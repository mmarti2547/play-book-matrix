import pandas as pd, numpy as np, gzip, re

frames = []
for y in range(2016, 2026):
    d = pd.read_csv(f"ps{y}.csv", low_memory=False)
    d = d.rename(columns={"recent_team": "team"})
    d = d[d["season_type"] == "REG"]
    frames.append(d[["player_id", "player_display_name", "position", "team", "season", "week",
                     "receptions", "receiving_yards", "rushing_yards", "passing_yards", "attempts", "targets", "carries"]])
df = pd.concat(frames, ignore_index=True)
df = df[df["position"].isin(["QB", "RB", "WR", "TE"])]

g = pd.read_csv("games.csv")
g = g[g.game_type == "REG"]
g["month"] = pd.to_datetime(g.gameday).dt.month
wk = g.groupby(["season", "week"]).month.agg(lambda s: s.mode().iloc[0]).reset_index()
df = df.merge(wk, on=["season", "week"], how="left")
mname = {9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec", 1: "Jan"}
df["mon"] = df.month.map(mname)

STATS = {"QB": ["passing_yards", "rushing_yards"], "RB": ["rushing_yards", "receptions", "receiving_yards"],
         "WR": ["receptions", "receiving_yards"], "TE": ["receptions", "receiving_yards"]}
MIN_MEAN = {"passing_yards": 150, "rushing_yards": 20, "receptions": 2, "receiving_yards": 25}

df = df.sort_values(["player_id", "season", "week"])
rows = []
for pos, stats in STATS.items():
    p = df[df.position == pos].copy()
    for s in stats:
        x = p[["player_id", "season", "week", "mon", s]].dropna().copy()
        grp = x.groupby(["player_id", "season"])[s]
        x["prior_mean"] = grp.transform(lambda v: v.shift(1).expanding().mean())
        x["n_prior"] = grp.cumcount()
        x = x[(x.n_prior >= 3) & (x.prior_mean >= MIN_MEAN[s])]
        x["ratio"] = x[s] / x.prior_mean
        x["over"] = (x[s] > x.prior_mean).astype(int)
        x["pos"], x["stat"] = pos, s
        rows.append(x[["pos", "stat", "season", "week", "mon", "ratio", "over", "player_id"]])
R = pd.concat(rows)

print("=== MONTH: game result vs player's own season-to-date average (ratio 1.00 = same) ===")
t = R.groupby(["pos", "stat", "mon"]).agg(n=("ratio", "size"), ratio=("ratio", "mean"), over_pct=("over", "mean")).reset_index()
t["over_pct"] = (t.over_pct * 100).round(1); t["ratio"] = t.ratio.round(3)
order = {"Sep": 0, "Oct": 1, "Nov": 2, "Dec": 3, "Jan": 4}
t["o"] = t.mon.map(order); t = t.sort_values(["pos", "stat", "o"]).drop(columns="o")
print(t.to_string(index=False))

print("\n=== ALL POSITIONS by month ===")
a = R.groupby("mon").agg(n=("ratio", "size"), ratio=("ratio", "mean"), over_pct=("over", "mean")).reset_index()
a["o"] = a.mon.map(order); print(a.sort_values("o").drop(columns="o").round(3).to_string(index=False))

# per-season consistency of the Dec/Jan effect
print("\n=== Dec+Jan vs Sep+Oct ratio, per season (all stats) ===")
R["half"] = np.where(R.mon.isin(["Dec", "Jan"]), "late", np.where(R.mon.isin(["Sep", "Oct"]), "early", "mid"))
print(R.groupby(["season", "half"]).ratio.mean().unstack().round(3).to_string())

# ---- contract year ----
with gzip.open("contracts.csv.gz", "rt") as f:
    c = pd.read_csv(f, low_memory=False)
c = c[c.position.isin(["QB", "RB", "WR", "TE"])].dropna(subset=["year_signed", "years"])
c["end"] = c.year_signed + c.years - 1
norm = lambda s: re.sub(r"[^a-z]", "", str(s).lower().replace(" jr", "").replace(" iii", "").replace(" ii", ""))
c["key"] = c.player.map(norm)
season_tot = df.groupby(["player_id", "player_display_name", "position", "season"]).agg(
    games=("week", "size"), rec=("receptions", "mean"), rec_yds=("receiving_yards", "mean"),
    rush_yds=("rushing_yards", "mean"), pass_yds=("passing_yards", "mean")).reset_index()
season_tot = season_tot[season_tot.games >= 6]
season_tot["key"] = season_tot.player_display_name.map(norm)
def status(r):
    cc = c[(c.key == r.key) & (c.year_signed <= r.season) & (c.end >= r.season)]
    if cc.empty: return "unknown"
    cc = cc.sort_values("year_signed").iloc[-1]
    return "contract_year" if cc.end == r.season else "signed_beyond"
keys = set(c.key)
season_tot = season_tot[season_tot.key.isin(keys)]
season_tot["status"] = season_tot.apply(status, axis=1)
season_tot = season_tot.sort_values(["player_id", "season"])
main = {"QB": "pass_yds", "RB": "rush_yds", "WR": "rec_yds", "TE": "rec_yds"}
season_tot["main"] = season_tot.apply(lambda r: r[main[r.position]], axis=1)
season_tot["prev_main"] = season_tot.groupby("player_id").main.shift(1)
season_tot["prev_season"] = season_tot.groupby("player_id").season.shift(1)
s2 = season_tot[(season_tot.prev_season == season_tot.season - 1) & (season_tot.prev_main > 10)].copy()
s2["chg"] = s2.main / s2.prev_main
print("\n=== CONTRACT YEAR: per-game main stat vs player's previous season (1.00 = same) ===")
print(s2.groupby(["position", "status"]).chg.agg(["size", "mean", "median"]).round(3).to_string())
print(s2.groupby("status").chg.agg(["size", "mean", "median"]).round(3).to_string())
season_tot.to_csv("season_status.csv", index=False)
R.to_csv("game_ratios.csv", index=False)
