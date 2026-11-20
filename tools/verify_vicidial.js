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
 const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
 return { status: res.status, text: await res.text() };
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
 }
 console.log('');
 console.log(ok ? 'RESULT: this login can be used for the pilot.' : 'RESULT: fix the permissions above and run again.');
 process.exit(ok ? 0 : 1);
})().catch((e) => {
 console.error('Could not reach Vicidial: ' + (e && e.message ? e.message : e));
 process.exit(1);
});
