"""
Bus router — Hasadna Open Bus Stride API (public, no auth).
https://open-bus-stride-api.hasadna.org.il

All arrival display logic, ghost-bus filtering, and real-time detection lives
in siri_service.py.  This router only handles HTTP routing + stop metadata.
"""
import logging
import time
from datetime import datetime, timezone, timedelta

import asyncio
import math

import httpx
import pytz
from fastapi import APIRouter, Query

from services.siri_service import (
    fetch_arrivals_for_stop,
    fetch_live_vehicles,
    haversine_km,
    IL_TZ,
    TIBERIAS_LAT, TIBERIAS_LON,
)

logger = logging.getLogger("buses")
router = APIRouter()
BASE  = "https://open-bus-stride-api.hasadna.org.il"

# ── Default bbox: Tiberias (32.7922, 35.5312) ± 2 km ─────────────────────────
# lat_delta  = 2 / 111.0          ≈ 0.018°
# lon_delta  = 2 / (111.0 * cos(32.79°)) ≈ 0.0215°
_TIB_LAT = 32.7922
_TIB_LON = 35.5312
_TIB_LAT_MIN = round(_TIB_LAT - 0.018,  4)   # 32.7742
_TIB_LAT_MAX = round(_TIB_LAT + 0.018,  4)   # 32.8102
_TIB_LON_MIN = round(_TIB_LON - 0.0215, 4)   # 35.5097
_TIB_LON_MAX = round(_TIB_LON + 0.0215, 4)   # 35.5527


# ══════════════════════════════════════════════════════════════════════════════
# /live  — real-time bus positions
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/live")
async def get_live_buses(
    limit: int     = Query(default=200, le=500),
    lat_min: float = Query(default=_TIB_LAT_MIN),   # Tiberias 2 km south
    lat_max: float = Query(default=_TIB_LAT_MAX),   # Tiberias 2 km north
    lon_min: float = Query(default=_TIB_LON_MIN),   # Tiberias 2 km west
    lon_max: float = Query(default=_TIB_LON_MAX),   # Tiberias 2 km east
    line_ref: str | None = Query(default=None),
):
    """
    Real-time bus positions from the Israel MOT SIRI feed (via Hasadna proxy).

    Defaults to Tiberias 2 km radius for testing.
    The frontend overrides lat_min/max/lon_min/max with the current map viewport.

    Filters applied in order:
      1. Bbox pre-filter  (fast, eliminates most of Israel)
      2. Haversine check  (exact 2 km circle when request uses default Tiberias bbox)
      3. Ghost-bus filter (GPS > 10 min old → dropped entirely)
      4. Live flag        (GPS > 5 min old → is_live=False, no pulse ring)
      5. Dedup by vehicle_ref (keep only latest position per physical bus)
    """
    print(f">>> CURRENT TIME IN ISRAEL: {datetime.now(pytz.timezone('Asia/Jerusalem'))}")
    # Use the actual requested bbox radius (no artificial 2 km floor).
    # The Hasadna API returns a broader set; we filter server-side below.
    radius_km = max(0.5, haversine_km(lat_min, lon_min, lat_max, lon_max) / 2)

    try:
        buses = await fetch_live_vehicles(
            lat_min=lat_min, lat_max=lat_max,
            lon_min=lon_min, lon_max=lon_max,
            radius_km=radius_km,
            limit=limit,
        )
        # Hard distance cap: never send buses > 800 m from Tiberias to the frontend
        buses = [b for b in buses if b.get("dist_km", 999) < 0.8]
        return {
            "buses":     buses,
            "count":     len(buses),
            "source":    "hasadna_siri",
            "timestamp": int(time.time()),
        }
    except Exception as e:
        logger.error("live endpoint error: %s", e)
        return {
            "buses":          [],
            "count":          0,
            "error":          str(e),
            "service_status": "unavailable",
            "timestamp":      int(time.time()),
        }


# ══════════════════════════════════════════════════════════════════════════════
# /stops  — GTFS stop search
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/stops")
async def search_stops(
    city: str = Query(default=""),
    code: int | None = Query(default=None),
    lat_min: float | None = Query(default=None),
    lat_max: float | None = Query(default=None),
    lon_min: float | None = Query(default=None),
    lon_max: float | None = Query(default=None),
    limit: int = Query(default=100, le=300),
):
    params: dict = {
        "limit":     500,
        "date_from": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    if code:
        params["code"] = code
    if city:
        params["city"] = city

    use_bbox = all(v is not None for v in [lat_min, lat_max, lon_min, lon_max])

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(f"{BASE}/gtfs_stops/list", params=params)
            resp.raise_for_status()
            stops = []
            seen: set = set()
            for item in resp.json():
                key = item.get("code")
                if key in seen:
                    continue
                lat, lon = item.get("lat"), item.get("lon")
                if use_bbox and (lat is None or lon is None):
                    continue
                if use_bbox and not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):  # type: ignore[operator]
                    continue
                seen.add(key)
                stops.append({
                    "id":   item.get("id"),
                    "code": item.get("code"),
                    "name": item.get("name", ""),
                    "city": item.get("city", ""),
                    "lat":  lat,
                    "lon":  lon,
                })
                if len(stops) >= limit:
                    break
            return {"stops": stops, "count": len(stops)}
    except Exception as e:
        return {"stops": [], "count": 0, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
# /station-board  — departure board for a stop
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/station-board")
async def get_station_board(
    stop_code: int = Query(...),
    window_hours: int = Query(default=2, le=6),
):
    """
    Real-time departure board delegated entirely to siri_service.
    All fetching, logging, and time calculations happen there.
    """
    try:
        now_utc = datetime.now(timezone.utc)
        now_il  = now_utc.astimezone(IL_TZ)

        # Fetch stop metadata in parallel with arrivals
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                f"{BASE}/gtfs_stops/list",
                params={"code": stop_code, "limit": 1,
                        "date_from": now_utc.strftime("%Y-%m-%d")},
                timeout=8.0,
            )
        gtfs      = r.json() if r.status_code == 200 else []
        stop_name = gtfs[0].get("name", f"תחנה {stop_code}") if gtfs else f"תחנה {stop_code}"
        stop_city = gtfs[0].get("city", "")  if gtfs else ""
        stop_lat  = gtfs[0].get("lat")        if gtfs else None
        stop_lon  = gtfs[0].get("lon")        if gtfs else None

        # Distance from Tiberias reference point (for UI display)
        stop_dist_km = None
        if stop_lat is not None and stop_lon is not None:
            stop_dist_km = round(haversine_km(TIBERIAS_LAT, TIBERIAS_LON, stop_lat, stop_lon), 2)

        # Delegate all SIRI fetching to siri_service
        arrivals = await fetch_arrivals_for_stop(stop_code, window_hours)

        return {
            "stop_code":      stop_code,
            "stop_name":      stop_name,
            "stop_city":      stop_city,
            "stop_lat":       stop_lat,
            "stop_lon":       stop_lon,
            "stop_dist_km":   stop_dist_km,   # km from Tiberias centre
            "arrivals":       arrivals,
            "window_hours":   window_hours,
            "server_time_il": now_il.strftime("%H:%M:%S"),
            "server_date_il": now_il.strftime("%Y-%m-%d"),
            "timestamp":      int(time.time()),
        }

    except Exception as e:
        logger.error("station-board exception: %s", e)
        return {
            "stop_code":      stop_code,
            "arrivals":       [],
            "error":          str(e),
            "service_status": "unavailable",
        }


# ══════════════════════════════════════════════════════════════════════════════
# /tiberias-board  — aggregated board for all stops near Tiberias centre
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tiberias-board")
async def get_tiberias_board(
    radius_km:    float       = Query(default=0.5, le=5.0),
    window_hours: int         = Query(default=2, le=6),
    line:         str | None  = Query(default=None),
):
    """
    Fetch arrivals for every GTFS bus stop within radius_km of Tiberias city centre
    (32.7922, 35.5312), run all stop lookups concurrently, merge and sort.

    Supports optional ?line=<route_short_name> filter.
    """
    now_utc = datetime.now(timezone.utc)
    now_il  = datetime.now(pytz.timezone("Asia/Jerusalem"))

    # ── Fetch all GTFS stops in Tiberias ──────────────────────────────────────
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"{BASE}/gtfs_stops/list",
                params={
                    "city":      "טבריה",
                    "date_from": now_utc.strftime("%Y-%m-%d"),
                    "limit":     500,
                },
            )
        all_stops = r.json() if r.status_code == 200 else []
    except Exception as e:
        logger.error("tiberias-board: stop fetch failed: %s", e)
        all_stops = []

    # ── Filter by haversine ≤ radius_km, deduplicate by stop code ────────────
    nearby_stops: list[dict] = []
    seen_codes:   set[int]   = set()
    for s in (all_stops if isinstance(all_stops, list) else []):
        lat, lon, code = s.get("lat"), s.get("lon"), s.get("code")
        if lat is None or lon is None or code is None or code in seen_codes:
            continue
        dist = haversine_km(TIBERIAS_LAT, TIBERIAS_LON, lat, lon)
        if dist <= radius_km:
            seen_codes.add(code)
            nearby_stops.append({
                "code":    code,
                "name":    s.get("name", f"תחנה {code}"),
                "dist_km": round(dist, 3),
            })

    print(f"[tiberias-board] {len(nearby_stops)} stops within {radius_km}km of Tiberias")

    if not nearby_stops:
        return {
            "stops_found":    0,
            "stops":          [],
            "arrivals":       [],
            "count":          0,
            "radius_km":      radius_km,
            "center_lat":     TIBERIAS_LAT,
            "center_lon":     TIBERIAS_LON,
            "server_time_il": now_il.strftime("%H:%M:%S"),
            "server_date_il": now_il.strftime("%Y-%m-%d"),
            "timestamp":      int(time.time()),
        }

    # ── Fetch arrivals for all stops concurrently ─────────────────────────────
    tasks   = [fetch_arrivals_for_stop(s["code"], window_hours) for s in nearby_stops]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # ── Merge, stamp stop info, deduplicate same trip across adjacent stops ───
    all_arrivals: list[dict] = []
    seen_trips:   set[str]   = set()
    for stop_info, result in zip(nearby_stops, results):
        if isinstance(result, Exception):
            logger.error("tiberias-board stop %s: %s", stop_info["code"], result)
            continue
        for a in result:
            stop_code = stop_info["code"]
            # Dedup key: same line + same scheduled time + same stop
            trip_key = f"{a.get('line_ref')}_{a.get('aimed_time', '')}_{stop_code}"
            if trip_key in seen_trips:
                continue
            seen_trips.add(trip_key)
            enriched              = dict(a)
            enriched["stop_code"] = stop_code
            enriched["stop_name"] = stop_info["name"]
            all_arrivals.append(enriched)

    # ── Optional line filter ──────────────────────────────────────────────────
    if line:
        all_arrivals = [
            a for a in all_arrivals
            if str(a.get("route_short_name") or a.get("line_ref") or "") == line.strip()
        ]

    all_arrivals.sort(key=lambda a: a.get("eta_minutes", 9999))

    return {
        "stops_found":    len(nearby_stops),
        "stops":          nearby_stops,
        "arrivals":       all_arrivals,
        "count":          len(all_arrivals),
        "radius_km":      radius_km,
        "center_lat":     TIBERIAS_LAT,
        "center_lon":     TIBERIAS_LON,
        "server_time_il": now_il.strftime("%H:%M:%S"),
        "server_date_il": now_il.strftime("%Y-%m-%d"),
        "timestamp":      int(time.time()),
    }


# ══════════════════════════════════════════════════════════════════════════════
# /line-path  — ordered stop list for a route
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/line-path")
async def get_line_path(
    line_ref: str = Query(...),
    limit: int = Query(default=50, le=100),
):
    try:
        async with httpx.AsyncClient(timeout=22.0) as client:
            now       = datetime.now(timezone.utc)
            time_from = (now - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
            time_to   = now.strftime("%Y-%m-%dT%H:%M:%S+00:00")

            r1 = await client.get(
                f"{BASE}/siri_ride_stops/list",
                params={
                    "siri_route__line_refs":                line_ref,
                    "siri_ride__scheduled_start_time_from": time_from,
                    "siri_ride__scheduled_start_time_to":   time_to,
                    "order_by": "order asc",
                    "limit":    300,
                },
            )
            r1.raise_for_status()
            all_stops = r1.json()
            if not isinstance(all_stops, list) or not all_stops:
                return {"stops": [], "line_ref": line_ref, "count": 0}

            rides: dict = {}
            for s in all_stops:
                rid = s.get("siri_ride__id") or "?"
                rides.setdefault(rid, []).append(s)
            best = max(rides.values(), key=len)

            stop_ids_ordered: list[str] = []
            seen: set = set()
            for s in sorted(best, key=lambda x: x.get("order") or 0):
                sid = str(s.get("siri_stop__id") or s.get("siri_stop_id") or "")
                if sid and sid != "None" and sid not in seen:
                    seen.add(sid)
                    stop_ids_ordered.append(sid)

            if not stop_ids_ordered:
                return {"stops": [], "line_ref": line_ref, "count": 0}

            r2 = await client.get(
                f"{BASE}/siri_stops/list",
                params={"ids": ",".join(stop_ids_ordered[:limit])},
            )
            r2.raise_for_status()
            siri_data = r2.json()

            stop_map: dict = {}
            if isinstance(siri_data, list):
                for s in siri_data:
                    stop_map[str(s.get("id", ""))] = s

            stops_out = []
            for sid in stop_ids_ordered[:limit]:
                info = stop_map.get(sid, {})
                lat, lon = info.get("lat"), info.get("lon")
                if lat is not None and lon is not None:
                    stops_out.append({
                        "siri_id": sid,
                        "code":    info.get("code"),
                        "name":    info.get("name") or f"תחנה {len(stops_out)+1}",
                        "city":    info.get("city", ""),
                        "lat":     lat,
                        "lon":     lon,
                    })

            return {
                "stops":       stops_out,
                "line_ref":    line_ref,
                "count":       len(stops_out),
                "rides_found": len(rides),
            }
    except Exception as e:
        return {"stops": [], "line_ref": line_ref, "count": 0, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
# /nearby-stops  — STOP-FIRST: all stops within radius + their arrivals
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/nearby-stops")
async def get_nearby_stops(
    lat:       float = Query(default=32.7922),
    lon:       float = Query(default=35.5312),
    radius_km: float = Query(default=0.5, le=2.0),
    city:      str   = Query(default="טבריה"),
    window_hours: int = Query(default=2, le=6),
):
    """
    Stop-first logic:
      1. Fetch ALL physical GTFS stops for the given city (reliable city-name filter).
      2. Haversine-filter to radius_km from (lat, lon).
      3. For each stop, fetch real-time arrivals concurrently.
      4. Return as array of stops, each carrying its own arrivals.

    Never invents data — empty arrivals list means no scheduled buses at that stop.
    """
    now_utc = datetime.now(timezone.utc)
    today   = now_utc.strftime("%Y-%m-%d")

    # ── Step 1: fetch all GTFS stops for this city ────────────────────────────
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"{BASE}/gtfs_stops/list",
                params={"city": city, "date_from": today, "limit": 500},
                timeout=12.0,
            )
        raw_stops = r.json() if r.status_code == 200 else []
    except Exception as exc:
        logger.error("nearby-stops: stop fetch failed: %s", exc)
        return {"stops": [], "count": 0, "error": "Stop data unavailable", "timestamp": int(time.time())}

    if not isinstance(raw_stops, list):
        return {"stops": [], "count": 0, "error": "Unexpected response from GTFS API", "timestamp": int(time.time())}

    # ── Step 2: haversine filter + deduplicate by stop code ───────────────────
    nearby: list[dict] = []
    seen_codes: set[int] = set()
    for s in raw_stops:
        slat, slon, code = s.get("lat"), s.get("lon"), s.get("code")
        if slat is None or slon is None or code is None:
            continue
        if code in seen_codes:
            continue
        dist_km = haversine_km(lat, lon, slat, slon)
        if dist_km <= radius_km:
            seen_codes.add(code)
            nearby.append({
                "code":   code,
                "name":   s.get("name") or f"תחנה {code}",
                "lat":    slat,
                "lon":    slon,
                "dist_m": int(dist_km * 1000),
            })

    nearby.sort(key=lambda s: s["dist_m"])

    print(f"[nearby-stops] {len(nearby)} stops within {radius_km}km of {lat},{lon} (city={city})")

    if not nearby:
        return {
            "stops": [], "count": 0,
            "message": f"אין תחנות ברדיוס {radius_km}ק\"מ",
            "timestamp": int(time.time()),
        }

    # ── Step 3: fetch arrivals for all stops concurrently ────────────────────
    tasks = [fetch_arrivals_for_stop(s["code"], window_hours) for s in nearby]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # ── Step 4: attach arrivals to each stop ──────────────────────────────────
    stops_out: list[dict] = []
    for stop_meta, arrivals in zip(nearby, results):
        if isinstance(arrivals, Exception):
            logger.error("nearby-stops arrivals error for stop %s: %s", stop_meta["code"], arrivals)
            arrivals = []
        stop_meta_out = dict(stop_meta)
        stop_meta_out["arrivals"] = arrivals
        stops_out.append(stop_meta_out)

    now_il = now_utc.astimezone(IL_TZ)
    return {
        "stops":          stops_out,
        "count":          len(stops_out),
        "center_lat":     lat,
        "center_lon":     lon,
        "radius_km":      radius_km,
        "server_time_il": now_il.strftime("%H:%M:%S"),
        "timestamp":      int(time.time()),
    }


# ══════════════════════════════════════════════════════════════════════════════
# /routes  — list SIRI routes
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/routes")
async def list_routes(
    operator_ref: int | None = Query(default=None),
    limit: int = Query(default=30, le=100),
):
    params: dict = {"limit": limit, "order_by": "id desc"}
    if operator_ref:
        params["operator_refs"] = operator_ref
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{BASE}/siri_routes/list", params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        return {"error": str(e)}
