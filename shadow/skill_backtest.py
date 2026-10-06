"""Shadow test 2: QB features + skill-position / scoring features. Same walk-forward backtest, same games.
Run from the repo root:  python -m shadow.skill_backtest
"""
import json
import numpy as np
import pandas as pd

from pbm import data as D, features as F
from shadow import qb_backtest as Q

SKILL_FEATURES = ["d_rb1_epa", "d_rb1_ypc", "d_wr_epa_tgt", "d_tgt_share_top", "d_explosive", "d_rz_td", "d_td_drive"]


def skill_game_stats(pbp: pd.DataFrame) -> pd.DataFrame:
    p = pbp[pbp.season_type.isin(["REG", "POST"]) & pbp.posteam.notna()].copy()
    p["explosive"] = ((p.rush == 1) & (p.yards_gained >= 12)) | ((p["pass"] == 1) & (p.yards_gained >= 20))
    plays = p[(p.rush == 1) | (p["pass"] == 1)]
    team = plays.groupby(["season", "week", "game_id", "posteam"]).agg(
        explosive=("explosive", "mean"), drives=("drive", "nunique")).reset_index()
    rz = p[(p.yardline_100 <= 20)].groupby(["game_id", "posteam"]).agg(rz_drives=("drive", "nunique")).reset_index()
    tds = p[(p.touchdown == 1) & (p.td_team == p.posteam)].groupby(["game_id", "posteam"]).agg(
        tds=("touchdown", "sum")).reset_index()
    rztd = p[(p.yardline_100 <= 20) & (p.touchdown == 1) & (p.td_team == p.posteam)].groupby(["game_id", "posteam"]).agg(
        rz_tds=("drive", "nunique")).reset_index()
    team = team.merge(rz, how="left").merge(tds, how="left").merge(rztd, how="left").fillna({"rz_drives": 0, "tds": 0, "rz_tds": 0})
    team["rz_td"] = np.where(team.rz_drives > 0, team.rz_tds / team.rz_drives, np.nan)
    team["td_drive"] = team.tds / team.drives.clip(lower=1)
    # top running back of that game (most carries) and receivers' efficiency per target
    ru = p[(p.rush == 1) & p.rusher_player_id.notna()].groupby(["game_id", "posteam", "rusher_player_id"]).agg(
        car=("rush", "sum"), epa=("epa", "sum"), yds=("yards_gained", "sum")).reset_index()
    ru = ru.sort_values("car", ascending=False).drop_duplicates(["game_id", "posteam"])
    ru = ru.assign(rb1_epa=ru.epa / ru.car, rb1_ypc=ru.yds / ru.car)[["game_id", "posteam", "rb1_epa", "rb1_ypc"]]
    tg = p[(p["pass"] == 1) & p.receiver_player_id.notna()].groupby(["game_id", "posteam", "receiver_player_id"]).agg(
        tgt=("pass", "sum"), epa=("epa", "sum")).reset_index()
    tg["share"] = tg.tgt / tg.groupby(["game_id", "posteam"]).tgt.transform("sum")
    top3 = tg.sort_values("tgt", ascending=False).groupby(["game_id", "posteam"]).head(3)
    wr = top3.groupby(["game_id", "posteam"]).agg(epa=("epa", "sum"), tgt=("tgt", "sum"), tgt_share_top=("share", "max")).reset_index()
    wr["wr_epa_tgt"] = wr.epa / wr.tgt.clip(lower=1)
    out = team.merge(ru, how="left").merge(wr[["game_id", "posteam", "wr_epa_tgt", "tgt_share_top"]], how="left")
    return out.rename(columns={"posteam": "team"})


def skill_form(g: pd.DataFrame) -> pd.DataFrame:
    cols = ["rb1_epa", "rb1_ypc", "wr_epa_tgt", "tgt_share_top", "explosive", "rz_td", "td_drive"]
    g = g.sort_values(["team", "season", "week"]).copy()
    for c in cols:   # entering form: exponentially weighted over earlier games, 6-game half-life like the team stats
        g[c] = g.groupby("team")[c].transform(lambda s: s.ewm(halflife=6, min_periods=1).mean().shift(1))
    return g[["game_id", "team"] + cols]


def skill_matrix(sched: pd.DataFrame, form: pd.DataFrame) -> pd.DataFrame:
    h = sched[["game_id", "home_team"]].merge(form, left_on=["game_id", "home_team"], right_on=["game_id", "team"], how="left")
    a = sched[["game_id", "away_team"]].merge(form, left_on=["game_id", "away_team"], right_on=["game_id", "team"], how="left")
    q = sched[["game_id"]].copy()
    for c in ["rb1_epa", "rb1_ypc", "wr_epa_tgt", "tgt_share_top", "explosive", "rz_td", "td_drive"]:
        q[f"d_{c}"] = (h[c] - a[c]).values
    return q.fillna(0.0)


def main():
    seasons = list(range(Q.FIRST_SEASON - 1, 2027))
    D.PBP_COLS = D.PBP_COLS + ["passer_player_id", "sack", "cpoe", "rusher_player_id", "receiver_player_id",
                               "yards_gained", "yardline_100", "touchdown", "td_team", "drive"]
    sched = D.load_schedules(seasons)
    pbp = D.load_pbp(seasons)
    inj, snaps, ids = D.load_injuries(seasons), D.load_snaps(seasons), D.load_player_ids()
    form = F.build_team_form(sched, F.team_game_stats(pbp))
    clusters = F.injury_clusters(inj, F.starters_by_team_week(snaps, sched, ids), sched)
    mat = F.build_matrix(F.game_context(sched, pbp), form, clusters)
    mat = mat[mat.season >= Q.FIRST_SEASON]
    mat = mat.merge(Q.qb_matrix(sched, Q.qb_form(Q.qb_game_stats(pbp))), on="game_id", how="left")
    mat = mat.merge(skill_matrix(sched, skill_form(skill_game_stats(pbp))), on="game_id", how="left")
    for c in Q.QB_FEATURES + SKILL_FEATURES:
        mat[c] = mat[c].fillna(0.0)

    bf, bw, bm = list(F.FEATURES), dict(F.FEATURE_WEIGHTS), dict(F.MONOTONE)
    runs = {}
    for name, extra in [("current", []), ("with_qb", Q.QB_FEATURES), ("with_skill_only", SKILL_FEATURES),
                        ("with_qb_and_skill", Q.QB_FEATURES + SKILL_FEATURES)]:
        r = Q.run_backtest(mat, bf + extra, {**bw, **{c: 1.0 for c in extra}}, {**bm, **{c: 0 for c in extra}})
        d = r["detail"]
        mae = d.assign(e=(d.result - d.model_margin).abs()).groupby("season").e.mean()
        runs[name] = {"winner_accuracy": round(r["summary"]["model_accuracy"], 4),
                      "logloss": round(r["summary"]["model_logloss"], 4),
                      "margin_mae": round(r["summary"]["margin_mae"], 3),
                      "mae_by_season": mae.round(3).to_dict(), "ats": Q.ats_table(d)}
        d.to_parquet(f"shadow/bt_{name}.parquet")
    base = runs["current"]["mae_by_season"]
    for k, v in runs.items():
        v["seasons_better_than_current"] = int(sum(v["mae_by_season"][s] < base[s] for s in base)) if k != "current" else None
    json.dump(runs, open("shadow/skill_backtest_result.json", "w"), indent=2, default=str)
    print(json.dumps(runs, indent=2, default=str))


if __name__ == "__main__":
    main()
