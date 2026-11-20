// Read-only check that a list of agent user IDs actually exist on Vicidial.
//   node tools/verify_agents.js 1015 1005 1024 ...
// Uses the credentials in the local .env.verify file. Prints only IDs, names,
// groups and errors — never the password.
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = {};
const FILE = path.join(ROOT, '.env.verify');
if (fs.existsSync(FILE)) {
 fs.readFileSync(FILE, 'utf8').split(/\r?\n/).forEach((line) => {
  const s = line.trim(); if (!s || s.startsWith('#')) return;
  const i = s.indexOf('='); if (i > 0) values[s.slice(0, i).trim()] = s.slice(i + 1).trim();
 });
}
const BASE = (values.VICIDIAL_BASE_URL || '').replace(/\/+$/, '');
const API_PATH = values.VICIDIAL_API_PATH || '/vicidial/non_agent_api.php';
const USER = values.VICIDIAL_API_USER || '';
const PASS = values.VICIDIAL_API_PASS || '';
const ids = process.argv.slice(2);
if (!BASE || !USER || !PASS || !ids.length) {
 console.error('Usage: node tools/verify_agents.js <id> [id ...]   (and fill .env.verify)');
 process.exit(2);
}

function call(agent) {
 const base = /^https?:\/\//i.test(BASE) ? BASE : `https://${BASE}`;
 const u = new URL(base + API_PATH);
 u.searchParams.set('source', 'khusela-verify');
 u.searchParams.set('user', USER);
 u.searchParams.set('pass', PASS);
 // This build (2.14-188 / 2024-04) predates user_details, so use the older
 // agent_campaigns function: it still errors clearly on an unknown agent.
 u.searchParams.set('function', 'agent_campaigns');
 u.searchParams.set('agent_user', agent);
 const transport = u.protocol === 'http:' ? http : https;
 return new Promise((resolve) => {
  const req = transport.get(u, (res) => {
   const chunks = [];
   res.on('data', (c) => chunks.push(c));
   res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8').trim() }));
  });
  req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  req.on('error', (e) => resolve({ status: 0, text: e.message }));
 });
}

(async () => {
 let bad = 0;
 for (const id of ids) {
  const r = await call(id);
  if (!/^ERROR:/i.test(r.text) && r.text.indexOf('|') > 0) {
   const p = r.text.split('|');
   const campaigns = (p[1] || '').split('-').filter(Boolean).length;
   const ingroups = (p[2] || '').split('-').filter(Boolean).length;
   console.log('  OK   ' + id + '  campaigns=' + campaigns + '  in-groups=' + ingroups);
  } else {
   bad++;
   console.log('  FAIL ' + id + '  ' + r.text.split('\n')[0]);
  }
 }
 console.log('');
 console.log(bad ? bad + ' ID(s) did not resolve — check the handwriting.' : 'All IDs resolve on Vicidial.');
 process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
