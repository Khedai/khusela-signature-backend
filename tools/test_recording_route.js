// Call-recording regression test. Nothing leaves this machine: a fake Vicidial
// answers the recording_lookup API and serves an MP3, and a fake SMTP server
// receives the real composed message so the body can be read.
//
//   node tools/test_recording_route.js
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DB = path.join(ROOT, 'storage', '_recording_test.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
fs.mkdirSync(path.dirname(DB), { recursive: true });

const PDF = Buffer.from('%PDF-1.4\nrecording test\n%%EOF\n');
const MP3 = Buffer.from('ID3fake-mp3-bytes-for-the-recording-route-test');
let pass = 0, fail = 0;
function check(name, ok, extra) {
 if (ok) { pass++; console.log('  ok   ' + name); }
 else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

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
     if (line === '.') { inData = false; say('250 2.0.0 Ok: queued'); }
     else s.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
     continue;
    }
    const cmd = line.toUpperCase();
    if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
     socket.write('250-fake.khusela.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 26214400\r\n'); continue;
    }
    if (auth === 1) { auth = 2; say('334 ' + b64('Password:')); continue; }
    if (auth === 2) { auth = 0; say('235 2.7.0 Authentication successful'); continue; }
    if (cmd.startsWith('AUTH LOGIN')) { auth = 1; say('334 ' + b64('Username:')); continue; }
    if (cmd.startsWith('AUTH PLAIN')) { say('235 2.7.0 Authentication successful'); continue; }
    if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) { say('250 Ok'); continue; }
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

function startFakeVicidial() {
 const seen = [];
 const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  seen.push(u.pathname);
  if (u.pathname === '/vicidial/non_agent_api.php') {
   check('the API call asks for recording_lookup', u.searchParams.get('function') === 'recording_lookup');
   // Vicidial answers "no calls that day" with an ERROR line, and a real fault
   // with a different ERROR line. The route has to tell those apart.
   if (u.searchParams.get('agent_user') === '1002') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ERROR: recording_lookup NO RECORDINGS FOUND - apiuser|1002||2026-11-18|\n');
   }
   if (u.searchParams.get('agent_user') === '1003') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ERROR: recording_lookup INVALID USER - apiuser|1003||2026-11-18|\n');
   }
   check('the API call names the consultant and date',
    u.searchParams.get('agent_user') === '1001' && u.searchParams.get('date') === '2026-11-18');
   res.writeHead(200, { 'Content-Type': 'text/plain' });
   return res.end(`2026-11-18 10:11:12|1001|534820|876409|63|http://127.0.0.1:${server.address().port}/RECORDINGS/MP3/20261118_101112_1001-all.mp3\n`);
  }
  if (u.pathname === '/RECORDINGS/MP3/20261118_101112_1001-all.mp3') {
   res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
   return res.end(MP3);
  }
  res.writeHead(404); res.end('not found');
 });
 return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
  port: server.address().port, seen, close: () => new Promise((r) => server.close(r)),
 })));
}

function startServer(port, smtpPort, vicPort) {
 const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
   PORT: String(port),
   TURSO_DATABASE_URL: 'file:./storage/_recording_test.db',
   PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
   ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
   ADMIN_API_KEY: 'test-key',
   TRUST_PROXY_HOPS: '1',
   EMAIL_API_KEY: '', INVITE_API_KEY: '',
   MAIL_TO: 'office@example.com', SMTP_USER: 'sender@example.com', SMTP_PASS: 'secret',
   SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
   VICIDIAL_BASE_URL: `http://127.0.0.1:${vicPort}`,
   VICIDIAL_API_USER: 'apiuser', VICIDIAL_API_PASS: 'apipass',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
 });
 const log = [];
 child.stdout.on('data', (d) => log.push(String(d)));
 child.stderr.on('data', (d) => log.push(String(d)));
 return { child, log, base: `http://127.0.0.1:${port}` };
}

async function waitReady(srv) {
 for (let i = 0; i < 80; i++) {
  if (srv.child.exitCode !== null) throw new Error('server exited: ' + srv.log.join(''));
  try { const r = await fetch(srv.base + '/health'); if (r.ok) return; } catch (e) {}
  await new Promise((r) => setTimeout(r, 250));
 }
 throw new Error('server did not start: ' + srv.log.join(''));
}

const ORIGIN = { Origin: 'https://itc-extractor.vercel.app' };
const jsonBody = (r) => r.json().catch(() => null);
// Nodemailer folds long lines with quoted-printable soft breaks, so a phrase can
// be split across two lines on the wire even though it is one line in the body.
const decodeBody = (s) => String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

(async () => {
 const smtp = await startFakeSmtp();
 const vic = await startFakeVicidial();
 const srv = startServer(3911, smtp.port, vic.port);
 try {
  await waitReady(srv);
  const health = await (await fetch(srv.base + '/health')).json();
  check('/health reports recordings are configured', health.recordingsConfigured === true);

  const lookup = await fetch(srv.base + '/api/recordings?agent=1001&date=2026-11-18', { headers: ORIGIN });
  const data = await jsonBody(lookup);
  check('the lookup returns the consultant\'s recording', lookup.ok && (data.rows || []).length === 1, JSON.stringify(data));
  const row = (data.rows || [])[0] || {};
  check('the row names the recording file', /20261118_101112_1001-all\.mp3$/.test(row.filename || ''), row.filename);

  // A consultant with no calls that day must get an empty list, not an error:
  // "nothing to attach" is a normal outcome, and the PWA says so plainly.
  const empty = await fetch(srv.base + '/api/recordings?agent=1002&date=2026-11-18', { headers: ORIGIN });
  const emptyBody = await jsonBody(empty);
  check('a day with no calls comes back as an empty list',
   empty.ok && Array.isArray(emptyBody.rows) && emptyBody.rows.length === 0, JSON.stringify(emptyBody));

  // A genuine Vicidial fault must stay a 502 with a readable reason — an earlier
  // log line threw while reading e.cause and turned this into a bare 500.
  const broken = await fetch(srv.base + '/api/recordings?agent=1003&date=2026-11-18', { headers: ORIGIN });
  const brokenBody = await jsonBody(broken);
  check('a real Vicidial error is reported as a 502 with the reason',
   broken.status === 502 && /INVALID USER/.test((brokenBody && brokenBody.error) || ''), broken.status + ' ' + JSON.stringify(brokenBody));

  const audio = await fetch(row.audioUrl);
  const bytes = Buffer.from(await audio.arrayBuffer());
  check('the signed audio link returns the MP3 from Vicidial', audio.ok && bytes.equals(MP3));
  const tampered = await fetch(row.audioUrl.replace(/signature=[^&]+/, 'signature=bad'));
  check('a tampered recording link is refused', tampered.status === 401);

  const badDate = await fetch(srv.base + '/api/recordings?agent=1001&date=18-11-2026', { headers: ORIGIN });
  check('a malformed date is refused', badDate.status === 400);

  // One application WITH a recording.
  const withRec = new FormData();
  withRec.append('attachment', new Blob([PDF], { type: 'application/pdf' }), 'application.pdf');
  withRec.append('recording', new Blob([MP3], { type: 'audio/mpeg' }), '20261118_101112_1001-all.mp3');
  withRec.append('applicant', 'Test Applicant');
  const sent = await fetch(srv.base + '/api/email', { method: 'POST', headers: ORIGIN, body: withRec });
  const sentJson = await jsonBody(sent);
  check('an application with a recording is accepted', sent.ok === true, JSON.stringify(sentJson));
  check('the response says the recording was stored', sentJson && sentJson.recordingStored === true);
  check('the response says the recording was attached', sentJson && sentJson.recordingAttached === true);
  const withBody = smtp.sessions[0] ? smtp.sessions[0].data : '';
  check('the email states the recording was attached', /Call recording: attached as/.test(withBody));
  check('the MP3 itself reached the office mailbox', withBody.includes(MP3.toString('base64').slice(0, 30)));

  // One application WITHOUT a recording.
  const noRec = new FormData();
  noRec.append('attachment', new Blob([PDF], { type: 'application/pdf' }), 'application.pdf');
  noRec.append('applicant', 'Second Applicant');
  const sent2 = await fetch(srv.base + '/api/email', { method: 'POST', headers: ORIGIN, body: noRec });
  const sent2Json = await jsonBody(sent2);
  check('an application without a recording is accepted too', sent2.ok === true, JSON.stringify(sent2Json));
  check('the response says no recording was stored', sent2Json && sent2Json.recordingStored === false);
  const noBody = smtp.sessions[1] ? smtp.sessions[1].data : '';
  check('the email explicitly says no recording was attached', /no call recording was attached/.test(decodeBody(noBody)), decodeBody(noBody).slice(0, 400));

  // The bucket keeps the MP3 beside the PDF, gated by the admin key.
  const list = await (await fetch(srv.base + '/api/admin/submissions', { headers: { 'x-admin-key': 'test-key' } })).json();
  const withId = (list.rows || []).find((r) => r.applicant === 'Test Applicant');
  check('the bucket records the recording beside the application', !!withId && withId.recording_name === '20261118_101112_1001-all.mp3');
  if (withId) {
   const dl = await fetch(srv.base + '/api/admin/submissions/' + withId.id + '/recording', { headers: { 'x-admin-key': 'test-key' } });
   const dlBytes = Buffer.from(await dl.arrayBuffer());
   check('the office can download the stored MP3', dl.ok && dlBytes.equals(MP3));
   const denied = await fetch(srv.base + '/api/admin/submissions/' + withId.id + '/recording');
   check('the recording download needs the admin key', denied.status === 401);
  }
 } finally {
  srv.child.kill('SIGTERM');
  await smtp.close();
  await vic.close();
 }
 console.log(pass + ' passed, ' + fail + ' failed');
 process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
