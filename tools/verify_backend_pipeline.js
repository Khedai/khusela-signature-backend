// End-to-end pilot check against the REAL Vicidial configured in .env.verify.
//
//   node tools/verify_backend_pipeline.js
//
// Starts a temporary local copy of this backend with those credentials, calls
// the SAME endpoints the PWA will call, and fetches one recording through the
// signed audio link. Prints only sanitized results; never prints a password.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env.verify');
if (!fs.existsSync(FILE)) {
 console.error('Create .env.verify first (see tools/.env.verify.example).');
 process.exit(2);
}
const values = {};
fs.readFileSync(FILE, 'utf8').split(/\r?\n/).forEach((line) => {
 const s = line.trim();
 if (!s || s.startsWith('#')) return;
 const i = s.indexOf('=');
 if (i > 0) values[s.slice(0, i).trim()] = s.slice(i + 1).trim();
});
const PORT = 3920;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_pipeline_test.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
fs.mkdirSync(path.dirname(DB), { recursive: true });

const child = spawn(process.execPath, ['server.js'], {
 cwd: ROOT,
 env: Object.assign({}, process.env, {
  PORT: String(PORT),
  TURSO_DATABASE_URL: 'file:./storage/_pipeline_test.db',
  PUBLIC_BASE_URL: BASE,
  ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
  ADMIN_API_KEY: 'pilot-test-key',
  TRUST_PROXY_HOPS: '1',
  EMAIL_API_KEY: '', INVITE_API_KEY: '',
  VICIDIAL_BASE_URL: values.VICIDIAL_BASE_URL || '',
  VICIDIAL_API_PATH: values.VICIDIAL_API_PATH || '/vicidial/non_agent_api.php',
  VICIDIAL_API_USER: values.VICIDIAL_API_USER || '',
  VICIDIAL_API_PASS: values.VICIDIAL_API_PASS || '',
  VICIDIAL_AGENT: values.VICIDIAL_AGENT || '',
  VICIDIAL_DATE: values.VICIDIAL_DATE || '',
  VICIDIAL_BRIDGE_URL: process.env.VICIDIAL_BRIDGE_URL || '',
 }),
 stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));

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

let failed = 0;
function check(name, ok, extra) {
 console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !extra ? '' : ' — ' + extra));
 if (!ok) failed++;
}

(async () => {
 let ready = false;
 for (let i = 0; i < 80; i++) {
  if (child.exitCode !== null) throw new Error('server exited: ' + log.join(''));
  try { const r = await get(BASE + '/health'); if (r.status === 200) { ready = true; break; } } catch (e) {}
  await new Promise((r) => setTimeout(r, 250));
 }
 if (!ready) throw new Error('server did not start: ' + log.join(''));
 const health = JSON.parse((await get(BASE + '/health')).body.toString());
 check('/health says recordings are configured', health.recordingsConfigured === true);

 const agent = values.VICIDIAL_AGENT;
 const date = values.VICIDIAL_DATE;
 const lookup = await get(BASE + '/api/recordings?agent=' + encodeURIComponent(agent) + '&date=' + encodeURIComponent(date),
  { Origin: 'https://itc-extractor.vercel.app' });
 check('the PWA lookup endpoint answers', lookup.status === 200, 'HTTP ' + lookup.status);
 const data = JSON.parse(lookup.body.toString());
 const rows = data.rows || [];
 check('it returns the consultant\'s recordings', rows.length > 0, JSON.stringify(data).slice(0, 300));
 if (!rows.length) throw new Error('no rows to test the download with');
 console.log('  (' + rows.length + ' recordings for ' + agent + ' on ' + date + ')');

 const audio = await get(rows[0].audioUrl);
 const bytes = audio.body;
 const head = bytes.subarray(0, 4).toString('hex');
 check('the signed audio link returns the MP3', audio.status === 200 && bytes.length > 100, 'HTTP ' + audio.status + ', ' + bytes.length + ' bytes');
 check('the preview is served as playable audio', /audio\//.test(audio.type), audio.type);
 check('the bytes are an MP3 frame (ffe3 / fffb)', /^ff(e3|fb|f3)/.test(head), head);
 console.log('');
 console.log(failed ? 'PIPELINE FAILED: ' + failed : 'PIPELINE OK — lookup, signed link and MP3 download all work with your login.');
})().catch((e) => { console.error('ERROR: ' + (e && e.message ? e.message : e)); failed++; })
 .finally(async () => {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed ? 1 : 0);
 });
