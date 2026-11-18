"""Street-aligned blocks: snap meters onto OpenStreetMap street segments (one segment = one block
between two intersections), so the site can colour a whole block when its meters share a rate.

Pure functions (no network) except `fetch_streets`, which takes an injectable `post`.
Output of `build_blocks` is a list of {"c": [[lat, lon], ...], "m": [meter_id, ...]}.
"""
import json
import math
import time
import urllib.parse
from pathlib import Path

HIGHWAYS = "primary|secondary|tertiary|residential|unclassified|living_street"
SNAP_M = 30          # a meter further than this from any street is left as a lone dot
MIN_SEG_M = 12       # ignore stub segments shorter than this
MAX_FULL_M = 220     # longer segments are clipped to the meters' span (+ PAD_M) instead of drawn in full
PAD_M = 40
CELL = 40.0
K_LAT = 111320.0
K_LON = 111320.0 * math.cos(math.radians(49.27))


def streets_query(box, server_timeout=55):
    s, w, n, e = box
    return (f"[out:json][timeout:{server_timeout}];"
            f'way["highway"~"^({HIGHWAYS})$"]({s},{w},{n},{e});out body geom;')


def tile_boxes(points, step_lat=0.015, step_lon=0.0225, pad=0.0007):
    """Bounding boxes (s, w, n, e) of the grid tiles that actually contain meters."""
    tiles = {}
    for lat, lon in points:
        tiles.setdefault((math.floor(lat / step_lat), math.floor(lon / step_lon)), []).append((lat, lon))
    boxes = []
    for pts in tiles.values():
        lats, lons = [p[0] for p in pts], [p[1] for p in pts]
        boxes.append((round(min(lats) - pad - 0.002, 5), round(min(lons) - pad - 0.003, 5),
                      round(max(lats) + pad + 0.002, 5), round(max(lons) + pad + 0.003, 5)))
    return boxes


MIRROR_STRIKES = 3  # consecutive failures before a mirror is skipped for the rest of the run
BAD_REMARK = ("timed out", "timeout", "runtime error", "out of memory", "too busy", "rate_limited")


def _fetch_tile(box, endpoints, post, label, strikes=None, started=None):
    """One tile on the first mirror that answers properly, or None. Overpass reports a server-side timeout
    as HTTP 200 with a 'remark' and (partial) elements, so that counts as a failure, not a success."""
    body = urllib.parse.urlencode({"data": streets_query(box, server_timeout=50)}).encode()
    strikes = strikes if strikes is not None else {}
    for ep in endpoints:
        if strikes.get(ep, 0) >= MIRROR_STRIKES:  # this mirror kept failing in this run: stop wasting time on it
            continue
        t = f" [{int(time.time() - started)}s]" if started else ""
        print(f"  streets {label} via {urllib.parse.urlparse(ep).netloc}{t}", flush=True)
        try:
            res = post(ep, data=body, retries=1, timeout=70, headers={"Content-Type": "application/x-www-form-urlencoded"})
        except RuntimeError:
            strikes[ep] = strikes.get(ep, 0) + 1
            continue
        remark = str(res.get("remark", "")).lower()
        if any(w in remark for w in BAD_REMARK):
            strikes[ep] = strikes.get(ep, 0) + 1
            continue
        strikes[ep] = 0
        return [el for el in res.get("elements", []) if el.get("type") == "way" and el.get("geometry") and el.get("nodes")]
    return None


def _quarters(box):
    s, w, n, e = box
    ms, mw = (s + n) / 2, (w + e) / 2
    return [(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]


CACHE_VERSION = 2  # v2 keeps way names (street + cross-street labels); older cache files are ignored
CACHE_MAX_AGE_S = 60 * 24 * 3600  # street layouts barely change


def _cache_path(cache_dir, box):
    return Path(cache_dir) / ("_".join(f"{v:.5f}" for v in box) + ".json")


def _cache_read(cache_dir, box):
    """('ways', [...]) | ('split', None) | None. Only trusts files younger than CACHE_MAX_AGE_S."""
    if not cache_dir:
        return None
    p = _cache_path(cache_dir, box)
    try:
        d = json.loads(p.read_text())
        if d.get("v") != CACHE_VERSION or time.time() - d["t"] > CACHE_MAX_AGE_S:
            return None
        return ("split", None) if d.get("split") else ("ways", d["ways"])
    except (OSError, ValueError, KeyError):
        return None


def _cache_write(cache_dir, box, ways=None, split=False):
    if not cache_dir:
        return
    p = _cache_path(cache_dir, box)
    p.parent.mkdir(parents=True, exist_ok=True)
    slim = None if split else [{"type": "way", "id": w["id"], "nodes": w["nodes"], "geometry": w["geometry"], "tags": {"name": (w.get("tags") or {}).get("name")}} for w in ways]
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"v": CACHE_VERSION, "t": time.time(), "split": split, "ways": slim}, separators=(",", ":")))
    tmp.replace(p)


def fetch_streets(boxes, endpoints, post, warnings=None, sleep=1.0, max_split=2, cache_dir=None, budget_s=None):
    """Fetch every tile; a tile that fails on all mirrors is split into 4 smaller ones (up to max_split times).
    With cache_dir, every finished tile (and every 'this tile had to be split' decision) is saved immediately,
    so after a crash or Ctrl-C a re-run only fetches what is missing."""
    ways = {}
    failed = [0]
    stats = {"cached": 0, "fetched": 0, "skipped": 0}
    strikes = {}
    started = time.time()

    def run(box, label, depth):
        hit = _cache_read(cache_dir, box)
        if hit and hit[0] == "ways":
            stats["cached"] += 1
            for el in hit[1]:
                ways[el["id"]] = el
            return
        if hit and hit[0] == "split":
            for k, sub in enumerate(_quarters(box)):
                run(sub, f"{label}.{k + 1}", depth + 1)
            return
        if budget_s and time.time() - started > budget_s:
            stats["skipped"] += 1  # out of time: leave it for the next run (finished tiles are already cached)
            return
        els = _fetch_tile(box, endpoints, post, label, strikes, started)
        if sleep:
            time.sleep(sleep)
        if els is None and depth < max_split:
            _cache_write(cache_dir, box, split=True)
            for k, sub in enumerate(_quarters(box)):
                run(sub, f"{label}.{k + 1}", depth + 1)
            return
        if els is None:
            failed[0] += 1
            return
        stats["fetched"] += 1
        _cache_write(cache_dir, box, ways=els)
        for el in els:
            ways[el["id"]] = el

    for i, box in enumerate(boxes):
        run(box, f"tile {i + 1}/{len(boxes)}", 0)
    if cache_dir:
        print(f"  tiles: {stats['cached']} from cache, {stats['fetched']} fetched", flush=True)
    if stats["skipped"] and warnings is not None:
        warnings.append(f"blocks: stopped at the time budget; {stats['skipped']} tiles not fetched yet. Re-run to continue (progress is cached)")
        print(f"  TIME BUDGET REACHED: {stats['skipped']} tiles left. Run the same command again to continue.", flush=True)
        # Don't write a half-covered blocks.json over a good one: progress is cached, so just re-run.
        raise RuntimeError(f"time budget reached with {stats['skipped']} tiles left; blocks.json unchanged. Re-run to continue")
    if failed[0] and warnings is not None:
        warnings.append(f"blocks: {failed[0]} small street tiles still failed; some blocks may be missing (re-run to retry just those)")
    if not ways:
        raise RuntimeError("no street data from Overpass")
    return list(ways.values())


def _xy(lat, lon):
    return (lon * K_LON, lat * K_LAT)


ABBR = [("Street", "St"), ("Avenue", "Ave"), ("Road", "Rd"), ("Drive", "Dr"), ("Boulevard", "Blvd"), ("Highway", "Hwy"),
        ("Crescent", "Cres"), ("Place", "Pl"), ("Court", "Ct"), ("Terrace", "Terr"), ("Parkway", "Pkwy"), ("Lane", "Ln"),
        ("North", "N"), ("South", "S"), ("East", "E"), ("West", "W")]


def abbreviate(name):
    """'West Georgia Street' -> 'W Georgia St' (keeps the label short on a phone)."""
    if not name:
        return None
    words = name.split()
    out = []
    for i, w in enumerate(words):
        for long, short in ABBR:
            if w == long and not (i == 0 and long in ("Place", "Court", "Lane", "Drive", "Terrace", "Road") and len(words) == 1):
                w = short
                break
        out.append(w)
    return " ".join(out)


def split_ways(ways):
    """Cut every way at intersections (nodes used by 2+ ways, or by the same way twice).
    Returns [{"pts": [(lat, lon)...], "name": str|None, "x": [cross street at start, cross street at end]}]."""
    use = {}
    names_at = {}
    for w in ways:
        nm = abbreviate((w.get("tags") or {}).get("name"))
        for nid in w["nodes"]:
            use[nid] = use.get(nid, 0) + 1
            if nm:
                names_at.setdefault(nid, set()).add(nm)
    out = []
    for w in ways:
        nodes, geom = w["nodes"], w["geometry"]
        if len(nodes) != len(geom):
            continue
        nm = abbreviate((w.get("tags") or {}).get("name"))

        def cross(nid):
            others = sorted(n for n in names_at.get(nid, ()) if n != nm)
            return others[0] if others else None

        start = 0
        for k in range(1, len(nodes)):
            if use[nodes[k]] >= 2 or k == len(nodes) - 1:
                pts = [(p["lat"], p["lon"]) for p in geom[start:k + 1]]
                if len(pts) >= 2 and _length(pts) >= MIN_SEG_M:
                    out.append({"pts": pts, "name": nm, "x": [cross(nodes[start]), cross(nodes[k])]})
                start = k
    return out


def _length(pts):
    return sum(math.dist(_xy(*pts[i]), _xy(*pts[i + 1])) for i in range(len(pts) - 1))


def _seg_dist(p, a, b):
    """Distance from p to segment ab (xy metres) and the fraction along ab."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t


def _clip(pts, s0, s1):
    """Sub-polyline of pts between chainage s0 and s1 (metres)."""
    xy = [_xy(*p) for p in pts]
    out, acc = [], 0.0
    for i in range(len(pts) - 1):
        seg = math.dist(xy[i], xy[i + 1])
        a, b = acc, acc + seg
        if b >= s0 and a <= s1 and seg > 0:
            t0, t1 = max(0.0, (s0 - a) / seg), min(1.0, (s1 - a) / seg)
            for t in (t0, t1):
                pt = (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t)
                if not out or out[-1] != pt:
                    out.append(pt)
        acc = b
    return out


def build_blocks(segments, meters):
    """meters: [{"id": str, "lat": float, "lon": float}] -> [{"c": coords, "m": [ids]}] for segments with meters."""
    segxy = [[_xy(*p) for p in sg["pts"]] for sg in segments]
    cum = []
    for pts in segxy:
        c = [0.0]
        for i in range(len(pts) - 1):
            c.append(c[-1] + math.dist(pts[i], pts[i + 1]))
        cum.append(c)

    grid = {}
    for si, pts in enumerate(segxy):
        for ei in range(len(pts) - 1):
            a, b = pts[ei], pts[ei + 1]
            n = max(1, int(math.dist(a, b) // 10) + 1)
            for k in range(n + 1):
                x, y = a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n
                grid.setdefault((int(x // CELL), int(y // CELL)), set()).add((si, ei))

    per_seg = {}
    for m in meters:
        p = _xy(m["lat"], m["lon"])
        cx, cy = int(p[0] // CELL), int(p[1] // CELL)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for si, ei in grid.get((cx + dx, cy + dy), ()):
                    d, t = _seg_dist(p, segxy[si][ei], segxy[si][ei + 1])
                    if d <= SNAP_M and (best is None or d < best[0]):
                        best = (d, si, cum[si][ei] + t * (cum[si][ei + 1] - cum[si][ei]))
        if best:
            per_seg.setdefault(best[1], []).append((best[2], m["id"]))

    out = []
    for si, items in per_seg.items():
        total = cum[si][-1]
        chains = [c for c, _ in items]
        seg = segments[si]
        clipped = total > MAX_FULL_M
        coords = _clip(seg["pts"], min(chains) - PAD_M, max(chains) + PAD_M) if clipped else seg["pts"]
        if len(coords) < 2:
            continue
        blk = {"c": [[round(a, 5), round(b, 5)] for a, b in coords], "m": [i for _, i in sorted(items)]}
        if seg["name"]:
            blk["n"] = seg["name"]
            if not clipped and any(seg["x"]):
                blk["x"] = seg["x"]  # cross streets at the two ends, in the order of "c"
        out.append(blk)
    return out
