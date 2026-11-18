'use strict';

// Depends on core.js (window.VPF) for all pricing / ranking / link logic.
const {
  getTimeInfo, getMeterStatus, rateToColor, maxStraightMeters, haversine, parseLatLng,
  parseWhenInput, formatClock, rankMeters, rankLots, formatCoords, mapsDriveUrl, mapsWalkUrl,
  formatMoney, meterLabel, buildPhotonUrl, formatPhotonResults, groupBlocks, resolveBlocks, meterSchedule, blockSchedule, blockTitle, meterName,
} = window.VPF;

// ─── Config ────────────────────────────────────────────────────────────────
// Free vector tiles, no API key: https://openfreemap.org  (styles: liberty, bright, positron)
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '© <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// Static data is rebuilt weekly by .github/workflows/refresh-data.yml (scripts/build_data.py).
const DATA_URLS = { meters: 'data/meters.json', tickets: 'data/tickets.json', lots: 'data/lots.json', blocks: 'data/blocks.json', meta: 'data/meta.json' };
// Fallback only (used if data/meters.json is missing, e.g. before the first weekly run)
const LIVE_METERS_EXPORT = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/parking-meters/exports/json?timezone=America/Vancouver';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const VANCOUVER_CENTER = { lat: 49.2827, lng: -123.1207 };
const SEARCH_VIEWBOX = '-123.27,49.32,-123.02,49.19'; // left,top,right,bottom
const FRESH = new URLSearchParams(location.search).has('fresh'); // ?fresh=1 bypasses the weekly cache

// ─── State ─────────────────────────────────────────────────────────────────
let map = null;
let meterLayer = null, ticketLayer = null, lotLayer = null, destLayer = null, resultLayer = null;
let zonesLayer = null, userMarker = null;
let blockByMeter = new Map(), allBlocks = null, allMeters = [], allLots = [], ticketData = { year: null, hotspots: [] }, dataMeta = null;
let currentTimeInfo = null;
let activeFilter = null;
let showZones = true, showTickets = false, showLots = false;
let dest = null; // { lat, lon, label }
let pinMode = false;
let settings = { walkMin: 10, stayHours: 2 };
let lastResults = null;
let canvasRenderer = null;
let statusTimer = null;
let selectedMarker = null; // circle marker currently highlighted

const $ = id => document.getElementById(id);
const COLOR_HEX = { green: '#34a853', yellow: '#fbbc04', red: '#ea4335', grey: '#9e9e9e' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Status toast (loading progress + errors) ──────────────────────────────
function setStatus(msg, { error = false, sticky = false } = {}) {
  const el = $('status');
  if (!el) return;
  clearTimeout(statusTimer);
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  if (!sticky) statusTimer = setTimeout(() => el.classList.add('hidden'), error ? 6000 : 3000);
}

// ─── Data loading ──────────────────────────────────────────────────────────
async function getJSON(url, { optional = false } = {}) {
  try {
    const res = await fetch(FRESH ? `${url}?fresh=1` : url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  }
}

// Fallback when data/meters.json doesn't exist yet: one bulk request instead of ~38 sequential pages.
async function fetchMetersLive() {
  setStatus('Loading live City data (slow)…', { sticky: true });
  const res = await fetch(LIVE_METERS_EXPORT);
  if (!res.ok) throw new Error(`City API error ${res.status}`);
  return res.json();
}

async function loadData() {
  setStatus('Loading parking data…', { sticky: true });
  const [meta, meters, tickets, lots, blocks] = await Promise.all([
    getJSON(DATA_URLS.meta, { optional: true }),
    getJSON(DATA_URLS.meters, { optional: true }),
    getJSON(DATA_URLS.tickets, { optional: true }),
    getJSON(DATA_URLS.lots, { optional: true }),
    getJSON(DATA_URLS.blocks, { optional: true }),
  ]);
  dataMeta = meta;
  allMeters = meters || await fetchMetersLive();
  if (tickets && Array.isArray(tickets.hotspots)) ticketData = tickets;
  if (Array.isArray(lots)) allLots = lots;
  allBlocks = Array.isArray(blocks) && blocks.length ? blocks : null;
  blockByMeter = new Map();
  (allBlocks || []).forEach(b => b.m.forEach(id => blockByMeter.set(String(id), b)));
  updateDataNote(!!meters);
  setStatus(`${allMeters.length.toLocaleString()} meters loaded`);
}

function updateDataNote(fromStatic) {
  const el = $('data-note');
  if (!el) return;
  const when = dataMeta && dataMeta.generated_at
    ? new Date(dataMeta.generated_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const bits = [
    fromStatic ? `Weekly snapshot${when ? ` from ${when}` : ''}.` : 'Live City data (no weekly snapshot found yet).',
    `${allMeters.length.toLocaleString()} meters, ${allLots.length.toLocaleString()} lots, ${ticketData.hotspots.length} ticket hotspots${ticketData.year ? ` (${ticketData.year})` : ''}.`,
  ];
  if (dataMeta && dataMeta.warnings && dataMeta.warnings.length) bits.push(`Last refresh warnings: ${dataMeta.warnings.map(esc).join('; ')}`);
  bits.push('Rates change annually; check the meter or pay station.');
  el.innerHTML = bits.join(' ');
}

// ─── Map ───────────────────────────────────────────────────────────────────
function markerRadius() {
  return Math.max(2.5, Math.min(8, map.getZoom() - 9.5));
}

function initMap() {
  canvasRenderer = L.canvas({ padding: 0.5 });
  map = L.map('map', { zoomControl: false, preferCanvas: true, renderer: canvasRenderer, maxZoom: 19 })
    .setView([VANCOUVER_CENTER.lat, VANCOUVER_CENTER.lng], 14);

  try {
    L.maplibreGL({
      style: BASEMAP_STYLE,
      attributionControl: { customAttribution: BASEMAP_ATTRIBUTION },
    }).addTo(map);
  } catch (e) {
    console.error('Basemap failed', e);
    setStatus('Basemap needs WebGL; markers still work.', { error: true });
  }

  L.control.zoom({ position: 'topright' }).addTo(map);

  meterLayer = L.layerGroup().addTo(map);
  ticketLayer = L.layerGroup();
  lotLayer = L.layerGroup();
  destLayer = L.layerGroup().addTo(map);
  resultLayer = L.layerGroup().addTo(map);

  map.on('click', e => {
    if (pickIfPinning(e)) return;
    $('info-panel').classList.add('hidden');
    selectMarker(null);
    clearHighlight();
  });

  map.on('zoomend', () => {
    const r = markerRadius();
    meterLayer.eachLayer(m => m.setRadius(r));
    if (highlightLatLng) highlightAt(highlightLatLng[0], highlightLatLng[1]);
    ticketLayer.eachLayer(m => m.setRadius(r + (m._extra || 0)));
  });

  setupChips();
  setupSearch();
  setupLocateButton();
  setupPanels();
  startClock();
  trackStackHeight();
  loadZones();

  loadData()
    .then(() => { renderMarkers(); renderLots(); renderTickets(); })
    .catch(err => { console.error(err); setStatus(`Could not load parking data: ${err.message}`, { error: true }); });
}

// Keep right-hand map controls below the top stack whatever its height is.
function trackStackHeight() {
  const stack = $('top-stack');
  const apply = () => document.documentElement.style.setProperty('--stack-h', `${Math.ceil(stack.getBoundingClientRect().bottom)}px`);
  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(stack);
  window.addEventListener('resize', apply);
}

// ─── Marker selection (blue ring on the tapped dot) ────────────────────────
function selectMarker(marker) {
  if (selectedMarker && selectedMarker._orig) selectedMarker.setStyle(selectedMarker._orig);
  selectedMarker = null;
  if (marker && marker.setStyle) {
    const o = marker.options;
    marker._orig = { color: o.color, weight: o.weight, fillOpacity: o.fillOpacity, opacity: o.opacity };
    marker.setStyle({ color: '#1a73e8', weight: 2.5, fillOpacity: 1, opacity: 1 });
    selectedMarker = marker;
  }
}

// ─── Meter markers ─────────────────────────────────────────────────────────
// Phones/tablets have no hover: they get the same information from tapping (the info panel).
const CAN_HOVER = window.matchMedia && window.matchMedia('(hover: hover)').matches;

function meterTitle(meter) {
  return meterName(blockByMeter.get(String(meter.meter_id)), meter.meter_id);
}

function scheduleHtml(lines, name) {
  const title = name && name.title, subline = name && name.sub;
  return `<div class="sched">${title ? `<b>${esc(title)}</b>` : ''}${subline ? `<div class="sched-sub">${esc(subline)}</div>` : ''}${lines.map(l => `<div class="${l.extra ? 'extra' : ''}"><span>${esc(l.label)}</span> ${esc(l.text)}</div>`).join('')}</div>`;
}

// Dots are semi-transparent so street names on the basemap stay readable underneath.
const DOT_FILL_OPACITY = 0.85;

function renderMarkers() {
  selectedMarker = null; // layer is rebuilt below
  meterLayer.clearLayers();
  currentTimeInfo = getTimeInfo(new Date());
  const radius = markerRadius();
  const maxM = dest ? maxStraightMeters(settings.walkMin) : null;

  for (const meter of allMeters) {
    const geo = meter.geo_point_2d;
    if (!geo || !geo.lat || !geo.lon) continue;
    const status = getMeterStatus(meter, currentTimeInfo);
    if (activeFilter !== null && status.color !== activeFilter) continue;
    // with a destination, meters outside the walking radius fade back
    const near = maxM === null || haversine(dest.lat, dest.lon, geo.lat, geo.lon) <= maxM;
    const marker = L.circleMarker([geo.lat, geo.lon], {
      renderer: canvasRenderer,
      radius,
      fillColor: COLOR_HEX[status.color] || COLOR_HEX.grey,
      fillOpacity: near ? DOT_FILL_OPACITY : 0.1,
      color: '#ffffff',
      weight: near ? 1 : 0.5,
      opacity: near ? 0.7 : 0.25,
    }).addTo(meterLayer);
    if (CAN_HOVER) marker.bindTooltip(scheduleHtml(meterSchedule(meter), meterTitle(meter)), { sticky: true, className: 'sched-tip', direction: 'top', opacity: 1 });
    marker.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (pickIfPinning(e)) return;
      selectMarker(marker);
      highlightAt(geo.lat, geo.lon);
      showPanel(meter, status, [geo.lat, geo.lon]);
    });
  }
}

// One glowing ring that marks the meter you tapped / picked. It lives in its own pane so it stays
// visible (and keeps pulsing) when the meter layer is redrawn on zoom or time change.
let highlightRing = null, highlightLatLng = null;

function highlightAt(lat, lon) {
  highlightLatLng = [lat, lon];
  if (!map.getPane('hl')) {
    const p = map.createPane('hl');
    p.style.zIndex = 450;
    p.style.pointerEvents = 'none';
  }
  const r = markerRadius() + 8;
  if (!highlightRing) {
    highlightRing = L.circleMarker(highlightLatLng, {
      pane: 'hl', renderer: L.svg({ pane: 'hl' }), interactive: false, className: 'hl-ring',
      radius: r, color: '#1a73e8', weight: 3, fillColor: '#1a73e8', fillOpacity: 0.22,
    }).addTo(map);
  } else {
    highlightRing.setLatLng(highlightLatLng).setRadius(r);
    if (!map.hasLayer(highlightRing)) highlightRing.addTo(map);
  }
}

function clearHighlight() {
  highlightLatLng = null;
  if (highlightRing && map.hasLayer(highlightRing)) map.removeLayer(highlightRing);
  document.querySelectorAll('.res-card.selected').forEach(el => el.classList.remove('selected'));
}

// Pick one result: ring on its meter + highlighted card (works from a card tap or a numbered map marker)
function pickResult(cardId, lat, lon) {
  clearHighlight();
  highlightAt(lat, lon);
  const el = $(cardId);
  if (el) el.classList.add('selected');
}

// ─── Info panel ────────────────────────────────────────────────────────────
function positionPanel(latlng) {
  const panel = $('info-panel');
  if (window.innerWidth >= 768) {
    const point = map.latLngToContainerPoint(latlng);
    const mapW = $('map').offsetWidth;
    const panelW = 280;
    let left = point.x + 20;
    if (left + panelW > mapW - 12) left = point.x - panelW - 20;
    if (left < 12) left = 12;
    const top = Math.max(80, point.y - 44);
    panel.style.cssText = `left:${left}px;top:${top}px;bottom:auto;right:auto;width:${panelW}px;`;
    panel.dataset.mode = 'desktop';
  } else {
    panel.style.cssText = '';
    delete panel.dataset.mode;
  }
}

function openPanel(tier, html, latlng) {
  const panel = $('info-panel');
  panel.dataset.tier = tier;
  $('panel-content').innerHTML = html;
  positionPanel(latlng);
  panel.classList.remove('hidden');
}

function linksHtml(lat, lon) {
  return `<div class="res-actions">
    <a class="btn primary" href="${mapsDriveUrl(lat, lon)}" target="_blank" rel="noopener">Open in Google Maps</a>
    <button class="btn" type="button" data-copy="${formatCoords(lat, lon)}">Copy ${formatCoords(lat, lon)}</button>
  </div>`;
}

function showPanel(meter, status, latlng, blockMeters) {
  const nm = meterTitle(meter);
  openPanel(status.color, `
    <div class="panel-header">
      <span class="panel-meter-id">${esc(nm.title)}</span>
      <span class="panel-rate-big">${esc(status.rate)}${status.rawRate ? '/hr' : ''}</span>
    </div>
    ${nm.sub ? `<div class="panel-sub">${esc(nm.sub)}</div>` : ''}
    ${scheduleHtml(blockMeters ? blockSchedule(blockMeters) : meterSchedule(meter), null)}
    <div class="panel-sub">Pay by phone (PayByPhone app) or at the meter. Free 10pm–9am.</div>
    ${linksHtml(latlng[0], latlng[1])}`, latlng);
}

function showTicketPanel(h, latlng) {
  openPanel('ticket', `
    <div class="panel-header">
      <span class="panel-meter-id">${esc(h.block)} ${esc(h.street)}</span>
      <span class="panel-ticket-tag">Tickets</span>
    </div>
    <div class="panel-sub">${h.count.toLocaleString()} tickets in ${esc(ticketData.year)} on this block (metered-parking and time-limit violations where available).</div>`, latlng);
}

function showLotPanel(lot, latlng) {
  openPanel('grey', `
    <div class="panel-header">
      <span class="panel-meter-id">${esc(lot.name)}</span>
      <span class="panel-rate-big">${lot.rate_per_hr ? `$${lot.rate_per_hr.toFixed(2)}/hr` : 'Rate: check'}</span>
    </div>
    <div class="panel-sub">${esc([lot.operator, lot.parking, lot.address].filter(Boolean).join(' · ')) || 'Off-street lot'}</div>
    ${linksHtml(latlng[0], latlng[1])}`, latlng);
}

function showZonePanel(zone, latlng) {
  const label = { RPO: 'Resident Parking Only', RPP: 'Residential Parking Permit', VRPP: 'Vancouver Resident Parking Permit' }[zone] || zone;
  openPanel(`zone-${zone.toLowerCase()}`, `
    <div class="panel-header"><span class="panel-meter-id">${esc(label)}</span></div>
    <div class="panel-sub">${zone === 'RPO'
      ? 'Parking reserved for residents (the City stopped issuing RPO signs in 2010 and is converting these blocks to permit parking or removing them). Obey the posted sign.'
      : 'Without a permit you are limited to the time on the sign (typically 2 hours) during the restricted hours; permit holders can park any time.'}</div>
    <div class="panel-sub">Restricted hours are set block by block and aren\'t in the City\'s open data. Check the sign (one example the City gives: Mon–Sat 8am–8pm). Vehicles with a SPARC accessible placard may stay up to 3 hours.</div>`, latlng);
}

// ─── Chips / overlays ──────────────────────────────────────────────────────
function setupChips() {
  document.querySelectorAll('.chip[data-type="price"]').forEach(chip => {
    chip.addEventListener('click', () => {
      const color = chip.dataset.color;
      if (activeFilter === color) {
        activeFilter = null;
        document.querySelectorAll('.chip[data-type="price"]').forEach(c => c.classList.add('active'));
      } else {
        activeFilter = color;
        document.querySelectorAll('.chip[data-type="price"]').forEach(c => c.classList.toggle('active', c.dataset.color === color));
      }
      renderMarkers();
    });
  });

  const toggle = (type, get, set, after) => {
    const chip = document.querySelector(`.chip[data-type="${type}"]`);
    if (!chip) return;
    chip.classList.toggle('active', get());
    chip.addEventListener('click', () => { set(!get()); chip.classList.toggle('active', get()); after(); });
  };
  toggle('zones', () => showZones, v => { showZones = v; }, toggleZones);
  toggle('ticket', () => showTickets, v => { showTickets = v; }, renderTickets);
  toggle('lots', () => showLots, v => { showLots = v; }, renderLots);
}

// Permit zones
const ZONE_STYLE = {
  RPO:  { color: '#e65100', fillColor: '#ff6d00', fillOpacity: 0.15, weight: 1.5 },
  RPP:  { color: '#1565c0', fillColor: '#1e88e5', fillOpacity: 0.15, weight: 1.5 },
  VRPP: { color: '#6a1b9a', fillColor: '#ab47bc', fillOpacity: 0.15, weight: 1.5 },
};

async function loadZones() {
  try {
    const res = await fetch('parking_zones.geojson');
    const geojson = await res.json();
    zonesLayer = L.geoJSON(geojson, {
      style: f => ZONE_STYLE[f.properties.zone] || { color: '#888', fillOpacity: 0.1, weight: 1 },
      onEachFeature: (f, layer) => layer.on('click', e => {
        L.DomEvent.stopPropagation(e);
        if (pickIfPinning(e)) return;
        showZonePanel(f.properties.zone, e.latlng);
      }),
    });
    toggleZones();
  } catch (err) {
    console.warn('Failed to load zones:', err);
  }
}

function toggleZones() {
  if (!zonesLayer) return;
  if (showZones) { zonesLayer.addTo(map); zonesLayer.bringToBack(); } else zonesLayer.remove();
}

// Tickets: pre-geocoded by the weekly job, so no runtime geocoding.
function renderTickets() {
  ticketLayer.clearLayers();
  if (!showTickets) { ticketLayer.remove(); return; }
  ticketLayer.addTo(map);
  if (!ticketData.hotspots.length) { setStatus('No ticket data yet (run the weekly data job).', { error: true }); return; }
  const max = Math.max(...ticketData.hotspots.map(h => h.count));
  const r = markerRadius();
  for (const h of ticketData.hotspots) {
    const extra = Math.round((h.count / max) * 5);
    const m = L.circleMarker([h.lat, h.lon], {
      renderer: canvasRenderer, radius: r + extra, fillColor: '#111', fillOpacity: 0.78, color: '#fff', weight: 1.5,
    }).addTo(ticketLayer);
    m._extra = extra;
    m.on('click', e => { L.DomEvent.stopPropagation(e); if (pickIfPinning(e)) return; selectMarker(m); showTicketPanel(h, [h.lat, h.lon]); });
  }
}

// Off-street lots (toggle chip)
function renderLots() {
  lotLayer.clearLayers();
  if (!showLots) { lotLayer.remove(); return; }
  lotLayer.addTo(map);
  if (!allLots.length) { setStatus('No lot data yet (run the weekly data job).', { error: true }); return; }
  for (const lot of allLots) {
    const m = L.marker([lot.lat, lot.lon], {
      icon: L.divIcon({ className: 'lot-dot', html: '<span>P</span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(lotLayer);
    m.on('click', e => { L.DomEvent.stopPropagation(e); if (pickIfPinning(e)) return; showLotPanel(lot, [lot.lat, lot.lon]); });
  }
}

// ─── Destination search ────────────────────────────────────────────────────
function setupSearch() {
  $('dest-form').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('dest-input').value.trim();
    if (!q) return;
    $('dest-input').blur();
    const coords = parseLatLng(q);
    if (coords) { setDestination(coords.lat, coords.lon, `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`); return; }
    await searchPlaces(q);
  });

  setupAutocomplete();
  $('pin-btn').addEventListener('click', () => setPinMode(!pinMode));
  $('clear-dest').addEventListener('click', clearDestination);
  $('when-now').addEventListener('click', () => { $('when-input').value = ''; updateTripSummary(); refreshResults(); });
  for (const id of ['walk-select', 'stay-select', 'when-input']) $(id).addEventListener('change', () => {
    settings.walkMin = +$('walk-select').value;
    settings.stayHours = +$('stay-select').value;
    updateTripSummary();
    refreshResults();
  });
  $('sheet-handle').addEventListener('click', () => $('results-sheet').classList.toggle('collapsed'));
  setupTripToggle();
  setupSheetSwipe();

  // Delegated clicks inside results and panels (copy buttons, picking a geocode candidate, focusing a card)
  document.addEventListener('click', e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) { copyText(copy.dataset.copy); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const [lat, lon] = pick.dataset.pick.split(',').map(Number);
      setDestination(lat, lon, pick.dataset.label);
      return;
    }
    const card = e.target.closest('.res-card[data-focus]');
    if (card && !e.target.closest('a,button')) {
      const [lat, lon] = card.dataset.focus.split(',').map(Number);
      pickResult(card.id, lat, lon);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 17), { duration: 0.6 });
    }
  });
}

// In pin mode every tap (even on a marker or zone) sets the destination.
function pickIfPinning(e) {
  if (!pinMode) return false;
  setPinMode(false);
  setDestination(e.latlng.lat, e.latlng.lng, 'Dropped pin');
  return true;
}

// ─── Address / place autocomplete (Photon: free, OpenStreetMap-based, built for search-as-you-type) ──
// Nominatim forbids autocomplete, so it is only used for the explicit "Go" search above.
const SUGGEST_MIN_CHARS = 3;
const SUGGEST_DEBOUNCE_MS = 250;
const suggestCache = new Map();
let suggestItems = [], suggestActive = -1, suggestTimer = null, suggestAbort = null, suppressSuggest = false;

function closeSuggest() {
  $('suggest').classList.add('hidden');
  $('dest-input').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('suggesting');
  suggestItems = [];
  suggestActive = -1;
}

function renderSuggest() {
  const box = $('suggest');
  if (!suggestItems.length) { closeSuggest(); return; }
  box.innerHTML = suggestItems.map((s, i) => `
    <div class="sg-item${i === suggestActive ? ' active' : ''}" role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === suggestActive}">
      <span class="sg-label">${esc(s.label)}</span>${s.sub ? `<span class="sg-sub">${esc(s.sub)}</span>` : ''}
    </div>`).join('') +
    `<div class="sg-foot">Search by <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a> · © OpenStreetMap contributors</div>`;
  box.classList.remove('hidden');
  document.body.classList.add('suggesting');
  $('dest-input').setAttribute('aria-expanded', 'true');
  const act = suggestActive >= 0 ? $(`sg-${suggestActive}`) : null;
  $('dest-input').setAttribute('aria-activedescendant', act ? act.id : '');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function chooseSuggestion(i) {
  const s = suggestItems[i];
  if (!s) return;
  suppressSuggest = true;
  $('dest-input').value = s.label;
  suppressSuggest = false;
  closeSuggest();
  $('dest-input').blur();
  setDestination(s.lat, s.lon, s.label);
}

async function fetchSuggestions(q) {
  const key = q.toLowerCase();
  if (suggestCache.has(key)) return suggestCache.get(key);
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  const c = map.getCenter();
  const res = await fetch(buildPhotonUrl(q, { lat: c.lat, lon: c.lng }), { signal: suggestAbort.signal });
  if (!res.ok) throw new Error(`autocomplete ${res.status}`);
  const items = formatPhotonResults(await res.json());
  suggestCache.set(key, items);
  return items;
}

function setupAutocomplete() {
  const input = $('dest-input');

  input.addEventListener('input', () => {
    if (suppressSuggest) return;
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (q.length < SUGGEST_MIN_CHARS || parseLatLng(q)) {
      if (suggestAbort) suggestAbort.abort();
      closeSuggest();
      return;
    }
    suggestTimer = setTimeout(async () => {
      try {
        const items = await fetchSuggestions(q);
        if (input.value.trim() !== q) return; // user kept typing
        suggestItems = items;
        suggestActive = -1;
        renderSuggest();
      } catch (err) {
        if (err.name !== 'AbortError') { console.warn('Autocomplete unavailable:', err); closeSuggest(); }
      }
    }, SUGGEST_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', e => {
    const open = !$('suggest').classList.contains('hidden');
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); suggestActive = (suggestActive + 1) % suggestItems.length; renderSuggest(); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); suggestActive = (suggestActive - 1 + suggestItems.length) % suggestItems.length; renderSuggest(); }
    else if (e.key === 'Enter' && open && suggestActive >= 0) { e.preventDefault(); chooseSuggestion(suggestActive); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); closeSuggest(); }
  });

  // pointerdown (not click) so the input's blur doesn't close the list before the tap registers
  $('suggest').addEventListener('pointerdown', e => {
    const item = e.target.closest('.sg-item');
    if (!item) return;
    e.preventDefault();
    chooseSuggestion(+item.dataset.i);
  });

  input.addEventListener('blur', () => setTimeout(closeSuggest, 150));
  input.addEventListener('focus', () => { if (suggestItems.length) renderSuggest(); });
  // Pressing Go / Enter with nothing highlighted runs the full (Nominatim) search instead
  $('dest-form').addEventListener('submit', () => { clearTimeout(suggestTimer); if (suggestAbort) suggestAbort.abort(); closeSuggest(); }, true);
}

function setPinMode(on) {
  pinMode = on;
  $('pin-btn').classList.toggle('active', on);
  $('map').classList.toggle('pin-mode', on);
  if (on) setStatus('Tap the map to set your destination', { sticky: true }); else setStatus('');
}

async function searchPlaces(q) {
  setStatus('Searching…', { sticky: true });
  try {
    const url = `${NOMINATIM}?${new URLSearchParams({
      q, format: 'jsonv2', limit: '5', countrycodes: 'ca', viewbox: SEARCH_VIEWBOX, bounded: '1', addressdetails: '0',
    })}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`search ${res.status}`);
    const hits = await res.json();
    setStatus('');
    if (!hits.length) {
      showSheet(`<div class="res-title">No match for “${esc(q)}”</div>`,
        `<div class="res-empty">Try the street address, or tap the pin button and tap the spot on the map.</div>`);
      return;
    }
    if (hits.length === 1) { setDestination(+hits[0].lat, +hits[0].lon, shortName(hits[0])); return; }
    showSheet(`<div class="res-title">Which one?</div><div class="res-subtitle">Pick the place you mean</div>`,
      `<div class="pick-list">${hits.map(h => `
        <div class="res-card pick" data-pick="${(+h.lat).toFixed(6)},${(+h.lon).toFixed(6)}" data-label="${esc(shortName(h))}">
          <div class="res-main"><div class="res-name">${esc(shortName(h))}</div>
          <div class="res-line">${esc(h.display_name.split(',').slice(1, 4).join(',').trim())}</div></div>
        </div>`).join('')}</div>`);
  } catch (err) {
    console.error(err);
    setStatus('Search failed. Check your connection, or drop a pin instead.', { error: true });
  }
}

function shortName(hit) {
  return (hit.name || hit.display_name.split(',')[0] || 'Destination').trim();
}

// ─── Destination + results ─────────────────────────────────────────────────
function setDestination(lat, lon, label) {
  dest = { lat, lon, label };
  settings.walkMin = +$('walk-select').value;
  settings.stayHours = +$('stay-select').value;
  $('trip-row').classList.remove('hidden');
  updateTripSummary();
  $('info-panel').classList.add('hidden');
  drawDestination(true);
  refreshResults();
}

function clearDestination() {
  dest = null;
  lastResults = null;
  destLayer.clearLayers();
  resultLayer.clearLayers();
  clearHighlight();
  $('trip-row').classList.add('hidden');
  $('trip-row').classList.remove('open');
  $('results-sheet').classList.add('hidden');
  $('reopen-results').classList.add('hidden');
  renderMarkers();
}

function drawDestination(fit) {
  destLayer.clearLayers();
  if (!dest) return;
  L.marker([dest.lat, dest.lon], {
    icon: L.divIcon({ className: 'dest-pin', html: '<div class="dest-pin-inner"></div>', iconSize: [28, 28], iconAnchor: [14, 28] }),
    keyboard: false,
  }).addTo(destLayer);
  const ring = L.circle([dest.lat, dest.lon], {
    radius: maxStraightMeters(settings.walkMin), color: '#1a73e8', weight: 2, dashArray: '6 6',
    fillColor: '#1a73e8', fillOpacity: 0.06, interactive: false,
  }).addTo(destLayer);
  if (fit) {
    const mobile = window.innerWidth < 768;
    const stackH = Math.ceil($('top-stack').getBoundingClientRect().bottom);
    map.fitBounds(ring.getBounds(), {
      paddingTopLeft: [mobile ? 16 : 410, stackH + 8],
      paddingBottomRight: [mobile ? 16 : 56, mobile ? Math.round(window.innerHeight * 0.44) : 24],
      maxZoom: 17,
    });
  }
}

function getStartDate() {
  return parseWhenInput($('when-input').value) || new Date();
}

function refreshResults() {
  if (!dest) return;
  settings.walkMin = +$('walk-select').value;
  settings.stayHours = +$('stay-select').value;
  drawDestination(false);
  if (!allMeters.length) { showSheet('<div class="res-title">Loading data…</div>', ''); return; }
  const start = getStartDate();
  const hotspots = ticketData.hotspots;
  const meters = rankMeters(allMeters, dest, { maxMinutes: settings.walkMin, start, hours: settings.stayHours, limit: 8, hotspots });
  const lots = rankLots(allLots, dest, { maxMinutes: settings.walkMin, hours: settings.stayHours, limit: 6 });
  lastResults = { meters, lots, start };
  renderResults();
  renderMarkers();
}

function whenLabel(start) {
  const sameMinute = Math.abs(start - Date.now()) < 90 * 1000 || !$('when-input').value;
  if (sameMinute) return 'now';
  return start.toLocaleString('en-CA', { timeZone: 'America/Vancouver', weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function cardName(o) {
  return meterName(blockByMeter.get(String(o.id)), o.id);
}

function meterCard(o, i, isCheapest) {
  const free = o.cost === 0;
  const demand = o.color === 'grey' ? '' : `<span class="badge demand-${o.color}">${esc(o.demand)}</span>`;
  const tickets = o.ticketsNearby ? `<span class="badge ticket">Ticket hotspot nearby</span>` : '';
  const limit = o.limit && !/no (time )?(limit|restrictions)/i.test(o.limit) && o.limit !== 'Unknown' ? ` · ${esc(o.limit)} limit` : '';
  return `
    <div class="res-card" id="res-meter-${i}" data-focus="${o.lat},${o.lon}">
      <div class="res-num">${i + 1}</div>
      <div class="res-main">
        <div class="res-name">${esc(cardName(o).title)} ${isCheapest ? '<span class="badge">Best price</span>' : ''}${demand}${tickets}</div>
        ${cardName(o).sub ? `<div class="res-sub">${esc(cardName(o).sub)}</div>` : ''}
        <div class="res-line"><b>${free ? 'Free' : formatMoney(o.cost)}</b> for ${settings.stayHours} h · ${esc(o.rateNow)}${o.rateNow !== 'Free' ? '/hr' : ''} · <b>${Math.max(1, Math.round(o.walkMin))} min</b> walk${limit}</div>
        ${o.exceedsLimit ? `<div class="res-warn">Time limit is shorter than your stay: you would need to move or re-park.</div>` : ''}
        <div class="res-coords">${formatCoords(o.lat, o.lon)}</div>
        <div class="res-actions">
          <a class="btn primary" href="${mapsDriveUrl(o.lat, o.lon)}" target="_blank" rel="noopener">Open in Maps</a>
          <a class="btn" href="${mapsWalkUrl(o, dest)}" target="_blank" rel="noopener">Walk to ${esc(dest.label.length > 18 ? 'destination' : dest.label)}</a>
          <button class="btn" type="button" data-copy="${formatCoords(o.lat, o.lon)}">Copy coords</button>
        </div>
      </div>
    </div>`;
}

function lotCard(o, i) {
  const rate = o.ratePerHr ? `<b>$${o.ratePerHr.toFixed(2)}/hr</b>${o.cost != null ? ` · ≈ ${formatMoney(o.cost)} for ${settings.stayHours} h` : ''}` : 'Rate: check operator';
  const sub = [o.operator, o.parking, o.address].filter(Boolean).join(' · ');
  return `
    <div class="res-card" id="res-lot-${i}" data-focus="${o.lat},${o.lon}">
      <div class="res-num lot">P</div>
      <div class="res-main">
        <div class="res-name">${esc(o.label)}</div>
        <div class="res-line">${rate} · <b>${Math.max(1, Math.round(o.walkMin))} min</b> walk</div>
        ${sub ? `<div class="res-line">${esc(sub)}</div>` : ''}
        <div class="res-coords">${formatCoords(o.lat, o.lon)}${o.verify ? ' · confirm rate & hours on arrival' : ''}</div>
        <div class="res-actions">
          <a class="btn primary" href="${mapsDriveUrl(o.lat, o.lon)}" target="_blank" rel="noopener">Open in Maps</a>
          <a class="btn" href="${mapsWalkUrl(o, dest)}" target="_blank" rel="noopener">Walk to destination</a>
          ${o.url ? `<a class="btn" href="${esc(o.url)}" target="_blank" rel="noopener">Rates</a>` : ''}
          <button class="btn" type="button" data-copy="${formatCoords(o.lat, o.lon)}">Copy coords</button>
        </div>
      </div>
    </div>`;
}

function renderResults() {
  if (!dest || !lastResults) return;
  const { meters, lots, start } = lastResults;
  const head = `
    <div class="res-title">Parking near ${esc(dest.label)}</div>
    <div class="res-subtitle">${settings.walkMin} min walk · ${settings.stayHours} h stay · arriving ${esc(whenLabel(start))}</div>`;

  let body = '';
  if (meters.length) {
    body += `<div class="res-section">Street meters, cheapest first</div>`;
    body += meters.map((o, i) => meterCard(o, i, i === 0 && !o.exceedsLimit)).join('');
  } else {
    body += `<div class="res-empty">No street meters within a ${settings.walkMin} min walk. Try a longer walk time.</div>`;
  }
  if (lots.length) {
    body += `<div class="res-section">Off-street lots, nearest first</div>`;
    body += lots.map(lotCard).join('');
  } else if (!allLots.length) {
    body += `<div class="res-empty">Lot data isn't loaded yet. It arrives with the weekly data job.</div>`;
  }
  body += `<div class="res-empty" style="font-size:11px;color:#999">Walk times are estimates (straight line × 1.3 at 4.8 km/h). Check posted signs: permit zones, loading zones and rush-hour restrictions are not included in cost.</div>`;
  showSheet(head, body);

  // numbered markers on the map
  resultLayer.clearLayers();
  meters.forEach((o, i) => {
    L.marker([o.lat, o.lon], {
      icon: L.divIcon({ className: 'res-marker', html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 1000,
    }).on('click', e => { L.DomEvent.stopPropagation(e); pickResult(`res-meter-${i}`, o.lat, o.lon); flashCard(`res-meter-${i}`); }).addTo(resultLayer);
  });
  lots.forEach((o, i) => {
    L.marker([o.lat, o.lon], {
      icon: L.divIcon({ className: 'res-marker lot', html: '<span>P</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 900,
    }).on('click', e => { L.DomEvent.stopPropagation(e); pickResult(`res-lot-${i}`, o.lat, o.lon); flashCard(`res-lot-${i}`); }).addTo(resultLayer);
  });
}

function showSheet(headHtml, bodyHtml) {
  const sheet = $('results-sheet');
  $('results-head').innerHTML = headHtml;
  $('results-body').innerHTML = bodyHtml;
  sheet.classList.remove('hidden', 'collapsed');
  $('reopen-results').classList.add('hidden');
}

// Mobile: trip settings (walk / stay / arrive) sit behind a one-line summary
function updateTripSummary() {
  const when = $('when-input').value;
  const arrive = when ? new Date(when).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'now';
  $('trip-summary').textContent = `Walk ${$('walk-select').value} min · Stay ${$('stay-select').value} h · Arrive ${arrive}`;
}

function setupTripToggle() {
  $('trip-toggle').addEventListener('click', () => {
    const open = $('trip-row').classList.toggle('open');
    $('trip-toggle').setAttribute('aria-expanded', String(open));
  });
}

// Mobile: drag the results sheet. Down = collapse, down again = hide (a pill brings it back), up = expand.
function setupSheetSwipe() {
  const sheet = $('results-sheet'), body = $('results-body'), pill = $('reopen-results');
  const mobile = window.matchMedia('(max-width: 767px)');
  let y0 = 0, dy = 0, drag = false, fromBody = false;

  sheet.addEventListener('touchstart', e => {
    if (!mobile.matches) return;
    y0 = e.touches[0].clientY; dy = 0; drag = false;
    fromBody = body.contains(e.target);
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (!mobile.matches) return;
    dy = e.touches[0].clientY - y0;
    if (!drag) {
      if (Math.abs(dy) < 8) return;
      // inside the list, only take over when it is scrolled to the top and the finger moves down
      if (fromBody && !(body.scrollTop <= 0 && dy > 0)) return;
      drag = true;
      sheet.style.transition = 'none';
    }
    if (e.cancelable) e.preventDefault();
    sheet.style.transform = `translateY(${Math.max(dy, 0)}px)`;
  }, { passive: false });

  const end = () => {
    if (!drag) return;
    drag = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 60) {
      if (sheet.classList.contains('collapsed')) { sheet.classList.add('hidden'); pill.classList.remove('hidden'); }
      else sheet.classList.add('collapsed');
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);

  // a short upward swipe on the collapsed sheet expands it
  let uy0 = 0;
  sheet.addEventListener('touchstart', e => { uy0 = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (mobile.matches && sheet.classList.contains('collapsed') && uy0 - e.changedTouches[0].clientY > 40) sheet.classList.remove('collapsed');
  });

  pill.addEventListener('click', () => { sheet.classList.remove('hidden', 'collapsed'); pill.classList.add('hidden'); });
}

function flashCard(id) {
  const el = $(id);
  if (!el) return;
  $('results-sheet').classList.remove('collapsed');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  setStatus(`Copied ${text}`);
}

// ─── Panels ────────────────────────────────────────────────────────────────
function setupPanels() {
  $('close-panel').addEventListener('click', () => { $('info-panel').classList.add('hidden'); selectMarker(null); });
  setupOnboarding();
  showHelpHint();
  const help = $('help-panel');
  $('help-btn').addEventListener('click', e => {
    e.stopPropagation();
    help.classList.toggle('hidden');
    $('info-panel').classList.add('hidden');
    $('onboarding').classList.add('hidden'); // both live bottom-right on desktop
  });
  $('close-help').addEventListener('click', e => { e.stopPropagation(); help.classList.add('hidden'); });
  help.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => help.classList.add('hidden'));
}

// Desktop "Quick Guide" card
// Welcome / info page: opens on the first visit (also on phones). The ? button → "Show the how-to guide" reopens it.
function setupOnboarding() {
  $('onboarding').classList.add('hidden');
  $('free-ok').addEventListener('click', () => $('free-popup').classList.add('hidden'));
  $('free-popup').addEventListener('click', e => { if (e.target === $('free-popup')) $('free-popup').classList.add('hidden'); });
  const welcome = $('welcome');
  const close = () => { welcome.classList.add('hidden'); $('dest-input').blur(); maybeShowFreePopup(); };
  $('welcome-go').addEventListener('click', close);
  welcome.addEventListener('click', e => { if (e.target === welcome) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !welcome.classList.contains('hidden')) close(); });
  $('show-welcome').addEventListener('click', e => {
    e.stopPropagation();
    $('help-panel').classList.add('hidden');
    welcome.classList.remove('hidden');
  });
  const KEY = 'vpf_welcome_seen';
  try { if (localStorage.getItem(KEY)) { maybeShowFreePopup(); return; } localStorage.setItem(KEY, '1'); } catch { /* private mode: show every time */ }
  welcome.classList.remove('hidden');
}

// While meters are off (10pm-9am Vancouver time) tell people once per visit, since every dot is grey then.
function isFreeNow() {
  return !getTimeInfo(new Date()).isMetered;
}

function maybeShowFreePopup() {
  if (!isFreeNow() || !$('welcome').classList.contains('hidden')) return;
  try { if (sessionStorage.getItem('vpf_free_popup')) return; sessionStorage.setItem('vpf_free_popup', '1'); } catch { /* show anyway */ }
  $('free-popup').classList.remove('hidden');
}

function showHelpHint() { /* replaced by the first-visit popup above */ }

// ─── Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    $('time-display').textContent = formatClock(now);
    const info = getTimeInfo(now);
    // Banner shown in the free window: 10pm-9am Vancouver time (meters run 9am-10pm)
    $('free-notice').classList.toggle('hidden', info.isMetered);
    if (currentTimeInfo && currentTimeInfo.isMetered && !info.isMetered) maybeShowFreePopup();
    if (currentTimeInfo && info.period !== currentTimeInfo.period && allMeters.length) {
      renderMarkers();
      if (dest && !$('when-input').value) refreshResults();
    }
    if (!currentTimeInfo) currentTimeInfo = info;
  }
  tick();
  setInterval(tick, 30000);
}

// ─── Locate ────────────────────────────────────────────────────────────────
function setupLocateButton() {
  $('locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('Geolocation not supported', { error: true }); return; }
    setStatus('Finding your location…', { sticky: true });
    navigator.geolocation.getCurrentPosition(
      pos => {
        const loc = [pos.coords.latitude, pos.coords.longitude];
        map.setView(loc, 16);
        if (userMarker) userMarker.setLatLng(loc);
        else userMarker = L.circleMarker(loc, { renderer: canvasRenderer, radius: 7, fillColor: '#1a73e8', fillOpacity: 1, color: '#fff', weight: 2 }).addTo(map);
        setStatus('Showing meters near you');
      },
      err => setStatus(`Location error: ${err.message}`, { error: true }),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initMap);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}
