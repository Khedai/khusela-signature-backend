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
    // Small enough to reach in a test and large enough that the flow above never
    // meets it: the limiter is per address, and every request there is local.
    INVITE_RATE_LIMIT: '8', INVITE_RATE_WINDOW_MS: '60000',
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
  // A pad that cannot be drawn on is the same dead page in different clothes.
  // The form (and the canvas with it) starts `hidden`, so the measurement taken
  // at parse time is 0 x 0, and a zero-sized element receives no pointer events
  // at all: no stroke, no signature. The pad must be measured again once the
  // form is on screen, or the client has nothing to sign with.
  check('the signature pad is measured again once the form is on screen, not only while it is hidden',
    /hidden\s*=\s*false\s*;\s*size\(\)/.test(scriptSrc));

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
  // The client has no reason to stay on the page, so the note has to say so — and
  // the page must not keep a signed stroke on screen with both buttons live, or the
  // client reads it as a form that still has to be sent.
  check('the note tells the client the browser window can be closed',
    /close this browser window/i.test(comp.message || ''), comp.message);
  check('the page clears the pad, refuses further strokes and switches the buttons off when the signature lands',
    /done\s*=\s*true/.test(scriptSrc) && /clearPad\(\)/.test(scriptSrc)
      && /if\(done\)return/.test(scriptSrc) && /!\s*drawing\s*\|\|\s*done/.test(scriptSrc));

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

  // 7b. The client's own page is served by THIS service, so the browser stamps
  //     the client's upload and complete POSTs with this service's own origin.
  //     That origin is not in ALLOWED_ORIGINS (which names the consultant's
  //     app), so both were answered 403 "CORS origin denied": the client could
  //     load a session and then never submit, in the browser only — every
  //     request without an Origin header is allowed, which is why the suites
  //     never saw it. An unknown token makes this probe a 404 when it is
  //     allowed, so it asserts the origin rule without signing anything.
  const ownOrigin = await fetch(BASE + '/api/sign/not-a-real-token/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}',
  });
  check("a POST from the signing page's own origin is not refused",
    ownOrigin.status !== 403, 'HTTP ' + ownOrigin.status + ' ' + JSON.stringify(await ownOrigin.json()));

  // Allowing the service its own origin must not let anyone else in.
  const stranger = await fetch(BASE + '/api/sign/not-a-real-token/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }, body: '{}',
  });
  check('a POST carrying an unlisted origin is still refused with 403',
    stranger.status === 403, 'HTTP ' + stranger.status);

  // 7c. Who may mint a signing link. This instance runs without INVITE_API_KEY, so
  //     POST /api/invite falls back to "callers that look like the consultant's app,
  //     or that come from this machine" — which is why every invite above works.
  //     What must not work is a stranger's headerless request. A public
  //     X-Forwarded-For is how a request from elsewhere is presented to a server
  //     that trusts one proxy hop, which is what this suite runs.
  const healthHere = await (await fetch(BASE + '/health')).json();
  check('/health reports the invite endpoint as unprotected while INVITE_API_KEY is unset',
    healthHere.inviteProtected === false, JSON.stringify(healthHere));
  const refused = await fetch(BASE + '/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ clientName: 'Stranger', idNumber: '9001015800083' }),
  });
  check('a headerless invite request from a public address is refused with 401',
    refused.status === 401, 'HTTP ' + refused.status + ' ' + (await refused.text()).slice(0, 120));

  // The app's own request always carries its Origin, so that one still works — from
  // a public address as well, which shows the refusal above was the missing Origin
  // and not the address it came from.
  const appInvite = await fetch(BASE + '/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10', Origin: 'https://itc-extractor.vercel.app' },
    body: JSON.stringify({ clientName: 'App Caller', idNumber: '9001015800083', applicationRef: 'INVITE-GATE-CHECK' }),
  });
  const appInviteBody = await appInvite.json();
  check('the same request carrying the app\'s Origin header is accepted (the PWA path)',
    appInvite.status === 200 && !!appInviteBody.signingLink,
    'HTTP ' + appInvite.status + ' ' + JSON.stringify(appInviteBody).slice(0, 120));

  // The limit is real, and it counts refused requests too, so a script cannot
  // hammer the route by being refused: the ninth request from one address inside
  // the window is answered 429 rather than creating a tenth link.
  const limiterIp = '198.51.100.7';
  const limiter = [];
  for (let i = 1; i <= 9; i++) {
    limiter.push(await fetch(BASE + '/api/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': limiterIp, Origin: 'https://itc-extractor.vercel.app' },
      body: JSON.stringify({ clientName: 'Rate ' + i, idNumber: '9001015800083', applicationRef: 'RATE-LIMIT-CHECK' }),
    }));
  }
  check('the ninth invite from one address is refused with 429 (INVITE_RATE_LIMIT=8 here)',
    limiter.filter((r) => r.status === 200).length === 8 && limiter[8].status === 429,
    limiter.map((r) => r.status).join(','));

  // 7d. What the audit remembers about where a request came from. One proxy hop is
  //     trusted, so the address that hop appended is the client's; a chain the
  //     caller wrote itself must not be able to put a different address in the row,
  //     and the whole chain is kept next to it either way. The address that ends up
  //     with a signature is the one the SIGNING request came from, so that is where
  //     the chain is written here.
  const addressInvite = async () => (await fetch(BASE + '/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://itc-extractor.vercel.app' },
    body: JSON.stringify({ clientName: 'Address Check', idNumber: '9001015800083', applicationRef: 'ADDRESS-CHECK' }),
  })).json();
  const signFrom = async (chain) => {
    const inv = await addressInvite();
    await fetch(BASE + '/api/sign/' + inv.signingLink.split('/').pop() + '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': chain },
      body: JSON.stringify({ signature: PNG }),
    });
    return inv;
  };
  const oneHop = await signFrom('203.0.113.11');
  const forged = await signFrom('9.9.9.9, 203.0.113.12');
  const adminOf = async (id) => (await fetch(BASE + '/api/admin/invite/' + id,
    { headers: { 'x-admin-key': 'test-key' } })).json();
  const oneHopRow = await adminOf(oneHop.invitationId);
  check('the address recorded with a signature is the one the proxy appended',
    oneHopRow.signature && oneHopRow.signature.ip === '203.0.113.11', JSON.stringify(oneHopRow.signature));
  const forgedRow = await adminOf(forged.invitationId);
  check('a caller cannot name itself in the row by writing X-Forwarded-For',
    forgedRow.signature && forgedRow.signature.ip === '203.0.113.12', JSON.stringify(forgedRow.signature));
  const signedEntry = (forgedRow.audit || []).find((a) => a.event === 'client_signed');
  let signedMeta = null;
  try { signedMeta = JSON.parse(signedEntry.meta); } catch (e) { signedMeta = null; }
  check('the audit entry keeps the whole chain the request arrived in (meta.xff)',
    !!signedMeta && signedMeta.xff === '9.9.9.9, 203.0.113.12', signedEntry ? signedEntry.meta : 'no client_signed entry');

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

  // 12. The switch that closes POST /api/invite properly: with INVITE_API_KEY set,
  //     nothing but the key is accepted — including the app's own request, which is
  //     exactly why it stays off until the PWA sends one. A second instance on a
  //     second port, with its own scratch database, is what makes that path testable
  //     before it is ever switched on in production.
  const KEY_PORT = 3902;
  const KEY_BASE = 'http://127.0.0.1:' + KEY_PORT;
  const KEY_DB = path.join(ROOT, 'storage', '_e2e_test_key.db');
  for (const f of [KEY_DB, KEY_DB + '-wal', KEY_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  const keyChild = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(KEY_PORT), TURSO_DATABASE_URL: 'file:./storage/_e2e_test_key.db', PUBLIC_BASE_URL: KEY_BASE,
      ALLOWED_ORIGINS: 'https://itc-extractor.vercel.app', ADMIN_API_KEY: 'test-key', REQUIRE_DOCUMENTS: 'false',
      INVITE_API_KEY: 'suite-invite-key',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  keyChild.stdout.on('data', () => {});
  keyChild.stderr.on('data', () => {});
  try {
    let keyReady = false;
    for (let i = 0; i < 80 && !keyReady; i++) {
      try { keyReady = (await fetch(KEY_BASE + '/api/sign/nope')).status === 404; } catch (e) {}
      if (!keyReady) await new Promise((r) => setTimeout(r, 250));
    }
    check('a second instance starts with INVITE_API_KEY set', keyReady);
    const keyHealth = await (await fetch(KEY_BASE + '/health')).json();
    check('/health reports the invite endpoint as protected once a key is set',
      keyHealth.inviteProtected === true, JSON.stringify(keyHealth));
    const appHeaders = { 'Content-Type': 'application/json', Origin: 'https://itc-extractor.vercel.app' };
    const inviteBody = JSON.stringify({ clientName: 'Key Check', idNumber: '9001015800083' });
    const noKey = await fetch(KEY_BASE + '/api/invite', { method: 'POST', headers: appHeaders, body: inviteBody });
    check('the app Origin alone is not enough once a key is set (401)', noKey.status === 401, 'HTTP ' + noKey.status);
    const wrongKey = await fetch(KEY_BASE + '/api/invite', {
      method: 'POST', headers: Object.assign({ 'x-invite-key': 'not-the-key' }, appHeaders), body: inviteBody,
    });
    check('a key of the wrong length is refused as a wrong key, not as a fault (401)',
      wrongKey.status === 401, 'HTTP ' + wrongKey.status);
    const keyOk = await fetch(KEY_BASE + '/api/invite', {
      method: 'POST', headers: Object.assign({ 'x-invite-key': 'suite-invite-key' }, appHeaders), body: inviteBody,
    });
    const keyOkBody = await keyOk.json();
    check('the key is accepted and a link comes back', keyOk.status === 200 && !!keyOkBody.signingLink,
      'HTTP ' + keyOk.status + ' ' + JSON.stringify(keyOkBody).slice(0, 120));
    const bearer = await fetch(KEY_BASE + '/api/invite', {
      method: 'POST', headers: Object.assign({ Authorization: 'Bearer suite-invite-key' }, appHeaders), body: inviteBody,
    });
    check('the key is accepted as a bearer token too', bearer.status === 200, 'HTTP ' + bearer.status);
  } finally {
    keyChild.kill();
    await new Promise((r) => setTimeout(r, 800));
    for (const f of [KEY_DB, KEY_DB + '-wal', KEY_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  }
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
