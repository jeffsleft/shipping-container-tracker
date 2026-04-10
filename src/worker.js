/**
 * Mercy Ships Container Tracker
 * Cloudflare Worker — serves HTML frontend and proxies to Modal.com MSC tracker
 *
 * Architecture:
 *   Browser → Cloudflare Worker (/api/track) → Modal.com Python function
 *   Modal uses curl_cffi to impersonate Chrome TLS, bypassing MSC's Akamai bot protection
 */

const MODAL_URL = 'https://jeffsleft--msc-tracker-track.modal.run';

// ─── MSC Response Parser ────────────────────────────────────────────────────

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

  // Find the most recent actual event (not estimated/intended future events)
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

// ─── Route: /api/track ────────────────────────────────────────────────────────

async function handleTrackRequest(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('containers') || '';
  const containers = raw.split(',').map(c => c.trim()).filter(Boolean).slice(0, 30);

  if (containers.length === 0) {
    return Response.json({ error: 'No container numbers provided' }, { status: 400 });
  }

  let modalResults;
  try {
    const modalRes = await fetch(
      `${MODAL_URL}?containers=${encodeURIComponent(containers.join(','))}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!modalRes.ok) {
      throw new Error('Proxy error: HTTP ' + modalRes.status);
    }
    modalResults = await modalRes.json();
  } catch (err) {
    return Response.json(
      containers.map(cn => ({ success: false, containerNumber: cn, error: 'Tracking service error: ' + err.message })),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  }

  const results = modalResults.map(item => {
    if (!item.success) {
      return { success: false, containerNumber: item.containerNumber, error: item.error || 'Unknown error' };
    }
    const parsed = parseMSCResponse(item.mscResponse, item.containerNumber);
    return { containerNumber: item.containerNumber, ...parsed };
  });

  return Response.json(results, {
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

<!-- Header -->
<header class="bg-[#002663] text-white shadow-lg">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between flex-wrap gap-2">
    <div>
      <h1 class="text-xl font-bold tracking-wide">Mercy Ships Container Tracker</h1>
      <p class="text-[#4fc2f8] text-xs mt-0.5">MSC Shipping &nbsp;·&nbsp; Houston &amp; Rotterdam &rarr; Freetown, Sierra Leone</p>
    </div>
    <div id="lastRefresh" class="text-[#4fc2f8] text-xs text-right"></div>
  </div>
</header>

<main class="max-w-6xl mx-auto px-4 py-6 space-y-5">

  <!-- Input Panel -->
  <div class="bg-white rounded-2xl shadow-sm border border-[#e6e8e8] p-5">
    <div class="flex flex-wrap gap-5">
      <div class="flex-1 min-w-56">
        <label class="block text-sm font-semibold text-[#262f3d] mb-1">Container Numbers</label>
        <textarea id="containerInput" rows="5"
          placeholder="MSDU6574161&#10;SZLU9350511&#10;MSMU4772708&#10;SEGU9785830&#10;TEMU9180974"
          class="w-full border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#002663] resize-none placeholder-[#a9adb1]"
        ></textarea>
        <p class="text-xs text-[#a9adb1] mt-1">One container number per line</p>
      </div>
      <div class="flex-1 min-w-48 flex flex-col gap-3">
        <div>
          <label class="block text-sm font-semibold text-[#262f3d] mb-1">Destination Port</label>
          <input id="destPort" value="FREETOWN, SL"
            class="w-full border border-[#e6e8e8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#002663]"
          />
          <p class="text-xs text-[#a9adb1] mt-1">Used to highlight matching ETA</p>
        </div>
        <button id="trackBtn" onclick="trackAll()"
          class="w-full bg-[#002663] hover:bg-[#02579a] active:bg-[#001a47] text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          Track Containers
        </button>
        <button id="clearBtn" onclick="clearAll()"
          class="w-full text-[#a9adb1] hover:text-[#c4002b] text-sm py-1 transition-colors">
          Clear saved list
        </button>
      </div>
    </div>
  </div>

  <!-- Summary Bar -->
  <div id="summaryBar" class="hidden grid grid-cols-2 sm:grid-cols-4 gap-3 fade-in">
    <div class="bg-white rounded-xl border border-[#e6e8e8] p-3 text-center shadow-sm">
      <div id="sumTotal" class="text-2xl font-bold text-[#262f3d]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">Total</div>
    </div>
    <div class="bg-white rounded-xl border border-[#d5e4f0] p-3 text-center shadow-sm">
      <div id="sumTransit" class="text-2xl font-bold text-[#02579a]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">In Transit</div>
    </div>
    <div class="bg-white rounded-xl border border-[#e6e8e8] p-3 text-center shadow-sm">
      <div id="sumDelivered" class="text-2xl font-bold text-[#262f3d]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">Delivered</div>
    </div>
    <div class="bg-white rounded-xl border border-[#f5d0d8] p-3 text-center shadow-sm">
      <div id="sumErrors" class="text-2xl font-bold text-[#c4002b]">0</div>
      <div class="text-xs text-[#a9adb1] mt-0.5">Errors</div>
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
  <div id="resultsSection" class="hidden fade-in">
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-semibold text-[#262f3d]">Tracking Results</h2>
      <button onclick="trackAll()" class="text-sm text-[#02579a] hover:text-[#002663] flex items-center gap-1 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        Refresh All
      </button>
    </div>

    <!-- Desktop Table -->
    <div class="hidden sm:block bg-white rounded-2xl shadow-sm border border-[#e6e8e8] overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-[#f7f7f7] border-b border-[#e6e8e8]">
          <tr>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Container</th>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Status</th>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Current Location</th>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Vessel / Voyage</th>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">ETA at Destination</th>
            <th class="text-left px-4 py-3 font-semibold text-[#897a6b] text-xs uppercase tracking-wide">Route</th>
            <th class="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>

    <!-- Mobile Cards -->
    <div id="mobileCards" class="sm:hidden space-y-3"></div>
  </div>

</main>

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

function parseDMY(str) {
  if (!str || str.length < 10) return null;
  var p = str.split('/');
  if (p.length !== 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}

function fmtDate(str) {
  var d = parseDMY(str);
  if (!d) return str || '—';
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function etaHtml(str) {
  if (!str) return '<span style="color:#a9adb1">—</span>';
  var d = parseDMY(str);
  if (!d) return '<span style="color:#897a6b">' + str + '</span>';
  var now = new Date();
  now.setHours(0,0,0,0);
  var days = Math.round((d - now) / 86400000);
  var label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days < 0) return '<span style="color:#a9adb1">' + label + '</span>';
  if (days === 0) return '<span style="color:#00695b;font-weight:600">' + label + ' (Today)</span>';
  if (days <= 7) return '<span style="color:#c46b1f;font-weight:600">' + label + ' <span style="font-size:0.75em">(' + days + 'd)</span></span>';
  if (days <= 21) return '<span style="color:#02579a">' + label + ' <span style="font-size:0.75em;color:#a9adb1">(' + days + 'd)</span></span>';
  return '<span style="color:#262f3d">' + label + ' <span style="font-size:0.75em;color:#a9adb1">(' + days + 'd)</span></span>';
}

function statusBadge(r) {
  var base = 'display:inline-block;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600;';
  if (!r.success) return '<span style="' + base + 'background:#fce8ec;color:#c4002b">Error</span>';
  if (r.delivered) return '<span style="' + base + 'background:#e6e8e8;color:#262f3d">Delivered</span>';
  var s = (r.status || '').toLowerCase();
  if (s.includes('load') || s.includes('depart') || s.includes('sail') || s.includes('transit')) {
    return '<span style="' + base + 'background:#e8eef5;color:#02579a">' + r.status + '</span>';
  }
  if (s.includes('discharg') || s.includes('arriv') || s.includes('import')) {
    return '<span style="' + base + 'background:#e6e8e8;color:#262f3d">' + r.status + '</span>';
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
  if (!r.portOfLoad) return '<span style="color:#a9adb1">—</span>';
  var route = r.portOfLoad;
  if (r.transshipments && r.transshipments.length) {
    route += ' &rarr; ' + r.transshipments.join(' &rarr; ');
  }
  route += ' &rarr; ' + (r.portOfDischarge || '?');
  return '<span style="font-size:0.75rem;color:#897a6b;line-height:1.4">' + route + '</span>';
}

function renderResults(results) {
  var tbody = document.getElementById('tableBody');
  var cards = document.getElementById('mobileCards');
  tbody.innerHTML = '';
  cards.innerHTML = '';

  var total = results.length, transit = 0, delivered = 0, errors = 0;

  results.forEach(function(r) {
    lastResults[r.containerNumber] = r;
    if (!r.success) { errors++; }
    else if (r.delivered) { delivered++; }
    else { transit++; }

    var etaStr = r.podEtaDate || '';

    var tr = document.createElement('tr');
    tr.className = 'border-b border-[#f0f1f2] hover:bg-[#fafafa] transition-colors';

    if (!r.success) {
      tr.innerHTML =
        '<td class="px-4 py-3 font-mono font-semibold" style="color:#262f3d">' + r.containerNumber + '</td>' +
        '<td class="px-4 py-3" colspan="5"><span style="color:#c4002b;font-size:0.75rem">&#9888; ' + (r.error || 'Unknown error') + '</span></td>' +
        '<td class="px-4 py-3"><a href="' + mscLink(r.containerNumber) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">MSC &#8599;</a></td>';
    } else {
      tr.innerHTML =
        '<td class="px-4 py-3">' +
          '<div class="font-mono font-semibold" style="color:#262f3d">' + r.containerNumber + '</div>' +
          '<div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + (r.containerType || '') + '</div>' +
        '</td>' +
        '<td class="px-4 py-3">' + statusBadge(r) + '</td>' +
        '<td class="px-4 py-3">' +
          '<div style="color:#262f3d">' + (r.currentLocation || '—') + '</div>' +
          '<div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + fmtDate(r.lastEventDate) + '</div>' +
        '</td>' +
        '<td class="px-4 py-3">' +
          (r.vessel
            ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a;font-size:0.875rem" class="hover:underline">' + r.vessel + '</a>' +
              '<div style="font-size:0.7rem;color:#a9adb1;margin-top:2px">' + (r.voyage || '') + '</div>'
            : '<span style="color:#a9adb1">—</span>') +
        '</td>' +
        '<td class="px-4 py-3">' + etaHtml(etaStr) + '</td>' +
        '<td class="px-4 py-3">' + routeHtml(r) + '</td>' +
        '<td class="px-4 py-3 whitespace-nowrap">' +
          '<div class="flex gap-2 items-center">' +
            '<a href="' + mscLink(r.containerNumber) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">MSC &#8599;</a>' +
            '<button onclick="showHistory(&apos;' + r.containerNumber + '&apos;)" style="color:#a9adb1;font-size:0.75rem" class="hover:underline underline">History</button>' +
          '</div>' +
        '</td>';
    }
    tbody.appendChild(tr);

    var card = document.createElement('div');
    card.className = 'bg-white rounded-xl p-4 shadow-sm';
    card.style.border = '1px solid #e6e8e8';

    if (!r.success) {
      card.innerHTML =
        '<div class="flex items-center justify-between mb-2">' +
          '<span class="font-mono font-semibold" style="color:#262f3d">' + r.containerNumber + '</span>' +
          '<span style="background:#fce8ec;color:#c4002b;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:600">Error</span>' +
        '</div>' +
        '<p style="color:#c4002b;font-size:0.75rem;margin-bottom:8px">' + (r.error || '') + '</p>' +
        '<a href="' + mscLink(r.containerNumber) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">View on MSC &#8599;</a>';
    } else {
      card.innerHTML =
        '<div class="flex items-center justify-between mb-3">' +
          '<div>' +
            '<div class="font-mono font-semibold" style="color:#262f3d">' + r.containerNumber + '</div>' +
            '<div style="font-size:0.7rem;color:#a9adb1">' + (r.containerType || '') + '</div>' +
          '</div>' +
          statusBadge(r) +
        '</div>' +
        '<div class="grid grid-cols-2 gap-y-2 mb-3" style="font-size:0.75rem">' +
          '<span style="color:#897a6b">Location</span><span style="color:#262f3d">' + (r.currentLocation || '—') + '</span>' +
          '<span style="color:#897a6b">Last event</span><span style="color:#262f3d">' + fmtDate(r.lastEventDate) + '</span>' +
          '<span style="color:#897a6b">Vessel</span>' +
          '<span>' + (r.vessel
            ? '<a href="' + vesselLink(r.vesselIMO, r.vessel) + '" target="_blank" style="color:#02579a" class="hover:underline">' + r.vessel + '</a>'
            : '<span style="color:#a9adb1">—</span>') + '</span>' +
          '<span style="color:#897a6b">ETA</span><span>' + etaHtml(etaStr) + '</span>' +
        '</div>' +
        '<div class="flex gap-3 pt-3" style="border-top:1px solid #f0f1f2">' +
          '<a href="' + mscLink(r.containerNumber) + '" target="_blank" style="color:#02579a;font-size:0.75rem" class="hover:underline">MSC Tracking &#8599;</a>' +
          '<button onclick="showHistory(&apos;' + r.containerNumber + '&apos;)" style="color:#a9adb1;font-size:0.75rem" class="hover:underline underline">Event History</button>' +
        '</div>';
    }
    cards.appendChild(card);
  });

  document.getElementById('sumTotal').textContent = total;
  document.getElementById('sumTransit').textContent = transit;
  document.getElementById('sumDelivered').textContent = delivered;
  document.getElementById('sumErrors').textContent = errors;
  document.getElementById('summaryBar').classList.remove('hidden');
  document.getElementById('resultsSection').classList.remove('hidden');
  document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function getContainerList() {
  return (document.getElementById('containerInput').value || '')
    .split('\\n')
    .map(function(c) { return c.trim().toUpperCase(); })
    .filter(function(c) { return c.length > 0; });
}

function startTimer() {
  var start = Date.now();
  var el = document.getElementById('loadingTimer');
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(function() {
    var s = ((Date.now() - start) / 1000).toFixed(0);
    el.textContent = s + 's elapsed';
  }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  document.getElementById('loadingTimer').textContent = '';
}

async function trackAll() {
  var containers = getContainerList();
  if (!containers.length) { alert('Please enter at least one container number.'); return; }

  localStorage.setItem('mercyships_containers', document.getElementById('containerInput').value);
  localStorage.setItem('mercyships_dest', document.getElementById('destPort').value);

  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('summaryBar').classList.add('hidden');
  document.getElementById('trackBtn').disabled = true;
  startTimer();

  try {
    var url = '/api/track?containers=' + encodeURIComponent(containers.join(','));
    var res = await fetch(url);
    if (!res.ok) throw new Error('Server returned ' + res.status);
    var results = await res.json();
    renderResults(results);
  } catch (err) {
    alert('Tracking failed: ' + err.message + '\\n\\nPlease try again or check msc.com directly.');
  } finally {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('trackBtn').disabled = false;
    stopTimer();
  }
}

function showHistory(cn) {
  var r = lastResults[cn];
  if (!r || !r.eventHistory) return;
  document.getElementById('modalTitle').textContent = cn + ' — Event History';
  var html = '';
  r.eventHistory.forEach(function(e) {
    html +=
      '<div style="border-left:2px solid #d5e4f0;padding:4px 0 4px 12px">' +
        '<div style="font-weight:600;color:#262f3d">' + (e.description || '—') + '</div>' +
        '<div style="font-size:0.7rem;color:#897a6b;margin-top:2px">' + fmtDate(e.date) + ' &nbsp;·&nbsp; ' + (e.location || '') + '</div>' +
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

function clearAll() {
  // Single-click clear — no confirm needed since list can be retyped
  localStorage.removeItem('mercyships_containers');
  localStorage.removeItem('mercyships_dest');
  document.getElementById('containerInput').value = '';
  document.getElementById('destPort').value = 'FREETOWN, SL';
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('summaryBar').classList.add('hidden');
  document.getElementById('clearBtn').textContent = 'Cleared';
  setTimeout(function() {
    document.getElementById('clearBtn').textContent = 'Clear saved list';
  }, 2000);
}

(function init() {
  var saved = localStorage.getItem('mercyships_containers');
  if (saved) document.getElementById('containerInput').value = saved;
  var savedDest = localStorage.getItem('mercyships_dest');
  if (savedDest) document.getElementById('destPort').value = savedDest;
  if (saved && saved.trim()) trackAll();
})();
</script>
</body>
</html>`;

// ─── Worker Entry Point ───────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/track') {
      return handleTrackRequest(request);
    }

    if (url.pathname === '/robots.txt') {
      return handleRobots();
    }

    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  },
};
