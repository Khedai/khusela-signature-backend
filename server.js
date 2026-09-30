import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { DB_URL, USING_REMOTE_DB, all, get, run, write, ddl, isUniqueViolation } from './db.js';
import { mailConfigured, sendApplication, MAX_EMAIL_BYTES } from './mailer.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3000);
// Render (and similar hosts) publish the service's own public URL, so signing
// links come out correct without anyone copying an address by hand.
const BASE=(process.env.PUBLIC_BASE_URL||process.env.RENDER_EXTERNAL_URL||`http://localhost:${PORT}`).replace(/\/$/,'');
// Signing links are built from BASE, so they only open if the client's own phone
// can reach it. Falling back to localhost is right while testing and silently
// fatal once deployed, so say so instead of handing out links nobody can open.
if(/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(BASE)){
 console.warn(`WARNING: no public URL is configured. Signing links will point at ${BASE} and will only open on this machine.`);
}
// Every request reaches this process through the host's own proxy, so the socket
// peer is that proxy and not the client. On Render that made every signature row
// record "::1" as the IP: a value that identifies nobody and leaves the audit trail
// unable to say where a signature came from. Trusting the right number of hops makes
// req.ip the address the proxy appended to X-Forwarded-For, and a caller cannot
// forge it by sending its own X-Forwarded-For, because a forged entry sits further
// left in the chain than the one the proxy appended.
//
// The number is measured, not assumed. On 2026-09-29 a real signing request reached
// Render carrying 165.0.11.224, 172.68.247.29, 10.24.207.248 — the client, Render's
// edge, Render's internal hop — so Render appends three entries and trusting one
// landed on an address inside Render. Render publishes RENDER_SERVICE_ID and
// RENDER_EXTERNAL_URL on a service, so a Render host gets three without anyone
// having to configure it, and TRUST_PROXY_HOPS overrides that where a chain differs
// (a service with its own proxy in front, an Nginx hop, or a host that is not
// Render at all, where one is a guess in the safe direction: under-trusting costs a
// less useful address, over-trusting lets a caller name itself in the record).
const ON_RENDER=!!(process.env.RENDER||process.env.RENDER_SERVICE_ID||process.env.RENDER_EXTERNAL_URL);
const TRUST_PROXY_HOPS=Math.max(0,Number(process.env.TRUST_PROXY_HOPS??(ON_RENDER?3:1)));
// POST /api/invite is the one route with no token to check — the consultant's app
// calls it straight from the browser to mint a signing link. INVITE_API_KEY, when
// set, is a real secret and the caller must send it as x-invite-key (or as a bearer
// token). The app has to be updated to send it before this can be switched on, so
// while it is unset the route falls back to accepting only callers that look like
// that app or come from this machine, and startup says so rather than leaving the
// state to be discovered.
const INVITE_KEY=process.env.INVITE_API_KEY||'';
if(!INVITE_KEY) console.warn('WARNING: POST /api/invite has no INVITE_API_KEY set. It accepts callers that present a trusted Origin header or come from this machine; an Origin header can be forged, so set INVITE_API_KEY (and send it from the app) to require a secret.');
// The database is either a managed Turso database or, in development, a local
// file — db.js decides which from the environment. Nothing the server stores is
// written to the local filesystem, so a host with a disposable disk (Render's
// free instances wipe theirs on every deploy) cannot lose a signature or a
// pending signing link.
console.log(`Database: ${USING_REMOTE_DB?'Turso (remote)':'local SQLite file'} (${DB_URL})`);

// Turso speaks SQLite, so this is the same schema as before: the change is that
// the images are columns now instead of files.
// stored_name and signature_file are NOT NULL columns that exist in databases
// created by the previous version. They are never read, but they are still
// written (empty) so that one INSERT works against an old and a new database.
const SCHEMA=[
`CREATE TABLE IF NOT EXISTS invitations(
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
 id_number TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, application_type TEXT,
 debit_amount TEXT, debit_date TEXT, consultant TEXT, branch TEXT,
 manage_token_hash TEXT, signer_label TEXT, application_ref TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, status TEXT NOT NULL DEFAULT 'pending'
)`,
`CREATE TABLE IF NOT EXISTS documents(
 id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL, kind TEXT NOT NULL, original_name TEXT NOT NULL,
 stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
 content BLOB, FOREIGN KEY(invitation_id) REFERENCES invitations(id)
)`,
`CREATE TABLE IF NOT EXISTS signatures(
 id TEXT PRIMARY KEY, invitation_id TEXT UNIQUE NOT NULL, signature_file TEXT NOT NULL,
 signature_data BLOB, signed_at TEXT NOT NULL, ip TEXT, user_agent TEXT,
 FOREIGN KEY(invitation_id) REFERENCES invitations(id)
)`,
`CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT, invitation_id TEXT, event TEXT NOT NULL,
 created_at TEXT NOT NULL, ip TEXT, user_agent TEXT, meta TEXT
)`,
];
// Lightweight migrations: CREATE TABLE IF NOT EXISTS never adds a column to a
// database that already exists, so additive columns are applied here.
async function ensureColumn(table,column,definition){
 const cols=(await all(`PRAGMA table_info(${table})`)).map(c=>c.name);
 if(!cols.includes(column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Creating the schema and applying those migrations is the first thing to touch
// the database, so a wrong TURSO_DATABASE_URL or TURSO_AUTH_TOKEN fails here rather
// than on the first client's request. A failure stops the process: a host with a
// disposable disk must never look as if it stored something it did not, and a
// server that cannot record a signature must not answer as though it had.
async function prepareDatabase(){
 await ddl(SCHEMA);
 await ensureColumn('invitations','manage_token_hash','TEXT');
 await ensureColumn('invitations','signer_label','TEXT');
 await ensureColumn('invitations','application_ref','TEXT');
 // The captured images used to live in files whose names were recorded in these
 // tables; the bytes themselves are stored in the database now.
 await ensureColumn('signatures','signature_data','BLOB');
 await ensureColumn('documents','content','BLOB');
 // The manage token is the consultant-side capability: it is only ever returned
 // to the app that created the request, never sent to the client.
 await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_manage_token ON invitations(manage_token_hash)');
}

try{
 await prepareDatabase();
}catch(e){
 console.error(`\nCould not prepare the database at ${DB_URL}`);
 console.error(USING_REMOTE_DB
  ?'Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: the URL must be the libsql:// one for this database, and the token must be one created for it.'
  :'Check that the STORAGE_DIR folder exists and is writable.');
 console.error(e.name+': '+e.message);
 process.exit(1);
}

const app=express();
app.disable('x-powered-by');
// Behind the host's own proxy this is what makes req.ip the client's address rather
// than the proxy's; see TRUST_PROXY_HOPS above.
app.set('trust proxy',TRUST_PROXY_HOPS);
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
const origins=(process.env.ALLOWED_ORIGINS||'*').split(',').map(x=>x.trim());
// One predicate for "this origin is allowed to talk to this service", shared by the
// CORS rule below and by the invite gate further down so the two cannot drift apart.
const originAllowed=origin=>!origin||origins.includes('*')||origins.includes(origin)||origin===BASE;
// The signing page the client is sent is served by this same service, so the
// browser labels the client's upload and complete POSTs with this service's own
// origin — an origin ALLOWED_ORIGINS does not list, because that setting names
// the consultant's app. Those two requests were therefore refused with a 403
// "CORS origin denied": the client could read the session (a same-origin GET
// carries no Origin header at all) and then never submit a signature. No test
// without an Origin header — curl, the suites — could show it. Its own origin is
// trusted here instead, and because BASE is derived exactly as the signing links
// are, a custom domain keeps working without a second setting to remember.
app.use(cors({origin:(origin,cb)=>{
 if(originAllowed(origin)) return cb(null,true);
 // A refused origin is an authorization failure, not a malformed request. The
 // status is attached so the error handler below keeps it a 4xx.
 const denied=new Error('CORS origin denied'); denied.status=403; cb(denied);
}}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false,limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));

function now(){return new Date().toISOString();}
function id(){return crypto.randomUUID();}
function hashToken(t){return crypto.createHash('sha256').update(t).digest('hex');}
// Express 4 does not pass a rejected promise from an async handler on to the error
// middleware, so an async route that throws would leave the request hanging until
// the client gave up. Wrapping keeps such failures ordinary error responses.
function wrap(fn){return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
async function audit(inv,event,req,meta={}){await run('INSERT INTO audit_log(invitation_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?)',[inv,event,now(),req.ip,req.get('user-agent')||'',JSON.stringify(meta)]);}
function requireAdmin(req,res,next){
 const key=req.get('x-admin-key')||'';
 const expected=process.env.ADMIN_API_KEY||'';
 // Compare fixed-length SHA-256 digests: timingSafeEqual throws on unequal
 // lengths, so comparing the raw strings turned a missing or wrong-length key
 // into a confusing "Input buffers must have the same byte length" 400 instead
 // of a 401. Digests are always 32 bytes, so the comparison stays constant-time.
 const ok=!!expected&&crypto.timingSafeEqual(
  crypto.createHash('sha256').update(key).digest(),
  crypto.createHash('sha256').update(expected).digest());
 if(!ok) return res.status(401).json({error:'Unauthorized'});
 next();
}

// ── Who may mint a signing link ──────────────────────────────────────────────
// POST /api/invite writes a row and hands back a capability link, and it has no
// session or token to check, because the consultant's app calls it from a browser.
// Two things stand in for one. INVITE_API_KEY, when set, is a real secret (see the
// top of this file): the caller must present it and nothing else counts. With no key
// configured the caller must instead look like the app this was written for — an
// allowed Origin header, or a request from this machine (the suites and local
// tools). An Origin header is forgeable, so that is a floor and not a lock; what it
// removes is the "mint a link with one headerless curl" path. Which state this
// service is in is reported by /health as inviteProtected, so it is never a guess.
function presentedInviteKey(req){
 const header=req.get('x-invite-key');
 if(header) return header;
 const bearer=/^Bearer\s+(.+)$/i.exec(req.get('authorization')||'');
 return bearer?bearer[1]:'';
}
// Fixed-length digests, for the same reason requireAdmin compares them: a key of the
// wrong length has to read as "wrong key" rather than as a crash.
function sameSecret(a,b){return crypto.timingSafeEqual(
 crypto.createHash('sha256').update(String(a)).digest(),
 crypto.createHash('sha256').update(String(b)).digest());}
// A request from this machine is a developer or a test, never a client's phone.
function isLocalAddress(ip){return ip==='::1'||ip==='127.0.0.1'||/^::ffff:127\./.test(String(ip||''));}
function inviteAuthorized(req){
 if(INVITE_KEY) return sameSecret(presentedInviteKey(req),INVITE_KEY);
 const origin=req.get('origin');
 return (!!origin&&originAllowed(origin))||isLocalAddress(req.ip);
}
// Minting a link costs a database row, so it is also the cheapest thing here to abuse
// in bulk. A per-address window — 20 in 10 minutes by default — keeps one script from
// filling the database; INVITE_RATE_LIMIT=0 switches it off. The counters live in this
// process, so a redeploy forgets them: that is the honest limit of a limiter with no
// shared store behind it.
const INVITE_LIMIT=Math.max(0,Number(process.env.INVITE_RATE_LIMIT??20));
const INVITE_WINDOW_MS=Math.max(1000,Number(process.env.INVITE_RATE_WINDOW_MS||600000));
const inviteHits=new Map();
if(INVITE_LIMIT) setInterval(()=>{const t=Date.now();for(const[k,e] of inviteHits) if(t-e.start>=INVITE_WINDOW_MS) inviteHits.delete(k);},INVITE_WINDOW_MS).unref();
function inviteRateLimit(req,res,next){
 if(!INVITE_LIMIT) return next();
 const who=String(req.ip||'unknown'); const t=Date.now();
 let e=inviteHits.get(who);
 if(!e||t-e.start>=INVITE_WINDOW_MS){e={start:t,n:0};inviteHits.set(who,e);}
 e.n++;
 if(e.n<=INVITE_LIMIT) return next();
 const wait=Math.max(1,Math.ceil((e.start+INVITE_WINDOW_MS-t)/1000));
 res.setHeader('Retry-After',String(wait));
 res.status(429).json({error:`Too many signing links have been requested from this address. Please wait ${Math.ceil(wait/60)} minute(s) and try again.`});
}

// The commit this instance was built from, so "is the live service the one that was
// pushed?" is one request with no credentials: Render puts the commit in
// RENDER_GIT_COMMIT, and tools/check_deployed.js compares it with the local HEAD.
// Anything without that variable — a laptop running npm start — says 'local'.
app.get('/health',(req,res)=>res.json({ok:true,service:'khusela-digital-signature',build:process.env.RENDER_GIT_COMMIT||'local',inviteProtected:!!INVITE_KEY,emailConfigured:mailConfigured(),emailProtected:!!process.env.EMAIL_API_KEY,time:now()}));

// The client's link points at /sign/<token>, but the page behind it is one static
// file for every token: public/sign.html reads the token out of its own path.
// Without this route nothing matches that path and the client is shown Express's
// "Cannot GET /sign/…" instead of a form, which is the whole point of the link.
// The token is deliberately not checked here — an unknown, expired or already-used
// link is reported by the page itself out of the API call below.
app.get('/sign/:token',(req,res)=>res.sendFile(path.join(__dirname,'public','sign.html')));

// Matches the existing Khusela HTML's Generate Signing Link call.
app.post('/api/invite',inviteRateLimit,wrap(async(req,res)=>{
 if(!inviteAuthorized(req)) return res.status(401).json({error:'This endpoint issues Khusela signing links to the Khusela application only'});
 try{
  const b=req.body||{};
  if(!b.clientName||!b.idNumber) return res.status(400).json({error:'clientName and idNumber are required'});
  const token=crypto.randomBytes(32).toString('base64url');
  // Consultant-side capability: used to poll the status and fetch the signed
  // image. It never travels with the client's signing link.
  const manageToken=crypto.randomBytes(32).toString('base64url');
  const inviteId=id(); const created=Date.now();
  const days=Math.min(Math.max(Number(b.expiresInDays||process.env.TOKEN_EXPIRY_DAYS||7),1),30);
  const expires=new Date(created+days*86400000).toISOString();
  const signerLabel=String(b.signerLabel||'').slice(0,60);
  const applicationRef=String(b.applicationRef||'').slice(0,80);
  await run(`INSERT INTO invitations(id,token_hash,manage_token_hash,client_name,id_number,phone,email,address,application_type,debit_amount,debit_date,consultant,branch,signer_label,application_ref,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
   [inviteId,hashToken(token),hashToken(manageToken),String(b.clientName),String(b.idNumber),b.phone||'',b.email||'',b.address||'',b.applicationType||'',b.debitAmount||'',b.debitDate||'',b.consultant||'',b.branch||'',signerLabel,applicationRef,new Date(created).toISOString(),expires]);
  await audit(inviteId,'invite_created',req,{expires,signerLabel:signerLabel||null});
  const signingLink=`${BASE}/sign/${token}`;
  res.json({ok:true,invitationId:inviteId,signingLink,manageToken,signerLabel,expiresAt:expires});
 }catch(e){console.error(e);res.status(500).json({error:'Could not generate secure signing link'});}
}));

// ── Emailing the finished application ────────────────────────────────────────
// The PWA posts the PDF it has just rendered here and this service mails it to
// the office mailbox (MAIL_TO) through the mailbox in mailer.js. Why that exists
// instead of the app posting to a form-to-email service is in that file's
// header; the short version is that FormSubmit answered every submission with a
// 500, and an app that cannot see a real status cannot tell anyone.
//
// The gate is the same shape as /api/invite's — called from a browser, so there
// is no session to check — with one difference that matters: the RECIPIENT is
// never taken from the request. The caller supplies the PDF and the applicant's
// details; where the mail goes is this service's own setting, so a copied URL
// cannot be used to send mail to strangers. EMAIL_API_KEY, when set, is a real
// secret (x-email-key, or a bearer token) and nothing else counts; while it is
// unset a caller that looks like the app (an allowed Origin) or that comes from
// this machine is accepted. /health reports both states, as emailConfigured and
// emailProtected, so neither is a guess.
const EMAIL_KEY=process.env.EMAIL_API_KEY||'';
if(!mailConfigured()) console.warn('WARNING: no mailbox is configured (MAIL_TO, SMTP_USER, SMTP_PASS), so POST /api/email answers 503 and the app keeps using its own email service. Set them to send applications from this service.');
function presentedEmailKey(req){
 const header=req.get('x-email-key');
 if(header) return header;
 const bearer=/^Bearer\s+(.+)$/i.exec(req.get('authorization')||'');
 return bearer?bearer[1]:'';
}
function emailAuthorized(req){
 if(EMAIL_KEY) return sameSecret(presentedEmailKey(req),EMAIL_KEY);
 const origin=req.get('origin');
 return (!!origin&&originAllowed(origin))||isLocalAddress(req.ip);
}
// An application is a few MB and a real message to a real mailbox, so it is
// limited per address as well: 20 in 10 minutes by default, EMAIL_RATE_LIMIT=0
// switches it off. The counters live in this process, so a redeploy forgets them.
const EMAIL_LIMIT=Math.max(0,Number(process.env.EMAIL_RATE_LIMIT??20));
const EMAIL_WINDOW_MS=Math.max(1000,Number(process.env.EMAIL_RATE_WINDOW_MS||600000));
const emailHits=new Map();
if(EMAIL_LIMIT) setInterval(()=>{const t=Date.now();for(const[k,e] of emailHits) if(t-e.start>=EMAIL_WINDOW_MS) emailHits.delete(k);},EMAIL_WINDOW_MS).unref();
function emailRateLimit(req,res,next){
 if(!EMAIL_LIMIT) return next();
 const who=String(req.ip||'unknown'); const t=Date.now();
 let e=emailHits.get(who);
 if(!e||t-e.start>=EMAIL_WINDOW_MS){e={start:t,n:0};emailHits.set(who,e);}
 e.n++;
 if(e.n<=EMAIL_LIMIT) return next();
 const wait=Math.max(1,Math.ceil((e.start+EMAIL_WINDOW_MS-t)/1000));
 res.setHeader('Retry-After',String(wait));
 res.status(429).json({error:`Too many applications have been emailed from this address. Please wait ${Math.ceil(wait/60)} minute(s) and try again.`});
}
// The gate runs BEFORE multer, so a caller with no right to be here — or a
// service with no mailbox configured yet — is answered without this process
// buffering 20 MB of PDF it is never going to use.
function emailGate(req,res,next){
 if(!emailAuthorized(req)) return res.status(401).json({error:'This endpoint emails Khusela applications to the Khusela office only'});
 if(!mailConfigured()) return res.status(503).json({error:'email_not_configured',message:'This service has no mailbox configured yet, so the application was not emailed. Try again once the office mailbox has been set up on it.'});
 next();
}
// One PDF and nothing else: that is what this route exists to carry.
const emailUpload=multer({
 storage:multer.memoryStorage(),
 limits:{fileSize:MAX_EMAIL_BYTES,files:1},
 fileFilter:(req,file,cb)=>{
  if(file.mimetype==='application/pdf') return cb(null,true);
  const bad=new Error('The application has to be sent as a PDF'); bad.status=400; cb(bad);
 },
});

app.post('/api/email',emailRateLimit,emailGate,emailUpload.single('attachment'),wrap(async(req,res)=>{
 const file=req.file;
 if(!file) return res.status(400).json({error:'The application PDF is missing from the request'});
 const b=req.body||{};
 try{
  const out=await sendApplication({
   filename:file.originalname,
   pdf:file.buffer,
   applicant:b.applicant,
   idNumber:b.idNumber,
   date:b.date,
   replyTo:b.replyTo,
  });
  // One line per application that went out, so the log answers "did it arrive?"
  // without a mailbox. The applicant's own address is deliberately not in it —
  // the message headers carry that and this log is not the place for it.
  console.log(`Application emailed (${(file.size/1048576).toFixed(1)} MB, message ${out.messageId||'?'}, accepted by ${out.accepted.join(', ')||'nobody'})`);
  res.json({ok:true,messageId:out.messageId,accepted:out.accepted.length>0});
 }catch(e){
  // The mailbox refused the message or could not be reached. That is neither the
  // caller's mistake nor a fault in this process, so it is a 502 carrying the
  // reason: a consultant needs to know the application did not go, and that
  // retrying is worth it. A wrong password shows up here, which is the whole
  // point of testing it before the office depends on it.
  console.error('email send failed: '+(e&&e.message?e.message:e));
  res.status(502).json({error:'The application could not be emailed: '+((e&&e.message)||'the mail server refused it')});
 }
}));

async function getInvite(token){
 const inv=await get('SELECT * FROM invitations WHERE token_hash=?',[hashToken(token)]);
 if(!inv) return null;
 if(inv.used_at || inv.status==='signed') return {...inv,invalidReason:'already_signed'};
 if(Date.now()>Date.parse(inv.expires_at)) return {...inv,invalidReason:'expired'};
 return inv;
}

app.get('/api/sign/:token',wrap(async(req,res)=>{
 const inv=await getInvite(req.params.token);
 if(!inv) return res.status(404).json({error:'Signing link not found'});
 if(inv.invalidReason==='expired') return res.status(410).json({error:'This signing link has expired'});
 if(inv.invalidReason==='already_signed') return res.status(410).json({error:'This signing link has already been used'});
 res.json({
  ok:true, clientName:inv.client_name, signerLabel:inv.signer_label||'',
  expiresAt:inv.expires_at, applicationType:inv.application_type,
  // The signing page only asks for documents when this backend requires them.
  requireDocuments:String(process.env.REQUIRE_DOCUMENTS||'').toLowerCase()==='true',
  documentsRequired:['id','payslip','bank_statement_1','bank_statement_2','bank_statement_3'],
 });
}));

// ── Consultant-side status + signature retrieval ───────────────────────────
// Keyed by the manage token returned from /api/invite. Unlike the signing
// token, a manage token stays valid after signing (that is the point of it),
// so the app can show the captured signature next to the applicant.
async function getManaged(manageToken){
 if(!manageToken) return null;
 return await get('SELECT * FROM invitations WHERE manage_token_hash=?',[hashToken(String(manageToken))]);
}

app.get('/api/manage/:manageToken',wrap(async(req,res)=>{
 const inv=await getManaged(req.params.manageToken);
 if(!inv) return res.status(404).json({error:'Signing request not found'});
 const sig=await get('SELECT signed_at FROM signatures WHERE invitation_id=?',[inv.id]);
 const expired=!sig && Date.now()>Date.parse(inv.expires_at);
 res.json({
  ok:true,
  invitationId:inv.id,
  signerLabel:inv.signer_label||'',
  clientName:inv.client_name,
  status: sig ? 'signed' : (expired ? 'expired' : 'pending'),
  signedAt: sig ? sig.signed_at : null,
  expiresAt:inv.expires_at,
  signatureUrl: sig ? `${BASE}/api/manage/${encodeURIComponent(req.params.manageToken)}/signature` : null,
 });
}));

app.get('/api/manage/:manageToken/signature',wrap(async(req,res)=>{
 const inv=await getManaged(req.params.manageToken);
 if(!inv) return res.status(404).json({error:'Signing request not found'});
 const sig=await get('SELECT signature_data FROM signatures WHERE invitation_id=?',[inv.id]);
 if(!sig) return res.status(404).json({error:'This request has not been signed yet'});
 // The PNG bytes are part of the row itself, so the image survives a redeploy.
 const bytes=sig.signature_data;
 if(!bytes) return res.status(404).json({error:'Signature image is no longer available'});
 res.setHeader('Cache-Control','no-store');
 res.type('png').send(Buffer.from(bytes));
}));

// Uploads are held in memory and written straight into the database row below, so
// a document never depends on a disk the host might wipe.
const upload=multer({
 storage:multer.memoryStorage(),
 limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||15)*1024*1024},
 fileFilter:(req,file,cb)=>{
  const ok=['application/pdf','image/jpeg','image/png'].includes(file.mimetype);
  if(ok) return cb(null,true);
  // A rejected type is the client's mistake, so it carries a status and the error
  // handler below passes the message on instead of turning it into a 500.
  const bad=new Error('Only PDF, JPG and PNG files are allowed'); bad.status=400; cb(bad);
 }
});

app.post('/api/sign/:token/upload',upload.array('documents',6),wrap(async(req,res)=>{
 const inv=await getInvite(req.params.token);
 if(!inv) return res.status(404).json({error:'Signing link not found'});
 if(inv.invalidReason) return res.status(410).json({error:'This signing link is no longer valid'});
 const files=req.files||[]; const kind=req.body.kind||'document'; const created=now();
 // Every file goes in with one atomic round trip. stored_name is written empty
 // because there is no longer a separate file for it to point at.
 await write(files.map(f=>({sql:'INSERT INTO documents(id,invitation_id,kind,original_name,stored_name,mime_type,size,created_at,content) VALUES(?,?,?,?,?,?,?,?,?)',
  args:[id(),inv.id,kind,f.originalname,'',f.mimetype,f.size,created,f.buffer]})));
 await audit(inv.id,'documents_uploaded',req,{count:files.length});
 res.json({ok:true,count:files.length});
}));

app.post('/api/sign/:token/complete',express.json({limit:'1mb'}),wrap(async(req,res)=>{
 const inv=await getInvite(req.params.token);
 if(!inv) return res.status(404).json({error:'Signing link not found'});
 if(inv.invalidReason) return res.status(410).json({error:'This signing link is no longer valid'});
 const signature=String(req.body.signature||'');
 if(!/^data:image\/(png|jpeg);base64,/.test(signature)) return res.status(400).json({error:'A valid signature image is required'});
 const docs=(await get('SELECT COUNT(*) c FROM documents WHERE invitation_id=?',[inv.id])).c;
 // A signature-only request (the application asks for the signature while the
 // paperwork is handled elsewhere) is allowed by default. Set
 // REQUIRE_DOCUMENTS=true to restore the original "upload before signing" rule.
 if(!docs && String(process.env.REQUIRE_DOCUMENTS||'').toLowerCase()==='true') return res.status(400).json({error:'Please upload the required documents before signing'});
 const raw=Buffer.from(signature.split(',')[1],'base64');
 const signed=now();
 try{
  // The UNIQUE index on signatures.invitation_id is what stops one link being
  // signed twice. All three writes travel in a single atomic batch, so a second
  // attempt can never leave a signature stored without its link being marked
  // used, or the reverse.
  await write([
   {sql:'INSERT INTO signatures(id,invitation_id,signature_file,signature_data,signed_at,ip,user_agent) VALUES(?,?,?,?,?,?,?)',args:[id(),inv.id,'',raw,signed,req.ip,req.get('user-agent')||'']},
   {sql:"UPDATE invitations SET used_at=?,status='signed' WHERE id=? AND used_at IS NULL",args:[signed,inv.id]},
   {sql:'INSERT INTO audit_log(invitation_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?)',args:[inv.id,'client_signed',signed,req.ip,req.get('user-agent')||'',JSON.stringify({documents:docs,xff:req.get('x-forwarded-for')||null})]},
  ]);
 }catch(e){
  if(isUniqueViolation(e)) return res.status(409).json({error:'This signing link has already been used'});
  throw e;
 }
 // The client is finished at this point, so the note says so rather than leaving
 // them waiting on a page that will never change again.
 res.json({ok:true,signedAt:signed,message:'Signature recorded successfully. Thank you. You can close this browser window now.'});
}));

app.get('/api/admin/invites',requireAdmin,wrap(async(req,res)=>{
 const rows=await all('SELECT id,client_name,id_number,phone,email,application_type,signer_label,application_ref,created_at,expires_at,used_at,status FROM invitations ORDER BY created_at DESC LIMIT 500');
 res.json({ok:true,rows});
}));
app.get('/api/admin/invite/:id',requireAdmin,wrap(async(req,res)=>{
 const inv=await get('SELECT * FROM invitations WHERE id=?',[req.params.id]);
 if(!inv)return res.status(404).json({error:'Not found'});
 const docs=await all('SELECT id,kind,original_name,mime_type,size,created_at FROM documents WHERE invitation_id=?',[inv.id]);
 const sig=await get('SELECT id,signed_at,ip,user_agent FROM signatures WHERE invitation_id=?',[inv.id]);
 const auditRows=await all('SELECT event,created_at,ip,meta FROM audit_log WHERE invitation_id=? ORDER BY created_at',[inv.id]);
 res.json({ok:true,invitation:inv,documents:docs,signature:sig,audit:auditRows});
}));

// Whatever a route did not answer itself is unexpected, and now that every route
// reaches a database over the network the likeliest case is a database that cannot
// be reached. An error that carries a status (a body that is not valid JSON, a
// refused origin, a file of the wrong type) keeps that status and its message;
// anything else is a fault on this side and becomes a 500 with a plain message,
// because the real one can name the database and belongs in the log rather than in
// a response to a client.
app.use((err,req,res,next)=>{
 console.error(err);
 if(res.headersSent)return next(err);
 // multer reports a refused upload with codes rather than a status. Those are the
 // client's mistake too: an oversized file is a 413 and any other limit a 400.
 const uploadStatus=err.name==='MulterError'?(err.code==='LIMIT_FILE_SIZE'?413:400):0;
 const status=uploadStatus||err.status||err.statusCode||500;
 res.status(status).json({error:status>=500?'The signature service could not complete that request':(err.message||'Request failed')});
});
app.listen(PORT,()=>console.log(`Khusela backend listening on ${BASE}`));
