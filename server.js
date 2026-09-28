import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { DB_URL, USING_REMOTE_DB, all, get, run, write, ddl, isUniqueViolation } from './db.js';

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
await ddl(SCHEMA);

// Lightweight migrations: CREATE TABLE IF NOT EXISTS never adds a column to a
// database that already exists, so additive columns are applied here.
async function ensureColumn(table,column,definition){
 const cols=(await all(`PRAGMA table_info(${table})`)).map(c=>c.name);
 if(!cols.includes(column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
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

const app=express();
app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
const origins=(process.env.ALLOWED_ORIGINS||'*').split(',').map(x=>x.trim());
app.use(cors({origin:(origin,cb)=>{if(!origin||origins.includes('*')||origins.includes(origin)) return cb(null,true); cb(new Error('CORS origin denied'));}}));
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

app.get('/health',(req,res)=>res.json({ok:true,service:'khusela-digital-signature',time:now()}));

// Matches the existing Khusela HTML's Generate Signing Link call.
app.post('/api/invite',wrap(async(req,res)=>{
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
 fileFilter:(req,file,cb)=>{const ok=['application/pdf','image/jpeg','image/png'].includes(file.mimetype); cb(ok?null:new Error('Only PDF, JPG and PNG files are allowed'),ok);}
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
   {sql:'INSERT INTO audit_log(invitation_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?)',args:[inv.id,'client_signed',signed,req.ip,req.get('user-agent')||'',JSON.stringify({documents:docs})]},
  ]);
 }catch(e){
  if(isUniqueViolation(e)) return res.status(409).json({error:'This signing link has already been used'});
  throw e;
 }
 res.json({ok:true,signedAt:signed,message:'Signature recorded successfully. Thank you.'});
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

app.use((err,req,res,next)=>{console.error(err); if(res.headersSent)return next(err); res.status(400).json({error:err.message||'Request failed'});});
app.listen(PORT,()=>console.log(`Khusela backend listening on ${BASE}`));
