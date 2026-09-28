import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

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
// Everything the server writes is kept under one directory, so a single mounted
// disk (Render's /var/data, for example) can hold the database, the uploaded
// documents and the signatures together. __dirname is the deployed code folder,
// which hosts like Render replace on every deploy, so STORAGE_DIR must point at
// the mounted disk once there is one.
const STORAGE_DIR=path.resolve(__dirname,process.env.STORAGE_DIR||'./storage');
const DB_PATH=path.resolve(__dirname,process.env.DB_PATH||path.join(STORAGE_DIR,'khusela.db'));
const UPLOAD_DIR=path.join(STORAGE_DIR,'uploads');
const SIG_DIR=path.join(STORAGE_DIR,'signatures');
fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
fs.mkdirSync(UPLOAD_DIR,{recursive:true}); fs.mkdirSync(SIG_DIR,{recursive:true});

const db=new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS invitations(
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
 id_number TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, application_type TEXT,
 debit_amount TEXT, debit_date TEXT, consultant TEXT, branch TEXT,
 manage_token_hash TEXT, signer_label TEXT, application_ref TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS documents(
 id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL, kind TEXT NOT NULL, original_name TEXT NOT NULL,
 stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(invitation_id) REFERENCES invitations(id)
);
CREATE TABLE IF NOT EXISTS signatures(
 id TEXT PRIMARY KEY, invitation_id TEXT UNIQUE NOT NULL, signature_file TEXT NOT NULL,
 signed_at TEXT NOT NULL, ip TEXT, user_agent TEXT, FOREIGN KEY(invitation_id) REFERENCES invitations(id)
);
CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT, invitation_id TEXT, event TEXT NOT NULL,
 created_at TEXT NOT NULL, ip TEXT, user_agent TEXT, meta TEXT
);`);

// Lightweight migrations: CREATE TABLE IF NOT EXISTS never adds a column to a
// database that already exists, so additive columns are applied here.
function ensureColumn(table,column,definition){
 const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
 if(!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('invitations','manage_token_hash','TEXT');
ensureColumn('invitations','signer_label','TEXT');
ensureColumn('invitations','application_ref','TEXT');
// The manage token is the consultant-side capability: it is only ever returned
// to the app that created the request, never sent to the client.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_manage_token ON invitations(manage_token_hash)');

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
function safeName(n){return path.basename(String(n||'file')).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120);}
function audit(inv,event,req,meta={}){db.prepare('INSERT INTO audit_log(invitation_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?)').run(inv,event,now(),req.ip,req.get('user-agent')||'',JSON.stringify(meta));}
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
app.post('/api/invite',(req,res)=>{
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
  db.prepare(`INSERT INTO invitations(id,token_hash,manage_token_hash,client_name,id_number,phone,email,address,application_type,debit_amount,debit_date,consultant,branch,signer_label,application_ref,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(inviteId,hashToken(token),hashToken(manageToken),String(b.clientName),String(b.idNumber),b.phone||'',b.email||'',b.address||'',b.applicationType||'',b.debitAmount||'',b.debitDate||'',b.consultant||'',b.branch||'',signerLabel,applicationRef,new Date(created).toISOString(),expires);
  audit(inviteId,'invite_created',req,{expires,signerLabel:signerLabel||null});
  const signingLink=`${BASE}/sign/${token}`;
  res.json({ok:true,invitationId:inviteId,signingLink,manageToken,signerLabel,expiresAt:expires});
 }catch(e){console.error(e);res.status(500).json({error:'Could not generate secure signing link'});}
});

function getInvite(token){
 const inv=db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(hashToken(token));
 if(!inv) return null;
 if(inv.used_at || inv.status==='signed') return {...inv,invalidReason:'already_signed'};
 if(Date.now()>Date.parse(inv.expires_at)) return {...inv,invalidReason:'expired'};
 return inv;
}

app.get('/api/sign/:token',(req,res)=>{
 const inv=getInvite(req.params.token);
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
});

// ── Consultant-side status + signature retrieval ───────────────────────────
// Keyed by the manage token returned from /api/invite. Unlike the signing
// token, a manage token stays valid after signing (that is the point of it),
// so the app can show the captured signature next to the applicant.
function getManaged(manageToken){
 if(!manageToken) return null;
 return db.prepare('SELECT * FROM invitations WHERE manage_token_hash=?').get(hashToken(String(manageToken))) || null;
}

app.get('/api/manage/:manageToken',(req,res)=>{
 const inv=getManaged(req.params.manageToken);
 if(!inv) return res.status(404).json({error:'Signing request not found'});
 const sig=db.prepare('SELECT signed_at FROM signatures WHERE invitation_id=?').get(inv.id)||null;
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
});

app.get('/api/manage/:manageToken/signature',(req,res)=>{
 const inv=getManaged(req.params.manageToken);
 if(!inv) return res.status(404).json({error:'Signing request not found'});
 const sig=db.prepare('SELECT signature_file FROM signatures WHERE invitation_id=?').get(inv.id);
 if(!sig) return res.status(404).json({error:'This request has not been signed yet'});
 const file=path.join(SIG_DIR,sig.signature_file);
 if(!fs.existsSync(file)) return res.status(404).json({error:'Signature image is no longer available'});
 res.setHeader('Cache-Control','no-store');
 res.sendFile(file);
});

const upload=multer({
 storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,UPLOAD_DIR),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+'-'+safeName(file.originalname))}),
 limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||15)*1024*1024},
 fileFilter:(req,file,cb)=>{const ok=['application/pdf','image/jpeg','image/png'].includes(file.mimetype); cb(ok?null:new Error('Only PDF, JPG and PNG files are allowed'),ok);}
});

app.post('/api/sign/:token/upload',upload.array('documents',6),(req,res)=>{
 const inv=getInvite(req.params.token);
 if(!inv) return res.status(404).json({error:'Signing link not found'});
 if(inv.invalidReason) return res.status(410).json({error:'This signing link is no longer valid'});
 const files=req.files||[];
 const insert=db.prepare('INSERT INTO documents(id,invitation_id,kind,original_name,stored_name,mime_type,size,created_at) VALUES(?,?,?,?,?,?,?,?)');
 const tx=db.transaction(()=>files.forEach(f=>insert.run(id(),inv.id,req.body.kind||'document',f.originalname,f.filename,f.mimetype,f.size,now()))); tx();
 audit(inv.id,'documents_uploaded',req,{count:files.length});
 res.json({ok:true,count:files.length});
});

app.post('/api/sign/:token/complete',express.json({limit:'1mb'}),(req,res)=>{
 const inv=getInvite(req.params.token);
 if(!inv) return res.status(404).json({error:'Signing link not found'});
 if(inv.invalidReason) return res.status(410).json({error:'This signing link is no longer valid'});
 const signature=String(req.body.signature||'');
 if(!/^data:image\/(png|jpeg);base64,/.test(signature)) return res.status(400).json({error:'A valid signature image is required'});
 const docs=db.prepare('SELECT COUNT(*) c FROM documents WHERE invitation_id=?').get(inv.id).c;
 // A signature-only request (the application asks for the signature while the
 // paperwork is handled elsewhere) is allowed by default. Set
 // REQUIRE_DOCUMENTS=true to restore the original "upload before signing" rule.
 if(!docs && String(process.env.REQUIRE_DOCUMENTS||'').toLowerCase()==='true') return res.status(400).json({error:'Please upload the required documents before signing'});
 const raw=signature.split(',')[1];
 const file=id()+'.png'; fs.writeFileSync(path.join(SIG_DIR,file),Buffer.from(raw,'base64'));
 const signed=now();
 const tx=db.transaction(()=>{
  db.prepare('INSERT INTO signatures(id,invitation_id,signature_file,signed_at,ip,user_agent) VALUES(?,?,?,?,?,?)').run(id(),inv.id,file,signed,req.ip,req.get('user-agent')||'');
  db.prepare("UPDATE invitations SET used_at=?,status='signed' WHERE id=? AND used_at IS NULL").run(signed,inv.id);
  audit(inv.id,'client_signed',req,{documents:docs});
 });
 try{tx();}catch(e){fs.rmSync(path.join(SIG_DIR,file),{force:true});return res.status(409).json({error:'This signing link has already been used'});}
 res.json({ok:true,signedAt:signed,message:'Signature recorded successfully. Thank you.'});
});

app.get('/api/admin/invites',requireAdmin,(req,res)=>{
 const rows=db.prepare('SELECT id,client_name,id_number,phone,email,application_type,signer_label,application_ref,created_at,expires_at,used_at,status FROM invitations ORDER BY created_at DESC LIMIT 500').all();
 res.json({ok:true,rows});
});
app.get('/api/admin/invite/:id',requireAdmin,(req,res)=>{
 const inv=db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
 if(!inv)return res.status(404).json({error:'Not found'});
 const docs=db.prepare('SELECT id,kind,original_name,mime_type,size,created_at FROM documents WHERE invitation_id=?').all(inv.id);
 const sig=db.prepare('SELECT id,signed_at,ip,user_agent FROM signatures WHERE invitation_id=?').get(inv.id)||null;
 const auditRows=db.prepare('SELECT event,created_at,ip,meta FROM audit_log WHERE invitation_id=? ORDER BY created_at').all(inv.id);
 res.json({ok:true,invitation:inv,documents:docs,signature:sig,audit:auditRows});
});

app.use((err,req,res,next)=>{console.error(err); if(res.headersSent)return next(err); res.status(400).json({error:err.message||'Request failed'});});
app.listen(PORT,()=>console.log(`Khusela backend listening on ${BASE}`));
