"""
Bus router — Hasadna Open Bus Stride API (public, no auth).
https://open-bus-stride-api.hasadna.org.il

REAL-TIME ENGINE v4 — date-anchored arrival display:
- All times in Asia/Jerusalem via pytz
- Ghost bus filter: vehicles silent > 10 min dropped from map
- is_live=False: vehicles silent 5–10 min (shown but no pulsing ring)
- Station board uses aimed_arrival_time (stop-specific), NOT ride start time
- DATE ANCHOR: "which day" is always decided by aimed_arrival_time in IL tz.
  expected_arrival_time is only used for the countdown if it is within ±60 min
  of aimed_arrival_time — otherwise it is a stale/corrupt value and is ignored.
- Already-passed stops (actual_arrival_time set) are skipped
- Query window extended backward 2 h to catch in-progress routes
- print() calls dump raw API responses so you can verify real data is fetched
"""
import logging
from fastapi import APIRouter, Query
import httpx
import time
import math
import pytz
from datetime import datetime, timezone, timedelta

from services.siri_service import (
    fetch_arrivals_for_stop,
    fetch_live_vehicles,
    haversine_km,
    arrival_display,
    IL_TZ,
    TIBERIAS_LAT, TIBERIAS_LON, TIBERIAS_RADIUS_KM,
    _parse_iso, _fmt_il, _ts,          # keep internal helpers accessible in this file
    _fill_route_names, _rsn_cache,
)

logger = logging.getLogger("buses")
router = APIRouter()
BASE  = "https://open-bus-stride-api.hasadna.org.il"

GHOST_CUTOFF_MIN = 10   # vehicles silent > 10 min: dropped from map entirely
LIVE_CUTOFF_MIN  = 5    # vehicles silent 5–10 min: shown, is_live=False, no pulse ring

# ── TEST MODE: default location = Tiberias, 2 km radius ──────────────────────
# These are the bbox corners for a 2 km radius around Tiberias (32.7922, 35.5312).
# lat_delta  = 2 / 111.0          ≈ 0.018°
# lon_delta  = 2 / (111.0 * cos(32.79°)) ≈ 0.0215°
_TIB_LAT = 32.7922
_TIB_LON = 35.5312
_TIB_LAT_MIN = round(_TIB_LAT - 0.018,  4)   # 32.7742
_TIB_LAT_MAX = round(_TIB_LAT + 0.018,  4)   # 32.8102
_TIB_LON_MIN = round(_TIB_LON - 0.0215, 4)   # 35.5097
_TIB_LON_MAX = round(_TIB_LON + 0.0215, 4)   # 35.5527

# ── route_short_name cache ─────────────────────────────────────────────────────
_rsn_cache: dict[tuple[int, int], tuple[str, str]] = {}
_rsn_cache_date: str = ""


# ══════════════════════════════════════════════════════════════════════════════
# INTERNAL HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str | None) -> datetime | None:
    """Parse any ISO-8601 string → UTC-aware datetime. Returns None on failure."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _fmt_il(dt: datetime) -> str:
    """Format a UTC-aware datetime as HH:MM in Asia/Jerusalem local time."""
    return dt.astimezone(IL_TZ).strftime("%H:%M")


def _arrival_display(
    aimed_utc: datetime | None,
    expected_utc: datetime | None,
    now_utc: datetime,
) -> tuple[str, str]:
    """
    Three-priority Moovit-style arrival display.

    DATE ANCHOR RULE — the "which day is this bus?" check always uses
    aimed_arrival_time, never expected_arrival_time.  The SIRI feed can
    carry stale expected_arrival_time values (e.g. from a previous run of the
    same route) that look like they are 2 minutes away.  We only trust
    expected_arrival_time for the countdown IF it is within ±60 minutes of
    aimed_arrival_time — otherwise we fall back to aimed.

    Returns (display_string, display_type):
      "realtime"  — Priority 1: valid expected_arrival_time, < 30 min away
      "scheduled" — Priority 2: no valid real-time, or ≥ 30 min; planned time
      "next_day"  — Priority 3: aimed_arrival_time is tomorrow (IL time)
      "departed"  — bus already passed (aimed is in the past)
    """
    if aimed_utc is None:
        return "—", "scheduled"

    now_il   = now_utc.astimezone(IL_TZ)
    aimed_il = aimed_utc.astimezone(IL_TZ)

    # ── DATE ANCHOR: which calendar day is this bus? ─────────────────────────
    # Always decided by aimed_arrival_time, not by expected_arrival_time.
    if aimed_il.date() < now_il.date():
        # Yesterday's ride leaked through the query window — discard
        return "עבר", "departed"

    if aimed_il.date() > now_il.date():
        # Priority 3: bus runs tomorrow (Israel calendar)
        return f"מחר ב-{aimed_il.strftime('%H:%M')}", "next_day"

    # ── Today's bus ──────────────────────────────────────────────────────────
    # Sanity-check expected_arrival_time: only trust it if it is within
    # ±60 minutes of the scheduled aimed time.  A drift > 60 min almost
    # certainly means the field contains stale data from a previous ride.
    eta_utc = aimed_utc  # default: use scheduled time
    using_realtime = False
    if expected_utc is not None:
        drift_sec = abs((expected_utc - aimed_utc).total_seconds())
        if drift_sec <= 3600:          # within 60 minutes → believable
            eta_utc = expected_utc
            using_realtime = True
        else:
            print(
                f"[buses] IGNORED stale expected_arrival_time "
                f"(drift {drift_sec/60:.1f} min from aimed): "
                f"aimed={_fmt_il(aimed_utc)}  expected={_fmt_il(expected_utc)}"
            )

    # ── EXACT SUBTRACTION: datetime.now(UTC) − ExpectedArrivalTime ──────────
    mins = int((eta_utc - now_utc).total_seconds() / 60)   # ← THE LINE
    # ────────────────────────────────────────────────────────────────────────

    if mins < 0:
        return "עבר", "departed"
    if mins == 0:
        return "מגיע", "realtime" if using_realtime else "scheduled"

    # Priority 1: real-time data is valid and bus arrives in < 30 min
    if using_realtime and mins < 30:
        if mins == 1:
            return "בעוד דקה", "realtime"
        return f"בעוד {mins} דקות", "realtime"

    # Priority 2: no usable real-time, or ≥ 30 min — show planned clock time
    eta_il = eta_utc.astimezone(IL_TZ)
    return f"מתוכנן ל-{eta_il.strftime('%H:%M')}", "scheduled"


def _ts(dt: datetime | None) -> str:
    """Return ISO string with UTC offset, or empty string."""
    if dt is None:
        return ""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres between two WGS-84 points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


async def _fill_route_names(
    pairs: list[tuple[int, int]],
    client: httpx.AsyncClient,
) -> None:
    """Batch-resolve (line_ref, operator_ref) → (route_short_name, agency_name)."""
    global _rsn_cache, _rsn_cache_date
    today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    missing = [(lr, op) for lr, op in pairs if (lr, op) not in _rsn_cache]
    if not missing:
        return
    try:
        params = {
            "line_refs":     ",".join(str(lr) for lr, _ in missing),
            "operator_refs": ",".join(str(op) for _, op in missing),
            "date_from":     today,
            "limit":         2000,
        }
        print(f"[buses] GET /gtfs_routes/list  params={params}")
        resp = await client.get(f"{BASE}/gtfs_routes/list", params=params, timeout=12.0)
        if resp.status_code != 200:
            print(f"[buses] gtfs_routes HTTP {resp.status_code}: {resp.text[:200]}")
            return
        rows = resp.json()
        print(f"[buses] gtfs_routes returned {len(rows)} rows")
        for row in rows:
            lr    = row.get("line_ref")
            op    = row.get("operator_ref")
            rsn   = row.get("route_short_name") or ""
            agency = row.get("agency_name") or ""
            if lr is not None and op is not None and rsn:
                _rsn_cache[(int(lr), int(op))] = (str(rsn), str(agency))
        _rsn_cache_date = today
    except Exception as exc:
        print(f"[buses] _fill_route_names error: {exc}")


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
    now_utc      = _utcnow()
    now_il       = now_utc.astimezone(IL_TZ)
    ghost_cutoff = now_utc - timedelta(minutes=GHOST_CUTOFF_MIN)
    live_cutoff  = now_utc - timedelta(minutes=LIVE_CUTOFF_MIN)
    time_from    = (now_utc - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    radius_km = max(2.0, haversine_km(lat_min, lon_min, lat_max, lon_max) / 2)

    try:
        buses = await fetch_live_vehicles(
            lat_min=lat_min, lat_max=lat_max,
            lon_min=lon_min, lon_max=lon_max,
            radius_km=radius_km,
            limit=limit,
        )
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
# /line-path  — ordered stop list for a route
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/line-path")
async def get_line_path(
    line_ref: str = Query(...),
    limit: int = Query(default=50, le=100),
):
    try:
        async with httpx.AsyncClient(timeout=22.0) as client:
            now       = _utcnow()
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
