"""Write results to Supabase through the REST API (service role key, bypasses RLS)."""
import json
import math
import os
import requests
import pandas as pd

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _clean(v):
    if v is None or v is pd.NaT:
        return None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if hasattr(v, "item"):
        v = v.item()
        return _clean(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _dry(table, rows):
    os.makedirs("out", exist_ok=True)
    rows = [{k: _clean(v) for k, v in r.items()} for r in rows]
    with open(f"out/{table}.json", "w") as fh:
        json.dump(rows, fh, default=str, allow_nan=False)
    print(f"[dry-run] {table}: {len(rows)} rows -> out/{table}.json")


def upsert(table, rows, on_conflict):
    if not URL or not KEY:
        return _dry(table, rows)
    rows = [{k: _clean(v) for k, v in r.items()} for r in rows]
    for i in range(0, len(rows), 500):
        r = requests.post(
            f"{URL}/rest/v1/{table}?on_conflict={on_conflict}",
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            data=json.dumps(rows[i:i + 500], default=str, allow_nan=False), timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"{table} upsert failed {r.status_code}: {r.text[:500]}")
    print(f"{table}: {len(rows)} rows upserted")


def insert(table, rows):
    if not URL or not KEY:
        return _dry(table, rows)
    rows = [{k: _clean(v) for k, v in r.items()} for r in rows]
    r = requests.post(f"{URL}/rest/v1/{table}",
                      headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                               "Prefer": "return=minimal"},
                      data=json.dumps(rows, default=str, allow_nan=False), timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"{table} insert failed {r.status_code}: {r.text[:500]}")
