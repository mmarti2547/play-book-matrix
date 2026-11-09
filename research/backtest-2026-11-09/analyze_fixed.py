import numpy as np, pandas as pd
from scipy.stats import norm
from scipy.optimize import minimize_scalar
pd.set_option("display.width", 200)
SD = 13.45
bt = pd.read_csv("/home/claude/research/backtest_preds_fixed.csv")
bt["gap"] = bt.model_margin - bt.spread_line
ats = bt[(bt.result != bt.spread_line) & (bt.gap != 0)].copy()
ats["home_cov"] = (ats.result > ats.spread_line).astype(int)
ats["hit"] = ((ats.gap > 0) == (ats.home_cov == 1)).astype(int)
print("pushes excluded:", len(bt) - len(ats), "of", len(bt))

def tab(d, by):
    out = {}
    for th in [0, 2, 3, 5]:
        x = d[d.gap.abs() >= th]
        g = x.groupby(by).hit.agg(["size", "mean"])
        g.loc["ALL"] = [len(x), x.hit.mean()]
        out[f"n>={th}"] = g["size"].astype(int); out[f"hit>={th}"] = (g["mean"] * 100).round(1)
    return pd.DataFrame(out)
print("\n=== 1. ATS (pick side where model_margin > spread_line) ===")
print(tab(ats, "season").to_string())
# binomial p vs 50% overall
from scipy.stats import binomtest
for th in [0, 2, 3, 5]:
    x = ats[ats.gap.abs() >= th]
    print(f"|gap|>={th}: n={len(x)} hits={x.hit.sum()} p(two-sided vs 50%)={binomtest(x.hit.sum(), len(x)).pvalue:.3f}; breakeven at -110 = 52.4%")
# also the production rule: cover prob >=55% / <=45% with w=1
cp = norm.cdf(ats.gap / SD); sel = (cp >= .55) | (cp <= .45)
print(f"production rule (cover prob>=55% at w=1, i.e. |gap|>={norm.ppf(.55)*SD:.2f}): n={sel.sum()} hit={ats.hit[sel].mean()*100:.1f}%")

print("\n=== 2. Shrink weight w: cover_prob = Phi(w*gap/13.45) ===")
z = (ats.gap / SD).values; y = ats.home_cov.values
def nll(w, z=z, y=y):
    p = np.clip(norm.cdf(w * z), 1e-9, 1 - 1e-9); return -np.sum(y * np.log(p) + (1 - y) * np.log(1 - p))
def fitw(z, y): return minimize_scalar(lambda w: nll(w, z, y), bounds=(-3, 3), method="bounded").x
w = fitw(z, y)
# likelihood-ratio CI
grid = np.linspace(-2, 2, 4001); ll = np.array([nll(g) for g in grid]); ok = grid[ll - nll(w) <= 1.92]
rng = np.random.default_rng(1)
bg = [fitw(z[i], y[i]) for i in (rng.integers(0, len(z), len(z)) for _ in range(1000))]
seasons = ats.season.values; us = np.unique(seasons); idx = {s: np.where(seasons == s)[0] for s in us}
bs = []
for _ in range(1000):
    ii = np.concatenate([idx[s] for s in rng.choice(us, len(us))]); bs.append(fitw(z[ii], y[ii]))
print(f"w = {w:.3f}  LR 95% CI [{ok.min():.3f}, {ok.max():.3f}]  game-bootstrap 95% [{np.percentile(bg,2.5):.3f}, {np.percentile(bg,97.5):.3f}]  season-bootstrap 95% [{np.percentile(bs,2.5):.3f}, {np.percentile(bs,97.5):.3f}]")
print("LL at w=0 (coin flip):", round(-nll(0), 2), " LL at w_hat:", round(-nll(w), 2), " LL at w=1:", round(-nll(1), 2))
print("per-season w:", {int(s): round(fitw(z[idx[s]], y[idx[s]]), 3) for s in us})
# calibration of picked side
ats["pick_p"] = norm.cdf(abs(w) * np.abs(ats.gap) / SD) if w > 0 else 0.5
ats["pick_p1"] = norm.cdf(np.abs(ats.gap) / SD)
bins = [0, .51, .52, .53, .54, .56, 1]
ats["b"] = pd.cut(ats.pick_p, bins) if w > 0 else "n/a"
print(f"Calibration (picked-side cover prob using w={w:.3f}):")
print(ats.groupby("b", observed=True).agg(n=("hit", "size"), pred=("pick_p", "mean"), actual=("hit", "mean"), gap_lo=("gap", lambda g: g.abs().min()), gap_hi=("gap", lambda g: g.abs().max())).round(3).to_string())
ats["b1"] = pd.cut(ats.pick_p1, [0, .52, .54, .56, .58, .60, .65, 1])
print("Same table with w=1 (current production cover_prob):")
print(ats.groupby("b1", observed=True).agg(n=("hit", "size"), pred=("pick_p1", "mean"), actual=("hit", "mean")).round(3).to_string())

print("\n=== 3. Win prob: Brier / log loss (ties and missing ML excluded) ===")
wp = bt[(bt.result != 0) & bt.market_home_prob.notna()].copy(); yy = wp.home_win.values
def scores(p):
    p = np.clip(p, 1e-6, 1 - 1e-6); return np.mean((p - yy) ** 2), -np.mean(yy * np.log(p) + (1 - yy) * np.log(1 - p))
rows = []
for a in np.round(np.arange(0, 1.01, .1), 1):
    b, l = scores(a * wp.model_home_prob + (1 - a) * wp.market_home_prob); rows.append((a, b, l))
r = pd.DataFrame(rows, columns=["alpha(model wt)", "brier", "logloss"]); print(r.round(5).to_string(index=False))
fine = [(a, *scores(a * wp.model_home_prob + (1 - a) * wp.market_home_prob)) for a in np.arange(0, 1.001, .01)]
fa = min(fine, key=lambda t: t[2]); fb = min(fine, key=lambda t: t[1])
print(f"n={len(wp)}; best alpha by logloss={fa[0]:.2f}, by brier={fb[0]:.2f}")
print("accuracy model / market:", round(((wp.model_home_prob > .5) == yy).mean(), 4), round(((wp.market_home_prob > .5) == yy).mean(), 4))
print("Per-season best alpha (logloss, step .1) and model vs market logloss:")
for s, d in wp.groupby("season"):
    y2 = d.home_win.values
    def ll(p): p = np.clip(p, 1e-6, 1 - 1e-6); return -np.mean(y2 * np.log(p) + (1 - y2) * np.log(1 - p))
    al = min(np.round(np.arange(0, 1.01, .1), 1), key=lambda a: ll(a * d.model_home_prob + (1 - a) * d.market_home_prob))
    print(f"  {s}: model {ll(d.model_home_prob):.4f}  market {ll(d.market_home_prob):.4f}  best alpha {al}")
# leave-one-season-out alpha (honest)
lo = []
for s in wp.season.unique():
    tr = wp[wp.season != s]; te = wp[wp.season == s]
    def lltr(a): p = np.clip(a * tr.model_home_prob + (1 - a) * tr.market_home_prob, 1e-6, 1 - 1e-6); return -np.mean(tr.home_win * np.log(p) + (1 - tr.home_win) * np.log(1 - p))
    lo.append((s, min(np.arange(0, 1.001, .05), key=lltr)))
print("leave-one-season-out alphas:", [(int(s), round(a, 2)) for s, a in lo])

print("\n=== 4. Moneyline value bets: flat 1u where blend - market >= 0.03 ===")
dec = lambda ml: np.where(ml > 0, 1 + ml / 100, 1 + 100 / np.abs(ml))
mlb = bt[bt.market_home_prob.notna()]
def mlsim(a):
    bets = []
    for r in mlb.itertuples():
        pb = a * r.model_home_prob + (1 - a) * r.market_home_prob
        for side, p, m, ml, res in [("H", pb, r.market_home_prob, r.home_moneyline, np.sign(r.result)),
                                    ("A", 1 - pb, 1 - r.market_home_prob, r.away_moneyline, -np.sign(r.result))]:
            if p - m >= 0.03:
                prof = (dec(ml) - 1) if res > 0 else (0.0 if res == 0 else -1.0)
                bets.append((r.season, side, ml, float(prof)))
    return pd.DataFrame(bets, columns=["season", "side", "ml", "profit"])
for a in sorted({fa[0].round(2), 0.3, 1.0}):
    b = mlsim(a)
    if not len(b): print(f"alpha={a}: no bets"); continue
    g = b.groupby("season").agg(n=("profit", "size"), units=("profit", "sum"), roi=("profit", "mean"))
    g.loc["ALL"] = [len(b), b.profit.sum(), b.profit.mean()]
    g["win%"] = list(b.groupby("season").profit.apply(lambda p: (p > 0).mean())) + [(b.profit > 0).mean()]
    dog = b[b.ml > 0]
    print(f"alpha={a}: (underdog bets {len(dog)}, ROI {dog.profit.mean()*100 if len(dog) else float('nan'):.1f}%; favorites {len(b)-len(dog)}, ROI {b[b.ml<0].profit.mean()*100:.1f}%)")
    g["roi"] = (g.roi * 100).round(1); g["win%"] = (g["win%"] * 100).round(1); g["units"] = g.units.round(2)
    print(g.to_string())

print("\n=== 5. Within-season decay: ATS by month / week bucket ===")
ats["month"] = pd.to_datetime(ats.gameday).dt.month.map({9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec", 1: "Jan"})
ats["wk"] = pd.cut(ats.week, [0, 4, 8, 12, 15, 18], labels=["1-4", "5-8", "9-12", "13-15", "16-18"])
for col, order in [("month", ["Sep", "Oct", "Nov", "Dec", "Jan"]), ("wk", None)]:
    t = tab(ats, col)
    if order: t = t.reindex(order + ["ALL"])
    print(t.to_string()); print()
