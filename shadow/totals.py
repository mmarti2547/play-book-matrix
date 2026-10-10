"""Totals Engine (over/under) - a SEPARATE, test-only model. Never bet; never touches live tables.

Predicts the combined score of each game and compares it to the Vegas total. Built the same way as the
live pick engine (pre-game rolling team form, injuries, weather, walk-forward learning from past seasons),
plus over/under-specific factors and historical trends:
  - scoring form: points for / against, offense vs defense efficiency matchups, red-zone touchdown rate
  - pace: plays per game, pass rate
  - weather: wind, cold, rain/snow, dome
  - injuries: starters out on offense (QB, line, skill) and defense
  - historical trends: each team's over rate and average total vs the line, the referee's over rate,
    divisional games, prime time, late season

    python -m shadow.totals --backtest   # walk-forward test on past seasons -> shadow/totals_backtest_result.json
    python -m shadow.totals              # predictions for upcoming games -> shadow_totals / shadow_totals_log
"""
import argparse
import json
import os
import warnings
import numpy as np
import pandas as pd
from scipy.stats import norm
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from pbm import data as D, features as F, weather as W, publish as P

warnings.filterwarnings("ignore")
FIRST_SEASON = 2014
TEST_SEASONS = range(2018, 2026)
VERSION = "totals-1"
HL = 6
SIGMA = 13.2   # spread of actual totals around the prediction (measured in the backtest)


# ---------------------------------------------------------------- per team-game stats
def red_zone(pbp: pd.DataFrame) -> pd.DataFrame:
    p = pbp[pbp.posteam.notna() & pbp.drive.notna()]
    rz = p[p.yardline_100 <= 20].groupby(["game_id", "posteam", "drive"]).size().rename("rz").reset_index()
    td = p[(p.touchdown == 1) & (p.td_team == p.posteam)].groupby(["game_id", "posteam", "drive"]).size().rename("td").reset_index()
    rz = rz.merge(td, on=["game_id", "posteam", "drive"], how="left")
    rz["td"] = (rz.td.fillna(0) > 0).astype(int)
    out = rz.groupby(["game_id", "posteam"]).agg(rz_trips=("rz", "size"), rz_tds=("td", "sum")).reset_index()
    return out.rename(columns={"posteam": "team"})


def team_form(sched: pd.DataFrame, pbp: pd.DataFrame) -> pd.DataFrame:
    tg = F.team_game_stats(pbp).merge(red_zone(pbp), on=["game_id", "team"], how="left")
    rows = []
    for side, opp in [("home", "away"), ("away", "home")]:
        r = sched[["game_id", "season", "week", "kickoff_utc", "total_line", f"{side}_team", f"{side}_score", f"{opp}_score"]].copy()
        r.columns = ["game_id", "season", "week", "kickoff_utc", "total_line", "team", "pf", "pa"]
        rows.append(r)
    t = pd.concat(rows).merge(tg, on=["game_id", "team"], how="left").sort_values(["team", "kickoff_utc"]).reset_index(drop=True)
    t["tot"] = t.pf + t.pa
    t["resid"] = t.tot - t.total_line
    t["over"] = np.where(t.resid > 0, 1.0, np.where(t.resid < 0, 0.0, np.nan))
    t.loc[t.pf.isna(), ["resid", "over"]] = np.nan
    t["rz_rate"] = t.rz_tds / t.rz_trips.replace(0, np.nan)

    def per(d):
        d = d.copy()
        ew = lambda c, hl=HL: d[c].ewm(halflife=hl, ignore_na=True).mean().shift(1)
        for c in ["pf", "pa", "off_epa", "def_epa", "off_sr", "def_sr", "off_pass_epa", "def_pass_epa",
                  "off_plays", "def_plays", "pass_rate", "rz_rate", "resid"]:
            d[f"t_{c}"] = ew(c)
        d["t_over16"] = d.over.rolling(16, min_periods=4).mean().shift(1)
        return d
    t = pd.concat([per(d) for _, d in t.groupby("team")], ignore_index=True)
    return t[["game_id", "team"] + [c for c in t.columns if c.startswith("t_")]]


def referee_trend(sched: pd.DataFrame) -> pd.DataFrame:
    """Referee over rate and average total vs the line, from EARLIER games only, shrunk toward neutral."""
    s = sched[["game_id", "kickoff_utc", "referee", "home_score", "away_score", "total_line"]].sort_values("kickoff_utc").copy()
    s["resid"] = s.home_score + s.away_score - s.total_line
    s["over"] = np.where(s.resid > 0, 1.0, np.where(s.resid < 0, 0.0, np.nan))
    out = []
    for ref, d in s.groupby("referee", dropna=False):
        d = d.copy()
        n = d.over.notna().astype(int).cumsum().shift(1).fillna(0)
        o = d.over.fillna(0).cumsum().shift(1).fillna(0)
        r = d.resid.fillna(0).cumsum().shift(1).fillna(0)
        k = 20.0
        d["ref_over"] = (o + 0.5 * k) / (n + k) - 0.5
        d["ref_resid"] = r / (n + k)
        if pd.isna(ref):
            d[["ref_over", "ref_resid"]] = 0.0
        out.append(d[["game_id", "ref_over", "ref_resid"]])
    return pd.concat(out)


ALL_FEATURES = [
    "total_line",
    # scoring form and matchups (home offense vs away defense, and the reverse)
    "sum_pf", "sum_pa", "m_epa_h", "m_epa_a", "m_sr_h", "m_sr_a", "m_pass_h", "m_pass_a", "sum_rz",
    # pace
    "sum_plays", "sum_pass_rate",
    # weather
    "indoor", "wind_mph", "temp_f", "precip", "turf",
    # injuries to starters
    "inj_qb", "inj_off", "inj_def",
    # historical trends
    "sum_team_resid", "sum_team_over", "ref_over", "ref_resid", "div_game", "primetime", "late_season",
]
# Tested 2026-10-10: a tree model on ALL_FEATURES chased noise (worse than Vegas). A heavily regularized linear
# model on these core factors was the most stable across seasons, so that is the engine.
FEATURES = ["total_line", "m_epa_h", "m_epa_a", "sum_plays", "wind_mph", "precip", "indoor", "temp_f",
            "inj_qb", "inj_off", "inj_def", "ref_over", "sum_team_resid", "div_game", "primetime", "late_season"]


def build(sched, pbp, ctx, clusters) -> pd.DataFrame:
    tf = team_form(sched, pbp)
    h = tf.add_prefix("h_").rename(columns={"h_game_id": "game_id", "h_team": "home_team"})
    a = tf.add_prefix("a_").rename(columns={"a_game_id": "game_id", "a_team": "away_team"})
    m = ctx.merge(h, on=["game_id", "home_team"], how="left").merge(a, on=["game_id", "away_team"], how="left")
    m = m.merge(referee_trend(sched), on="game_id", how="left")
    m["sum_pf"] = m.h_t_pf + m.a_t_pf
    m["sum_pa"] = m.h_t_pa + m.a_t_pa
    m["m_epa_h"] = m.h_t_off_epa + m.a_t_def_epa
    m["m_epa_a"] = m.a_t_off_epa + m.h_t_def_epa
    m["m_sr_h"] = m.h_t_off_sr + m.a_t_def_sr
    m["m_sr_a"] = m.a_t_off_sr + m.h_t_def_sr
    m["m_pass_h"] = m.h_t_off_pass_epa + m.a_t_def_pass_epa
    m["m_pass_a"] = m.a_t_off_pass_epa + m.h_t_def_pass_epa
    m["sum_rz"] = m.h_t_rz_rate + m.a_t_rz_rate
    m["sum_plays"] = m.h_t_off_plays + m.a_t_off_plays
    m["sum_pass_rate"] = m.h_t_pass_rate + m.a_t_pass_rate
    m["sum_team_resid"] = m.h_t_resid + m.a_t_resid
    m["sum_team_over"] = m.h_t_over16 + m.a_t_over16
    m["turf"] = (~m.surface.fillna("grass").str.contains("grass")).astype(int)
    m["primetime"] = (m.kickoff_et.dt.hour >= 19).astype(int)
    m["late_season"] = (m.week >= 13).astype(int)

    ij = clusters.copy() if not clusters.empty else pd.DataFrame(columns=["game_id", "team"])
    keep = [c for c in ij.columns if c.startswith("f_inj_")]
    g = ij.groupby("game_id")[keep].sum() if len(ij) else pd.DataFrame(columns=keep)
    m = m.merge(g, left_on="game_id", right_index=True, how="left")
    for c in ["f_inj_qb", "f_inj_ol", "f_inj_skill", "f_inj_front", "f_inj_db"]:
        if c not in m:
            m[c] = 0.0
        m[c] = m[c].fillna(0.0)
    m["inj_qb"] = m.f_inj_qb
    m["inj_off"] = m.f_inj_ol + m.f_inj_skill
    m["inj_def"] = m.f_inj_front + m.f_inj_db
    m["div_game"] = m.div_game.fillna(0).astype(int)
    m["actual_total"] = m.home_score + m.away_score
    m["resid"] = m.actual_total - m.total_line
    return m


def fit(train):
    tr = train.dropna(subset=["resid", "total_line"])
    reg = make_pipeline(SimpleImputer(), StandardScaler(), RidgeCV(alphas=[10, 100, 1000, 5000]))
    reg.fit(tr[FEATURES].astype(float), tr.resid.astype(float))
    return reg


def predict(reg, df, sigma=SIGMA):
    out = df[["game_id", "total_line"]].copy()
    out["pred_resid"] = reg.predict(df[FEATURES].astype(float))
    out["pred_total"] = out.total_line + out.pred_resid
    out["over_prob"] = norm.cdf(out.pred_resid / sigma)
    return out


def grade(p):
    """Totals grades, set from the backtest: the model's edges are small, so the scale is tighter than the side picks."""
    q = max(p, 1 - p)
    return "A" if q >= 0.53 else "B" if q >= 0.52 else "PASS"


def backtest(mat):
    rows = []
    for s in TEST_SEASONS:
        tr = mat[(mat.season < s) & (mat.season >= FIRST_SEASON)]
        te = mat[(mat.season == s) & mat.resid.notna() & mat.total_line.notna()]
        if not len(te):
            continue
        reg = fit(tr)
        rows.append(predict(reg, te).merge(te[["game_id", "season", "week", "resid", "actual_total"]], on="game_id"))
    bt = pd.concat(rows, ignore_index=True)
    sigma = float(np.std(bt.resid - bt.pred_resid))
    bt["over_prob"] = norm.cdf(bt.pred_resid / sigma)
    d = bt[bt.resid != 0].copy()
    d["pick_over"] = d.over_prob >= 0.5
    d["won"] = np.where(d.pick_over, d.resid > 0, d.resid < 0)
    d["grade"] = d.over_prob.apply(grade)

    def rec(x):
        n = len(x); w = int(x.won.sum())
        return {"bets": n, "win_rate": round(w / n, 4) if n else None,
                "roi_at_-110": round((w * (100 / 110) - (n - w)) / n, 4) if n else None}
    res = {
        "games": int(len(bt)), "sigma": round(sigma, 2),
        "model_mae": round(float(np.mean(np.abs(bt.actual_total - bt.pred_total))), 3),
        "vegas_mae": round(float(np.mean(np.abs(bt.resid))), 3),
        "all_games": rec(d),
        "by_grade": {g: rec(d[d.grade == g]) for g in ["A", "B", "PASS"]},
        "a_and_b": rec(d[d.grade.isin(["A", "B"])]),
        "by_season_A_and_B": {int(s): rec(x[x.grade.isin(["A", "B"])]) for s, x in d.groupby("season")},
        "overs_vs_unders_A_and_B": {"over": rec(d[d.grade.isin(["A", "B"]) & d.pick_over]),
                                    "under": rec(d[d.grade.isin(["A", "B"]) & ~d.pick_over])},
    }
    return res, bt


def load(seasons):
    D.PBP_COLS = D.PBP_COLS + ["yardline_100", "touchdown", "td_team", "drive"]
    sched = D.load_schedules(seasons)
    pbp = D.load_pbp(seasons)
    inj, snaps, ids = D.load_injuries(seasons), D.load_snaps(seasons), D.load_player_ids()
    clusters = F.injury_clusters(inj, F.starters_by_team_week(snaps, sched, ids), sched)
    ctx = F.game_context(sched, pbp)
    return sched, pbp, ctx, clusters


def current_season():
    today = pd.Timestamp.now(tz="America/New_York")
    return today.year if today.month >= 8 else today.year - 1


def main(run_backtest=False):
    cur = current_season()
    sched, pbp, ctx, clusters = load(list(range(FIRST_SEASON - 1, cur + 1)))
    now = pd.Timestamp.now(tz="UTC")
    upcoming = ctx[(ctx.result.isna()) & (ctx.kickoff_utc > now - pd.Timedelta(hours=4)) &
                   (ctx.kickoff_utc < now + pd.Timedelta(days=10))]
    if not run_backtest and not os.environ.get("PBM_SKIP_WEATHER"):
        wx = W.fetch_game_weather(upcoming)
        if len(wx):   # same live weather the live engine uses
            live = wx[~wx.indoor].set_index("game_id")
            for col in ["temp_f", "wind_mph", "humidity", "precip"]:
                if col in live:
                    vals = ctx.game_id.map(live[col])
                    ctx[col] = np.where(vals.notna(), vals, ctx[col])
    mat = build(sched, pbp, ctx, clusters)
    mat = mat[mat.season >= FIRST_SEASON]

    if run_backtest:
        res, bt = backtest(mat)
        reg = fit(mat[mat.resid.notna()])
        res["points_per_1sd"] = {f: round(float(c), 3) for f, c in sorted(zip(FEATURES, reg[-1].coef_), key=lambda t: -abs(t[1]))}
        json.dump(res, open("shadow/totals_backtest_result.json", "w"), indent=2)
        bt.to_parquet("shadow/bt_totals.parquet")
        print(json.dumps(res, indent=2))
        return

    tgt = mat[mat.game_id.isin(upcoming.game_id) & mat.total_line.notna()]
    if not len(tgt):
        print("totals: no upcoming games"); return
    reg = fit(mat[mat.resid.notna()])
    p = predict(reg, tgt)
    recs = []
    for r in p.to_dict("records"):
        side = "OVER" if r["over_prob"] >= 0.5 else "UNDER"
        recs.append({"game_id": r["game_id"], "model_version": VERSION, "total_line": float(r["total_line"]),
                     "pred_total": round(float(r["pred_total"]), 2), "over_prob": round(float(r["over_prob"]), 4),
                     "pick": side, "pick_prob": round(float(max(r["over_prob"], 1 - r["over_prob"])), 4),
                     "grade": grade(r["over_prob"]), "updated_at": now})
    P.upsert("shadow_totals", recs, "game_id")
    P.insert("shadow_totals_log", recs)
    print(pd.DataFrame(recs).drop(columns=["updated_at"]).to_string())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true")
    main(ap.parse_args().backtest)
