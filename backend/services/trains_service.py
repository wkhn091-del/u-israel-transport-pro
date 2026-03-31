"""
Israel Railways service — based on the user's custom train logic.
Adapted for async use inside FastAPI.
"""
import httpx
from datetime import datetime
from zoneinfo import ZoneInfo

IL_TZ = ZoneInfo("Asia/Jerusalem")

# ============================
# Station IDs with coordinates
# ============================
STATIONS = {
    "תל אביב סבידור מרכז": {"id": 3600, "lat": 32.0867, "lon": 34.7806, "name_en": "Tel Aviv Savidor Center"},
    "ירושלים יצחק נבון":   {"id": 4600, "lat": 31.7894, "lon": 35.2037, "name_en": "Jerusalem Yitzhak Navon"},
    "חיפה מרכז השמיטה":    {"id": 1500, "lat": 32.8156, "lon": 34.9887, "name_en": "Haifa Center HaShmona"},
    "באר שבע מרכז":        {"id": 7300, "lat": 31.2457, "lon": 34.7994, "name_en": "Beer Sheva Center"},
    "בני ברק":             {"id": 3400, "lat": 32.0841, "lon": 34.8337, "name_en": "Bnei Brak"},
    "פתח תקווה סגולה":     {"id": 3500, "lat": 32.0940, "lon": 34.8795, "name_en": "Petah Tikva Segula"},
    "בית שמש":             {"id": 5410, "lat": 31.7528, "lon": 34.9876, "name_en": "Beit Shemesh"},
    "נתניה":               {"id": 2800, "lat": 32.3215, "lon": 34.8532, "name_en": "Netanya"},
    "ראשון לציון משה דיין": {"id": 8600, "lat": 31.9816, "lon": 34.7896, "name_en": "Rishon LeZion Moshe Dayan"},
}

STATION_BY_ID = {v["id"]: {**v, "name_he": k} for k, v in STATIONS.items()}

RAIL_URL = "https://www.rail.co.il/apiinfo/api/Train/GetRoutes"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.rail.co.il/",
    "Origin": "https://www.rail.co.il",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
    "sec-ch-ua-platform": '"Windows"',
}


async def get_routes_async(origin_id: int, dest_id: int) -> dict | None:
    """Fetch routes from Israel Railways API (async version of user's get_trains)."""
    now = datetime.now(IL_TZ)  # Israel Railways API uses Israel local time
    params = {
        "OId": origin_id,
        "TId": dest_id,
        "Date": now.strftime("%Y-%m-%d"),
        "Hour": now.strftime("%H%M"),
        "Seats": 1,
        "SchOnly": "false",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(RAIL_URL, params=params, headers=HEADERS)
            resp.raise_for_status()
            return resp.json()
    except Exception:
        return None


def parse_routes(data: dict, origin_id: int, dest_id: int) -> list[dict]:
    """
    Parse Israel Railways API response.
    Mirrors the user's parse_delays() logic but returns structured dicts.
    """
    if not data:
        return []

    routes = data.get("Data", {}).get("Routes", [])
    if not routes:
        return []

    origin_info = STATION_BY_ID.get(origin_id, {})
    dest_info = STATION_BY_ID.get(dest_id, {})
    results = []

    for i, route in enumerate(routes):
        trains_in_route = route.get("Train", [])
        if not trains_in_route:
            continue

        first = trains_in_route[0]
        last = trains_in_route[-1]

        depart_delay = int(first.get("DepartureDelay", 0) or 0)
        arrive_delay = int(last.get("ArrivalDelay", 0) or 0)

        if depart_delay == 0:
            status = "on_time"
        elif depart_delay <= 5:
            status = "slight_delay"
        else:
            status = "delayed"

        results.append({
            "route_index": i + 1,
            "origin_id": origin_id,
            "origin_name": origin_info.get("name_en", str(origin_id)),
            "origin_name_he": origin_info.get("name_he", ""),
            "origin_lat": origin_info.get("lat"),
            "origin_lon": origin_info.get("lon"),
            "dest_id": dest_id,
            "dest_name": dest_info.get("name_en", str(dest_id)),
            "dest_name_he": dest_info.get("name_he", ""),
            "dest_lat": dest_info.get("lat"),
            "dest_lon": dest_info.get("lon"),
            "departure_time": first.get("DepartureTime", ""),
            "arrival_time": last.get("ArrivalTime", ""),
            "departure_delay_min": depart_delay,
            "arrival_delay_min": arrive_delay,
            "platform": first.get("Platform", "?"),
            "status": status,
            "changes": len(trains_in_route) - 1,
            "train_number": first.get("Trainno", ""),
        })

    return results
