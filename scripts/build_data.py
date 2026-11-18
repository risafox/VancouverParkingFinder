#!/usr/bin/env python3
"""
Weekly data builder for Vancouver Parking Finder (standard library only).

Writes static JSON into ./data so the web app never has to hit the City API
page-by-page in the browser:

  data/meters.json   all street meters (trimmed)           <- City of Vancouver Open Data
  data/tickets.json  geocoded ticket hotspots (last full year)
  data/lots.json     off-street lots                        <- OpenStreetMap (Overpass) + data/lots_curated.json
  data/meta.json     generated_at, counts, warnings
  data/geocode_cache.json  Nominatim results, so weekly runs only geocode new places

Usage:
  python3 scripts/build_data.py                 # everything
  python3 scripts/build_data.py --only meters   # meters | tickets | lots | blocks
  python3 scripts/build_data.py --skip-geocode  # no Nominatim calls (cache only)

A stage that fails keeps the previous file and records a warning in meta.json.
Exit code is 1 only if the meters stage fails (the app can't work without it).
"""
import argparse
import http.client
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "VancouverParkingFinder/2.0 (+https://github.com/risafox/VancouverParkingFinder)"

OD = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# south, west, north, east: City of Vancouver incl. UBC/Pacific Spirit margin
BBOX = (49.19, -123.27, 49.32, -123.02)
# Fallback if the whole-city Overpass query keeps timing out: downtown + Yaletown + West End + Gastown
DOWNTOWN_BBOX = (49.262, -123.150, 49.292, -123.090)

METER_KEEP = re.compile(
    r"^(meter_?id|meterhead|credit_card|flat_rate|.*rate.*|.*limit.*|.*street.*|.*block.*|.*pay_?by.*|.*type.*)$",
    re.I,
)
PRIVATE_ACCESS = {"private", "customers", "permit", "residents", "delivery", "no", "employees", "students", "agricultural"}


# ─── HTTP ───────────────────────────────────────────────────────────────────
def http_json(url, data=None, retries=3, timeout=180, headers=None):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        # OSError covers URLError, socket/SSL read timeouts (ssl.SSLError), resets, etc.
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url[:120]} failed: {last}")


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


# ─── Geocoding (Nominatim, 1 req/sec, cached) ───────────────────────────────
class Geocoder:
    MISS_RETRY_DAYS = 30

    def __init__(self, cache_path, fetch=http_json, sleep=time.sleep, enabled=True):
        self.path = cache_path
        self.cache = read_json(cache_path, {})
        self.fetch, self.sleep, self.enabled = fetch, sleep, enabled
        self._last = 0.0
        self.new_lookups = 0

    def _fresh_miss(self, entry):
        try:
            when = datetime.fromisoformat(entry["miss"])
        except (KeyError, ValueError):
            return False
        return datetime.now(timezone.utc) - when < timedelta(days=self.MISS_RETRY_DAYS)

    def lookup(self, query):
        entry = self.cache.get(query)
        if entry and "lat" in entry:
            return entry["lat"], entry["lon"]
        if entry and self._fresh_miss(entry):
            return None
        if not self.enabled:
            return None
        wait = 1.1 - (time.monotonic() - self._last)
        if wait > 0:
            self.sleep(wait)
        self._last = time.monotonic()
        params = urllib.parse.urlencode({
            "q": query, "format": "jsonv2", "limit": 1, "countrycodes": "ca",
            "viewbox": f"{BBOX[1]},{BBOX[2]},{BBOX[3]},{BBOX[0]}", "bounded": 1,
        })
        self.new_lookups += 1
        try:
            res = self.fetch(f"{NOMINATIM}?{params}", retries=2, timeout=30)
        except RuntimeError:
            return None  # network blip: don't cache a miss
        if res:
            self.cache[query] = {"lat": round(float(res[0]["lat"]), 6), "lon": round(float(res[0]["lon"]), 6)}
            return self.cache[query]["lat"], self.cache[query]["lon"]
        self.cache[query] = {"miss": datetime.now(timezone.utc).isoformat()}
        return None

    def save(self):
        write_json(self.path, self.cache)


# ─── Meters ─────────────────────────────────────────────────────────────────
def trim_meter(rec):
    g = rec.get("geo_point_2d")
    if not g or g.get("lat") is None or g.get("lon") is None:
        return None
    out = {k: v for k, v in rec.items() if k != "geo_point_2d" and v not in (None, "") and METER_KEEP.match(k)}
    out["geo_point_2d"] = {"lat": round(g["lat"], 6), "lon": round(g["lon"], 6)}
    return out


def fetch_meters():
    base = f"{OD}/parking-meters"
    try:  # one request for everything
        recs = http_json(f"{base}/exports/json?timezone=America/Vancouver")
        if not isinstance(recs, list) or not recs:
            raise RuntimeError("empty export")
    except RuntimeError as e:
        print(f"  export failed ({e}); paging instead", file=sys.stderr)
        recs, offset, total = [], 0, None
        while total is None or offset < total:
            page = http_json(f"{base}/records?limit=100&offset={offset}&timezone=America/Vancouver&include_links=false&include_app_metas=false")
            total = page["total_count"]
            recs.extend(page["results"])
            offset += 100
    meters = [m for m in (trim_meter(r) for r in recs) if m]
    if len(meters) < 500:  # ~3,800 expected; refuse to publish a broken pull
        raise RuntimeError(f"only {len(meters)} meters with coordinates")
    return meters


# ─── Tickets ────────────────────────────────────────────────────────────────
def pick_year(rows):
    """rows: [{'year': '2025', 'n': 12345}, ...]. Latest year with at least half the busiest year's volume."""
    clean = []
    for r in rows:
        try:
            clean.append((int(r["year"]), int(r["n"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not clean:
        return None
    biggest = max(n for _, n in clean)
    full = [y for y, n in clean if n >= biggest * 0.5]
    return str(max(full))


def fetch_ticket_hotspots(geocoder, warnings, top_n=100):
    base = f"{OD}/parking-tickets/records"

    def q(**params):
        return http_json(f"{base}?{urllib.parse.urlencode(params)}")

    years = q(select="year, count(*) as n", group_by="year", order_by="year desc", limit=8)["results"]
    year = pick_year(years)
    if not year:
        raise RuntimeError("could not determine ticket year")

    attempts = [
        f'year="{year}" AND infractiontext LIKE "METER"',
        f'year="{year}"',
    ]
    rows = []
    for where in attempts:
        res = q(select="block, street, count(*) as n", group_by="block, street", order_by="n desc", where=where, limit=top_n)
        rows = res.get("results", [])
        if rows:
            if where != attempts[0]:
                warnings.append("ticket infraction filter matched nothing; used all ticket types")
            break
    if not rows:
        raise RuntimeError(f"no ticket rows for {year}")

    hotspots = []
    for r in rows:
        block, street = str(r.get("block") or "").strip(), str(r.get("street") or "").strip()
        if not street:
            continue
        place = f"{block} {street}".strip() if block not in ("", "0") else street
        pos = geocoder.lookup(f"{place}, Vancouver, BC")
        if not pos:
            continue
        hotspots.append({"block": block, "street": street, "count": int(r["n"]), "lat": pos[0], "lon": pos[1]})
    if len(hotspots) < 5:
        raise RuntimeError(f"only {len(hotspots)} ticket hotspots could be geocoded")
    return {"year": year, "hotspots": hotspots}


# ─── Lots ───────────────────────────────────────────────────────────────────
def parse_charge(tag):
    """OSM 'charge' like '3.50 CAD/hour' or '$4/h' -> 3.5 (per hour) or None."""
    if not tag:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:CAD|\$)?\s*/\s*(?:h|hr|hour)", str(tag), re.I)
    return float(m.group(1)) if m else None


def is_public_lot(tags):
    access = (tags.get("access") or "").lower()
    if access in PRIVATE_ACCESS:
        return False
    if tags.get("parking") in ("street_side", "lane", "layby", "on_kerb", "carports", "garage_boxes", "sheds"):
        return False
    if tags.get("amenity") != "parking":
        return False
    # Most untagged OSM lots are private residential garages. Keep ones with a public signal.
    return bool(
        access in ("yes", "public", "permissive")
        or tags.get("fee") == "yes"
        or tags.get("name")
        or tags.get("operator")
    )


def normalise_osm_element(el):
    tags = el.get("tags", {})
    if not is_public_lot(tags):
        return None
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lon = el.get("lon") or (el.get("center") or {}).get("lon")
    if lat is None or lon is None:
        return None
    cap = tags.get("capacity")
    return {
        "id": f"osm/{el['type']}/{el['id']}",
        "name": tags.get("name") or tags.get("operator") or "Parking lot",
        "operator": tags.get("operator", ""),
        "parking": tags.get("parking", ""),
        "fee": tags.get("fee"),
        "capacity": int(cap) if cap and cap.isdigit() else None,
        "rate_per_hr": parse_charge(tags.get("charge")),
        "lat": round(lat, 6), "lon": round(lon, 6),
        "source": "osm",
    }


def overpass_query(box, server_timeout=55):
    s_, w, n, e = box
    # Filter on the server so Overpass returns far less than every car park in the city
    return (
        f"[out:json][timeout:{server_timeout}];"
        '(nwr["amenity"="parking"]'
        '["access"!~"^(private|customers|permit|residents|delivery|no|employees|students)$"]'
        '["parking"!~"^(street_side|lane|layby|on_kerb|carports|garage_boxes|sheds)$"]'
        f"({s_},{w},{n},{e}););out center tags;"
    )


def fetch_osm_lots(post=http_json):
    """Try the whole city on each mirror, then just downtown. Short per-attempt timeouts so it fails fast."""
    last = None
    for label, box in (("city", BBOX), ("downtown only", DOWNTOWN_BBOX)):
        body = urllib.parse.urlencode({"data": overpass_query(box)}).encode()
        for ep in OVERPASS_ENDPOINTS:
            print(f"  Overpass ({label}) {urllib.parse.urlparse(ep).netloc} ...", flush=True)
            try:
                res = post(ep, data=body, retries=1, timeout=75, headers={"Content-Type": "application/x-www-form-urlencoded"})
            except RuntimeError as err:
                last = err
                continue
            lots = [x for x in (normalise_osm_element(el) for el in res.get("elements", [])) if x]
            if lots:
                if label != "city":
                    print("  (used downtown-only fallback)")
                return lots
            last = RuntimeError("no elements")
    raise RuntimeError(f"Overpass failed on every mirror: {last}")


def load_curated(geocoder):
    path = DATA / "lots_curated.json"
    out = []
    for item in read_json(path, []):
        lat, lon = item.get("lat"), item.get("lon")
        if lat is None or lon is None:
            pos = geocoder.lookup(f'{item["address"]}, Vancouver, BC')
            if not pos:
                continue
            lat, lon = pos
        out.append({
            "id": "curated/" + re.sub(r"[^a-z0-9]+", "-", item["name"].lower()).strip("-"),
            "name": item["name"], "operator": item.get("operator", ""), "address": item.get("address", ""),
            "parking": item.get("parking", ""), "rate_per_hr": item.get("rate_per_hr"),
            "url": item.get("url", ""), "verify": item.get("verify", True),
            "lat": round(lat, 6), "lon": round(lon, 6), "source": "curated",
        })
    return out


def merge_lots(osm, curated, near_m=50):
    """Curated entries win; drop OSM lots that sit on top of a curated one."""
    kept = [o for o in osm if not any(haversine(o["lat"], o["lon"], c["lat"], c["lon"]) < near_m for c in curated)]
    return curated + kept


# ─── Orchestration ──────────────────────────────────────────────────────────
def do_blocks_stage(meters, warnings, post=http_json, refresh=False, budget_min=12):
    sys.path.insert(0, str(ROOT / "scripts"))
    import blocks as B
    pts = [{"id": str(m.get("meter_id", i)), "lat": m["geo_point_2d"]["lat"], "lon": m["geo_point_2d"]["lon"]}
           for i, m in enumerate(meters) if m.get("geo_point_2d")]
    boxes = B.tile_boxes([(p["lat"], p["lon"]) for p in pts])
    cache_dir = ROOT / ".cache" / "streets"
    if refresh and cache_dir.exists():
        for f in cache_dir.glob("*.json"):
            f.unlink()
    ways = B.fetch_streets(boxes, OVERPASS_ENDPOINTS, post, warnings, cache_dir=cache_dir, budget_s=budget_min * 60)
    segments = B.split_ways(ways)
    return B.build_blocks(segments, pts), len(segments), len(pts)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["meters", "tickets", "lots", "blocks"])
    ap.add_argument("--skip-geocode", action="store_true")
    ap.add_argument("--street-minutes", type=int, default=12, help="stop downloading street tiles after this many minutes (progress is cached; re-run to continue)")
    ap.add_argument("--refresh-streets", action="store_true", help="ignore the street-tile cache and re-download everything")
    args = ap.parse_args(argv)

    DATA.mkdir(exist_ok=True)
    meta = read_json(DATA / "meta.json", {})
    warnings, counts, failed_meters = [], meta.get("counts", {}), False
    geocoder = Geocoder(DATA / "geocode_cache.json", enabled=not args.skip_geocode)

    def stage(name, fn):
        nonlocal failed_meters
        if args.only and args.only != name:
            return
        print(f"[{name}] ...", flush=True)
        try:
            fn()
        except Exception as e:  # keep previous file, report
            msg = f"{name}: {e}"
            print(f"  FAILED {msg}", file=sys.stderr)
            warnings.append(msg)
            if name == "meters":
                failed_meters = True

    def do_meters():
        meters = fetch_meters()
        write_json(DATA / "meters.json", meters)
        counts["meters"] = len(meters)
        print(f"  {len(meters)} meters")

    def do_tickets():
        t = fetch_ticket_hotspots(geocoder, warnings)
        write_json(DATA / "tickets.json", t)
        counts["ticket_hotspots"], meta["ticket_year"] = len(t["hotspots"]), t["year"]
        print(f"  {len(t['hotspots'])} hotspots for {t['year']}")

    def do_lots():
        curated = load_curated(geocoder)
        try:
            osm = fetch_osm_lots()
        except RuntimeError as e:
            warnings.append(f"lots: OSM unavailable, curated only ({e})")
            osm = []
        lots = merge_lots(osm, curated)
        if not lots:
            raise RuntimeError("no lots")
        write_json(DATA / "lots.json", lots)
        counts["lots"], counts["lots_curated"] = len(lots), len(curated)
        print(f"  {len(lots)} lots ({len(curated)} curated)")

    def do_blocks():
        meters = read_json(DATA / "meters.json", [])
        if not meters:
            raise RuntimeError("data/meters.json missing; run the meters stage first")
        blocks, n_segs, n_meters = do_blocks_stage(meters, warnings, refresh=args.refresh_streets, budget_min=args.street_minutes)
        snapped = sum(len(b["m"]) for b in blocks)
        if snapped < 0.5 * n_meters:
            raise RuntimeError(f"only {snapped}/{n_meters} meters snapped to streets; keeping the old blocks.json")
        write_json(DATA / "blocks.json", blocks)
        counts["blocks"] = len(blocks)
        print(f"  {len(blocks)} blocks from {n_segs} street segments; {snapped}/{n_meters} meters snapped")

    stage("meters", do_meters)
    stage("tickets", do_tickets)
    stage("lots", do_lots)
    stage("blocks", do_blocks)
    geocoder.save()

    if not failed_meters:  # keep the old timestamp if the meter pull failed
        meta["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta.update({
        "counts": counts,
        "warnings": warnings,
        "sources": {
            "meters": "City of Vancouver Open Data: parking-meters",
            "tickets": "City of Vancouver Open Data: parking-tickets (block-level, geocoded via Nominatim)",
            "lots": "OpenStreetMap contributors (Overpass) + data/lots_curated.json",
            "blocks": "OpenStreetMap contributors (Overpass): street centrelines, split at intersections",
        },
    })
    write_json(DATA / "meta.json", meta)
    return 1 if failed_meters else 0


if __name__ == "__main__":
    sys.exit(main())
