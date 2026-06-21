# Shipping Container Tracker — Project Instructions

## What This Is

A lightweight shipping container tracking dashboard. Tracks MSC containers from Houston and Rotterdam to Freetown, Sierra Leone. Shared container list across all users; mobile-friendly card + desktop table view.

**Live app:** https://shipping-container-tracker.confluence-ops.workers.dev

## Architecture

```
Browser  →  Cloudflare Worker (HTML + /api/track)  →  Modal Python (msc_proxy.py)  →  MSC Tracking API
```

This follows the canonical pattern in AI_RULES §3 and §5: Cloudflare Worker for routing/HTML/auth, Modal Python for the work that needs native deps.

## File Layout

- `src/worker.js` — Cloudflare Worker: HTML frontend + `/api/track` route + KV helpers + MSC response parser
- `msc_proxy.py` — Modal function: Chrome TLS proxy that calls the MSC API
- `wrangler.toml` — Worker config + KV binding
- `package.json` — Wrangler dev dependency only (no runtime deps)
- `README.md` — public-facing description

## Project-Specific Decisions

1. **Why a Python proxy at all?** MSC's API sits behind Akamai bot detection that blocks any client without a real Chrome TLS fingerprint. Cloudflare Workers can't impersonate TLS handshakes — only a native HTTP client like `curl_cffi` can. So the Worker delegates the actual MSC call to Modal. See AI_RULES §2 for the TLS-fingerprinting rule.
2. **Shared container list, not per-user.** Stored in KV (`TRACKER_KV`) under a single key. Any authenticated user adds/removes from the same list. Matches the logistics team's actual workflow.
3. **30 container max per request.** Hard cap in `msc_proxy.py:29` to prevent runaway Modal cost and stay inside reasonable Modal cold-start time budgets.
4. **`chrome124` impersonation pinned.** Newer Chrome versions in `curl_cffi` sometimes get blocked by Akamai while older ones still pass. Keep `chrome124` until a regression forces an update.

## Secrets

- **Worker:** `env.PASSCODE` (gates all `/api/*` routes, set via `wrangler secret put PASSCODE`)
- **Modal:** none (the function only calls the public MSC API; no API key needed)

## Endpoints

- **Worker:** https://shipping-container-tracker.confluence-ops.workers.dev
- **Modal:** https://jeffsleft--msc-tracker-track.modal.run (referenced as `MODAL_URL` in `src/worker.js:9`)

## KV Bindings

- `TRACKER_KV` (id `8be56545389845049a7d16faff15ffd0`) — stores `containers`, `ports`, `vessels` keys

## Deployment

```bash
# Cloudflare Worker
npx wrangler deploy

# Modal proxy
modal deploy msc_proxy.py
```

If the Modal endpoint URL changes, update `MODAL_URL` at the top of `src/worker.js` and redeploy the Worker.

## Gotchas

- **`curl_cffi` pin matters.** Must be `>=0.15.0` to avoid CVE-2026-33752. The version is pinned in `msc_proxy.py:13`. Don't relax this.
- **MSC response shape is fragile.** The parser in `worker.js` (`parseMSCResponse`) walks several nested structures (`BillOfLadings[0]`, `ContainersInfo[0]`, `Events`). If MSC changes their API response shape, the parser silently returns `{ success: false }` rather than throwing — check Worker logs when tracking suddenly returns "Container not found" for known-valid containers.
- **HANDOFF.md, IMPLEMENTATION_SUMMARY.md, features.json are gitignored** — session-internal docs, not for the public repo.
