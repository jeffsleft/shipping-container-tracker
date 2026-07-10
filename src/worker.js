/**
 * Shipping Container Tracker
 * Cloudflare Worker — serves HTML frontend and proxies to Modal.com MSC tracker
 *
 * Storage: Cloudflare KV (TRACKER_KV binding) — shared container list for all users
 * Auth: PASSCODE Worker secret gates all API access (read and write)
 */

const MODAL_URL = 'https://jeffsleft--msc-tracker-track.modal.run';

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkPasscode(request, env) {
  return request.headers.get('X-Passcode') === env.PASSCODE;
}

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function getContainers(env) {
  const raw = await env.TRACKER_KV.get('containers');
  return raw ? JSON.parse(raw) : [];
}

async function saveContainers(env, list) {
  await env.TRACKER_KV.put('containers', JSON.stringify(list));
}

async function getPorts(env) {
  const raw = await env.TRACKER_KV.get('ports');
  if (raw) return JSON.parse(raw);
  const defaultPorts = [
    { id: 'USHOU', name: 'Houston, United States', country: 'US' },
    { id: 'BSFRP', name: 'Freeport, Grand Bahama', country: 'BS' },
    { id: 'GHTEM', name: 'Tema, Ghana', country: 'GH' },
    { id: 'TGLFW', name: 'Lome, Togo', country: 'TG' },
    { id: 'SLFNT', name: 'Freetown, Sierra Leone', country: 'SL' },
    { id: 'BEANR', name: 'Antwerp, Belgium', country: 'BE' },
    { id: 'CIABJ', name: 'Abidjan, Cote d\'Ivoire', country: 'CI' },
    { id: 'NLRTM', name: 'Rotterdam, Netherlands', country: 'NL' },
    { id: 'ESPLM', name: 'Las Palmas, Gran Canaria', country: 'ES' },
    { id: 'SNDAK', name: 'Dakar, Senegal', country: 'SN' },
  ];
  await env.TRACKER_KV.put('ports', JSON.stringify(defaultPorts));
  return defaultPorts;
}

async function savePorts(env, ports) {
  await env.TRACKER_KV.put('ports', JSON.stringify(ports));
}

async function getCurrentPort(env) {
  const raw = await env.TRACKER_KV.get('currentPort');
  return raw ? JSON.parse(raw) : null;
}

async function saveCurrentPort(env, port) {
  await env.TRACKER_KV.put('currentPort', JSON.stringify(port));
}

// ─── MSC Response Parser ──────────────────────────────────────────────────────

function parseMSCResponse(data, requestedContainer) {
  if (!data || !data.IsSuccess || !data.Data) {
    return { success: false, error: 'Container not found or tracking unavailable' };
  }

  const d = data.Data;
  const bl = d.BillOfLadings && d.BillOfLadings[0];
  if (!bl) return { success: false, error: 'No bill of lading data returned' };

  const gi = bl.GeneralTrackingInfo || {};
  const ci = (bl.ContainersInfo && bl.ContainersInfo[0]) || {};
  const events = ci.Events || [];
  const latest = events[0] || {};

  const actualEvent = events.find(function(e) {
    const desc = (e.Description || '').toLowerCase();
    return !desc.includes('estimated') && !desc.includes('intended');
  }) || latest;

  // Find a real (non-estimated) event date at a given port, matched by keyword.
  // pickLast=true returns the earliest match (origin load); false returns the latest (POD discharge).
  function eventDateAt(portStr, keywords, pickLast) {
    if (!portStr) return '';
    const portKey = portStr.split(',')[0].trim().toLowerCase();
    if (!portKey) return '';
    const matches = events.filter(function(e) {
      const loc = (e.Location || '').toLowerCase();
      const desc = (e.Description || '').toLowerCase();
      if (desc.includes('estimated') || desc.includes('intended')) return false;
      if (loc.indexOf(portKey) === -1) return false;
      return keywords.some(function(k) { return desc.indexOf(k) !== -1; });
    });
    if (!matches.length) return '';
    return (pickLast ? matches[matches.length - 1] : matches[0]).Date || '';
  }

  const portOfLoad = gi.PortOfLoad || gi.ShippedFrom || '';
  const portOfDischarge = gi.PortOfDischarge || gi.ShippedTo || '';
  const loadKey = portOfLoad.toLowerCase();
  const originPort = loadKey.includes('houston') ? 'Houston'
    : (loadKey.includes('rotterdam') ? 'Rotterdam' : (portOfLoad.split(',')[0].trim() || ''));
  const loadedDate = eventDateAt(portOfLoad, ['load', 'depart', 'sail'], true);
  const dischargedDate = eventDateAt(portOfDischarge, ['discharg', 'import'], false);

  return {
    success: true,
    containerNumber: ci.ContainerNumber || requestedContainer,
    containerType: ci.ContainerType || '',
    billOfLading: bl.BillOfLadingNumber || '',
    delivered: ci.Delivered === true,
    status: ci.Delivered ? 'Delivered' : (actualEvent.Description || latest.Description || 'Unknown'),
    latestMove: ci.LatestMove || '',
    currentLocation: ci.LatestMove || actualEvent.Location || '',
    currentLocationCode: actualEvent.UnLocationCode || '',
    lastEventDate: actualEvent.Date || '',
    vessel: (latest.Detail && latest.Detail[0]) || '',
    voyage: (latest.Detail && latest.Detail[1]) || '',
    vesselIMO: (latest.Vessel && latest.Vessel.IMO) || '',
    portOfLoad: portOfLoad,
    portOfDischarge: portOfDischarge,
    originPort: originPort,
    destPort: portOfDischarge.split(',')[0].trim(),
    loadedDate: loadedDate,
    dischargedDate: dischargedDate,
    transshipments: gi.Transshipments || [],
    podEtaDate: ci.PodEtaDate || gi.FinalPodEtaDate || '',
    eventHistory: events.slice(0, 8).map(function(e) {
      return {
        date: e.Date,
        location: e.Location,
        description: e.Description,
        vessel: (e.Detail && e.Detail[0]) || '',
        voyage: (e.Detail && e.Detail[1]) || '',
      };
    }),
    asOf: d.TrackingResultsLabel || '',
  };
}

// ─── Route: GET /api/list ─────────────────────────────────────────────────────

async function handleListGet(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  const containers = await getContainers(env);
  return Response.json(containers);
}

// ─── Route: POST /api/list ────────────────────────────────────────────────────

async function handleListPost(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch(e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Parse comma-separated input — prevents multi-number strings from being stored as one entry.
  // Container numbers are strictly alphanumeric (ISO 6346); stripping anything else
  // keeps stored numbers safe to embed in the UI's inline onclick handlers.
  const numbers = (body.number || '').split(',').map(function(n) { return n.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }).filter(Boolean);
  if (!numbers.length) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  const today = new Date().toISOString().slice(0, 10);
  const added = [], duplicates = [];

  numbers.forEach(function(number) {
    const existing = containers.find(function(c) { return c.number === number && !c.received; });
    if (existing) {
      duplicates.push({ number: existing.number, addedAt: existing.addedAt, shipmentId: existing.shipmentId });
    } else {
      containers.push({ number: number, addedAt: today, originalEta: null, received: false, receivedAt: null, shipmentId: null, location: 'In Transit', receivedPort: null });
      added.push(number);
    }
  });

  if (added.length === 0 && duplicates.length === 1) {
    return Response.json({ error: 'Container already in list', existingContainer: duplicates[0] }, { status: 409 });
  }

  if (added.length > 0) await saveContainers(env, containers);
  return Response.json({ success: true, added: added, duplicates: duplicates });
}

// ─── Route: DELETE /api/list ──────────────────────────────────────────────────

async function handleListDelete(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  const url = new URL(request.url);
  const number = (url.searchParams.get('number') || '').trim().toUpperCase();
  if (!number) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  await saveContainers(env, containers.filter(function(c) { return c.number !== number; }));
  return Response.json({ success: true });
}

// ─── Route: POST /api/receive ─────────────────────────────────────────────────

async function handleReceive(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch(e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const number = (body.number || '').trim().toUpperCase();
  const receivedAt = body.receivedAt || new Date().toISOString().slice(0, 10);
  const receivedPort = body.receivedPort || null;
  if (!number) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  const c = containers.find(function(c) { return c.number && c.number.trim().toUpperCase() === number; });
  if (!c) return Response.json({ error: 'Container not found in tracker list: ' + number }, { status: 404 });

  c.received = true;
  c.receivedAt = receivedAt;
  c.receivedPort = receivedPort;
  await saveContainers(env, containers);
  return Response.json({ success: true });
}

// ─── Route: POST /api/shipment ───────────────────────────────────────────────

async function handleShipment(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch(e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const number = (body.number || '').trim().toUpperCase();
  const shipmentId = (body.shipmentId || '').trim();
  if (!number) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  const c = containers.find(function(c) { return c.number === number; });
  if (!c) return Response.json({ error: 'Container not found' }, { status: 404 });

  c.shipmentId = shipmentId || null;
  await saveContainers(env, containers);
  return Response.json({ success: true });
}

// ─── Route: GET/POST /api/ports ───────────────────────────────────────────────

async function handlePorts(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  if (request.method === 'GET') {
    const ports = await getPorts(env);
    return Response.json(ports);
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch(e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    // UNLOCODEs are strictly alphanumeric — sanitized so port ids are safe in inline onclick handlers
    const id = (body.id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = (body.name || '').trim();
    const country = (body.country || '').trim();
    if (!id || !name) return Response.json({ error: 'Port id and name required' }, { status: 400 });

    const ports = await getPorts(env);
    if (ports.find(function(p) { return p.id === id; })) {
      return Response.json({ error: 'Port already exists' }, { status: 409 });
    }
    ports.push({ id: id, name: name, country: country });
    await savePorts(env, ports);
    return Response.json({ success: true, port: { id: id, name: name, country: country } });
  }
  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || '').trim().toUpperCase();
    if (!id) return Response.json({ error: 'Port id required' }, { status: 400 });
    const ports = await getPorts(env);
    const filtered = ports.filter(function(p) { return p.id !== id; });
    if (filtered.length === ports.length) return Response.json({ error: 'Port not found' }, { status: 404 });
    await savePorts(env, filtered);
    return Response.json({ success: true });
  }
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ─── Route: GET/PUT /api/current-port ─────────────────────────────────────────

async function handleCurrentPort(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  if (request.method === 'GET') {
    const port = await getCurrentPort(env);
    return Response.json({ port });
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch(e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const portId = (body.portId || '').trim().toUpperCase();
    if (!portId) {
      await saveCurrentPort(env, null);
      return Response.json({ success: true, port: null });
    }
    const ports = await getPorts(env);
    const port = ports.find(function(p) { return p.id === portId; });
    if (!port) return Response.json({ error: 'Port not found' }, { status: 404 });
    await saveCurrentPort(env, port);
    return Response.json({ success: true, port });
  }
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ─── Route: GET /api/track ────────────────────────────────────────────────────

async function handleTrackRequest(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();

  const storedList = await getContainers(env);
  const active = storedList.filter(function(c) { return !c.received; });
  const received = storedList.filter(function(c) { return c.received; });

  const receivedResults = received.map(function(c) {
    return {
      success: true, containerNumber: c.number, received: true,
      receivedAt: c.receivedAt, originalEta: c.originalEta, addedAt: c.addedAt, status: 'Received',
      shipmentId: c.shipmentId || null,
      receivedPort: c.receivedPort || null,
      originPort: c.originPort || null,
      destPort: c.destPort || null,
      loadedAt: c.loadedAt || null,
      dischargedAt: c.dischargedAt || null,
    };
  });

  if (active.length === 0) {
    return Response.json(receivedResults, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  let modalResults;
  try {
    // The Modal proxy caps each request at 30 containers and silently drops the
    // rest — chunk here so containers beyond 30 still get tracked.
    const chunks = [];
    for (let i = 0; i < active.length; i += 30) chunks.push(active.slice(i, i + 30));
    const responses = await Promise.all(chunks.map(function(chunk) {
      return fetch(
        MODAL_URL + '?containers=' + encodeURIComponent(chunk.map(function(c) { return c.number; }).join(',')),
        { headers: { 'Accept': 'application/json' } }
      ).then(function(res) {
        if (!res.ok) throw new Error('Proxy error: HTTP ' + res.status);
        return res.json();
      });
    }));
    modalResults = responses.flat();
  } catch (err) {
    const errorResults = active.map(function(c) {
      return { success: false, containerNumber: c.number, error: 'Tracking service error: ' + err.message };
    });
    return Response.json(errorResults.concat(receivedResults), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  let needsKvUpdate = false;
  const activeResults = modalResults.map(function(item) {
    if (!item.success) {
      return { success: false, containerNumber: item.containerNumber, error: item.error || 'Unknown error' };
    }
    const parsed = parseMSCResponse(item.mscResponse, item.containerNumber);
    const kvEntry = storedList.find(function(c) { return c.number === item.containerNumber; });

    if (kvEntry && kvEntry.originalEta === null && parsed.podEtaDate) {
      kvEntry.originalEta = parsed.podEtaDate;
      needsKvUpdate = true;
    }
    // Capture-once: origin, load date, and discharge date persist before the box is received.
    if (kvEntry) {
      if (!kvEntry.originPort && parsed.originPort) { kvEntry.originPort = parsed.originPort; needsKvUpdate = true; }
      if (!kvEntry.destPort && parsed.destPort) { kvEntry.destPort = parsed.destPort; needsKvUpdate = true; }
      if (!kvEntry.loadedAt && parsed.loadedDate) { kvEntry.loadedAt = parsed.loadedDate; needsKvUpdate = true; }
      if (!kvEntry.dischargedAt && parsed.dischargedDate) { kvEntry.dischargedAt = parsed.dischargedDate; needsKvUpdate = true; }
    }

    return Object.assign({}, parsed, {
      containerNumber: item.containerNumber,
      received: false,
      originalEta: kvEntry ? kvEntry.originalEta : null,
      addedAt: kvEntry ? kvEntry.addedAt : null,
      shipmentId: kvEntry ? (kvEntry.shipmentId || null) : null,
      originPort: kvEntry ? (kvEntry.originPort || parsed.originPort || null) : (parsed.originPort || null),
      destPort: kvEntry ? (kvEntry.destPort || parsed.destPort || null) : (parsed.destPort || null),
      loadedAt: kvEntry ? (kvEntry.loadedAt || parsed.loadedDate || null) : (parsed.loadedDate || null),
      dischargedAt: kvEntry ? (kvEntry.dischargedAt || parsed.dischargedDate || null) : (parsed.dischargedDate || null),
    });
  });

  if (needsKvUpdate) {
    // Re-read before write-back: the Modal round trip takes 10-20s, and saving
    // the list read before it would overwrite any add/receive made in between.
    // Merge only the captured fields into the fresh list.
    const fresh = await getContainers(env);
    storedList.forEach(function(stale) {
      const f = fresh.find(function(c) { return c.number === stale.number && c.addedAt === stale.addedAt; });
      if (!f) return;
      ['originalEta', 'originPort', 'destPort', 'loadedAt', 'dischargedAt'].forEach(function(k) {
        if (!f[k] && stale[k]) f[k] = stale[k];
      });
    });
    await saveContainers(env, fresh);
  }

  return Response.json(activeResults.concat(receivedResults), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── Canary: daily MSC lookup health check ───────────────────────────────────
// The whole system depends on the Modal proxy's Chrome TLS impersonation
// continuing to pass MSC's Akamai bot detection. When that breaks, tracking
// fails silently ("Container not found" for every box). The canary tracks up
// to 3 known containers daily and records pass/fail so the UI can warn.

async function runCanary(env) {
  const status = { lastRun: new Date().toISOString(), ok: true, detail: '' };
  try {
    const containers = await getContainers(env);
    const active = containers.filter(function(c) { return !c.received; }).slice(0, 3);
    if (active.length === 0) {
      status.detail = 'No active containers to check';
    } else {
      const res = await fetch(
        MODAL_URL + '?containers=' + encodeURIComponent(active.map(function(c) { return c.number; }).join(',')),
        { headers: { 'Accept': 'application/json' } }
      );
      if (!res.ok) throw new Error('Proxy HTTP ' + res.status);
      const results = await res.json();
      const anyParsed = results.some(function(item) {
        return item.success && parseMSCResponse(item.mscResponse, item.containerNumber).success;
      });
      if (!anyParsed) {
        throw new Error('MSC returned no usable data for ' + active.length + ' known container(s) — likely Akamai block or MSC API change');
      }
      status.detail = 'OK (' + active.length + ' container(s) checked)';
    }
  } catch (err) {
    status.ok = false;
    status.detail = err.message;
  }
  await env.TRACKER_KV.put('canaryStatus', JSON.stringify(status));
  return status;
}

// ─── Route: GET /api/canary ───────────────────────────────────────────────────

async function handleCanaryGet(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  const raw = await env.TRACKER_KV.get('canaryStatus');
  return Response.json(raw ? JSON.parse(raw) : { ok: true, lastRun: null, detail: 'Not yet run' });
}

// ─── Route: GET /api/debug ────────────────────────────────────────────────────

async function handleDebug(request, env) {
  if (!checkPasscode(request, env)) return unauthorized();
  const raw = await env.TRACKER_KV.get('containers');
  const containers = raw ? JSON.parse(raw) : [];
  const summary = containers.map(function(c, i) {
    return { index: i, number: c.number, received: c.received, addedAt: c.addedAt, allKeys: Object.keys(c) };
  });
  return Response.json({ count: containers.length, containers: summary });
}

// ─── Route: /robots.txt ───────────────────────────────────────────────────────

function handleRobots() {
  return new Response('User-agent: *\nDisallow: /', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────

// Compiled Tailwind utilities, inlined so styling has no runtime CDN dependency
// (ship internet). Regenerate after adding/removing Tailwind classes in the HTML:
//   npx tailwindcss --content src/worker.js -o tw.css --minify
// then paste the output between the String.raw backticks below.
const TAILWIND_CSS = String.raw`*,::backdrop,:after,:before{--tw-border-spacing-x:0;--tw-border-spacing-y:0;--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness:proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-color:#3b82f680;--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }/*! tailwindcss v3.4.19 | MIT License | https://tailwindcss.com*/*,:after,:before{box-sizing:border-box;border:0 solid #e5e7eb}:after,:before{--tw-content:""}:host,html{line-height:1.5;-webkit-text-size-adjust:100%;-moz-tab-size:4;-o-tab-size:4;tab-size:4;font-family:ui-sans-serif,system-ui,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji;font-feature-settings:normal;font-variation-settings:normal;-webkit-tap-highlight-color:transparent}body{margin:0;line-height:inherit}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,pre,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;font-feature-settings:normal;font-variation-settings:normal;font-size:1em}small{font-size:80%}sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:initial}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}button,input,optgroup,select,textarea{font-family:inherit;font-feature-settings:inherit;font-variation-settings:inherit;font-size:100%;font-weight:inherit;line-height:inherit;letter-spacing:inherit;color:inherit;margin:0;padding:0}button,select{text-transform:none}button,input:where([type=button]),input:where([type=reset]),input:where([type=submit]){-webkit-appearance:button;background-color:initial;background-image:none}:-moz-focusring{outline:auto}:-moz-ui-invalid{box-shadow:none}progress{vertical-align:initial}::-webkit-inner-spin-button,::-webkit-outer-spin-button{height:auto}[type=search]{-webkit-appearance:textfield;outline-offset:-2px}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-file-upload-button{-webkit-appearance:button;font:inherit}summary{display:list-item}blockquote,dd,dl,figure,h1,h2,h3,h4,h5,h6,hr,p,pre{margin:0}fieldset{margin:0}fieldset,legend{padding:0}menu,ol,ul{list-style:none;margin:0;padding:0}dialog{padding:0}textarea{resize:vertical}input::-moz-placeholder,textarea::-moz-placeholder{opacity:1;color:#9ca3af}input::placeholder,textarea::placeholder{opacity:1;color:#9ca3af}[role=button],button{cursor:pointer}:disabled{cursor:default}audio,canvas,embed,iframe,img,object,svg,video{display:block;vertical-align:middle}img,video{max-width:100%;height:auto}[hidden]:where(:not([hidden=until-found])){display:none}.container{width:100%}@media (min-width:640px){.container{max-width:640px}}@media (min-width:768px){.container{max-width:768px}}@media (min-width:1024px){.container{max-width:1024px}}@media (min-width:1280px){.container{max-width:1280px}}@media (min-width:1536px){.container{max-width:1536px}}.fixed{position:fixed}.inset-0{inset:0}.z-50{z-index:50}.mx-auto{margin-left:auto;margin-right:auto}.mb-2{margin-bottom:.5rem}.mb-3{margin-bottom:.75rem}.mb-4{margin-bottom:1rem}.mb-6{margin-bottom:1.5rem}.ml-auto{margin-left:auto}.mt-0\.5{margin-top:.125rem}.mt-1{margin-top:.25rem}.mt-2{margin-top:.5rem}.mt-3{margin-top:.75rem}.block{display:block}.inline{display:inline}.flex{display:flex}.table{display:table}.grid{display:grid}.hidden{display:none}.h-10{height:2.5rem}.h-2\.5{height:.625rem}.h-3\.5{height:.875rem}.h-4{height:1rem}.max-h-\[80vh\]{max-height:80vh}.min-h-screen{min-height:100vh}.w-10{width:2.5rem}.w-2\.5{width:.625rem}.w-3\.5{width:.875rem}.w-4{width:1rem}.w-full{width:100%}.max-w-6xl{max-width:72rem}.max-w-lg{max-width:32rem}.max-w-sm{max-width:24rem}.flex-1{flex:1 1 0%}.flex-shrink-0{flex-shrink:0}.transform{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.cursor-pointer{cursor:pointer}.select-none{-webkit-user-select:none;-moz-user-select:none;user-select:none}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.flex-wrap{flex-wrap:wrap}.items-center{align-items:center}.justify-end{justify-content:flex-end}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-1{gap:.25rem}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.gap-y-2{row-gap:.5rem}.space-y-1>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.25rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.25rem*var(--tw-space-y-reverse))}.space-y-2>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.5rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.5rem*var(--tw-space-y-reverse))}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.75rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75rem*var(--tw-space-y-reverse))}.space-y-5>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(1.25rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1.25rem*var(--tw-space-y-reverse))}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.whitespace-nowrap{white-space:nowrap}.rounded-2xl{border-radius:1rem}.rounded-full{border-radius:9999px}.rounded-lg{border-radius:.5rem}.rounded-xl{border-radius:.75rem}.border{border-width:1px}.border-b{border-bottom-width:1px}.border-b-2{border-bottom-width:2px}.border-t{border-top-width:1px}.border-\[\#1e293b\]{--tw-border-opacity:1;border-color:rgb(30 41 59/var(--tw-border-opacity,1))}.border-\[\#d5e4f0\]{--tw-border-opacity:1;border-color:rgb(213 228 240/var(--tw-border-opacity,1))}.border-\[\#e6e8e8\]{--tw-border-opacity:1;border-color:rgb(230 232 232/var(--tw-border-opacity,1))}.border-\[\#f0f1f2\]{--tw-border-opacity:1;border-color:rgb(240 241 242/var(--tw-border-opacity,1))}.border-\[\#fdf3e8\]{--tw-border-opacity:1;border-color:rgb(253 243 232/var(--tw-border-opacity,1))}.border-transparent{border-color:#0000}.bg-\[\#02579a\]{--tw-bg-opacity:1;background-color:rgb(2 87 154/var(--tw-bg-opacity,1))}.bg-\[\#1e293b\]{--tw-bg-opacity:1;background-color:rgb(30 41 59/var(--tw-bg-opacity,1))}.bg-\[\#a9adb1\]{--tw-bg-opacity:1;background-color:rgb(169 173 177/var(--tw-bg-opacity,1))}.bg-\[\#c4002b\]{--tw-bg-opacity:1;background-color:rgb(196 0 43/var(--tw-bg-opacity,1))}.bg-\[\#c46b1f\]{--tw-bg-opacity:1;background-color:rgb(196 107 31/var(--tw-bg-opacity,1))}.bg-\[\#e6e8e8\]{--tw-bg-opacity:1;background-color:rgb(230 232 232/var(--tw-bg-opacity,1))}.bg-\[\#e8eef5\]{--tw-bg-opacity:1;background-color:rgb(232 238 245/var(--tw-bg-opacity,1))}.bg-\[\#f2f3f4\]{--tw-bg-opacity:1;background-color:rgb(242 243 244/var(--tw-bg-opacity,1))}.bg-\[\#f7f7f7\]{--tw-bg-opacity:1;background-color:rgb(247 247 247/var(--tw-bg-opacity,1))}.bg-\[\#fdf3e8\]{--tw-bg-opacity:1;background-color:rgb(253 243 232/var(--tw-bg-opacity,1))}.bg-black\/50{background-color:#00000080}.bg-white{--tw-bg-opacity:1;background-color:rgb(255 255 255/var(--tw-bg-opacity,1))}.bg-gradient-to-r{background-image:linear-gradient(to right,var(--tw-gradient-stops))}.from-\[\#1e293b\]{--tw-gradient-from:#1e293b var(--tw-gradient-from-position);--tw-gradient-to:#1e293b00 var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.to-\[\#02579a\]{--tw-gradient-to:#02579a var(--tw-gradient-to-position)}.p-10{padding:2.5rem}.p-3{padding:.75rem}.p-4{padding:1rem}.p-5{padding:1.25rem}.p-8{padding:2rem}.px-2{padding-left:.5rem;padding-right:.5rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-4{padding-left:1rem;padding-right:1rem}.px-5{padding-left:1.25rem;padding-right:1.25rem}.py-0\.5{padding-top:.125rem;padding-bottom:.125rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}.py-1\.5{padding-top:.375rem;padding-bottom:.375rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-4{padding-top:1rem;padding-bottom:1rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.pl-3{padding-left:.75rem}.pr-3{padding-right:.75rem}.pt-1{padding-top:.25rem}.pt-3{padding-top:.75rem}.text-left{text-align:left}.text-center{text-align:center}.text-right{text-align:right}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace}.text-2xl{font-size:1.5rem;line-height:2rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xl{font-size:1.25rem;line-height:1.75rem}.text-xs{font-size:.75rem;line-height:1rem}.font-bold{font-weight:700}.font-semibold{font-weight:600}.uppercase{text-transform:uppercase}.leading-none{line-height:1}.tracking-wide{letter-spacing:.025em}.text-\[\#00695b\]{--tw-text-opacity:1;color:rgb(0 105 91/var(--tw-text-opacity,1))}.text-\[\#02579a\]{--tw-text-opacity:1;color:rgb(2 87 154/var(--tw-text-opacity,1))}.text-\[\#1e293b\]{--tw-text-opacity:1;color:rgb(30 41 59/var(--tw-text-opacity,1))}.text-\[\#262f3d\]{--tw-text-opacity:1;color:rgb(38 47 61/var(--tw-text-opacity,1))}.text-\[\#4fc2f8\]{--tw-text-opacity:1;color:rgb(79 194 248/var(--tw-text-opacity,1))}.text-\[\#897a6b\]{--tw-text-opacity:1;color:rgb(137 122 107/var(--tw-text-opacity,1))}.text-\[\#a9adb1\]{--tw-text-opacity:1;color:rgb(169 173 177/var(--tw-text-opacity,1))}.text-\[\#c4002b\]{--tw-text-opacity:1;color:rgb(196 0 43/var(--tw-text-opacity,1))}.text-\[\#c46b1f\]{--tw-text-opacity:1;color:rgb(196 107 31/var(--tw-text-opacity,1))}.text-white{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.underline{text-decoration-line:underline}.placeholder-\[\#a9adb1\]::-moz-placeholder{--tw-placeholder-opacity:1;color:rgb(169 173 177/var(--tw-placeholder-opacity,1))}.placeholder-\[\#a9adb1\]::placeholder{--tw-placeholder-opacity:1;color:rgb(169 173 177/var(--tw-placeholder-opacity,1))}.opacity-75{opacity:.75}.shadow-lg{--tw-shadow:0 10px 15px -3px #0000001a,0 4px 6px -4px #0000001a;--tw-shadow-colored:0 10px 15px -3px var(--tw-shadow-color),0 4px 6px -4px var(--tw-shadow-color)}.shadow-lg,.shadow-sm{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-sm{--tw-shadow:0 1px 2px 0 #0000000d;--tw-shadow-colored:0 1px 2px 0 var(--tw-shadow-color)}.shadow-xl{--tw-shadow:0 20px 25px -5px #0000001a,0 8px 10px -6px #0000001a;--tw-shadow-colored:0 20px 25px -5px var(--tw-shadow-color),0 8px 10px -6px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.filter{filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.transition-colors{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.transition-transform{transition-property:transform;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.hover\:bg-\[\#02579a\]:hover{--tw-bg-opacity:1;background-color:rgb(2 87 154/var(--tw-bg-opacity,1))}.hover\:bg-\[\#fafafa\]:hover{--tw-bg-opacity:1;background-color:rgb(250 250 250/var(--tw-bg-opacity,1))}.hover\:text-\[\#02579a\]:hover{--tw-text-opacity:1;color:rgb(2 87 154/var(--tw-text-opacity,1))}.hover\:text-\[\#1e293b\]:hover{--tw-text-opacity:1;color:rgb(30 41 59/var(--tw-text-opacity,1))}.hover\:text-\[\#262f3d\]:hover{--tw-text-opacity:1;color:rgb(38 47 61/var(--tw-text-opacity,1))}.hover\:text-\[\#c4002b\]:hover{--tw-text-opacity:1;color:rgb(196 0 43/var(--tw-text-opacity,1))}.hover\:text-white:hover{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.hover\:underline:hover{text-decoration-line:underline}.hover\:opacity-75:hover{opacity:.75}.focus\:outline-none:focus{outline:2px solid #0000;outline-offset:2px}.focus\:ring-2:focus{--tw-ring-offset-shadow:var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow:var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow,0 0 #0000)}.focus\:ring-\[\#1e293b\]:focus{--tw-ring-opacity:1;--tw-ring-color:rgb(30 41 59/var(--tw-ring-opacity,1))}.active\:bg-\[\#0f172a\]:active{--tw-bg-opacity:1;background-color:rgb(15 23 42/var(--tw-bg-opacity,1))}@media (min-width:640px){.sm\:block{display:block}.sm\:hidden{display:none}}`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Shipping Container Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Open+Sans:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>${TAILWIND_CSS}</style>
<style>
  body { font-family: 'Open Sans', sans-serif; }
  .spinner { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .fade-in { animation: fadeIn 0.3s ease-in; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .font-mono { font-family: 'JetBrains Mono', monospace !important; }
</style>
</head>
<body class="bg-[#f2f3f4] min-h-screen text-[#262f3d]">

<!-- Passcode Gate -->
<div id="passcodeGate" class="fixed inset-0 bg-[#1e293b] z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
    <div class="text-center mb-6">
      <div class="text-[#1e293b] font-bold text-2xl tracking-wide">Shipping Container</div>
      <div class="text-[#897a6b] text-sm mt-1">Tracker</div>
    </div>
    <div class="space-y-3">
      <input type="password" id="passcodeInput"
        placeholder="Enter passcode"
        class="w-full border border-[#e6e8e8] rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e293b]"
        onkeydown="if(event.key==='Enter')submitPasscode()"
      />
      <button onclick="submitPasscode()" id="passcodeBtn"
        class="w-full bg-[#1e293b] hover:bg-[#02579a] active:bg-[#0f172a] text-white font-semibold py-3 rounded-lg text-sm transition-colors">
        Enter
      </button>
      <div id="passcodeError" class="hidden text-center text-[#c4002b] text-xs pt-1">Incorrect passcode. Try again.</div>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="mainApp" class="hidden">

<div id="canaryBanner" class="hidden bg-[#c4002b] text-white text-xs font-semibold px-4 py-2 text-center"></div>

<header class="bg-gradient-to-r from-[#1e293b] to-[#02579a] text-white shadow-lg">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between flex-wrap gap-2">
    <div>
      <h1 class="text-xl font-bold tracking-wide">Shipping Container Tracker</h1>
      <p class="text-[#4fc2f8] text-xs mt-0.5">Houston &amp; Rotterdam &rarr; <span id="destPort" class="font-semibold text-white">Freetown, Sierra Leone</span></p>
    </div>
    <div class="flex items-center gap-4">
      <div id="lastRefresh" class="text-[#4fc2f8] text-xs"></div>
      <button onclick="trackAll()" class="text-[#4fc2f8] hover:text-white text-xs flex items-center gap-1 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        Refresh
      </button>
    </div>
  </div>
</header>

<main class="max-w-6xl mx-auto px-4 py-6 space-y-5">

  <!-- Add Container -->
  <div class="bg-white rounded-2xl shadow-sm border border-[#e6e8e8] p-5">
    <h2 class="text-sm font-semibold text-[#262f3d] mb-3">Add Container</h2>
    <div class="flex gap-3">
      <input type="text" id="newContainerInput"
        placeholder="e.g. MSDU6574161, or comma-separated for multiple"
        style="text-transform:uppercase"
        class="flex-1 border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#1e293b] placeholder-[#a9adb1]"
        onkeydown="if(event.key==='Enter')addContainer()"
      />
      <button onclick="addContainer()"
        class="bg-[#1e293b] hover:bg-[#02579a] active:bg-[#0f172a] text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors whitespace-nowrap">
        + Add
      </button>
    </div>
    <div id="addMsg" class="hidden text-xs mt-2"></div>
  </div>

  <!-- Tabs -->
  <div class="flex gap-1 border-b border-[#e6e8e8]">
    <button onclick="switchTab('tracker')" id="tabTracker" class="px-4 py-2 text-sm font-semibold text-[#1e293b] border-b-2 border-[#1e293b]">
      Tracker
    </button>
    <button onclick="switchTab('manage')" id="tabManage" class="px-4 py-2 text-sm font-semibold text-[#a9adb1] border-b-2 border-transparent hover:text-[#262f3d]">
      Manage Ports
    </button>
  </div>

  <!-- Summary -->
  <div id="trackerView">
  <div id="summaryBar" class="hidden grid grid-cols-3 gap-3 fade-in">
    <div class="bg-white rounded-xl border border-[#d5e4f0] p-3 text-center shadow-sm">
      <div id="sumTransit" class="text-2xl font-bold text-[#02579a]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">In Transit</div>
    </div>
    <div class="bg-white rounded-xl border border-[#fdf3e8] p-3 text-center shadow-sm">
      <div id="sumPort" class="text-2xl font-bold text-[#c46b1f]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">In Port</div>
    </div>
    <div class="bg-white rounded-xl border border-[#e6e8e8] p-3 text-center shadow-sm">
      <div id="sumReceived" class="text-2xl font-bold text-[#897a6b]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">Received</div>
    </div>
  </div>

  <!-- Embark analytics: avg days from loaded at origin to received, by port of call -->
  <div id="embarkStats" class="hidden mt-3 bg-white rounded-xl border border-[#e6e8e8] p-3 fade-in">
    <div class="text-xs font-semibold text-[#897a6b] uppercase tracking-wide mb-2">Avg loaded &rarr; received (days), by port of call</div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-xs text-[#a9adb1] uppercase tracking-wide">
            <th class="text-left py-1 pr-3 font-semibold">Port of Call</th>
            <th class="text-right py-1 px-3 font-semibold">Houston</th>
            <th class="text-right py-1 px-3 font-semibold">Rotterdam</th>
            <th class="text-right py-1 pl-3 font-semibold">All</th>
          </tr>
        </thead>
        <tbody id="embarkTableBody"></tbody>
      </table>
    </div>
    <div id="embarkEmpty" class="hidden text-xs text-[#a9adb1] pt-1">No completed shipments with load + receive dates captured yet — this fills in as boxes are tracked and received.</div>
  </div>

  <!-- Loading -->
  <div id="loadingState" class="hidden">
    <div class="bg-white rounded-2xl border border-[#e6e8e8] shadow-sm p-10 text-center">
      <svg class="spinner inline w-10 h-10 mb-4" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#e6e8e8" stroke-width="3"/>
        <path d="M12 2a10 10 0 0 1 10 10" stroke="#1e293b" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <p class="text-[#262f3d] font-semibold">Fetching tracking data&hellip;</p>
      <p class="text-[#a9adb1] text-xs mt-2">Contacting MSC via secure browser proxy. This takes 10&ndash;20 seconds.</p>
      <div id="loadingTimer" class="text-[#897a6b] text-xs mt-3 font-mono"></div>
    </div>
  </div>

  <!-- Results -->
  <div id="resultsSection" class="hidden space-y-5 fade-in">

    <!-- In Transit -->
    <div id="sectionTransit" class="hidden">
      <div class="flex items-center gap-2 mb-2">
        <span class="w-2.5 h-2.5 rounded-full bg-[#02579a] flex-shrink-0"></span>
        <h2 class="font-semibold text-[#262f3d]">In Transit</h2>
        <span id="badgeTransit" class="bg-[#e8eef5] text-[#02579a] text-xs px-2 py-0.5 rounded-full font-semibold"></span>
      </div>
      <div class="hidden sm:block bg-white rounded-2xl shadow-sm border border-[#e6e8e8] overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-[#f7f7f7] border-b border-[#e6e8e8]">
            <tr>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Transit&apos;,&apos;containerNumber&apos;)">Container <span id="sort-Transit-containerNumber" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Transit&apos;,&apos;shipmentId&apos;)">Shipment # <span id="sort-Transit-shipmentId" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Transit&apos;,&apos;status&apos;)">Status <span id="sort-Transit-status" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Transit&apos;,&apos;currentLocation&apos;)">Location <span id="sort-Transit-currentLocation" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Vessel / Voyage</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Transit&apos;,&apos;podEtaDate&apos;)">ETA <span id="sort-Transit-podEtaDate" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Route</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody id="tableTransit"></tbody>
        </table>
      </div>
      <div id="cardsTransit" class="sm:hidden space-y-3"></div>
    </div>

    <!-- In Port -->
    <div id="sectionPort" class="hidden">
      <div class="flex items-center gap-2 mb-2">
        <span class="w-2.5 h-2.5 rounded-full bg-[#c46b1f] flex-shrink-0"></span>
        <h2 class="font-semibold text-[#262f3d]">In Port</h2>
        <span id="badgePort" class="bg-[#fdf3e8] text-[#c46b1f] text-xs px-2 py-0.5 rounded-full font-semibold"></span>
      </div>
      <div class="hidden sm:block bg-white rounded-2xl shadow-sm border border-[#e6e8e8] overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-[#f7f7f7] border-b border-[#e6e8e8]">
            <tr>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Port&apos;,&apos;containerNumber&apos;)">Container <span id="sort-Port-containerNumber" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Port&apos;,&apos;shipmentId&apos;)">Shipment # <span id="sort-Port-shipmentId" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Port&apos;,&apos;status&apos;)">Status <span id="sort-Port-status" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Port&apos;,&apos;currentLocation&apos;)">Location <span id="sort-Port-currentLocation" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Vessel / Voyage</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Port&apos;,&apos;podEtaDate&apos;)">ETA <span id="sort-Port-podEtaDate" style="color:#c4c8cc">&#8645;</span></th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Route</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody id="tablePort"></tbody>
        </table>
      </div>
      <div id="cardsPort" class="sm:hidden space-y-3"></div>
    </div>

    <!-- Received (collapsible, collapsed by default) -->
    <div id="sectionReceived" class="hidden">
      <button class="flex items-center gap-2 mb-2 w-full text-left" onclick="toggleReceived()">
        <span class="w-2.5 h-2.5 rounded-full bg-[#a9adb1] flex-shrink-0"></span>
        <h2 class="font-semibold text-[#262f3d]">Received</h2>
        <span id="badgeReceived" class="bg-[#e6e8e8] text-[#897a6b] text-xs px-2 py-0.5 rounded-full font-semibold"></span>
        <svg id="receivedChevron" class="w-4 h-4 text-[#a9adb1] ml-auto transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div id="receivedBody" class="hidden">
        <div class="hidden sm:block bg-white rounded-2xl shadow-sm border border-[#e6e8e8] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-[#f7f7f7] border-b border-[#e6e8e8]">
              <tr>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Received&apos;,&apos;containerNumber&apos;)">Container <span id="sort-Received-containerNumber" style="color:#c4c8cc">&#8645;</span></th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Received&apos;,&apos;shipmentId&apos;)">Shipment # <span id="sort-Received-shipmentId" style="color:#c4c8cc">&#8645;</span></th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Loaded</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Discharged</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Received&apos;,&apos;originalEta&apos;)">Original ETA <span id="sort-Received-originalEta" style="color:#c4c8cc">&#8645;</span></th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Received&apos;,&apos;receivedAt&apos;)">Date Received <span id="sort-Received-receivedAt" style="color:#c4c8cc">&#8645;</span></th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]">Port Received</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide cursor-pointer select-none hover:text-[#262f3d]" onclick="sortSection(&apos;Received&apos;,&apos;variance&apos;)">Variance <span id="sort-Received-variance" style="color:#c4c8cc">&#8645;</span></th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody id="tableReceived"></tbody>
          </table>
        </div>
        <div id="cardsReceived" class="sm:hidden space-y-3"></div>
      </div>
    </div>

    <!-- Empty state -->
    <div id="emptyState" class="hidden bg-white rounded-2xl border border-[#e6e8e8] shadow-sm p-10 text-center">
      <p class="text-[#897a6b] font-semibold">No containers in the tracker yet.</p>
      <p class="text-[#a9adb1] text-sm mt-1">Add a container number above to get started.</p>
    </div>

  </div>
  </div>

  <!-- Management View -->
  <div id="manageView" class="hidden space-y-5">
    
    <!-- Manage Ports -->
    <div class="bg-white rounded-2xl shadow-sm border border-[#e6e8e8] p-5">
      <h2 class="text-sm font-semibold text-[#262f3d] mb-4">Ports of Call</h2>
      <div class="flex gap-3 mb-4 flex-wrap">
        <input type="text" id="newPortId" placeholder="UNLOCODE (e.g., SLFNT)" style="text-transform:uppercase; max-width:120px"
          class="border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#1e293b]" />
        <input type="text" id="newPortName" placeholder="Port name (e.g., Freetown, Sierra Leone)"
          class="flex-1 border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e293b]" />
        <input type="text" id="newPortCountry" placeholder="Country (e.g., SL)" style="text-transform:uppercase; max-width:80px"
          class="border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e293b]" />
        <button onclick="addPort()" class="bg-[#1e293b] hover:bg-[#02579a] text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors whitespace-nowrap">
          + Add Port
        </button>
      </div>
      <div id="portsList" class="space-y-2"></div>
      <div id="portsMsg" class="hidden text-xs mt-3"></div>
    </div>

  </div>

</main>
</div>

<!-- Duplicate Container Modal -->
<div id="duplicateModal" class="fixed inset-0 bg-black/50 z-50 hidden flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl max-w-sm w-full">
    <div class="px-5 py-4 border-b border-[#e6e8e8]">
      <h3 class="font-semibold text-[#262f3d]">Container Already Exists</h3>
    </div>
    <div class="p-5 space-y-3 text-sm">
      <p class="text-[#262f3d]">This container has already been added and is not yet received.</p>
      <div class="bg-[#f7f7f7] rounded-lg p-3 space-y-1 text-xs">
        <div><span class="text-[#897a6b]">Container:</span> <span id="dupContainerNum" class="font-mono font-semibold"></span></div>
        <div><span class="text-[#897a6b]">Added:</span> <span id="dupAddedAt"></span></div>
        <div><span class="text-[#897a6b]">Shipment:</span> <span id="dupShipmentId"></span></div>
      </div>
    </div>
    <div class="px-5 py-3 border-t border-[#e6e8e8] flex justify-end">
      <button onclick="closeDuplicateModal()" class="bg-[#1e293b] hover:bg-[#02579a] text-white font-semibold px-4 py-2 rounded-lg text-sm">
        OK
      </button>
    </div>
  </div>
</div>

<!-- History Modal -->
<div id="historyModal" class="fixed inset-0 bg-black/50 z-50 hidden items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
    <div class="flex items-center justify-between px-5 py-4 border-b border-[#e6e8e8]">
      <h3 id="modalTitle" class="font-semibold text-[#262f3d]"></h3>
      <button onclick="closeModal()" class="text-[#a9adb1] hover:text-[#262f3d] text-xl leading-none">&times;</button>
    </div>
    <div id="modalBody" class="p-5 space-y-3 text-sm"></div>
  </div>
</div>

<script>
var lastResults = {};
var timerInterval = null;
var receivedOpen = false;
var sortState = { Transit: { col: null, dir: 'asc' }, Port: { col: null, dir: 'asc' }, Received: { col: null, dir: 'asc' } };
var allTransit = [], allPort = [], allReceived = [];

// ── Escaping ──────────────────────────────────────────────────────────────────
// Everything rendered via innerHTML that comes from MSC or from user input
// (shipment IDs) goes through esc() first.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDMY(str) {
  if (!str || str.length < 10) return null;
  var p = str.split('/');
  if (p.length !== 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}

function fmtDate(str) {
  var d = parseDMY(str);
  if (!d) return str ? esc(str) : '\u2014';
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
}

function fmtDateISO(str) {
  if (!str) return '\u2014';
  var d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return esc(str);
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
}

function etaDelta(originalEta, receivedAt) {
  if (!originalEta || !receivedAt) return '\u2014';
  var eta = parseDMY(originalEta);
  var recv = new Date(receivedAt + 'T00:00:00');
  if (!eta || isNaN(recv)) return '\u2014';
  var days = Math.round((recv - eta) / 86400000);
  if (days === 0) return '<span style="color:#00695b;font-weight:600">On time</span>';
  if (days > 0) return '<span style="color:#c4002b;font-weight:600">+' + days + 'd late</span>';
  return '<span style="color:#00695b;font-weight:600">' + Math.abs(days) + 'd early</span>';
}

function etaHtml(str, originalEta) {
  if (!str) return '<span style="color:#a9adb1">\u2014</span>';
  var d = parseDMY(str);
  if (!d) return '<span style="color:#897a6b">' + esc(str) + '</span>';
  var now = new Date(); now.setHours(0,0,0,0);
  var days = Math.round((d - now) / 86400000);
  var label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  var colorStr, weightStr, suffix;
  if (days < 0) { colorStr = '#a9adb1'; weightStr = ''; suffix = ''; }
  else if (days === 0) { colorStr = '#00695b'; weightStr = 'font-weight:600;'; suffix = ' (Today)'; }
  else if (days <= 7) { colorStr = '#c46b1f'; weightStr = 'font-weight:600;'; suffix = ' <span style="font-size:0.75em;color:#a9adb1">(' + days + 'd)</span>'; }
  else if (days <= 21) { colorStr = '#02579a'; weightStr = ''; suffix = ' <span style="font-size:0.75em;color:#a9adb1">(' + days + 'd)</span>'; }
  else { colorStr = '#262f3d'; weightStr = ''; suffix = ' <span style="font-size:0.75em;color:#a9adb1">(' + days + 'd)</span>'; }
  var html = '<span style="color:' + colorStr + ';' + weightStr + '">' + label + suffix + '</span>';
  if (originalEta && originalEta !== str) {
    html += '<div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">Orig: ' + fmtDate(originalEta) + '</div>';
  }
  return html;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function classifyStatus(r) {
  if (r.received) return 'received';
  if (r.delivered) return 'port';
  var s = (r.status || '').toLowerCase();
  if (s.includes('discharg') || s.includes('import') || s.includes('arriv')) return 'port';
  return 'transit';
}

function statusBadge(r) {
  var base = 'display:inline-block;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600;';
  if (!r.success) return '<span style="' + base + 'background:#fce8ec;color:#c4002b">Error</span>';
  var s = (r.status || '').toLowerCase();
  if (r.delivered || s.includes('deliver')) {
    return '<span style="' + base + 'background:#e6f4ea;color:#1e7e34">' + esc(r.status || 'Delivered') + '</span>';
  }
  if (s.includes('load') || s.includes('depart') || s.includes('sail') || s.includes('transit')) {
    return '<span style="' + base + 'background:#e8eef5;color:#02579a">' + esc(r.status) + '</span>';
  }
  if (s.includes('discharg') || s.includes('arriv') || s.includes('import')) {
    return '<span style="' + base + 'background:#fdf3e8;color:#c46b1f">' + esc(r.status) + '</span>';
  }
  if (s.includes('transship') || s.includes('transfer') || s.includes('customs') || s.includes('gate')) {
    return '<span style="' + base + 'background:#fdf3e8;color:#c46b1f">' + esc(r.status) + '</span>';
  }
  return '<span style="' + base + 'background:#f0efee;color:#897a6b">' + esc(r.status || 'Unknown') + '</span>';
}

function mscLink(cn) {
  return 'https://www.msc.com/en/track-a-shipment?agencyPath=msc&trackingNumber=' + cn;
}

function vesselLink(imo, name) {
  if (imo) return 'https://www.marinetraffic.com/en/ais/details/ships/imo:' + imo;
  if (name) return 'https://www.marinetraffic.com/en/ais/home/shipname:' + encodeURIComponent(name);
  return 'https://www.marinetraffic.com/en/ais/home/centerx:-20.1/centery:13.1/zoom:5';
}

function routeHtml(r) {
  if (!r.portOfLoad) return '<span style="color:#a9adb1">\u2014</span>';
  var route = r.portOfLoad;
  if (r.transshipments && r.transshipments.length) route += ' \u2192 ' + r.transshipments.join(' \u2192 ');
  route += ' \u2192 ' + (r.portOfDischarge || '?');
  return '<span style="font-size:0.75rem;color:#897a6b;line-height:1.4">' + esc(route) + '</span>';
}

// ── Action buttons (inner HTML only — wrapper div carries data-actions attr) ──

function actionsInner(cn, isReceived) {
  if (isReceived) {
    return '<a href="' + mscLink(cn) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">MSC &#8599;</a>' +
      ' <button onclick="removeContainer(&apos;' + cn + '&apos;)" style="color:#a9adb1;font-size:0.75rem" class="hover:text-[#c4002b] hover:underline">Remove</button>';
  }
  return '<a href="' + mscLink(cn) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">MSC &#8599;</a>' +
    ' <button onclick="showHistory(&apos;' + cn + '&apos;)" style="color:#a9adb1;font-size:0.75rem" class="hover:underline underline">History</button>' +
    ' <button onclick="showReceivePrompt(&apos;' + cn + '&apos;)" style="color:#00695b;font-size:0.75rem;font-weight:600" class="hover:underline">&#10003; Received</button>' +
    ' <button onclick="removeContainer(&apos;' + cn + '&apos;)" style="color:#d0d3d4;font-size:0.9rem;line-height:1" class="hover:text-[#c4002b]">&times;</button>';
}

function actionsDiv(cn, isReceived) {
  return '<div data-actions="' + cn + '" class="flex gap-2 items-center flex-wrap">' + actionsInner(cn, isReceived) + '</div>';
}

// ── Shipment # cell ───────────────────────────────────────────────────────────

function shipmentCellInner(cn, sid) {
  if (sid) {
    return '<span style="color:#262f3d;font-size:0.8rem">' + esc(sid) + '</span>' +
      ' <button onclick="showShipmentEdit(&apos;' + cn + '&apos;)" style="color:#c4c8cc;font-size:0.75rem" title="Edit">&#9998;</button>';
  }
  return '<button onclick="showShipmentEdit(&apos;' + cn + '&apos;)" style="color:#a9adb1;font-size:0.75rem" class="hover:text-[#02579a]">+ Add #</button>';
}

function shipmentCell(cn, sid) {
  return '<div data-shipment="' + cn + '">' + shipmentCellInner(cn, sid) + '</div>';
}

function showShipmentEdit(cn) {
  var r = lastResults[cn];
  var current = (r && r.shipmentId) ? r.shipmentId : '';
  var html = '<span class="flex items-center gap-1 flex-wrap">' +
    '<input type="text" class="sedit-' + cn + '" value="' + esc(current) + '" placeholder="e.g. 0426-NL0102G-SL" style="border:1px solid #e6e8e8;border-radius:6px;padding:2px 6px;font-size:0.75rem;min-width:150px" onkeydown="if(event.key===&apos;Enter&apos;)saveShipment(&apos;' + cn + '&apos;)" />' +
    ' <button onclick="saveShipment(&apos;' + cn + '&apos;)" style="background:#1e293b;color:#fff;font-size:0.7rem;padding:3px 10px;border-radius:6px;font-weight:600">Save</button>' +
    ' <button onclick="cancelShipmentEdit(&apos;' + cn + '&apos;)" style="color:#a9adb1;font-size:0.7rem">Cancel</button>' +
    '</span>';
  document.querySelectorAll('[data-shipment="' + cn + '"]').forEach(function(el) { el.innerHTML = html; });
  var inputs = document.querySelectorAll('.sedit-' + cn);
  if (inputs.length) { inputs[0].focus(); inputs[0].select(); }
}

async function saveShipment(cn) {
  var inputs = document.querySelectorAll('.sedit-' + cn);
  var sid = inputs.length ? inputs[0].value.trim() : '';
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/shipment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: JSON.stringify({ number: cn, shipmentId: sid })
    });
    if (res.ok) {
      if (lastResults[cn]) lastResults[cn].shipmentId = sid || null;
      document.querySelectorAll('[data-shipment="' + cn + '"]').forEach(function(el) {
        el.innerHTML = shipmentCellInner(cn, sid || null);
      });
    } else { alert('Failed to save Shipment #. Please try again.'); }
  } catch(e) { alert('Network error: ' + e.message); }
}

function cancelShipmentEdit(cn) {
  var r = lastResults[cn];
  var sid = (r && r.shipmentId) ? r.shipmentId : null;
  document.querySelectorAll('[data-shipment="' + cn + '"]').forEach(function(el) {
    el.innerHTML = shipmentCellInner(cn, sid);
  });
}

// ── Receive prompt ────────────────────────────────────────────────────────────

function showReceivePrompt(cn) {
  var today = new Date().toISOString().split('T')[0];
  var html = '<div class="flex items-center gap-1 flex-wrap">' +
    '<input type="date" class="rdate-' + cn + '" value="' + today + '" style="border:1px solid #e6e8e8;border-radius:6px;padding:2px 6px;font-size:0.75rem" />' +
    ' <button onclick="confirmReceived(&apos;' + cn + '&apos;)" style="background:#1e293b;color:#fff;font-size:0.7rem;padding:3px 10px;border-radius:6px;font-weight:600">Confirm</button>' +
    ' <button onclick="cancelReceive(&apos;' + cn + '&apos;)" style="color:#a9adb1;font-size:0.7rem">Cancel</button>' +
    '</div>';
  document.querySelectorAll('[data-actions="' + cn + '"]').forEach(function(el) { el.innerHTML = html; });
}

function cancelReceive(cn) {
  document.querySelectorAll('[data-actions="' + cn + '"]').forEach(function(el) {
    el.innerHTML = actionsInner(cn, false);
  });
}

async function confirmReceived(cn) {
  var dateInputs = document.querySelectorAll('.rdate-' + cn);
  var date = dateInputs.length ? dateInputs[0].value : '';
  if (!date) date = new Date().toISOString().split('T')[0];
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: JSON.stringify({ number: cn, receivedAt: date })
    });
    if (res.ok) {
      if (lastResults[cn]) {
        lastResults[cn].received = true;
        lastResults[cn].receivedAt = date;
      }
      renderResults(Object.values(lastResults));
    } else {
      var errData = null;
      try { errData = await res.json(); } catch(ignored) {}
      var msg = (errData && errData.error) ? errData.error : ('HTTP ' + res.status);
      alert('Failed to mark ' + cn + ' as received: ' + msg);
    }
  } catch(e) { alert('Network error: ' + e.message); }
}

// ── Remove container ──────────────────────────────────────────────────────────

async function removeContainer(cn) {
  if (!confirm('Remove ' + cn + ' from the tracker?')) return;
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/list?number=' + encodeURIComponent(cn), {
      method: 'DELETE', headers: { 'X-Passcode': passcode }
    });
    if (res.ok) {
      delete lastResults[cn];
      renderResults(Object.values(lastResults));
    } else { alert('Failed to remove container.'); }
  } catch(e) { alert('Network error: ' + e.message); }
}

// ── Add container ─────────────────────────────────────────────────────────────

async function addContainer() {
  var input = document.getElementById('newContainerInput');
  var cn = (input.value || '').trim().toUpperCase();
  var msg = document.getElementById('addMsg');
  if (!cn) return;
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: JSON.stringify({ number: cn })
    });
    var data = await res.json();
    if (res.ok) {
      input.value = '';
      msg.className = 'hidden';
      trackAll();
    } else if (res.status === 409 && data.existingContainer) {
      showDuplicateModal(data.existingContainer);
    } else {
      msg.textContent = data.error || 'Failed to add container.';
      msg.className = 'text-[#c4002b] text-xs mt-2';
    }
  } catch(e) {
    msg.textContent = 'Network error: ' + e.message;
    msg.className = 'text-[#c4002b] text-xs mt-2';
  }
}

function showDuplicateModal(container) {
  document.getElementById('dupContainerNum').textContent = container.number || 'Unknown';
  document.getElementById('dupAddedAt').textContent = container.addedAt || '—';
  document.getElementById('dupShipmentId').textContent = container.shipmentId || '—';
  document.getElementById('duplicateModal').classList.remove('hidden');
}

function closeDuplicateModal() {
  document.getElementById('duplicateModal').classList.add('hidden');
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function sortItems(items, col, dir) {
  if (!col) return items;
  return items.slice().sort(function(a, b) {
    var av, bv;
    if (col === 'podEtaDate' || col === 'originalEta') {
      av = parseDMY(a[col]); bv = parseDMY(b[col]);
      if (!av && !bv) return 0; if (!av) return 1; if (!bv) return -1;
      return dir === 'asc' ? av - bv : bv - av;
    }
    if (col === 'receivedAt') {
      av = a[col] ? new Date(a[col] + 'T00:00:00') : null;
      bv = b[col] ? new Date(b[col] + 'T00:00:00') : null;
      if (!av && !bv) return 0; if (!av) return 1; if (!bv) return -1;
      return dir === 'asc' ? av - bv : bv - av;
    }
    if (col === 'variance') {
      av = (a.originalEta && a.receivedAt) ? Math.round((new Date(a.receivedAt + 'T00:00:00') - parseDMY(a.originalEta)) / 86400000) : null;
      bv = (b.originalEta && b.receivedAt) ? Math.round((new Date(b.receivedAt + 'T00:00:00') - parseDMY(b.originalEta)) / 86400000) : null;
      if (av === null && bv === null) return 0; if (av === null) return 1; if (bv === null) return -1;
      return dir === 'asc' ? av - bv : bv - av;
    }
    // string sort
    av = (a[col] || '').toLowerCase(); bv = (b[col] || '').toLowerCase();
    if (!av && !bv) return 0; if (!av) return 1; if (!bv) return -1;
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function updateSortIndicators(sectionName, col, dir) {
  var cols = sectionName === 'Received'
    ? ['containerNumber', 'shipmentId', 'originalEta', 'receivedAt', 'variance']
    : ['containerNumber', 'shipmentId', 'status', 'currentLocation', 'podEtaDate'];
  cols.forEach(function(c) {
    var el = document.getElementById('sort-' + sectionName + '-' + c);
    if (!el) return;
    el.textContent = (c === col) ? (dir === 'asc' ? '\u2191' : '\u2193') : '\u21C5';
    el.style.color = (c === col) ? '#262f3d' : '#c4c8cc';
  });
}

function sortSection(sectionName, colKey) {
  var state = sortState[sectionName];
  if (state.col === colKey) {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.col = colKey; state.dir = 'asc';
  }
  if (sectionName === 'Received') {
    renderReceivedSection(allReceived, true);
  } else {
    renderSection(sectionName, sectionName === 'Transit' ? allTransit : allPort, true);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderActiveRow(r) {
  var cn = r.containerNumber;
  var etaStr = r.podEtaDate || '';
  if (!r.success) {
    return '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa]">' +
      '<td class="px-4 py-3 font-mono font-semibold">' + cn + '</td>' +
      '<td class="px-4 py-3" colspan="6"><span style="color:#c4002b;font-size:0.75rem">&#9888; ' + esc(r.error || 'Unknown error') + '</span></td>' +
      '<td class="px-4 py-3">' + actionsDiv(cn, false) + '</td>' +
      '</tr>';
  }
  return '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa] transition-colors">' +
    '<td class="px-4 py-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + esc(r.containerType || '') + '</div></td>' +
    '<td class="px-4 py-3">' + shipmentCell(cn, r.shipmentId) + '</td>' +
    '<td class="px-4 py-3">' + statusBadge(r) + '</td>' +
    '<td class="px-4 py-3"><div style="color:#262f3d">' + esc(r.currentLocation || '\u2014') + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + fmtDate(r.lastEventDate) + '</div></td>' +
    '<td class="px-4 py-3">' + (r.vessel ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a;font-size:0.875rem" class="hover:underline">' + esc(r.vessel) + '</a><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + esc(r.voyage || '') + '</div>' : '<span style="color:#a9adb1">\u2014</span>') + '</td>' +
    '<td class="px-4 py-3">' + etaHtml(etaStr, r.originalEta) + '</td>' +
    '<td class="px-4 py-3">' + routeHtml(r) + '</td>' +
    '<td class="px-4 py-3 whitespace-nowrap">' + actionsDiv(cn, false) + '</td>' +
    '</tr>';
}

function renderActiveCard(r) {
  var cn = r.containerNumber;
  var card = document.createElement('div');
  card.className = 'bg-white rounded-xl p-4 shadow-sm border border-[#e6e8e8]';
  if (!r.success) {
    card.innerHTML = '<div class="flex items-center justify-between mb-2"><span class="font-mono font-semibold">' + cn + '</span>' + statusBadge(r) + '</div>' +
      '<p style="color:#c4002b;font-size:0.75rem;margin-bottom:8px">' + esc(r.error || '') + '</p>' + actionsDiv(cn, false);
  } else {
    var etaStr = r.podEtaDate || '';
    card.innerHTML =
      '<div class="flex items-center justify-between mb-3"><div><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1">' + esc(r.containerType || '') + '</div></div>' + statusBadge(r) + '</div>' +
      '<div class="grid grid-cols-2 gap-y-2 mb-3" style="font-size:0.75rem">' +
        '<span style="color:#897a6b">Shipment #</span><span>' + shipmentCell(cn, r.shipmentId) + '</span>' +
        '<span style="color:#897a6b">Location</span><span style="color:#262f3d">' + esc(r.currentLocation || '\u2014') + '</span>' +
        '<span style="color:#897a6b">Last event</span><span style="color:#262f3d">' + fmtDate(r.lastEventDate) + '</span>' +
        '<span style="color:#897a6b">Vessel</span><span>' + (r.vessel ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a">' + esc(r.vessel) + '</a>' : '\u2014') + '</span>' +
        '<span style="color:#897a6b">ETA</span><span>' + etaHtml(etaStr, r.originalEta) + '</span>' +
      '</div>' +
      '<div class="pt-3" style="border-top:1px solid #f0f1f2">' + actionsDiv(cn, false) + '</div>';
  }
  return card;
}

function renderSection(name, items, noStore) {
  if (!noStore) {
    if (name === 'Transit') allTransit = items;
    else if (name === 'Port') allPort = items;
  }
  var state = sortState[name];
  var sorted = sortItems(items, state.col, state.dir);
  var sec = document.getElementById('section' + name);
  var tbody = document.getElementById('table' + name);
  var cards = document.getElementById('cards' + name);
  document.getElementById('badge' + name).textContent = items.length;
  tbody.innerHTML = '';
  cards.innerHTML = '';
  if (!items.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  var rows = '';
  sorted.forEach(function(r) { rows += renderActiveRow(r); });
  tbody.innerHTML = rows;
  sorted.forEach(function(r) { cards.appendChild(renderActiveCard(r)); });
  updateSortIndicators(name, state.col, state.dir);
}

function renderReceivedSection(items, noStore) {
  if (!noStore) allReceived = items;
  var state = sortState['Received'];
  var sorted = sortItems(items, state.col, state.dir);
  var sec = document.getElementById('sectionReceived');
  var tbody = document.getElementById('tableReceived');
  var cards = document.getElementById('cardsReceived');
  document.getElementById('badgeReceived').textContent = items.length;
  tbody.innerHTML = '';
  cards.innerHTML = '';
  if (!items.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  var rows = '';
  sorted.forEach(function(r) {
    var cn = r.containerNumber;
    rows += '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa] transition-colors">' +
      '<td class="px-4 py-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">Added ' + fmtDateISO(r.addedAt) + '</div></td>' +
      '<td class="px-4 py-3">' + shipmentCell(cn, r.shipmentId) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDate(r.loadedAt) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDate(r.dischargedAt) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDate(r.originalEta) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDateISO(r.receivedAt) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + esc(r.receivedPort || '\u2014') + '</td>' +
      '<td class="px-4 py-3">' + etaDelta(r.originalEta, r.receivedAt) + '</td>' +
      '<td class="px-4 py-3">' + actionsDiv(cn, true) + '</td>' +
      '</tr>';
    var card = document.createElement('div');
    card.className = 'bg-white rounded-xl p-4 shadow-sm border border-[#e6e8e8] opacity-75';
    card.innerHTML =
      '<div class="flex items-center justify-between mb-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><span style="background:#e6e8e8;color:#897a6b;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600">Received</span></div>' +
      '<div class="grid grid-cols-2 gap-y-2 mb-3" style="font-size:0.75rem">' +
        '<span style="color:#897a6b">Shipment #</span><span>' + shipmentCell(cn, r.shipmentId) + '</span>' +
        '<span style="color:#897a6b">Loaded</span><span>' + fmtDate(r.loadedAt) + '</span>' +
        '<span style="color:#897a6b">Discharged</span><span>' + fmtDate(r.dischargedAt) + '</span>' +
        '<span style="color:#897a6b">Original ETA</span><span>' + fmtDate(r.originalEta) + '</span>' +
        '<span style="color:#897a6b">Received</span><span>' + fmtDateISO(r.receivedAt) + '</span>' +
        '<span style="color:#897a6b">Port Received</span><span>' + esc(r.receivedPort || '\u2014') + '</span>' +
        '<span style="color:#897a6b">Variance</span><span>' + etaDelta(r.originalEta, r.receivedAt) + '</span>' +
      '</div>' +
      '<div class="pt-3" style="border-top:1px solid #f0f1f2">' + actionsDiv(cn, true) + '</div>';
    cards.appendChild(card);
  });
  tbody.innerHTML = rows;
  updateSortIndicators('Received', state.col, state.dir);
}

// Days between an MSC event date (DD/MM/YYYY) and an ISO received date (YYYY-MM-DD).
function daysBetween(loadedStr, receivedStr) {
  var load = parseDMY(loadedStr);
  var recv = receivedStr ? new Date(receivedStr + 'T00:00:00') : null;
  if (!load || !recv || isNaN(recv)) return null;
  return Math.round((recv - load) / 86400000);
}

function renderEmbarkStats(received) {
  // Group by destination port of call, split by origin (Houston / Rotterdam) plus an All column.
  var ports = {};
  received.forEach(function(r) {
    if (!r.loadedAt || !r.receivedAt) return;
    var d = daysBetween(r.loadedAt, r.receivedAt);
    if (d === null || d < 0) return;
    var key = r.destPort || '(Unknown)';
    if (!ports[key]) ports[key] = { Houston: [], Rotterdam: [], all: [] };
    ports[key].all.push(d);
    if (r.originPort === 'Houston' || r.originPort === 'Rotterdam') ports[key][r.originPort].push(d);
  });
  function avg(arr) {
    if (!arr.length) return '<span style="color:#c4c8cc">—</span>';
    var m = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
    return m.toFixed(1) + ' <span style="font-size:0.7em;color:#a9adb1">n=' + arr.length + '</span>';
  }
  var keys = Object.keys(ports).sort(function(a, b) { return ports[b].all.length - ports[a].all.length; });
  var body = document.getElementById('embarkTableBody');
  var empty = document.getElementById('embarkEmpty');
  if (!keys.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    body.innerHTML = keys.map(function(k) {
      var p = ports[k];
      return '<tr class="border-t border-[#f0f1f2]">' +
        '<td class="text-left py-1.5 pr-3 font-semibold" style="color:#262f3d">' + esc(k) + '</td>' +
        '<td class="text-right py-1.5 px-3" style="color:#262f3d">' + avg(p.Houston) + '</td>' +
        '<td class="text-right py-1.5 px-3" style="color:#262f3d">' + avg(p.Rotterdam) + '</td>' +
        '<td class="text-right py-1.5 pl-3 font-semibold" style="color:#02579a">' + avg(p.all) + '</td>' +
        '</tr>';
    }).join('');
  }
  document.getElementById('embarkStats').classList.remove('hidden');
}

function renderResults(results) {
  var transit = [], port = [], received = [];
  results.forEach(function(r) {
    lastResults[r.containerNumber] = r;
    if (r.received) { received.push(r); return; }
    if (!r.success) { transit.push(r); return; }
    if (classifyStatus(r) === 'port') port.push(r); else transit.push(r);
  });
  document.getElementById('sumTransit').textContent = transit.length;
  document.getElementById('sumPort').textContent = port.length;
  document.getElementById('sumReceived').textContent = received.length;
  renderEmbarkStats(received);
  document.getElementById('summaryBar').classList.remove('hidden');
  document.getElementById('resultsSection').classList.remove('hidden');
  renderSection('Transit', transit);
  renderSection('Port', port);
  renderReceivedSection(received);
  document.getElementById('emptyState').classList[results.length === 0 ? 'remove' : 'add']('hidden');
  document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

// ── Track all ─────────────────────────────────────────────────────────────────

function startTimer() {
  var start = Date.now();
  var el = document.getElementById('loadingTimer');
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(function() { el.textContent = ((Date.now() - start) / 1000).toFixed(0) + 's elapsed'; }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  var el = document.getElementById('loadingTimer');
  if (el) el.textContent = '';
}

async function trackAll() {
  sortState = { Transit: { col: null, dir: 'asc' }, Port: { col: null, dir: 'asc' }, Received: { col: null, dir: 'asc' } };
  var passcode = sessionStorage.getItem('passcode') || '';
  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('summaryBar').classList.add('hidden');
  startTimer();
  try {
    var res = await fetch('/api/track', { headers: { 'X-Passcode': passcode } });
    if (res.status === 401) { sessionStorage.removeItem('passcode'); location.reload(); return; }
    if (!res.ok) throw new Error('Server returned ' + res.status);
    renderResults(await res.json());
  } catch(err) {
    alert('Tracking failed: ' + err.message);
  } finally {
    document.getElementById('loadingState').classList.add('hidden');
    stopTimer();
  }
}

// ── Received toggle ───────────────────────────────────────────────────────────

function toggleReceived() {
  receivedOpen = !receivedOpen;
  document.getElementById('receivedBody').classList[receivedOpen ? 'remove' : 'add']('hidden');
  document.getElementById('receivedChevron').style.transform = receivedOpen ? 'rotate(180deg)' : '';
}

// ── History modal ─────────────────────────────────────────────────────────────

function showHistory(cn) {
  var r = lastResults[cn];
  if (!r || !r.eventHistory) return;
  document.getElementById('modalTitle').textContent = cn + ' \u2014 Event History';
  var html = '';
  r.eventHistory.forEach(function(e) {
    html += '<div style="border-left:2px solid #d5e4f0;padding:4px 0 4px 12px">' +
      '<div style="font-weight:600;color:#262f3d">' + esc(e.description || '\u2014') + '</div>' +
      '<div style="font-size:0.7rem;color:#897a6b;margin-top:2px">' + fmtDate(e.date) + ' &nbsp;&middot;&nbsp; ' + esc(e.location || '') + '</div>' +
      (e.vessel ? '<div style="font-size:0.7rem;color:#02579a;margin-top:2px">' + esc(e.vessel) + (e.voyage ? ' / ' + esc(e.voyage) : '') + '</div>' : '') +
      '</div>';
  });
  document.getElementById('modalBody').innerHTML = html || '<p style="color:#a9adb1">No event history available.</p>';
  var modal = document.getElementById('historyModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal() {
  var modal = document.getElementById('historyModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('historyModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

async function submitPasscode() {
  var input = document.getElementById('passcodeInput');
  var btn = document.getElementById('passcodeBtn');
  var err = document.getElementById('passcodeError');
  var passcode = input.value;
  if (!passcode) return;
  btn.disabled = true;
  btn.textContent = 'Checking\u2026';
  err.classList.add('hidden');
  try {
    var res = await fetch('/api/list', { headers: { 'X-Passcode': passcode } });
    if (res.ok) {
      sessionStorage.setItem('passcode', passcode);
      initApp();
    } else {
      err.classList.remove('hidden');
      input.value = '';
      input.focus();
    }
  } catch(e) {
    err.textContent = 'Connection error. Try again.';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enter';
  }
}

function initApp() {
  document.getElementById('passcodeGate').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  loadPorts();
  checkCanary();
  trackAll();
}

// Shows a warning banner if the daily MSC health check last failed.
async function checkCanary() {
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/canary', { headers: { 'X-Passcode': passcode } });
    if (!res.ok) return;
    var s = await res.json();
    var banner = document.getElementById('canaryBanner');
    if (s && s.ok === false) {
      banner.textContent = '⚠ MSC tracking health check failed on ' + (s.lastRun || '').slice(0, 10) +
        ' — container data below may be missing or stale. Detail: ' + (s.detail || 'unknown');
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch(e) { /* banner is best-effort */ }
}

async function loadPorts() {
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var portsRes = await fetch('/api/ports', { headers: { 'X-Passcode': passcode } });
    if (portsRes.ok) {
      var ports = await portsRes.json();
      window._cachedPorts = ports;
    }
    var cpRes = await fetch('/api/current-port', { headers: { 'X-Passcode': passcode } });
    if (cpRes.ok) {
      var cpData = await cpRes.json();
      updateCurrentPortDisplay(cpData.port);
    }
  } catch(e) {
    console.error('Failed to load ports:', e);
  }
}

// ── Current Port Display ─────────────────────────────────────────────────────

function updateCurrentPortDisplay(port) {
  // Header destination tracks the app's Current Port setting (Manage Ports tab).
  // Falls back to the primary destination when no current port is set.
  var dest = document.getElementById('destPort');
  if (!dest) return;
  dest.textContent = (port && port.name) ? port.name : 'Freetown, Sierra Leone';
}

async function setCurrentPort(portId) {
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/current-port', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: JSON.stringify({ portId: portId })
    });
    if (res.ok) {
      var data = await res.json();
      updateCurrentPortDisplay(data.port);
      refreshManagementUI();
      showMsg('portsMsg', 'Current port updated', 'success');
    } else {
      showMsg('portsMsg', 'Failed to set current port', 'error');
    }
  } catch(e) {
    showMsg('portsMsg', 'Network error: ' + e.message, 'error');
  }
}

// ── Tab & Management UI ───────────────────────────────────────────────────────

function switchTab(tab) {
  var isTracker = tab === 'tracker';
  document.getElementById('trackerView').classList[isTracker ? 'remove' : 'add']('hidden');
  document.getElementById('manageView').classList[isTracker ? 'add' : 'remove']('hidden');
  
  var tabTracker = document.getElementById('tabTracker');
  var tabManage = document.getElementById('tabManage');
  
  if (isTracker) {
    tabTracker.classList.add('border-[#1e293b]');
    tabTracker.classList.add('text-[#1e293b]');
    tabTracker.classList.remove('border-transparent');
    tabTracker.classList.remove('text-[#a9adb1]');
    tabManage.classList.remove('border-[#1e293b]');
    tabManage.classList.remove('text-[#1e293b]');
    tabManage.classList.add('border-transparent');
    tabManage.classList.add('text-[#a9adb1]');
  } else {
    tabTracker.classList.remove('border-[#1e293b]');
    tabTracker.classList.remove('text-[#1e293b]');
    tabTracker.classList.add('border-transparent');
    tabTracker.classList.add('text-[#a9adb1]');
    tabManage.classList.add('border-[#1e293b]');
    tabManage.classList.add('text-[#1e293b]');
    tabManage.classList.remove('border-transparent');
    tabManage.classList.remove('text-[#a9adb1]');
    refreshManagementUI();
  }
}

async function refreshManagementUI() {
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var portsRes = await fetch('/api/ports', { headers: { 'X-Passcode': passcode } });
    var currentPort = null;
    var cpRes = await fetch('/api/current-port', { headers: { 'X-Passcode': passcode } });
    if (cpRes.ok) { var cpData = await cpRes.json(); currentPort = cpData.port; }
    if (portsRes.ok) {
      var ports = await portsRes.json();
      var html = '<div class="space-y-2">';
      ports.forEach(function(p) {
        var isCurrent = currentPort && currentPort.id === p.id;
        html += '<div class="flex items-center justify-between rounded-lg p-3 ' + (isCurrent ? 'bg-[#1e293b] text-white' : 'bg-[#f7f7f7]') + '">' +
          '<div>' +
            '<div class="font-semibold ' + (isCurrent ? 'text-white' : 'text-[#262f3d]') + '">' + esc(p.name) + (isCurrent ? ' <span style="font-size:0.65rem;font-weight:600;background:#4fc2f830;border-radius:4px;padding:1px 5px">CURRENT</span>' : '') + '</div>' +
            '<div class="text-xs ' + (isCurrent ? 'text-[#4fc2f8]' : 'text-[#a9adb1]') + '">' + esc(p.id) + ' · ' + esc(p.country) + '</div>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            (!isCurrent ? '<button onclick="setCurrentPort(&apos;' + p.id + '&apos;)" class="text-[#02579a] hover:text-[#1e293b] text-xs font-semibold">Set Current</button>' : '') +
            '<button onclick="deletePort(&apos;' + p.id + '&apos;)" class="' + (isCurrent ? 'text-[#4fc2f8]' : 'text-[#c4002b]') + ' hover:opacity-75 text-xs font-semibold">Remove</button>' +
          '</div>' +
          '</div>';
      });
      html += '</div>';
      document.getElementById('portsList').innerHTML = html;
    }
  } catch(e) {
    console.error('Failed to refresh management UI:', e);
  }
}

async function addPort() {
  var portId = (document.getElementById('newPortId').value || '').trim().toUpperCase();
  var name = (document.getElementById('newPortName').value || '').trim();
  var country = (document.getElementById('newPortCountry').value || '').trim().toUpperCase();
  if (!portId || !name || !country) {
    showMsg('portsMsg', 'Please enter UNLOCODE, port name, and country', 'error');
    return;
  }
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/ports', {
      method: 'POST',
      headers: { 'X-Passcode': passcode, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: portId, name: name, country: country })
    });
    if (res.ok) {
      document.getElementById('newPortId').value = '';
      document.getElementById('newPortName').value = '';
      document.getElementById('newPortCountry').value = '';
      showMsg('portsMsg', 'Port added', 'success');
      loadPorts();
      refreshManagementUI();
    } else {
      var err = await res.json();
      showMsg('portsMsg', err.error || 'Failed to add port', 'error');
    }
  } catch(e) {
    showMsg('portsMsg', 'Network error: ' + e.message, 'error');
  }
}

async function deletePort(portId) {
  if (!confirm('Remove this port?')) return;
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/ports?id=' + encodeURIComponent(portId), {
      method: 'DELETE', headers: { 'X-Passcode': passcode }
    });
    if (res.ok) {
      showMsg('portsMsg', 'Port removed', 'success');
      loadPorts();
      refreshManagementUI();
    } else {
      var err = null;
      try { err = await res.json(); } catch(ignored) {}
      showMsg('portsMsg', (err && err.error) || 'Failed to remove port', 'error');
    }
  } catch(e) {
    showMsg('portsMsg', 'Network error: ' + e.message, 'error');
  }
}

function showMsg(elementId, msg, type) {
  var el = document.getElementById(elementId);
  el.textContent = msg;
  el.className = 'text-xs mt-3 ' + (type === 'error' ? 'text-[#c4002b]' : 'text-[#00695b]');
  el.classList.remove('hidden');
  setTimeout(function() { el.classList.add('hidden'); }, 4000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(function boot() {
  if (sessionStorage.getItem('passcode')) initApp();
})();
</script>
</body>
</html>`;

// ─── Worker Entry Point ───────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/track') return handleTrackRequest(request, env);
    if (url.pathname === '/api/list') {
      if (request.method === 'GET') return handleListGet(request, env);
      if (request.method === 'POST') return handleListPost(request, env);
      if (request.method === 'DELETE') return handleListDelete(request, env);
    }
    if (url.pathname === '/api/receive' && request.method === 'POST') return handleReceive(request, env);
    if (url.pathname === '/api/shipment' && request.method === 'POST') return handleShipment(request, env);
    if (url.pathname === '/api/ports') return handlePorts(request, env);
    if (url.pathname === '/api/current-port') return handleCurrentPort(request, env);
    if (url.pathname === '/api/canary' && request.method === 'GET') return handleCanaryGet(request, env);
    if (url.pathname === '/api/debug' && request.method === 'GET') return handleDebug(request, env);
    if (url.pathname === '/robots.txt') return handleRobots();

    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCanary(env));
  },
};
