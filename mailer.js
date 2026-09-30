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
