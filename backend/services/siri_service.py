"""
siri_service.py — Official Israel MOT SIRI data fetcher.

Priority order:
  1. MOT SIRI REST API  (https://siri.motrealtime.co.il/Siri/)
     Requires OAuth2 token from mot_auth.py / credentials.json.
     Returns SIRI XML → parsed into structured dicts.
  2. Hasadna Open Bus Stride  (https://open-bus-stride-api.hasadna.org.il)
     Public REST proxy of the same SIRI/GTFS data.  Used when MOT is down
     or no credentials are configured.

All filtering is done AFTER fetching — no random numbers, no invented buses.
If both sources return nothing, we return [].
"""
import logging
import math
import re
import xml.etree.ElementTree as ET
import pytz
from datetime import datetime, timezone, timedelta

import httpx

from services.mot_auth import get_token

logger = logging.getLogger("siri_service")

# ── Israel timezone ────────────────────────────────────────────────────────────
IL_TZ = pytz.timezone("Asia/Jerusalem")

# ── Data sources ───────────────────────────────────────────────────────────────
MOT_SIRI_BASE  = "https://siri.motrealtime.co.il/Siri"
HASADNA_BASE   = "https://open-bus-stride-api.hasadna.org.il"

# SIRI XML namespace used in MOT responses
_NS = {
    "siri": "http://www.siri.org.uk/siri",
    "s":    "http://schemas.xmlsoap.org/soap/envelope/",
}

# ── Tiberias reference point ───────────────────────────────────────────────────
TIBERIAS_LAT       = 32.7922
TIBERIAS_LON       = 35.5312
TIBERIAS_RADIUS_KM = 2.0


# ══════════════════════════════════════════════════════════════════════════════
# UTILITY HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres between two WGS-84 points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def _parse_iso(s: str | None) -> datetime | None:
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
    return dt.astimezone(IL_TZ).strftime("%H:%M")


def _ts(dt: datetime | None) -> str:
    if dt is None:
        return ""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def arrival_display(
    aimed_utc: datetime | None,
    expected_utc: datetime | None,
    now_utc: datetime,
) -> tuple[str, str]:
    """
    Return (display_string, display_type).

    - aimed_utc:    The GTFS-scheduled arrival time for this specific stop.
    - expected_utc: Real-time prediction from SIRI (may be None for GTFS-only data).

    DATE ANCHOR: which calendar day the bus belongs to is decided by aimed_utc
    in Israel local time.  expected_utc is only trusted if it drifts ≤ 20 min
    from aimed_utc (buses are never 20+ min early/late on SIRI feeds).

    Countdown is shown for any bus arriving within 30 min — real-time OR scheduled.
    display_type "realtime" means SIRI expected_utc was used; "scheduled" means GTFS only.
    The Live badge in the UI must only appear when display_type == "realtime".
    """
    if aimed_utc is None:
        return "—", "scheduled"

    now_il   = now_utc.astimezone(IL_TZ)
    aimed_il = aimed_utc.astimezone(IL_TZ)

    # ── DATE ANCHOR ─────────────────────────────────────────────────────────────
    if aimed_il.date() < now_il.date():
        return "עבר", "departed"

    if aimed_il.date() > now_il.date():
        return f"מחר ב-{aimed_il.strftime('%H:%M')}", "next_day"

    # ── Validate expected_arrival_time (SIRI real-time) ──────────────────────────
    # Only trust it if drift from scheduled is ≤ 20 minutes.
    # A larger drift means the SIRI field is stale data from a previous trip.
    eta_utc        = aimed_utc
    using_realtime = False
    if expected_utc is not None:
        drift_sec = abs((expected_utc - aimed_utc).total_seconds())
        if drift_sec <= 1200:          # ≤ 20 min drift → believable real-time
            eta_utc        = expected_utc
            using_realtime = True
        else:
            print(
                f"[arrival_display] REJECTED stale expected (drift {drift_sec/60:.1f} min): "
                f"aimed={_fmt_il(aimed_utc)}  expected={_fmt_il(expected_utc)}"
            )

    # ── EXACT TIME DIFFERENCE: datetime.now(UTC) − eta_utc ─────────────────────
    mins = int((eta_utc - now_utc).total_seconds() / 60)
    print(
        f"[arrival_display] now_il={_fmt_il(now_utc)}  eta_il={_fmt_il(eta_utc)}"
        f"  mins={mins}  has_realtime={using_realtime}"
    )

    if mins < 0:
        return "עבר", "departed"
    if mins == 0:
        return "מגיע", "realtime" if using_realtime else "scheduled"

    # Countdown ONLY when SIRI expected_arrival_time is present and valid.
    # GTFS-only data (no expected_utc) → always show the scheduled clock time.
    if using_realtime and mins < 30:
        label = "בעוד דקה" if mins == 1 else f"בעוד {mins} דקות"
        return label, "realtime"

    # No real-time data or >= 30 min → exact scheduled time
    return f"מתוכנן ל-{eta_utc.astimezone(IL_TZ).strftime('%H:%M')}", "scheduled"


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 1 — MOT SIRI REST API  (authenticated)
# ══════════════════════════════════════════════════════════════════════════════

def _build_stop_monitoring_xml(
    stop_code: int,
    requestor_ref: str,
    preview_minutes: int = 90,
    max_visits: int = 20,
) -> str:
    """Build a SIRI StopMonitoringRequest SOAP envelope."""
    now_il = datetime.now(IL_TZ).strftime("%Y-%m-%dT%H:%M:%S%z")
    preview = f"PT{preview_minutes}M"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <siri:Siri xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
      <siri:ServiceRequest>
        <siri:RequestTimestamp>{now_il}</siri:RequestTimestamp>
        <siri:RequestorRef>{requestor_ref}</siri:RequestorRef>
        <siri:StopMonitoringRequest version="2.0">
          <siri:RequestTimestamp>{now_il}</siri:RequestTimestamp>
          <siri:MonitoringRef>{stop_code}</siri:MonitoringRef>
          <siri:PreviewInterval>{preview}</siri:PreviewInterval>
          <siri:MaximumStopVisits>{max_visits}</siri:MaximumStopVisits>
          <siri:MinimumStopVisitsPerLine>1</siri:MinimumStopVisitsPerLine>
        </siri:StopMonitoringRequest>
      </siri:ServiceRequest>
    </siri:Siri>
  </S:Body>
</S:Envelope>"""


def _parse_mot_stop_monitoring_xml(xml_text: str, now_utc: datetime) -> list[dict]:
    """Parse MOT SIRI StopMonitoringDelivery XML into arrival dicts."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        logger.error("XML parse error: %s | body preview: %.200s", exc, xml_text)
        return []

    arrivals: list[dict] = []
    # Walk all MonitoredStopVisit elements regardless of namespace prefix
    for msv in root.iter("{http://www.siri.org.uk/siri}MonitoredStopVisit"):
        mvj = msv.find(".//{http://www.siri.org.uk/siri}MonitoredVehicleJourney")
        if mvj is None:
            continue

        def _t(tag: str) -> str | None:
            el = mvj.find(f"{{http://www.siri.org.uk/siri}}{tag}")
            return el.text.strip() if el is not None and el.text else None

        line_ref  = _t("LineRef")
        op_ref    = _t("OperatorRef")
        veh_ref   = _t("VehicleRef")
        dest_name = _t("DestinationName")

        call = mvj.find(".//{http://www.siri.org.uk/siri}MonitoredCall")
        if call is None:
            continue

        def _tc(tag: str) -> str | None:
            el = call.find(f"{{http://www.siri.org.uk/siri}}{tag}")
            return el.text.strip() if el is not None and el.text else None

        aimed_str    = _tc("AimedArrivalTime") or _tc("AimedDepartureTime")
        expected_str = _tc("ExpectedArrivalTime") or _tc("ExpectedDepartureTime")

        aimed_utc    = _parse_iso(aimed_str)
        expected_utc = _parse_iso(expected_str)

        if aimed_utc is None:
            continue

        display_str, display_type = arrival_display(aimed_utc, expected_utc, now_utc)
        if display_type == "departed":
            continue

        eta_ref = expected_utc if (expected_utc and
                  abs((expected_utc - aimed_utc).total_seconds()) <= 3600) else aimed_utc
        eta_min = int((eta_ref - now_utc).total_seconds() / 60)

        arrivals.append({
            "line_ref":          line_ref,
            "route_short_name":  line_ref or "?",
            "agency_name":       op_ref or "",
            "operator":          op_ref,
            "aimed_time":        _ts(aimed_utc),
            "aimed_display":     _fmt_il(aimed_utc),
            "eta_time":          _ts(eta_ref),
            "eta_display":       display_str,
            "display_type":      display_type,
            "eta_minutes":       eta_min,
            "is_realtime":       display_type == "realtime",
            "vehicle_ref":       veh_ref,
            "destination":       dest_name,
            "scheduled_time":    _ts(aimed_utc),
            "scheduled_display": _fmt_il(aimed_utc),
            "source":            "mot_siri",
        })

    return arrivals


async def _fetch_mot_stop_monitoring(
    stop_code: int,
    client: httpx.AsyncClient,
    now_utc: datetime,
) -> list[dict] | None:
    """
    Try the official MOT SIRI StopMonitoring endpoint.
    Returns None if auth is unavailable or the call fails.
    """
    token = await get_token()
    if not token:
        logger.info("MOT SIRI: no auth token available — skipping MOT source")
        return None

    url = f"{MOT_SIRI_BASE}/api/v1/stop-monitoring"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/xml",
        "Accept":        "application/xml",
    }
    xml_body = _build_stop_monitoring_xml(stop_code=stop_code, requestor_ref="IsraelTransportPro")

    logger.info("MOT SIRI: POST %s  stop_code=%s", url, stop_code)
    try:
        resp = await client.post(url, content=xml_body.encode("utf-8"), headers=headers, timeout=10.0)
        logger.info("SIRI Response Status: %s", resp.status_code)

        if resp.status_code == 404:
            # Try REST GET variant (some MOT deployments use query params)
            url_get = f"{MOT_SIRI_BASE}/api/v1/stop-monitoring?monitoringRef={stop_code}&maxStopVisits=20&previewInterval=PT90M"
            logger.info("MOT SIRI: retry GET %s", url_get)
            resp = await client.get(url_get, headers={"Authorization": f"Bearer {token}"}, timeout=10.0)
            logger.info("SIRI Response Status (GET retry): %s", resp.status_code)

        if resp.status_code != 200:
            logger.warning("MOT SIRI returned HTTP %s: %.300s", resp.status_code, resp.text)
            return None

        arrivals = _parse_mot_stop_monitoring_xml(resp.text, now_utc)
        logger.info("MOT SIRI: parsed %d arrivals for stop %s", len(arrivals), stop_code)
        return arrivals

    except httpx.TimeoutException:
        logger.warning("MOT SIRI: request timed out for stop %s", stop_code)
        return None
    except Exception as exc:
        logger.error("MOT SIRI: unexpected error for stop %s: %s", stop_code, exc)
        return None


# ══════════════════════════════════════════════════════════════════════════════
# SOURCE 2 — Hasadna Open Bus Stride  (public fallback)
# ══════════════════════════════════════════════════════════════════════════════

# in-process cache: (line_ref, operator_ref) → (route_short_name, agency_name, destination_name)
_rsn_cache: dict[tuple, tuple[str, str, str]] = {}


def _extract_dest(long_name: str, direction: str) -> str:
    """
    Parse a human-readable destination from a GTFS route_long_name.

    GTFS long names look like:
      "ת. מרכזית טבריה/רציפים-טבריה<->הנשיא וייצמן/המברג-טבריה-10"
    Split on "<->":  part[0] = first terminus, part[1] = second terminus.
    direction "2" → bus runs from part[1] to part[0], so destination = part[0].
    Otherwise (direction "1" or unknown) → destination = part[1].
    Strip trailing "-<digits>" suffixes and everything after "/" to keep it short.
    """
    if not long_name:
        return ""
    parts = long_name.split("<->")
    if len(parts) == 2:
        raw = parts[0].strip() if direction == "2" else parts[1].strip()
    else:
        raw = parts[0].strip()
    raw = re.sub(r"-\d+$", "", raw).strip()      # drop route-number suffix "-10"
    raw = re.sub(r"-[^-/]+$", "", raw).strip()   # drop city suffix "-כרמיאל"
    if "/" in raw:
        raw = raw.split("/")[0].strip()           # keep station name, drop street
    return raw[:22]                               # cap at 22 chars


async def _fill_route_names(pairs: list[tuple], client: httpx.AsyncClient) -> None:
    today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    missing = [p for p in pairs if p not in _rsn_cache]
    if not missing:
        return
    url = f"{HASADNA_BASE}/gtfs_routes/list"
    params = {
        "line_refs":     ",".join(str(lr) for lr, _ in missing),
        "operator_refs": ",".join(str(op) for _, op in missing),
        "date_from":     today,
        "limit":         2000,
    }
    logger.info("Fetching data from: %s  params=%s", url, params)
    try:
        resp = await client.get(url, params=params, timeout=12.0)
        logger.info("SIRI Response Status: %s  (gtfs_routes)", resp.status_code)
        for row in (resp.json() if resp.status_code == 200 else []):
            lr        = row.get("line_ref")
            op        = row.get("operator_ref")
            rsn       = row.get("route_short_name") or ""
            agency    = row.get("agency_name") or ""
            long_name = row.get("route_long_name") or ""
            direction = str(row.get("route_direction") or "1")
            if lr is not None and op is not None and rsn:
                dest = _extract_dest(long_name, direction)
                _rsn_cache[(int(lr), int(op))] = (str(rsn), str(agency), dest)
    except Exception as exc:
        logger.error("gtfs_routes fetch error: %s", exc)


async def _fetch_hasadna_stop_monitoring(
    stop_code: int,
    window_hours: int,
    client: httpx.AsyncClient,
    now_utc: datetime,
) -> list[dict]:
    """
    Fetch scheduled arrivals for stop_code using the Hasadna GTFS ride-stops endpoint.

    Uses /gtfs_ride_stops/list which provides real per-stop arrival_time from GTFS.
    The old /siri_ride_stops/list endpoint had no per-stop timing — all aimed/expected
    fields were null — causing the fallback to ride start time ("fake 2 min" bug).

    Returns [] if the API is unreachable or the stop has no scheduled arrivals.
    No invented data is ever returned.
    """
    now_il = now_utc.astimezone(IL_TZ)

    # Query window: a small buffer before now so arriving buses aren't missed,
    # plus window_hours ahead.  Times must include the timezone offset (+03:00 / +02:00).
    time_from = (now_il - timedelta(minutes=2)).isoformat(timespec="seconds")
    time_to   = (now_il + timedelta(hours=window_hours)).isoformat(timespec="seconds")

    url = f"{HASADNA_BASE}/gtfs_ride_stops/list"
    params = {
        "gtfs_stop__code":   stop_code,
        "arrival_time_from": time_from,
        "arrival_time_to":   time_to,
        "limit":             60,
        "order_by":          "arrival_time asc",
    }

    print(f"[siri_service] DEBUG: now_il={now_il.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print(f"[siri_service] GET {url}  params={params}")

    try:
        r = await client.get(url, params=params, timeout=12.0)
    except Exception as exc:
        logger.error("gtfs_ride_stops request failed: %s", exc)
        return []

    print(f"[siri_service] Response status={r.status_code}")

    if r.status_code != 200:
        logger.error("gtfs_ride_stops HTTP %s: %s", r.status_code, r.text[:300])
        return []

    rows = r.json()
    if not isinstance(rows, list):
        logger.error("gtfs_ride_stops returned non-list: %s", str(rows)[:200])
        return []

    print(f"[siri_service] {len(rows)} raw rows from gtfs_ride_stops")

    # Log first 3 raw rows for verification
    for i, row in enumerate(rows[:3]):
        print(
            f"[siri_service] raw[{i}]: line={row.get('gtfs_route__route_short_name')}"
            f"  arrival_time={row.get('arrival_time')}"
            f"  stop_code={row.get('gtfs_stop__code')}"
            f"  city={row.get('gtfs_stop__city')}"
        )

    arrivals: list[dict] = []
    seen_journey: set[str] = set()

    for row in rows:
        # Each row is one stop in one GTFS trip — deduplicate by journey_ref
        jref = row.get("gtfs_ride__journey_ref") or str(row.get("gtfs_ride_id", ""))
        if jref in seen_journey:
            continue
        seen_journey.add(jref)

        # arrival_time is the GTFS-scheduled arrival at this specific stop (UTC ISO)
        aimed_at = _parse_iso(row.get("arrival_time") or row.get("departure_time"))
        if aimed_at is None:
            print(f"[siri_service] SKIP row {row.get('id')}: no arrival_time")
            continue

        # Drop if more than 2 min in the past (bus already left)
        if aimed_at < (now_utc - timedelta(minutes=2)):
            print(f"[siri_service] SKIP past arrival: {_fmt_il(aimed_at)} (now={_fmt_il(now_utc)})")
            continue

        # No expected_arrival_time from GTFS — schedule only, no real-time
        display_str, display_type = arrival_display(aimed_at, None, now_utc)
        if display_type == "departed":
            continue

        eta_min = int((aimed_at - now_utc).total_seconds() / 60)

        rsn    = row.get("gtfs_route__route_short_name") or ""
        agency = row.get("gtfs_route__agency_name") or ""
        lr     = row.get("gtfs_route__line_ref")
        op     = row.get("gtfs_route__operator_ref")
        vref   = row.get("siri_ride__vehicle_ref")

        # is_realtime=True when SIRI has a vehicle_ref for this ride — the bus
        # is actively tracked, so show the live indicator in the UI.
        is_rt  = bool(vref and str(vref).strip() not in ("", "None"))

        print(f">>> STATION {stop_code}: Line {rsn or lr} arriving at {display_str} (LIVE: {is_rt})")

        arrivals.append({
            "line_ref":          lr,
            "route_short_name":  rsn or (str(lr) if lr else "?"),
            "agency_name":       agency,
            "operator":          op,
            "aimed_time":        _ts(aimed_at),
            "aimed_display":     _fmt_il(aimed_at),
            "eta_time":          _ts(aimed_at),
            "eta_display":       display_str,
            "display_type":      display_type,
            "eta_minutes":       eta_min,
            "is_realtime":       is_rt,   # True when SIRI vehicle_ref is present
            "vehicle_ref":       vref,
            "scheduled_time":    _ts(aimed_at),
            "scheduled_display": _fmt_il(aimed_at),
            "source":            "hasadna_gtfs",
            "stop_code":         stop_code,
        })

    return arrivals


# ══════════════════════════════════════════════════════════════════════════════
# PUBLIC INTERFACE
# ══════════════════════════════════════════════════════════════════════════════

async def fetch_arrivals_for_stop(
    stop_code: int,
    window_hours: int = 2,
) -> list[dict]:
    """
    Fetch upcoming arrivals for stop_code.

    Tries MOT SIRI first; falls back to Hasadna if unavailable or unauthenticated.
    Returns [] on all failures — no invented data.
    """
    now_utc = datetime.now(timezone.utc)
    now_il  = now_utc.astimezone(IL_TZ)
    logger.info(
        "=== fetch_arrivals_for_stop  stop=%d  now_il=%s ===",
        stop_code, now_il.strftime("%Y-%m-%d %H:%M:%S %Z"),
    )

    async with httpx.AsyncClient(timeout=20.0) as client:
        # Source 1: MOT SIRI (authenticated)
        mot_arrivals = await _fetch_mot_stop_monitoring(stop_code, client, now_utc)
        if mot_arrivals is not None:
            logger.info("Using MOT SIRI data (%d arrivals)", len(mot_arrivals))
            for a in mot_arrivals:
                a.setdefault("stop_code", stop_code)
            mot_arrivals.sort(key=lambda a: a["eta_minutes"])
            return mot_arrivals

        # Source 2: Hasadna (public fallback)
        logger.info("Falling back to Hasadna Open Bus Stride API")
        arrivals = await _fetch_hasadna_stop_monitoring(stop_code, window_hours, client, now_utc)

        # Resolve destination names while client is still open
        if arrivals:
            pairs = list({
                (int(a["line_ref"]), int(a["operator"]))
                for a in arrivals
                if a.get("line_ref") is not None and a.get("operator") is not None
            })
            if pairs:
                await _fill_route_names(pairs, client)
            for a in arrivals:
                lr = a.get("line_ref")
                op = a.get("operator")
                if lr is not None and op is not None:
                    _, _, dest = _rsn_cache.get((int(lr), int(op)), ("", "", ""))
                    if dest:
                        a.setdefault("destination", dest)

    arrivals.sort(key=lambda a: a["eta_minutes"])
    logger.info(
        "fetch_arrivals_for_stop done: %d arrivals  stop=%d", len(arrivals), stop_code
    )
    return arrivals


async def fetch_nearby_stops(
    lat: float,
    lon: float,
    radius_m: float = 500,
) -> list[dict]:
    """
    Fetch bus stops within radius_m metres of (lat, lon) from the Hasadna GTFS API.

    Strategy:
      1. Build an approximate bounding box (lat ± delta, lon ± delta).
      2. Query the Hasadna /gtfs_stops/list endpoint — it accepts lat/lon bbox via
         lat_min/lat_max/lon_min/lon_max params but its filtering is unreliable, so
         we re-filter client-side with haversine.
      3. Returns a list of dicts: {stop_code, stop_name, lat, lon, dist_m}.

    Never invents data — returns [] on any failure.
    """
    today     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    radius_km = radius_m / 1000.0

    # Degree deltas for the bounding-box pre-filter (generous — haversine cleans up)
    lat_delta = (radius_km * 1.5) / 111.0
    lon_delta = (radius_km * 1.5) / (111.0 * math.cos(math.radians(lat)))

    params = {
        "date_from": today,
        "limit":     500,
        "lat_min":   lat - lat_delta,
        "lat_max":   lat + lat_delta,
        "lon_min":   lon - lon_delta,
        "lon_max":   lon + lon_delta,
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{HASADNA_BASE}/gtfs_stops/list", params=params)
        if r.status_code != 200:
            logger.warning("fetch_nearby_stops: HTTP %s", r.status_code)
            return []
        raw = r.json()
        if not isinstance(raw, list):
            return []
    except Exception as exc:
        logger.error("fetch_nearby_stops: request failed: %s", exc)
        return []

    stops: list[dict] = []
    seen_codes: set[int] = set()
    for s in raw:
        code = s.get("code")
        slat = s.get("lat")
        slon = s.get("lon")
        if code is None or slat is None or slon is None:
            continue
        if code in seen_codes:
            continue
        dist_km = haversine_km(lat, lon, slat, slon)
        if dist_km > radius_km:
            continue
        seen_codes.add(code)
        stops.append({
            "stop_code": code,
            "stop_name": s.get("name") or f"תחנה {code}",
            "lat":       slat,
            "lon":       slon,
            "dist_m":    int(dist_km * 1000),
        })

    stops.sort(key=lambda s: s["dist_m"])
    logger.info(
        "fetch_nearby_stops: %d stops within %.0fm of %.4f,%.4f",
        len(stops), radius_m, lat, lon,
    )
    return stops


async def get_realtime_buses(limit: int = 200) -> list[dict]:
    """
    Strict public interface: fetch live buses within TIBERIAS_RADIUS_KM of Tiberias.
    Calls ONLY the Hasadna SIRI API. Returns [] on any failure — no fallback data.
    """
    return await fetch_live_vehicles(
        lat_min=TIBERIAS_LAT - 0.018,
        lat_max=TIBERIAS_LAT + 0.018,
        lon_min=TIBERIAS_LON - 0.0215,
        lon_max=TIBERIAS_LON + 0.0215,
        radius_km=TIBERIAS_RADIUS_KM,
        limit=limit,
    )


async def fetch_live_vehicles(
    lat_min: float, lat_max: float,
    lon_min: float, lon_max: float,
    radius_km: float,
    limit: int = 200,
) -> list[dict]:
    """
    Fetch real-time vehicle positions within the given bbox + radius.
    Ghost buses (GPS > 10 min stale) are dropped.
    Returns [] on failure — no invented vehicles.
    """
    now_utc      = datetime.now(timezone.utc)
    now_il       = now_utc.astimezone(IL_TZ)
    ghost_cutoff = now_utc - timedelta(minutes=10)
    live_cutoff  = now_utc - timedelta(minutes=5)
    time_from    = (now_utc - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    # ── LOCATION FILTER: always pin to Tiberias centre + 2 km ─────────────────
    # The frontend may send a wide viewport bbox (full-Israel) when not in focus
    # mode.  Pinning to TIBERIAS_LAT/LON + TIBERIAS_RADIUS_KM ensures we NEVER
    # return buses from Haifa, Tel Aviv, etc. regardless of the frontend bbox.
    FILTER_LAT = TIBERIAS_LAT        # 32.7922
    FILTER_LON = TIBERIAS_LON        # 35.5312
    FILTER_KM  = TIBERIAS_RADIUS_KM  # 2.0

    url = f"{HASADNA_BASE}/siri_vehicle_locations/list"
    params = {
        "limit":                 1000,
        "order_by":              "id desc",
        "recorded_at_time_from": time_from,
    }
    print(f"[fetch_live_vehicles] {now_il.strftime('%H:%M:%S %Z')}  "
          f"filter=Tiberias {FILTER_LAT},{FILTER_LON} radius={FILTER_KM}km")
    print(f"[fetch_live_vehicles] GET {url}  params={params}")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url, params=params, timeout=15.0)
            raw_count = len(resp.json()) if resp.status_code == 200 else 0
            print(f"[fetch_live_vehicles] Response status={resp.status_code}  raw_records={raw_count}")
            resp.raise_for_status()
            raw_items = resp.json()

            buses: list[dict] = []
            seen_vrefs: set[str] = set()
            dropped: dict[str, int] = {"radius": 0, "ghost": 0, "dup": 0}

            for item in raw_items:
                lat = item.get("lat")
                lon = item.get("lon")
                if lat is None or lon is None:
                    continue

                # Haversine radius filter — always against Tiberias centre
                dist_km = haversine_km(FILTER_LAT, FILTER_LON, lat, lon)
                if dist_km > FILTER_KM:
                    dropped["radius"] += 1
                    continue

                # Ghost-bus filter: GPS > 10 min old → drop entirely
                recorded_at = _parse_iso(item.get("recorded_at_time"))
                if recorded_at is None or recorded_at < ghost_cutoff:
                    dropped["ghost"] += 1
                    continue

                lr   = item.get("siri_route__line_ref")
                op   = item.get("siri_route__operator_ref")
                vref = item.get("siri_ride__vehicle_ref") or ""

                if vref:
                    if vref in seen_vrefs:
                        dropped["dup"] += 1
                        continue
                    seen_vrefs.add(vref)

                if len(buses) >= limit:
                    break

                is_live = recorded_at >= live_cutoff
                rsn = str(lr) if lr is not None else "?"
                buses.append({
                    "id":               f"bus_{item['id']}",
                    "lat":              lat,
                    "lon":              lon,
                    "bearing":          item.get("bearing") or 0,
                    "velocity":         item.get("velocity") or 0,
                    "line_ref":         lr,
                    "operator_ref":     op,
                    "vehicle_ref":      vref,
                    "journey_ref":      item.get("siri_ride__journey_ref"),
                    "recorded_at":      item.get("recorded_at_time"),
                    "dist_km":          round(dist_km, 2),
                    "source":           "hasadna_siri",
                    "type":             "bus",
                    "route_short_name": rsn,
                    "operator":         op,
                    "agency_name":      "",
                    "destination_name": "",   # resolved below after route lookup
                    "is_live":          is_live,
                })
                print(f">>> REAL-TIME VALIDATION: Found {rsn} at {lat}/{lon}. "
                      f"Distance from User: {round(dist_km, 2)}km")

            print(f"[fetch_live_vehicles] kept={len(buses)}  "
                  f"dropped radius={dropped['radius']} ghost={dropped['ghost']} dup={dropped['dup']}")

            # Resolve route_short_name
            if buses:
                async with httpx.AsyncClient(timeout=12.0) as c2:
                    pairs = [
                        (int(b["line_ref"]), int(b["operator_ref"]))
                        for b in buses
                        if b["line_ref"] is not None and b["operator_ref"] is not None
                    ]
                    await _fill_route_names(pairs, c2)
                for b in buses:
                    lr = b["line_ref"]
                    op = b["operator_ref"]
                    if lr is not None and op is not None:
                        rsn, agency, dest = _rsn_cache.get((int(lr), int(op)), ("", "", ""))
                        if rsn:
                            b["route_short_name"] = rsn
                            b["agency_name"]      = agency
                            b["destination_name"] = dest
                            print(f"Sending bus {rsn} to {dest!r} to frontend")

            return buses

    except Exception as exc:
        logger.error("fetch_live_vehicles error: %s", exc)
        return []
