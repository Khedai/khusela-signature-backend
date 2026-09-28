// End-to-end test of the ITC application's signature flow:
//   invite -> signing page data -> status polling -> signature -> signature image
// Runs the real server on a scratch database, so nothing is left behind.
//   node tools/test_signature_flow.js
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 3901;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_e2e_test.db');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: './storage/_e2e_test.db', PUBLIC_BASE_URL: BASE,
    ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app', ADMIN_API_KEY: 'test-key', REQUIRE_DOCUMENTS: 'false',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/sign/nope'); if (r.status === 404) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  check('server starts', await waitReady());

  // 1. The PWA creates an Applicant 1 signing request.
  const invRes = await fetch(BASE + '/api/invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'Thabo Mokoena', idNumber: '9001015800085', signerLabel: 'Applicant 1', applicationRef: 'KHM-0001' }),
  });
  const inv = await invRes.json();
  check('POST /api/invite 200', invRes.status === 200, JSON.stringify(inv));
  check('returns signingLink + manageToken + invitationId', !!(inv.signingLink && inv.manageToken && inv.invitationId));
  check('manageToken is NOT inside the signing link', !inv.signingLink.includes(inv.manageToken));

  const token = inv.signingLink.split('/').pop();

  // 2. The client's signing page loads it.
  const sign = await (await fetch(BASE + '/api/sign/' + token)).json();
  check('signerLabel echoed to the signing page', sign.signerLabel === 'Applicant 1', JSON.stringify(sign));
  check('documents not required for a signature-only request', sign.requireDocuments === false);
  check('client name shown', sign.clientName === 'Thabo Mokoena');

  // 3. The PWA polls before signing.
  let man = await (await fetch(BASE + '/api/manage/' + inv.manageToken)).json();
  check('status pending before signing', man.status === 'pending' && man.signatureUrl === null, JSON.stringify(man));
  check('an unknown manage token is rejected', (await fetch(BASE + '/api/manage/not-a-token')).status === 404);

  // 4. The client signs with NO documents uploaded.
  const compRes = await fetch(BASE + '/api/sign/' + token + '/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: PNG }),
  });
  const comp = await compRes.json();
  check('signature accepted without documents', compRes.status === 200, JSON.stringify(comp));

  // 5. The PWA sees it and can display it in the box.
  man = await (await fetch(BASE + '/api/manage/' + inv.manageToken)).json();
  check('status signed after signing', man.status === 'signed' && !!man.signedAt, JSON.stringify(man));
  check('manage token still usable after signing', man.signatureUrl !== null);

  const imgRes = await fetch(BASE + '/api/manage/' + inv.manageToken + '/signature');
  const buf = Buffer.from(await imgRes.arrayBuffer());
  check('signature image served as a real PNG',
    imgRes.status === 200 && String(imgRes.headers.get('content-type')).includes('image/png') && buf.subarray(1, 4).toString() === 'PNG',
    imgRes.headers.get('content-type'));

  // 6. The client's one-time link is burned.
  check('signed link can no longer be used', (await fetch(BASE + '/api/sign/' + token)).status === 410);

  // 7. CORS: the PWA's own origin is allowed.
  const pre = await fetch(BASE + '/api/invite', {
    method: 'OPTIONS',
    headers: { Origin: 'https://itc-extractor.vercel.app', 'Access-Control-Request-Method': 'POST' },
  });
  check('CORS preflight allows the PWA origin', pre.status < 400 && !!pre.headers.get('access-control-allow-origin'),
    pre.headers.get('access-control-allow-origin') || 'no header');

  // An origin outside the list must be refused outright.
  const denied = await fetch(BASE + '/api/invite', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  check('CORS preflight refuses an unlisted origin',
    denied.status >= 400 || !denied.headers.get('access-control-allow-origin'),
    'status ' + denied.status + ', allow-origin ' + (denied.headers.get('access-control-allow-origin') || 'none'));

  // Matching is exact, so a trailing slash in ALLOWED_ORIGINS silently blocks the
  // real site — the browser never sends one. This is the reason .env keeps it bare.
  const slash = await fetch(BASE + '/api/invite', {
    method: 'OPTIONS',
    headers: { Origin: 'https://itc-extractor.vercel.app/', 'Access-Control-Request-Method': 'POST' },
  });
  check('a trailing slash in the origin list does NOT match',
    slash.status >= 400 || !slash.headers.get('access-control-allow-origin'),
    'status ' + slash.status);

  // 8. Admin access: a missing or wrong-length key must be a clean 401, not the
  //    400 the constant-time comparison used to produce.
  const noKey = await fetch(BASE + '/api/admin/invites');
  check('admin endpoint refuses a missing key with 401', noKey.status === 401, String(noKey.status));
  const badKey = await fetch(BASE + '/api/admin/invites', { headers: { 'x-admin-key': 'wrong-length-key' } });
  check('admin endpoint refuses a wrong-length key with 401', badKey.status === 401, String(badKey.status));
  const goodKey = await fetch(BASE + '/api/admin/invites', { headers: { 'x-admin-key': 'test-key' } });
  check('admin endpoint accepts the configured key', goodKey.status === 200, String(goodKey.status));

  // 9. Two applicants are independent.
  const inv2 = await (await fetch(BASE + '/api/invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'Thabo Mokoena', idNumber: '9001015800085', signerLabel: 'Applicant 2' }),
  })).json();
  check('second applicant gets an independent link',
    inv2.invitationId !== inv.invitationId && inv2.signingLink !== inv.signingLink);
  const man2 = await (await fetch(BASE + '/api/manage/' + inv2.manageToken)).json();
  check('Applicant 2 still pending while Applicant 1 is signed',
    man2.status === 'pending' && man2.signerLabel === 'Applicant 2', JSON.stringify(man2));
} catch (e) {
  fail++;
  console.log('  FAIL exception -- ' + (e && e.message));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
