# Where to Street Park Vancouver

A mobile PWA that shows City of Vancouver parking meters on a map, color-coded by current rate. Add it to your iPhone home screen for a native app experience.

Data sources:
- [Parking Meters – City of Vancouver Open Data](https://opendata.vancouver.ca/explore/dataset/parking-meters/information/)
- [Parking Tickets – City of Vancouver Open Data](https://opendata.vancouver.ca/explore/dataset/parking-tickets/information/)

---

## Does this need to run on your machine?

**No.** Once deployed to a static host (GitHub Pages, Netlify, Vercel), it runs permanently on their infrastructure for free. You only need your machine to push updates.

---

## Setup

### 1. Generate app icons

Open `generate-icons.html` in a browser, click both download buttons, and place the files into the `icons/` folder:

```
icons/
  icon-192.png
  icon-512.png
```

### 2. Deploy

The app is fully static — no server or API keys required. Any of these work:

**GitHub Pages** (free)
1. Push this repo to GitHub
2. Go to Settings → Pages → set source to `main` branch root
3. Your app will be live at `https://<username>.github.io/<repo>/`

**Netlify** (free)
- Drag and drop this folder at [netlify.com/drop](https://netlify.com/drop)

**Vercel** (free)
```bash
npx vercel --prod
```

> HTTPS is required for geolocation and PWA install to work on iPhone — all three hosts above provide it automatically.

### 3. Add to iPhone home screen

1. Open the deployed URL in **Safari**
2. Tap the Share button
3. Tap **Add to Home Screen**
4. Launch it — it opens fullscreen with no browser chrome

---

## How it works

- Fetches all ~3,800 parking meters from the Vancouver Open Data API (paginated, cached locally for 6 hours)
- Detects current day and time → applies the correct rate period (weekday/weekend × 9am–6pm / 6pm–10pm)
- Color-codes markers:
  - **Green** — $0–$1.50/hr
  - **Yellow** — $1.51–$3.00/hr
  - **Red** — $3+/hr
  - **Grey** — free or outside metered hours
- Tap a price chip to filter to only that tier; tap again to show all
- Tap **Tickets** chip to overlay 2025 parking ticket hotspots (dot size = relative frequency)
- Tap any marker to see rate, time limit, and payment info
- Auto re-renders when the time period changes (e.g. crossing 6pm)
- "My Location" button centers the map on you
