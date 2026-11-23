# Vicidial bridge — Cloudflare Worker (free, no PC)

This replaces the office-PC bridge. It gives a **stable URL** and needs no machine
running at your office. The Worker only exposes two read-only routes (`/lookup` and
`/audio`) and refuses anything without `x-bridge-key`.

## 1. Create the Worker (free, ~5 minutes)
1. Sign in / sign up at https://dash.cloudflare.com (free account).
2. Go to **Workers & Pages → Create → Worker**.
3. Name it `khusela-vicidial-bridge` → **Deploy**.
4. Click **Edit code**, delete the sample, paste the contents of
   `vicidial-bridge.js`, then **Deploy**.
5. Note your URL: `https://khusela-vicidial-bridge.<your-subdomain>.workers.dev`
   (the first Worker asks you to choose a workers.dev subdomain).

## 2. Add the settings
Worker → **Settings → Variables and Secrets** → add:

| Name | Type | Value |
| --- | --- | --- |
| `BRIDGE_KEY` | Secret | `IZdduSz68lgAciwC0TfbWX87cOXkQQ4U` |
| `VICIDIAL_BASE_URL` | Text | `https://kdebt.dialer.co.za` |
| `VICIDIAL_API_PATH` | Text | `/vicidial/non_agent_api.php` |
| `VICIDIAL_API_USER` | Text | `6666` |
| `VICIDIAL_API_PASS` | Secret | your Vicidial password |
| `VICIDIAL_RECORDINGS_USER` | Secret | leave blank unless /RECORDINGS/ needs a password |
| `VICIDIAL_RECORDINGS_PASS` | Secret | leave blank unless needed |

Then **Deploy** again.

## 3. Point Render at it
In Render → Environment:

| Key | Value |
| --- | --- |
| `VICIDIAL_BRIDGE_URL` | `https://khusela-vicidial-bridge.<your-subdomain>.workers.dev` |
| `VICIDIAL_BRIDGE_KEY` | `IZdduSz68lgAciwC0TfbWX87cOXkQQ4U` |

Redeploy Render.

## 4. Test
Open this in a browser (replace the host):

```
https://khusela-vicidial-bridge.<your-subdomain>.workers.dev/health
```

It should answer `{"ok":true,...}`. Then the app's **Find recordings** should work
without your PC being on.

## If it fails
The dialer may block Cloudflare's IPs the same way it blocked Render's. In that
case the Worker is not usable and we keep the office-PC bridge instead.
