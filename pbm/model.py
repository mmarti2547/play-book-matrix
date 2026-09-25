"""XGBoost models: home win classifier + margin regressor, walk-forward backtest vs Vegas."""
import numpy as np
import pandas as pd
from sklearn.metrics import log_loss, brier_score_loss, accuracy_score
from xgboost import XGBClassifier, XGBRegressor

from .features import FEATURES, FEATURE_WEIGHTS, MONOTONE
from . import market as M

CLF_PARAMS = dict(n_estimators=350, max_depth=3, learning_rate=0.03, subsample=0.8,
                  colsample_bynode=0.6, min_child_weight=8, reg_lambda=3.0,
                  eval_metric="logloss", tree_method="hist", random_state=7)
REG_PARAMS = dict(n_estimators=350, max_depth=3, learning_rate=0.03, subsample=0.8,
                  colsample_bynode=0.6, min_child_weight=8, reg_lambda=3.0,
                  tree_method="hist", random_state=7)

EDGE_MIN = 0.03  # minimum probability edge over the no-vig market to flag a bet


def _fw():
    return np.array([FEATURE_WEIGHTS[f] for f in FEATURES])


def fit(train: pd.DataFrame):
    tr = train.dropna(subset=["home_win"])
    X, y = tr[FEATURES].astype(float), tr.home_win.astype(int)
    clf = XGBClassifier(**CLF_PARAMS, monotone_constraints=tuple(MONOTONE[f] for f in FEATURES))
    clf.fit(X, y, feature_weights=_fw())
    reg = XGBRegressor(**REG_PARAMS, monotone_constraints=tuple(MONOTONE[f] for f in FEATURES))
    reg.fit(tr[FEATURES].astype(float), tr.result.astype(float), feature_weights=_fw())
    return clf, reg


def predict(clf, reg, df: pd.DataFrame) -> pd.DataFrame:
    out = df[["game_id"]].copy()
    X = df[FEATURES].astype(float)
    out["model_home_prob"] = clf.predict_proba(X)[:, 1]
    out["model_margin"] = reg.predict(X)
    return out


def price(df: pd.DataFrame) -> pd.DataFrame:
    """Attach market comparison + EV to a frame with model_home_prob/model_margin and lines."""
    d = df.copy()
    has_ml = d.home_moneyline.notna() & d.away_moneyline.notna()
    d["market_home_prob"] = np.where(has_ml, M.no_vig_home_prob(d.home_moneyline.fillna(-110), d.away_moneyline.fillna(-110)), np.nan)
    d["spread_home_prob"] = M.spread_to_prob(d.spread_line)
    d["edge_home"] = d.model_home_prob - d.market_home_prob
    d["ev_home"] = np.where(has_ml, M.ev_per_dollar(d.model_home_prob, d.home_moneyline.fillna(-110)), np.nan)
    d["ev_away"] = np.where(has_ml, M.ev_per_dollar(1 - d.model_home_prob, d.away_moneyline.fillna(-110)), np.nan)
    d["home_cover_prob"] = M.cover_prob(d.model_margin, d.spread_line)
    return d


def backtest(matrix: pd.DataFrame, seasons) -> dict:
    rows = []
    for s in seasons:
        train = matrix[(matrix.season < s)]
        test = matrix[(matrix.season == s) & matrix.home_win.notna()]
        if len(test) == 0:
            continue
        clf, reg = fit(train)
        p = predict(clf, reg, test).merge(test[["game_id", "season", "week", "home_win", "result", "spread_line",
                                                "home_moneyline", "away_moneyline"]], on="game_id")
        rows.append(price(p))
    bt = pd.concat(rows, ignore_index=True)
    ok = bt.market_home_prob.notna()
    b = bt[ok]
    summary = {
        "games": int(len(b)),
        "model_logloss": float(log_loss(b.home_win, b.model_home_prob)),
        "vegas_logloss": float(log_loss(b.home_win, b.market_home_prob)),
        "model_brier": float(brier_score_loss(b.home_win, b.model_home_prob)),
        "vegas_brier": float(brier_score_loss(b.home_win, b.market_home_prob)),
        "model_accuracy": float(accuracy_score(b.home_win, b.model_home_prob > 0.5)),
        "vegas_accuracy": float(accuracy_score(b.home_win, b.market_home_prob > 0.5)),
        "margin_mae": float(np.mean(np.abs(b.result - b.model_margin))),
        "vegas_margin_mae": float(np.mean(np.abs(b.result - b.spread_line))),
    }
    # simulated flat 1-unit moneyline bets on every +EV side with edge >= EDGE_MIN
    bets = []
    for r in b.itertuples():
        for side, p, mkt, ml, won in [("home", r.model_home_prob, r.market_home_prob, r.home_moneyline, r.home_win == 1),
                                      ("away", 1 - r.model_home_prob, 1 - r.market_home_prob, r.away_moneyline, r.home_win == 0)]:
            if p - mkt >= EDGE_MIN:
                dec = float(M.american_to_decimal(ml))
                bets.append({"season": r.season, "edge": p - mkt, "profit": (dec - 1) if won else -1.0})
    bets = pd.DataFrame(bets)
    if len(bets):
        summary.update({"ev_bets": int(len(bets)), "ev_roi": float(bets.profit.mean()),
                        "ev_roi_by_season": {int(k): round(float(v), 4) for k, v in bets.groupby("season").profit.mean().items()}})
    # spread: bet side where model cover prob >= 55%, at standard -110
    sp = b.dropna(subset=["spread_line"]).copy()
    sp = sp[sp.result != sp.spread_line]
    pick_home = sp.home_cover_prob >= 0.55
    pick_away = sp.home_cover_prob <= 0.45
    won = np.where(pick_home, sp.result > sp.spread_line, sp.result < sp.spread_line)
    n = int((pick_home | pick_away).sum())
    if n:
        w = int(won[(pick_home | pick_away).values].sum())
        summary.update({"ats_bets": n, "ats_win_rate": w / n, "ats_roi": (w * (100 / 110) - (n - w)) / n})
    return {"summary": summary, "detail": bt}


def importance(clf) -> dict:
    g = clf.get_booster().get_score(importance_type="gain")
    tot = sum(g.values()) or 1.0
    return {k: round(v / tot, 4) for k, v in sorted(g.items(), key=lambda kv: -kv[1])}
