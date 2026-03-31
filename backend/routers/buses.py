"""
Bus router — Hasadna Open Bus Stride API (public, no auth).
https://open-bus-stride-api.hasadna.org.il

Real-time join path (confirmed from live API field inspection):
  siri_vehicle_locations
      .siri_route__line_ref        ─┐
      .siri_route__operator_ref    ─┤─▶  gtfs_routes
      + today's date               ─┘       .route_short_name  ← "430", "28", "5"
                                             .agency_name       ← "סופרבוס", "אגד"
"""
from fastapi import APIRouter, Query
import httpx
import time
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

IL_TZ = ZoneInfo("Asia/Jerusalem")

router = APIRouter()
BASE = "https://open-bus-stride-api.hasadna.org.il"

# ── route_short_name cache ─────────────────────────────────────────────────────
# Key: (line_ref: int, operator_ref: int)  →  (route_short_name: str, agency_name: str)
_rsn_cache: dict[tuple[int, int], tuple[str, str]] = {}
_rsn_cache_date: str = ""          # YYYY-MM-DD the cache was built for
_rsn_cache_ops: frozenset[int] = frozenset()   # operator_refs already cached


async def _fill_route_names(
    pairs: list[tuple[int, int]],   # [(line_ref, operator_ref), ...]
    client: httpx.AsyncClient,
) -> None:
    """
    Populate _rsn_cache for the given (line_ref, operator_ref) pairs.

    One API call:
      GET /gtfs_routes/list
          ?line_refs=A,B,C
          &operator_refs=X,Y
          &date_from=TODAY
          &limit=2000
    gtfs_routes has BOTH line_ref and operator_ref so we join directly —
    no intermediate siri_routes step needed.
    """
    global _rsn_cache, _rsn_cache_date, _rsn_cache_ops

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    missing = [(lr, op) for lr, op in pairs if (lr, op) not in _rsn_cache]
    if not missing:
        return

    unique_lrs  = list({lr for lr, _ in missing})
    unique_ops  = list({op for _, op in missing})

    try:
        resp = await client.get(
            f"{BASE}/gtfs_routes/list",
            params={
                "line_refs":     ",".join(str(x) for x in unique_lrs),
                "operator_refs": ",".join(str(x) for x in unique_ops),
                "date_from":     today,
                "limit":         2000,
            },
            timeout=12.0,
        )
        if resp.status_code != 200:
            return
        for row in resp.json():
            lr  = row.get("line_ref")
            op  = row.get("operator_ref")
            rsn = row.get("route_short_name") or ""
            agency = row.get("agency_name") or ""
            if lr is not None and op is not None and rsn:
                _rsn_cache[(int(lr), int(op))] = (str(rsn), str(agency))
        _rsn_cache_date = today
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────────────
# /live  —  real-time vehicle positions
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/live")
async def get_live_buses(
    limit: int   = Query(default=200, le=500),
    lat_min: float = Query(default=29.3),
    lat_max: float = Query(default=33.5),
    lon_min: float = Query(default=34.0),
    lon_max: float = Query(default=36.2),
    line_ref: str | None = Query(default=None),
):
    """
    Fetch real-time bus GPS positions from the Israel Ministry of Transport
    SIRI feed (via Hasadna Open Bus Stride proxy).

    Steps:
      1. GET /siri_vehicle_locations/list  — positions recorded in the last 5 min
      2. Filter client-side to the requested bounding box
      3. GET /gtfs_routes/list             — resolve route_short_name + agency_name
    """
    now_utc   = datetime.now(timezone.utc)
    time_from = (now_utc - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:

            # ── Step 1: fetch fresh SIRI vehicle locations ────────────────────
            resp = await client.get(
                f"{BASE}/siri_vehicle_locations/list",
                params={
                    "limit":                  1000,
                    "order_by":               "id desc",
                    "recorded_at_time_from":  time_from,
                },
                timeout=15.0,
            )
            resp.raise_for_status()
            raw_items = resp.json()

            # ── Step 2: bbox + dedup filter ───────────────────────────────────
            buses: list[dict] = []
            seen_vrefs: set[str] = set()

            for item in raw_items:
                lat = item.get("lat")
                lon = item.get("lon")
                if lat is None or lon is None:
                    continue
                if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
                    continue

                lr  = item.get("siri_route__line_ref")
                op  = item.get("siri_route__operator_ref")

                if line_ref is not None:
                    if lr is None or str(lr) != str(line_ref):
                        continue

                vref = item.get("siri_ride__vehicle_ref") or ""
                if vref:
                    if vref in seen_vrefs:
                        continue
                    seen_vrefs.add(vref)

                if len(buses) >= limit:
                    break

                buses.append({
                    "id":            f"bus_{item['id']}",
                    "lat":           lat,
                    "lon":           lon,
                    "bearing":       item.get("bearing") or 0,
                    "velocity":      item.get("velocity") or 0,
                    "line_ref":      lr,
                    "operator_ref":  op,
                    "vehicle_ref":   vref,
                    "journey_ref":   item.get("siri_ride__journey_ref"),
                    "recorded_at":   item.get("recorded_at_time"),
                    "source":        "siri_live",
                    "type":          "bus",
                    # placeholders filled in step 3
                    "route_short_name": str(lr) if lr is not None else "?",
                    "operator":      op,
                    "agency_name":   "",
                })

            # ── Step 3: resolve route_short_name via gtfs_routes ─────────────
            if buses:
                pairs = [
                    (int(b["line_ref"]), int(b["operator_ref"]))
                    for b in buses
                    if b["line_ref"] is not None and b["operator_ref"] is not None
                ]
                await _fill_route_names(pairs, client)

                for b in buses:
                    lr = b["line_ref"]
                    op = b["operator_ref"]
                    if lr is not None and op is not None:
                        rsn, agency = _rsn_cache.get((int(lr), int(op)), ("", ""))
                        if rsn:
                            b["route_short_name"] = rsn
                            b["agency_name"]      = agency

            return {
                "buses":     buses,
                "count":     len(buses),
                "source":    "hasadna_siri",
                "time_from": time_from,
                "timestamp": int(now_utc.timestamp()),
            }

    except Exception as e:
        return {
            "buses":          [],
            "count":          0,
            "error":          str(e),
            "service_status": "unavailable",
            "timestamp":      int(time.time()),
        }


# ──────────────────────────────────────────────────────────────────────────────
# /stops  —  GTFS bus stops by city / bbox
# ──────────────────────────────────────────────────────────────────────────────

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
        "limit": 500,
        "date_from": datetime.now().strftime("%Y-%m-%d"),
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


# ──────────────────────────────────────────────────────────────────────────────
# /station-board  —  upcoming departures at a stop
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/station-board")
async def get_station_board(
    stop_code: int = Query(...),
    window_hours: int = Query(default=2, le=6),
):
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # 1. Resolve stop code → siri stop id
            r1 = await client.get(
                f"{BASE}/siri_stops/list",
                params={"codes": stop_code, "limit": 5},
            )
            siri_stops = r1.json()
            if not siri_stops or not isinstance(siri_stops, list) or not siri_stops[0].get("id"):
                return {"stop_code": stop_code, "arrivals": [], "error": "Stop not found"}

            siri_stop_ids = [str(s["id"]) for s in siri_stops[:3]]

            # 2. Fetch upcoming scheduled arrivals
            now = datetime.now(timezone.utc)
            time_to = now + timedelta(hours=window_hours)

            r2 = await client.get(
                f"{BASE}/siri_ride_stops/list",
                params={
                    "siri_stop_ids": ",".join(siri_stop_ids),
                    "siri_ride__scheduled_start_time_from": now.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                    "siri_ride__scheduled_start_time_to":   time_to.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                    "limit": 30,
                    "order_by": "siri_ride__scheduled_start_time asc",
                },
                timeout=12.0,
            )
            rides = r2.json() if r2.status_code == 200 else []

            # 3. Resolve route_short_name for all rides in one batch
            pairs = [
                (int(r["siri_route__line_ref"]), int(r["siri_route__operator_ref"]))
                for r in (rides if isinstance(rides, list) else [])
                if r.get("siri_route__line_ref") and r.get("siri_route__operator_ref")
            ]
            if pairs:
                await _fill_route_names(pairs, client)

            # 4. GTFS stop name
            r3 = await client.get(
                f"{BASE}/gtfs_stops/list",
                params={"code": stop_code, "limit": 1,
                        "date_from": now.strftime("%Y-%m-%d")},
            )
            gtfs = r3.json() if r3.status_code == 200 else []
            stop_name = gtfs[0].get("name", f"תחנה {stop_code}") if gtfs else f"תחנה {stop_code}"
            stop_city = gtfs[0].get("city", "")   if gtfs else ""
            stop_lat  = gtfs[0].get("lat")         if gtfs else None
            stop_lon  = gtfs[0].get("lon")         if gtfs else None

            arrivals = []
            for ride in (rides if isinstance(rides, list) else []):
                sched = ride.get("siri_ride__scheduled_start_time", "")
                lr    = ride.get("siri_route__line_ref")
                op    = ride.get("siri_route__operator_ref")
                rsn, agency = ("", "")
                if lr is not None and op is not None:
                    rsn, agency = _rsn_cache.get((int(lr), int(op)), ("", ""))
                arrivals.append({
                    "line_ref":          lr,
                    "route_short_name":  rsn or (str(lr) if lr else "?"),
                    "agency_name":       agency,
                    "operator":          op,
                    "scheduled_time":    sched,
                    "scheduled_display": _fmt_time(sched),
                    "vehicle_ref":       ride.get("siri_ride__vehicle_ref"),
                })

            return {
                "stop_code":  stop_code,
                "stop_name":  stop_name,
                "stop_city":  stop_city,
                "stop_lat":   stop_lat,
                "stop_lon":   stop_lon,
                "arrivals":   arrivals,
                "window_hours": window_hours,
                "timestamp":  int(time.time()),
            }
    except Exception as e:
        return {"stop_code": stop_code, "arrivals": [], "error": str(e)}


# ──────────────────────────────────────────────────────────────────────────────
# /line-path  —  ordered stops along a route for map overlay
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/line-path")
async def get_line_path(
    line_ref: str = Query(...),
    limit: int = Query(default=50, le=100),
):
    try:
        async with httpx.AsyncClient(timeout=22.0) as client:
            now = datetime.now(timezone.utc)
            time_from = (now - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
            time_to   = now.strftime("%Y-%m-%dT%H:%M:%S+00:00")

            r1 = await client.get(
                f"{BASE}/siri_ride_stops/list",
                params={
                    "siri_route__line_refs": line_ref,
                    "siri_ride__scheduled_start_time_from": time_from,
                    "siri_ride__scheduled_start_time_to":   time_to,
                    "order_by": "order asc",
                    "limit": 300,
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


# ──────────────────────────────────────────────────────────────────────────────
# /routes  —  active SIRI routes list
# ──────────────────────────────────────────────────────────────────────────────

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


# ──────────────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────────────

def _fmt_time(iso: str) -> str:
    """Format an ISO timestamp as HH:MM in Asia/Jerusalem (Israel) local time."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone(IL_TZ).strftime("%H:%M")
    except Exception:
        return iso[-8:][:5] if len(iso) >= 8 else iso
