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
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');
const PDF = Buffer.from('%PDF-1.4 test document');

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

// The server keeps signatures and documents in the database now, so nothing it
// does may add a file to the host's disk. Count what is already lying around
// (older runs left files here) and compare again once the flow has finished.
const SIG_DIR = path.join(ROOT, 'storage', 'signatures');
const UPLOAD_DIR = path.join(ROOT, 'storage', 'uploads');
const countFiles = (dir) => { try { return fs.readdirSync(dir).length; } catch (e) { return 0; } };
const sigFilesBefore = countFiles(SIG_DIR);
const upFilesBefore = countFiles(UPLOAD_DIR);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    // E2E_DB_URL points this same suite at a real libSQL server (http://… or
    // libsql://…), which is the path Render uses; unset it to use a scratch file.
    PORT: String(PORT), TURSO_DATABASE_URL: process.env.E2E_DB_URL || 'file:./storage/_e2e_test.db', PUBLIC_BASE_URL: BASE,
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

  // 2. The client's signing page loads it — starting with the page itself, since
  //    that is all the client receives. A 404 here would leave them looking at
  //    "Cannot GET /sign/…" with no way to sign, which is why the route exists.
  const pageRes = await fetch(inv.signingLink);
  const pageHtml = await pageRes.text();
  check('the signing link serves the signing page', pageRes.status === 200 && pageHtml.includes('Khusela Secure Digital Signature'), 'HTTP ' + pageRes.status);

  // The page must actually RUN in a browser. Two separate faults once made it
  // render and do nothing: the script was inline while server.js sends helmet's
  // default CSP (script-src 'self', which refuses inline scripts), and that
  // script was itself invalid — load() declared `const r` and also `var r`, and
  // const and var share a function's scope, which V8 rejects as an early
  // SyntaxError. Either fault alone leaves the client staring at "Loading your
  // secure signing session…" for ever, so both are checked here.
  const scriptTags = pageHtml.match(/<script\b[^>]*>/gi) || [];
  const inlineTags = scriptTags.filter((tag) => !/\bsrc=/i.test(tag));
  check('the page carries no inline <script> (the CSP would refuse it)',
    inlineTags.length === 0, inlineTags.join(' ') || 'none');
  const srcMatch = pageHtml.match(/<script\b[^>]*\bsrc="([^"]+)"/i);
  check('the page loads its script by an absolute path, not one relative to /sign/<token>',
    !!srcMatch && srcMatch[1].startsWith('/'), srcMatch ? srcMatch[1] : 'no src attribute');
  const scriptRes = await fetch(BASE + srcMatch[1]);
  const scriptSrc = await scriptRes.text();
  check('that script is served', scriptRes.status === 200, 'HTTP ' + scriptRes.status);
  let parseError = null;
  try { new Function(scriptSrc); } catch (e) { parseError = e.message; }
  check('that script is valid JavaScript the browser will parse (V8)', !parseError, parseError || 'parses');
  check('it reads the token out of the path and posts the signature to /complete',
    scriptSrc.includes('location.pathname') && scriptSrc.includes('/complete'));

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
  // The bytes must come back out of the database exactly as they went in.
  check('signature bytes round-trip exactly', buf.equals(PNG_BYTES),
    'got ' + buf.length + ' bytes, expected ' + PNG_BYTES.length);

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

  // 10. Uploaded documents go into the database too — the other half of "no disk".
  //     Uploaded against Applicant 2 so the signature-only flow above is exercised
  //     exactly as the PWA uses it.
  const token2 = inv2.signingLink.split('/').pop();
  const form = new FormData();
  form.append('kind', 'id');
  form.append('documents', new Blob([PDF], { type: 'application/pdf' }), 'id-copy.pdf');
  const upRes = await fetch(BASE + '/api/sign/' + token2 + '/upload', { method: 'POST', body: form });
  const up = await upRes.json();
  check('uploading a document succeeds', upRes.status === 200 && up.count === 1, JSON.stringify(up));

  const admin2 = await (await fetch(BASE + '/api/admin/invite/' + inv2.invitationId,
    { headers: { 'x-admin-key': 'test-key' } })).json();
  check('uploaded document is recorded with its name, type and size',
    admin2.documents.length === 1 && admin2.documents[0].original_name === 'id-copy.pdf'
      && admin2.documents[0].mime_type === 'application/pdf' && admin2.documents[0].size === PDF.length,
    JSON.stringify(admin2.documents));

  const admin1 = await (await fetch(BASE + '/api/admin/invite/' + inv.invitationId,
    { headers: { 'x-admin-key': 'test-key' } })).json();
  check('Applicant 1 has no documents of their own', admin1.documents.length === 0, JSON.stringify(admin1.documents));

  // A refused upload is the client's mistake and must be answered as one: a 4xx
  // that names the rule, never the 500 the error handler keeps for faults on this
  // side (a database it cannot reach). Both are refused before the database is
  // touched.
  const wrongType = new FormData();
  wrongType.append('documents', new Blob([Buffer.from('not a document')], { type: 'text/plain' }), 'notes.txt');
  const wrongTypeRes = await fetch(BASE + '/api/sign/' + token2 + '/upload', { method: 'POST', body: wrongType });
  const wrongTypeBody = await wrongTypeRes.json();
  check('a file of the wrong type is refused as a client error, not a 500',
    wrongTypeRes.status === 400 && /Only PDF, JPG and PNG/.test(wrongTypeBody.error || ''),
    wrongTypeRes.status + ' ' + JSON.stringify(wrongTypeBody));

  const tooBig = new FormData();
  tooBig.append('documents', new Blob([Buffer.alloc(16 * 1024 * 1024)], { type: 'application/pdf' }), 'huge.pdf');
  const tooBigRes = await fetch(BASE + '/api/sign/' + token2 + '/upload', { method: 'POST', body: tooBig });
  check('a file larger than MAX_UPLOAD_MB is refused with 413, not a 500',
    tooBigRes.status === 413, String(tooBigRes.status));

  const afterRefusals = await (await fetch(BASE + '/api/admin/invite/' + inv2.invitationId,
    { headers: { 'x-admin-key': 'test-key' } })).json();
  check('neither refused upload stored a document row',
    afterRefusals.documents.length === 1, JSON.stringify(afterRefusals.documents));


  // 11. The whole point of moving off the filesystem: after a signature and an
  //     upload, not one file has been added to the host's disk.
  check('signing wrote no file to disk', countFiles(SIG_DIR) === sigFilesBefore,
    SIG_DIR + ' holds ' + countFiles(SIG_DIR) + ' files, was ' + sigFilesBefore);
  check('uploading wrote no file to disk', countFiles(UPLOAD_DIR) === upFilesBefore,
    UPLOAD_DIR + ' holds ' + countFiles(UPLOAD_DIR) + ' files, was ' + upFilesBefore);
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
