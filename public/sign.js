// The client signing page (served at /sign/<token> as public/sign.html).
//
// This is an external file on purpose: server.js sends helmet's default
// Content-Security-Policy, whose script-src is 'self'. The script used to sit
// inline in the page, and the browser therefore refused to run it — the client
// was left on "Loading your secure signing session…" with no form and no way to
// sign. A same-origin file is allowed by that policy, so the script lives here.
// One identifier was renamed as it moved: load() declared `const r` and, further
// down in the same function, `var r` — and because const and var share the
// function's scope, that is an early SyntaxError in every V8 browser. The page's
// script therefore never ran (the form never appeared), on top of being refused
// by the CSP. The inner one is `var row` now.
//
// The pad is also sized twice, and it has to be. #form starts `hidden`, and the
// canvas inside it is sized at parse time — so the first measurement is of a
// hidden canvas, 0 x 0, and a zero-sized element cannot be touched at all: the
// client could not draw a single stroke. size() is therefore called again the
// moment the form is revealed, which measures the real thing. Calling it twice
// is safe: size() assigns width and height, which resets the canvas transform,
// so the scale is applied once per measurement and cannot compound.
// Once the signature is recorded the client has nothing left to do, and the page
// has to say so: the note tells them the browser window can be closed, the pad is
// wiped (a signed pad still showing the stroke looks like a form that was never
// sent), and both buttons go dead. The pad also stops accepting strokes at that
// point — otherwise a client who leaves the tab open can draw a second signature
// that nothing will ever send, and reasonably conclude the first one had failed.

const token=location.pathname.split('/').filter(Boolean).pop();const $=id=>document.getElementById(id);let drawing=false,done=false,ctx=$('sig').getContext('2d');function size(){const c=$('sig'),r=c.getBoundingClientRect(),d=devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;ctx.scale(d,d);ctx.lineWidth=2;ctx.lineCap='round'}size();window.addEventListener('resize',size);function p(e){const r=$('sig').getBoundingClientRect();return{x:(e.touches?e.touches[0].clientX:e.clientX)-r.left,y:(e.touches?e.touches[0].clientY:e.clientY)-r.top}}$('sig').addEventListener('pointerdown',e=>{if(done)return;drawing=true;const q=p(e);ctx.beginPath();ctx.moveTo(q.x,q.y)});$('sig').addEventListener('pointermove',e=>{if(!drawing||done)return;const q=p(e);ctx.lineTo(q.x,q.y);ctx.stroke()});['pointerup','pointerleave'].forEach(x=>$('sig').addEventListener(x,()=>drawing=false));function clearPad(){ctx.clearRect(0,0,$('sig').width,$('sig').height)}$('clear').onclick=clearPad;async function load(){const r=await fetch('/api/sign/'+token);const d=await r.json();if(!r.ok){$('intro').textContent=d.error||'This signing link is not available.';return}$('name').textContent=d.clientName;$('intro').textContent=(d.requireDocuments?'Please upload the requested documents and sign once below.':'Please sign once below.')+' This secure link expires on '+new Date(d.expiresAt).toLocaleString()+'.';$('signer').textContent=d.signerLabel||'';$('signerRow').hidden=!d.signerLabel;if(!d.requireDocuments){var rows=document.querySelectorAll('#form .row label');for(var i=0;i<rows.length;i++){var row=rows[i].closest('.row');if(row)row.hidden=true}}$('form').hidden=false;size()}load();$('submit').onclick=async()=>{try{$('status').textContent='Uploading documents…';const fd=new FormData();[['id','ID document'],['payslip','Payslip'],['bank1','Bank statement 1'],['bank2','Bank statement 2'],['bank3','Bank statement 3']].forEach(([x,k])=>{if($(x).files[0])fd.append('documents',$(x).files[0]);});let r=await fetch('/api/sign/'+token+'/upload',{method:'POST',body:fd});let d=await r.json();if(!r.ok)throw Error(d.error);$('status').textContent='Recording signature…';r=await fetch('/api/sign/'+token+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature:$('sig').toDataURL('image/png')})});d=await r.json();if(!r.ok)throw Error(d.error);$('status').textContent=d.message;$('status').style.color='#1f6b5a';$('submit').disabled=true;$('clear').disabled=true;done=true;drawing=false;clearPad()}catch(e){$('status').textContent=e.message}}
