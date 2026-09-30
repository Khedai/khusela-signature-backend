// Proves that a captured signature outlives the server process.
//
// Render restarts this service on every deploy and wakes it from sleep on the
// first request after a quiet spell, so "the signature is still there" has to be
// a property of the database rather than of the process that happened to write
// it. This starts the real server, captures a signature, kills the process the
// way a deploy does, starts a second process against the same database and asks
// for the same signature again — including that the one-time link is still burned.
//
//   node tools/test_restart.js                        # a scratch local file
//   E2E_DB_URL=libsql://… TURSO_AUTH_TOKEN=… node tools/test_restart.js
//
// The second form is the one that matters before a deploy: it runs against the
// same remote database Render will use.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 3902;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.E2E_DB_URL || 'file:./storage/_e2e_restart.db';
const LOCAL_DB = path.join(ROOT, 'storage', '_e2e_restart.db');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');

if (!process.env.E2E_DB_URL) {
  // The storage folder is not in git — only the databases inside it are ignored
  // — and db.js creates it only for its own default path, so a fresh checkout has
  // nowhere for a scratch database to live.
  fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
  for (const f of [LOCAL_DB, LOCAL_DB + '-wal', LOCAL_DB + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch (e) {}
  }
}
console.log('restart survival against: ' + DB_URL + '\n');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TURSO_DATABASE_URL: DB_URL, PUBLIC_BASE_URL: BASE,
      ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app', ADMIN_API_KEY: 'test-key', REQUIRE_DOCUMENTS: 'false',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/sign/nope'); if (r.status === 404) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// A killed process leaves the port shut within a moment. Starting the second
// process before that has happened would fail to bind, which would look like a
// database problem and send the next reader hunting in the wrong place.
async function stopServer(child) {
  child.kill();
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/sign/nope'); } catch (e) { return true; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let first = null, second = null, inv = null, token = null;
try {
  first = startServer();
  check('the server starts on a fresh process', await waitReady());

  inv = await (await fetch(BASE + '/api/invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'Restart Test', idNumber: '9001015800085', signerLabel: 'Applicant 1' }),
  })).json();
  check('an invitation is created', !!(inv.invitationId && inv.manageToken && inv.signingLink), JSON.stringify(inv));
  token = inv.signingLink.split('/').pop();

  const compRes = await fetch(BASE + '/api/sign/' + token + '/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: PNG }),
  });
  check('a signature is captured', compRes.status === 200, String(compRes.status));

  // The deploy: the process that wrote the signature goes away for good.
  check('the first process shuts down and frees the port', await stopServer(first));
  first = null;

  second = startServer();
  check('a second process starts against the same database', await waitReady());

  const manRes = await fetch(BASE + '/api/manage/' + inv.manageToken);
  const man = await manRes.json();
  check('the signature is still there, read by the new process',
    manRes.status === 200 && man.status === 'signed' && !!man.signedAt, JSON.stringify(man));

  const imgRes = await fetch(BASE + '/api/manage/' + inv.manageToken + '/signature');
  const buf = Buffer.from(await imgRes.arrayBuffer());
  check('the signature bytes come back unchanged after the restart',
    imgRes.status === 200 && buf.equals(PNG_BYTES), 'got ' + buf.length + ' bytes, expected ' + PNG_BYTES.length);

  // The rule that a signing link works once is a row in the database, so a
  // restart must not hand the signer a second chance.
  check('the used signing link is still refused (410)', (await fetch(BASE + '/api/sign/' + token)).status === 410);

  const adminRes = await fetch(BASE + '/api/admin/invite/' + inv.invitationId, { headers: { 'x-admin-key': 'test-key' } });
  check('the invitation is still readable through the admin API', adminRes.status === 200, String(adminRes.status));
} catch (e) {
  fail++;
  console.log('  FAIL exception -- ' + (e && e.message));
} finally {
  for (const c of [first, second]) { if (c) c.kill(); }
  await new Promise((r) => setTimeout(r, 800));
  if (!process.env.E2E_DB_URL) {
    for (const f of [LOCAL_DB, LOCAL_DB + '-wal', LOCAL_DB + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch (e) {}
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
