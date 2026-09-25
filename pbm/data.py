"""Data loading from the nflverse ecosystem (nflreadpy = successor to nfl_data_py)."""
import re
import numpy as np
import pandas as pd
import nflreadpy as nfl

PBP_COLS = [
    "game_id", "season", "week", "season_type", "home_team", "away_team", "posteam", "defteam",
    "play_type", "pass", "rush", "epa", "success", "air_yards", "pass_attempt", "qb_dropback",
    "fumble", "fumble_lost", "interception", "weather", "total_home_score", "total_away_score",
]


def load_schedules(seasons):
    s = nfl.load_schedules(seasons).to_pandas()
    s = s[s.game_type.isin(["REG", "WC", "DIV", "CON", "SB"])].copy()
    s["kickoff_et"] = pd.to_datetime(s.gameday + " " + s.gametime.fillna("13:00"), errors="coerce")
    s["kickoff_utc"] = s.kickoff_et.dt.tz_localize("America/New_York", ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
    return s


def load_pbp(seasons):
    """Load play-by-play one season at a time and keep only needed columns (memory-safe)."""
    frames = []
    for yr in seasons:
        try:
            p = nfl.load_pbp([yr]).to_pandas()
        except Exception as e:  # season not published yet
            print(f"pbp {yr} unavailable: {e}")
            continue
        frames.append(p[[c for c in PBP_COLS if c in p.columns]])
    return pd.concat(frames, ignore_index=True)


def load_injuries(seasons):
    out = []
    for yr in seasons:
        try:
            out.append(nfl.load_injuries([yr]).to_pandas())
        except Exception as e:
            print(f"injuries {yr} unavailable: {e}")
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def load_snaps(seasons):
    out = []
    for yr in seasons:
        try:
            out.append(nfl.load_snap_counts([yr]).to_pandas())
        except Exception as e:
            print(f"snaps {yr} unavailable: {e}")
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def load_player_ids():
    p = nfl.load_players().to_pandas()
    return p[["gsis_id", "pfr_id"]].dropna().drop_duplicates("gsis_id")


_num = re.compile(r"(-?\d+)")


def parse_weather_text(txt):
    """nflfastR weather strings look like 'Rain Temp: 45° F, Humidity: 80%, Wind: NW 14 mph'."""
    if not isinstance(txt, str):
        return np.nan, np.nan, 0
    hum = re.search(r"Humidity:\s*(\d+)", txt)
    t = txt.lower()
    precip = int(any(w in t for w in ["rain", "snow", "shower", "sleet", "drizzle", "storm", "flurr"]))
    return (float(hum.group(1)) if hum else np.nan), None, precip
