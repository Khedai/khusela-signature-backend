// Emailing a finished Khusela application (the PDF the PWA builds) from this
// service, using a mailbox we control.
//
// WHY THIS EXISTS: the PWA used to hand the PDF to FormSubmit, a free
// form-to-email service, with no backend involved. On 2026-09-30 every
// submission to it came back HTTP 500 — its own /documentation page answered
// with "Server Error 500 ... Looks like we are having some server issues" —
// while the app, which can only see that *something* answered inside its hidden
// iframe, reported the send as successful. Applications stopped arriving and
// nobody was told. Sending from here removes the third party, lifts the 10 MB
// attachment ceiling (the app's own limit) and, because the reply is a real HTTP
// status, the app can tell the truth about whether the mail was sent.
//
// Configuration, all read once at startup (see .env.example and render.yaml):
//   MAIL_TO     the office mailbox. It is the ONLY recipient this service will
//               ever use — a caller cannot name one (see the route in
//               server.js), because an endpoint a browser can call must not be
//               a way to send mail to strangers. A comma-separated list works.
//   SMTP_HOST   defaults to smtp.gmail.com.
//   SMTP_PORT   defaults to 465, which is implicit TLS. 587 (STARTTLS) works
//               too; SMTP_SECURE overrides the guess when the two disagree.
//   SMTP_USER   the mailbox address.
//   SMTP_PASS   its APP PASSWORD. Google refuses the ordinary account password
//               over SMTP, and only offers an app password once 2-step
//               verification is on (myaccount.google.com > Security > App
//               passwords). The 16 characters are shown with spaces; type them
//               without.
//   MAIL_FROM   defaults to SMTP_USER, which is the sender Gmail rewrites to
//               anyway. A different address works only if Gmail has it as a
//               verified "send as" alias.
//   MAIL_SUBJECT
//               defaults to the subject the office already filters on. The
//               applicant's name is appended to it.
//   MAX_EMAIL_MB  20 by default. Gmail refuses a message over 25 MB including
//               its own encoding overhead, so the ceiling sits under that.
//   BREVO_API_KEY
//               the free HTTPS attachment path. Render's free tier blocks SMTP
//               ports (25/465/587), so a free instance cannot use the SMTP path
//               above; it CAN make ordinary HTTPS requests. Brevo's free plan
//               allows attachments (up to 25 MB) and 300 messages a day, which is
//               what makes it a drop-in replacement for a mailbox here. Create a
//               key under Brevo > SMTP & API > API Keys.
//   BREVO_SENDER
//               the address Brevo sends from. It must be a verified sender (or a
//               verified domain) in the Brevo account, otherwise Brevo refuses
//               the message. Defaults to MAIL_FROM.
//   FORMSPREE_ENDPOINT
//               the other HTTPS path. Point this at a Formspree form's endpoint
//               (https://formspree.io/f/<id>); its recipient is fixed on the
//               form. Formspree's FREE plan refuses file uploads, so when it
//               answers "File Uploads Not Permitted" this path retries without
//               the PDF and puts a secure, expiring download link in the email
//               instead. Paid Formspree plans carry the attachment itself. The
//               office already uses Formspree elsewhere, so this needs no new
//               account.
//
// With no SMTP_* / BREVO_API_KEY / FORMSPREE_ENDPOINT this reports itself as
// unconfigured and the route answers 503 after storing the PDF in the bucket.
//
// It is kept out of server.js so the send can be tested on its own: the suite in
// tools/test_email_route.js points SMTP_HOST at a fake SMTP server it starts
// itself (and BREVO/FORMSPREE at fake HTTP servers), so a real message is
// composed and delivered with no account, no internet and nothing leaving the
// machine.
import nodemailer from 'nodemailer';

const list=v=>String(v||'').split(',').map(s=>s.trim()).filter(Boolean);
export const MAIL_TO=list(process.env.MAIL_TO);
export const SMTP_HOST=process.env.SMTP_HOST||'smtp.gmail.com';
export const SMTP_PORT=Number(process.env.SMTP_PORT||465);
const SMTP_USER=process.env.SMTP_USER||'';
const SMTP_PASS=process.env.SMTP_PASS||'';
export const MAIL_FROM=process.env.MAIL_FROM||SMTP_USER;
export const MAIL_SUBJECT=process.env.MAIL_SUBJECT||'Khusela Credit Application - ITC report';
export const MAX_EMAIL_MB=Math.min(24,Math.max(1,Number(process.env.MAX_EMAIL_MB||20)));
export const MAX_EMAIL_BYTES=MAX_EMAIL_MB*1024*1024;
// Brevo over HTTPS: the free-plan path that carries the PDF as an attachment even
// on a host (Render free) whose SMTP ports are blocked. Empty means "not set up".
export const BREVO_API_KEY=process.env.BREVO_API_KEY||'';
export const BREVO_SENDER=process.env.BREVO_SENDER||MAIL_FROM;
// Overridable so the suite can point at a fake endpoint; production leaves it.
export const BREVO_API_URL=process.env.BREVO_API_URL||'https://api.brevo.com/v3/smtp/email';
// Formspree over HTTPS: the office keeps a form there (as it does for its other
// services). Its free plan refuses file uploads, so that case falls back to a
// secure link in the email rather than failing. Empty means "not set up".
export const FORMSPREE_ENDPOINT=process.env.FORMSPREE_ENDPOINT||'';

// The address a client may be sent mail at. Deliberately stricter than the
// office-recipient check above: this is the one message here whose recipient
// comes from a request (via the invitation row), so a shape that is not plainly
// one address has no business being a header.
export function looksLikeEmail(v){return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(v||'').trim());}

// Whether each delivery path is set up. mailConfigured() is true when ANY is: a
// mailbox we control (SMTP), a Brevo key, or a Formspree endpoint — one function,
// so /health, the route and the send itself cannot disagree about it.
const smtpConfigured=()=>!!(SMTP_USER&&SMTP_PASS&&MAIL_TO.length);
const brevoConfigured=()=>!!(BREVO_API_KEY&&MAIL_TO.length&&looksLikeEmail(BREVO_SENDER));
export function mailConfigured(){return smtpConfigured()||brevoConfigured()||!!FORMSPREE_ENDPOINT;}
// Which paths are ready, for /health. Names only — never a key, a password or an
// address — so an operator can confirm the deployment without reading the logs.
export function mailPaths(){return {smtp:smtpConfigured(),brevo:brevoConfigured(),formspree:!!FORMSPREE_ENDPOINT};}

let transport=null;
function mailer(){
 if(transport) return transport;
 if(!smtpConfigured()) throw new Error('The SMTP mailbox is not configured on the server');
 const flag=(process.env.SMTP_SECURE||'').trim().toLowerCase();
 const secure=flag?flag==='true':SMTP_PORT===465;
 transport=nodemailer.createTransport({
  host:SMTP_HOST,port:SMTP_PORT,secure,
  auth:{user:SMTP_USER,pass:SMTP_PASS},
  // A wrong port must fail the request rather than hang it: the PWA gives up
  // after two minutes, and a consultant watching a spinner learns nothing.
  connectionTimeout:15000,greetingTimeout:15000,socketTimeout:60000,
 });
 return transport;
}

// Strip newlines and cap the length of anything that is about to become a
// header, a body line or a form field — a newline inside one is how a header or
// a field gets forged. Used by every send below, so none has to remember to.
const cleanField=(v,n)=>String(v==null?'':v).replace(/[\r\n]+/g,' ').trim().slice(0,n);

// The plain-text body shared by every path. `downloadUrl` is present only when
// the path cannot carry the attachment (Formspree's free plan); the secure link
// is then the way to the PDF, and the text says so rather than pretending a file
// is attached.
function applicationText({applicant,idNumber,date,downloadUrl}={}){
 const who=cleanField(applicant,120);
 const ref=cleanField(idNumber,40);
 const when=cleanField(date,40);
 return [
  `Applicant: ${who||'(not given)'}`,
  ref?`ID number: ${ref}`:null,
  when?`Date: ${when}`:null,
  '',
  downloadUrl
   ? 'The completed Khusela credit application is ready to download from the secure link below. The link is private and expires.'
   : 'The completed Khusela credit application is attached to this email as a PDF.',
  downloadUrl?`Download PDF: ${downloadUrl}`:null,
  "Any signature captured on the client's own device is already included in that PDF.",
 ].filter(v=>v!==null).join('\n');
}

// ── Path 1: our own mailbox over SMTP ────────────────────────────────────────
// Only runs when SMTP_USER/SMTP_PASS/MAIL_TO are set — a paid host or a local
// `npm start`. Render's free tier cannot reach SMTP ports (25/465/587), so there
// this path is simply skipped and an HTTPS path below carries the application.
async function sendViaSmtp({filename,pdf,applicant,idNumber,date,replyTo}={}){
 const who=cleanField(applicant,120);
 const name=cleanField(filename,120)||'Khusela-Credit-Application.pdf';
 const body=applicationText({applicant,idNumber,date});
 const mail={
  from:MAIL_FROM,
  to:MAIL_TO.join(','),
  subject:who?`${MAIL_SUBJECT} - ${who}`:MAIL_SUBJECT,
  text:body,
  attachments:[{filename:name,content:pdf,contentType:'application/pdf'}],
 };
 // Deliberately a check and not a copy: the applicant's address becomes the
 // Reply-To only when it looks like an address, so the office can reply straight
 // to the client.
 const reply=cleanField(replyTo,200);
 if(looksLikeEmail(reply)) mail.replyTo=reply;
 const info=await mailer().sendMail(mail);
 const addr=a=>typeof a==='string'?a:((a&&(a.address||a))||'').toString();
 return {
  messageId:info.messageId,
  accepted:(info.accepted||[]).map(addr).filter(Boolean),
  rejected:(info.rejected||[]).map(addr).filter(Boolean),
 };
}

// ── Path 2: Brevo over HTTPS, with the PDF attached ──────────────────────────
// Render's free tier blocks SMTP ports but allows ordinary HTTPS. Brevo's free
// plan accepts an attachment (up to 25 MB) and 300 messages a day, so this is the
// permanent way to keep the actual PDF in the office's inbox on a free instance.
// The recipient is still MAIL_TO and nothing in the request can name one.
async function sendViaBrevo({filename,pdf,applicant,idNumber,date,replyTo}={}){
 if(!brevoConfigured()) throw new Error('Brevo is not configured on the server (BREVO_API_KEY / BREVO_SENDER / MAIL_TO)');
 const who=cleanField(applicant,120);
 const reply=cleanField(replyTo,200);
 const payload={
  sender:{email:BREVO_SENDER, name:'Khusela Management'},
  to:MAIL_TO.map(email=>({email})),
  subject:who?`${MAIL_SUBJECT} - ${who}`:MAIL_SUBJECT,
  textContent:applicationText({applicant,idNumber,date}),
  attachment:[{
   name:cleanField(filename,120)||'Khusela-Credit-Application.pdf',
   content:Buffer.from(pdf).toString('base64'),
  }],
 };
 if(looksLikeEmail(reply)) payload.replyTo={email:reply};
 let res;
 try{
  res=await fetch(BREVO_API_URL,{
   method:'POST',
   headers:{'api-key':BREVO_API_KEY,'Content-Type':'application/json',Accept:'application/json'},
   body:JSON.stringify(payload),
  });
 }catch(e){
  throw new Error('Brevo could not be reached: '+(e&&e.message?e.message:e));
 }
 if(!res.ok){
  let detail='';
  try{ const j=await res.json(); detail=j?(' '+JSON.stringify(j)):''; }catch(e){}
  throw new Error(`Brevo answered ${res.status}${detail}`);
 }
 let id=null;
 try{ const j=await res.json(); id=j&&j.messageId?j.messageId:null; }catch(e){}
 return { messageId:id, accepted:MAIL_TO.slice(), rejected:[] };
}

// ── Path 3: Formspree over HTTPS ─────────────────────────────────────────────
// Formspree is a provider-backed form-to-email service the office already uses
// elsewhere. Paid plans carry the PDF; the free plan refuses uploads with
// "File Uploads Not Permitted", so that answer is not treated as a dead end: the
// application is posted again without the file and with `downloadUrl` — a
// secure, expiring link generated by server.js — in the email. The office still
// gets the application, and the bucket remains the permanent copy.
async function sendViaFormspree({filename,pdf,applicant,idNumber,date,replyTo,downloadUrl}={}){
 if(!FORMSPREE_ENDPOINT) throw new Error('Formspree is not configured on the server');
 const who=cleanField(applicant,120);
 const reply=cleanField(replyTo,200);
 const post=async(withFile)=>{
  const form=new FormData();
  form.append('_subject', who?`${MAIL_SUBJECT} - ${who}`:MAIL_SUBJECT);
  if(looksLikeEmail(reply)) form.append('_replyto', reply);
  form.append('Applicant', who||'(not given)');
  form.append('ID Number', cleanField(idNumber,40));
  form.append('Date', cleanField(date,40));
  if(withFile){
   form.append('attachment', new Blob([pdf], {type:'application/pdf'}), cleanField(filename,120)||'Khusela-Credit-Application.pdf');
  }else{
   // The free plan can carry text fields; the PDF stays in the bucket and this
   // link is the way to it. A missing link means this fallback cannot run, so
   // say that plainly rather than sending an email with no PDF and no way to get it.
   if(!downloadUrl) throw new Error('Formspree refused the file and no secure download link is configured');
   form.append('Download PDF', downloadUrl);
   form.append('Note', 'The PDF is not attached because this Formspree plan does not accept file uploads. Use the secure link above; it expires.');
  }
  let res;
  try{
   res=await fetch(FORMSPREE_ENDPOINT,{method:'POST',body:form,headers:{Accept:'application/json'}});
  }catch(e){
   throw new Error('Formspree could not be reached: '+(e&&e.message?e.message:e));
  }
  let body='';
  try{ body=await res.text(); }catch(e){}
  return {res,body};
 };
 const first=await post(true);
 if(first.res.ok) return { messageId:null, accepted:['formspree'], rejected:[] };
 // Only a plan/upload refusal (or a file too large for the provider) falls back
 // to the link. Any other refusal (bad endpoint, unconfirmed form, quota) is a
 // real failure and is reported as one.
 const uploadRefused=/file uploads? (not permitted|are not allowed)/i.test(first.body)||first.res.status===413;
 if(uploadRefused && downloadUrl){
  const second=await post(false);
  if(second.res.ok) return { messageId:null, accepted:['formspree (secure link)'], rejected:[], linkOnly:true };
  throw new Error(`Formspree answered ${second.res.status} ${second.body}`.trim());
 }
 throw new Error(`Formspree answered ${first.res.status} ${first.body}`.trim());
}

// The one entry point the route calls. It validates the PDF once, then tries the
// delivery paths in order — our own mailbox first, Brevo second (attachment over
// HTTPS), Formspree last — and throws with every failure if none carried it. The
// PDF is already in the bucket by the time this runs (see server.js), so nothing
// here can lose an application. `downloadUrl` is used only by Formspree's
// file-upload fallback.
export async function sendApplication({filename,pdf,applicant,idNumber,date,replyTo,downloadUrl}={}){
 if(!mailConfigured()) throw new Error('Email is not configured on the server');
 if(!pdf||!pdf.length) throw new Error('The PDF attachment is empty');
 if(pdf.length>MAX_EMAIL_BYTES) throw new Error(`The PDF is ${(pdf.length/1048576).toFixed(1)} MB, over this service's ${MAX_EMAIL_MB} MB email limit`);
 const errors=[];
 if(smtpConfigured()){
  try{ return await sendViaSmtp({filename,pdf,applicant,idNumber,date,replyTo}); }
  catch(e){ errors.push('mailbox: '+(e&&e.message?e.message:e)); }
 }
 if(brevoConfigured()){
  try{ return await sendViaBrevo({filename,pdf,applicant,idNumber,date,replyTo}); }
  catch(e){ errors.push('Brevo: '+(e&&e.message?e.message:e)); }
 }
 if(FORMSPREE_ENDPOINT){
  try{ return await sendViaFormspree({filename,pdf,applicant,idNumber,date,replyTo,downloadUrl}); }
  catch(e){ errors.push('Formspree: '+(e&&e.message?e.message:e)); }
 }
 throw new Error(errors.length?errors.join('; '):'Email is not configured on the server');
}
