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

    DATE ANCHOR RULE: which calendar day the bus runs is ALWAYS decided by
    aimed_arrival_time in Israel local time.  A stale expected_arrival_time
    that happens to be "2 minutes from now" cannot override this.

    expected_arrival_time is trusted for the countdown only if its drift from
    aimed_arrival_time is ≤ 60 minutes (sanity check for stale SIRI data).
    """
    if aimed_utc is None:
        return "—", "scheduled"

    now_il   = now_utc.astimezone(IL_TZ)
    aimed_il = aimed_utc.astimezone(IL_TZ)

    # ── DATE ANCHOR ────────────────────────────────────────────────────────────
    if aimed_il.date() < now_il.date():
        return "עבר", "departed"      # yesterday's ride leaked through

    if aimed_il.date() > now_il.date():
        # Priority 3: bus runs tomorrow in Israel local calendar
        return f"מחר ב-{aimed_il.strftime('%H:%M')}", "next_day"

    # ── Today's bus — validate expected_arrival_time ───────────────────────────
    eta_utc        = aimed_utc
    using_realtime = False
    if expected_utc is not None:
        drift_sec = abs((expected_utc - aimed_utc).total_seconds())
        if drift_sec <= 3600:          # ≤ 60 min drift → believable
            eta_utc        = expected_utc
            using_realtime = True
        else:
            logger.warning(
                "Ignored stale expected_arrival_time "
                "(drift %.1f min): aimed=%s  expected=%s",
                drift_sec / 60, _fmt_il(aimed_utc), _fmt_il(expected_utc),
            )

    # ── EXACT SUBTRACTION: now_utc from eta_utc ───────────────────────────────
    mins = int((eta_utc - now_utc).total_seconds() / 60)   # ← THE LINE

    if mins < 0:
        return "עבר", "departed"
    if mins == 0:
        return "מגיע", "realtime" if using_realtime else "scheduled"

    # Priority 1: real-time, arrives in < 30 min
    if using_realtime and mins < 30:
        return ("בעוד דקה" if mins == 1 else f"בעוד {mins} דקות"), "realtime"

    # Priority 2: no valid real-time, or ≥ 30 min — planned clock time
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

# in-process cache: (line_ref, operator_ref) → (route_short_name, agency_name)
_rsn_cache: dict[tuple, tuple[str, str]] = {}


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
            lr  = row.get("line_ref")
            op  = row.get("operator_ref")
            rsn = row.get("route_short_name") or ""
            agency = row.get("agency_name") or ""
            if lr is not None and op is not None and rsn:
                _rsn_cache[(int(lr), int(op))] = (str(rsn), str(agency))
    except Exception as exc:
        logger.error("gtfs_routes fetch error: %s", exc)


async def _fetch_hasadna_stop_monitoring(
    stop_code: int,
    window_hours: int,
    client: httpx.AsyncClient,
    now_utc: datetime,
) -> list[dict]:
    """
    Fetch arrivals for stop_code from the Hasadna Open Bus Stride API.
    This is a public REST proxy of the same Israeli MOT SIRI/GTFS data.
    """
    # Step 1 — stop code → SIRI stop IDs
    url1 = f"{HASADNA_BASE}/siri_stops/list"
    logger.info("Fetching data from: %s  params={codes: %s}", url1, stop_code)
    r1 = await client.get(url1, params={"codes": stop_code, "limit": 5}, timeout=8.0)
    logger.info("SIRI Response Status: %s  (siri_stops)", r1.status_code)

    siri_stops = r1.json() if r1.status_code == 200 else []
    if not isinstance(siri_stops, list) or not siri_stops or not siri_stops[0].get("id"):
        logger.warning("Stop %s not found in Hasadna SIRI database", stop_code)
        return []

    siri_stop_ids = [str(s["id"]) for s in siri_stops[:3]]
    logger.info("Resolved stop %s → SIRI IDs %s", stop_code, siri_stop_ids)

    # Step 2 — ride-stops for this stop
    query_from = (now_utc - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    query_to   = (now_utc + timedelta(hours=window_hours)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    params2 = {
        "siri_stop_ids":                         ",".join(siri_stop_ids),
        "siri_ride__scheduled_start_time_from":  query_from,
        "siri_ride__scheduled_start_time_to":    query_to,
        "limit":    60,
        "order_by": "aimed_arrival_time asc",
    }
    url2 = f"{HASADNA_BASE}/siri_ride_stops/list"
    logger.info("Fetching data from: %s  params=%s", url2, params2)
    r2 = await client.get(url2, params=params2, timeout=12.0)
    logger.info("SIRI Response Status: %s  (siri_ride_stops, %d records)",
                r2.status_code,
                len(r2.json()) if r2.status_code == 200 and isinstance(r2.json(), list) else 0)

    rides = r2.json() if r2.status_code == 200 else []
    if not isinstance(rides, list):
        logger.error("Hasadna siri_ride_stops returned non-list: %s", rides)
        return []

    # Log first 3 raw records so operator can verify fields
    for i, ride in enumerate(rides[:3]):
        logger.info(
            "raw ride[%d]: line=%s  aimed=%s  expected=%s  actual=%s",
            i,
            ride.get("siri_route__line_ref"),
            ride.get("aimed_arrival_time"),
            ride.get("expected_arrival_time"),
            ride.get("actual_arrival_time"),
        )

    # Step 3 — resolve route names
    pairs = [
        (int(r["siri_route__line_ref"]), int(r["siri_route__operator_ref"]))
        for r in rides
        if r.get("siri_route__line_ref") and r.get("siri_route__operator_ref")
    ]
    if pairs:
        await _fill_route_names(pairs, client)

    # Step 4 — build arrival list
    arrivals: list[dict] = []
    seen: set[str] = set()

    for ride in rides:
        ride_key = f"{ride.get('siri_ride__id')}_{ride.get('siri_stop__id')}"
        if ride_key in seen:
            continue
        seen.add(ride_key)

        # Skip if bus already departed this stop
        if _parse_iso(ride.get("actual_arrival_time")) is not None:
            continue

        # Stop-specific scheduled arrival (aimed > departure > ride start as fallback)
        aimed_at = (
            _parse_iso(ride.get("aimed_arrival_time"))
            or _parse_iso(ride.get("aimed_departure_time"))
            or _parse_iso(ride.get("siri_ride__scheduled_start_time"))
        )
        if aimed_at is None:
            continue

        # Drop if more than 2 minutes in the past
        if aimed_at < (now_utc - timedelta(minutes=2)):
            continue

        expected_at = _parse_iso(ride.get("expected_arrival_time"))

        # Three-priority display (with date anchor on aimed_at)
        display_str, display_type = arrival_display(aimed_at, expected_at, now_utc)
        if display_type == "departed":
            continue

        # ETA minutes — use expected only if sane (within 60 min)
        if expected_at and abs((expected_at - aimed_at).total_seconds()) <= 3600:
            eta_ref = expected_at
        else:
            eta_ref = aimed_at
        eta_min = int((eta_ref - now_utc).total_seconds() / 60)

        lr  = ride.get("siri_route__line_ref")
        op  = ride.get("siri_route__operator_ref")
        rsn, agency = _rsn_cache.get(
            (int(lr), int(op)) if lr is not None and op is not None else (-1, -1),
            ("", ""),
        )

        logger.info(
            "  → line=%-6s aimed_il=%s  expected=%s  display='%s'  type=%s  eta_min=%d",
            rsn or lr, _fmt_il(aimed_at),
            "—" if expected_at is None else _fmt_il(expected_at),
            display_str, display_type, eta_min,
        )

        arrivals.append({
            "line_ref":          lr,
            "route_short_name":  rsn or (str(lr) if lr else "?"),
            "agency_name":       agency,
            "operator":          op,
            "aimed_time":        _ts(aimed_at),
            "aimed_display":     _fmt_il(aimed_at),
            "eta_time":          _ts(eta_ref),
            "eta_display":       display_str,
            "display_type":      display_type,
            "eta_minutes":       eta_min,
            "is_realtime":       display_type == "realtime",
            "vehicle_ref":       ride.get("siri_ride__vehicle_ref"),
            "scheduled_time":    _ts(aimed_at),
            "scheduled_display": _fmt_il(aimed_at),
            "source":            "hasadna_siri",
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
            mot_arrivals.sort(key=lambda a: a["eta_minutes"])
            return mot_arrivals

        # Source 2: Hasadna (public fallback)
        logger.info("Falling back to Hasadna Open Bus Stride API")
        arrivals = await _fetch_hasadna_stop_monitoring(stop_code, window_hours, client, now_utc)

    arrivals.sort(key=lambda a: a["eta_minutes"])
    logger.info(
        "fetch_arrivals_for_stop done: %d arrivals  (source=hasadna_siri)", len(arrivals)
    )
    return arrivals


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
    center_lat   = (lat_min + lat_max) / 2
    center_lon   = (lon_min + lon_max) / 2
    time_from    = (now_utc - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    url = f"{HASADNA_BASE}/siri_vehicle_locations/list"
    params = {
        "limit":                 1000,
        "order_by":              "id desc",
        "recorded_at_time_from": time_from,
    }
    logger.info(
        "=== fetch_live_vehicles  %s ===", now_il.strftime("%Y-%m-%d %H:%M:%S %Z")
    )
    logger.info("Fetching data from: %s  params=%s", url, params)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url, params=params, timeout=15.0)
            logger.info("SIRI Response Status: %s  (%d raw records)",
                        resp.status_code,
                        len(resp.json()) if resp.status_code == 200 else 0)
            resp.raise_for_status()
            raw_items = resp.json()

            buses: list[dict] = []
            seen_vrefs: set[str] = set()
            dropped: dict[str, int] = {"bbox": 0, "radius": 0, "ghost": 0}

            for item in raw_items:
                lat = item.get("lat")
                lon = item.get("lon")
                if lat is None or lon is None:
                    continue

                # Bbox pre-filter
                if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
                    dropped["bbox"] += 1
                    continue

                # Haversine radius filter
                dist_km = haversine_km(center_lat, center_lon, lat, lon)
                if dist_km > radius_km:
                    dropped["radius"] += 1
                    continue

                # Ghost-bus filter
                recorded_at = _parse_iso(item.get("recorded_at_time"))
                if recorded_at is None or recorded_at < ghost_cutoff:
                    dropped["ghost"] += 1
                    continue

                lr   = item.get("siri_route__line_ref")
                op   = item.get("siri_route__operator_ref")
                vref = item.get("siri_ride__vehicle_ref") or ""

                if vref:
                    if vref in seen_vrefs:
                        continue
                    seen_vrefs.add(vref)

                if len(buses) >= limit:
                    break

                is_live = recorded_at >= live_cutoff
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
                    "route_short_name": str(lr) if lr is not None else "?",
                    "operator":         op,
                    "agency_name":      "",
                    "is_live":          is_live,
                })

            logger.info(
                "fetch_live_vehicles result: %d buses | dropped bbox=%d radius=%d ghost=%d",
                len(buses), dropped["bbox"], dropped["radius"], dropped["ghost"],
            )
            for b in buses:
                logger.info(
                    "  bus line=%-6s lat=%.4f lon=%.4f dist=%.2f km is_live=%s recorded=%s",
                    b["route_short_name"], b["lat"], b["lon"],
                    b["dist_km"], b["is_live"], b["recorded_at"],
                )

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
                        rsn, agency = _rsn_cache.get((int(lr), int(op)), ("", ""))
                        if rsn:
                            b["route_short_name"] = rsn
                            b["agency_name"]      = agency

            return buses

    except Exception as exc:
        logger.error("fetch_live_vehicles error: %s", exc)
        return []
