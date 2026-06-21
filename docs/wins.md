# Shipping Container Tracker — Wins

A running record of what shipped, what worked, and the story arc. For roll-up and career storytelling later.

---

## The Project

Shipping container tracking dashboard for the Mercy Ships logistics team. Tracks MSC containers from Houston and Rotterdam to Freetown, Sierra Leone. Shared container list across all authenticated users; mobile-friendly card + desktop table view. Live at shipping-container-tracker.confluence-ops.workers.dev.

---

## Wins

### Production Support & Hardening (2026-06-01)
- Diagnosed and fixed a live production bug affecting the Mercy Ships logistics team — containers couldn't be marked as received; traced root cause to comma-separated input being stored as a single KV entry
- Repaired KV data directly via wrangler without downtime; 6 containers restored to individually-trackable state
- Hardened the add handler to parse comma-separated input correctly — users can now paste a list of container numbers and each is added individually
- Improved error UX: failure alerts now show the actual server error, not a generic message
- Eliminated unnecessary full MSC re-fetches on remove and receive — UI now updates instantly instead of waiting on Modal cold start

### Initial Build (2026-05-14 session)
- Shipped a working container tracker for a real operational team on a hospital ship
- Solved the Akamai bot-detection problem: Cloudflare Worker can't impersonate TLS handshakes, so the Worker delegates the MSC API call to a Modal Python sidecar using `curl_cffi` with Chrome TLS impersonation — the standard Worker-→-Modal architecture applied to a non-obvious problem
- Shared container list in KV: any authenticated user adds/removes from the same list — matches the Mercy Ships logistics team's actual workflow (not per-user silos)
- 30-container cap per request keeps Modal costs predictable and cold-start times manageable
- Zero external dependencies in the Worker — all HTML, CSS, JS, and API routes in a single `worker.js` file

### Architecture Proof Point
- This is a clean example of the Cloudflare Worker → Modal Python pattern applied to a real constraint: a public-facing API behind enterprise bot detection that blocks any standard HTTP client. The solution required routing through two layers (Worker for auth/HTML, Modal for TLS fingerprinting) with no workarounds.

---

## The "So What"

Built operational tooling for a real logistics team — deployed to production, in active use — that solved a technically non-trivial problem (TLS fingerprint bypass) without overcomplicating the architecture. The Mercy Ships logistics team can now track container shipments without needing direct MSC portal access.
