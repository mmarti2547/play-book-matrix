"""Jamie's Pick - each player's normal game, from his recent history (feeds the live agent pbm-jamie).

Writes jamie_baselines: expected receptions, receiving yards, rushing yards, passing yards and
rushing + receiving yards for every active player, weighted toward recent games. Test only; never bets.

    python -m jamie.baselines
"""
import re
import numpy as np
import pandas as pd
import nflreadpy as nfl

from pbm import publish as P

HL = 6
STATS = {"rec": "receptions", "rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards"}


def norm_name(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", str(s).lower().replace("-", " "))
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


def current_season():
    t = pd.Timestamp.now(tz="America/New_York")
    return t.year if t.month >= 8 else t.year - 1


def main():
    cur = current_season()
    ps = nfl.load_player_stats([cur - 1, cur]).to_pandas()
    ps = ps[ps.season_type.isin(["REG", "POST"])].sort_values(["player_id", "season", "week"]).copy()
    ps["rr_yds"] = ps.rushing_yards.fillna(0) + ps.receiving_yards.fillna(0)
    cols = list(STATS.values()) + ["rr_yds"]
    ps[cols] = ps[cols].fillna(0)
    rows = []
    for pid, d in ps.groupby("player_id"):
        last = d.iloc[-1]
        if last.season < cur - 1 or len(d) < 3:
            continue
        e = {c: float(d[c].ewm(halflife=HL).mean().iloc[-1]) for c in cols}
        if e["rr_yds"] + e["passing_yards"] + e["receptions"] < 1:   # no offensive role
            continue
        this = d[d.season == cur]
        rows.append({
            "player_key": f"{last.team}|{norm_name(last.player_display_name)}", "player_id": pid,
            "player_name": last.player_display_name, "team": last.team, "position": last.position,
            "pre_rec": round(e["receptions"], 2), "pre_rec_yds": round(e["receiving_yards"], 1),
            "pre_rush_yds": round(e["rushing_yards"], 1), "pre_pass_yds": round(e["passing_yards"], 1),
            "pre_rr_yds": round(e["rr_yds"], 1), "games": int(len(d)), "games_this_season": int(len(this)),
            "last_week": int(last.week), "last_season": int(last.season), "updated_at": pd.Timestamp.now(tz="UTC"),
        })
    P.upsert("jamie_baselines", rows, "player_key")
    print(f"jamie_baselines: {len(rows)} players")


if __name__ == "__main__":
    main()
