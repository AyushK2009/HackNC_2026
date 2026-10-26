"""Bayesian need model: baseline prior per neighborhood x category, fused with resident-report evidence.

prior     mu0 in [0.03, 0.97]  (access scores + hardship), lowered near completed projects (adjustments)
evidence  each report adds weight w = credibility * recency * kernel to nearby neighborhoods, signal s = severity/5
posterior mu = (k0*mu0 + sum(w*s)) / (k0 + sum(w)),  k0 = 6;  90% interval from Beta(mu*(k0+W), (1-mu)*(k0+W))
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
from scipy.stats import beta as beta_dist, rankdata

from .data import MILE, Geo

CATS = ["food", "health", "transit", "digital", "housing", "childcare"]
CI = {c: i for i, c in enumerate(CATS)}
LABELS = {
    "food": "Food access",
    "health": "Health care",
    "transit": "Transportation",
    "digital": "Internet & library",
    "housing": "Housing",
    "childcare": "Childcare",
}
PHRASE = {  # for sentences: "<phrase> need"
    "food": "food access",
    "health": "health care",
    "transit": "transportation",
    "digital": "internet & library",
    "housing": "housing",
    "childcare": "childcare",
}
WEIGHTS = np.array([0.20, 0.20, 0.20, 0.15, 0.15, 0.10])
KAPPA0 = 6.0
KERNEL_SIGMA = 1.5 * MILE
REPORT_RADIUS = 4.0 * MILE
HALF_LIFE_DAYS = 45.0
SECONDARY = 0.6  # weight multiplier for a report's non-primary categories
ADDRESSED = 0.3  # reports marked addressed by a completed project keep 30% of their weight
NEARBY = 1.5 * MILE  # "reports" count in NeedSummary


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def pct_of(values: np.ndarray, ref_sorted: np.ndarray) -> np.ndarray:
    """Midrank percentile (0-100) of values within a sorted reference distribution."""
    n = len(ref_sorted)
    lo = np.searchsorted(ref_sorted, values, side="left")
    hi = np.searchsorted(ref_sorted, values, side="right")
    return (lo + 0.5 * (hi - lo)) / max(n, 1) * 100.0


class NeedModel:
    def __init__(self, geo: Geo) -> None:
        self.geo = geo
        self.n = geo.n
        self.base = self._baseline()
        self.reset_state()

    # ---- baseline ----------------------------------------------------------------------------------------
    def _baseline(self) -> np.ndarray:
        g = self.geo
        h = g.hardship / 100.0
        scale = 0.6 + 0.4 * h
        acc_need = 1.0 - g.access / 100.0
        acc_need = np.where(np.isnan(acc_need), 0.5, acc_need)
        base = np.zeros((self.n, 6))
        for j in range(4):  # food, health, transit, digital(library)
            base[:, j] = acc_need[:, j] * scale

        def rank01(v):
            v = np.where(np.isnan(v), np.nanmedian(v), v)
            return (rankdata(v) - 0.5) / len(v)

        pov, snap = rank01(g.poverty), rank01(g.snap)
        housing = 0.4 * pov + 0.3 * snap + 0.3 * h
        childcare = 0.6 * h + 0.4 * snap
        base[:, CI["housing"]] = 0.1 + 0.7 * housing
        base[:, CI["childcare"]] = 0.1 + 0.7 * childcare
        return np.clip(base, 0.03, 0.97)

    # ---- state -------------------------------------------------------------------------------------------
    def reset_state(self) -> None:
        self.adjust = np.ones((self.n, 6))
        self.sumW = np.zeros((self.n, 6))
        self.sumWS = np.zeros((self.n, 6))
        self.nearby = np.zeros(self.n, dtype=int)
        self.contrib: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        self.lo = np.zeros((self.n, 6))
        self.hi = np.zeros((self.n, 6))
        self.updated_at = iso(now_utc())
        self._cache: bytes | None = None
        self._recompute(None)

    def rebuild(self, reports: list[dict], adjustments: list[dict]) -> None:
        self.reset_state()
        for a in adjustments:
            self._apply_adjustment(a)
        now = now_utc()
        for r in reports:
            self._add(r, now)
        self._recompute(None)

    @property
    def prior(self) -> np.ndarray:
        return np.clip(self.base * self.adjust, 0.0, 1.0)

    def _apply_adjustment(self, a: dict) -> np.ndarray:
        if "tracts" in a:  # nearest-first allocation: explicit fraction removed per neighborhood and category
            idx = []
            for g, eff in a["tracts"].items():
                i = self.geo.idx.get(g)
                if i is None:
                    continue
                idx.append(i)
                for c, e in eff.items():
                    if c in CI and e > 0:
                        self.adjust[i, CI[c]] *= 1.0 - min(0.95, e)
            return np.array(idx, dtype=int)
        sigma = a["sigma_mi"] * MILE
        x, y = self.geo.xy(a["lat"], a["lon"])
        idx = self.geo.near(x, y, 3 * sigma)
        if len(idx) == 0:
            return idx
        k = np.exp(-self.geo.dist_m(x, y, idx) ** 2 / (2 * sigma**2))
        for c, e in a["effect"].items():
            if c in CI and e > 0:
                self.adjust[idx, CI[c]] *= 1.0 - e * k
        return idx

    def report_weights(self, r: dict, now: datetime | None = None):
        now = now or now_utc()
        x, y = self.geo.xy(r["lat"], r["lon"])
        idx = self.geo.near(x, y, REPORT_RADIUS)
        own = self.geo.idx.get(r["geoid"])
        if own is not None and own not in set(idx.tolist()):
            idx = np.append(idx, own)
        d = self.geo.dist_m(x, y, idx)
        ker = np.exp(-(d**2) / (2 * KERNEL_SIGMA**2))
        if own is not None:
            ker[idx == own] = np.maximum(ker[idx == own], 0.85)
        conf = min(1.0, max(0.3, float(r.get("confidence", 0.6))))
        n_conf = int(r.get("confirmations", 0))
        cred = conf * (1 + 0.25 * min(n_conf, 4) + 0.05 * max(0, min(n_conf, 12) - 4))
        # A "me too" means the problem is still current: recency counts from the latest confirmation.
        last = parse_iso(r.get("last_confirmed_at") or r["created_at"])
        age = max(0.0, (now - max(last, parse_iso(r["created_at"]))).total_seconds() / 86400)
        rec = 0.5 ** (age / HALF_LIFE_DAYS)
        status = ADDRESSED if r.get("status") == "addressed" else 1.0
        catw = np.zeros(6)
        for c in r.get("categories", []):
            if c in CI:
                catw[CI[c]] = SECONDARY
        if r.get("primary") in CI:
            catw[CI[r["primary"]]] = 1.0
        W = (cred * rec * status * ker)[:, None] * catw[None, :]
        close = (d <= NEARBY) | (idx == own) if own is not None else d <= NEARBY
        return idx, W, close

    def signal(self, r: dict) -> float:
        """Severity signal s = severity/5. Each "me too" closes 15% of the gap to 1 (more people affected), and a
        confirmed report always signals at least 0.15 above the baseline prior, so confirming never lowers need."""
        s = float(r.get("severity", 3)) / 5.0
        c = int(r.get("confirmations", 0))
        if c <= 0:
            return s
        s = 1.0 - (1.0 - s) * 0.85 ** min(c, 10)
        i, j = self.geo.idx.get(r.get("geoid")), CI.get(r.get("primary"))
        if i is not None and j is not None:
            s = max(s, min(0.97, float(self.base[i, j] * self.adjust[i, j]) + 0.15))
        return min(1.0, s)

    def _add(self, r: dict, now: datetime | None = None) -> np.ndarray:
        idx, W, close = self.report_weights(r, now)
        s = self.signal(r)
        self.sumW[idx] += W
        self.sumWS[idx] += W * s
        self.nearby[idx[close]] += 1
        self.contrib[r["id"]] = (idx, W * 1.0, close, s)
        return idx

    def _remove(self, rid: str) -> np.ndarray:
        item = self.contrib.pop(rid, None)
        if not item:
            return np.array([], dtype=int)
        idx, W, close, s = item
        self.sumW[idx] = np.maximum(self.sumW[idx] - W, 0)
        self.sumWS[idx] = np.maximum(self.sumWS[idx] - W * s, 0)
        self.nearby[idx[close]] -= 1
        return idx

    # ---- public updates ----------------------------------------------------------------------------------
    def add_report(self, r: dict) -> None:
        idx = self._add(r)
        self._recompute(idx)

    def update_report(self, r: dict) -> None:
        a = self._remove(r["id"])
        b = self._add(r)
        self._recompute(np.union1d(a, b))

    def apply_adjustment(self, a: dict) -> None:
        idx = self._apply_adjustment(a)
        self._recompute(idx)

    # ---- posterior ---------------------------------------------------------------------------------------
    def _recompute(self, idx) -> None:
        mu0 = self.prior
        if idx is None:
            idx = np.arange(self.n)
        idx = np.asarray(idx, dtype=int)
        if not hasattr(self, "post"):
            self.post = np.zeros((self.n, 6))
        if len(idx):
            W = self.sumW[idx]
            post = (KAPPA0 * mu0[idx] + self.sumWS[idx]) / (KAPPA0 + W)
            post = np.clip(post, 0.005, 0.995)
            self.post[idx] = post
            tot = KAPPA0 + W
            a, b = post * tot, (1 - post) * tot
            self.lo[idx] = beta_dist.ppf(0.05, a, b)
            self.hi[idx] = beta_dist.ppf(0.95, a, b)
        self.need = self.post @ WEIGHTS * 100.0
        pop = self.geo.populated
        ref = np.sort(self.need[pop])
        self.pct = pct_of(self.need, ref)
        self.cat_pct = np.zeros((self.n, 6))
        for j in range(6):
            self.cat_pct[:, j] = pct_of(self.post[:, j], np.sort(self.post[pop, j]))
        self.conf = self.sumW.sum(1) / (self.sumW.sum(1) + KAPPA0)
        self.updated_at = iso(now_utc())
        self._cache = None

    # ---- views -------------------------------------------------------------------------------------------
    def summary(self, i: int) -> dict:
        p = self.post[i]
        return {
            "need": round(float(self.need[i]), 1),
            "pct": round(float(self.pct[i]), 1),
            "top": CATS[int(np.argmax(p))],
            "by": {c: round(float(p[j] * 100), 1) for j, c in enumerate(CATS)},
            "conf": round(float(self.conf[i]), 3),
            "reports": int(self.nearby[i]),
        }

    def needs_json(self) -> bytes:
        if self._cache is None:
            tracts = {g: self.summary(i) for i, g in enumerate(self.geo.geoids)}
            body = {"categories": CATS, "labels": LABELS, "tracts": tracts, "updated_at": self.updated_at}
            self._cache = json.dumps(body, separators=(",", ":")).encode()
        return self._cache

    def cells(self, i: int) -> dict:
        mu0 = self.prior[i]
        return {
            c: {
                "prior": round(float(mu0[j] * 100), 1),
                "posterior": round(float(self.post[i, j] * 100), 1),
                "lo": round(float(self.lo[i, j] * 100), 1),
                "hi": round(float(self.hi[i, j] * 100), 1),
                "evidence": round(float(self.sumW[i, j]), 3),
            }
            for j, c in enumerate(CATS)
        }

    def pop_mean_need(self, idx) -> float:
        idx = np.asarray(idx, dtype=int)
        w = self.geo.pop[idx]
        if w.sum() <= 0:
            return float(self.need[idx].mean()) if len(idx) else 0.0
        return float((self.need[idx] * w).sum() / w.sum())


def ordinal_pct(p: float) -> str:
    p = int(round(min(99, max(1, p))))
    return f"{p}%"


def fmt_int(v) -> str:
    return f"{int(round(v)):,}"


def safe(v, nd=1):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), nd)
