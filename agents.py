"""Dispatch the Claude agents (news + expert picks) and refresh the game-day sheets.

Runs after run.py in GitHub Actions:
  - news agent: every game kicking off in the next 36 hours whose intel is older than 6 hours
  - expert agent: each active expert once per ~20 hours, Wednesday through Monday, for the current week
  - snapshot_slate for today and tomorrow (sheets freeze automatically at the slate's first kickoff)
"""
import os
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
import requests

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def get(path):
    r = requests.get(f"{URL}/rest/v1/{path}", headers=H, timeout=60)
    r.raise_for_status()
    return r.json()


def invoke(fn, body):
    try:
        r = requests.post(f"{URL}/functions/v1/{fn}", headers=H, json=body, timeout=400)
        j = r.json()
        print(fn, body, "->", "ok" if j.get("ok") else j.get("error", "")[:300])
    except Exception as e:
        print(fn, body, "failed:", e)


def main():
    now = pd.Timestamp.now(tz="UTC")
    et = now.tz_convert("America/New_York")

    games = pd.DataFrame(get("games?select=game_id,season,week,kickoff_utc,home_score&home_score=is.null&order=kickoff_utc"))
    if games.empty:
        return
    games["kickoff_utc"] = pd.to_datetime(games.kickoff_utc, utc=True)
    intel = pd.DataFrame(get("news_intel?select=game_id,scanned_at"))
    last = dict(zip(intel.game_id, pd.to_datetime(intel.scanned_at, utc=True))) if len(intel) else {}

    soon = games[(games.kickoff_utc > now) & (games.kickoff_utc < now + pd.Timedelta(hours=36))]
    stale = [g for g in soon.game_id if g not in last or now - last[g] > pd.Timedelta(hours=6)]
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(lambda g: invoke("pbm-news-agent", {"game_id": g}), stale))

    # expert picks: current week = week of the next unplayed game
    nxt = games[games.kickoff_utc > now].iloc[0] if (games.kickoff_utc > now).any() else None
    if nxt is not None and et.dayofweek in (0, 2, 3, 4, 5, 6):  # Mon, Wed-Sun
        season, week = int(nxt.season), int(nxt.week)
        experts = get("experts?select=id,name&active=is.true")
        scans = {s["expert_id"]: pd.Timestamp(s["scanned_at"]) for s in
                 get(f"expert_scans?select=expert_id,scanned_at&season=eq.{season}&week=eq.{week}")}
        due = [e["id"] for e in experts if e["id"] not in scans or now - scans[e["id"]] > pd.Timedelta(hours=20)]
        with ThreadPoolExecutor(max_workers=5) as ex:
            list(ex.map(lambda i: invoke("pbm-expert-agent", {"expert_id": i, "season": season, "week": week}), due))

    for d in [et.date(), (et + pd.Timedelta(days=1)).date()]:
        requests.post(f"{URL}/rest/v1/rpc/snapshot_slate", headers=H, json={"d": str(d)}, timeout=60)
    print("sheets refreshed")


if __name__ == "__main__":
    main()
