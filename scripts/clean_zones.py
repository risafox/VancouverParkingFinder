#!/usr/bin/env python3
"""Remove overlapping permit-zone polygons from parking_zones.geojson.

Dev-time tool (needs `pip install shapely`; the site itself needs nothing).
  1. repairs invalid polygons
  2. merges overlapping/touching polygons of the same zone type into one shape
  3. where different zone types overlap, the higher-priority type keeps the area
     (VRPP > RPP > RPO) and the lower one is cut back, so nothing is drawn twice
Usage: python3 scripts/clean_zones.py [in.geojson] [out.geojson]
"""
import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

PRIORITY = ["VRPP", "RPP", "RPO"]
M = 111320.0  # rough metres per degree, only used for tolerances / area reporting


def polys_only(g):
    if g.is_empty:
        return g
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else g.__class__()


def main(src, dst):
    data = json.loads(Path(src).read_text())
    by_zone = {}
    for f in data["features"]:
        g = make_valid(shape(f["geometry"]))
        by_zone.setdefault(f["properties"]["zone"], []).append(polys_only(g))

    merged = {z: polys_only(unary_union(gs).buffer(0)) for z, gs in by_zone.items()}
    taken = None
    out = []
    for z in PRIORITY + [z for z in merged if z not in PRIORITY]:
        if z not in merged:
            continue
        g = merged[z]
        if taken is not None:
            overlap = g.intersection(taken)
            print(f"{z}: cut {overlap.area * (M ** 2) * 0.65:,.0f} m² overlapping higher-priority zones")
            g = polys_only(g.difference(taken))
        taken = g if taken is None else unary_union([taken, g])
        g = g.simplify(0.5 / M, preserve_topology=True)  # ~0.5 m, invisible but smaller file
        if not g.is_empty:
            out.append({"type": "Feature", "properties": {"zone": z}, "geometry": mapping(g)})
    n_before = len(data["features"])
    Path(dst).write_text(json.dumps({"type": "FeatureCollection", "features": out}, separators=(",", ":")))
    print(f"{n_before} polygons -> {len(out)} merged features, no overlaps; wrote {dst}")


if __name__ == "__main__":
    main(*(sys.argv[1:3] or ["parking_zones.geojson", "parking_zones.geojson"]))
