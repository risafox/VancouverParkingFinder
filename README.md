# Where to Street Park Vancouver

Mobile-first web app: type where you're going, pick how far you'll walk (5/10/15 min), how long you'll stay and when you arrive, and get the cheapest street meters and nearby off-street lots, each with coordinates and a Google Maps link.

Static site (Leaflet + MapLibre GL, no build step), hosted on GitHub Pages.

## How it works

- **Basemap:** [OpenFreeMap](https://openfreemap.org) vector tiles (`positron` style) rendered by MapLibre GL through `maplibre-gl-leaflet`. No API key. To change the look, edit `BASEMAP_STYLE` in `app.js` (`liberty`, `bright`, `positron`).
- **Data** is prebuilt weekly into `data/*.json` by `scripts/build_data.py` (GitHub Action `.github/workflows/refresh-data.yml`, Mondays ~09:17 UTC, also runnable by hand). The browser never pages through the City API.
  - `meters.json` — all street meters, City of Vancouver Open Data (`parking-meters`)
  - `tickets.json` — top ticket blocks for the most recent year with full volume (`parking-tickets`), geocoded server-side with Nominatim
  - `lots.json` — off-street lots: OpenStreetMap (`amenity=parking`, via Overpass) merged with `data/lots_curated.json`
  - `blocks.json` — street segments (OpenStreetMap centrelines cut at intersections) with the meters that sit on each; the site colours a whole block when most of its meters share a rate and keeps the odd ones as dots. Without this file it falls back to chaining nearby meters
  - `meta.json` — when it was built, counts, warnings
- **Weekly cache:** the service worker (`sw.js`) serves `data/*.json` from cache for up to 7 days. Open the site with `?fresh=1` to bypass it.
- **Ranking** (`core.js`): cost is computed over your whole stay in 15-minute steps, so 6pm / 10pm rate changes and free hours are priced correctly. Spots whose time limit is shorter than your stay are listed after the ones that fit. All time logic uses America/Vancouver, not the device's time zone. Walk time = straight-line distance × 1.3 at 4.8 km/h.
- **Busyness:** there is no public occupancy feed. The UI shows rate-based demand (Vancouver raises a meter's rate by $1/hr where peak occupancy was ≥85%) and flags ticket hotspots within 150 m.

## Run the data job

```bash
python3 scripts/build_data.py            # everything (first run geocodes ~100 places at 1/sec)
python3 scripts/build_data.py --only blocks   # street-aligned blocks (needs data/meters.json)
python3 scripts/build_data.py --only meters
python3 scripts/build_data.py --skip-geocode
```

Standard library only. A stage that fails keeps its previous file and records a warning in `meta.json`; the exit code is non-zero only if the meter pull fails.

## Tests

```bash
npm test      # node --test (core.js) + python unittest (build_data.py); no dependencies to install
```

## Adding / editing off-street lots

Edit `data/lots_curated.json`: `name`, `address` (geocoded by the weekly job) or `lat`/`lon`, optional `operator`, `url`, `parking`, and `rate_per_hr` (a number, once you've confirmed it). Curated entries replace any OSM lot within 50 m. OSM lots have no rates unless tagged `charge=* CAD/hour`.

## Preview locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploying / maintenance

- GitHub Pages serves the repo root; the weekly Action commits `data/` to `main`, which redeploys the site.
- After changing `core.js`, `app.js`, `styles.css`, `index.html` or `vendor/`, bump `VERSION` in `sw.js` so installed copies pick it up.
- Vendored libraries live in `vendor/` (see `vendor/README.txt`).
- No API keys are needed for the City data, OpenFreeMap, Overpass or Nominatim. Nominatim and Overpass are public services with usage policies (≤1 request/sec, identify the app): the weekly job already complies. Search in the browser only calls Nominatim when you press Go.
- Add to home screen (iOS Safari: Share → Add to Home Screen).

Data © City of Vancouver (Open Government Licence – Vancouver), © OpenStreetMap contributors. Basemap by OpenFreeMap / OpenMapTiles.
