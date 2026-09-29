# Khusela Digital Signature Backend

Production-oriented Node.js/Express backend for the Khusela application.

## What it provides
- `POST /api/invite` — creates a random, expiring, one-time signing link. Returns the link plus a **manage token** (see below). Accepts `signerLabel` (e.g. `Applicant 1`) and `applicationRef` so one application can have several signatories.
- `GET /sign/:token` — the signing page the client opens, i.e. the link `POST /api/invite` returns. One static file serves every token (it reads the token out of its own path); an unknown, expired or already-used link is reported by the page itself. This page is the only thing the client ever sees — there is nothing to log into. The page's code is the separate same-origin file `public/sign.js`: helmet's default Content-Security-Policy here is `script-src 'self'`, so an inline `<script>` is refused by the browser and the client would sit on "Loading your secure signing session…" for ever. That script measures the signature pad twice for a second reason: the form holding the canvas starts `hidden`, so the measurement taken while the script loads is 0 x 0, and a zero-sized element receives no touch or click at all — the client would have nothing to sign on.
- `GET /api/sign/:token` — validates the secure link and returns only the client-facing data needed by the signing page.
- `POST /api/sign/:token/upload` — accepts ID, payslip and bank-statement files (PDF/JPG/PNG).
- `POST /api/sign/:token/complete` — stores the drawn signature, timestamp, IP and user-agent and permanently consumes the link.
- `GET /api/manage/:manageToken` — the consultant-side status of a signing request (`pending` / `signed` / `expired`), plus the signature URL when signed.
- `GET /api/manage/:manageToken/signature` — the captured signature as a PNG.
- Admin endpoints protected by `x-admin-key` for invitation/document/signature/audit status.
- SQLite through the libSQL/Turso client, with **everything** in the database: the
  invitations, the audit log, the uploaded documents and the signature images
  themselves, the last two as BLOB columns. Nothing is written to the host's disk,
  so an ephemeral filesystem (Render's free instance) cannot lose a signature.
- One environment variable chooses where that database lives: `TURSO_DATABASE_URL`
  unset keeps a local file at `storage/khusela.db` (tests and local development
  need no account), set points the server at a free hosted Turso database.

## Two tokens per signing request
`POST /api/invite` returns two different capabilities on purpose:

| Token | Who holds it | What it can do |
| --- | --- | --- |
| `signingLink` (contains the **signing token**) | the client | open the signing page, upload documents, sign **once** |
| `manageToken` | the application that created the request | poll the status, download the signature |

The manage token is never placed in the signing link, so a leaked client link
cannot be used to read the signature back. Only SHA-256 hashes of both tokens
are stored.

## Install
```bash
npm install
cp .env.example .env
# edit .env
npm start
```

## Connect the existing Khusela HTML
Set the API base before loading the application:
```html
<script>window.KHUSELA_API_BASE='https://api.your-domain.co.za';</script>
```
The existing Generate Signing Link button already calls `/api/invite` and uses the returned `signingLink`.

## Connect the Khusela ITC application (PWA)
`khusela-itc-pwa` drives this backend from its **Signature** section:

1. Set the API base in `khusela-itc-pwa/js/config.js`:
   ```js
   window.ITC_CONFIG = { /* … */ signatureApiBase: 'https://api.your-domain.co.za' };
   ```
   While it is empty the section stays a plain pair of boxes and nothing is sent.
2. Add the PWA's exact address to `ALLOWED_ORIGINS` here, or the browser will
   block the requests:
   ```
   ALLOWED_ORIGINS=https://itc-extractor.vercel.app,https://your-domain.co.za
   ```
   The PWA is the only origin you list. The signing page is served by this server
   itself, so the browser stamps the client's upload and complete requests with
   this server's own origin; that origin is allowed automatically, which is why a
   custom domain needs no second entry. (Listing the PWA and nothing else once
   left the client's two writes refused with a `403 CORS origin denied` — the page
   could load a session and then never submit, and no request without an `Origin`
   header, such as curl, could show it.)
3. `PUBLIC_BASE_URL` must be the public HTTPS address of **this** server — it is
   what the generated signing link is built from. On Render this is picked up
   automatically from `RENDER_EXTERNAL_URL`, so leave it empty there.
4. Leave `REQUIRE_DOCUMENTS=false` for signature-only requests, which is what the
   "Send Signing Link" button asks for. Set it to `true` to require the ID,
   payslip and bank statements before a signature is accepted.

The consultant presses **Send Signing Link** next to Applicant 1 or 2, sends the
copied link to that applicant (WhatsApp, SMS, e-mail), and the captured
signature appears in that applicant's box and in the PDF the PWA e-mails.

Once the signature is recorded the client's page says so, tells them the browser
window can be closed, wipes the signature pad and switches both buttons off. A
client who leaves the tab open therefore cannot sign a second time that would
never be sent, nor mistake a signed pad for a form that still has to go.

## Tests
```bash
npm test
```
- `tools/test_signature_flow.js` — end-to-end: create a request, fetch the link the
  client receives (it has to serve the signing page itself, not a 404), and check that
  page can actually **run** in a browser — no inline `<script>` for the CSP to refuse,
  its script loaded by an absolute path and parsed the way V8 parses it, since the page
  once rendered and did nothing at all. Then load the signing page data, poll the
  status, sign **without** documents, fetch the signature image
  (byte-for-byte), confirm the link is burned, that two applicants stay independent,
  that an upload is recorded (while a file of the wrong type is refused as a 400 and
  an oversized one as a 413, rather than either looking like a fault on this side),
  and that **not one file reached the host's disk**. It also covers who may mint a
  link — a headerless caller from elsewhere is refused while the app's own `Origin`
  is accepted, and the ninth request from one address is answered 429 — what the
  audit records as the client's address (and that a caller cannot forge it by
  writing `X-Forwarded-For` itself), and the key path on a second instance started
  with `INVITE_API_KEY` set.
- `tools/test_restart.js` — starts the server, captures a signature, kills the process
  the way a deploy does, then starts a second process against the same database and
  checks the signature is still there byte-for-byte, that the used signing link is
  still refused with a 410, and that the invitation is still readable. This is the
  property a sleeping free instance depends on.
- `tools/test_migration.js` — starts the server against a database written by the
  previous version and checks the new columns (`manage_token_hash`, `signer_label`,
  `application_ref`, `signature_data`, the `documents.content` table) are added
  without touching existing invitations.

All three run on a scratch database in `storage/` and clean up after themselves.

`npm test` never touches a deployment. To ask a **deployed** service whether it is
running this repository's code — reads only, no credentials, non-zero exit while it
is stale — run `npm run check:deployed -- <service URL>` (see the deploy section).

**Before deploying, run the same suites against the real database.** This is what
turns "the settings look right" into evidence, because it uses the connection Render
will use:

```bash
E2E_DB_URL=libsql://khusela-<you>.turso.io TURSO_AUTH_TOKEN=<token> node tools/test_signature_flow.js
E2E_DB_URL=libsql://khusela-<you>.turso.io TURSO_AUTH_TOKEN=<token> node tools/test_restart.js
```

On Windows, set those two in PowerShell first: `$env:E2E_DB_URL='libsql://…'` and
`$env:TURSO_AUTH_TOKEN='…'`. A local server that speaks the same protocol works too
(`E2E_DB_URL=http://127.0.0.1:8080`, e.g. `sqld` from the Turso CLI), which is how
the remote path was first exercised without an account.

## Where PUBLIC_BASE_URL comes from
A signing link is built from one address: the public HTTPS one your host gives
this server, e.g. `https://khusela-signature-backend.onrender.com`. It cannot be
guessed from the code, so it is configuration rather than something the server
computes — that is why `.env` ships it empty.

On Render you can leave it empty permanently. Render publishes the service's own
address as `RENDER_EXTERNAL_URL`, and the server uses that whenever
`PUBLIC_BASE_URL` is empty, so signing links are correct from the very first boot.
Set `PUBLIC_BASE_URL` only when you attach a custom domain. On any other host, set
it yourself to that host's address.

Two things follow from that:

1. **It must be reachable from the internet**, because the applicant opens
   `PUBLIC_BASE_URL/sign/<token>` on their own phone. `http://localhost:3000`
   only works when the person signing is at this machine, so the server prints a
   startup warning if the address it resolved points at localhost.
2. **The database must be reachable from it.** Nothing is stored on the host any
   more, so any host will do — Render / Railway / Fly.io / a small VPS, and the free
   instance of each, because an ephemeral filesystem can no longer take a signature
   with it. Point `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` at your Turso
   database and the server keeps every byte there. The one platform to avoid for
   uploads is serverless functions (Vercel, Netlify): their request-body limit is a
   few megabytes, so a large bank statement is refused before this code runs. The
   PWA itself is fine on Vercel.

## Deploying: a free Turso database + a free Render instance
Two free sign-ups, no card, no disk to buy. The database lives at **Turso** (hosted
SQLite, 5 GB free) and the server runs on **Render** (free web instance).
`render.yaml` in this folder describes the whole service, so the Dashboard only has
to be pointed at the repository.

1. **Create the database.** Install the Turso CLI. There is **no npm package** for
   it — `npm i -g @tursodatabase/cli` returns a 404 — and it runs on Linux and
   macOS only, so on Windows it belongs inside WSL:

   ```bash
   brew install tursodatabase/tap/turso      # macOS
   curl -sSfL https://get.tur.so/install.sh | bash   # Linux, and inside `wsl` on Windows
   ```

   On WSL or in CI, add `--headless` so it prints a URL to open instead of
   expecting a browser in Linux: `turso auth login --headless`. Then run
   `turso db create khusela`. The Turso dashboard is an alternative that needs no
   install at all: it creates the database and a token for it by clicking. The two
   values are the only secrets the server needs:
   ```bash
   turso db show khusela --url      # libsql://khusela-<you>.turso.io
   turso db tokens create khusela   # the auth token
   ```
2. Push this folder to a GitHub repository — Render deploys from Git, and this
   folder is not a repository until you create one.
3. In Render choose **New → Blueprint** and pick that repository. Render prompts for
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (marked `sync: false`, so they never
   enter the repository), allows the PWA's origin and generates `ADMIN_API_KEY`.
4. When the deploy finishes, open the service URL — `/health` should answer
   `{"ok":true,...}`.
5. Copy that URL into `khusela-itc-pwa/js/config.js` as `signatureApiBase`
   (see the PWA section above), commit it, and let Vercel redeploy.

**Deploying a change later.** Render only rebuilds when it is told to, and there are
two ways to tell it. Both are wired up in `.github/workflows/deploy.yml`, which uses
whichever is configured and says so when neither is:

- **Render's API — the one to use.** Create a key at Render → **Account Settings →
  API Keys**, add it to this repository as the `RENDER_API_KEY` secret together with
  `RENDER_SERVICE_ID` (the service's `srv-...` ID, which is in its dashboard URL),
  and every push to `main` triggers a deploy. The key can be revoked and replaced on
  that same Account Settings page, which is the point of preferring it, and the
  request names the exact commit (`commitId`), so what is built is the commit the
  workflow ran on rather than whatever the branch tip has become by the time Render
  looks.
- **The service's Deploy Hook** (Settings → Deploy Hook, kept here as the
  `RENDER_DEPLOY_HOOK` secret). Still supported, because it needs no API key, but
  Render's documentation describes replacing a compromised hook with **Regenerate
  Hook** in that same section — if your dashboard does not show that control, prefer
  the API key instead of losing the ability to rotate a credential. Worth knowing
  before treating a leaked hook as an emergency: the hook deploys the latest commit
  on the connected branch, and it can only deploy commits that are already in this
  repository, so it is a trigger rather than a way in. The worst it allows is an
  unnecessary rebuild.

Adding `RENDER_API_KEY` while the hook secret is still set is the safe migration —
the API path is used as soon as it exists, so the hook can be deleted afterwards. And
check the service's Settings first: if **Auto-Deploy** reads *On Commit*, Render is
watching the repository and deploys by itself, which makes both credentials
unnecessary and a leaked hook harmless.

To tell whether the running build is the one you pushed:

```bash
npm run check:deployed -- https://khusela-signature-backend.onrender.com
```

It reads only, needs no credentials, and exits non-zero while the service is stale.
The last check is the commit itself: `/health` reports the commit Render built the
instance from, and the check compares that with `git rev-parse HEAD` here, so "is the
thing you pushed the thing that is live?" has a yes or no answer.

**Why no disk is needed.** Every byte that matters — the invitations, the uploaded
documents and the signature images — is a row in the Turso database, so Render's
ephemeral filesystem has nothing to lose. The free instance sleeps after about 15
minutes idle and takes up to a minute to wake, so the first page load after a quiet
spell is slow; that delay is the whole cost of the free plan, and the data is
untouched while it sleeps.

`STORAGE_DIR` and `khusela.db` are still supported for local development and tests,
where no account and no network are wanted. A deployment simply sets
`TURSO_DATABASE_URL`, and then the server writes nothing to disk at all.

Prefer clicking to using the blueprint? Create a **Web Service** instead, with
Build Command `npm ci`, Start Command `npm start`, health check path `/health` and
plan **Free**, then add `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
`ALLOWED_ORIGINS`, `REQUIRE_DOCUMENTS` and `ADMIN_API_KEY` by hand. Do not attach a
disk: there is nothing to put on one.

**Testing from a real phone before you deploy:** run the server locally and expose
it with a tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http
3000`). Set `PUBLIC_BASE_URL` to the tunnel's `https://…` address and add the
tunnel origin to `ALLOWED_ORIGINS` for the duration of the test.

**If the first deploy fails**, the log says why before the service ever listens. A
`TURSO_DATABASE_URL` for the wrong database, or a token that was revoked or belongs
to another database, stops the process with:

```
Could not prepare the database at libsql://…
Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: the URL must be the libsql:// one
for this database, and the token must be one created for it.
LibsqlError: SERVER_ERROR: Server returned HTTP status 404
```

That is deliberate. A server that cannot reach its database must not answer requests
as though it had recorded a signature, and it must never quietly fall back to a local
file instead: on a host that wipes its disk, anything written there would be lost
without an error ever being shown. So the process exits, Render marks the deploy
failed, and the log names the setting to check.


## Production requirements
1. Use HTTPS.
2. Put the Node server behind Nginx/Cloudflare or another TLS reverse proxy. A host
   that says it is Render — a Render service publishes `RENDER_SERVICE_ID` and
   `RENDER_EXTERNAL_URL` — trusts three appends to `X-Forwarded-For` by itself,
   because that is what a real signing request showed (arriving as
   `165.0.11.224, 172.68.247.29, 10.24.207.248`: the client, Render's edge, Render's
   internal hop). Everywhere else the default is one, and `TRUST_PROXY_HOPS` overrides
   either. Both ways of being wrong matter: too few and the address stored with a
   signature is an address inside the host, which is what `::1` was; too many and a
   caller could name itself. The live harness signs and then compares the stored
   address with the address the machine really is, so a wrong number fails loudly
   instead of quietly recording something meaningless.
3. Use a strong random `ADMIN_API_KEY` and keep `.env` out of source control.
4. Back up the database. At Turso that is `turso db dump khusela > backup.sql`;
   locally it is just `storage/khusela.db`. Documents and signature images are
   inside it, so one file covers everything.
5. For multi-server/high-volume deployment, put SQLite behind a paid Turso plan (or
   move to PostgreSQL) and keep the images in object storage.
6. Configure `ALLOWED_ORIGINS` to the exact Khusela application domain.
7. `POST /api/invite` is the one route with no token to check, because the
   consultant's app calls it straight from a browser. Until that request carries a
   secret it accepts callers that present an allowed `Origin` header (the app) or
   that come from the server itself, and it issues at most 20 new links per address
   per 10 minutes. The limit is real; the `Origin` rule is only a floor, since a
   script may send any header it likes. To close it properly, send
   `x-invite-key: <key>` from the app's invite request and set `INVITE_API_KEY` to
   the same value — callers without it are then refused with a 401. `GET /health`
   reports which state the service is in as `inviteProtected`.
8. Treat `INVITE_RATE_LIMIT` as a floor, not a guarantee: those counters live in the
   process, so a redeploy forgets them and two instances keep two sets.

## Important security design
The raw signing token is never stored in the database; only SHA-256(token) is stored. The token expires, can only be used once, and signing records include timestamp, IP and user-agent. The backend does not expose uploaded documents through a public static route. The **manage token** (status + signature retrieval) is a separate secret that is never sent to the client, so a client's signing link cannot read a signature back.

The IP recorded with a signature is the client's own rather than the host's proxy:
`TRUST_PROXY_HOPS` makes `req.ip` the address the reverse proxy appended to
`X-Forwarded-For`, and the raw chain is kept with the audit entry (`meta.xff`) so the
value can be checked rather than taken on trust. Minting a link (`POST /api/invite`)
is the one action with no token attached, because the app calls it from a browser, so
it is limited per address and restricted to callers that look like that app or come
from the server itself until `INVITE_API_KEY` is set and sent.
