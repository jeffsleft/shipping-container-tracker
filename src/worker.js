/**
 * Mercy Ships Container Tracker
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
    portOfLoad: gi.PortOfLoad || gi.ShippedFrom || '',
    portOfDischarge: gi.PortOfDischarge || gi.ShippedTo || '',
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
  const number = (body.number || '').trim().toUpperCase();
  if (!number) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  if (containers.find(function(c) { return c.number === number; })) {
    return Response.json({ error: 'Container already in list' }, { status: 409 });
  }
  const today = new Date().toISOString().slice(0, 10);
  containers.push({ number: number, addedAt: today, originalEta: null, received: false, receivedAt: null });
  await saveContainers(env, containers);
  return Response.json({ success: true });
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
  if (!number) return Response.json({ error: 'Container number required' }, { status: 400 });

  const containers = await getContainers(env);
  const c = containers.find(function(c) { return c.number === number; });
  if (!c) return Response.json({ error: 'Container not found' }, { status: 404 });

  c.received = true;
  c.receivedAt = receivedAt;
  await saveContainers(env, containers);
  return Response.json({ success: true });
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
    };
  });

  if (active.length === 0) {
    return Response.json(receivedResults, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  let modalResults;
  try {
    const modalRes = await fetch(
      MODAL_URL + '?containers=' + encodeURIComponent(active.map(function(c) { return c.number; }).join(',')),
      { headers: { 'Accept': 'application/json' } }
    );
    if (!modalRes.ok) throw new Error('Proxy error: HTTP ' + modalRes.status);
    modalResults = await modalRes.json();
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

    return Object.assign({}, parsed, {
      containerNumber: item.containerNumber,
      received: false,
      originalEta: kvEntry ? kvEntry.originalEta : null,
      addedAt: kvEntry ? kvEntry.addedAt : null,
    });
  });

  if (needsKvUpdate) {
    await saveContainers(env, storedList);
  }

  return Response.json(activeResults.concat(receivedResults), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── Route: /robots.txt ───────────────────────────────────────────────────────

function handleRobots() {
  return new Response('User-agent: *\nDisallow: /', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Mercy Ships Container Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: 'Open Sans', sans-serif; }
  .spinner { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .fade-in { animation: fadeIn 0.3s ease-in; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
</style>
</head>
<body class="bg-[#f2f3f4] min-h-screen text-[#262f3d]">

<!-- Passcode Gate -->
<div id="passcodeGate" class="fixed inset-0 bg-[#002663] z-50 flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
    <div class="text-center mb-6">
      <div class="text-[#002663] font-bold text-2xl tracking-wide">Mercy Ships</div>
      <div class="text-[#897a6b] text-sm mt-1">Container Tracker</div>
    </div>
    <div class="space-y-3">
      <input type="password" id="passcodeInput"
        placeholder="Enter passcode"
        class="w-full border border-[#e6e8e8] rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#002663]"
        onkeydown="if(event.key==='Enter')submitPasscode()"
      />
      <button onclick="submitPasscode()" id="passcodeBtn"
        class="w-full bg-[#002663] hover:bg-[#02579a] active:bg-[#001a47] text-white font-semibold py-3 rounded-lg text-sm transition-colors">
        Enter
      </button>
      <div id="passcodeError" class="hidden text-center text-[#c4002b] text-xs pt-1">Incorrect passcode. Try again.</div>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="mainApp" class="hidden">

<header class="bg-[#002663] text-white shadow-lg">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between flex-wrap gap-2">
    <div>
      <h1 class="text-xl font-bold tracking-wide">Mercy Ships Container Tracker</h1>
      <p class="text-[#4fc2f8] text-xs mt-0.5">MSC Shipping &nbsp;&middot;&nbsp; Houston &amp; Rotterdam &rarr; Freetown, Sierra Leone</p>
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
        placeholder="e.g. MSDU6574161"
        style="text-transform:uppercase"
        class="flex-1 border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#002663] placeholder-[#a9adb1]"
        onkeydown="if(event.key==='Enter')addContainer()"
      />
      <button onclick="addContainer()"
        class="bg-[#002663] hover:bg-[#02579a] active:bg-[#001a47] text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors whitespace-nowrap">
        + Add
      </button>
    </div>
    <div id="addMsg" class="hidden text-xs mt-2"></div>
  </div>

  <!-- Summary -->
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

  <!-- Loading -->
  <div id="loadingState" class="hidden">
    <div class="bg-white rounded-2xl border border-[#e6e8e8] shadow-sm p-10 text-center">
      <svg class="spinner inline w-10 h-10 mb-4" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#e6e8e8" stroke-width="3"/>
        <path d="M12 2a10 10 0 0 1 10 10" stroke="#002663" stroke-width="3" stroke-linecap="round"/>
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
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Container</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Status</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Location</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Vessel / Voyage</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">ETA</th>
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
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Container</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Status</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Location</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Vessel / Voyage</th>
              <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">ETA</th>
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
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Container</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Original ETA</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Date Received</th>
                <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Variance</th>
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
</main>
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

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDMY(str) {
  if (!str || str.length < 10) return null;
  var p = str.split('/');
  if (p.length !== 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}

function fmtDate(str) {
  var d = parseDMY(str);
  if (!d) return str || '\u2014';
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
}

function fmtDateISO(str) {
  if (!str) return '\u2014';
  var d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
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
  if (!d) return '<span style="color:#897a6b">' + str + '</span>';
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
  var s = (r.status || '').toLowerCase();
  if (s.includes('discharg') || s.includes('import') || s.includes('arriv')) return 'port';
  return 'transit';
}

function statusBadge(r) {
  var base = 'display:inline-block;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600;';
  if (!r.success) return '<span style="' + base + 'background:#fce8ec;color:#c4002b">Error</span>';
  var s = (r.status || '').toLowerCase();
  if (s.includes('load') || s.includes('depart') || s.includes('sail') || s.includes('transit')) {
    return '<span style="' + base + 'background:#e8eef5;color:#02579a">' + r.status + '</span>';
  }
  if (s.includes('discharg') || s.includes('arriv') || s.includes('import')) {
    return '<span style="' + base + 'background:#fdf3e8;color:#c46b1f">' + r.status + '</span>';
  }
  if (s.includes('transship') || s.includes('transfer') || s.includes('customs') || s.includes('gate')) {
    return '<span style="' + base + 'background:#fdf3e8;color:#c46b1f">' + r.status + '</span>';
  }
  return '<span style="' + base + 'background:#f0efee;color:#897a6b">' + (r.status || 'Unknown') + '</span>';
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
  return '<span style="font-size:0.75rem;color:#897a6b;line-height:1.4">' + route + '</span>';
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

// ── Receive prompt ────────────────────────────────────────────────────────────

function showReceivePrompt(cn) {
  var today = new Date().toISOString().split('T')[0];
  var html = '<div class="flex items-center gap-1 flex-wrap">' +
    '<input type="date" class="rdate-' + cn + '" value="' + today + '" style="border:1px solid #e6e8e8;border-radius:6px;padding:2px 6px;font-size:0.75rem" />' +
    ' <button onclick="confirmReceived(&apos;' + cn + '&apos;)" style="background:#002663;color:#fff;font-size:0.7rem;padding:3px 10px;border-radius:6px;font-weight:600">Confirm</button>' +
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
  var date = dateInputs.length ? dateInputs[0].value : new Date().toISOString().split('T')[0];
  var passcode = sessionStorage.getItem('passcode') || '';
  try {
    var res = await fetch('/api/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: JSON.stringify({ number: cn, receivedAt: date })
    });
    if (res.ok) { trackAll(); }
    else { alert('Failed to mark as received. Please try again.'); }
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
    if (res.ok) { trackAll(); }
    else { alert('Failed to remove container.'); }
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
    } else {
      msg.textContent = data.error || 'Failed to add container.';
      msg.className = 'text-[#c4002b] text-xs mt-2';
    }
  } catch(e) {
    msg.textContent = 'Network error: ' + e.message;
    msg.className = 'text-[#c4002b] text-xs mt-2';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderActiveRow(r) {
  var cn = r.containerNumber;
  var etaStr = r.podEtaDate || '';
  if (!r.success) {
    return '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa]">' +
      '<td class="px-4 py-3 font-mono font-semibold">' + cn + '</td>' +
      '<td class="px-4 py-3" colspan="5"><span style="color:#c4002b;font-size:0.75rem">&#9888; ' + (r.error || 'Unknown error') + '</span></td>' +
      '<td class="px-4 py-3">' + actionsDiv(cn, false) + '</td>' +
      '</tr>';
  }
  return '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa] transition-colors">' +
    '<td class="px-4 py-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + (r.containerType || '') + '</div></td>' +
    '<td class="px-4 py-3">' + statusBadge(r) + '</td>' +
    '<td class="px-4 py-3"><div style="color:#262f3d">' + (r.currentLocation || '\u2014') + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + fmtDate(r.lastEventDate) + '</div></td>' +
    '<td class="px-4 py-3">' + (r.vessel ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a;font-size:0.875rem" class="hover:underline">' + r.vessel + '</a><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + (r.voyage || '') + '</div>' : '<span style="color:#a9adb1">\u2014</span>') + '</td>' +
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
      '<p style="color:#c4002b;font-size:0.75rem;margin-bottom:8px">' + (r.error || '') + '</p>' + actionsDiv(cn, false);
  } else {
    var etaStr = r.podEtaDate || '';
    card.innerHTML =
      '<div class="flex items-center justify-between mb-3"><div><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1">' + (r.containerType || '') + '</div></div>' + statusBadge(r) + '</div>' +
      '<div class="grid grid-cols-2 gap-y-2 mb-3" style="font-size:0.75rem">' +
        '<span style="color:#897a6b">Location</span><span style="color:#262f3d">' + (r.currentLocation || '\u2014') + '</span>' +
        '<span style="color:#897a6b">Last event</span><span style="color:#262f3d">' + fmtDate(r.lastEventDate) + '</span>' +
        '<span style="color:#897a6b">Vessel</span><span>' + (r.vessel ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a">' + r.vessel + '</a>' : '\u2014') + '</span>' +
        '<span style="color:#897a6b">ETA</span><span>' + etaHtml(etaStr, r.originalEta) + '</span>' +
      '</div>' +
      '<div class="pt-3" style="border-top:1px solid #f0f1f2">' + actionsDiv(cn, false) + '</div>';
  }
  return card;
}

function renderSection(name, items) {
  var sec = document.getElementById('section' + name);
  var tbody = document.getElementById('table' + name);
  var cards = document.getElementById('cards' + name);
  document.getElementById('badge' + name).textContent = items.length;
  tbody.innerHTML = '';
  cards.innerHTML = '';
  if (!items.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  var rows = '';
  items.forEach(function(r) { rows += renderActiveRow(r); });
  tbody.innerHTML = rows;
  items.forEach(function(r) { cards.appendChild(renderActiveCard(r)); });
}

function renderReceivedSection(items) {
  var sec = document.getElementById('sectionReceived');
  var tbody = document.getElementById('tableReceived');
  var cards = document.getElementById('cardsReceived');
  document.getElementById('badgeReceived').textContent = items.length;
  tbody.innerHTML = '';
  cards.innerHTML = '';
  if (!items.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  var rows = '';
  items.forEach(function(r) {
    var cn = r.containerNumber;
    rows += '<tr class="border-b border-[#f0f1f2] hover:bg-[#fafafa] transition-colors">' +
      '<td class="px-4 py-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">Added ' + fmtDateISO(r.addedAt) + '</div></td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDate(r.originalEta) + '</td>' +
      '<td class="px-4 py-3" style="color:#262f3d">' + fmtDateISO(r.receivedAt) + '</td>' +
      '<td class="px-4 py-3">' + etaDelta(r.originalEta, r.receivedAt) + '</td>' +
      '<td class="px-4 py-3">' + actionsDiv(cn, true) + '</td>' +
      '</tr>';
    var card = document.createElement('div');
    card.className = 'bg-white rounded-xl p-4 shadow-sm border border-[#e6e8e8] opacity-75';
    card.innerHTML =
      '<div class="flex items-center justify-between mb-3"><div class="font-mono font-semibold" style="color:#262f3d">' + cn + '</div><span style="background:#e6e8e8;color:#897a6b;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600">Received</span></div>' +
      '<div class="grid grid-cols-2 gap-y-2 mb-3" style="font-size:0.75rem">' +
        '<span style="color:#897a6b">Original ETA</span><span>' + fmtDate(r.originalEta) + '</span>' +
        '<span style="color:#897a6b">Received</span><span>' + fmtDateISO(r.receivedAt) + '</span>' +
        '<span style="color:#897a6b">Variance</span><span>' + etaDelta(r.originalEta, r.receivedAt) + '</span>' +
      '</div>' +
      '<div class="pt-3" style="border-top:1px solid #f0f1f2">' + actionsDiv(cn, true) + '</div>';
    cards.appendChild(card);
  });
  tbody.innerHTML = rows;
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
      '<div style="font-weight:600;color:#262f3d">' + (e.description || '\u2014') + '</div>' +
      '<div style="font-size:0.7rem;color:#897a6b;margin-top:2px">' + fmtDate(e.date) + ' &nbsp;&middot;&nbsp; ' + (e.location || '') + '</div>' +
      (e.vessel ? '<div style="font-size:0.7rem;color:#02579a;margin-top:2px">' + e.vessel + (e.voyage ? ' / ' + e.voyage : '') + '</div>' : '') +
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
  trackAll();
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
    if (url.pathname === '/robots.txt') return handleRobots();

    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  },
};
