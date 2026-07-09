# Lessons Learned

Technical failures and their resolutions, per AI_RULES §4. Append new entries at the top.

---

## 2026-07-09 — "Delivered" container rendered in the "In Transit" section

**Problem:** MSDU9740543 showed a "Delivered" badge but sat in the "In Transit" section. Any delivered container hit this.

**Root cause:** Status was derived in two independent places that drifted apart. `statusBadge()` knew about MSC's `Delivered: true` flag and rendered "Delivered"; `classifyStatus()` did not — it only bucketed on the status *text* (`discharg`/`import`/`arriv`), so "Delivered" fell through to the default `transit` bucket. Badge and section disagreed.

**Resolution:** Added `if (r.delivered) return 'port';` to `classifyStatus()` (delivered = at/past destination port) and a green "Delivered" badge to `statusBadge()`. Both now consult the `delivered` boolean.

**Also confirmed (not a bug):** Same container's destination read as "Las Palmas, ES", not Freetown. That is correct — it's MSC's actual `PortOfDischarge` for that bill of lading (Houston → Valencia transship → Las Palmas, delivered to consignee). The app reads per-container destination from `gi.PortOfDischarge`; the "Freetown" in the header is a cosmetic app-level label only.

**Future agents:** Keep `classifyStatus()` and `statusBadge()` in sync — if you add a status either function recognizes, teach both. They independently classify the same MSC response and will silently contradict each other otherwise.

---

## 2026-06-01 — Comma-separated input stored as single KV entry, breaking receive/remove

**Problem:** Users pasted multiple container numbers separated by commas into the add form (e.g. `MSDU9858243, CAAU8066791`). The add handler accepted the entire string as one container number. MSC's tracking API happens to split on commas internally, so all containers appeared correctly in the UI — but `handleReceive` and `handleListDelete` do exact-string lookups, so neither could find individual numbers like `MSDU9858243`. Both silently "succeeded" (remove returned 200 even though nothing was deleted) while nothing actually changed.

**Diagnosis path:** Generic "Failed to mark as received" alert gave no clue. Added detailed error reporting → saw "Container not found in tracker list: CAAU8066791" → read raw KV via `npx wrangler kv key get --remote "containers"` → found the comma-string entries immediately.

**Resolution:**
1. Fixed KV data directly via wrangler kv put, splitting the two bad entries into 6 individual clean entries.
2. Updated `handleListPost` to split on commas and add each number individually. Users can now paste comma-separated lists and they work correctly.
3. Added `/api/debug` endpoint (passcode-gated) that exposes raw KV container data for future diagnostics.

**Future agents:**
- Always add `--remote` flag when reading/writing production KV via wrangler — without it, wrangler reads a local preview namespace that appears empty.
- When a remove "succeeds" but the container stays visible after refresh, suspect a lookup mismatch (exact string match failed silently).
- The `/api/debug` endpoint is the fastest way to inspect raw KV state without going to the Cloudflare dashboard.

---

## 2026-06-01 — Full MSC re-fetch triggered on every remove and receive action

**Problem:** After marking a container received or removing one, the app called `trackAll()` — which re-fetches all active containers from MSC, waits for Modal cold start, and re-renders everything. For a remove or receive, the new state is already known locally; there's no reason to hit MSC again.

**Resolution:** Replaced `trackAll()` calls in `removeContainer()` and `confirmReceived()` with local state updates: mutate `lastResults` (delete the entry or set `received: true`), then call `renderResults(Object.values(lastResults))`. The UI updates instantly.

**Future agents:** `trackAll()` is the right call after adding a new container (need MSC data) or on the auto-refresh timer. It's wrong after remove/receive where the new state is already known.

---

## 2026-05-15 — curl_cffi CVE-2026-33752 (SSRF)

**Problem:** `curl_cffi <0.15.0` does not restrict redirects to internal IP ranges, enabling redirect-based SSRF (CVSS 8.6). The proxy was pinned to unversioned `curl_cffi` in the Modal image.

**Actual exposure:** Zero. The proxy never passes user-supplied URLs to `curl_cffi` — only the hardcoded `MSC_HOMEPAGE` and `MSC_API` constants. SSRF requires attacker-controlled URLs reaching the vulnerable library.

**Why it still matters:** Once this repo flipped public, any code scanner pointed at it flagged the vulnerability. Even a theoretical CVE in a public repo looks bad to recruiters and security tooling.

**Resolution:** Pinned `curl_cffi>=0.15.0` in `msc_proxy.py:13`, redeployed to Modal, pushed to GitHub. Verified live function smoke test still works (real container lookup returned full tracking data).

**Future agents:** Don't relax this pin. The CVE is real; defense-in-depth beats arguing about exposure on a public repo.

---

## 2026-04-XX — Why a Python proxy at all (architectural rationale)

**Problem:** Initial design tried to call MSC's tracking API directly from a Cloudflare Worker (`fetch` from inside the Worker runtime). Got 403s every time.

**Root cause:** MSC's API sits behind Akamai bot detection that fingerprints TLS handshakes. Cloudflare Workers run on the Cloudflare edge runtime — they can't impersonate a real Chrome TLS fingerprint. Standard HTTP clients (including the Worker's `fetch`) get fingerprinted as bots and 403'd.

**Resolution:** Added Modal Python sidecar with `curl_cffi` and `impersonate="chrome124"`. Worker now delegates the actual MSC call to Modal. Modal returns the JSON; Worker parses and serves to the browser.

**Future agents:** If you're tempted to "simplify" by removing the Modal proxy, don't. The TLS-fingerprinting requirement is structural, not optional.
