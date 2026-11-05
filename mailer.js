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
//   FORMSPREE_ENDPOINT
//               the permanent HTTPS path. Render's free tier blocks SMTP ports
//               (25/465/587), so a free instance cannot use the SMTP path above;
//               it CAN make ordinary HTTPS requests. Point this at a Formspree
//               form's endpoint (https://formspree.io/f/<id>) and the application
//               is delivered through Formspree, whose recipient is fixed on the
//               form. The office already uses Formspree elsewhere, so this needs
//               no new account.
//
// With no SMTP_* / MAIL_TO and no FORMSPREE_ENDPOINT this reports itself as
// unconfigured and the route answers 503 after storing the PDF in the bucket.
//
// It is kept out of server.js so the send can be tested on its own: the suite in
// tools/test_email_route.js points SMTP_HOST at a fake SMTP server it starts
// itself (and FORMSPREE_ENDPOINT at a fake HTTP server), so a real message is
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
// Formspree is the permanent HTTPS delivery path: the office keeps a form there
// (as it does for its other services) and this service posts each application to
// it. Its recipient is fixed on the form, so a caller cannot name one. Empty
// means "not set up". See .env.example.
export const FORMSPREE_ENDPOINT=process.env.FORMSPREE_ENDPOINT||'';

// Whether each delivery path is set up. mailConfigured() is true when EITHER is:
// a mailbox we control (SMTP) or a Formspree endpoint — one function, so /health,
// the route and the send itself cannot disagree about it.
const smtpConfigured=()=>!!(SMTP_USER&&SMTP_PASS&&MAIL_TO.length);
export function mailConfigured(){return smtpConfigured()||!!FORMSPREE_ENDPOINT;}

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

// The address a client may be sent mail at. Deliberately stricter than the
// office-recipient check above: this is the one message here whose recipient
// comes from a request (via the invitation row), so a shape that is not plainly
// one address has no business being a header.
export function looksLikeEmail(v){return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(v||'').trim());}

// Strip newlines and cap the length of anything that is about to become a
// header, a body line or a form field — a newline inside one is how a header or
// a field gets forged. Used by both sends below, so neither has to remember to.
const cleanField=(v,n)=>String(v==null?'':v).replace(/[\r\n]+/g,' ').trim().slice(0,n);

// ── Path 1: our own mailbox over SMTP ────────────────────────────────────────
// Only runs when SMTP_USER/SMTP_PASS/MAIL_TO are set — a paid host or a local
// `npm start`. Render's free tier cannot reach SMTP ports (25/465/587), so there
// this path is simply skipped and the HTTPS path below carries the application.
async function sendViaSmtp({filename,pdf,applicant,idNumber,date,replyTo}={}){
 const who=cleanField(applicant,120);
 const ref=cleanField(idNumber,40);
 const when=cleanField(date,40);
 const name=cleanField(filename,120)||'Khusela-Credit-Application.pdf';
 const body=[
  `Applicant: ${who||'(not given)'}`,
  ref?`ID number: ${ref}`:null,
  when?`Date: ${when}`:null,
  '',
  'The completed Khusela credit application is attached to this email as a PDF.',
  "Any signature captured on the client's own device is already included in that PDF.",
 ].filter(v=>v!==null).join('\n');
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

// ── Path 2: Formspree over HTTPS ─────────────────────────────────────────────
// Render's free tier blocks SMTP ports but allows ordinary HTTPS, so this is the
// permanent path for a free instance. Formspree is a provider-backed
// form-to-email service the office already uses elsewhere; the application is
// posted to the form's endpoint exactly as a browser would — PDF and all — and
// its recipient is fixed on the form, so a caller cannot name one.
async function sendViaFormspree({filename,pdf,applicant,idNumber,date,replyTo}={}){
 if(!FORMSPREE_ENDPOINT) throw new Error('Formspree is not configured on the server');
 const who=cleanField(applicant,120);
 const form=new FormData();
 form.append('_subject', who?`${MAIL_SUBJECT} - ${who}`:MAIL_SUBJECT);
 const reply=cleanField(replyTo,200);
 if(looksLikeEmail(reply)) form.append('_replyto', reply);
 form.append('Applicant', who||'(not given)');
 form.append('ID Number', cleanField(idNumber,40));
 form.append('Date', cleanField(date,40));
 form.append('attachment', new Blob([pdf], {type:'application/pdf'}), cleanField(filename,120)||'Khusela-Credit-Application.pdf');
 let res;
 try{
  res=await fetch(FORMSPREE_ENDPOINT,{method:'POST',body:form,headers:{Accept:'application/json'}});
 }catch(e){
  throw new Error('Formspree could not be reached: '+(e&&e.message?e.message:e));
 }
 if(!res.ok){
  let detail='';
  try{ const j=await res.json(); detail=j?(' '+JSON.stringify(j)):''; }catch(e){}
  throw new Error(`Formspree answered ${res.status}${detail}`);
 }
 return { messageId:null, accepted:['formspree'], rejected:[] };
}

// The one entry point the route calls. It validates the PDF once, then tries the
// delivery paths in order — our own mailbox first, Formspree second — and throws
// with every failure if none carried it. The PDF is already in the bucket by the
// time this runs (see server.js), so nothing here can lose an application.
export async function sendApplication({filename,pdf,applicant,idNumber,date,replyTo}={}){
 if(!mailConfigured()) throw new Error('Email is not configured on the server');
 if(!pdf||!pdf.length) throw new Error('The PDF attachment is empty');
 if(pdf.length>MAX_EMAIL_BYTES) throw new Error(`The PDF is ${(pdf.length/1048576).toFixed(1)} MB, over this service's ${MAX_EMAIL_MB} MB email limit`);
 const errors=[];
 if(smtpConfigured()){
  try{ return await sendViaSmtp({filename,pdf,applicant,idNumber,date,replyTo}); }
  catch(e){ errors.push('mailbox: '+(e&&e.message?e.message:e)); }
 }
 if(FORMSPREE_ENDPOINT){
  try{ return await sendViaFormspree({filename,pdf,applicant,idNumber,date,replyTo}); }
  catch(e){ errors.push('Formspree: '+(e&&e.message?e.message:e)); }
 }
 throw new Error(errors.length?errors.join('; '):'Email is not configured on the server');
}
