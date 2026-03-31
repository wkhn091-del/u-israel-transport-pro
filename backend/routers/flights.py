"""
Flights router — OpenSky Network API.
Uses credentials from credentials.json if it contains opensky_user/opensky_pass fields,
otherwise anonymous (lower rate limit but free).
"""
from fastapi import APIRouter, Query
import httpx
import json
import time
from pathlib import Path

router = APIRouter()

OPENSKY_BASE = "https://opensky-network.org/api"

# Israel bounding box (slightly expanded)
IL_LAMIN = 29.3
IL_LOMIN = 34.1
IL_LAMAX = 33.5
IL_LOMAX = 36.1


def _get_opensky_auth() -> tuple[str, str] | None:
    """Read optional OpenSky credentials from credentials.json."""
    try:
        creds_path = Path(__file__).parent.parent / "credentials.json"
        creds = json.loads(creds_path.read_text(encoding="utf-8"))
        user = creds.get("opensky_user") or creds.get("openskyUser")
        pw = creds.get("opensky_pass") or creds.get("openskyPass")
        if user and pw:
            return (user, pw)
    except Exception:
        pass
    return None


@router.get("/live")
async def get_live_flights(
    lamin: float = Query(default=IL_LAMIN),
    lomin: float = Query(default=IL_LOMIN),
    lamax: float = Query(default=IL_LAMAX),
    lomax: float = Query(default=IL_LOMAX),
):
    """
    Live flights over Israel from OpenSky Network.
    No API key required for anonymous access.
    """
    auth = _get_opensky_auth()
    request_kwargs: dict = {
        "params": {"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax},
        "timeout": 15.0,
    }
    if auth:
        request_kwargs["auth"] = auth

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{OPENSKY_BASE}/states/all", **request_kwargs)
            resp.raise_for_status()
            data = resp.json()

        flights = []
        for state in (data.get("states") or []):
            lon, lat = state[5], state[6]
            if lon is None or lat is None:
                continue
            callsign = (state[1] or "").strip()
            flights.append({
                "id": state[0],
                "icao24": state[0],
                "callsign": callsign,
                "origin_country": state[2],
                "lon": lon,
                "lat": lat,
                "altitude_m": state[7],
                "on_ground": state[8],
                "velocity_ms": state[9],
                "heading": state[10],
                "vertical_rate": state[11],
                "type": "flight",
            })

        return {
            "flights": flights,
            "count": len(flights),
            "authenticated": auth is not None,
            "timestamp": int(time.time()),
        }

    except Exception as e:
        return {"flights": [], "count": 0, "error": str(e), "timestamp": int(time.time())}
