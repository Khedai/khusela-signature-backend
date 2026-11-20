// Rehearsal of the REAL production email path: Formspree's free plan, which
// refuses uploads and therefore carries signed download links for both files.
//
//   node tools/rehearse_formspree.js
//
// Uses a real Vicidial recording, a local copy of the new backend, and a local
// fake Formspree that answers exactly like the free plan. Nothing is deployed
// and no real email is sent. Verifies both links download the intact bytes.
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { spawn } from 'child_process';
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
const PORT = 3923;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_rehearsal_formspree.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
fs.mkdirSync(path.dirname(DB), { recursive: true });
const PDF = Buffer.from('%PDF-1.4\nKhusela Formspree rehearsal\n%%EOF\n');

let pass = 0, fail = 0;
function check(name, ok, extra) {
 if (ok) { pass++; console.log('  ok   ' + name); }
 else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const get = (url, headers) => new Promise((resolve, reject) => {
 const u = new URL(url);
 const transport = u.protocol === 'http:' ? http : https;
 const req = transport.get(u, { headers: headers || {} }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => resolve({ status: res.statusCode || 0, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
 });
 req.setTimeout(30000, () => req.destroy(new Error('no answer within 30 s')));
 req.on('error', reject);
});

function startFakeFormspree() {
 const posts = [];
 const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
   const body = Buffer.concat(chunks).toString('utf8');
   posts.push(body);
   if (body.includes('name="attachment"')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"File Uploads Not Permitted"}');
   } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
   }
  });
 });
 return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
  port: server.address().port, posts, close: () => new Promise((r) => server.close(r)),
 })));
}

(async () => {
 const formspree = await startFakeFormspree();
 const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
   PORT: String(PORT),
   TURSO_DATABASE_URL: 'file:./storage/_rehearsal_formspree.db',
   PUBLIC_BASE_URL: BASE,
   ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
   ADMIN_API_KEY: 'rehearsal-key',
   TRUST_PROXY_HOPS: '1',
   EMAIL_API_KEY: '', INVITE_API_KEY: '',
   FORMSPREE_ENDPOINT: `http://127.0.0.1:${formspree.port}`,
   VICIDIAL_BASE_URL: cfg.VICIDIAL_BASE_URL || '',
   VICIDIAL_API_PATH: cfg.VICIDIAL_API_PATH || '/vicidial/non_agent_api.php',
   VICIDIAL_API_USER: cfg.VICIDIAL_API_USER || '',
   VICIDIAL_API_PASS: cfg.VICIDIAL_API_PASS || '',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
 });
 const log = [];
 child.stdout.on('data', (d) => log.push(String(d)));
 child.stderr.on('data', (d) => log.push(String(d)));
 try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
   if (child.exitCode !== null) throw new Error('server exited: ' + log.join(''));
   try { const r = await get(BASE + '/health'); if (r.status === 200) { ready = true; break; } } catch (e) {}
   await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error('server did not start: ' + log.join(''));
  const health = JSON.parse((await get(BASE + '/health')).body.toString());
  check('the service reports Formspree as the delivery path', health.emailPaths && health.emailPaths.formspree === true);

  const lookup = await get(BASE + '/api/recordings?agent=' + encodeURIComponent(cfg.VICIDIAL_AGENT) +
   '&date=' + encodeURIComponent(cfg.VICIDIAL_DATE), { Origin: 'https://itc-extractor.vercel.app' });
  const rows = (JSON.parse(lookup.body.toString()).rows || []);
  check('a real recording was found', rows.length > 0);
  if (!rows.length) throw new Error('nothing to rehearse with');
  const chosen = rows[0];
  const audio = await get(chosen.audioUrl);
  const mp3 = audio.body;
  check('the real MP3 was fetched', audio.status === 200 && mp3.length > 500, mp3.length + ' bytes');
  console.log('  chosen: ' + chosen.filename);

  const form = new FormData();
  form.append('attachment', new Blob([PDF], { type: 'application/pdf' }), 'application.pdf');
  form.append('recording', new Blob([mp3], { type: 'audio/mpeg' }), chosen.filename);
  form.append('applicant', 'Formspree Rehearsal');
  const res = await fetch(BASE + '/api/email', { method: 'POST', headers: { Origin: 'https://itc-extractor.vercel.app' }, body: form });
  const out = await res.json().catch(() => ({}));
  check('the application was delivered', res.ok === true, JSON.stringify(out));
  check('the response says it went as links', out.linkOnly === true && out.recordingLinkOnly === true, JSON.stringify(out));
  check('the response does not claim an attachment', out.recordingAttached === false);

  check('Formspree was tried twice (file, then links)', formspree.posts.length === 2, 'posts=' + formspree.posts.length);
  const fallback = formspree.posts[1] || '';
  const pdfUrl = (fallback.match(/name="Download PDF"\r?\n\r?\n([^\r\n]+)/) || [])[1] || '';
  const recLine = (fallback.match(/name="Call Recording"\r?\n\r?\n([^\r\n]+)/) || [])[1] || '';
  const recUrl = (recLine.match(/https?:\/\/\S+/) || [])[0] || '';
  console.log('  fallback email fields: ' + JSON.stringify([...fallback.matchAll(/name="([^"]+)"/g)].map((m) => m[1])));
  console.log('  Call Recording line: ' + recLine.slice(0, 160));
  check('the fallback email carries a PDF link', /^https?:\/\//.test(pdfUrl), pdfUrl.slice(0, 80));
  check('the fallback email carries a recording link', /^https?:\/\//.test(recUrl), recLine.slice(0, 120));
  check('it does NOT claim the MP3 was attached', !/attached as/.test(recLine), recLine.slice(0, 120));

  const pdfDl = await get(pdfUrl);
  const recDl = await get(recUrl);
  check('the PDF link downloads the intact PDF', pdfDl.status === 200 && pdfDl.body.equals(PDF));
  check('the recording link downloads the intact MP3', recDl.status === 200 && recDl.body.equals(mp3), recDl.body.length + ' vs ' + mp3.length);
  console.log('');
  console.log(fail ? 'FORMSPREE REHEARSAL FAILED: ' + fail
   : 'FORMSPREE REHEARSAL OK — with the live email path, both links download the original bytes intact.');
 } catch (e) {
  console.error('ERROR: ' + (e && e.message ? e.message : e));
  fail++;
 } finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  await formspree.close();
  process.exit(fail ? 1 : 0);
 }
})();
