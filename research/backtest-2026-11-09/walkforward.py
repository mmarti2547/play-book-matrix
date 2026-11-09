# Walk-forward: for each test season s, fit pbm.model.fit on seasons [2014, s) and predict every REG game of s
import sys, warnings
sys.path.insert(0, "/home/claude/play-book-matrix")
warnings.filterwarnings("ignore")
import numpy as np, pandas as pd
from pbm import model as MD, market as M
FIRST = 2014
mat = pd.read_pickle("/home/claude/research/pbm_matrix.pkl")
mat = mat[mat.season >= FIRST]
rows = []
for s in range(2019, 2026):
    train = mat[mat.season < s]
    test = mat[(mat.season == s) & (mat.game_type == "REG") & mat.result.notna()]
    clf, reg = MD.fit(train)
    p = MD.predict(clf, reg, test).merge(test[["game_id", "season", "week", "gameday", "home_team", "away_team",
        "spread_line", "result", "home_win", "home_moneyline", "away_moneyline"]], on="game_id")
    rows.append(p); print(s, len(train), len(p), flush=True)
bt = pd.concat(rows, ignore_index=True)
has = bt.home_moneyline.notna() & bt.away_moneyline.notna()
bt["market_home_prob"] = np.where(has, M.no_vig_home_prob(bt.home_moneyline.fillna(-110), bt.away_moneyline.fillna(-110)), np.nan)
bt["home_win"] = np.where(bt.result > 0, 1.0, np.where(bt.result < 0, 0.0, 0.5))  # tie = 0.5
bt.to_csv("/home/claude/research/backtest_preds.csv", index=False)
print(bt.shape)
