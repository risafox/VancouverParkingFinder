'use strict';

// ─── Config ────────────────────────────────────────────────────────────────
const API_BASE = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/parking-meters/records';
const TICKET_API = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/parking-tickets/records';
const PAGE_SIZE = 100;
const VANCOUVER_CENTER = { lat: 49.2827, lng: -123.1207 };
const CACHE_KEY = 'vpf_meters_v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── State ─────────────────────────────────────────────────────────────────
let map = null;
let markers = [];
let allMeters = [];
let currentTimeInfo = null;
let activeFilter = null; // null = show all, or a color string for single-select
let ticketMarkers = [];
let showTickets = false;
let zonesLayer = null;
let showZones = false;

// ─── Time Helpers ──────────────────────────────────────────────────────────
function getTimeInfo(date = new Date()) {
  const day = date.getDay(); // 0=Sun, 6=Sat
  const hour = date.getHours();
  const minute = date.getMinutes();
  const totalMinutes = hour * 60 + minute;

  const isWeekend = day === 0 || day === 6;
  const isMorningPeak = totalMinutes >= 9 * 60 && totalMinutes < 18 * 60;   // 9am–6pm
  const isEveningPeak = totalMinutes >= 18 * 60 && totalMinutes < 22 * 60; // 6pm–10pm
  const isMetered = isMorningPeak || isEveningPeak;

  let period = null;
  if (isMorningPeak) period = isWeekend ? 'weekend_morning' : 'weekday_morning';
  else if (isEveningPeak) period = isWeekend ? 'weekend_evening' : 'weekday_evening';

  // When does the current metered period end?
  let periodEndsAt = null;
  if (isMorningPeak) periodEndsAt = '6:00 PM';
  else if (isEveningPeak) periodEndsAt = '10:00 PM';

  return { isWeekend, isMorningPeak, isEveningPeak, isMetered, period, hour, minute, day, periodEndsAt };
}

function formatTimeDisplay(date = new Date()) {
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function getMeterStatus(meter, timeInfo) {
  if (!timeInfo.isMetered) {
    return { rate: 'Free', limit: 'No restrictions', limitWithExpiry: 'No restrictions', color: 'grey', score: 0 };
  }

  let rateStr = null;
  let limitStr = null;

  if (timeInfo.period === 'weekday_morning' || timeInfo.period === 'weekend_morning') {
    rateStr = meter.rate_9am_6pm;
    limitStr = timeInfo.isWeekend ? meter.time_limit_weekend_9am_6pm : meter.time_limit_9am_6pm;
  } else {
    rateStr = meter.rate_6pm_10pm;
    limitStr = timeInfo.isWeekend ? meter.time_limit_weekend_6pm_10pm : meter.time_limit_6pm_10pm;
  }

  // Use flat rate if no period rate
  if (!rateStr && meter.flat_rate) {
    rateStr = meter.flat_rate;
  }

  const rate = parseRate(rateStr);
  const color = rateToColor(rate);

  const hasTimeLimit = limitStr && !/no time limit/i.test(limitStr);
  const limitWithExpiry = hasTimeLimit && timeInfo.periodEndsAt
    ? `${limitStr} (until ${timeInfo.periodEndsAt})`
    : limitStr || 'Unknown';

  return {
    rate: rateStr || 'Unknown',
    limit: limitStr || 'Unknown',
    limitWithExpiry,
    color,
    score: rate,
    rawRate: rate
  };
}

function parseRate(rateStr) {
  if (!rateStr) return 0;
  const match = rateStr.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

function rateToColor(rate) {
  if (rate === 0) return 'grey';
  if (rate <= 1.5) return 'green';
  if (rate <= 3.0) return 'yellow';
  return 'red';
}

const COLOR_HEX = {
  green:  '#34a853',
  yellow: '#fbbc04',
  red:    '#ea4335',
  grey:   '#9e9e9e',
};

// ─── Data Fetching ─────────────────────────────────────────────────────────
async function fetchAllMeters() {
  // Try cache first
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_TTL_MS) {
        setStatus(`Loaded ${data.length} meters (cached)`);
        return data;
      }
    }
  } catch (e) {
    // ignore cache errors
  }

  setStatus('Fetching parking data...');
  const meters = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const url = `${API_BASE}?limit=${PAGE_SIZE}&offset=${offset}&timezone=America/Vancouver&include_links=false&include_app_metas=false`;
    const res = await fetch(url, { headers: { accept: 'application/json; charset=utf-8' } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = await res.json();

    if (total === null) total = json.total_count;
    meters.push(...json.results);
    offset += PAGE_SIZE;
    setStatus(`Loading meters... ${meters.length} / ${total}`);
  }

  // Save to cache
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: meters, timestamp: Date.now() }));
  } catch (e) {
    // ignore storage errors (e.g. private browsing)
  }

  setStatus(`Loaded ${meters.length} meters`);
  return meters;
}

// ─── Map ───────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { zoomControl: false }).setView(
    [VANCOUVER_CENTER.lat, VANCOUVER_CENTER.lng], 14
  );

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  loadAndRender();
  loadZones();
  startClock();
  setupLocateButton();
  setupClosePanel();
  setupChips();
}

async function loadAndRender() {
  try {
    allMeters = await fetchAllMeters();
    renderMarkers();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

function renderMarkers() {
  // Clear existing markers
  markers.forEach(m => m.remove());
  markers = [];

  currentTimeInfo = getTimeInfo();

  allMeters.forEach(meter => {
    const geo = meter.geo_point_2d;
    if (!geo || !geo.lat || !geo.lon) return;

    const status = getMeterStatus(meter, currentTimeInfo);
    if (activeFilter !== null && status.color !== activeFilter) return;

    const hex = COLOR_HEX[status.color] || COLOR_HEX.grey;

    const marker = L.circleMarker([geo.lat, geo.lon], {
      radius: 6,
      fillColor: hex,
      fillOpacity: 0.9,
      color: '#ffffff',
      weight: 1.5,
    }).addTo(map);

    marker.on('click', () => showPanel(meter, status, [geo.lat, geo.lon]));
    markers.push(marker);
  });

}

// ─── Panel Positioning ─────────────────────────────────────────────────────
function positionPanel(latlng) {
  const panel = document.getElementById('info-panel');
  if (window.innerWidth >= 768) {
    const point = map.latLngToContainerPoint(latlng);
    const mapW = document.getElementById('map').offsetWidth;
    const panelW = 280;
    let left = point.x + 20;
    if (left + panelW > mapW - 12) left = point.x - panelW - 20;
    if (left < 12) left = 12;
    let top = Math.max(80, point.y - 44);
    panel.style.cssText = `left:${left}px;top:${top}px;bottom:auto;right:auto;width:${panelW}px;`;
    panel.dataset.mode = 'desktop';
  } else {
    panel.style.cssText = '';
    delete panel.dataset.mode;
  }
}

// ─── Info Panel ────────────────────────────────────────────────────────────
function showPanel(meter, status, latlng) {
  const street = meter.streetname || meter.street_name || meter.street || '';
  const label = street ? `Meter ${meter.meter_id} · ${street}` : `Meter ${meter.meter_id}`;
  const payment = meter.credit_card === 'Yes' ? 'Credit card + coin' : `Coin · #${meter.mobile_payment_number || '–'}`;
  const hasLimit = status.limitWithExpiry && status.limitWithExpiry !== 'No restrictions' && status.limitWithExpiry !== 'Unknown';
  const sub = [hasLimit ? status.limitWithExpiry : null, payment].filter(Boolean).join(' · ');

  const panel = document.getElementById('info-panel');
  panel.dataset.tier = status.color;

  document.getElementById('panel-content').innerHTML = `
    <div class="panel-header">
      <span class="panel-meter-id">${label}</span>
      <span class="panel-rate-big">${status.rate}/hr</span>
    </div>
    <div class="panel-sub">${sub}</div>
  `;

  positionPanel(latlng);
  panel.classList.remove('hidden');
}

function showTicketPanel(ticket, latlng) {
  const panel = document.getElementById('info-panel');
  panel.dataset.tier = 'ticket';

  document.getElementById('panel-content').innerHTML = `
    <div class="panel-header">
      <span class="panel-meter-id">${ticket.block} ${ticket.street}</span>
      <span class="panel-ticket-tag">Ticket</span>
    </div>
    <div class="panel-sub">${ticket.infractiontext || 'Parking infraction'}</div>
    <div class="panel-sub panel-muted">${ticket.entrydate || ''}</div>
  `;

  positionPanel(latlng);
  panel.classList.remove('hidden');
}

function setupChips() {
  // Price chips: single-select
  document.querySelectorAll('.chip[data-type="price"]').forEach(chip => {
    chip.addEventListener('click', () => {
      const color = chip.dataset.color;
      if (activeFilter === color) {
        activeFilter = null;
        document.querySelectorAll('.chip[data-type="price"]').forEach(c => c.classList.add('active'));
      } else {
        activeFilter = color;
        document.querySelectorAll('.chip[data-type="price"]').forEach(c => {
          c.classList.toggle('active', c.dataset.color === color);
        });
      }
      renderMarkers();
    });
  });

  // Ticket chip: independent toggle
  const ticketChip = document.querySelector('.chip[data-type="ticket"]');
  if (ticketChip) {
    ticketChip.addEventListener('click', () => {
      showTickets = !showTickets;
      ticketChip.classList.toggle('active', showTickets);
      renderTickets();
    });
  }

  // Zones chip: independent toggle
  const zonesChip = document.querySelector('.chip[data-type="zones"]');
  if (zonesChip) {
    zonesChip.addEventListener('click', () => {
      showZones = !showZones;
      zonesChip.classList.toggle('active', showZones);
      toggleZones();
    });
  }
}

// ─── Permit Zones ──────────────────────────────────────────────────────────

const ZONE_STYLE = {
  RPO:  { color: '#e65100', fillColor: '#ff6d00', fillOpacity: 0.15, weight: 1.5 },
  RPP:  { color: '#1565c0', fillColor: '#1e88e5', fillOpacity: 0.15, weight: 1.5 },
  VRPP: { color: '#6a1b9a', fillColor: '#ab47bc', fillOpacity: 0.15, weight: 1.5 },
};

const ZONE_LABEL = {
  RPO:  'Resident Parking Only',
  RPP:  'Residential Parking Permit',
  VRPP: 'Vancouver Resident Parking Permit',
};

async function loadZones() {
  try {
    const res = await fetch('parking_zones.geojson');
    const geojson = await res.json();
    zonesLayer = L.geoJSON(geojson, {
      style: f => ZONE_STYLE[f.properties.zone] || { color: '#888', fillOpacity: 0.1, weight: 1 },
      onEachFeature: (f, layer) => {
        const zone = f.properties.zone;
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          showZonePanel(zone, e.latlng);
        });
      },
    });
  } catch (err) {
    console.warn('Failed to load zones:', err);
  }
}

function toggleZones() {
  if (!zonesLayer) return;
  if (showZones) {
    zonesLayer.addTo(map);
    zonesLayer.bringToBack();
  } else {
    zonesLayer.remove();
  }
}

function showZonePanel(zone, latlng) {
  const panel = document.getElementById('info-panel');
  panel.dataset.tier = 'zone';
  document.getElementById('panel-content').innerHTML = `
    <div class="panel-header">
      <span class="panel-meter-id">${ZONE_LABEL[zone] || zone}</span>
    </div>
    <div class="panel-sub">${zone === 'RPO'
      ? 'Parking reserved for residents. No permits issued — obey posted signs.'
      : 'A residential parking permit is required to park here during restricted hours.'
    }</div>
  `;
  positionPanel(latlng);
  panel.classList.remove('hidden');
}

// ─── Tickets ───────────────────────────────────────────────────────────────
// The parking-tickets dataset has no geo coordinates, so we geocode block+street
// via Nominatim. Results are cached in sessionStorage. First load ~10s for 10
// unique locations; subsequent loads are instant from cache.

const geoCache = {};

async function geocodeBlockStreet(block, street) {
  const key = `${block}|${street}`;
  if (geoCache[key] !== undefined) return geoCache[key];
  const stored = sessionStorage.getItem('vpf_geo_' + key.replace(/\s/g, '_'));
  if (stored) { geoCache[key] = JSON.parse(stored); return geoCache[key]; }

  try {
    const q = encodeURIComponent(`${block} ${street}, Vancouver, BC, Canada`);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=ca`,
      { headers: { 'User-Agent': 'VancouverParkingFinder/1.0' } }
    );
    const data = await res.json();
    const result = data[0] ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
    geoCache[key] = result;
    if (result) sessionStorage.setItem('vpf_geo_' + key.replace(/\s/g, '_'), JSON.stringify(result));
    return result;
  } catch (e) {
    geoCache[key] = null;
    return null;
  }
}

// Infraction types to include (metered-space violations only)
const TICKET_INFRACTIONS = [
  'PARK IN A METERED SPACE IF THE TIME RECORDED BY THE OPERATOR UNDER THE PAY BY PHONE OR PAY BY LICENCE PLATE OPTION HAS EXPIRED',
  'PARK IN A METERED SPACE IF THE PARKING METER HEAD DISPLAYS FOUR FLASHING ZEROS IN A WINDOW',
  'PARK ON A STREET WHERE A TRAFFIC SIGN RESTRICTS PARKING, EXCEPT IN ACCORDANCE WITH SUCH RESTRICTION..',
  'VEHICLE LEFT IN A METERED SPACE FOR A PERIOD LONGER THAN THE TIME LIMIT IN HOURS THAT IS SHOWN ON THE PARKING METER HEAD OR RECORDED UNDER THE PAY BY PHONE OR PAY BY LICENCE PLATE OPTION',
];

async function fetchRecentTickets() {
  // Build refine params: multiple infraction types (OR) + year filter
  const infractionParams = TICKET_INFRACTIONS
    .map(t => `refine=${encodeURIComponent(`infractiontext:"${t}"`)}`)
    .join('&');
  const yearParam = `refine=${encodeURIComponent('year:"2025"')}`;
  const base = `${TICKET_API}?limit=100&${infractionParams}&${yearParam}&include_links=false&include_app_metas=false`;

  // Fetch 5 pages in parallel (500 records total — API max is 100/page, 10k via pagination)
  const pages = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetch(`${base}&offset=${i * 100}`, { headers: { accept: 'application/json; charset=utf-8' } })
        .then(r => r.ok ? r.json() : { results: [] })
        .then(j => j.results || [])
        .catch(() => [])
    )
  );

  return pages.flat();
}

let ticketsLoading = false;

function renderTickets() {
  ticketMarkers.forEach(m => m.remove());
  ticketMarkers = [];
  if (!showTickets || ticketsLoading) return;
  doRenderTickets();
}

async function doRenderTickets() {
  ticketsLoading = true;
  try {
    const tickets = await fetchRecentTickets();

    // Build frequency map: block|street → { ticket, count }
    const freq = new Map();
    for (const t of tickets) {
      const key = `${t.block}|${t.street}`;
      if (freq.has(key)) {
        freq.get(key).count++;
      } else {
        freq.set(key, { ticket: t, count: 1 });
      }
    }

    // Sort by frequency desc, take top 25 hotspots
    const hotspots = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 25);
    const maxCount = hotspots[0]?.count || 1;

    for (let i = 0; i < hotspots.length; i++) {
      if (!showTickets) break;

      const { ticket, count } = hotspots[i];
      const cacheKey = `${ticket.block}|${ticket.street}`;
      const isCached = geoCache[cacheKey] !== undefined ||
        !!sessionStorage.getItem('vpf_geo_' + cacheKey.replace(/\s/g, '_'));
      if (i > 0 && !isCached) await new Promise(r => setTimeout(r, 1100));
      if (!showTickets) break;

      const geo = await geocodeBlockStreet(ticket.block, ticket.street);
      if (!geo || !showTickets) continue;

      // Scale dot size 6–14 by relative frequency
      const radius = 6 + Math.round((count / maxCount) * 8);

      const latlng = [geo.lat, geo.lon];
      const m = L.circleMarker(latlng, {
        radius,
        fillColor: '#111111',
        fillOpacity: 0.8,
        color: '#ffffff',
        weight: 1.5,
      }).addTo(map);
      m.on('click', () => showTicketPanel({ ...ticket, count }, latlng));
      ticketMarkers.push(m);
    }
  } catch (err) {
    console.warn('Failed to load tickets:', err);
  } finally {
    ticketsLoading = false;
  }
}

function setupClosePanel() {
  document.getElementById('close-panel').addEventListener('click', () => {
    document.getElementById('info-panel').classList.add('hidden');
  });
}

// ─── Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('time-display').textContent = `as of ${formatTimeDisplay(now)}`;

    // Re-render markers when the hour or period changes
    const newInfo = getTimeInfo(now);
    if (currentTimeInfo && newInfo.period !== currentTimeInfo.period) {
      renderMarkers();
    } else {
      currentTimeInfo = newInfo;
    }
  }
  tick();
  setInterval(tick, 30000); // every 30s
}

// ─── Locate ────────────────────────────────────────────────────────────────
function setupLocateButton() {
  document.getElementById('locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('Geolocation not supported');
      return;
    }
    setStatus('Finding your location...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const loc = [pos.coords.latitude, pos.coords.longitude];
        map.setView(loc, 16);

        L.circleMarker(loc, {
          radius: 9,
          fillColor: '#1a73e8',
          fillOpacity: 1,
          color: '#ffffff',
          weight: 2,
        }).addTo(map);

        setStatus('Showing meters near you');
      },
      err => setStatus(`Location error: ${err.message}`)
    );
  });
}

// ─── Utilities ─────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initMap);

// ─── Service Worker ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}
