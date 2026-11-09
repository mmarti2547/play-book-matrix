# Build the PBM feature matrix (same pipeline as run.py, no live weather, no publishing)
import sys, time, warnings
sys.path.insert(0, "/home/claude/play-book-matrix")
warnings.filterwarnings("ignore")
import pandas as pd
from pbm import data as D, features as F
FIRST = int(sys.argv[1]) if len(sys.argv) > 1 else 2014
seasons = list(range(FIRST - 1, 2026))
t = time.time()
sched = D.load_schedules(seasons); print("sched", sched.shape, time.time()-t, flush=True)
pbp = D.load_pbp(seasons); print("pbp", pbp.shape, time.time()-t, flush=True)
inj = D.load_injuries(seasons); print("inj", inj.shape, time.time()-t, flush=True)
snaps = D.load_snaps(seasons); print("snaps", snaps.shape, time.time()-t, flush=True)
ids = D.load_player_ids(); print("ids", ids.shape, flush=True)
tg = F.team_game_stats(pbp)
form = F.build_team_form(sched, tg)
starters = F.starters_by_team_week(snaps, sched, ids); print("starters", starters.shape, time.time()-t, flush=True)
clusters = F.injury_clusters(inj, starters, sched)
ctx = F.game_context(sched, pbp)
mat = F.build_matrix(ctx, form, clusters)
mat = mat.drop(columns=[c for c in mat.columns if c.endswith("starters_out")])
mat.to_pickle("/home/claude/research/pbm_matrix.pkl")
print("matrix", mat.shape, time.time()-t)
print(mat.groupby("season").size().to_string())
