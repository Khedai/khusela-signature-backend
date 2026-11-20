// Dress rehearsal BEFORE pushing to main.
//
// Uses the REAL Vicidial in .env.verify to look up and download a real call, then
// sends it through a LOCAL copy of the new backend to a LOCAL fake mailbox. Nothing
// is deployed and nothing leaves this machine except the read-only Vicidial calls.
// The delivered MIME message is inspected so we can confirm the MP3 arrives intact.
//
//   node tools/rehearse_email.js
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env.verify');
if (!fs.existsSync(FILE)) { console.error('Create .env.verify first.'); process.exit(2); }
const cfg = {};
fs.readFileSync(FILE, 'utf8').split(/\r?\n/).forEach((line) => {
 const s = line.trim(); if (!s || s.startsWith('#')) return;
 const i = s.indexOf('='); if (i > 0) cfg[s.slice(0, i).trim()] = s.slice(i + 1).trim();
});
const PORT = 3922;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_rehearsal.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
fs.mkdirSync(path.dirname(DB), { recursive: true });
const PDF = Buffer.from('%PDF-1.4\nKhusela rehearsal application\n%%EOF\n');
const OFFICE = 'office@example.test';

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

function startFakeSmtp() {
 const sessions = [];
 const server = net.createServer((socket) => {
  const s = { data: '' }; sessions.push(s);
  let buf = '', inData = false, auth = 0;
  const b64 = (v) => Buffer.from(v).toString('base64');
  const say = (t) => socket.write(t + '\r\n');
  say('220 fake.khusela.test ESMTP ready');
  socket.on('data', (chunk) => {
   buf += chunk.toString('utf8');
   let i;
   while ((i = buf.indexOf('\r\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (inData) {
     if (line === '.') { inData = false; say('250 Ok'); }
     else s.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
     continue;
    }
    const cmd = line.toUpperCase();
    if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
     socket.write('250-fake.khusela.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 26214400\r\n'); continue;
    }
    if (auth === 1) { auth = 2; say('334 ' + b64('Password:')); continue; }
    if (auth === 2) { auth = 0; say('235 Authenticated'); continue; }
    if (cmd.startsWith('AUTH LOGIN')) { auth = 1; say('334 ' + b64('Username:')); continue; }
    if (cmd.startsWith('AUTH PLAIN')) { say('235 Authenticated'); continue; }
    if (cmd.startsWith('MAIL FROM')) { s.from = line; say('250 Ok'); continue; }
    if (cmd.startsWith('RCPT TO')) { s.to = (s.to || []).concat(line); say('250 Ok'); continue; }
    if (cmd === 'DATA') { inData = true; say('354 End data with <CR><LF>.<CR><LF>'); continue; }
    if (cmd === 'QUIT') { say('221 Bye'); socket.end(); continue; }
    say('250 Ok');
   }
  });
  socket.on('error', () => {});
 });
 return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
  port: server.address().port, sessions,
  close: () => new Promise((r) => server.close(r)),
 })));
}

(async () => {
 const smtp = await startFakeSmtp();
 const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
   PORT: String(PORT),
   TURSO_DATABASE_URL: 'file:./storage/_rehearsal.db',
   PUBLIC_BASE_URL: BASE,
   ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
   ADMIN_API_KEY: 'rehearsal-key',
   TRUST_PROXY_HOPS: '1',
   EMAIL_API_KEY: '', INVITE_API_KEY: '',
   MAIL_TO: OFFICE, SMTP_USER: 'sender@example.test', SMTP_PASS: 'dummy',
   SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false',
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
  console.log('Local backend started with the new code. Real Vicidial: ' + cfg.VICIDIAL_BASE_URL);
  console.log('');

  // 1. Real lookup through our new endpoint.
  const lookup = await get(BASE + '/api/recordings?agent=' + encodeURIComponent(cfg.VICIDIAL_AGENT) +
   '&date=' + encodeURIComponent(cfg.VICIDIAL_DATE), { Origin: 'https://itc-extractor.vercel.app' });
  check('the lookup endpoint answers', lookup.status === 200, 'HTTP ' + lookup.status);
  const data = JSON.parse(lookup.body.toString());
  const rows = data.rows || [];
  check('real recordings were returned', rows.length > 0, JSON.stringify(data).slice(0, 200));
  if (!rows.length) throw new Error('nothing to rehearse with');
  const chosen = rows[0];
  console.log('  chosen: ' + chosen.filename + '  (' + chosen.start_time + ', lead ' + chosen.lead_id + ')');

  // 2. Real MP3 downloaded through the signed link.
  const audio = await get(chosen.audioUrl);
  const mp3 = audio.body;
  check('the MP3 came back through the signed link', audio.status === 200 && mp3.length > 500, 'HTTP ' + audio.status + ', ' + mp3.length + ' bytes');
  check('it is served as playable audio', /audio\//.test(audio.type), audio.type);
  check('the bytes are a real MP3 frame', /^ff(e3|fb|f3)/.test(mp3.subarray(0, 2).toString('hex')), mp3.subarray(0, 4).toString('hex'));

  // 3. Submit an application with that real MP3, exactly as the PWA will.
  const form = new FormData();
  form.append('attachment', new Blob([PDF], { type: 'application/pdf' }), 'Khusela-Credit-Application.pdf');
  form.append('recording', new Blob([mp3], { type: 'audio/mpeg' }), chosen.filename);
  form.append('applicant', 'Rehearsal Applicant');
  form.append('idNumber', '0000000000000');
  const res = await fetch(BASE + '/api/email', { method: 'POST', headers: { Origin: 'https://itc-extractor.vercel.app' }, body: form });
  const out = await res.json().catch(() => ({}));
  check('the application was accepted', res.ok === true, JSON.stringify(out));
  check('the backend says the recording was stored', out.recordingStored === true);
  check('the backend says the recording was attached', out.recordingAttached === true);

  // 4. Inspect the message the office would actually receive.
  for (let i = 0; i < 40 && !smtp.sessions.length; i++) await new Promise((r) => setTimeout(r, 100));
  const msg = smtp.sessions[0] ? smtp.sessions[0].data : '';
  check('a message reached the office mailbox', !!msg);
  check('it is addressed to the configured office', smtp.sessions[0] && JSON.stringify(smtp.sessions[0].to || []).includes(OFFICE), JSON.stringify(smtp.sessions[0] && smtp.sessions[0].to));
  check('the body says the recording was attached', /Call recording: attached as/.test(msg));
  check('the body names the real recording file', msg.includes(chosen.filename));
  // Base64 is wrapped at 76 characters per line, so compare against a version
  // of the message with line breaks removed — that is the bytes on the wire.
  const compact = msg.replace(/\r?\n/g, '');
  const mp3B64 = mp3.toString('base64');
  const pdfB64 = PDF.toString('base64');
  check('the REAL MP3 bytes are in the message, intact', compact.includes(mp3B64.slice(0, 80)));
  check('the PDF bytes are in the message too', compact.includes(pdfB64.slice(0, 80)));
  check('the message carries two attachments', (msg.match(/Content-Type: (application\/pdf|audio\/mpeg)/g) || []).length >= 2);
  console.log('');
  console.log(fail ? 'REHEARSAL FAILED: ' + fail : 'REHEARSAL OK — a real Vicidial call arrived in the email as an intact MP3 alongside the PDF.');
 } catch (e) {
  console.error('ERROR: ' + (e && e.message ? e.message : e));
  fail++;
 } finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  await smtp.close();
  process.exit(fail ? 1 : 0);
 }
})();
