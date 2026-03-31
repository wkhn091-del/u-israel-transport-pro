from fastapi import APIRouter, Query
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from services.trains_service import (
    STATIONS, STATION_BY_ID, get_routes_async, parse_routes
)

router = APIRouter()
IL_TZ = ZoneInfo("Asia/Jerusalem")


@router.get("/stations")
async def list_stations():
    """Return all known Israel Railways stations with coordinates."""
    return {
        "stations": [
            {
                "id": v["id"],
                "name_he": k,
                "name_en": v["name_en"],
                "lat": v["lat"],
                "lon": v["lon"],
            }
            for k, v in STATIONS.items()
        ]
    }


@router.get("/routes")
async def get_train_routes(
    origin_id: int = Query(..., description="Origin station ID"),
    dest_id: int = Query(..., description="Destination station ID"),
):
    """
    Fetch live routes between two stations from Israel Railways API.
    Returns departure/arrival times and real-time delay info.
    """
    if origin_id == dest_id:
        return {"error": "Origin and destination must differ", "routes": []}

    data = await get_routes_async(origin_id, dest_id)
    routes = parse_routes(data, origin_id, dest_id)
    return {"routes": routes, "timestamp": int(time.time())}


@router.get("/live")
async def get_live_trains():
    """
    Fetch live train positions by querying multiple route pairs from Israel Railways API.
    Interpolates each train's map position between origin and destination
    based on its scheduled departure/arrival window (Israel local time).
    Returns empty list with error message if the API is unavailable — no fake data.
    """
    import asyncio

    # Representative cross-country route pairs to show across the map
    route_pairs = [
        (3600, 4600),  # Tel Aviv ↔ Jerusalem
        (3600, 1500),  # Tel Aviv ↔ Haifa
        (3600, 7300),  # Tel Aviv ↔ Beer Sheva
        (2800, 3600),  # Netanya ↔ Tel Aviv
        (3400, 3600),  # Bnei Brak ↔ Tel Aviv
        (8600, 3600),  # Rishon ↔ Tel Aviv
    ]

    tasks = [get_routes_async(o, d) for o, d in route_pairs]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Use Israel local time for progress calculation — Railway API times are Israel local
    now = datetime.now(IL_TZ)
    vehicles = []
    seen_trains: set = set()
    api_failed = all(isinstance(r, Exception) or r is None for r in results)

    for (origin_id, dest_id), raw in zip(route_pairs, results):
        if isinstance(raw, Exception) or raw is None:
            continue
        routes = parse_routes(raw, origin_id, dest_id)
        for route in routes:
            train_no = route.get("train_number", "")
            if train_no and train_no in seen_trains:
                continue
            if train_no:
                seen_trains.add(train_no)

            # Parse departure/arrival using Israel local time
            try:
                today_il = now.date()
                dep = datetime.strptime(
                    f"{today_il} {route['departure_time']}", "%Y-%m-%d %H:%M"
                ).replace(tzinfo=IL_TZ)
                arr = datetime.strptime(
                    f"{today_il} {route['arrival_time']}", "%Y-%m-%d %H:%M"
                ).replace(tzinfo=IL_TZ)
                total_sec = (arr - dep).total_seconds()
                elapsed_sec = (now - dep).total_seconds()
                progress = max(0.0, min(1.0, elapsed_sec / total_sec)) if total_sec > 0 else 0.5
            except Exception:
                progress = 0.5

            olat = route.get("origin_lat") or 0
            olon = route.get("origin_lon") or 0
            dlat = route.get("dest_lat") or 0
            dlon = route.get("dest_lon") or 0

            lat = olat + (dlat - olat) * progress
            lon = olon + (dlon - olon) * progress

            delay = route.get("departure_delay_min", 0)
            vehicles.append({
                "id": f"train_{train_no or len(vehicles)}",
                "train_number": train_no,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "origin": route["origin_name"],
                "origin_he": route["origin_name_he"],
                "destination": route["dest_name"],
                "destination_he": route["dest_name_he"],
                "departure_time": route["departure_time"],
                "arrival_time": route["arrival_time"],
                "delay_minutes": delay,
                "platform": route["platform"],
                "status": route["status"],
                "changes": route["changes"],
                "progress": round(progress, 3),
                "type": "train",
            })

    if not vehicles:
        return {
            "trains":         [],
            "count":          0,
            "source":         "unavailable",
            "service_status": "unavailable",
            "error":          "Israel Railways API temporarily unavailable. Real-time data will resume automatically.",
            "timestamp":      int(time.time()),
        }

    return {"trains": vehicles, "count": len(vehicles), "source": "live", "timestamp": int(time.time())}
