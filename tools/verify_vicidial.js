// Read-only Vicidial connectivity check for the pilot setup.
//
//   node tools/verify_vicidial.js
//
// It reads credentials from the environment, or from a local .env.verify file
// in the project root (gitignored — never committed). It prints ONLY sanitized
// results: permissions, error text and recording filenames. It never prints a
// password, and it never changes anything on the Vicidial server.
//
// Copy .env.verify.example to .env.verify, fill in your values, then run it.
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env.verify');
const values = {};
if (fs.existsSync(FILE)) {
 fs.readFileSync(FILE, 'utf8').split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s || s.startsWith('#')) return;
  const i = s.indexOf('=');
  if (i > 0) values[s.slice(0, i).trim()] = s.slice(i + 1).trim();
 });
}
const get = (k) => process.env[k] || values[k] || '';

const BASE = get('VICIDIAL_BASE_URL').replace(/\/+$/, '');
const API_PATH = get('VICIDIAL_API_PATH') || '/vicidial/non_agent_api.php';
const USER = get('VICIDIAL_API_USER');
const PASS = get('VICIDIAL_API_PASS');
const AGENT = get('VICIDIAL_AGENT');
const DATE = get('VICIDIAL_DATE');

const missing = [];
if (!BASE) missing.push('VICIDIAL_BASE_URL');
if (!USER) missing.push('VICIDIAL_API_USER');
if (!PASS) missing.push('VICIDIAL_API_PASS');
if (!AGENT) missing.push('VICIDIAL_AGENT');
if (!DATE) missing.push('VICIDIAL_DATE');
if (missing.length) {
 console.error('Missing values: ' + missing.join(', '));
 console.error('Copy .env.verify.example to .env.verify and fill it in first.');
 process.exit(2);
}

async function call(params) {
 const base = /^https?:\/\//i.test(BASE) ? BASE : `https://${BASE}`;
 const u = new URL(base.replace(/\/+$/, '') + API_PATH);
 u.searchParams.set('source', 'khusela-verify');
 u.searchParams.set('user', USER);
 u.searchParams.set('pass', PASS);
 Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
 // Node's fetch/undici can leave a closing handle behind on Windows and print
 // an assertion after an otherwise successful check. Plain https.get keeps the
 // result identical and lets the process exit cleanly.
 const transport = u.protocol === 'http:' ? http : https;
 return await new Promise((resolve, reject) => {
  const req = transport.get(u, (res) => {
   const chunks = [];
   res.on('data', (c) => chunks.push(c));
   res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.setTimeout(20000, () => req.destroy(new Error('Vicidial did not answer within 20 s')));
  req.on('error', reject);
 });
}

(async () => {
 let ok = true;
 console.log('Vicidial: ' + BASE);
 console.log('API user: ' + USER + '   Agent to look up: ' + AGENT + '   Date: ' + DATE);
 console.log('');

 // 1. Does this login have API access at all?
 const version = await call({ function: 'version' });
 if (version.status !== 200 || /^ERROR:/i.test(version.text.trim())) {
  console.log('AUTH/API ACCESS: FAILED');
  console.log('  ' + version.text.trim().split('\n')[0]);
  console.log('');
  console.log('Fix: in Vicidial Admin -> Users -> this user, enable "API Access"');
  console.log('(and "Agent API Access"), set user_level 7+ and enable "View Reports".');
  process.exit(1);
 }
 console.log('AUTH/API ACCESS: OK');
 console.log('  ' + version.text.trim().split('\n')[0]);
 console.log('');

 // 2. Can it look up recordings for this consultant?
 const lookup = await call({
  function: 'recording_lookup',
  agent_user: AGENT,
  date: DATE,
  stage: 'pipe',
  duration: 'Y',
  header: 'NO',
 });
 const text = lookup.text.trim();
 if (/^ERROR:/i.test(text)) {
  console.log('RECORDING LOOKUP: FAILED');
  console.log('  ' + text.split('\n')[0]);
  if (/PERMISSION|API ACCESS/i.test(text)) {
   console.log('');
   console.log('This user can reach the API but cannot view recordings.');
   console.log('Give it "View Reports" and add the consultant\'s user group to');
   console.log('"Admin Viewable Groups", or use an admin-level API user for the pilot.');
  }
  ok = false;
 } else if (!text) {
  console.log('RECORDING LOOKUP: OK — no recordings found for that agent/date.');
  console.log('Try a date when the consultant definitely took a recorded call.');
 } else {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log('RECORDING LOOKUP: OK — ' + rows.length + ' recording(s) found.');
  rows.slice(0, 5).forEach((line) => {
   const p = line.split('|');
   const file = (p[p.length - 1] || '').split('/').pop().split('?')[0];
   console.log('  ' + p[0] + '  lead ' + p[3] + '  ' + (p[4] || '?') + 's  ' + file);
  });
  console.log('');
  console.log('The URL each row carries is what the backend will fetch for the MP3.');

  // Fetch a small slice of the first recording. This proves the file is actually
  // reachable (and whether /RECORDINGS/ needs a password) without downloading
  // the whole call. Only sanitized headers/bytes are printed.
  const first = rows[0].split('|');
  const location = first.slice(5).join('|').trim();
  if (/^https?:\/\//i.test(location)) {
   try {
    const fileUrl = new URL(location);
    const fileTransport = fileUrl.protocol === 'http:' ? http : https;
    const probe = await new Promise((resolve, reject) => {
     const req = fileTransport.get(fileUrl, { headers: { Range: 'bytes=0-1023' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => resolve({
       status: res.statusCode || 0,
       type: res.headers['content-type'] || '',
       length: res.headers['content-length'] || '',
       first: Buffer.concat(chunks).subarray(0, 12).toString('hex'),
      }));
     });
     req.setTimeout(20000, () => req.destroy(new Error('no answer within 20 s')));
     req.on('error', reject);
    });
    console.log('');
    console.log('RECORDING DOWNLOAD: HTTP ' + probe.status);
    console.log('  host: ' + fileUrl.host + '   path: ' + fileUrl.pathname);
    console.log('  content-type: ' + (probe.type || '(none)') + '   content-length: ' + (probe.length || '(none)'));
    console.log('  first bytes: ' + (probe.first || '(empty)'));
    if (probe.status === 401 || probe.status === 403) {
     console.log('  -> /RECORDINGS/ needs a password; set VICIDIAL_RECORDINGS_USER/PASS.');
     ok = false;
    } else if (probe.status >= 200 && probe.status < 300) {
     console.log('  -> the MP3 can be downloaded from this machine.');
    } else {
     console.log('  -> unexpected status; the backend may not be able to fetch this file.');
     ok = false;
    }
   } catch (e) {
    console.log('');
    console.log('RECORDING DOWNLOAD: FAILED — ' + (e && e.message ? e.message : e));
    console.log('  The lookup URL may point at an internal address. The backend would');
    console.log('  need the same network access (or the office-machine go-between).');
    ok = false;
   }
  }
 }
 console.log('');
 console.log(ok ? 'RESULT: this login can be used for the pilot.' : 'RESULT: fix the permissions above and run again.');
 process.exit(ok ? 0 : 1);
})().catch((e) => {
 console.error('Could not reach Vicidial: ' + (e && e.message ? e.message : e));
 process.exit(1);
});
