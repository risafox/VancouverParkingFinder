import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_data as b  # noqa: E402


class TrimMeter(unittest.TestCase):
    def test_keeps_rates_limits_geo_drops_noise(self):
        rec = {
            "meter_id": "1", "geo_point_2d": {"lat": 49.1234567, "lon": -123.7654321},
            "rate_9am_6pm": "$3.00", "time_limit_9am_6pm": "2 Hr", "credit_card": "Yes",
            "geom": {"big": "shape"}, "notes_internal": "x", "streetname": "HORNBY ST", "empty": "",
        }
        out = b.trim_meter(rec)
        self.assertEqual(out["geo_point_2d"], {"lat": 49.123457, "lon": -123.765432})
        self.assertIn("rate_9am_6pm", out)
        self.assertIn("streetname", out)
        self.assertNotIn("geom", out)
        self.assertNotIn("notes_internal", out)

    def test_no_geo_is_dropped(self):
        self.assertIsNone(b.trim_meter({"meter_id": "1"}))
        self.assertIsNone(b.trim_meter({"meter_id": "1", "geo_point_2d": {"lat": None, "lon": 1}}))


class Tickets(unittest.TestCase):
    def test_pick_year_skips_partial_current_year(self):
        rows = [{"year": "2026", "n": 900}, {"year": "2025", "n": 180000}, {"year": "2024", "n": 170000}]
        self.assertEqual(b.pick_year(rows), "2025")

    def test_pick_year_latest_when_all_full(self):
        self.assertEqual(b.pick_year([{"year": "2025", "n": 100}, {"year": "2024", "n": 90}]), "2025")

    def test_pick_year_garbage(self):
        self.assertIsNone(b.pick_year([{"year": "x", "n": "y"}]))

    def test_hotspots_use_cache_and_skip_misses(self):
        with tempfile.TemporaryDirectory() as d:
            calls = []

            def fake_http(url, **kw):
                if "/records" in url and "group_by=year" in url:
                    return {"results": [{"year": "2025", "n": 1000}]}
                if "/records" in url:
                    return {"results": [
                        {"block": "1100", "street": "ALBERNI ST", "n": 50},
                        {"block": "900", "street": "NOWHERE ST", "n": 40},
                        {"block": "100", "street": "W HASTINGS ST", "n": 30},
                        {"block": "200", "street": "MAIN ST", "n": 20},
                        {"block": "300", "street": "GRANVILLE ST", "n": 10},
                        {"block": "400", "street": "ROBSON ST", "n": 9},
                    ]}
                calls.append(url)
                if "NOWHERE" in url:
                    return []
                return [{"lat": "49.28", "lon": "-123.12"}]

            with mock.patch.object(b, "http_json", fake_http):
                g = b.Geocoder(Path(d) / "c.json", fetch=fake_http, sleep=lambda s: None)
                warnings = []
                out = b.fetch_ticket_hotspots(g, warnings)
                self.assertEqual(out["year"], "2025")
                self.assertEqual(len(out["hotspots"]), 5)  # NOWHERE ST missed
                n_first = len(calls)
                out2 = b.fetch_ticket_hotspots(g, [])  # fully cached, incl. the recorded miss
                self.assertEqual(len(calls), n_first)
                self.assertEqual(len(out2["hotspots"]), 5)


class Lots(unittest.TestCase):
    def test_parse_charge(self):
        self.assertEqual(b.parse_charge("3.50 CAD/hour"), 3.5)
        self.assertEqual(b.parse_charge("$4/h"), 4.0)
        self.assertIsNone(b.parse_charge("5 CAD/day"))
        self.assertIsNone(b.parse_charge(None))

    def test_is_public_lot(self):
        self.assertTrue(b.is_public_lot({"amenity": "parking", "name": "Thurlow Parkade"}))
        self.assertTrue(b.is_public_lot({"amenity": "parking", "fee": "yes"}))
        self.assertFalse(b.is_public_lot({"amenity": "parking"}))  # untagged: probably private
        self.assertFalse(b.is_public_lot({"amenity": "parking", "access": "private", "name": "X"}))
        self.assertFalse(b.is_public_lot({"amenity": "parking", "parking": "street_side", "name": "X"}))

    def test_normalise_way_uses_center(self):
        el = {"type": "way", "id": 7, "center": {"lat": 49.27, "lon": -123.12},
              "tags": {"amenity": "parking", "name": "P1", "parking": "underground", "fee": "yes",
                       "capacity": "120", "charge": "4 CAD/hour"}}
        out = b.normalise_osm_element(el)
        self.assertEqual((out["id"], out["capacity"], out["rate_per_hr"]), ("osm/way/7", 120, 4.0))

    def test_merge_prefers_curated_and_drops_overlap(self):
        cur = [{"id": "c", "lat": 49.2745, "lon": -123.1212}]
        osm = [{"id": "o1", "lat": 49.27452, "lon": -123.12121}, {"id": "o2", "lat": 49.30, "lon": -123.10}]
        self.assertEqual([x["id"] for x in b.merge_lots(osm, cur)], ["c", "o2"])

    def test_curated_geocodes_missing_coords(self):
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            (data / "lots_curated.json").write_text(json.dumps([
                {"name": "Test Lot", "address": "1 Main St"},
                {"name": "Has Coords", "address": "x", "lat": 49.1, "lon": -123.1},
            ]))
            fake = lambda url, **kw: [{"lat": "49.2", "lon": "-123.2"}]  # noqa: E731
            with mock.patch.object(b, "DATA", data):
                g = b.Geocoder(data / "c.json", fetch=fake, sleep=lambda s: None)
                out = b.load_curated(g)
            self.assertEqual([o["id"] for o in out], ["curated/test-lot", "curated/has-coords"])
            self.assertEqual(out[0]["lat"], 49.2)


class Http(unittest.TestCase):
    def test_ssl_read_timeout_is_retried_then_reported(self):
        import ssl
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise ssl.SSLError("The read operation timed out")

        with mock.patch.object(b.urllib.request, "urlopen", boom), mock.patch.object(b.time, "sleep", lambda s: None):
            with self.assertRaises(RuntimeError):
                b.http_json("https://example.invalid/x", retries=3)
        self.assertEqual(len(calls), 3)


class Overpass(unittest.TestCase):
    def test_query_filters_on_server(self):
        q = b.overpass_query(b.BBOX)
        self.assertIn('["amenity"="parking"]', q)
        self.assertIn("private", q)
        self.assertIn("street_side", q)
        self.assertIn("out center tags", q)

    def test_falls_back_to_next_mirror_then_downtown(self):
        seen = []
        good = {"elements": [{"type": "way", "id": 1, "center": {"lat": 49.27, "lon": -123.12},
                              "tags": {"amenity": "parking", "name": "Lot"}}]}

        def post(url, data=None, **kw):
            seen.append((url, b"49.262" in data))
            if len(seen) < 5:  # city on all 3 mirrors fails, downtown on mirror 1 fails
                raise RuntimeError("timed out")
            return good

        out = b.fetch_osm_lots(post=post)
        self.assertEqual(len(out), 1)
        self.assertEqual(len(seen), 5)
        self.assertTrue(seen[-1][1])  # last call used the downtown box

    def test_all_fail_raises_runtime_error(self):
        def post(*a, **k):
            raise RuntimeError("down")
        with self.assertRaises(RuntimeError):
            b.fetch_osm_lots(post=post)


class Geocoder(unittest.TestCase):
    def test_disabled_never_calls_network(self):
        with tempfile.TemporaryDirectory() as d:
            boom = mock.Mock(side_effect=AssertionError("network used"))
            g = b.Geocoder(Path(d) / "c.json", fetch=boom, enabled=False)
            self.assertIsNone(g.lookup("anything"))

    def test_network_error_not_cached_as_miss(self):
        with tempfile.TemporaryDirectory() as d:
            def fail(url, **kw):
                raise RuntimeError("down")
            g = b.Geocoder(Path(d) / "c.json", fetch=fail, sleep=lambda s: None)
            self.assertIsNone(g.lookup("a"))
            self.assertNotIn("a", g.cache)


if __name__ == "__main__":
    unittest.main()
