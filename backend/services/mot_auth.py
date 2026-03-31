"""
MOT (Ministry of Transport) OAuth2 token manager.
Reads credentials from credentials.json and tries known Israeli transport
auth endpoints. Logs every attempt so failures are visible via /api/buses/auth-status.
"""
import json
import time
import httpx
from pathlib import Path

CREDS_PATH = Path(__file__).parent.parent / "credentials.json"

# All known MOT / Israeli transport OAuth2 token endpoints.
# Each entry: (url, grant payload style)
#   "form"  → application/x-www-form-urlencoded  (standard OAuth2)
#   "json"  → application/json body
TOKEN_ENDPOINTS = [
    # Ministry of Transport direct API (requires registered client)
    ("https://api.mot.gov.il/oauth2/token",                "form"),
    ("https://api.mot.gov.il/v1/auth/token",               "json"),
    # MOT real-time SIRI gateway
    ("https://siri.motrealtime.co.il/oauth/token",         "form"),
    ("https://siri.motrealtime.co.il/Siri/auth/token",     "form"),
    # Hasadna Open Bus Stride (public — no token needed, included for completeness)
    ("https://open-bus-stride-api.hasadna.org.il/token",   "form"),
]

_cache: dict = {"token": None, "expires_at": 0.0}
_last_probe: list[dict] = []   # stores diagnostic results for /auth-status


def _load_creds() -> dict:
    try:
        return json.loads(CREDS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"error": f"credentials.json not found at {CREDS_PATH}"}
    except Exception as e:
        return {"error": str(e)}


async def get_token() -> str | None:
    """Return a valid access token, refreshing from the first responsive endpoint."""
    if _cache["token"] and time.time() < _cache["expires_at"] - 30:
        return _cache["token"]

    creds = _load_creds()
    if "error" in creds:
        return None

    client_id = creds.get("clientId", "")
    client_secret = creds.get("clientSecret", "")
    if not client_id or not client_secret:
        return None

    form_payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    json_payload = {
        "grantType": "client_credentials",
        "clientId": client_id,
        "clientSecret": client_secret,
    }

    _last_probe.clear()

    async with httpx.AsyncClient(timeout=8.0) as client:
        for url, style in TOKEN_ENDPOINTS:
            entry: dict = {"url": url, "style": style}
            try:
                if style == "json":
                    r = await client.post(url, json=json_payload)
                else:
                    r = await client.post(url, data=form_payload)

                entry["status"] = r.status_code
                entry["body_preview"] = r.text[:200]

                if r.status_code == 200:
                    try:
                        data = r.json()
                        token = data.get("access_token")
                        expires_in = int(data.get("expires_in", 3600))
                        if token:
                            _cache["token"] = token
                            _cache["expires_at"] = time.time() + expires_in
                            entry["result"] = "OK — token obtained"
                            _last_probe.append(entry)
                            return token
                        else:
                            entry["result"] = "200 but no access_token in response"
                    except Exception as parse_err:
                        entry["result"] = f"200 but JSON parse failed: {parse_err}"
                else:
                    entry["result"] = f"HTTP {r.status_code}"

            except httpx.ConnectError as e:
                entry["status"] = None
                entry["result"] = f"DNS/connect error: {e}"
            except httpx.ConnectTimeout:
                entry["status"] = None
                entry["result"] = "Connection timed out"
            except Exception as e:
                entry["status"] = None
                entry["result"] = f"{type(e).__name__}: {e}"

            _last_probe.append(entry)

    return None  # all endpoints failed


def get_last_probe() -> dict:
    """Return the diagnostic results from the last token fetch attempt."""
    creds = _load_creds()
    return {
        "credentials_file": str(CREDS_PATH),
        "credentials_found": "error" not in creds,
        "client_id": creds.get("clientId", "—"),
        "token_cached": _cache["token"] is not None,
        "token_expires_at": _cache["expires_at"] if _cache["token"] else None,
        "probes": _last_probe,
        "summary": (
            "Token cached (still valid)" if _cache["token"] and time.time() < _cache["expires_at"] - 30
            else "No valid token — all endpoints failed or not yet probed"
        ),
    }
