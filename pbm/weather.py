"""Live stadium weather: National Weather Service (US) + Open-Meteo (pressure, gusts, international)."""
import re
import time
import requests
import pandas as pd

from .config import STADIUMS

UA = {"User-Agent": "PlayBookMatrix/1.0 (github.com/mmarti2547)", "Accept": "application/geo+json"}


def _get(url, params=None, headers=None, tries=3):
    for k in range(tries):
        try:
            r = requests.get(url, params=params, headers=headers or UA, timeout=20)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
        time.sleep(1.5 * (k + 1))
    return None


def _mph(txt):
    nums = [int(n) for n in re.findall(r"\d+", txt or "")]
    return float(max(nums)) if nums else None


def nws(lat, lon, kickoff_utc):
    pts = _get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
    if not pts:
        return None
    props = pts["properties"]
    fc = _get(props["forecastHourly"])
    if not fc:
        return None
    best = None
    for p in fc["properties"]["periods"]:
        start = pd.Timestamp(p["startTime"]).tz_convert("UTC")
        if start <= kickoff_utc < start + pd.Timedelta(hours=1):
            best = p
            break
    if best is None:
        return None
    out = {
        "source": "NWS",
        "temp_f": float(best["temperature"]),
        "wind_mph": _mph(best.get("windSpeed")),
        "wind_dir": best.get("windDirection"),
        "humidity": (best.get("relativeHumidity") or {}).get("value"),
        "precip_prob": (best.get("probabilityOfPrecipitation") or {}).get("value"),
        "short_forecast": best.get("shortForecast"),
    }
    # current station pressure (only meaningful close to kickoff)
    if kickoff_utc - pd.Timestamp.now(tz="UTC") < pd.Timedelta(hours=4):
        st = _get(props["observationStations"])
        if st and st.get("features"):
            obs = _get(st["features"][0]["id"] + "/observations/latest")
            if obs:
                pa = (obs["properties"].get("barometricPressure") or {}).get("value")
                out["pressure_mb"] = round(pa / 100.0, 1) if pa else None
    return out


def open_meteo(lat, lon, kickoff_utc):
    j = _get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "timezone": "UTC", "forecast_days": 16,
        "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
        "hourly": "temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,"
                  "wind_direction_10m,wind_gusts_10m,surface_pressure,weather_code",
    }, headers={"User-Agent": UA["User-Agent"]})
    if not j:
        return None
    h = pd.DataFrame(j["hourly"])
    h["time"] = pd.to_datetime(h.time).dt.tz_localize("UTC")
    row = h[h.time == kickoff_utc.floor("h")]
    if row.empty:
        return None
    r = row.iloc[0]
    return {
        "source": "Open-Meteo", "temp_f": r.temperature_2m, "wind_mph": r.wind_speed_10m,
        "wind_dir_deg": r.wind_direction_10m, "gust_mph": r.wind_gusts_10m, "humidity": r.relative_humidity_2m,
        "precip_prob": r.precipitation_probability, "pressure_mb": r.surface_pressure, "weather_code": int(r.weather_code),
    }


RAINY = re.compile(r"rain|snow|shower|storm|sleet|drizzle|flurr", re.I)


def fetch_game_weather(games: pd.DataFrame) -> pd.DataFrame:
    """games: game_id, stadium_id, kickoff_utc, indoor. Only games within the 7-day forecast window."""
    rows = []
    now = pd.Timestamp.now(tz="UTC")
    for g in games.itertuples():
        if g.stadium_id not in STADIUMS or pd.isna(g.kickoff_utc):
            continue
        if not (now < g.kickoff_utc < now + pd.Timedelta(days=7)):
            continue
        name, lat, lon, roof = STADIUMS[g.stadium_id]
        rec = {"game_id": g.game_id, "indoor": bool(g.indoor), "stadium": name, "roof_type": roof,
               "hours_to_kickoff": round((g.kickoff_utc - now).total_seconds() / 3600, 1)}
        us = -125 < lon < -66 and 24 < lat < 50
        w = nws(lat, lon, g.kickoff_utc) if us else None
        om = open_meteo(lat, lon, g.kickoff_utc)
        if w is None and om is not None:
            w = om
        elif w is not None and om is not None:
            w.setdefault("pressure_mb", om.get("pressure_mb"))
            if w.get("pressure_mb") is None:
                w["pressure_mb"] = om.get("pressure_mb")
            w["gust_mph"] = om.get("gust_mph")
            w["wind_dir_deg"] = om.get("wind_dir_deg")
        if w:
            rec.update(w)
            txt = str(w.get("short_forecast") or "")
            rec["precip"] = int(bool(RAINY.search(txt)) or (w.get("precip_prob") or 0) >= 50)
        rows.append(rec)
    return pd.DataFrame(rows)
