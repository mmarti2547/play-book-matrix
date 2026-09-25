"""Play Book Matrix engine.

    python run.py            # refresh data, live weather, injuries -> predictions for upcoming games
    python run.py --backtest # also run the walk-forward backtest and store a model_runs record
"""
import argparse
import os
import warnings
import numpy as np
import pandas as pd
import xgboost as xgb

from pbm import data as D, features as F, model as MD, weather as W, publish as P
from pbm.config import MODEL_VERSION

warnings.filterwarnings("ignore")

FIRST_SEASON = 2014
BLEND_ALPHA = 0.30  # weight on the model when blending with the no-vig market for moneyline EV

CATEGORY = {}
for f in F.FEATURES:
    if "inj" in f:
        CATEGORY[f] = "Injuries"
    elif f in ("d_pythag", "d_luck", "d_fum_rec_rate"):
        CATEGORY[f] = "Luck regression"
    elif f in ("home_home_boost", "away_road_boost", "neutral"):
        CATEGORY[f] = "Home/Away split"
    elif f in ("d_load3", "rest_diff", "away_travel_mi", "div_game"):
        CATEGORY[f] = "Fatigue & travel"
    elif f in ("indoor", "wind_mph", "temp_f", "humidity", "precip") or f.startswith("wind_x"):
        CATEGORY[f] = "Weather"
    else:
        CATEGORY[f] = "Efficiency (EPA/SR)"


def current_season():
    today = pd.Timestamp.now(tz="America/New_York")
    return today.year if today.month >= 8 else today.year - 1


def slate_of(ts_et):
    return ts_et.strftime("%a").upper()[:3] if pd.notna(ts_et) else None


def main(run_backtest=False):
    cur = current_season()
    seasons = list(range(FIRST_SEASON - 1, cur + 1))
    sched = D.load_schedules(seasons)
    pbp = D.load_pbp(seasons)
    inj = D.load_injuries(seasons)
    snaps = D.load_snaps(seasons)
    ids = D.load_player_ids()

    tg = F.team_game_stats(pbp)
    form = F.build_team_form(sched, tg)
    starters = F.starters_by_team_week(snaps, sched, ids)
    clusters = F.injury_clusters(inj, starters, sched)
    ctx = F.game_context(sched, pbp)

    # ---- live weather overrides for upcoming outdoor games
    now = pd.Timestamp.now(tz="UTC")
    upcoming = ctx[(ctx.result.isna()) & (ctx.kickoff_utc > now - pd.Timedelta(hours=4)) &
                   (ctx.kickoff_utc < now + pd.Timedelta(days=10))]
    wx = W.fetch_game_weather(upcoming) if not os.environ.get("PBM_SKIP_WEATHER") else pd.DataFrame()
    if len(wx):
        live = wx[~wx.indoor].set_index("game_id")
        for col in ["temp_f", "wind_mph", "humidity", "precip"]:
            if col in live:
                vals = ctx.game_id.map(live[col])
                ctx[col] = np.where(vals.notna(), vals, ctx[col])

    mat = F.build_matrix(ctx, form, clusters)
    train = mat[(mat.season >= FIRST_SEASON) & mat.home_win.notna()]
    clf, reg = MD.fit(train)

    tgt = mat[mat.game_id.isin(upcoming.game_id)].copy()
    preds = pd.DataFrame()
    if len(tgt):
        preds = MD.predict(clf, reg, tgt).merge(
            tgt[["game_id", "season", "week", "home_team", "away_team", "spread_line", "total_line",
                 "home_moneyline", "away_moneyline", "kickoff_utc", "kickoff_et", "indoor", "wind_mph",
                 "temp_f", "precip", "home_starters_out", "away_starters_out", "home_inj_total", "away_inj_total"]],
            on="game_id")
        preds = MD.price(preds)
        preds["blend_home_prob"] = np.where(preds.market_home_prob.notna(),
                                            preds.market_home_prob + BLEND_ALPHA * (preds.model_home_prob - preds.market_home_prob),
                                            preds.model_home_prob)

        # SHAP-style contributions (log-odds) grouped into factor categories
        dm = xgb.DMatrix(tgt[F.FEATURES].astype(float), feature_names=F.FEATURES)
        contrib = clf.get_booster().predict(dm, pred_contribs=True)[:, :-1]
        drivers = []
        for i, gid in enumerate(tgt.game_id):
            cats, top = {}, []
            for j, f in enumerate(F.FEATURES):
                cats[CATEGORY[f]] = cats.get(CATEGORY[f], 0.0) + float(contrib[i, j])
                top.append((f, float(contrib[i, j])))
            top = sorted(top, key=lambda t: -abs(t[1]))[:8]
            drivers.append({"game_id": gid,
                            "categories": {k: round(v, 4) for k, v in cats.items()},
                            "top_features": [{"feature": f, "logit": round(v, 4)} for f, v in top]})
        preds = preds.merge(pd.DataFrame(drivers), on="game_id")

        # risk components (combined with news volatility in the database view)
        def q_count(lst):
            return sum(1 for p in lst if p.get("status") in ("Questionable", "Doubtful", "Practice: DNP", "Practice: Limited")) if isinstance(lst, list) else 0
        preds["questionable_starters"] = preds.home_starters_out.apply(q_count) + preds.away_starters_out.apply(q_count)
        preds["weather_severity"] = np.where(preds.indoor == 1, 0.0,
                                             np.clip((preds.wind_mph.fillna(0) - 10) / 15, 0, 1) * 0.6 + preds.precip.fillna(0) * 0.4)
        preds["early_season"] = (preds.week <= 3).astype(int)
        preds["model_market_gap"] = (preds.model_margin - preds.spread_line).abs()

    # ---- publish
    games_cur = sched[sched.season == cur]
    P.upsert("games", [{
        "game_id": g.game_id, "season": g.season, "week": g.week, "game_type": g.game_type,
        "kickoff_utc": g.kickoff_utc, "slate": slate_of(g.kickoff_et), "game_date_et": g.kickoff_et.date() if pd.notna(g.kickoff_et) else None,
        "home_team": g.home_team, "away_team": g.away_team, "home_score": g.home_score, "away_score": g.away_score,
        "stadium": g.stadium, "stadium_id": g.stadium_id, "roof": g.roof, "surface": g.surface,
        "spread_line": g.spread_line, "total_line": g.total_line, "home_moneyline": g.home_moneyline,
        "away_moneyline": g.away_moneyline, "home_rest": g.home_rest, "away_rest": g.away_rest,
        "home_qb": g.home_qb_name, "away_qb": g.away_qb_name, "div_game": bool(g.div_game),
    } for g in games_cur.itertuples()], "game_id")

    # team ratings = pre-game form for each team's next unplayed game (or its last game if season over)
    RK = ["off_epa", "def_epa", "off_sr", "def_sr", "off_pass_epa", "def_pass_epa", "off_rush_epa", "def_rush_epa",
          "adot", "pythag", "winpct17", "luck", "margin_epa", "home_split", "road_split", "load3"]
    cm = mat[mat.season == cur].sort_values("kickoff_utc")
    team_rows = {}
    for r in cm.itertuples():
        for side, pre in [("home", "h_"), ("away", "a_")]:
            t = getattr(r, f"{side}_team")
            if team_rows.get(t, {}).get("_next"):
                continue
            team_rows[t] = {"season": cur, "team": t, "as_of_game": r.game_id, "_next": pd.isna(r.home_win),
                            **{k: getattr(r, f"{pre}f_{k}") for k in RK}}
    P.upsert("team_ratings", [{k: v for k, v in r.items() if k != "_next"} for r in team_rows.values()], "season,team")

    if len(wx):
        wx = wx.assign(fetched_at=now)
        cols = ["game_id", "source", "indoor", "roof_type", "temp_f", "wind_mph", "gust_mph", "wind_dir", "wind_dir_deg",
                "humidity", "precip_prob", "precip", "pressure_mb", "short_forecast", "hours_to_kickoff", "fetched_at"]
        P.upsert("weather", [{c: (r.get(c) if c in r else None) for c in cols} for r in wx.to_dict("records")], "game_id")

    if len(preds):
        pcols = ["game_id", "model_home_prob", "blend_home_prob", "market_home_prob", "spread_home_prob", "model_margin",
                 "home_cover_prob", "edge_home", "ev_home", "ev_away", "categories", "top_features",
                 "home_starters_out", "away_starters_out", "home_inj_total", "away_inj_total",
                 "questionable_starters", "weather_severity", "early_season", "model_market_gap"]
        recs = []
        for r in preds[pcols].to_dict("records"):
            r["model_version"] = MODEL_VERSION
            r["updated_at"] = now
            for k in ("home_starters_out", "away_starters_out"):
                r[k] = r[k] if isinstance(r[k], list) else []
            recs.append(r)
        P.upsert("predictions", recs, "game_id")
        P.insert("predictions_log", [{k: r[k] for k in ["game_id", "model_version", "model_home_prob", "blend_home_prob",
                                                       "market_home_prob", "model_margin", "home_cover_prob", "updated_at"]}
                                     for r in recs])
        print(preds[["game_id", "model_home_prob", "market_home_prob", "model_margin", "spread_line", "home_cover_prob"]].round(3).to_string())

    if run_backtest:
        bt = MD.backtest(mat[mat.season >= FIRST_SEASON], range(2018, cur + 1))
        P.insert("model_runs", [{"model_version": MODEL_VERSION, "created_at": now,
                                 "train_seasons": f"{FIRST_SEASON}-{cur}", "backtest": bt["summary"],
                                 "feature_importance": MD.importance(clf)}])
        print(bt["summary"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true")
    main(ap.parse_args().backtest)
