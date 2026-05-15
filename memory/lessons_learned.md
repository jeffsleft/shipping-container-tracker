# Lessons Learned

Technical failures and their resolutions, per AI_RULES §4. Append new entries at the top.

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
