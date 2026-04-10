# Mercy Ships Container Tracker

A lightweight shipping container tracking dashboard built for [Mercy Ships](https://www.mercyships.org), tracking MSC containers from Houston and Rotterdam to Freetown, Sierra Leone.

**Live app:** https://mercy-ships-tracker.mercy-ships-shipping.workers.dev

---

## What it does

- Tracks up to 30 MSC containers simultaneously
- Shows current location, vessel, ETA, status, and full route
- Persists your container list between sessions (localStorage)
- Mobile-friendly card layout + desktop table view
- Links to MSC tracking and MarineTraffic for each container

## Architecture

```
Browser → Cloudflare Worker (serves HTML + /api/track)
                ↓
         Modal.com Python function (msc_proxy.py)
                ↓
         MSC Tracking API (www.msc.com)
```

**Why the proxy?** MSC's API is protected by Akamai bot detection that blocks standard HTTP clients via TLS fingerprinting. The Modal.com sidecar uses `curl_cffi` to impersonate Chrome's exact TLS handshake, which allows the API call to succeed. The Cloudflare Worker itself only serves static HTML and forwards requests to Modal.

## Files

| File | Purpose |
|---|---|
| `src/worker.js` | Cloudflare Worker — HTML frontend + `/api/track` route |
| `msc_proxy.py` | Modal.com Python function — Chrome TLS proxy to MSC API |
| `wrangler.toml` | Cloudflare Workers config |
| `package.json` | Wrangler dev dependency |

## Deployment

### Cloudflare Worker

```bash
# Requires Node.js and wrangler
npm install
npx wrangler login
npx wrangler deploy
```

### Modal Proxy

```bash
# Requires Python 3.10+ and Modal CLI
pip install modal
modal login
modal deploy msc_proxy.py
```

If you change the Modal endpoint URL, update `MODAL_URL` at the top of `src/worker.js`.

## Sample container numbers

```
MSDU6574161
SZLU9350511
MSMU4772708
SEGU9785830
TEMU9180974
MEDU9349763
MSNU2320702
```

## Built with

- [Cloudflare Workers](https://workers.cloudflare.com) — free tier, 100k requests/day
- [Modal.com](https://modal.com) — serverless Python, free tier
- [curl_cffi](https://github.com/yifeikong/curl_cffi) — Chrome TLS impersonation
- [Tailwind CSS](https://tailwindcss.com) — CDN for styling
- [Open Sans](https://fonts.google.com/specimen/Open+Sans) — Mercy Ships brand font

## Ideas for future development

- Custom domain (e.g. `tracker.mercyships.org`)
- Email or Slack alerts when container status or ETA changes
- Auto-refresh on a scheduled interval
- Support for additional carriers (Maersk, CMA CGM)

---

*Built April 2026 with [Claude Code](https://claude.ai/code)*
