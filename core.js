'use strict';
/*
 * Pure logic for Vancouver Parking Finder (no DOM, no network).
 * Loaded in the browser as window.VPF and in Node (tests/core.test.js) via require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VPF = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const TZ = 'America/Vancouver';
  const WALK_M_PER_MIN = 80;   // ~4.8 km/h
  const DETOUR_FACTOR = 1.3;   // street grid vs. straight line
  const COST_STEP_HOURS = 0.25;

  // ─── Geometry ────────────────────────────────────────────────────────────
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Estimated walking minutes for a straight-line distance in metres. */
  function walkMinutes(straightMetres) {
    return (straightMetres * DETOUR_FACTOR) / WALK_M_PER_MIN;
  }

  /** Largest straight-line distance (m) that still fits in `minutes` of walking. */
  function maxStraightMeters(minutes) {
    return (minutes * WALK_M_PER_MIN) / DETOUR_FACTOR;
  }

  // ─── Vancouver time zone helpers ─────────────────────────────────────────
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let _fmt = null;
  function fmt() {
    if (!_fmt) {
      _fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, weekday: 'short', year: 'numeric', month: 'numeric',
        day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      });
    }
    return _fmt;
  }

  /** Wall-clock parts of `date` in Vancouver (independent of the device time zone). */
  function vancouverParts(date) {
    const o = {};
    for (const p of fmt().formatToParts(date)) o[p.type] = p.value;
    return {
      year: +o.year, month: +o.month, day: +o.day,
      hour: +o.hour % 24, minute: +o.minute, weekday: WEEKDAYS[o.weekday],
    };
  }

  /** Convert a Vancouver wall-clock time to a real Date. */
  function vancouverWallToDate(y, mo, d, h, mi) {
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    let guess = wall;
    for (let i = 0; i < 2; i++) { // second pass settles DST edges
      const p = vancouverParts(new Date(guess));
      const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      guess -= (shown - wall);
    }
    return new Date(guess);
  }

  /** Parse an <input type=datetime-local> value ("2026-11-06T20:30") as Vancouver time. */
  function parseWhenInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
    if (!m) return null;
    return vancouverWallToDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  function formatClock(date) {
    return date.toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  }

  // ─── Rates ───────────────────────────────────────────────────────────────
  function getTimeInfo(date = new Date()) {
    const p = vancouverParts(date);
    const totalMinutes = p.hour * 60 + p.minute;
    const isWeekend = p.weekday === 0 || p.weekday === 6;
    const isMorningPeak = totalMinutes >= 9 * 60 && totalMinutes < 18 * 60;
    const isEveningPeak = totalMinutes >= 18 * 60 && totalMinutes < 22 * 60;
    const isMetered = isMorningPeak || isEveningPeak;

    let period = null;
    if (isMorningPeak) period = isWeekend ? 'weekend_morning' : 'weekday_morning';
    else if (isEveningPeak) period = isWeekend ? 'weekend_evening' : 'weekday_evening';

    let periodEndsAt = null;
    if (isMorningPeak) periodEndsAt = '6:00 PM';
    else if (isEveningPeak) periodEndsAt = '10:00 PM';

    return {
      isWeekend, isMorningPeak, isEveningPeak, isMetered, period, periodEndsAt,
      hour: p.hour, minute: p.minute, day: p.weekday,
    };
  }

  function parseRate(rateStr) {
    if (!rateStr) return 0;
    const match = String(rateStr).match(/\$?\s*([\d.]+)/);
    return match ? parseFloat(match[1]) || 0 : 0;
  }

  function rateToColor(rate) {
    if (!rate) return 'grey';
    if (rate <= 1.5) return 'green';
    if (rate <= 3.0) return 'yellow';
    return 'red';
  }

  /** "2 Hr" -> 2, "30 Min" -> 0.5, "No time limit" / unknown -> null. */
  function parseLimitHours(limitStr) {
    if (!limitStr || /no\s*time\s*limit|unlimited/i.test(limitStr)) return null;
    const m = String(limitStr).match(/(\d+(?:\.\d+)?)\s*(hr|hour|h\b|min)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return /min/i.test(m[2]) ? n / 60 : n;
  }

  function getMeterStatus(meter, timeInfo) {
    if (!timeInfo.isMetered) {
      return { rate: 'Free', limit: 'No restrictions', limitWithExpiry: 'No restrictions', color: 'grey', score: 0, rawRate: 0, limitHours: null };
    }
    const morning = timeInfo.period === 'weekday_morning' || timeInfo.period === 'weekend_morning';
    let rateStr, limitStr;
    if (morning) {
      rateStr = meter.rate_9am_6pm;
      limitStr = timeInfo.isWeekend ? meter.time_limit_weekend_9am_6pm : meter.time_limit_9am_6pm;
    } else {
      rateStr = meter.rate_6pm_10pm;
      limitStr = timeInfo.isWeekend ? meter.time_limit_weekend_6pm_10pm : meter.time_limit_6pm_10pm;
    }
    if (!rateStr && meter.flat_rate) rateStr = meter.flat_rate;

    const rate = parseRate(rateStr);
    const hasTimeLimit = limitStr && !/no time limit/i.test(limitStr);
    const limitWithExpiry = hasTimeLimit && timeInfo.periodEndsAt
      ? `${limitStr} (until ${timeInfo.periodEndsAt})`
      : limitStr || 'Unknown';

    return {
      rate: rateStr || 'Unknown', limit: limitStr || 'Unknown', limitWithExpiry,
      color: rateToColor(rate), score: rate, rawRate: rate, limitHours: parseLimitHours(limitStr),
    };
  }

  /**
   * Cost of parking at `meter` from `start` for `hours`, sampled every 15 minutes
   * so stays that cross 6pm / 10pm / 9am are priced correctly.
   */
  function estimateCost(meter, start, hours) {
    const steps = Math.max(1, Math.round(hours / COST_STEP_HOURS));
    let cost = 0, meteredHours = 0, tightestLimit = null;
    for (let i = 0; i < steps; i++) {
      const t = new Date(start.getTime() + i * COST_STEP_HOURS * 3600 * 1000);
      const info = getTimeInfo(t);
      if (!info.isMetered) continue;
      const st = getMeterStatus(meter, info);
      cost += st.rawRate * COST_STEP_HOURS;
      meteredHours += COST_STEP_HOURS;
      if (st.limitHours != null) tightestLimit = tightestLimit == null ? st.limitHours : Math.min(tightestLimit, st.limitHours);
    }
    const exceedsLimit = tightestLimit != null && meteredHours > tightestLimit + 1e-9;
    return { cost: Math.round(cost * 100) / 100, meteredHours, tightestLimit, exceedsLimit };
  }

  // ─── Ranking ─────────────────────────────────────────────────────────────
  function meterLabel(m) {
    const street = m.streetname || m.street_name || m.street || '';
    const block = m.block || m.hundredblock || '';
    const where = [block, street].filter(Boolean).join(' ');
    return where || `Meter ${m.meter_id || ''}`.trim();
  }

  function demandFromColor(color) {
    return { green: 'Lower demand', yellow: 'Moderate demand', red: 'High demand' }[color] || '';
  }

  function ticketHotspotsNear(lat, lon, hotspots, radiusM = 150) {
    let n = 0;
    for (const h of hotspots || []) {
      if (haversine(lat, lon, h.lat, h.lon) <= radiusM) n += h.count || 1;
    }
    return n;
  }

  /**
   * Cheapest street meters within `maxMinutes` of walking from `dest`.
   * Sort: spots that fit the stay first, then total cost, then walk time.
   * Nearby spots that are effectively the same block are collapsed (keep the best one).
   */
  function rankMeters(meters, dest, opts) {
    const { maxMinutes, start, hours, limit = 8, dedupeMetres = 45, hotspots = [] } = opts;
    const maxM = maxStraightMeters(maxMinutes);
    const startInfo = getTimeInfo(start);
    const cands = [];
    for (const m of meters) {
      const g = m.geo_point_2d;
      if (!g || !g.lat || !g.lon) continue;
      const d = haversine(dest.lat, dest.lon, g.lat, g.lon);
      if (d > maxM) continue;
      const est = estimateCost(m, start, hours);
      const st = getMeterStatus(m, startInfo);
      cands.push({
        kind: 'meter', id: m.meter_id, lat: g.lat, lon: g.lon, label: meterLabel(m),
        distM: d, walkMin: walkMinutes(d),
        rateNow: st.rate, color: st.color, demand: demandFromColor(st.color),
        cost: est.cost, exceedsLimit: est.exceedsLimit, limit: st.limit, limitHours: est.tightestLimit,
        payment: m.credit_card === 'Yes' ? 'Card + coin' : 'Coin',
      });
    }
    cands.sort((a, b) =>
      (a.exceedsLimit - b.exceedsLimit) || (a.cost - b.cost) || (a.distM - b.distM));

    const kept = [];
    for (const c of cands) {
      if (kept.some(k => haversine(k.lat, k.lon, c.lat, c.lon) < dedupeMetres)) continue;
      kept.push(c);
      if (kept.length >= limit) break;
    }
    for (const k of kept) k.ticketsNearby = ticketHotspotsNear(k.lat, k.lon, hotspots);
    return kept;
  }

  /** Off-street lots within walking range, nearest first. Cost only if the lot has a known rate. */
  function rankLots(lots, dest, opts) {
    const { maxMinutes, hours, limit = 6 } = opts;
    const maxM = maxStraightMeters(maxMinutes);
    const out = [];
    for (const l of lots || []) {
      const d = haversine(dest.lat, dest.lon, l.lat, l.lon);
      if (d > maxM) continue;
      out.push({
        kind: 'lot', id: l.id, lat: l.lat, lon: l.lon, label: l.name || 'Parking lot',
        operator: l.operator || '', parking: l.parking || '', url: l.url || '', address: l.address || '',
        source: l.source || '', verify: !!l.verify,
        distM: d, walkMin: walkMinutes(d),
        ratePerHr: typeof l.rate_per_hr === 'number' ? l.rate_per_hr : null,
        cost: typeof l.rate_per_hr === 'number' ? Math.round(l.rate_per_hr * hours * 100) / 100 : null,
        capacity: l.capacity || null, fee: l.fee || null,
      });
    }
    out.sort((a, b) => a.distM - b.distM);
    return out.slice(0, limit);
  }

  // ─── Links / coordinates ─────────────────────────────────────────────────
  function formatCoords(lat, lon) { return `${lat.toFixed(6)}, ${lon.toFixed(6)}`; }

  function mapsDriveUrl(lat, lon) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
  }

  function mapsWalkUrl(from, to) {
    return 'https://www.google.com/maps/dir/?api=1' +
      `&origin=${from.lat.toFixed(6)},${from.lon.toFixed(6)}` +
      `&destination=${to.lat.toFixed(6)},${to.lon.toFixed(6)}&travelmode=walking`;
  }

  /** Accepts "49.2745, -123.1212" (also "49.2745 -123.1212"); returns null otherwise. */
  function parseLatLng(text) {
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text || '');
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function formatMoney(x) { return x === 0 ? 'Free' : `$${x.toFixed(2)}`; }

  // ─── Address / place autocomplete (Photon, OpenStreetMap-based) ──────────
  const PHOTON_URL = 'https://photon.komoot.io/api/';
  const VANCOUVER_BBOX = [-123.27, 49.19, -123.02, 49.32]; // minLon, minLat, maxLon, maxLat

  /** Photon request biased to the map centre and limited to Vancouver. */
  function buildPhotonUrl(query, center, limit = 6) {
    const p = new URLSearchParams({
      q: query, limit: String(limit), lang: 'en',
      lat: String(center.lat), lon: String(center.lon),
      bbox: VANCOUVER_BBOX.join(','),
    });
    return `${PHOTON_URL}?${p}`;
  }

  /** GeoJSON features from Photon -> [{label, sub, lat, lon}] with duplicates removed. */
  function formatPhotonResults(geojson, max = 6) {
    const out = [], seen = new Set();
    for (const f of (geojson && geojson.features) || []) {
      const p = f.properties || {};
      const c = f.geometry && f.geometry.coordinates;
      if (!c || c.length < 2) continue;
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const area = [p.district || p.locality, p.city].filter(Boolean).join(', ');
      const label = p.name || street || p.city;
      if (!label) continue;
      const sub = (p.name ? [street, area] : [area, p.postcode]).filter(Boolean).join(', ');
      const key = `${label}|${sub}|${c[1].toFixed(4)},${c[0].toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, sub, lat: c[1], lon: c[0] });
      if (out.length >= max) break;
    }
    return out;
  }

  // Group same-rate meters that sit next to each other into "blocks".
  // pts: [{lat, lon, color}]. Meters of the same colour within linkM metres are chained (minimum
  // spanning forest); chains of >= minSize meters become a block. Meters whose colour differs from
  // their neighbours never join a block, so they stay as individual "standout" dots.
  function groupBlocks(pts, linkM = 40, minSize = 2) {
    const kLat = 111320, kLon = 111320 * Math.cos(49.27 * Math.PI / 180);
    const xy = pts.map(p => [p.lon * kLon, p.lat * kLat]);
    const grid = new Map();
    const cell = linkM;
    const key = (cx, cy) => cx + ',' + cy;
    xy.forEach((q, i) => {
      const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    const edges = [];
    xy.forEach((q, i) => {
      const cx = Math.floor(q[0] / cell), cy = Math.floor(q[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) || []) {
          if (j <= i || pts[j].color !== pts[i].color) continue;
          const d = Math.hypot(q[0] - xy[j][0], q[1] - xy[j][1]);
          if (d <= linkM) edges.push([d, i, j]);
        }
      }
    });
    edges.sort((a, b) => a[0] - b[0]);
    const parent = pts.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const kept = [];
    for (const [, i, j] of edges) {
      const a = find(i), b = find(j);
      if (a !== b) { parent[a] = b; kept.push([i, j]); }
    }
    const comps = new Map();
    pts.forEach((_, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, { members: [], edges: [] }); comps.get(r).members.push(i); });
    kept.forEach(e => comps.get(find(e[0])).edges.push(e));
    const blocks = [], singles = [];
    for (const comp of comps.values()) {
      if (comp.members.length >= minSize) blocks.push({ color: pts[comp.members[0]].color, members: comp.members, edges: comp.edges });
      else singles.push(...comp.members);
    }
    return { blocks, singles };
  }

  // Decide how to draw street-aligned blocks (data/blocks.json). colorOf(id) -> colour name or null.
  // A block is drawn as one line in its majority colour (> minShare of its meters); meters of any other
  // colour stay as dots on top. A block with no clear majority is not drawn and all its meters stay dots.
  function resolveBlocks(blocks, colorOf, minShare = 0.5) {
    const lines = [], dots = [], seen = new Set();
    for (const b of blocks) {
      const ids = b.m.filter(id => colorOf(id));
      ids.forEach(id => seen.add(id));
      if (!ids.length) continue;
      const tally = {};
      ids.forEach(id => { const col = colorOf(id); tally[col] = (tally[col] || 0) + 1; });
      const [color, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (n / ids.length > minShare) {
        lines.push({ coords: b.c, color, members: ids, n: b.n, x: b.x });
        ids.forEach(id => { if (colorOf(id) !== color) dots.push(id); });
      } else {
        dots.push(...ids);
      }
    }
    return { lines, dots, seen };
  }

  // Price/limit schedule for hover tooltips and panels.
  // "2 Hr" -> "max 2h", "30 Min" -> "max 30 min", "No Time Limit" -> "no max", missing -> null
  function formatLimit(raw) {
    if (!raw) return null;
    if (/no\s*time\s*limit/i.test(raw)) return 'no max';
    const m = String(raw).match(/(\d+(?:\.\d+)?)\s*(hr|hour|min)/i);
    if (!m) return String(raw).toLowerCase();
    return /^h/i.test(m[2]) ? `max ${m[1]}h` : `max ${m[1]} min`;
  }

  function rateSignature(m) {
    return {
      r1: m.rate_9am_6pm || null, r2: m.rate_6pm_10pm || null,
      l1: formatLimit(m.time_limit_9am_6pm), l2: formatLimit(m.time_limit_6pm_10pm),
      w1: formatLimit(m.time_limit_weekend_9am_6pm), w2: formatLimit(m.time_limit_weekend_6pm_10pm),
    };
  }

  // Lines for one signature. 9am-10pm collapses into one line when rate and limit don't change at 6pm.
  // Outside 9am-10pm parking is free everywhere, so that is not listed.
  function signatureLines(s) {
    const part = (rate, lim, wk) => {
      const bits = [rate ? `${rate}/hr` : '—'];
      if (lim) bits.push(lim);
      if (wk && wk !== lim) bits.push(`weekends ${wk}`);
      return bits.join(' · ');
    };
    const t1 = part(s.r1, s.l1, s.w1), t2 = part(s.r2, s.l2, s.w2);
    if (t1 === t2) return [{ label: '9am–10pm', text: t1 }];
    return [{ label: '9am–6pm', text: t1 }, { label: '6pm–10pm', text: t2 }];
  }

  function meterSchedule(m) { return signatureLines(rateSignature(m)); }

  // Whole block: the most common pricing in full, then (at most two) other pricings that also occur on it.
  function blockSchedule(meters) {
    const tally = new Map();
    meters.forEach(m => {
      const sig = rateSignature(m), key = JSON.stringify(sig);
      if (!tally.has(key)) tally.set(key, { sig, n: 0 });
      tally.get(key).n++;
    });
    const groups = [...tally.values()].sort((a, b) => b.n - a.n);
    const lines = signatureLines(groups[0].sig);
    groups.slice(1, 3).forEach(g => {
      signatureLines(g.sig).forEach(l => lines.push({ label: 'Also', text: `${l.label} ${l.text}`, extra: true }));
    });
    return lines;
  }

  // { title: "Meter on Smithe St", sub: "Richards St to Seymour St" }. Falls back to "Meter #123" without street data.
  function meterName(b, meterId) {
    if (!b || !b.n) return { title: meterId != null && meterId !== '' ? `Meter #${meterId}` : 'Parking meter', sub: '' };
    const [from, to] = b.x || [];
    const sub = from && to ? `${from} to ${to}` : (from || to) ? `near ${from || to}` : '';
    return { title: `Meter on ${b.n}`, sub };
  }

  // "Smithe St, Richards St to Seymour St" / "Smithe St near Richards St" / "Smithe St"
  function blockTitle(b) {
    if (!b || !b.n) return null;
    const [from, to] = b.x || [];
    if (from && to) return `${b.n}, ${from} to ${to}`;
    if (from || to) return `${b.n} near ${from || to}`;
    return b.n;
  }

  return {
    TZ, WALK_M_PER_MIN, DETOUR_FACTOR,
    haversine, walkMinutes, maxStraightMeters,
    vancouverParts, vancouverWallToDate, parseWhenInput, formatClock,
    getTimeInfo, parseRate, rateToColor, parseLimitHours, getMeterStatus, estimateCost,
    meterLabel, demandFromColor, ticketHotspotsNear, rankMeters, rankLots,
    formatCoords, mapsDriveUrl, mapsWalkUrl, parseLatLng, formatMoney,
    VANCOUVER_BBOX, buildPhotonUrl, formatPhotonResults, groupBlocks, resolveBlocks, meterSchedule, blockSchedule, blockTitle, meterName, formatLimit,
  };
});
