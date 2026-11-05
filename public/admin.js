// Khusela report-bucket admin: list the applications the PWA has submitted and
// download any one of them as a PDF. Everything here is gated by the
// ADMIN_API_KEY set on this service — nothing is listed or downloaded without it,
// so a consultant's shared screen (the PWA) can never open this. The key is kept
// in sessionStorage, so it lives only in this tab and is gone when the tab closes.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY_STORE = 'khusela_admin_key';

  const keyInput = $('key');
  const unlockBtn = $('unlock');
  const lockBtn = $('lock');
  const refreshBtn = $('refresh');
  const statusEl = $('status');
  const gated = $('gated');
  const listWrap = $('listWrap');
  const listBody = $('listBody');

  const key = () => String(keyInput.value || '').trim();

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function saveKey(v) { try { sessionStorage.setItem(KEY_STORE, v); } catch (e) {} }
  function loadKey() { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function clearKey() { try { sessionStorage.removeItem(KEY_STORE); } catch (e) {} }

  function lock() {
    clearKey();
    keyInput.value = '';
    gated.hidden = false;
    listWrap.hidden = true;
    setStatus('');
    keyInput.focus();
  }

  // Every call carries the admin key as x-admin-key; the server refuses a missing
  // or wrong one with 401, which is what keeps this page private.
  function authFetch(url, opts) {
    return fetch(url, Object.assign({}, opts || {}, {
      headers: Object.assign({ 'x-admin-key': key() }, (opts && opts.headers) || {}),
    }));
  }

  async function loadSubmissions() {
    setStatus('Loading applications…');
    let res;
    try {
      res = await authFetch('/api/admin/submissions');
    } catch (e) {
      setStatus('Could not reach the office server.', 'err');
      return;
    }
    if (res.status === 401) { setStatus('That admin key was refused.', 'err'); lock(); return; }
    if (!res.ok) { setStatus('Could not load the list (HTTP ' + res.status + ').', 'err'); return; }
    const data = await res.json();
    render(data.rows || []);
    setStatus((data.rows || []).length + ' application(s) in the bucket — newest first.', 'ok');
  }

  function fmtSize(n) { return (Number(n || 0) / 1048576).toFixed(1) + ' MB'; }

  function render(rows) {
    gated.hidden = true;
    listWrap.hidden = false;
    listBody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'No applications have been submitted yet.';
      tr.appendChild(td);
      listBody.appendChild(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = r.applicant || '(no name)';
      tr.appendChild(nameTd);

      const idTd = document.createElement('td');
      idTd.textContent = r.id_number || '';
      tr.appendChild(idTd);

      const signerTd = document.createElement('td');
      signerTd.textContent = r.signer_label || '';
      tr.appendChild(signerTd);

      const appDateTd = document.createElement('td');
      appDateTd.textContent = r.app_date || '';
      tr.appendChild(appDateTd);

      const whenTd = document.createElement('td');
      whenTd.textContent = r.created_at ? r.created_at.slice(0, 16).replace('T', ' ') : '';
      tr.appendChild(whenTd);

      const sizeTd = document.createElement('td');
      sizeTd.textContent = fmtSize(r.size);
      tr.appendChild(sizeTd);

      const stateTd = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge ' + (r.email_status || '');
      badge.textContent = {
        pending: 'sending…',
        sent: 'emailed',
        not_configured: 'not emailed (no delivery set up)',
        failed: 'not emailed (failed)',
      }[r.email_status] || (r.email_status || '');
      stateTd.appendChild(badge);
      tr.appendChild(stateTd);

      const dlTd = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = 'Download PDF';
      btn.className = 'secondary';
      btn.addEventListener('click', () => download(r.id, r.filename));
      dlTd.appendChild(btn);
      // A report that never made it out can be pushed out again once delivery is
      // configured — the "fallback after the backup".
      if (r.email_status !== 'sent') {
        const reBtn = document.createElement('button');
        reBtn.textContent = 'Resend';
        reBtn.className = 'primary';
        reBtn.style.marginLeft = '6px';
        reBtn.addEventListener('click', () => resend(r.id, r.applicant || r.filename));
        dlTd.appendChild(reBtn);
      }
      tr.appendChild(dlTd);

      listBody.appendChild(tr);
    });
  }

  async function download(id, filename) {
    setStatus('Downloading…');
    let res;
    try {
      res = await authFetch('/api/admin/submissions/' + encodeURIComponent(id) + '/pdf');
    } catch (e) {
      setStatus('Could not reach the office server.', 'err');
      return;
    }
    if (res.status === 401) { setStatus('That admin key was refused.', 'err'); lock(); return; }
    if (!res.ok) { setStatus('Could not download the PDF (HTTP ' + res.status + ').', 'err'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'application.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus('Downloaded ' + (filename || 'application.pdf') + '.', 'ok');
  }

  async function resend(id, label) {
    setStatus('Resending ' + (label || 'application') + '…');
    let res;
    try {
      res = await authFetch('/api/admin/submissions/' + encodeURIComponent(id) + '/resend', { method: 'POST' });
    } catch (e) {
      setStatus('Could not reach the office server.', 'err');
      return;
    }
    if (res.status === 401) { setStatus('That admin key was refused.', 'err'); lock(); return; }
    if (res.status === 503) { setStatus('Delivery is not configured yet — set BREVO_API_KEY, FORMSPREE_ENDPOINT or SMTP first.', 'err'); return; }
    if (!res.ok) { setStatus('Resend failed (HTTP ' + res.status + ').', 'err'); return; }
    setStatus('Resent — ' + (label || 'application') + ' has been emailed. Refreshing…', 'ok');
    loadSubmissions();
  }

  unlockBtn.addEventListener('click', async () => {
    if (!key()) { setStatus('Paste the admin key first.', 'err'); return; }
    setStatus('Checking…');
    let res;
    try {
      res = await authFetch('/api/admin/submissions');
    } catch (e) {
      setStatus('Could not reach the office server.', 'err');
      return;
    }
    if (res.status === 401) { setStatus('That admin key was refused.', 'err'); return; }
    if (!res.ok) { setStatus('Could not reach the bucket (HTTP ' + res.status + ').', 'err'); return; }
    saveKey(key());
    const data = await res.json();
    render(data.rows || []);
    setStatus((data.rows || []).length + ' application(s) in the bucket — newest first.', 'ok');
  });

  lockBtn.addEventListener('click', lock);
  refreshBtn.addEventListener('click', loadSubmissions);
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockBtn.click(); });

  // A key already in this tab is used straight away; otherwise the gate is shown.
  const saved = loadKey();
  if (saved) {
    keyInput.value = saved;
    gated.hidden = true;
    listWrap.hidden = false;
    loadSubmissions();
  } else {
    gated.hidden = false;
    listWrap.hidden = true;
    keyInput.focus();
  }
})();
