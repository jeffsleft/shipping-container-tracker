"""
MSC Container Tracking Proxy
Deployed to Modal.com — called by the Cloudflare Worker.

Uses curl_cffi to impersonate Chrome's TLS fingerprint, which bypasses
MSC's Akamai bot protection that blocks standard HTTP clients.
"""

import modal

app = modal.App("msc-tracker")

image = modal.Image.debian_slim().pip_install("curl_cffi", "fastapi[standard]")

MSC_HOMEPAGE = "https://www.msc.com/en/track-a-shipment"
MSC_API = "https://www.msc.com/api/feature/tools/TrackingInfo"


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def track(containers: str) -> list:
    """
    Track one or more MSC containers.
    containers: comma-separated container numbers, e.g. MSDU6574161,SZLU9350511
    Returns: array of raw MSC API responses, one per container.
    """
    from curl_cffi.requests import Session

    container_list = [c.strip().upper() for c in containers.split(",") if c.strip()][:30]
    if not container_list:
        return []

    s = Session(impersonate="chrome124")

    # Establish a real browser session — sets Akamai cookies (ak_bmsc, etc.)
    s.get(
        MSC_HOMEPAGE,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
        },
        timeout=20,
    )

    results = []
    for container in container_list:
        try:
            r = s.post(
                MSC_API,
                json={"trackingNumber": container, "trackingMode": "0"},
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Content-Type": "application/json",
                    "Referer": MSC_HOMEPAGE,
                    "Origin": "https://www.msc.com",
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout=20,
            )
            results.append({"containerNumber": container, "mscResponse": r.json(), "success": True})
        except Exception as e:
            results.append({"containerNumber": container, "error": str(e), "success": False})

    return results
