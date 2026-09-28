# Khusela Digital Signature Backend

Production-oriented Node.js/Express backend for the Khusela application.

## What it provides
- `POST /api/invite` — creates a random, expiring, one-time signing link. Returns the link plus a **manage token** (see below). Accepts `signerLabel` (e.g. `Applicant 1`) and `applicationRef` so one application can have several signatories.
- `GET /api/sign/:token` — validates the secure link and returns only the client-facing data needed by the signing page.
- `POST /api/sign/:token/upload` — accepts ID, payslip and bank-statement files (PDF/JPG/PNG).
- `POST /api/sign/:token/complete` — stores the drawn signature, timestamp, IP and user-agent and permanently consumes the link.
- `GET /api/manage/:manageToken` — the consultant-side status of a signing request (`pending` / `signed` / `expired`), plus the signature URL when signed.
- `GET /api/manage/:manageToken/signature` — the captured signature as a PNG.
- Admin endpoints protected by `x-admin-key` for invitation/document/signature/audit status.
- SQLite with WAL mode for a simple persistent deployment.

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
3. `PUBLIC_BASE_URL` must be the public HTTPS address of **this** server — it is
   what the generated signing link is built from. On Render this is picked up
   automatically from `RENDER_EXTERNAL_URL`, so leave it empty there.
4. Leave `REQUIRE_DOCUMENTS=false` for signature-only requests, which is what the
   "Send Signing Link" button asks for. Set it to `true` to require the ID,
   payslip and bank statements before a signature is accepted.

The consultant presses **Send Signing Link** next to Applicant 1 or 2, sends the
copied link to that applicant (WhatsApp, SMS, e-mail), and the captured
signature appears in that applicant's box and in the PDF the PWA e-mails.

## Tests
```bash
npm test
```
- `tools/test_signature_flow.js` — end-to-end: create a request, load the signing
  page data, poll the status, sign **without** documents, fetch the signature
  image, confirm the link is burned and that two applicants stay independent.
- `tools/test_migration.js` — starts the server against a database written by the
  previous version and checks the new columns are added without touching
  existing invitations.

Both run on a scratch database in `storage/` and clean up after themselves.

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
2. **The host must give you a real one.** Pick a host with a persistent public URL
   and a writable disk — the signatures, uploads and `khusela.db` are all files
   on disk. Render / Railway / Fly.io / a small VPS all work. Serverless
   platforms (Vercel, Netlify functions) do **not**: their filesystem is
   read-only and ephemeral, so signatures would vanish on the next deploy. The PWA
   itself is fine on Vercel — it is only this backend that needs a disk.

## Deploying to Render
`render.yaml` in this folder describes the whole service, so the Dashboard only
has to be pointed at the repository.

1. Push this folder to a GitHub repository — Render deploys from Git, and this
   folder is not a repository until you create one.
2. In Render choose **New → Blueprint** and pick that repository. Render then
   creates the service, mounts a 1 GB disk at `/var/data`, sets
   `STORAGE_DIR=/var/data`, allows the PWA's origin and generates `ADMIN_API_KEY`.
3. When the deploy finishes, open the service URL — `/health` should answer
   `{"ok":true,...}`.
4. Copy that URL into `khusela-itc-pwa/js/config.js` as `signatureApiBase`
   (see the PWA section above), commit it, and let Vercel redeploy.

**The disk is not optional.** A Render service without one has an ephemeral
filesystem that Render wipes on every deploy and restart. That deletes
`khusela.db` — and with it every pending signing link. Disks are only available on
a paid instance, which is why `render.yaml` asks for the `starter` plan; the free
instance cannot safely hold this data. A disk has two further consequences worth
knowing: deploys stop the old instance before starting the new one (a few seconds
of downtime), and the service runs as a single instance.

`STORAGE_DIR` is what ties the disk to the data. The database, `uploads/` and
`signatures/` all live under it, so setting it to the disk's mount path in one
place keeps every file that matters off the ephemeral filesystem. Anywhere outside
that path is wiped on deploy.

Prefer clicking to using the blueprint? Create a **Web Service** instead, with
Build Command `npm ci`, Start Command `npm start` and health check path `/health`,
add the variables from `render.yaml` by hand, and attach a disk with mount path
`/var/data`.

**Testing from a real phone before you deploy:** run the server locally and expose
it with a tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http
3000`). Set `PUBLIC_BASE_URL` to the tunnel's `https://…` address and add the
tunnel origin to `ALLOWED_ORIGINS` for the duration of the test.

## Production requirements
1. Use HTTPS.
2. Put the Node server behind Nginx/Cloudflare or another TLS reverse proxy.
3. Use a strong random `ADMIN_API_KEY` and keep `.env` out of source control.
4. Back up everything under `STORAGE_DIR` — `khusela.db`, `uploads/` and
   `signatures/` (locally that is `storage/`, on Render `/var/data`) — securely.
5. For multi-server/high-volume deployment, replace SQLite with PostgreSQL and object storage.
6. Configure `ALLOWED_ORIGINS` to the exact Khusela application domain.

## Important security design
The raw signing token is never stored in the database; only SHA-256(token) is stored. The token expires, can only be used once, and signing records include timestamp, IP and user-agent. The backend does not expose uploaded documents through a public static route. The **manage token** (status + signature retrieval) is a separate secret that is never sent to the client, so a client's signing link cannot read a signature back.
