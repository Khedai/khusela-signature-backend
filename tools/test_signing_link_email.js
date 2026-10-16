// Test of the signing-link email route:
//   POST /api/notify/email  (the PWA asks this service to mail a client's signing
//   link to the address already held on that signing request)
//   node tools/test_signing_link_email.js
//
// Nothing leaves this machine. SMTP_HOST points at a fake SMTP server started by
// this file, so the message is composed and delivered for REAL — headers, MIME
// and the HTML body included — with no account and no internet. That is what lets
// the checks read what the client would actually receive, and, more to the point
// here, WHERE it would be delivered: this route is the only one in the service
// whose recipient is not the office, so the recipient is the thing under test.
//
// The failure this locks down is a mail relay. The app hands over a manage token
// and a link, and both are attacker-supplied in a copied request, so every check
// below is about what the route will and will not send, and to whom:
//   • an unknown manage token is not a mailbox at all;
//   • a link minted for a DIFFERENT request is refused, not forwarded;
//   • the recipient is the address on the database row, never one in the body —
//     the request below that tries to name its own recipient is the point of it.
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DB = path.join(ROOT, 'storage', '_notify_test.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
fs.mkdirSync(path.dirname(DB), { recursive: true });

const OFFICE = 'khuselamanagement@gmail.com';
const SENDER = 'khuselamanagement@gmail.com';
const CLIENT = 'thabo.mokoena@example.com';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

// ── A fake SMTP server ───────────────────────────────────────────────────────
// Enough of RFC 5321 to accept one message per connection. Everything received
// is kept so the test can read the delivered message.
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
          if (line === '.') { inData = false; say('250 2.0.0 Ok: queued as FAKE1'); }
          else s.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          socket.write('250-fake.khusela.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 26214400\r\n');
          continue;
        }
        if (auth === 1) { auth = 2; say('334 ' + b64('Password:')); continue; }
        if (auth === 2) { auth = 0; say('235 2.7.0 Authentication successful'); continue; }
        if (cmd.startsWith('AUTH LOGIN')) { auth = 1; say('334 ' + b64('Username:')); continue; }
        if (cmd.startsWith('AUTH PLAIN')) { say('235 2.7.0 Authentication successful'); continue; }
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
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

function startServer(port, extra) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      TURSO_DATABASE_URL: 'file:./storage/_notify_test.db',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app',
      ADMIN_API_KEY: 'test-key',
      TRUST_PROXY_HOPS: '1',
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

const KEY = 'test-email-key';

async function post(base, pathname, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-email-key'] = key;
  const res = await fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

// A signing request created the way the app creates one.
async function invite(base, over) {
  const res = await post(base, '/api/invite', Object.assign({
    clientName: 'Thabo Mokoena',
    idNumber: '9001015800085',
    phone: '0821234567',
    email: CLIENT,
    signerLabel: 'Applicant 1',
    applicationRef: 'KDM-2026-014',
  }, over || {}));
  return res.json;
}

const MAILBOX = {
  SMTP_HOST: '127.0.0.1', SMTP_SECURE: 'false',
  SMTP_USER: SENDER, SMTP_PASS: 'fake-app-password',
  MAIL_TO: OFFICE, MAIL_FROM: SENDER,
};

const smtp = await startFakeSmtp();
const MAILBOX_ENV = Object.assign({ SMTP_PORT: String(smtp.port) }, MAILBOX);
let srv = null, limited = null, bare = null;

try {
  srv = startServer(3921, Object.assign({ EMAIL_API_KEY: KEY, EMAIL_RATE_LIMIT: '50' }, MAILBOX_ENV));
  check('server starts', await waitReady(srv.base));

  const one = await invite(srv.base);
  check('a signing request is created for the test', !!(one && one.signingLink && one.manageToken), JSON.stringify(one));

  // ── 1. Who may send this ────────────────────────────────────────────────────
  const noKey = await post(srv.base, '/api/notify/email', { manageToken: one.manageToken, signingLink: one.signingLink });
  check('a caller with no key is refused', noKey.status === 401, 'HTTP ' + noKey.status);
  const wrongKey = await post(srv.base, '/api/notify/email', { manageToken: one.manageToken, signingLink: one.signingLink }, 'not-the-key');
  check('a caller with the wrong key is refused', wrongKey.status === 401, 'HTTP ' + wrongKey.status);
  check('and nothing was delivered while they were being refused', smtp.sessions.length === 0, smtp.sessions.length + ' messages');

  // ── 2. What it will not send ───────────────────────────────────────────────
  const unknown = await post(srv.base, '/api/notify/email', { manageToken: 'made-up-token', signingLink: one.signingLink }, KEY);
  check('an unknown manage token is a 404, not a mailbox', unknown.status === 404, 'HTTP ' + unknown.status + ' ' + JSON.stringify(unknown.json));

  const empty = await post(srv.base, '/api/notify/email', { manageToken: '', signingLink: '' }, KEY);
  check('a request with neither token nor link is a 404', empty.status === 404, 'HTTP ' + empty.status);

  // A second request, so there is a real link that belongs to a DIFFERENT row:
  // this is the case that would forward one client's signing link to another.
  const other = await invite(srv.base, { clientName: 'Nomsa Dlamini', email: 'nomsa@example.com' });
  const crossed = await post(srv.base, '/api/notify/email', { manageToken: one.manageToken, signingLink: other.signingLink }, KEY);
  check("another request's link is refused", crossed.status === 400, 'HTTP ' + crossed.status + ' ' + JSON.stringify(crossed.json));
  check('and says the link was not issued for this request', /not issued by this service/i.test((crossed.json && crossed.json.error) || ''), JSON.stringify(crossed.json));

  const forged = await post(srv.base, '/api/notify/email', { manageToken: one.manageToken, signingLink: srv.base + '/sign/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, KEY);
  check('a link this service never minted is refused', forged.status === 400, 'HTTP ' + forged.status);

  // A request created with no address has nowhere to send the mail, and must not
  // borrow one from the request that is asking.
  const noEmail = await invite(srv.base, { clientName: 'Pieter Botha', email: '' });
  const homeless = await post(srv.base, '/api/notify/email', {
    manageToken: noEmail.manageToken,
    signingLink: noEmail.signingLink,
    to: 'attacker@example.com', email: 'attacker@example.com',
  }, KEY);
  check('a request with no email address cannot be emailed', homeless.status === 422, 'HTTP ' + homeless.status + ' ' + JSON.stringify(homeless.json));
  check('and it says what to do about it', /email/i.test((homeless.json && homeless.json.error) || ''), JSON.stringify(homeless.json));

  // A row whose address is not an address is not one to send to either.
  const badEmail = await invite(srv.base, { clientName: 'Sipho Mahlangu', email: 'not-an-address' });
  const bad = await post(srv.base, '/api/notify/email', { manageToken: badEmail.manageToken, signingLink: badEmail.signingLink }, KEY);
  check('an address that is not an address is refused', bad.status === 422, 'HTTP ' + bad.status);

  check('none of that produced a single message', smtp.sessions.length === 0, smtp.sessions.length + ' messages');

  // ── 3. The link itself ─────────────────────────────────────────────────────
  const sent = await post(srv.base, '/api/notify/email', {
    manageToken: one.manageToken,
    signingLink: one.signingLink,
    // The request names its own recipient. It must have no effect at all.
    to: 'attacker@example.com', email: 'attacker@example.com', recipient: 'attacker@example.com',
  }, KEY);
  check('the real link is emailed', sent.status === 200 && sent.json && sent.json.ok === true, 'HTTP ' + sent.status + ' ' + JSON.stringify(sent.json));
  check('exactly one message was delivered', smtp.sessions.length === 1, smtp.sessions.length + ' messages');

  const session = smtp.sessions[0] || { to: [], data: '', from: '' };
  const mail = session.data;
  // The wire format is quoted-printable, so a long line (a URL) arrives broken
  // with "=" soft breaks and "=3D" for characters a mail client would otherwise
  // mangle. Undo both before reading the message, exactly as a mail client does —
  // asserting against the encoded bytes would only prove that nodemailer encoded
  // it. The soft break may be "=\r\n" or "=\n": this fake server joins the lines
  // it received with "\n", and a regex written for one of the two silently
  // decodes nothing at all for the other.
  const decoded = mail.replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (process.env.DUMP_MAIL) fs.writeFileSync(path.join(ROOT, 'storage', '_notify_mail.txt'), mail);
  check('it went to the address held on the signing request, and nowhere else',
    session.to.length === 1 && session.to[0] === '<' + CLIENT + '>', session.to.join(',') || '(none)');
  check('a recipient named in the request is ignored', !mail.includes('attacker@example.com'),
    mail.split('\n').filter((l) => /attacker/.test(l)).join(' | '));
  check('it is sent from the office mailbox', new RegExp('^From: .*' + SENDER, 'm').test(mail), '');
  check('the office stays the reply address', /^Reply-To: .*khuselamanagement@gmail\.com/m.test(mail),
    mail.split('\n').find((l) => l.startsWith('Reply-To')) || '(no Reply-To)');
  check('the subject names the application reference, not the client',
    /^Subject: .*KDM-2026-014/m.test(mail), mail.split('\n').find((l) => l.startsWith('Subject')) || '');

  // The payload is the link, in both bodies: a mail client that rewrites URLs
  // would break an HTML-only link, and most clients will not make a bare URL in
  // a text body clickable.
  const quoted = one.signingLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  check('the link is in the plain-text body', new RegExp(quoted).test(decoded.split('Content-Type: text/html')[0]), '');
  check('and in the HTML body as a clickable link', /href="https?:\/\/[^"]*\/sign\/[A-Za-z0-9_-]+"/.test(decoded),
    (decoded.match(/<a href="[^"]*"/) || ['(no anchor)'])[0]);
  check('the body greets the client by name', decoded.includes('Hi Thabo Mokoena'), '');
  check('it says what to do and that signing is once only',
    /draw your signature/i.test(decoded) && /only sign once/i.test(decoded), '');
  check('the expiry is stated', /expires/i.test(decoded), '');
  check('the route logged the delivery', srv.log.join('').includes('Signing link emailed'), '');
  check("and the client's address is not in that log line",
    !/Signing link emailed.*thabo\.mokoena@example\.com/.test(srv.log.join('')), '');

  // ── 4. A link that has been used ───────────────────────────────────────────
  const token = one.signingLink.split('/sign/')[1];
  const done = await fetch(srv.base + '/api/sign/' + encodeURIComponent(token) + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: 'data:image/png;base64,iVBORw0KGgo=' }),
  });
  check('the client signs with that link', done.status === 200, 'HTTP ' + done.status);
  const afterSign = await post(srv.base, '/api/notify/email', { manageToken: one.manageToken, signingLink: one.signingLink }, KEY);
  check('a link that has already been used is a 409', afterSign.status === 409, 'HTTP ' + afterSign.status + ' ' + JSON.stringify(afterSign.json));
  check('and no second message went out', smtp.sessions.length === 1, smtp.sessions.length + ' messages');

  // ── 5. The limiter ─────────────────────────────────────────────────────────
  // Its own server: the counters are per address and every request above came
  // from this machine.
  await stop(srv); srv = null;
  limited = startServer(3922, Object.assign({ EMAIL_API_KEY: KEY, NOTIFY_RATE_LIMIT: '1', NOTIFY_RATE_WINDOW_MS: '60000' }, MAILBOX_ENV));
  check('the rate-limited service starts', await waitReady(limited.base));
  const inv = await invite(limited.base, { email: 'first@example.com' });
  const hit1 = await post(limited.base, '/api/notify/email', { manageToken: inv.manageToken, signingLink: inv.signingLink }, KEY);
  const hit2 = await post(limited.base, '/api/notify/email', { manageToken: inv.manageToken, signingLink: inv.signingLink }, KEY);
  check('the first link in the window is not limited', hit1.status === 200, 'HTTP ' + hit1.status);
  check('the next one in the window is a 429', hit2.status === 429, 'HTTP ' + hit2.status);
  check('and it says how long to wait, about links rather than applications',
    /wait/i.test((hit2.json && hit2.json.error) || '') && /signing links/i.test((hit2.json && hit2.json.error) || ''),
    JSON.stringify(hit2.json));
  await stop(limited); limited = null;

  // ── 6. A service with no mailbox ───────────────────────────────────────────
  // The state the app reads as "this cannot send it" — a 503 it already knows,
  // never a false success.
  bare = startServer(3923, { SMTP_USER: '', SMTP_PASS: '', MAIL_TO: '', MAIL_FROM: '', SMTP_HOST: '' });
  check('the service with no mailbox starts anyway', await waitReady(bare.base));
  const bareInv = await invite(bare.base);
  const unconfigured = await post(bare.base, '/api/notify/email', { manageToken: bareInv.manageToken, signingLink: bareInv.signingLink });
  check('it answers 503 email_not_configured',
    unconfigured.status === 503 && unconfigured.json && unconfigured.json.error === 'email_not_configured',
    'HTTP ' + unconfigured.status + ' ' + JSON.stringify(unconfigured.json));
  await stop(bare); bare = null;
} catch (e) {
  fail++;
  console.log('  FAIL exception -- ' + (e && e.stack ? e.stack.split('\n')[0] : e));
} finally {
  if (srv) await stop(srv);
  if (limited) await stop(limited);
  if (bare) await stop(bare);
  await smtp.close();
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}