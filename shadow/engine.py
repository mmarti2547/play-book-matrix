"""Shadow engine ("QB+ engine"): the current engine's features PLUS quarterback form and skill-player / scoring form.

It never touches the live engine or its tables. It writes only to shadow_predictions / shadow_predictions_log,
which feed the shadow grade (shadow_bet_sheet) shown next to the live grade for comparison. Nothing here is bet.

    python -m shadow.engine
"""
import os
import warnings
import numpy as np
import pandas as pd

from pbm import data as D, features as F, model as MD, weather as W, publish as P
from shadow import qb_backtest as Q, skill_backtest as S

warnings.filterwarnings("ignore")
FIRST_SEASON = 2014
BLEND_ALPHA = 0.30
SHADOW_VERSION = "qbplus-1"
EXTRA = Q.QB_FEATURES + S.SKILL_FEATURES


def current_season():
    today = pd.Timestamp.now(tz="America/New_York")
    return today.year if today.month >= 8 else today.year - 1


def main():
    cur = current_season()
    seasons = list(range(FIRST_SEASON - 1, cur + 1))
    D.PBP_COLS = D.PBP_COLS + ["passer_player_id", "sack", "cpoe", "rusher_player_id", "receiver_player_id",
                               "yards_gained", "yardline_100", "touchdown", "td_team", "drive"]
    sched = D.load_schedules(seasons)
    pbp = D.load_pbp(seasons)
    inj, snaps, ids = D.load_injuries(seasons), D.load_snaps(seasons), D.load_player_ids()

    form = F.build_team_form(sched, F.team_game_stats(pbp))
    clusters = F.injury_clusters(inj, F.starters_by_team_week(snaps, sched, ids), sched)
    ctx = F.game_context(sched, pbp)

    now = pd.Timestamp.now(tz="UTC")
    upcoming = ctx[(ctx.result.isna()) & (ctx.kickoff_utc > now - pd.Timedelta(hours=4)) &
                   (ctx.kickoff_utc < now + pd.Timedelta(days=10))]
    wx = W.fetch_game_weather(upcoming) if not os.environ.get("PBM_SKIP_WEATHER") else pd.DataFrame()
    if len(wx):   # same live weather the live engine uses
        live = wx[~wx.indoor].set_index("game_id")
        for col in ["temp_f", "wind_mph", "humidity", "precip"]:
            if col in live:
                vals = ctx.game_id.map(live[col])
                ctx[col] = np.where(vals.notna(), vals, ctx[col])

    mat = F.build_matrix(ctx, form, clusters)
    mat = mat.merge(Q.qb_matrix(sched, Q.qb_form(Q.qb_game_stats(pbp))), on="game_id", how="left")
    mat = mat.merge(S.skill_matrix(sched, S.skill_form(S.skill_game_stats(pbp))), on="game_id", how="left")
    for c in EXTRA:
        mat[c] = mat[c].fillna(0.0)

    MD.FEATURES = list(F.FEATURES) + EXTRA
    MD.FEATURE_WEIGHTS = {**F.FEATURE_WEIGHTS, **{c: 1.0 for c in EXTRA}}
    MD.MONOTONE = {**F.MONOTONE, **{c: 0 for c in EXTRA}}
    clf, reg = MD.fit(mat[(mat.season >= FIRST_SEASON) & mat.home_win.notna()])

    tgt = mat[mat.game_id.isin(upcoming.game_id)].copy()
    if not len(tgt):
        print("shadow: no upcoming games"); return
    preds = MD.predict(clf, reg, tgt).merge(
        tgt[["game_id", "season", "week", "spread_line", "home_moneyline", "away_moneyline", "indoor", "wind_mph", "precip",
             "home_starters_out", "away_starters_out", "home_inj_total", "away_inj_total"]], on="game_id")
    preds = MD.price(preds)
    preds["blend_home_prob"] = np.where(preds.market_home_prob.notna(),
                                        preds.market_home_prob + BLEND_ALPHA * (preds.model_home_prob - preds.market_home_prob),
                                        preds.model_home_prob)

    def q_count(lst):
        return sum(1 for p in lst if p.get("status") in ("Questionable", "Doubtful", "Practice: DNP", "Practice: Limited")) if isinstance(lst, list) else 0
    preds["questionable_starters"] = preds.home_starters_out.apply(q_count) + preds.away_starters_out.apply(q_count)
    preds["weather_severity"] = np.where(preds.indoor == 1, 0.0,
                                         np.clip((preds.wind_mph.fillna(0) - 10) / 15, 0, 1) * 0.6 + preds.precip.fillna(0) * 0.4)
    preds["early_season"] = (preds.week <= 3).astype(int)
    preds["model_market_gap"] = (preds.model_margin - preds.spread_line).abs()

    pcols = ["game_id", "model_home_prob", "blend_home_prob", "market_home_prob", "spread_home_prob", "model_margin",
             "home_cover_prob", "edge_home", "ev_home", "ev_away", "home_starters_out", "away_starters_out",
             "home_inj_total", "away_inj_total", "questionable_starters", "weather_severity", "early_season", "model_market_gap"]
    recs = []
    for r in preds[pcols].to_dict("records"):
        r.update({"model_version": SHADOW_VERSION, "updated_at": now, "categories": {}, "top_features": []})
        for k in ("home_starters_out", "away_starters_out"):
            r[k] = r[k] if isinstance(r[k], list) else []
        recs.append(r)
    P.upsert("shadow_predictions", recs, "game_id")
    P.insert("shadow_predictions_log", [{k: r[k] for k in ["game_id", "model_version", "model_home_prob", "blend_home_prob",
                                                          "market_home_prob", "model_margin", "home_cover_prob", "updated_at"]}
                                        for r in recs])
    print(preds[["game_id", "model_home_prob", "model_margin", "spread_line", "home_cover_prob"]].round(3).to_string())


if __name__ == "__main__":
    main()
