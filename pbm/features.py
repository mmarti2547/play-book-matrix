"""Feature engineering: EPA/success rate, Pythagorean luck, home/away splits,
cluster injuries, fatigue proxies, travel, and weather interactions."""
import numpy as np
import pandas as pd

from .config import STADIUMS, TEAM_HOME, UNIT_OF_POSITION, STATUS_WEIGHT, PYTHAG_EXP
from .data import parse_weather_text

HALFLIFE = 6  # games; exponential decay for rolling team form
UNITS = ["qb", "ol", "skill", "front", "db"]


# ---------------------------------------------------------------- team-game efficiency
def team_game_stats(pbp: pd.DataFrame) -> pd.DataFrame:
    plays = pbp[(pbp.epa.notna()) & ((pbp["pass"] == 1) | (pbp["rush"] == 1)) & pbp.posteam.notna()].copy()
    plays["is_pass"] = (plays["pass"] == 1).astype(int)
    plays["pass_epa"] = np.where(plays.is_pass == 1, plays.epa, np.nan)
    plays["rush_epa"] = np.where(plays.is_pass == 0, plays.epa, np.nan)
    plays["ay"] = np.where(plays.pass_attempt == 1, plays.air_yards, np.nan)

    off = plays.groupby(["game_id", "posteam"]).agg(
        off_epa=("epa", "mean"), off_sr=("success", "mean"), off_pass_epa=("pass_epa", "mean"),
        off_rush_epa=("rush_epa", "mean"), adot=("ay", "mean"), off_plays=("epa", "size"),
        pass_rate=("is_pass", "mean"),
    ).reset_index().rename(columns={"posteam": "team"})
    dfn = plays.groupby(["game_id", "defteam"]).agg(
        def_epa=("epa", "mean"), def_sr=("success", "mean"), def_pass_epa=("pass_epa", "mean"),
        def_rush_epa=("rush_epa", "mean"), def_plays=("epa", "size"),
    ).reset_index().rename(columns={"defteam": "team"})

    # fumble luck: share of own fumbles recovered (true talent ~50%)
    fum = pbp[pbp.fumble == 1].groupby(["game_id", "posteam"]).agg(
        fumbles=("fumble", "sum"), fumbles_lost=("fumble_lost", "sum")).reset_index().rename(columns={"posteam": "team"})
    ints = pbp[pbp.interception == 1].groupby(["game_id", "posteam"]).size().rename("ints").reset_index().rename(columns={"posteam": "team"})

    g = off.merge(dfn, on=["game_id", "team"], how="outer").merge(fum, on=["game_id", "team"], how="left").merge(ints, on=["game_id", "team"], how="left")
    return g.fillna({"fumbles": 0, "fumbles_lost": 0, "ints": 0})


def build_team_form(sched: pd.DataFrame, tg: pd.DataFrame) -> pd.DataFrame:
    """One row per (game_id, team) holding PRE-GAME rolling form (shifted, no leakage)."""
    rows = []
    for side, opp in [("home", "away"), ("away", "home")]:
        r = sched[["game_id", "season", "week", "kickoff_utc", f"{side}_team", f"{side}_score", f"{opp}_score"]].copy()
        r.columns = ["game_id", "season", "week", "kickoff_utc", "team", "pf", "pa"]
        r["is_home"] = int(side == "home")
        rows.append(r)
    tf = pd.concat(rows).merge(tg, on=["game_id", "team"], how="left")
    tf = tf.sort_values(["team", "kickoff_utc"]).reset_index(drop=True)
    tf["played"] = tf.pf.notna()
    tf["win"] = np.where(tf.pf > tf.pa, 1.0, np.where(tf.pf < tf.pa, 0.0, 0.5))
    tf.loc[~tf.played, "win"] = np.nan
    tf["margin_epa"] = tf.off_epa - tf.def_epa
    tf["fum_rec_rate"] = np.where(tf.fumbles > 0, (tf.fumbles - tf.fumbles_lost) / tf.fumbles.replace(0, np.nan), np.nan)

    ewm_cols = ["off_epa", "off_sr", "off_pass_epa", "off_rush_epa", "def_epa", "def_sr",
                "def_pass_epa", "def_rush_epa", "adot", "pass_rate", "margin_epa", "fum_rec_rate"]

    def per_team(d):
        d = d.copy()
        for c in ewm_cols:
            d[f"f_{c}"] = d[c].ewm(halflife=HALFLIFE, ignore_na=True).mean().shift(1)
        # Pythagorean expectation over trailing 17 games
        pf17 = d.pf.rolling(17, min_periods=4).sum().shift(1)
        pa17 = d.pa.rolling(17, min_periods=4).sum().shift(1)
        d["f_pythag"] = pf17 ** PYTHAG_EXP / (pf17 ** PYTHAG_EXP + pa17 ** PYTHAG_EXP)
        d["f_winpct17"] = d.win.rolling(17, min_periods=4).mean().shift(1)
        d["f_luck"] = d.f_winpct17 - d.f_pythag
        # fatigue proxy: snaps (plays) played + defended over the last 3 games
        d["f_load3"] = (d.off_plays.fillna(0) + d.def_plays.fillna(0)).rolling(3, min_periods=1).sum().shift(1)
        # home / road split of EPA margin, relative to overall
        for flag, name in [(1, "home"), (0, "road")]:
            m = d.margin_epa.where(d.is_home == flag)
            d[f"f_{name}_split"] = m.ewm(halflife=HALFLIFE * 1.5, ignore_na=True).mean().shift(1)
            d[f"f_{name}_split"] = d[f"f_{name}_split"].ffill()
        return d

    tf = pd.concat([per_team(d) for _, d in tf.groupby("team")], ignore_index=True)
    tf["f_home_boost"] = tf.f_home_split - tf.f_margin_epa
    tf["f_road_boost"] = tf.f_road_split - tf.f_margin_epa
    keep = ["game_id", "team"] + [c for c in tf.columns if c.startswith("f_")]
    return tf[keep]


# ---------------------------------------------------------------- cluster injuries
def starters_by_team_week(snaps: pd.DataFrame, sched: pd.DataFrame, ids: pd.DataFrame) -> pd.DataFrame:
    """A 'starter' for (team, season, week) = played >= 60% of offensive or defensive
    snaps on average in the games he appeared in among that team's previous 4 games."""
    s = snaps.copy()
    s["pct"] = s[["offense_pct", "defense_pct"]].max(axis=1)
    order = sched[["game_id", "kickoff_utc"]]
    s = s.merge(order, on="game_id", how="left")
    team_games = s[["team", "game_id", "kickoff_utc", "season", "week"]].drop_duplicates().sort_values(["team", "kickoff_utc"])
    team_games["gidx"] = team_games.groupby("team").cumcount()
    s = s.merge(team_games[["team", "game_id", "gidx"]], on=["team", "game_id"])

    # next game each team plays (including unplayed scheduled games)
    out = []
    upcoming = pd.concat([
        sched[["game_id", "season", "week", "kickoff_utc", "home_team"]].rename(columns={"home_team": "team"}),
        sched[["game_id", "season", "week", "kickoff_utc", "away_team"]].rename(columns={"away_team": "team"}),
    ])
    for team, grp in upcoming.groupby("team"):
        tg = team_games[team_games.team == team]
        ts = s[s.team == team]
        for _, g in grp.iterrows():
            prior = tg[tg.kickoff_utc < g.kickoff_utc].tail(4)
            if prior.empty:
                continue
            w = ts[ts.game_id.isin(prior.game_id)]
            agg = w.groupby(["pfr_player_id", "position"]).pct.mean().reset_index()
            st = agg[agg.pct >= 0.6]
            for _, p in st.iterrows():
                out.append((g.game_id, team, p.pfr_player_id, p.position))
    st = pd.DataFrame(out, columns=["game_id", "team", "pfr_id", "snap_pos"])
    return st.merge(ids, on="pfr_id", how="left")


def injury_clusters(inj: pd.DataFrame, starters: pd.DataFrame, sched: pd.DataFrame) -> pd.DataFrame:
    """Probability-weighted absences of STARTERS per unit; cluster score = load^1.5 so that
    three secondary starters out hurts far more than three single absences across units."""
    if inj.empty:
        return pd.DataFrame(columns=["game_id", "team"])
    i = inj[inj.game_type.isin(["REG", "WC", "DIV", "CON", "SB"]) | inj.game_type.isna()].copy()
    i["w"] = i.report_status.map(STATUS_WEIGHT)
    i["unit"] = i.position.map(UNIT_OF_POSITION)
    gm = pd.concat([
        sched[["game_id", "season", "week", "home_team", "result"]].rename(columns={"home_team": "team"}),
        sched[["game_id", "season", "week", "away_team", "result"]].rename(columns={"away_team": "team"}),
    ])
    i = i.merge(gm, on=["season", "week", "team"], how="inner")
    # Before the final (Friday) report is out, unplayed games use practice participation as a provisional signal
    prov = i.practice_status.map({"Did Not Participate In Practice": 0.45,
                                  "Limited Participation in Practice": 0.1}).fillna(0.0)
    i["w"] = np.where(i.w.isna() & i.result.isna(), prov, i.w.fillna(0.0))
    i = i[i.w > 0]
    i = i.merge(starters[["game_id", "team", "gsis_id"]].assign(starter=1), on=["game_id", "team", "gsis_id"], how="left")
    i["starter"] = i.starter.fillna(0)
    # depth players count 20% of a starter
    i["load"] = i.w * np.where(i.starter == 1, 1.0, 0.2)
    piv = i.pivot_table(index=["game_id", "team"], columns="unit", values="load", aggfunc="sum").reindex(columns=UNITS).fillna(0)
    res = pd.DataFrame(index=piv.index)
    res["f_inj_qb"] = piv["qb"].clip(upper=1.0)
    for u in ["ol", "skill", "front", "db"]:
        res[f"f_inj_{u}"] = piv[u] ** 1.5
    res["f_inj_total"] = res[[f"f_inj_{u}" for u in ["ol", "skill", "front", "db"]]].sum(axis=1) + 3 * res.f_inj_qb
    si = i[i.starter == 1]
    detail = pd.Series(
        {k: [{"player": r.full_name, "pos": r.position,
          "status": r.report_status if isinstance(r.report_status, str) else
          ("Practice: DNP" if r.practice_status == "Did Not Participate In Practice" else "Practice: Limited")}
         for r in d.itertuples()]
         for k, d in si.groupby(["game_id", "team"])}, name="starters_out", dtype=object)
    if len(detail):
        detail.index = pd.MultiIndex.from_tuples(detail.index, names=["game_id", "team"])
    return res.join(detail).reset_index()


# ---------------------------------------------------------------- travel + weather
def haversine_miles(a, b):
    if a not in STADIUMS or b not in STADIUMS:
        return np.nan
    _, la1, lo1, _ = STADIUMS[a]
    _, la2, lo2, _ = STADIUMS[b]
    la1, lo1, la2, lo2 = map(np.radians, [la1, lo1, la2, lo2])
    h = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * np.arcsin(np.sqrt(h))


def game_context(sched: pd.DataFrame, pbp: pd.DataFrame) -> pd.DataFrame:
    g = sched.copy()
    roof_type = g.stadium_id.map(lambda x: STADIUMS.get(x, (None, None, None, "open"))[3])
    g["indoor"] = ((g.roof.isin(["dome", "closed"])) |
                   (g.roof.isna() & roof_type.isin(["dome", "retractable", "canopy"]))).astype(int)
    # humidity / precip from nflfastR weather strings (historical); live values overwrite later
    wx = pbp.groupby("game_id").weather.first()
    parsed = wx.apply(parse_weather_text)
    g["humidity"] = g.game_id.map(parsed.map(lambda t: t[0]))
    g["precip"] = g.game_id.map(parsed.map(lambda t: t[2])).fillna(0)
    g["temp_f"] = g.temp
    g["wind_mph"] = g.wind
    g.loc[g.indoor == 1, ["temp_f", "wind_mph", "humidity", "precip"]] = [70, 0, 45, 0]
    g["away_travel_mi"] = [haversine_miles(TEAM_HOME.get(t, ""), s) for t, s in zip(g.away_team, g.stadium_id)]
    g["home_travel_mi"] = [haversine_miles(TEAM_HOME.get(t, ""), s) for t, s in zip(g.home_team, g.stadium_id)]
    g["home_travel_mi"] = g.home_travel_mi.fillna(0)
    g["rest_diff"] = g.home_rest - g.away_rest
    g["neutral"] = (g.location == "Neutral").astype(int)
    return g


# ---------------------------------------------------------------- assemble model matrix
FEATURES = [
    # efficiency (home - away differentials)
    "d_off_epa", "d_def_epa", "d_off_sr", "d_def_sr", "d_off_pass_epa", "d_def_pass_epa",
    "d_off_rush_epa", "d_def_rush_epa", "d_margin_epa",
    # luck regression
    "d_pythag", "d_luck", "d_fum_rec_rate",
    # home/away splits
    "home_home_boost", "away_road_boost", "neutral",
    # injuries (cluster)
    "home_inj_qb", "away_inj_qb", "home_inj_ol", "away_inj_ol", "home_inj_db", "away_inj_db",
    "home_inj_front", "away_inj_front", "home_inj_skill", "away_inj_skill", "d_inj_total",
    # fatigue / schedule
    "d_load3", "rest_diff", "away_travel_mi", "div_game",
    # weather
    "indoor", "wind_mph", "temp_f", "humidity", "precip", "wind_x_adot_home", "wind_x_adot_away",
]

# Explicit weighting (used by XGBoost column sampling): higher = sampled more often
FEATURE_WEIGHTS = {f: 1.0 for f in FEATURES}
FEATURE_WEIGHTS.update({
    "d_margin_epa": 2.0, "d_off_epa": 1.5, "d_def_epa": 1.5, "d_off_sr": 1.5, "d_def_sr": 1.5,
    "home_inj_qb": 2.0, "away_inj_qb": 2.0, "d_inj_total": 1.5, "home_inj_db": 1.3, "away_inj_db": 1.3,
    "home_inj_ol": 1.3, "away_inj_ol": 1.3,
    "wind_x_adot_home": 1.3, "wind_x_adot_away": 1.3, "wind_mph": 1.2,
    "home_home_boost": 1.2, "away_road_boost": 1.2, "d_luck": 1.2,
})

# Direction the home-win probability must move as the feature rises (+1 up, -1 down, 0 free)
MONOTONE = {f: 0 for f in FEATURES}
MONOTONE.update({
    "d_off_epa": 1, "d_off_sr": 1, "d_margin_epa": 1, "d_def_epa": -1, "d_def_sr": -1,
    "home_inj_qb": -1, "away_inj_qb": 1, "d_inj_total": -1, "rest_diff": 0,
})


def build_matrix(ctx: pd.DataFrame, form: pd.DataFrame, inj: pd.DataFrame) -> pd.DataFrame:
    h = form.add_prefix("h_").rename(columns={"h_game_id": "game_id", "h_team": "home_team"})
    a = form.add_prefix("a_").rename(columns={"a_game_id": "game_id", "a_team": "away_team"})
    m = ctx.merge(h, on=["game_id", "home_team"], how="left").merge(a, on=["game_id", "away_team"], how="left")
    for c in ["off_epa", "def_epa", "off_sr", "def_sr", "off_pass_epa", "def_pass_epa", "off_rush_epa",
              "def_rush_epa", "margin_epa", "pythag", "luck", "fum_rec_rate", "load3"]:
        m[f"d_{c}"] = m[f"h_f_{c}"] - m[f"a_f_{c}"]
    m["home_home_boost"] = np.where(m.neutral == 1, 0, m.h_f_home_boost)
    m["away_road_boost"] = m.a_f_road_boost
    m["wind_x_adot_home"] = m.wind_mph.fillna(0) * m.h_f_adot
    m["wind_x_adot_away"] = m.wind_mph.fillna(0) * m.a_f_adot

    ij = inj.copy() if not inj.empty else pd.DataFrame(columns=["game_id", "team"])
    for side in ["home", "away"]:
        x = ij.rename(columns={"team": f"{side}_team"})
        x = x.rename(columns={c: c.replace("f_inj_", f"{side}_inj_") for c in x.columns})
        x = x.rename(columns={"starters_out": f"{side}_starters_out"})
        m = m.merge(x, on=["game_id", f"{side}_team"], how="left")
    for side in ["home", "away"]:
        for u in UNITS + ["total"]:
            col = f"{side}_inj_{u}"
            if col not in m:
                m[col] = 0.0
            m[col] = m[col].fillna(0.0)
    m["d_inj_total"] = m.home_inj_total - m.away_inj_total
    m["home_win"] = np.where(m.result > 0, 1, np.where(m.result < 0, 0, np.nan))
    return m
