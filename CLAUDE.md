# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source-of-Truth Rules

These rules are fixed and must not be changed without explicit user instruction:

1. **Backend always runs on port 8001.** Port 8000 is permanently occupied by a stale phantom process. Never use port 8000. All frontend API calls are hardcoded to `http://localhost:8001`.
2. **Project scope is all of Israel** — nationwide coverage for buses, trains, and flights. The default map bbox is the full country (`lat 29.3–33.5, lon 34.0–36.2`). Do not revert to Tiberias-only without explicit instruction.
3. **Start commands are canonical:**
   ```bash
   # Backend (from project root)
   cd Israel-Transport-Pro/backend
   source /c/Users/user/OneDrive/Desktop/.venv/Scripts/activate
   uvicorn main:app --host 0.0.0.0 --port 8001 --reload

   # Frontend (from project root)
   cd Israel-Transport-Pro/frontend
   npm run dev
   ```

## Current Project State — Phase 2 Complete

**Phase 2: Nationwide Expansion & Performance** is complete as of 2026-03-30. The following are now live:

- **Nationwide coverage** — map centers on Israel (`[31.7683, 35.2137]`, zoom 8), showing all buses/trains/flights across the country.
- **Canvas rendering** — vehicles are drawn on a single `<canvas>` element via the HTML5 Canvas 2D API in a `requestAnimationFrame` loop. Zero DOM nodes per vehicle. Capable of rendering thousands of vehicles without lag.
- **Smooth interpolation** — each vehicle glides from its previous position to the new one using ease-out cubic over 8 seconds. Glide starts from the vehicle's current interpolated position (no snapping on update).
- **Bounding-box fetch** — buses are fetched per current map bounds on `moveend` only (not during drag). Trains and flights refresh every 15s full-country.
- **Web Worker deduplication** — raw bus data is deduplicated by `vehicle_ref` inside an inline blob Worker, off the main thread.
- **Backend deduplication** — `buses.py` also deduplicates by `vehicle_ref` server-side (keeps most recent, since records are `ORDER BY id DESC`), reducing payload size.
- **Pro SVG vehicle icons** — drawn on canvas as top-down silhouettes (bus rectangular body + windows, train narrower body + windows, airplane plan-view). All rotated by `bearing`/`heading`.
- **Stop visibility** — bus stops only load and display at zoom ≥ 14. Stops are fetched per bounds on `moveend`, cached by bbox key to avoid duplicate requests.
- **Click detection** — vehicle clicks use `map.on("click")` with a 24px hit-radius search through interpolated canvas positions (canvas itself has `pointer-events: none` so map drag/zoom is unaffected).

## Running the App

Both servers must run simultaneously:

- Backend: `http://localhost:8001`
- Frontend: `http://localhost:3000`

### Python Virtual Environment

The venv lives at the **Desktop root**, not inside the project:

```bash
source /c/Users/user/OneDrive/Desktop/.venv/Scripts/activate
# Or invoke directly:
/c/Users/user/OneDrive/Desktop/.venv/Scripts/uvicorn
```

Install backend deps: `pip install -r backend/requirements.txt`
Install frontend deps: `cd frontend && npm install`

### Frontend Commands

```bash
npm run dev      # dev server with HMR
npm run build    # production build
npm run lint     # ESLint check
```

## Architecture

### Backend (`backend/`)

FastAPI app with three routers mounted under `/api/`:

| Router | Prefix | Data Source |
|--------|--------|-------------|
| `routers/buses.py` | `/api/buses` | Hasadna Open Bus Stride (public REST API) |
| `routers/trains.py` | `/api/trains` | Israel Railways `rail.co.il` + deterministic simulation fallback |
| `routers/flights.py` | `/api/flights` | OpenSky Network (anonymous or credentialed) |

**Key design decisions:**

- **Buses** — The Hasadna API does **not** reliably filter by lat/lon via query params. The `/live` endpoint fetches 2000 recent records (`ORDER BY id DESC`) and filters client-side in Python using the requested bbox. It also deduplicates by `vehicle_ref` (first hit = most recent) before returning. Default bbox is all-Israel.
- **Trains** — The Israel Railways API requires a Chrome-like User-Agent (WAF protection). When it fails, `_simulate_trains()` returns deterministic positions interpolated between real station coordinates on a 30-minute sinusoidal cycle.
- **Flights** — Optional credentials in `backend/credentials.json` (`opensky_user`, `opensky_pass`) upgrade from anonymous to authenticated OpenSky access. Anonymous works but has rate limits.
- **Station board** — Three-step async chain: GTFS stop code → SIRI stop ID → upcoming ride-stops.

`backend/services/mot_auth.py` exists but is not currently used (MOT OAuth2 standby).

### Frontend (`frontend/src/`)

Next.js 16 app with a single page (`app/page.tsx` → `<Dashboard />`). All map work is `"use client"` with SSR disabled via `next/dynamic`.

**Component hierarchy and data flow:**

```
Dashboard
├── Sidebar          — layer toggles (trains/buses/flights on/off) + live vehicle list (top 12)
├── StatsBar         — live counts, API online indicator, last-refresh time
└── [main area]
    ├── TransportMap (always mounted, full area)
    │   ├── Leaflet map (CartoDB Dark Matter tiles, no API key needed)
    │   ├── <canvas> vehicle layer — Canvas 2D + rAF loop, pointer-events: none
    │   ├── Bus stop markers — L.Marker DOM elements, only at zoom ≥ 14, per-bounds
    │   └── VehiclePopup — shown on vehicle click (absolute overlay, z-index 1001)
    └── StationBoard (slides in as 400px right-side overlay when activePanel === "station-board")
```

**State managed in `Dashboard`:**
- `layers` — which vehicle types are visible (passed as ref to canvas render loop)
- `activePanel` — `"map"` | `"station-board"`
- `vehicles` — lifted from `TransportMap` via `onVehiclesUpdate` callback, used by `Sidebar`

**Canvas rendering architecture (`TransportMap.tsx`):**
- `trackedRef` — `Map<id, TrackedVehicle>` with `fromLat/fromLon`, `toLat/toLon`, `startTime`
- `layersRef` — ref mirror of `layers` prop, read inside rAF loop without stale closure
- `selectedRef` — ref mirror of selected vehicle, read inside rAF loop
- rAF loop: `clearRect` → iterate `trackedRef` → `map.latLngToContainerPoint()` → `drawVehicle()`
- Click: `map.on("click")` → find nearest tracked vehicle within 24px hit radius

**API base URLs** — all hardcoded to `http://localhost:8001` in:
- `TransportMap.tsx` (vehicle fetches + stop fetch)
- `StatsBar.tsx` (count fetches)
- `StationBoard.tsx` (const `API`)

If the port changes, update all three files.

### Styling

- Dark theme: `#080d18` (page bg), `#0f1623` (panels), `#253047` (borders)
- Color constants: train `#3b82f6`, bus `#22c55e`, flight `#f59e0b`
- Defined as `COLORS` objects in `TransportMap.tsx` and `VehiclePopup.tsx` — keep in sync.
- Tailwind 4 is used but most component styling uses inline `style={}` for dynamic color values.
- Leaflet-specific overrides (zoom controls, attribution, stop tooltips) are in `globals.css`.
- The old `.vehicle-marker { transition: transform 2s linear }` CSS has been removed — interpolation is now handled entirely in the canvas rAF loop.

## API Reference

### Buses
- `GET /api/buses/live?lat_min&lat_max&lon_min&lon_max&limit` — real-time positions, Israel-wide default bbox, deduplicated by vehicle_ref
- `GET /api/buses/stops?lat_min&lat_max&lon_min&lon_max&limit` — GTFS stops by bbox (or city name / stop code)
- `GET /api/buses/station-board?stop_code=XXXX&window_hours=2` — departure board for a stop

### Trains
- `GET /api/trains/live` — simulated trains with real station coordinates
- `GET /api/trains/stations` — all hardcoded stations with coordinates

### Flights
- `GET /api/flights/live` — flights over Israel (full-country bbox)

## Key External APIs

| API | URL | Auth | Notes |
|-----|-----|------|-------|
| Hasadna Open Bus Stride | `open-bus-stride-api.hasadna.org.il` | None | GTFS + SIRI real-time. Bbox params unreliable — always filter client-side in Python. |
| Israel Railways | `rail.co.il/apiinfo/api/Train/GetRoutes` | None | WAF blocks non-browser UA. Requires Chrome User-Agent. Falls back to simulation. |
| OpenSky Network | `opensky-network.org/api` | Optional | Anonymous works; add creds to `credentials.json` for higher rate limits. |
| CartoDB Dark Matter | `basemaps.cartocdn.com/dark_all/` | None | Free dark tile layer, no token needed. |
