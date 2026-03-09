# Where to Street Park Vancouver

A simple web app that shows City of Vancouver parking meters on a map, color-coded by current rate.

Data sources:
- [Parking Meters – City of Vancouver Open Data](https://opendata.vancouver.ca/explore/dataset/parking-meters/information/)
- [Parking Tickets – City of Vancouver Open Data](https://opendata.vancouver.ca/explore/dataset/parking-tickets/information/)

---

### Hosting

This app is currently hosted in Github pages. This has been optimized for mobile browsing, and can be 

1. Open [the URL](https://github.com/risafox/VancouverParkingFinder)in **Safari**
2. Tap the Share button
3. Tap **Add to Home Screen**
4. Launch — functionally this works like an app

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
- Tap **Tickets** chip to overlay 2025 parking ticket hotspots (dot size = relative frequency) -- WIP
- Tap any marker to see rate, time limit, and payment info
- Auto re-renders when the time period changes (e.g. crossing 6pm)
- "My Location" button centers the map on you
