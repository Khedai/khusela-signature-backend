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
// With no SMTP_USER, SMTP_PASS or MAIL_TO this reports itself as unconfigured
// and the route answers 503 — which is what the PWA reads as "this server
// cannot send, use the old path".
//
// It is kept out of server.js so the send can be tested on its own: the suite in
// tools/test_email_route.js points SMTP_HOST at a fake SMTP server it starts
// itself, so a real message is composed and delivered with no account, no
// internet and nothing leaving the machine.
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

// The three settings that decide whether mail can be sent at all. One function,
// so /health, the route and the send itself cannot disagree about it.
export function mailConfigured(){return !!(SMTP_USER&&SMTP_PASS&&MAIL_TO.length);}

let transport=null;
function mailer(){
 if(transport) return transport;
 if(!mailConfigured()) throw new Error('Email is not configured on the server');
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
// header or a body line — a newline inside a header is how a mail header gets
// forged. Used by both sends below, so neither has to remember to.
const cleanText=(v,n)=>String(v==null?'':v).replace(/[\r\n]+/g,' ').trim().slice(0,n);

// Everything the caller supplied is length-capped and stripped of newlines
// before it becomes a header or a body line — a newline inside a header is how
// a mail header gets forged. The PDF is the only value taken as-is.
export async function sendApplication({filename,pdf,applicant,idNumber,date,replyTo}={}){
 if(!mailConfigured()) throw new Error('Email is not configured on the server');
 if(!pdf||!pdf.length) throw new Error('The PDF attachment is empty');
 if(pdf.length>MAX_EMAIL_BYTES) throw new Error(`The PDF is ${(pdf.length/1048576).toFixed(1)} MB, over this service's ${MAX_EMAIL_MB} MB email limit`);
 const clean=(v,n)=>String(v==null?'':v).replace(/[\r\n]+/g,' ').trim().slice(0,n);
 const who=clean(applicant,120);
 const ref=clean(idNumber,40);
 const when=clean(date,40);
 const name=clean(filename,120)||'Khusela-Credit-Application.pdf';
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
 // to the client (the FormSubmit path worked the same way).
 const reply=clean(replyTo,200);
 if(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(reply)) mail.replyTo=reply;
const info=await mailer().sendMail(mail);
  const addr=a=>typeof a==='string'?a:((a&&(a.address||a))||'').toString();
  return {
   messageId:info.messageId,
   accepted:(info.accepted||[]).map(addr).filter(Boolean),
   rejected:(info.rejected||[]).map(addr).filter(Boolean),
  };
}

// ── Emailing a signing link to the client ───────────────────────────────────
// The signing link is the one thing the client cannot reach on their own, so
// this mails it to them from the office mailbox rather than leaving the
// consultant to paste it into a message themselves.
//
// WHO the mail goes to is the difference from sendApplication above, and it is
// the whole risk of this function: the recipient here is the address stored on
// the invitation — which the consultant's app put there from the applicant's
// own form — while sendApplication only ever uses MAIL_TO. The route in
// server.js is what enforces that: it looks the invitation up by its manage
// token and takes the address from the row, never from the request, so this
// function cannot be pointed at an arbitrary stranger. It also checks the link
// against the token hash before calling here.
//
// The link is the payload, so it is in both a plain-text and an HTML body: a
// mail client that rewrites URLs would break a link that only existed in HTML,
// and the one that only existed as text would be unclickable for most clients.
export async function sendSigningLink({to,clientName,signerLabel,applicationRef,signingLink,expiresAt}={}){
 if(!mailConfigured()) throw new Error('Email is not configured on the server');
 const addr=cleanText(to,200);
 if(!looksLikeEmail(addr)) throw new Error('That client has no valid email address on this signing request');
 const link=cleanText(signingLink,600);
 if(!/^https?:\/\//i.test(link)) throw new Error('There is no signing link to send yet');
 const who=cleanText(clientName,120);
 const label=cleanText(signerLabel,60);
 const ref=cleanText(applicationRef,80);
 const when=cleanText(expiresAt,40);
 const expiry=when&&!Number.isNaN(Date.parse(when))
  ?new Date(when).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'';
 const greeting=who?`Hi ${who},`:'Hi,';
 const body=[
  greeting,
  '',
  label
   ?`${label} can sign your Khusela credit application here:`
   :'You can sign your Khusela credit application here:',
  '',
  link,
  '',
  'Open that link on this device, draw your signature with your finger and press submit. That is all — you only sign once.',
  ref?`Application reference: ${ref}`:null,
  expiry?`This link expires on ${expiry}, after which a new one can be sent.`:null,
  '',
  'If you did not expect this message, you can ignore it: nobody is charged and no information about your application is sent unless you open the link and sign.',
 ].filter(v=>v!==null).join('\n');
 const html=`<p>${greeting}</p>`
  +`<p>${label?`${escapeHtml(label)} can sign your Khusela credit application here:`:'You can sign your Khusela credit application here:'}</p>`
  +`<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2e7d32;color:#fff;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:bold">Sign my application</a></p>`
  +'<p style="font-size:12px;color:#555">Open that link on this device, draw your signature with your finger and press submit. That is all &mdash; you only sign once.</p>'
  +`<p style="font-size:12px;color:#555">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>`
  +(ref?`<p style="font-size:12px;color:#555">Application reference: ${escapeHtml(ref)}</p>`:'')
  +(expiry?`<p style="font-size:12px;color:#555">This link expires on ${escapeHtml(expiry)}, after which a new one can be sent.</p>`:'')
  +'<p style="font-size:12px;color:#777">If you did not expect this message you can ignore it: nobody is charged and nothing about your application is sent unless you open the link and sign.</p>';
 const mail={
  from:MAIL_FROM,
  to:addr,
  subject:`Khusela: your signing link${ref?` (ref ${ref})`:''}`,
  text:body,
  html,
 };
 // The office stays the reply address, so an answer from the client lands with
 // the consultant rather than with the service.
 if(looksLikeEmail(MAIL_TO[0])) mail.replyTo=MAIL_TO[0];
 const info=await mailer().sendMail(mail);
 const addrOf=a=>typeof a==='string'?a:((a&&(a.address||a))||'').toString();
 return {
  messageId:info.messageId,
  accepted:(info.accepted||[]).map(addrOf).filter(Boolean),
  rejected:(info.rejected||[]).map(addrOf).filter(Boolean),
 };
}

// Only the values above are interpolated into HTML, and all of them can come
// from a request, so they are escaped rather than trusted. The link is the one
// that matters: an unescaped quote in it would end the href attribute and let
// the address carry markup of its own.
function escapeHtml(v){
 return String(v==null?'':v)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
