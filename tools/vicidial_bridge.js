// Free office-side bridge for Vicidial.
//
// Runs on a machine INSIDE the office network that can reach the dialer. The
// Khusela backend on Render calls this over a free HTTPS tunnel, because Render's
// own IP is blocked by the dialer's firewall. No new secret to manage: the shared
// key is derived from the Vicidial API password already in .env.verify.
//
//   node tools/vicidial_bridge.js
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = {};
const FILE = path.join(ROOT, '.env.verify');
if (fs.existsSync(FILE)) {
 fs.readFileSync(FILE, 'utf8').split(/\r?\n/).forEach((line) => {
  const s = line.trim(); if (!s || s.startsWith('#')) return;
  const i = s.indexOf('='); if (i > 0) cfg[s.slice(0, i).trim()] = s.slice(i + 1).trim();
 });
}
const BASE = (cfg.VICIDIAL_BASE_URL || '').replace(/\/+$/, '');
const API_PATH = cfg.VICIDIAL_API_PATH || '/vicidial/non_agent_api.php';
const USER = cfg.VICIDIAL_API_USER || '';
const PASS = cfg.VICIDIAL_API_PASS || '';
if (!BASE || !USER || !PASS) {
 console.error('Fill VICIDIAL_BASE_URL / API_USER / API_PASS in .env.verify first.');
 process.exit(2);
}
const KEY = crypto.createHmac('sha256', PASS).update('khusela-vicidial-bridge').digest('hex');
const PORT = Number(process.env.BRIDGE_PORT || 8787);

function get(url) {
 return new Promise((resolve, reject) => {
  const u = new URL(url);
  const transport = u.protocol === 'http:' ? http : https;
  const req = transport.get(u, (res) => {
   const chunks = [];
   res.on('data', (c) => chunks.push(c));
   res.on('end', () => resolve({ status: res.statusCode || 0, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
  });
  req.setTimeout(30000, () => req.destroy(new Error('Vicidial did not answer within 30 s')));
  req.on('error', reject);
 });
}

const server = http.createServer(async (req, res) => {
 const u = new URL(req.url, 'http://localhost');
 res.setHeader('Access-Control-Allow-Origin', '*');
 if (u.pathname === '/health') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true, base: new URL(/^https?:\/\//i.test(BASE) ? BASE : 'https://' + BASE).host }));
 }
 if (req.headers['x-bridge-key'] !== KEY) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  return res.end('{"error":"bad bridge key"}');
 }
 try {
  if (u.pathname === '/lookup') {
   const agent = u.searchParams.get('agent') || '';
   const date = u.searchParams.get('date') || '';
   if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{2,40}$/.test(agent)) {
    res.writeHead(400); return res.end('bad agent or date');
   }
   const raw = /^https?:\/\//i.test(BASE) ? BASE : 'https://' + BASE;
   const api = new URL(raw.replace(/\/+$/, '') + API_PATH);
   api.searchParams.set('source', 'khusela-bridge');
   api.searchParams.set('user', USER);
   api.searchParams.set('pass', PASS);
   api.searchParams.set('function', 'recording_lookup');
   api.searchParams.set('agent_user', agent);
   api.searchParams.set('date', date);
   api.searchParams.set('stage', 'pipe');
   api.searchParams.set('duration', 'Y');
   api.searchParams.set('header', 'NO');
   const r = await get(api.toString());
   res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
   return res.end(r.body);
  }
  if (u.pathname === '/audio') {
   const location = u.searchParams.get('location') || '';
   let target;
   try { target = new URL(location); } catch (e) { res.writeHead(400); return res.end('bad location'); }
   if (!/^https?:$/i.test(target.protocol) || target.pathname.toUpperCase().indexOf('/RECORDINGS/') !== 0 || !/\.(mp3|wav)$/i.test(target.pathname)) {
    res.writeHead(400); return res.end('location not allowed');
   }
   const r = await get(target.toString());
   if (r.status < 200 || r.status >= 300) { res.writeHead(r.status); return res.end('upstream HTTP ' + r.status); }
   res.writeHead(200, { 'Content-Type': /\.wav$/i.test(target.pathname) ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'no-store' });
   return res.end(r.body);
  }
  res.writeHead(404); res.end('not found');
 } catch (e) {
  console.error('bridge error: ' + (e && e.message ? e.message : e));
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'bridge could not reach Vicidial: ' + (e && e.message ? e.message : e) }));
 }
});

server.listen(PORT, '127.0.0.1', () => {
 console.log('Vicidial bridge listening on http://127.0.0.1:' + PORT);
 console.log('Dialer: ' + new URL(/^https?:\/\//i.test(BASE) ? BASE : 'https://' + BASE).host);
 console.log('Give Render: VICIDIAL_BRIDGE_URL = <public tunnel URL>');
});
