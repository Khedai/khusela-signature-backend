// Test of the application-email route:
//   POST /api/email  (the PWA sends the PDF it rendered, this service mails it)
//   node tools/test_email_route.js
//
// Nothing leaves this machine. SMTP_HOST points at a fake SMTP server started by
// this file, so the message is composed and delivered for REAL — headers, MIME
// boundaries and attachment encoding included — with no account, no app password
// and no internet. That is what lets the checks below read what the office would
// actually receive instead of what the route claims it sent.
//
// The suite also runs the same server twice more, to prove the two states the PWA
// depends on: a limiter that says no, and a service with no mailbox configured
// answering 503 so the app can fall back.
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DB = path.join(ROOT, 'storage', '_email_test.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
// The folder is not in git — only the databases inside it are ignored — and db.js
// creates it only for its own default path, so a fresh checkout has nowhere for a
// scratch database to live. Make it before a server is pointed at it.
fs.mkdirSync(path.dirname(DB), { recursive: true });


const OFFICE = 'khuselamanagement@gmail.com';
const SENDER = 'khuselamanagement@gmail.com';
const PDF = Buffer.from('%PDF-1.4\n% email route test\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
// The attachment travels base64-encoded, so the first line of that encoding is
// what proves the bytes on the wire are these bytes.
const PDF_B64 = PDF.toString('base64').slice(0, 48);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

// ── A fake SMTP server ───────────────────────────────────────────────────────
// Enough of RFC 5321 to accept one message per connection: greeting, EHLO,
// AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Everything received is kept
// so the test can read the delivered message.
function startFakeSmtp() {
  const sessions = [];
  const server = net.createServer((socket) => {
    const s = { from: '', to: [], data: '' };
    sessions.push(s);
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
          // Lines are kept as the office's server would hand them over, with the
          // terminating dot on its own line marking the end.
          if (line === '.') { inData = false; say('250 2.0.0 Ok: queued as FAKE1'); }
          else s.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          // ONE response, in the multi-line form: every line but the last carries
          // a '-' after the code. A stray final "250 OK" is read as a SECOND reply
          // and shifts the client's whole response queue by one, which shows up as
          // a mysterious failure further along the conversation.
          socket.write('250-fake.khusela.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 26214400\r\n');
          continue;
        }
        // A bare base64 line while authenticating is the username, then the password.
        if (auth === 1) { auth = 2; say('334 ' + b64('Password:')); continue; }
        if (auth === 2) { auth = 0; say('235 2.7.0 Authentication successful'); continue; }
        if (cmd.startsWith('AUTH LOGIN')) { auth = 1; say('334 ' + b64('Username:')); continue; }
        if (cmd.startsWith('AUTH PLAIN') || cmd.startsWith('AUTH PLAIN ')) { say('235 2.7.0 Authentication successful'); continue; }
        if (cmd.startsWith('MAIL FROM')) { s.from = line.slice(line.indexOf(':') + 1).trim(); say('250 2.1.0 Ok'); continue; }
        if (cmd.startsWith('RCPT TO')) { s.to.push(line.slice(line.indexOf(':') + 1).trim()); say('250 2.1.5 Ok'); continue; }
        if (cmd === 'DATA') { inData = true; say('354 End data with <CR><LF>.<CR><LF>'); continue; }
        if (cmd === 'QUIT') { say('221 2.0.0 Bye'); socket.end(); continue; }
        say('250 2.0.0 Ok');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      sessions,
      last: () => sessions[sessions.length - 1],
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}


function startServer(port, extra) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      TURSO_DATABASE_URL: 'file:./storage/_email_test.db',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
      ADMIN_API_KEY: 'test-key',
      TRUST_PROXY_HOPS: '1',
      // Cleared on purpose: this suite must give the same answers on a machine
      // whose shell happens to have these set. Each server below sets what it needs.
      EMAIL_API_KEY: '',
      INVITE_API_KEY: '',
    }, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log, base: `http://127.0.0.1:${port}` };
}

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function stop(srv) {
  try { srv.child.kill(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 800));
}

// A multipart/form-data body, built by hand: the route is what is under test, so
// nothing here should depend on a library assembling it differently to a browser.
function multipart(fields, files) {
  const boundary = '----KhuselaTest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.content);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function postEmail(base, opts) {
  const o = opts || {};
  const headers = {};
  if (o.key) headers['x-email-key'] = o.key;
  let body = o.body;
  if (!body) {
    const m = multipart(o.fields || {}, o.files || []);
    body = m.body;
    headers['Content-Type'] = m.contentType;
  }
  if (o.contentType) headers['Content-Type'] = o.contentType;
  const res = await fetch(base + '/api/email', { method: 'POST', headers, body });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

const KEY = 'test-email-key';
const APP = { applicant: 'Thabo Mokoena', idNumber: '9001015800085', date: '2026-09-30', replyTo: 'thabo@example.com' };


// ── 1. A configured service, with a key set ───────────────────────────────────
const smtp = await startFakeSmtp();
let srv = null, limited = null, bare = null;
const MAILBOX = {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false',
  SMTP_USER: SENDER, SMTP_PASS: 'fake-app-password',
  MAIL_TO: OFFICE, MAIL_FROM: SENDER, MAX_EMAIL_MB: '1',
};
const PDF_FILE = [{ name: 'attachment', filename: 'Khusela-Credit-Application-2026-09-30.pdf', type: 'application/pdf', content: PDF }];

try {
  srv = startServer(3911, Object.assign({
    EMAIL_API_KEY: KEY, EMAIL_RATE_LIMIT: '50', EMAIL_RATE_WINDOW_MS: '60000',
  }, MAILBOX));
  check('server starts', await waitReady(srv.base));

  const health = await (await fetch(srv.base + '/health')).json();
  check('/health reports the mailbox as configured', health.emailConfigured === true, JSON.stringify(health));
  check('/health reports the route as protected', health.emailProtected === true, JSON.stringify(health));

  const noKey = await postEmail(srv.base, { fields: APP, files: PDF_FILE });
  check('a caller with no key is refused', noKey.status === 401, 'HTTP ' + noKey.status + ' ' + JSON.stringify(noKey.json));

  const wrongKey = await postEmail(srv.base, { key: 'not-the-key', fields: APP, files: PDF_FILE });
  check('a caller with the wrong key is refused', wrongKey.status === 401, 'HTTP ' + wrongKey.status);

  const noFile = await postEmail(srv.base, { key: KEY, fields: APP });
  check('a request with no attachment is a 400', noFile.status === 400, 'HTTP ' + noFile.status + ' ' + JSON.stringify(noFile.json));

  const notPdf = await postEmail(srv.base, { key: KEY, fields: APP, files: [{ name: 'attachment', filename: 'notes.txt', type: 'text/plain', content: Buffer.from('not a pdf') }] });
  check('an attachment that is not a PDF is refused', notPdf.status === 400, 'HTTP ' + notPdf.status + ' ' + JSON.stringify(notPdf.json));

  const asJson = await postEmail(srv.base, { key: KEY, contentType: 'application/json', body: JSON.stringify(APP) });
  check('a JSON body carries no attachment, so it is a 400 too', asJson.status === 400, 'HTTP ' + asJson.status + ' ' + JSON.stringify(asJson.json));

  const oversized = await postEmail(srv.base, { key: KEY, fields: APP, files: [{ name: 'attachment', filename: 'big.pdf', type: 'application/pdf', content: Buffer.concat([PDF, Buffer.alloc(1536 * 1024, 0x20)]) }] });
  check('an attachment over MAX_EMAIL_MB is a 413', oversized.status === 413, 'HTTP ' + oversized.status + ' ' + JSON.stringify(oversized.json));

  check('nothing has been delivered yet', smtp.sessions.length === 0, smtp.sessions.length + ' messages');

  // ── 2. The application itself ───────────────────────────────────────────────
  // A hostile "to" is sent along with the real fields: the recipient is this
  // service's setting, and a request must not be able to name one.
  const sent = await postEmail(srv.base, {
    key: KEY,
    fields: Object.assign({}, APP, { to: 'attacker@example.com' }),
    files: PDF_FILE,
  });
  check('a real application is accepted', sent.status === 200 && sent.json && sent.json.ok === true, 'HTTP ' + sent.status + ' ' + JSON.stringify(sent.json));
  check('exactly one message was delivered', smtp.sessions.length === 1, smtp.sessions.length + ' messages');

  const session = smtp.sessions[0] || { to: [], data: '', from: '' };
  const mail = session.data;
  check('the mail server was handed the office address as the only recipient',
    session.to.join(',') === '<' + OFFICE + '>', session.to.join(',') || '(none)');
  check('the message is addressed to the office, not to whatever the caller named',
    /^To: .*khuselamanagement@gmail\.com/m.test(mail) && !mail.includes('attacker@example.com'),
    mail.split('\n').slice(0, 12).join(' | '));
  check('it is sent from the configured mailbox', new RegExp('^From: .*' + SENDER + '', 'm').test(mail), '');
  check('the subject names the applicant', /^Subject: .*Thabo Mokoena/m.test(mail), mail.split('\n').find((l) => l.startsWith('Subject')) || '');
  check('the office can reply straight to the applicant', /^Reply-To: .*thabo@example\.com/m.test(mail), mail.split('\n').find((l) => l.startsWith('Reply-To')) || '');
  check('the body names the applicant and the ID number',
    mail.includes('Applicant: Thabo Mokoena') && mail.includes('ID number: 9001015800085'), '');

  const at = mail.indexOf('Content-Type: application/pdf');
  const headEnd = at < 0 ? -1 : mail.indexOf('\n\n', at);
  const payload = headEnd < 0 ? '' : mail.slice(headEnd + 2);
  const payloadLines = payload.split('\n');
  const boundaryAt = payloadLines.findIndex((l) => l.startsWith('--'));
  const b64 = payloadLines.slice(0, boundaryAt < 0 ? payloadLines.length : boundaryAt).join('');
  let attached = Buffer.alloc(0);
  try { attached = Buffer.from(b64, 'base64'); } catch (e) {}
  check('the PDF travels as an application/pdf attachment', at >= 0, 'no application/pdf part in the message');
  check('under the name the app gave it', /filename[*]?=["']?.*Khusela-Credit-Application-2026-09-30\.pdf/i.test(mail), '');
  check('and the bytes that arrive are the bytes that were sent', attached.equals(PDF),
    attached.length + ' bytes arrived, ' + PDF.length + ' were sent');
  check('the route logged the delivery', srv.log.join('').includes('Application emailed'), '');

  // ── 3. The limiter ─────────────────────────────────────────────────────────
  // Its own server, because the counter is per address and every request above
  // came from this machine.
  await stop(srv); srv = null;
  limited = startServer(3912, Object.assign({ EMAIL_API_KEY: KEY, EMAIL_RATE_LIMIT: '1', EMAIL_RATE_WINDOW_MS: '60000' }, MAILBOX));
  check('the rate-limited service starts', await waitReady(limited.base));
  const firstHit = await postEmail(limited.base, { key: KEY, fields: APP });
  const secondHit = await postEmail(limited.base, { key: KEY, fields: APP });
  check('the first application in the window is not limited', firstHit.status !== 429, 'HTTP ' + firstHit.status);
  check('the next one in the window is a 429', secondHit.status === 429, 'HTTP ' + secondHit.status);
  check('and it says how long to wait', !!secondHit.json && /wait/i.test(secondHit.json.error || ''), JSON.stringify(secondHit.json));
  await stop(limited); limited = null;

  // ── 4. A service with no mailbox ───────────────────────────────────────────
  // This is the state the PWA reads as "send it the old way", so it has to be a
  // 503 that says so rather than a 500 that says nothing.
  bare = startServer(3913, { SMTP_USER: '', SMTP_PASS: '', MAIL_TO: '', MAIL_FROM: '', SMTP_HOST: '' });
  check('the service with no mailbox starts anyway', await waitReady(bare.base));
  const bareHealth = await (await fetch(bare.base + '/health')).json();
  check('/health says the mailbox is not configured', bareHealth.emailConfigured === false, JSON.stringify(bareHealth));
  check('/health says the route is open to the app (no key needed)', bareHealth.emailProtected === false, JSON.stringify(bareHealth));
  const unconfigured = await postEmail(bare.base, { fields: APP, files: PDF_FILE });
  check('it answers 503 email_not_configured', unconfigured.status === 503 && unconfigured.json && unconfigured.json.error === 'email_not_configured',
    'HTTP ' + unconfigured.status + ' ' + JSON.stringify(unconfigured.json));
  check('and says what is missing', !!unconfigured.json && /mailbox/i.test(unconfigured.json.message || ''), JSON.stringify(unconfigured.json));
  check('startup announced that state rather than leaving it to be discovered',
    bare.log.join('').includes('no mailbox is configured'), bare.log.join('').slice(0, 200));
  await stop(bare); bare = null;
} catch (e) {
  fail++;
  console.log('  FAIL exception -- ' + (e && e.message));
} finally {
  if (srv) await stop(srv);
  if (limited) await stop(limited);
  if (bare) await stop(bare);
  await smtp.close();
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

