// Khusela — Vicidial bridge as a Cloudflare Worker (free, always on, stable URL).
//
// Deploy this file as a Worker and set these Worker variables/secrets:
//   BRIDGE_KEY                 same value as VICIDIAL_BRIDGE_KEY on Render
//   VICIDIAL_BASE_URL          https://kdebt.dialer.co.za
//   VICIDIAL_API_PATH          /vicidial/non_agent_api.php
//   VICIDIAL_API_USER          6666
//   VICIDIAL_API_PASS          your Vicidial password
//   VICIDIAL_RECORDINGS_USER   optional basic auth for /RECORDINGS/ (usually blank)
//   VICIDIAL_RECORDINGS_PASS   optional
//
// Then on Render set:
//   VICIDIAL_BRIDGE_URL = https://<your-worker>.<your-subdomain>.workers.dev
//   VICIDIAL_BRIDGE_KEY = the same BRIDGE_KEY
//
// It exposes only two read-only routes and refuses anything without the key.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function fetchTimeout(url, options = {}, ms = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'khusela-vicidial-bridge' });
    }

    if (request.headers.get('x-bridge-key') !== (env.BRIDGE_KEY || '')) {
      return json({ error: 'bad bridge key' }, 401);
    }

    try {
      if (url.pathname === '/lookup') {
        const agent = url.searchParams.get('agent') || '';
        const date = url.searchParams.get('date') || '';
        if (!/^[A-Za-z0-9_-]{2,40}$/.test(agent) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({ error: 'bad agent or date' }, 400);
        }
        const raw = /^https?:\/\//i.test(env.VICIDIAL_BASE_URL)
          ? env.VICIDIAL_BASE_URL
          : 'https://' + env.VICIDIAL_BASE_URL;
        const api = new URL(raw.replace(/\/+$/, '') + (env.VICIDIAL_API_PATH || '/vicidial/non_agent_api.php'));
        api.searchParams.set('source', 'khusela-worker-bridge');
        api.searchParams.set('user', env.VICIDIAL_API_USER || '');
        api.searchParams.set('pass', env.VICIDIAL_API_PASS || '');
        api.searchParams.set('function', 'recording_lookup');
        api.searchParams.set('agent_user', agent);
        api.searchParams.set('date', date);
        api.searchParams.set('stage', 'pipe');
        api.searchParams.set('duration', 'Y');
        api.searchParams.set('header', 'NO');
        const res = await fetchTimeout(api.toString());
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      if (url.pathname === '/audio') {
        const location = url.searchParams.get('location') || '';
        let target;
        try { target = new URL(location); } catch (e) { return json({ error: 'bad location' }, 400); }
        const path = target.pathname.toUpperCase();
        if (!/^https?:$/.test(target.protocol) || path.indexOf('/RECORDINGS/') !== 0 || !/\.(mp3|wav)$/i.test(target.pathname)) {
          return json({ error: 'location not allowed' }, 400);
        }
        const headers = {};
        if (env.VICIDIAL_RECORDINGS_USER) {
          headers.Authorization = 'Basic ' + btoa(env.VICIDIAL_RECORDINGS_USER + ':' + (env.VICIDIAL_RECORDINGS_PASS || ''));
        }
        const res = await fetchTimeout(target.toString(), { headers });
        if (!res.ok) return json({ error: 'Vicidial did not provide the recording (HTTP ' + res.status + ')' }, 502);
        return new Response(res.body, {
          status: 200,
          headers: {
            'content-type': /\.wav$/i.test(target.pathname) ? 'audio/wav' : 'audio/mpeg',
            'cache-control': 'no-store',
          },
        });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'bridge could not reach Vicidial: ' + (e && e.message ? e.message : e) }, 502);
    }
  },
};
