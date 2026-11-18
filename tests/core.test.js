'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../core.js');

const meter = (over = {}) => ({
  meter_id: 'M1', geo_point_2d: { lat: 49.2745, lon: -123.1212 },
  rate_9am_6pm: '$3.00', rate_6pm_10pm: '$2.00',
  time_limit_9am_6pm: '2 Hr', time_limit_6pm_10pm: '4 Hr',
  time_limit_weekend_9am_6pm: '2 Hr', time_limit_weekend_6pm_10pm: '4 Hr',
  credit_card: 'Yes', streetname: 'HORNBY ST', ...over,
});

test('haversine ~ known distance (Granville St: 100m of latitude ≈ 111m per 0.001°)', () => {
  const d = V.haversine(49.0, -123.0, 49.001, -123.0);
  assert.ok(Math.abs(d - 111.2) < 0.5, String(d));
});

test('walk time / radius are inverses', () => {
  const m = V.maxStraightMeters(10);
  assert.ok(Math.abs(V.walkMinutes(m) - 10) < 1e-9);
  assert.ok(m > 550 && m < 650); // ~615 m straight line for 10 min
});

test('Vancouver time: wall-clock -> Date respects PST/PDT', () => {
  // Jul 15 2026 is PDT (UTC-7) under any tzdata
  assert.equal(V.vancouverWallToDate(2026, 7, 15, 12, 0).toISOString(), '2026-07-15T19:00:00.000Z');
  // Jan 15 2026 is PST (UTC-8)
  assert.equal(V.vancouverWallToDate(2026, 1, 15, 12, 0).toISOString(), '2026-01-15T20:00:00.000Z');
  // Round trips hold regardless of DST rules (incl. days around transitions)
  for (const [y, mo, d, h, mi] of [[2026, 3, 8, 12, 0], [2026, 3, 9, 9, 0], [2026, 11, 1, 12, 0], [2026, 11, 6, 20, 31], [2027, 1, 3, 0, 15]]) {
    const p = V.vancouverParts(V.vancouverWallToDate(y, mo, d, h, mi));
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [y, mo, d, h, mi]);
  }
});

test('getTimeInfo uses Vancouver time not device time', () => {
  // Fri 2026-11-06 20:31 Vancouver (== Sat UTC) must be weekday evening, not weekend
  const info = V.getTimeInfo(V.vancouverWallToDate(2026, 11, 6, 20, 31));
  assert.equal(info.period, 'weekday_evening');
  assert.equal(info.isWeekend, false);
  // 23:00 Vancouver -> free
  assert.equal(V.getTimeInfo(V.vancouverWallToDate(2026, 11, 6, 23, 0)).isMetered, false);
  // Sat 10:00 -> weekend_morning
  assert.equal(V.getTimeInfo(V.vancouverWallToDate(2026, 11, 7, 10, 0)).period, 'weekend_morning');
});

test('parseWhenInput', () => {
  const p = V.vancouverParts(V.parseWhenInput('2026-11-06T20:30'));
  assert.deepEqual([p.day, p.hour, p.minute], [6, 20, 30]);
  assert.equal(V.parseWhenInput(''), null);
});

test('parseLimitHours', () => {
  assert.equal(V.parseLimitHours('2 Hr'), 2);
  assert.equal(V.parseLimitHours('30 Min'), 0.5);
  assert.equal(V.parseLimitHours('No time limit'), null);
  assert.equal(V.parseLimitHours(undefined), null);
});

test('estimateCost prices across the 6pm rate boundary', () => {
  // Fri 5pm for 2h: 1h @ $3 + 1h @ $2 = $5
  const start = V.vancouverWallToDate(2026, 11, 6, 17, 0);
  const r = V.estimateCost(meter(), start, 2);
  assert.equal(r.cost, 5);
  assert.equal(r.exceedsLimit, false); // tightest limit 2h, metered 2h
});

test('estimateCost: free after 10pm and limit flag', () => {
  const late = V.vancouverWallToDate(2026, 11, 6, 21, 0); // 9pm, 3h => 1h metered, then free
  assert.equal(V.estimateCost(meter(), late, 3).cost, 2);
  const day = V.vancouverWallToDate(2026, 11, 6, 10, 0);
  const r = V.estimateCost(meter(), day, 4); // 4h at $3 with 2h limit
  assert.equal(r.cost, 12);
  assert.equal(r.exceedsLimit, true);
  const free = V.vancouverWallToDate(2026, 11, 6, 23, 0);
  assert.equal(V.estimateCost(meter(), free, 2).cost, 0);
});

test('rankMeters: radius filter, cost sort, dedupe, limit-fit first', () => {
  const dest = { lat: 49.2745, lon: -123.1212 };
  const mk = (id, dLat, dLon, rate, limit = '4 Hr') => meter({
    meter_id: id, geo_point_2d: { lat: dest.lat + dLat, lon: dest.lon + dLon },
    rate_9am_6pm: rate, rate_6pm_10pm: rate, time_limit_9am_6pm: limit, time_limit_6pm_10pm: limit,
  });
  const meters = [
    mk('cheap-near', 0.0005, 0, '$1.00'),
    mk('cheap-dup', 0.00052, 0, '$1.00'),         // ~2 m from cheap-near -> collapsed
    mk('mid', 0, 0.003, '$2.00'),
    mk('cheapest-but-short', 0.001, 0.001, '$0.50', '1 Hr'), // exceeds 2h stay
    mk('far', 0.02, 0, '$0.25'),                  // way outside 10 min
  ];
  const start = V.vancouverWallToDate(2026, 11, 6, 11, 0);
  const out = V.rankMeters(meters, dest, { maxMinutes: 10, start, hours: 2, limit: 10 });
  const ids = out.map(o => o.id);
  assert.deepEqual(ids, ['cheap-near', 'mid', 'cheapest-but-short']);
  assert.equal(out[0].cost, 2);
  assert.ok(out[2].exceedsLimit);
  assert.ok(!ids.includes('far'));
});

test('rankLots sorts by distance and prices known rates', () => {
  const dest = { lat: 49.2745, lon: -123.1212 };
  const lots = [
    { id: 'a', name: 'A', lat: 49.2745, lon: -123.1190, rate_per_hr: 4 },
    { id: 'b', name: 'B', lat: 49.2746, lon: -123.1213 },
    { id: 'c', name: 'C', lat: 49.30, lon: -123.12 },
  ];
  const out = V.rankLots(lots, dest, { maxMinutes: 10, hours: 3 });
  assert.deepEqual(out.map(o => o.id), ['b', 'a']);
  assert.equal(out[0].cost, null);
  assert.equal(out[1].cost, 12);
});

test('links and coordinate parsing', () => {
  assert.equal(V.formatCoords(49.27451234, -123.1212), '49.274512, -123.121200');
  assert.match(V.mapsDriveUrl(49.2745, -123.1212), /destination=49\.274500,-123\.121200&travelmode=driving$/);
  assert.match(V.mapsWalkUrl({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }), /origin=1\.000000,2\.000000&destination=3\.000000,4\.000000&travelmode=walking/);
  assert.deepEqual(V.parseLatLng('49.2745, -123.1212'), { lat: 49.2745, lon: -123.1212 });
  assert.equal(V.parseLatLng('soho pool bar'), null);
  assert.equal(V.parseLatLng('95, 10'), null);
});

test('buildPhotonUrl biases to map centre and restricts to Vancouver', () => {
  const u = new URL(V.buildPhotonUrl('soho pool', { lat: 49.28, lon: -123.12 }));
  assert.equal(u.origin + u.pathname, 'https://photon.komoot.io/api/');
  assert.equal(u.searchParams.get('q'), 'soho pool');
  assert.equal(u.searchParams.get('lat'), '49.28');
  assert.equal(u.searchParams.get('lon'), '-123.12');
  assert.equal(u.searchParams.get('bbox'), '-123.27,49.19,-123.02,49.32');
  assert.equal(u.searchParams.get('limit'), '6');
});

test('formatPhotonResults: POIs, addresses, dedupe, junk', () => {
  const feat = (props, lon = -123.12, lat = 49.27) => ({ geometry: { coordinates: [lon, lat] }, properties: props });
  const out = V.formatPhotonResults({ features: [
    feat({ name: 'Soho Pool Bar', housenumber: '1144', street: 'Homer Street', district: 'Yaletown', city: 'Vancouver' }),
    feat({ name: 'Soho Pool Bar', housenumber: '1144', street: 'Homer Street', district: 'Yaletown', city: 'Vancouver' }), // dup
    feat({ housenumber: '909', street: 'Mainland Street', city: 'Vancouver', postcode: 'V6B 1S3' }, -123.1, 49.2),
    { geometry: null, properties: { name: 'No coords' } },
    feat({}),
  ] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { label: 'Soho Pool Bar', sub: '1144 Homer Street, Yaletown, Vancouver', lat: 49.27, lon: -123.12 });
  assert.equal(out[1].label, '909 Mainland Street');
  assert.equal(out[1].sub, 'Vancouver, V6B 1S3');
  assert.deepEqual(V.formatPhotonResults(null), []);
});

test('groupBlocks chains same-colour neighbours and leaves standouts', () => {
  const { groupBlocks } = require('../core.js');
  const lat = 49.27, lon0 = -123.12, dLon = 10 / (111320 * Math.cos(lat * Math.PI / 180));
  const pts = [];
  for (let i = 0; i < 6; i++) pts.push({ lat, lon: lon0 + i * dLon, color: i === 3 ? 'red' : 'yellow' });
  pts.push({ lat: lat + 0.01, lon: lon0, color: 'yellow' }); // far away, alone
  const { blocks, singles } = groupBlocks(pts);
  // the red meter (3) is a standout dot; the yellow chain continues past it (gap 20 m) as one block
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].members.sort(), [0, 1, 2, 4, 5]);
  assert.deepEqual(singles.sort(), [3, 6]);
  assert.equal(blocks[0].edges.length, 4);
});

test('resolveBlocks: majority colour line, minority meters stay as dots', () => {
  const { resolveBlocks } = require('../core.js');
  const col = { a: 'red', b: 'red', c: 'yellow', d: 'red', e: 'green', f: 'red', g: 'green' };
  const blocks = [{ c: [[0, 0], [0, 1]], m: ['a', 'b', 'c', 'd'] }, { c: [[1, 0], [1, 1]], m: ['e', 'f'] }];
  const { lines, dots, seen } = resolveBlocks(blocks, id => col[id]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].color, 'red');
  assert.deepEqual(lines[0].members, ['a', 'b', 'c', 'd']);
  assert.deepEqual(dots.sort(), ['c', 'e', 'f']); // yellow on the red block; 1-1 tie block is all dots
  assert.ok(seen.has('a') && !seen.has('g'));
});

test('meterSchedule collapses 9am-10pm when nothing changes at 6pm', () => {
  const { meterSchedule, blockSchedule, blockTitle, formatLimit } = require('../core.js');
  assert.equal(formatLimit('2 Hr'), 'max 2h');
  assert.equal(formatLimit('30 Min'), 'max 30 min');
  assert.equal(formatLimit('No Time Limit'), 'no max');
  assert.equal(formatLimit(null), null);
  const same = { rate_9am_6pm: '$3.50', rate_6pm_10pm: '$3.50', time_limit_9am_6pm: '2 Hr', time_limit_6pm_10pm: '2 Hr' };
  assert.deepEqual(meterSchedule(same), [{ label: '9am–10pm', text: '$3.50/hr · max 2h' }]);
  const diff = { rate_9am_6pm: '$5.50', rate_6pm_10pm: '$3.00', time_limit_9am_6pm: '2 Hr', time_limit_weekend_9am_6pm: '4 Hr', time_limit_6pm_10pm: '4 Hr' };
  const d = meterSchedule(diff);
  assert.equal(d.length, 2);
  assert.equal(d[0].text, '$5.50/hr · max 2h · weekends max 4h');
  assert.equal(d[1].text, '$3.00/hr · max 4h');
  assert.ok(!JSON.stringify(d).includes('free'));
  const b = blockSchedule([same, same, { ...same, rate_9am_6pm: '$7.00', rate_6pm_10pm: '$7.00' }]);
  assert.equal(b[0].text, '$3.50/hr · max 2h');
  assert.equal(b[1].extra, true);
  assert.equal(b[1].text, '9am–10pm $7.00/hr · max 2h');
});

test('blockTitle', () => {
  const { blockTitle } = require('../core.js');
  assert.equal(blockTitle({ n: 'Smithe St', x: ['Richards St', 'Seymour St'] }), 'Smithe St, Richards St to Seymour St');
  assert.equal(blockTitle({ n: 'Smithe St', x: [null, 'Seymour St'] }), 'Smithe St near Seymour St');
  assert.equal(blockTitle({ n: 'Smithe St' }), 'Smithe St');
  assert.equal(blockTitle({}), null);
});

test('meterName', () => {
  const { meterName } = require('../core.js');
  assert.deepEqual(meterName({ n: 'Smithe St', x: ['Richards St', 'Seymour St'] }, '5'), { title: 'Meter on Smithe St', sub: 'Richards St to Seymour St' });
  assert.deepEqual(meterName({ n: 'Smithe St', x: [null, 'Seymour St'] }, '5'), { title: 'Meter on Smithe St', sub: 'near Seymour St' });
  assert.deepEqual(meterName(undefined, '5'), { title: 'Meter #5', sub: '' });
});
