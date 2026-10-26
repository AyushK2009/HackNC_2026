"""Budgeted maximum-coverage portfolio, solved exactly as a mixed-integer program (scipy.optimize.milp / HiGHS).

x_k  in {0,1}       open candidate k = (intervention type t, site neighborhood s)
y_ic in [0, mu_ic]  fraction of category-c need removed in neighborhood i
max  sum_i sum_c w_i * pi_c * y_ic          w_i = pop_i/1000 * (0.25 + 0.75 * hardship_i/100)
s.t. y_ic <= sum_k a_kic x_k                a_kic = effect_tc * exp(-d_is^2 / 2 sigma_t^2) * mu_ic  (d <= 3 sigma)
     sum_k cost_k x_k <= budget;  sum_k vol_k x_k <= volunteers
     sum_{k of type t} x_k <= max_per_type;  at most one facility per site
"""
from __future__ import annotations

import time
from collections import Counter

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree

from .catalog import capacity_of
from .data import MILE, Geo
from .needs import CATS, PHRASE, WEIGHTS, NeedModel

A_REL = 0.01  # drop coverage entries below 1% of a candidate's strongest entry
REACHED_MIN = 0.5  # reached = neighborhoods that get at least half the intervention's full effect (d <= 1.18 sigma)
STATUS = {0: "optimal", 1: "time_limit", 2: "infeasible", 3: "unbounded", 4: "error"}


def scope_indices(geo: Geo, scope: str) -> tuple[np.ndarray, str]:
    if scope in ("nc", "NC", "", None):
        return np.where(geo.populated)[0], "North Carolina"
    fips = geo.county_fips(scope)
    if fips is None:
        raise KeyError(f"Unknown county '{scope}'")
    idx = np.where((geo.fips == fips) & geo.populated)[0]
    return idx, geo.county_name(fips)


def _effect_vec(t: dict) -> np.ndarray:
    return np.array([float(t["effect"].get(c, 0.0) or 0.0) for c in CATS])


def reach_scale(geo: Geo, t: dict, x: float, y: float) -> tuple[float, float, float]:
    """(scale, population in reach weighted by the coverage kernel, capacity); scale = min(1, capacity / pop)."""
    sigma = max(0.25, float(t["reach_mi"])) * MILE
    idx = geo.near(x, y, 3 * sigma)
    idx = idx[geo.populated[idx]] if len(idx) else idx
    pop = float((geo.pop[idx] * np.exp(-geo.dist_m(x, y, idx) ** 2 / (2 * sigma**2))).sum()) if len(idx) else 0.0
    cap = capacity_of(t)
    return (min(1.0, cap / pop) if pop > 0 else 1.0), pop, cap


def allocate(geo: Geo, t: dict, x: float, y: float):
    """Nearest-first capacity allocation. Neighborhoods in reach (d <= 3 sigma) sorted by distance; each is fully
    served while cumulative population <= capacity, the one crossing capacity gets the remaining fraction, the rest 0.
    Returns (geo indices, served fraction, kernel, people served, capacity)."""
    sigma = max(0.25, float(t["reach_mi"])) * MILE
    idx = geo.near(x, y, 3 * sigma)
    idx = idx[geo.populated[idx]] if len(idx) else idx
    cap = capacity_of(t)
    if len(idx) == 0:
        return idx, np.zeros(0), np.zeros(0), 0.0, cap
    d = geo.dist_m(x, y, idx)
    order = np.argsort(d, kind="stable")
    idx, d = idx[order], d[order]
    pop = geo.pop[idx]
    before = np.concatenate([[0.0], np.cumsum(pop)[:-1]])
    frac = np.clip((cap - before) / np.maximum(pop, 1.0), 0.0, 1.0)
    ker = np.exp(-(d**2) / (2 * sigma**2))
    served = float((pop * frac).sum())
    return idx, frac, ker, served, cap


def _coverage(geo: Geo, mu: np.ndarray, t: dict, site: int, scope_idx: np.ndarray, stree: cKDTree):
    """Local scope indices nb, matrix A (len(nb) x 6) of need fraction removable by t at site, and capacity info."""
    gidx, frac, ker, served, cap = allocate(geo, t, geo.x[site], geo.y[site])
    meta = {"served": served, "cap": cap, "n_served": int((frac > 0).sum())}
    pos = {int(g): k for k, g in enumerate(scope_idx)}
    keep = [(pos[int(g)], f * kk) for g, f, kk in zip(gidx, frac, ker) if f > 0 and int(g) in pos]
    if not keep:
        return np.array([], dtype=int), np.zeros((0, 6)), meta
    nb = np.array([k for k, _ in keep], dtype=int)
    w = np.array([v for _, v in keep])
    A = w[:, None] * _effect_vec(t)[None, :] * mu[scope_idx[nb]]
    return nb, A, meta


def _prune(A: np.ndarray):
    if A.size == 0:
        return np.array([], int), np.array([], int)
    return np.nonzero(A > max(A_REL * float(A.max()), 1e-12))


def select_sites(geo: Geo, order: np.ndarray, n: int, min_mi: float) -> np.ndarray:
    """Highest-need neighborhoods first, skipping any within min_mi of one already picked."""
    out: list[int] = []
    for i in order:
        if out and np.min(np.hypot(geo.x[out] - geo.x[i], geo.y[out] - geo.y[i])) < min_mi * MILE:
            continue
        out.append(int(i))
        if len(out) >= n:
            break
    return np.array(out, dtype=int)


class _Ctx:
    def __init__(self, geo: Geo, model: NeedModel, reports: list[dict], scope_idx: np.ndarray):
        self.geo, self.model, self.scope_idx = geo, model, scope_idx
        self.stree = cKDTree(np.c_[geo.x[scope_idx], geo.y[scope_idx]])
        self.mu = model.post
        self.w = geo.pop[scope_idx] / 1000.0 * (0.25 + 0.75 * geo.hardship[scope_idx] / 100.0)
        self.reports = [r for r in reports if r.get("status") != "addressed"]
        if self.reports:
            xy = np.array([geo.xy(r["lat"], r["lon"]) for r in self.reports])
            self.rx, self.ry = xy[:, 0], xy[:, 1]
        else:
            self.rx = self.ry = np.zeros(0)


def why_text(ctx: _Ctx, t: dict, site: int, reached: np.ndarray, people: float, main: str | None = None) -> str:
    geo = ctx.geo
    gi = ctx.scope_idx[reached] if len(reached) else np.array([site])
    pw = geo.pop[gi]
    pw = pw if pw.sum() > 0 else np.ones(len(gi))

    def wmean(v):
        m = ~np.isnan(v)
        return float((v[m] * pw[m]).sum() / pw[m].sum()) if m.any() and pw[m].sum() > 0 else float("nan")

    main = main or (t["categories"][0] if t.get("categories") else "food")
    stat = {
        "transit": (wmean(geo.no_car[gi]), "{:.0f}% of households have no car"),
        "food": (wmean(geo.snap[gi]), "{:.0f}% of households use SNAP"),
        "health": (wmean(geo.miles[gi, 1]), "the nearest community health center averages {:.1f} miles away"),
        "digital": (wmean(geo.miles[gi, 3]), "the nearest public library averages {:.1f} miles away"),
        "housing": (wmean(geo.poverty[gi]), "{:.0f}% of residents live below the poverty line"),
        "childcare": (wmean(geo.poverty[gi]), "{:.0f}% of residents live below the poverty line"),
    }[main]
    n = len(reached)
    head = (f"Serves about {int(round(people, -1)):,} people a year in the {'nearest neighborhood' if n == 1 else f'{n} nearest neighborhoods'}"
            if n else f"Serves about {int(round(people, -1)):,} people a year")
    if not np.isnan(stat[0]):
        head += " where " + stat[1].format(stat[0])
    parts = [head]
    if len(ctx.rx):
        sigma = float(t["reach_mi"]) * MILE
        d = np.hypot(ctx.rx - geo.x[site], ctx.ry - geo.y[site])
        cats = set(t.get("categories") or [])
        near = [r for r, dd in zip(ctx.reports, d) if dd <= 2 * sigma and (r.get("primary") in cats or cats & set(r.get("categories", [])))]
        if near:
            bar = Counter(b for r in near for b in r.get("barriers", []))
            txt = f"residents filed {len(near)} report{'s' if len(near) != 1 else ''} about {PHRASE[main]} nearby"
            if bar:
                txt += f", most often about {bar.most_common(1)[0][0].replace('_', ' ')}"
            parts.append(txt)
    sp = ctx.model.cat_pct[site, CATS.index(main)]
    parts.append(f"{PHRASE[main]} need at the site is higher than {int(min(99, round(sp)))}% of NC")
    s = "; ".join(parts)
    return s[0].upper() + s[1:] + "."


def _items(ctx: _Ctx, cands: list, sel: list[int], pair_index: dict | None = None):
    """Attribute removed need to selected candidates. Returns items, Y (scope x 6), reached mask."""
    geo, scope_idx, mu = ctx.geo, ctx.scope_idx, ctx.mu
    S = len(scope_idx)
    tot = np.zeros(S * 6)
    for k in sel:
        p, a = cands[k][2], cands[k][3]
        np.add.at(tot, p, a)
    mu_s = mu[scope_idx].reshape(-1)
    Yflat = np.minimum(mu_s, tot)
    items = []
    reached_all = np.zeros(S, dtype=bool)
    pop_s = geo.pop[scope_idx]
    for k in sel:
        t, site, p, a, meta = cands[k]
        share = a / np.maximum(tot[p], 1e-12)
        yk = share * Yflat[p]
        loc, cj = p // 6, p % 6
        cover = np.bincount(loc, weights=a, minlength=S)
        reached = np.where(cover > 0)[0]  # neighborhoods it actually serves (nearest first, up to capacity)
        if len(reached) == 0:
            reached = np.unique(loc[np.argsort(-a)[:1]])
        reached_all[reached] = True
        people = float(min(meta["cap"], meta["served"]))  # people actually served
        red = {}
        for j, c in enumerate(CATS):
            m = cj == j
            if m.any() and people > 0:
                v = float((pop_s[loc[m]] * yk[m]).sum() / people * 100)
                if v >= 0.05:
                    red[c] = round(v, 2)
        score = float((ctx.w[loc] * WEIGHTS[cj] * yk).sum())
        g = geo.geoids[site]
        items.append({
            "id": f"{t['key']}@{g}", "type": t["key"], "label": t["label"], "categories": list(t.get("categories") or []),
            "geoid": g, "county": geo.county[site], "lat": round(float(geo.lat[site]), 5), "lon": round(float(geo.lon[site]), 5),
            "cost": int(t["cost"]), "volunteers": int(t["volunteers"]), "people_reached": int(round(people)),
            "need_reduction": red, "score": round(score, 3), "why": why_text(ctx, t, site, reached, people, max(red, key=red.get) if red else None),
        })
    return items, Yflat.reshape(S, 6), reached_all


def _greedy(cands, budget, vol, max_per_type, ctx: _Ctx):
    S = len(ctx.scope_idx)
    mu_s = ctx.mu[ctx.scope_idx].reshape(-1)
    val = np.repeat(ctx.w, 6) * np.tile(WEIGHTS, S)
    tot = np.zeros(S * 6)
    sel, cost, hours, per_type, fac_sites = [], 0.0, 0.0, Counter(), set()
    while True:
        best, best_r = None, 0.0
        cur = np.minimum(mu_s, tot)
        for k, (t, site, p, a, _m) in enumerate(cands):
            if k in sel or cost + t["cost"] > budget or hours + t["volunteers"] > vol or per_type[t["key"]] >= max_per_type:
                continue
            if t["kind"] == "facility" and site in fac_sites:
                continue
            gain = float((val[p] * (np.minimum(mu_s[p], tot[p] + a) - cur[p])).sum())
            r = gain / max(t["cost"], 1.0)
            if gain > 1e-9 and r > best_r:
                best, best_r = k, r
        if best is None:
            return sel
        t, site, p, a, _m = cands[best]
        sel.append(best)
        np.add.at(tot, p, a)
        cost += t["cost"]
        hours += t["volunteers"]
        per_type[t["key"]] += 1
        if t["kind"] == "facility":
            fac_sites.add(site)


def optimize(geo: Geo, model: NeedModel, reports: list[dict], scope: str, budget: float, volunteers: float,
             types: list[dict], max_per_type: int = 3, time_limit: float | None = None) -> dict:
    t0 = time.perf_counter()
    scope_idx, scope_label = scope_indices(geo, scope)
    if len(scope_idx) == 0:
        raise KeyError("No populated neighborhoods in that area")
    ctx = _Ctx(geo, model, reports, scope_idx)
    S = len(scope_idx)
    statewide = str(scope).lower() == "nc"
    if time_limit is None:
        time_limit = 4.0 if statewide else 2.0
    order = scope_idx[np.argsort(-model.need[scope_idx], kind="stable")]
    sites = select_sites(geo, order, 150 if statewide else 35, 2.0 if statewide else 0.6)

    cands = []  # (type, site, pair ids, a)
    for t in types:
        if t["cost"] > budget or t["volunteers"] > volunteers or not any(v > 0 for v in t["effect"].values()):
            continue
        for s in sites:
            nb, A, meta = _coverage(geo, ctx.mu, t, int(s), scope_idx, ctx.stree)
            if len(nb) == 0:
                continue
            li, cj = _prune(A)
            if len(li) == 0:
                continue
            cands.append((t, int(s), nb[li] * 6 + cj, A[li, cj], meta))
    K = len(cands)
    mu_s = ctx.mu[scope_idx]
    pop_s = geo.pop[scope_idx]
    status, n_vars, gap = "no_candidates", 0, None
    sel: list[int] = []
    if K:
        allp = np.unique(np.concatenate([c[2] for c in cands]))
        P = len(allp)
        pid = -np.ones(S * 6, dtype=int)
        pid[allp] = np.arange(P)
        rows, cols, vals = [np.arange(P)], [K + np.arange(P)], [np.ones(P)]
        for k, (_, _, p, a, _m) in enumerate(cands):
            rows.append(pid[p]); cols.append(np.full(len(p), k)); vals.append(-a)
        r = P
        lb_r, ub_r = [np.full(P, -np.inf)], [np.zeros(P)]
        extra_rows = []  # (cols, vals, ub)
        extra_rows.append((np.arange(K), np.array([c[0]["cost"] for c in cands], float), float(budget)))
        extra_rows.append((np.arange(K), np.array([c[0]["volunteers"] for c in cands], float), float(volunteers)))
        by_type, fac_by_site = {}, {}
        for k, c in enumerate(cands):
            by_type.setdefault(c[0]["key"], []).append(k)
            if c[0]["kind"] == "facility":
                fac_by_site.setdefault(c[1], []).append(k)
        for ks in by_type.values():
            if len(ks) > max_per_type:
                extra_rows.append((np.array(ks), np.ones(len(ks)), float(max_per_type)))
            # Spacing: within any circle of radius sigma around a candidate site, at most one of the same type.
            ss = np.array([cands[k][1] for k in ks])
            sig = float(cands[ks[0]][0]["reach_mi"]) * MILE
            sx, sy = geo.x[ss], geo.y[ss]
            seen_rows = set()
            for a_ in range(len(ks)):
                close = np.where(np.hypot(sx - sx[a_], sy - sy[a_]) < sig)[0]
                if len(close) > 1:
                    key = tuple(close.tolist())
                    if key not in seen_rows:
                        seen_rows.add(key)
                        extra_rows.append((np.array(ks)[close], np.ones(len(close)), 1.0))
        for ks in fac_by_site.values():
            if len(ks) > 1:
                extra_rows.append((np.array(ks), np.ones(len(ks)), 1.0))
        for cs, vs, ub in extra_rows:
            rows.append(np.full(len(cs), r)); cols.append(cs); vals.append(vs)
            lb_r.append(np.array([-np.inf])); ub_r.append(np.array([ub]))
            r += 1
        A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(r, K + P)).tocsr()
        obj = np.zeros(K + P)
        obj[K:] = -(ctx.w[allp // 6] * WEIGHTS[allp % 6])
        obj[:K] = 1e-9 * np.array([c[0]["cost"] for c in cands]) / max(float(budget), 1.0)
        ub_v = np.concatenate([np.ones(K), mu_s.reshape(-1)[allp]])
        integ = np.concatenate([np.ones(K), np.zeros(P)])
        n_vars = K + P
        try:
            res = milp(obj, integrality=integ, bounds=Bounds(np.zeros(K + P), ub_v),
                       constraints=LinearConstraint(A, np.concatenate(lb_r), np.concatenate(ub_r)),
                       options={"time_limit": time_limit, "disp": False, "mip_rel_gap": 2e-3})
            status = STATUS.get(res.status, "error")
            gap = getattr(res, "mip_gap", None)
            if res.x is not None:
                sel = [k for k in range(K) if res.x[k] > 0.5]
            else:
                status += "_greedy"
                sel = _greedy(cands, budget, volunteers, max_per_type, ctx)
        except Exception:
            status = "greedy"
            sel = _greedy(cands, budget, volunteers, max_per_type, ctx)

    items, Y, reached = _items(ctx, cands, sel) if sel else ([], np.zeros((S, 6)), np.zeros(S, bool))
    items.sort(key=lambda it: -it["score"])
    tp = pop_s.sum() or 1.0
    before_c = (pop_s[:, None] * mu_s).sum(0) / tp * 100
    after_c = (pop_s[:, None] * (mu_s - Y)).sum(0) / tp * 100
    need_b = model.need[scope_idx]
    need_a = need_b - (Y @ WEIGHTS) * 100
    totals = {
        "cost": int(sum(i["cost"] for i in items)),
        "volunteers": int(sum(i["volunteers"] for i in items)),
        "people_reached": int(round(min(float(pop_s.sum()), sum(i["people_reached"] for i in items)))),
        "need_before": round(float((need_b * pop_s).sum() / tp), 2),
        "need_after": round(float((need_a * pop_s).sum() / tp), 2),
        "by_category": {c: {"before": round(float(before_c[j]), 2), "after": round(float(after_c[j]), 2)} for j, c in enumerate(CATS)},
    }
    imp = (need_b - need_a) >= 0.5  # neighborhoods where the plan removes at least half a need point
    wi = pop_s[imp]
    wsum = float(wi.sum()) or 1.0
    totals["reached_before"] = round(float((need_b[imp] * wi).sum() / wsum), 2) if imp.any() else totals["need_before"]
    totals["reached_after"] = round(float((need_a[imp] * wi).sum() / wsum), 2) if imp.any() else totals["need_after"]
    totals["neighborhoods_improved"] = int(imp.sum())
    tracts = {geo.geoids[g]: {"before": round(float(need_b[l]), 1), "after": round(float(need_a[l]), 1)} for l, g in enumerate(scope_idx)}
    return {
        "scope_label": scope_label,
        "portfolio": items,
        "totals": totals,
        "tracts": tracts,
        "solver": {"method": "milp", "status": status, "time_ms": int((time.perf_counter() - t0) * 1000),
                   "candidates": K, "variables": n_vars,
                   "gap": None if gap is None or not np.isfinite(gap) else round(float(gap), 4)},
    }


def evaluate_single(geo: Geo, model: NeedModel, reports: list[dict], t: dict, site: int) -> dict:
    """PortfolioItem for one intervention at one site (scope = its county)."""
    scope_idx, _ = scope_indices(geo, geo.fips[site])
    ctx = _Ctx(geo, model, reports, scope_idx)
    nb, A, meta = _coverage(geo, ctx.mu, t, site, scope_idx, ctx.stree)
    li, cj = _prune(A)
    cands = [(t, site, nb[li] * 6 + cj, A[li, cj], meta)]
    items, _, _ = _items(ctx, cands, [0])
    return items[0]


def best_site(geo: Geo, model: NeedModel, t: dict, fips: str) -> int:
    """Highest-need populated neighborhood in a county for the type's main category."""
    idx = np.where((geo.fips == fips) & geo.populated)[0]
    e = _effect_vec(t)
    score = model.post[idx] @ e * (geo.pop[idx] > 800)
    return int(idx[int(np.argmax(score))])
