// Is the deployed service running the code in this repository?
//
// Deploying this server is the one step that no test here can do: Render has to
// be told, and this repository is not what tells it. The service does not watch
// the repository, so a push reaches it only because .github/workflows/deploy.yml
// calls the service's Deploy Hook — and when that call fails, or the secret it
// needs is missing, `git push` changes nothing that is live. That left a gap this
// file closes: after a deploy, or when a link misbehaves in a client's hands,
// there was no way to ask "is the running build the one I pushed?" without a
// browser and a signing link.
//
// It asks with reads only — no credentials, no database rows, nothing written —
// and it checks the things that only a browser could see when they were wrong:
//   * the service answers at all (/health),
//   * the build it reports is the commit in this working copy (which is the
//     difference between a deploy having happened and a push having done
//     nothing),
//   * the signing page carries no inline <script> (the CSP refuses those, so the
//     client would stare at "Loading your secure signing session…" for ever),
//   * the script it points at is served, is valid JavaScript, and measures the
//     signature pad again once the form is on screen (a hidden canvas measures
//     0 x 0 and a zero-sized element takes no touch at all),
//   * a POST carrying the signing page's own origin is not refused — the
//     browser always sends it, and the client's upload and complete requests
//     were answered 403 "CORS origin denied" while it was missing from the list.
//
// Usage:
//   node tools/check_deployed.js                      # PUBLIC_BASE_URL / RENDER_EXTERNAL_URL / localhost:3000
//   node tools/check_deployed.js https://host.example # say which service to ask
// Exit code is 0 only when every check passes, so it can gate a deploy.
import { execSync } from 'child_process';

const BASE = (process.argv[2] || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL
  || 'http://localhost:3000').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// Which commit is this working copy on? A copy without git (a downloaded zip, a
// container without it) cannot answer, and a check that cannot be asked is
// skipped rather than failed — the verdict is about the service, not about
// whether this machine has git installed.
let localSha = null;
try {
  localSha = execSync('git rev-parse HEAD', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim() || null;
} catch (e) { localSha = null; }

(async () => {
  console.log('Asking ' + BASE + ' what it is running\n');

  // 1. It is there at all.
  let health = null;
  try {
    const res = await fetch(BASE + '/health');
    health = { status: res.status, body: await res.json() };
  } catch (e) { health = { status: 0, error: e.message }; }
  check('the service answers /health',
    health.status === 200 && health.body && health.body.ok === true,
    health.status + ' ' + (health.error || JSON.stringify(health.body)));

  // 3. The build it reports is the commit in this working copy. This is the check
  // that says whether a push reached the service at all: a service deployed before
  // this field existed reports no build at all, and one deployed from another
  // commit reports that other commit. Two situations cannot be asked and are
  // skipped rather than failed — no git here to name a commit, and a service that
  // was never built by Render (it reports 'local'), which is what a laptop running
  // `npm start` answers.
  const build = health.body ? health.body.build : null;
  if (!localSha) {
    console.log('  --   the running build is this commit (skipped: no git here to name the commit)');
  } else if (build === 'local') {
    console.log('  --   the running build is this commit (skipped: ' + BASE + ' was not built by Render,'
      + ' so there is no deployed build to compare with)');
  } else {
    check('the running build is this commit (' + localSha.slice(0, 7) + ')',
      build === localSha,
      build ? 'the service reports ' + String(build).slice(0, 7)
        : 'nothing in /health: the running build predates this field, so it was deployed before this check existed');
  }

  // 4. The signing page is the external-script one.
  const pageRes = await fetch(BASE + '/sign/check-deployed');
  const page = await pageRes.text();
  const inlineTags = (page.match(/<script\b[^>]*>/gi) || []).filter((t) => !/\bsrc=/i.test(t));
  const srcMatch = page.match(/<script\b[^>]*\bsrc="([^"]+)"/i);
  check('the signing page is served', pageRes.status === 200 && /Khusela Secure Digital Signature/.test(page),
    'HTTP ' + pageRes.status);
  check('it carries no inline <script> (helmet\'s script-src is \'self\', so those never run)',
    inlineTags.length === 0, inlineTags.join(' ') || 'none');
  check('it loads its script by an absolute path', !!srcMatch && srcMatch[1].startsWith('/'),
    srcMatch ? srcMatch[1] : 'no src attribute');

  // 5. That script, as this service serves it.
  let script = '', scriptStatus = 0;
  if (srcMatch) {
    const res = await fetch(BASE + srcMatch[1]);
    scriptStatus = res.status;
    script = await res.text();
  }
  check('the script it points at is served', scriptStatus === 200, 'HTTP ' + scriptStatus);
  let parseError = null;
  try { new Function(script); } catch (e) { parseError = e.message; }
  check('that script is valid JavaScript the browser will parse (V8)',
    script.length > 0 && !parseError, parseError || (script ? 'parses' : 'nothing was served to parse'));
  check('the pad is measured again once the form is on screen',
    /hidden\s*=\s*false\s*;\s*size\(\)/.test(script), oneLine(script) || 'no script to read');

  // 6. The origin rule the client's own page depends on.
  let own = { status: 0, body: '' };
  try {
    const res = await fetch(BASE + '/api/sign/check-deployed/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}',
    });
    own = { status: res.status, body: await res.text() };
  } catch (e) { own = { status: 0, body: e.message }; }
  check('a POST from the signing page\'s own origin (' + ORIGIN + ') is not refused',
    own.status !== 403, 'HTTP ' + own.status + ' ' + oneLine(own.body));

  // 7. Minting a link is the one action with no token attached, because the app
  //    calls it from a browser, so a caller that presents neither the app's Origin
  //    nor a key has to be refused. Asked of a deployed address only: on this
  //    machine the endpoint is open to local callers by design (the suites use it),
  //    and a 200 there is correct — it would fail this check for the wrong reason.
  //    A refused request writes nothing, so this still reads only.
  const localBase = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(BASE);
  if (localBase) {
    console.log('  --   a headerless invite request is refused (skipped: ' + BASE
      + ' is local, where local callers are allowed on purpose)');
  } else {
    let invite = { status: 0, body: '' };
    try {
      const res = await fetch(BASE + '/api/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName: 'deploy-check', idNumber: '9001015800083' }),
      });
      invite = { status: res.status, body: await res.text() };
    } catch (e) { invite = { status: 0, body: e.message }; }
    check('a headerless invite request from elsewhere is refused instead of minting a link',
      invite.status === 401, 'HTTP ' + invite.status + ' ' + oneLine(invite.body));
    console.log('  --   /health: the invite endpoint is '
      + (health.body && health.body.inviteProtected === true
        ? 'protected by INVITE_API_KEY'
        : 'unprotected — INVITE_API_KEY is not set, so the Origin rule and the rate limit are what stand'));
  }

  console.log('');
  if (fail) {
    console.log(fail + ' of ' + (pass + fail) + ' checks failed: this service is NOT running the code in this repository (or is misconfigured).');
    console.log('Deploy it — push to main, which makes the deploy workflow call the Deploy Hook, or press');
    console.log('"Deploy latest commit" on the service in the Render dashboard — then run this again.');
  } else {
    console.log('All ' + pass + ' checks passed: the deployed service matches this repository.');
  }
  // process.exit() here races undici's own teardown on Windows and can kill the
  // run with an assertion (exit code 0xC0000409) *after* the verdict is printed,
  // which would break the exit code this is meant to gate a deploy with. Setting
  // the code and letting Node wind down is quieter and always reports the truth.
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('could not check ' + BASE + ': ' + e.message); process.exitCode = 1; });
