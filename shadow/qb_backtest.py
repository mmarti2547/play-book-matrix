"""Shadow test: does adding QB form / trend / season-fade features improve the engine?

Walk-forward backtest (train on all earlier seasons, test on one season) for the CURRENT engine
and for the engine + QB features, on the same games. Nothing here touches live picks.
Run from the repo root:  python -m shadow.qb_backtest
"""
import json
import sys
import numpy as np
import pandas as pd

from pbm import data as D, features as F, model as MD

FIRST_SEASON = 2014
TEST_SEASONS = range(2018, 2026)

QB_FEATURES = ["d_qb_epa", "d_qb_int", "d_qb_sack", "d_qb_att", "d_qb_cpoe", "d_qb_int_trend", "d_qb_exp", "d_qb_fade"]


def qb_game_stats(pbp: pd.DataFrame) -> pd.DataFrame:
    p = pbp[(pbp.season_type == "REG") | (pbp.season_type == "POST")]
    db = p[(p.qb_dropback == 1) & p.passer_player_id.notna()].copy()
    g = db.groupby(["season", "week", "game_id", "posteam", "passer_player_id"]).agg(
        dropbacks=("qb_dropback", "sum"), att=("pass_attempt", "sum"), ints=("interception", "sum"),
        sacks=("sack", "sum"), epa=("epa", "mean"), cpoe=("cpoe", "mean")).reset_index()
    return g.rename(columns={"posteam": "team", "passer_player_id": "qb_id"})


def qb_form(qg: pd.DataFrame) -> pd.DataFrame:
    """Per QB, per game: form ENTERING that game (only earlier games used)."""
    qg = qg[qg.dropbacks >= 10].sort_values(["qb_id", "season", "week"]).copy()
    qg["int_rate"] = qg.ints / qg.dropbacks
    qg["sack_rate"] = qg.sacks / qg.dropbacks
    out = []
    for qb, d in qg.groupby("qb_id", sort=False):
        d = d.copy()
        e = lambda s, hl: s.ewm(halflife=hl, min_periods=1).mean().shift(1)
        d["qb_epa"] = e(d.epa, 4)
        d["qb_int"] = e(d.int_rate, 4)
        d["qb_sack"] = e(d.sack_rate, 4)
        d["qb_att"] = e(d.att, 4)
        d["qb_cpoe"] = e(d.cpoe.fillna(0), 4)
        last3 = d.int_rate.rolling(3, min_periods=2).mean().shift(1)
        base = d.int_rate.rolling(16, min_periods=6).mean().shift(1)
        d["qb_int_trend"] = (last3 - base)
        d["qb_exp"] = np.log1p(np.arange(len(d)))
        # season fade: from PRIOR seasons only, late-season (wk 10+) minus early-season EPA/dropback
        fades = {}
        for s in sorted(d.season.unique()):
            prev = d[d.season < s]
            per = prev.groupby("season").apply(
                lambda x: x[x.week >= 10].epa.mean() - x[x.week <= 9].epa.mean(), include_groups=False).dropna()
            fades[s] = float(per.mean()) if len(per) >= 2 else 0.0
        d["qb_fade"] = d.season.map(fades) * np.clip((d.week - 9) / 9, 0, 1)
        out.append(d[["season", "week", "game_id", "team", "qb_id", "qb_epa", "qb_int", "qb_sack", "qb_att",
                      "qb_cpoe", "qb_int_trend", "qb_exp", "qb_fade"]])
    return pd.concat(out, ignore_index=True)


def qb_matrix(sched: pd.DataFrame, form: pd.DataFrame) -> pd.DataFrame:
    """Attach the STARTING QB's entering form to each game (schedule's home_qb_id / away_qb_id)."""
    cols = ["qb_epa", "qb_int", "qb_sack", "qb_att", "qb_cpoe", "qb_int_trend", "qb_exp", "qb_fade"]
    # a QB's entering form for a game = his row for that game if he played it, else his latest row before it
    f = form.sort_values(["qb_id", "season", "week"])
    rows = []
    for side in ["home", "away"]:
        s = sched[["game_id", "season", "week", f"{side}_qb_id"]].rename(columns={f"{side}_qb_id": "qb_id"})
        m = s.merge(f.drop(columns=["team"]), on=["game_id", "qb_id"], how="left", suffixes=("", "_f"))
        miss = m[cols[0]].isna() & m.qb_id.notna()
        if miss.any():   # did not drop back 10 times that game (or game not played yet): his latest EARLIER form (no peeking ahead)
            fk = f.assign(k=f.season * 100 + f.week)[["qb_id", "k"] + cols].sort_values("k")
            mm = m.loc[miss, ["game_id", "qb_id", "season", "week"]].assign(k=lambda x: x.season * 100 + x.week).sort_values("k")
            got = pd.merge_asof(mm, fk, on="k", by="qb_id", allow_exact_matches=False).set_index("game_id")
            for c in cols:
                m.loc[miss, c] = m.loc[miss, "game_id"].map(got[c])
        m = m[["game_id"] + cols].rename(columns={c: f"{side}_{c}" for c in cols})
        rows.append(m)
    q = rows[0].merge(rows[1], on="game_id")
    league = {c: form[c].median() for c in cols}
    for side in ["home", "away"]:   # rookies / unknown starters -> league median, zero experience
        for c in cols:
            q[f"{side}_{c}"] = q[f"{side}_{c}"].fillna(0.0 if c in ("qb_exp", "qb_fade", "qb_int_trend") else league[c])
    for c in cols:
        q[f"d_{c}"] = q[f"home_{c}"] - q[f"away_{c}"]
    return q[["game_id"] + QB_FEATURES]


def run_backtest(mat, feats, weights, mono):
    MD.FEATURES, MD.FEATURE_WEIGHTS, MD.MONOTONE = feats, weights, mono
    return MD.backtest(mat, TEST_SEASONS)


def ats_table(detail: pd.DataFrame) -> dict:
    d = detail.dropna(subset=["spread_line"]).copy()
    d = d[d.result != d.spread_line]
    out = {}
    for thr in (0.52, 0.55, 0.58, 0.60):
        ph, pa = d.home_cover_prob >= thr, d.home_cover_prob <= 1 - thr
        won = np.where(ph, d.result > d.spread_line, d.result < d.spread_line)
        sel = (ph | pa).values
        n = int(sel.sum())
        w = int(won[sel].sum()) if n else 0
        out[f">={int(thr*100)}%"] = {"bets": n, "win_rate": round(w / n, 4) if n else None,
                                     "roi_at_-110": round((w * (100 / 110) - (n - w)) / n, 4) if n else None}
    return out


def main():
    cur = 2026
    seasons = list(range(FIRST_SEASON - 1, cur + 1))
    D.PBP_COLS = D.PBP_COLS + ["passer_player_id", "sack", "cpoe"]
    sched = D.load_schedules(seasons)
    pbp = D.load_pbp(seasons)
    inj, snaps, ids = D.load_injuries(seasons), D.load_snaps(seasons), D.load_player_ids()
    tg = F.team_game_stats(pbp)
    form = F.build_team_form(sched, tg)
    clusters = F.injury_clusters(inj, F.starters_by_team_week(snaps, sched, ids), sched)
    ctx = F.game_context(sched, pbp)
    mat = F.build_matrix(ctx, form, clusters)
    mat = mat[mat.season >= FIRST_SEASON]

    qf = qb_form(qb_game_stats(pbp))
    q = qb_matrix(sched, qf)
    mat2 = mat.merge(q, on="game_id", how="left")
    for c in QB_FEATURES:
        mat2[c] = mat2[c].fillna(0.0)

    base_f, base_w, base_m = list(F.FEATURES), dict(F.FEATURE_WEIGHTS), dict(F.MONOTONE)
    b = run_backtest(mat2, base_f, base_w, base_m)
    new_f = base_f + QB_FEATURES
    new_w = {**base_w, **{c: 1.0 for c in QB_FEATURES}}
    new_m = {**base_m, **{c: 0 for c in QB_FEATURES}}
    n = run_backtest(mat2, new_f, new_w, new_m)

    imp = MD.importance(MD.fit(mat2[mat2.home_win.notna()])[0])
    res = {
        "baseline": {**{k: v for k, v in b["summary"].items() if k != "ev_roi_by_season"}, "ats": ats_table(b["detail"])},
        "with_qb": {**{k: v for k, v in n["summary"].items() if k != "ev_roi_by_season"}, "ats": ats_table(n["detail"])},
        "qb_feature_importance": {k: v for k, v in imp.items() if k in QB_FEATURES},
        "by_season_margin_mae": {
            "baseline": b["detail"].assign(e=lambda x: (x.result - x.model_margin).abs()).groupby("season").e.mean().round(3).to_dict(),
            "with_qb": n["detail"].assign(e=lambda x: (x.result - x.model_margin).abs()).groupby("season").e.mean().round(3).to_dict(),
        },
    }
    b["detail"].to_parquet("shadow/bt_baseline.parquet"); n["detail"].to_parquet("shadow/bt_with_qb.parquet")
    json.dump(res, open("shadow/qb_backtest_result.json", "w"), indent=2, default=str)
    print(json.dumps(res, indent=2, default=str))


if __name__ == "__main__":
    sys.exit(main())
