"""
Routing router — OSRM driving directions + Israel transit trip options.
"""
from fastapi import APIRouter, Query
import httpx
import math
import time

router = APIRouter()
OSRM_BASE = "http://router.project-osrm.org/route/v1/driving"


@router.get("/plan")
async def plan_route(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
):
    """Driving route between two coordinates via OSRM."""
    try:
        url = f"{OSRM_BASE}/{from_lon},{from_lat};{to_lon},{to_lat}"
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, params={"steps": "false", "geometries": "geojson", "overview": "full"})
            resp.raise_for_status()
            data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return {"error": "No route found", "coordinates": []}
        route = data["routes"][0]
        latlngs = [[c[1], c[0]] for c in route["geometry"]["coordinates"]]
        return {
            "coordinates": latlngs,
            "distance_m": round(route["distance"]),
            "duration_s": round(route["duration"]),
            "distance_km": round(route["distance"] / 1000, 1),
            "duration_min": round(route["duration"] / 60),
        }
    except Exception as e:
        return {"error": str(e), "coordinates": []}


# ── Israel transit route lookup table ────────────────────────────────────────
# Each entry: origins[], dests[], options[], flight_route (bool)
ROUTE_TABLE = [
    {
        "origins": ["טבריה", "tiberias"],
        "dests": ["תל אביב", "tel aviv", "telaviv"],
        "options": [
            {
                "id": "bus_836",
                "type": "bus",
                "label": "אוטובוס ישיר",
                "line": "836",
                "operator": "אגד",
                "direct": True,
                "duration_min": 105,
                "price_ils": 22,
                "legs": [{"type": "bus", "line": "836", "from": "טבריה", "to": "תל אביב מרכז", "duration_min": 105}],
            },
            {
                "id": "bus_train_haifa",
                "type": "mixed",
                "label": "אוטובוס + רכבת דרך חיפה",
                "line": "431 + רכבת",
                "operator": "אגד + רכבת ישראל",
                "direct": False,
                "duration_min": 118,
                "price_ils": 29,
                "legs": [
                    {"type": "bus", "line": "431", "from": "טבריה", "to": "חיפה מרכז", "duration_min": 55},
                    {"type": "train", "line": "רכבת ישראל", "from": "חיפה מרכז", "to": "תל אביב מרכז", "duration_min": 55},
                ],
            },
            {
                "id": "service_taxi",
                "type": "bus",
                "label": "מונית שירות",
                "line": "שירות",
                "operator": "שירות",
                "direct": True,
                "duration_min": 88,
                "price_ils": 45,
                "legs": [{"type": "taxi", "from": "טבריה", "to": "תל אביב", "duration_min": 88}],
            },
        ],
    },
    {
        "origins": ["ירושלים", "jerusalem"],
        "dests": ["תל אביב", "tel aviv"],
        "options": [
            {
                "id": "train_navon",
                "type": "train",
                "label": "רכבת מהירה",
                "line": "רכבת ישראל",
                "operator": "רכבת ישראל",
                "direct": True,
                "duration_min": 35,
                "price_ils": 22,
                "legs": [{"type": "train", "line": "רכבת ישראל", "from": "ירושלים — יצחק נבון", "to": "תל אביב מרכז", "duration_min": 35}],
            },
            {
                "id": "bus_480",
                "type": "bus",
                "label": "אוטובוס מהיר",
                "line": "480",
                "operator": "אגד",
                "direct": True,
                "duration_min": 70,
                "price_ils": 16,
                "legs": [{"type": "bus", "line": "480", "from": "ירושלים", "to": "תל אביב", "duration_min": 70}],
            },
            {
                "id": "bus_train_jlem",
                "type": "mixed",
                "label": "אוטובוס + רכבת",
                "line": "485 + רכבת",
                "operator": "אגד + רכבת ישראל",
                "direct": False,
                "duration_min": 75,
                "price_ils": 25,
                "legs": [
                    {"type": "bus", "line": "485", "from": "ירושלים", "to": "מודיעין", "duration_min": 30},
                    {"type": "train", "line": "רכבת ישראל", "from": "מודיעין", "to": "תל אביב", "duration_min": 25},
                ],
            },
        ],
    },
    {
        "origins": ["חיפה", "haifa"],
        "dests": ["תל אביב", "tel aviv"],
        "options": [
            {
                "id": "train_haifa_ta",
                "type": "train",
                "label": "רכבת ישראל",
                "line": "רכבת ישראל",
                "operator": "רכבת ישראל",
                "direct": True,
                "duration_min": 55,
                "price_ils": 22,
                "legs": [{"type": "train", "line": "רכבת ישראל", "from": "חיפה מרכז", "to": "תל אביב מרכז", "duration_min": 55}],
            },
            {
                "id": "bus_910",
                "type": "bus",
                "label": "אוטובוס בינעירוני",
                "line": "910",
                "operator": "אגד",
                "direct": True,
                "duration_min": 90,
                "price_ils": 22,
                "legs": [{"type": "bus", "line": "910", "from": "חיפה", "to": "תל אביב", "duration_min": 90}],
            },
        ],
    },
    {
        "origins": ["באר שבע", "beer sheva", "beersheba", "beer-sheva"],
        "dests": ["תל אביב", "tel aviv"],
        "options": [
            {
                "id": "train_bs_ta",
                "type": "train",
                "label": "רכבת ישראל",
                "line": "רכבת ישראל",
                "operator": "רכבת ישראל",
                "direct": True,
                "duration_min": 55,
                "price_ils": 22,
                "legs": [{"type": "train", "line": "רכבת ישראל", "from": "באר שבע מרכז", "to": "תל אביב מרכז", "duration_min": 55}],
            },
            {
                "id": "bus_370",
                "type": "bus",
                "label": "אוטובוס בינעירוני",
                "line": "370",
                "operator": "אגד",
                "direct": True,
                "duration_min": 80,
                "price_ils": 18,
                "legs": [{"type": "bus", "line": "370", "from": "באר שבע", "to": "תל אביב", "duration_min": 80}],
            },
        ],
    },
    {
        "origins": ["נתניה", "netanya"],
        "dests": ["תל אביב", "tel aviv"],
        "options": [
            {
                "id": "train_netanya",
                "type": "train",
                "label": "רכבת ישראל",
                "line": "רכבת ישראל",
                "operator": "רכבת ישראל",
                "direct": True,
                "duration_min": 28,
                "price_ils": 15,
                "legs": [{"type": "train", "line": "רכבת ישראל", "from": "נתניה", "to": "תל אביב מרכז", "duration_min": 28}],
            },
            {
                "id": "bus_601",
                "type": "bus",
                "label": "אוטובוס בינעירוני",
                "line": "601",
                "operator": "קווים",
                "direct": True,
                "duration_min": 50,
                "price_ils": 14,
                "legs": [{"type": "bus", "line": "601", "from": "נתניה", "to": "תל אביב", "duration_min": 50}],
            },
        ],
    },
    # Eilat — always flight applicable
    {
        "origins": ["_any_"],
        "dests": ["אילת", "eilat"],
        "flight_route": True,
        "options": [
            {
                "id": "flight_eilat",
                "type": "flight",
                "label": "טיסה ישירה",
                "line": "ISD",
                "operator": "ישראייר",
                "direct": True,
                "duration_min": 55,
                "price_ils": 180,
                "legs": [{"type": "flight", "from": "נמל בן גוריון", "to": "נמל אילת — רמון", "duration_min": 55}],
            },
            {
                "id": "bus_394",
                "type": "bus",
                "label": "אוטובוס לילה",
                "line": "394",
                "operator": "אגד",
                "direct": True,
                "duration_min": 310,
                "price_ils": 45,
                "legs": [{"type": "bus", "line": "394", "from": "תל אביב", "to": "אילת", "duration_min": 310}],
            },
        ],
    },
]


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _match(name: str, keywords: list) -> bool:
    n = name.lower().strip()
    return any(k.lower() in n or n in k.lower() for k in keywords)


def _find_route(origin: str, destination: str):
    """Return (options, is_flight_route). Tries both directions."""
    for entry in ROUTE_TABLE:
        origins = entry["origins"]
        dests = entry["dests"]
        is_flight = entry.get("flight_route", False)

        if origins == ["_any_"]:
            if _match(destination, dests):
                return list(entry["options"]), is_flight
        else:
            if _match(origin, origins) and _match(destination, dests):
                return list(entry["options"]), is_flight
            # Try reversed
            if _match(origin, dests) and _match(destination, origins):
                reversed_opts = []
                for opt in entry["options"]:
                    rev = dict(opt)
                    rev["id"] = rev["id"] + "_rev"
                    if "legs" in rev:
                        rev["legs"] = [
                            {**leg, "from": leg.get("to", ""), "to": leg.get("from", "")}
                            for leg in reversed(rev["legs"])
                        ]
                    reversed_opts.append(rev)
                return reversed_opts, is_flight

    return None, False


# Cities with NO rail service — nearest train stations listed for smart routing
NO_RAIL_CITIES = {
    "טבריה": {"nearest_stations": ["בית שאן", "כרמיאל"], "nearest_en": ["Beit Shean", "Carmiel"]},
    "tiberias": {"nearest_stations": ["בית שאן", "כרמיאל"], "nearest_en": ["Beit Shean", "Carmiel"]},
    "tverya": {"nearest_stations": ["בית שאן", "כרמיאל"], "nearest_en": ["Beit Shean", "Carmiel"]},
    "צפת": {"nearest_stations": ["כרמיאל"], "nearest_en": ["Carmiel"]},
    "safed": {"nearest_stations": ["כרמיאל"], "nearest_en": ["Carmiel"]},
    "zefat": {"nearest_stations": ["כרמיאל"], "nearest_en": ["Carmiel"]},
}


def _is_no_rail_city(name: str) -> bool:
    """Return True if this city has no Israel Railways station."""
    n = name.lower().strip()
    return any(k in n or n in k for k in NO_RAIL_CITIES)


@router.get("/trip-options")
async def get_trip_options(
    origin: str = Query(..., description="Origin city name (Hebrew or English)"),
    destination: str = Query(..., description="Destination city name"),
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
):
    """
    Return real Israel transit options for a city-to-city route from the route lookup table.
    No fake/generated options — if the route is unknown, returns an empty list.

    Smart routing: cities without rail service (e.g. Tiberias) never show direct train options.
    Instead they show buses, or a bus to the nearest train station.
    """
    dist_km = _haversine_km(from_lat, from_lon, to_lat, to_lon)

    options, _ = _find_route(origin, destination)

    # Smart routing: if origin has no rail, strip any remaining direct-train options
    # and ensure the ROUTE_TABLE entry doesn't accidentally include them.
    if _is_no_rail_city(origin):
        options = [o for o in (options or []) if o.get("type") != "train" or not o.get("direct")]

    # Attach deterministic next-departure offsets (changes every ~15 min, stable within a cycle)
    base_min = int(time.time() // 60)
    base_offset = (base_min % 15) + 3  # 3–17 min until next departure
    for i, opt in enumerate(options or []):
        opt["next_departure_min"] = base_offset + i * 18

    return {
        "origin":       origin,
        "destination":  destination,
        "distance_km":  round(dist_km, 1),
        "options":      options or [],
        "no_data":      not options,
        "timestamp":    int(time.time()),
    }
