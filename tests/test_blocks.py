import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import blocks as B  # noqa: E402

LAT0, LON0 = 49.27, -123.12
DLAT = 1 / B.K_LAT
DLON = 1 / B.K_LON


def pt(x_m, y_m):
    return {"lat": LAT0 + y_m * DLAT, "lon": LON0 + x_m * DLON}


def way(wid, nodes_xy, name=None):
    return {"type": "way", "id": wid, "nodes": [n for n, _ in nodes_xy], "geometry": [pt(*xy) for _, xy in nodes_xy], "tags": {"name": name} if name else {}}


# Two streets crossing at node 2: an east-west street (nodes 1-2-3) and a north-south one (4-2-5), 100 m arms
EW = way(1, [(1, (-100, 0)), (2, (0, 0)), (3, (100, 0))], "West Georgia Street")
NS = way(2, [(4, (0, -100)), (2, (0, 0)), (5, (0, 100))], "Richards Street")


class BlocksTest(unittest.TestCase):
    def test_split_at_intersections(self):
        segs = B.split_ways([EW, NS])
        self.assertEqual(len(segs), 4)
        for s in segs:
            self.assertAlmostEqual(B._length(s["pts"]), 100, delta=1)

    def test_snap_and_block_membership(self):
        segs = B.split_ways([EW, NS])
        meters = [{"id": "a", **pt(-80, 6)}, {"id": "b", **pt(-50, -6)}, {"id": "c", **pt(60, 5)},  # EW west/east
                  {"id": "d", **pt(4, 70)},                                                          # NS north
                  {"id": "far", **pt(500, 500)}]                                                      # nowhere near a street
        out = B.build_blocks(segs, meters)
        by_ids = {tuple(sorted(b["m"])): b for b in out}
        self.assertIn(("a", "b"), by_ids)
        self.assertIn(("c",), by_ids)
        self.assertIn(("d",), by_ids)
        self.assertNotIn("far", sum((b["m"] for b in out), []))
        # whole block is drawn (100 m), not just the span of the meters
        self.assertAlmostEqual(B._length([tuple(c) for c in by_ids[("a", "b")]["c"]]), 100, delta=2)
        # street name + cross streets at the ends: block "a,b" is the west arm of W Georgia St, ending at Richards St
        blk = by_ids[("a", "b")]
        self.assertEqual(blk["n"], "W Georgia St")
        self.assertEqual(sorted(x for x in blk["x"] if x), ["Richards St"])
        self.assertIn(None, blk["x"])  # the far end of the arm has no cross street in this toy map

    def test_long_segment_is_clipped_to_meter_span(self):
        long_way = way(9, [(10, (0, 0)), (11, (600, 0))])
        segs = B.split_ways([long_way])
        out = B.build_blocks(segs, [{"id": "m1", **pt(300, 5)}, {"id": "m2", **pt(330, 5)}])
        self.assertEqual(len(out), 1)
        length = B._length([tuple(c) for c in out[0]["c"]])
        self.assertAlmostEqual(length, 30 + 2 * B.PAD_M, delta=3)

    def test_abbreviate(self):
        self.assertEqual(B.abbreviate("West Georgia Street"), "W Georgia St")
        self.assertEqual(B.abbreviate("Pacific Boulevard"), "Pacific Blvd")
        self.assertIsNone(B.abbreviate(None))

    def test_tile_boxes_cover_points(self):
        pts = [(49.27, -123.12), (49.28, -123.11), (49.21, -123.2)]
        boxes = B.tile_boxes(pts)
        for lat, lon in pts:
            self.assertTrue(any(s <= lat <= n and w <= lon <= e for s, w, n, e in boxes))

    def test_fetch_streets_dedupes_and_tolerates_failed_tile(self):
        calls = []

        def post(ep, data=None, retries=1, timeout=0, headers=None):
            calls.append(ep)
            if len(calls) == 3:
                raise RuntimeError("timeout")
            return {"elements": [EW, NS]}

        warnings = []
        ways = B.fetch_streets([(0, 0, 1, 1), (0, 0, 1, 1)], ["https://a", "https://b"], post, warnings, sleep=0)
        self.assertEqual(len(ways), 2)  # same two ways from both tiles, de-duplicated
        warn_free = []
        B.fetch_streets([(0, 0, 1, 1)], ["https://a"], lambda *a, **k: {"elements": [EW]}, warn_free, sleep=0)
        self.assertEqual(warn_free, [])

    def test_failed_tile_is_split_and_retried(self):
        sizes = []

        def post(ep, data=None, retries=1, timeout=0, headers=None):
            import urllib.parse as up
            q = up.parse_qs(data.decode())["data"][0]
            box = q.split("(")[-1].split(")")[0].split(",")
            size = float(box[2]) - float(box[0])
            sizes.append(size)
            if size > 0.6:  # big tiles time out the way Overpass does: HTTP 200 + remark
                return {"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1"}
            return {"elements": [EW]}

        warnings = []
        ways = B.fetch_streets([(0, 0, 1, 1)], ["https://a"], post, warnings, sleep=0)
        self.assertEqual(len(ways), 1)
        self.assertEqual(warnings, [])
        self.assertTrue(any(s <= 0.5 for s in sizes))

    def test_persistent_failure_is_reported(self):
        def post(ep, data=None, retries=1, timeout=0, headers=None):
            raise RuntimeError("down")

        with self.assertRaises(RuntimeError):
            B.fetch_streets([(0, 0, 1, 1)], ["https://a"], post, [], sleep=0, max_split=1)

    def test_cache_makes_rerun_fetch_only_missing_tiles(self):
        import tempfile
        calls = []
        fail_second = [True]

        def post(ep, data=None, retries=1, timeout=0, headers=None):
            import urllib.parse as up
            q = up.parse_qs(data.decode())["data"][0]
            calls.append(q)
            s = float(q.split("(")[-1].split(")")[0].split(",")[0])
            if s == 5.0 and fail_second[0]:
                raise RuntimeError("down")  # the second tile fails on the first run
            return {"elements": [EW]}

        with tempfile.TemporaryDirectory() as tmp:
            boxes = [(0.0, 0.0, 1.0, 1.0), (5.0, 0.0, 6.0, 1.0)]
            B.fetch_streets(boxes, ["https://a"], post, [], sleep=0, max_split=0, cache_dir=tmp)
            first = len(calls)
            fail_second[0] = False
            calls.clear()
            B.fetch_streets(boxes, ["https://a"], post, [], sleep=0, max_split=0, cache_dir=tmp)
            self.assertEqual(first, 2)
            self.assertEqual(len(calls), 1)  # tile 1 came from cache; only the failed tile was fetched again

    def test_dead_mirror_is_skipped_and_budget_stops_cleanly(self):
        hits = {"dead": 0, "ok": 0}

        def post(ep, data=None, retries=1, timeout=0, headers=None):
            if "dead" in ep:
                hits["dead"] += 1
                raise RuntimeError("timeout")
            hits["ok"] += 1
            return {"elements": [EW]}

        boxes = [(i, 0, i + 1, 1) for i in range(8)]
        B.fetch_streets(boxes, ["https://dead", "https://ok"], post, [], sleep=0)
        self.assertEqual(hits["dead"], B.MIRROR_STRIKES)  # tried 3 times, then never again
        self.assertEqual(hits["ok"], 8)
        warnings = []
        B.fetch_streets(boxes, ["https://ok"], post, warnings, sleep=0, budget_s=-1) if False else None
        with self.assertRaises(RuntimeError):  # budget already spent and no cache -> nothing fetched
            B.fetch_streets(boxes, ["https://ok"], post, warnings, sleep=0, budget_s=0.000001)
        self.assertTrue(any("time budget" in w for w in warnings))

    def test_no_streets_raises(self):
        with self.assertRaises(RuntimeError):
            B.fetch_streets([(0, 0, 1, 1)], ["https://a"], lambda *a, **k: {"elements": []}, [], sleep=0)


if __name__ == "__main__":
    unittest.main()
