"""Deterministic demo data: simulated resident reports, fictional organizations, opportunities, volunteers,
projects in different stages, and an activity feed. All people and organizations are invented."""
from __future__ import annotations

import itertools
import random
import re
from datetime import datetime, timedelta

import numpy as np

from .catalog import BY_KEY, CATALOG
from .corpus import (DURHAM_FEATURED, FIRST_NAMES, LAST_INITIALS, OPP_TEMPLATES, ORGS, PREFIXES, SKILL_POOL, SLOTS,
                     SUFFIXES, TEMPLATES)
from .needs import CATS, PHRASE, iso, now_utc
from .optimize import best_site, evaluate_single, optimize
from .projects import brief_facts, complete_project, create_project, local_brief, progress, skill_fit

FOCUS = [("063", 25), ("135", 12), ("183", 14), ("155", 14), ("065", 12), ("083", 11), ("119", 16), ("081", 13),
         ("051", 13), ("147", 11), ("021", 11)]
SCATTERED = 48
VOL_COUNTIES = [("063", 18), ("135", 10), ("183", 12), ("155", 8), ("065", 6), ("083", 5), ("119", 10), ("081", 7),
                ("051", 6), ("147", 4), ("021", 4)]
PERSONAS = [["driving", "reliable car"], ["spanish", "interpreting"], ["nursing", "medical", "cpr"],
            ["tech support", "computer repair", "teaching"], ["legal", "paralegal"], ["childcare", "cpr", "tutoring"],
            ["organizing", "scheduling", "phone"], ["lifting", "packing", "customer service"],
            ["outreach", "social media", "spanish"], ["data entry", "customer service"], ["carpentry", "construction"],
            ["cooking", "organizing"]]
WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Saturdays"]


def _fill(tpl: str, rng: random.Random) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: rng.choice(SLOTS[m.group(1)]), tpl)


def _hour(h: int) -> str:
    return f"{(h - 1) % 12 + 1} {'AM' if h < 12 else 'PM'}"


def seed(state) -> None:
    store, geo, model, nlp = state.store, state.geo, state.model, state.nlp
    counter = itertools.count(1)
    state.new_id = lambda prefix: f"{prefix}-{next(counter):04d}"  # deterministic ids while seeding
    try:
        _seed(state, store, geo, model, nlp)
    finally:
        del state.new_id


def _seed(state, store, geo, model, nlp) -> None:
    store.clear()
    model.reset_state()
    rng = random.Random(2026)
    nrng = np.random.default_rng(2026)
    now = now_utc().replace(microsecond=0)

    # ---- organizations ---------------------------------------------------------------------------------------
    orgs = [{"id": f"org-{k + 1:02d}", "name": n, "fips": f, "county": geo.county_name(f), "categories": cats, "description": d}
            for k, (n, f, cats, d) in enumerate(ORGS)]
    store.put_many("orgs", orgs)

    # ---- resident reports ----------------------------------------------------------------------------------------
    need0 = model.need.copy() / 100.0
    post0 = model.post.copy()

    def pick_tract(fips: str, power: float = 4.0) -> int:
        idx = np.where((geo.fips == fips) & (geo.pop > 300))[0]
        w = need0[idx] ** power * np.sqrt(geo.pop[idx])
        return int(idx[nrng.choice(len(idx), p=w / w.sum())])

    by_cat = {c: [t for k, t in TEMPLATES if k == c] for c in CATS}
    raw = []  # (days_ago, text, tract)
    # Durham featured cluster: the highest-need Durham neighborhood and its neighbors.
    d_idx = np.where((geo.fips == "063") & (geo.pop > 300))[0]
    core = int(d_idx[np.argmax(need0[d_idx])])
    ring = geo.near(geo.x[core], geo.y[core], 2.0 * 1609.344)
    ring = [int(i) for i in ring if geo.fips[i] == "063" and geo.pop[i] > 300] or [core]
    for k, (_, text) in enumerate(DURHAM_FEATURED):
        raw.append((0.3 + k * 0.9, text, ring[k % len(ring)]))
    plan = list(FOCUS)
    plan[0] = ("063", FOCUS[0][1] - len(DURHAM_FEATURED))
    others = [f for f in geo.county_names if f not in dict(FOCUS)]
    mean_need = {f: float(need0[(geo.fips == f) & geo.populated].mean()) for f in others if ((geo.fips == f) & geo.populated).any()}
    rural = sorted(mean_need, key=lambda f: -mean_need[f])[:22]
    for k in range(SCATTERED):
        plan.append((rural[k % len(rural)], 1))
    for fips, n in plan:
        for _ in range(n):
            i = pick_tract(fips, 6.0 if fips == "063" else 4.0)
            w = post0[i] ** 2
            c = CATS[int(nrng.choice(6, p=w / w.sum()))]
            tpl = rng.choice(by_cat[c])
            text = _fill(tpl, rng)
            spanish = bool(re.search(r"\b(mi|mis|no tenemos|nadie)\b", text))
            if not spanish:
                pre = rng.choice(PREFIXES)
                if pre.endswith(", ") and not re.match(r"(I\b|I'|SNAP|Route|Head Start|Mi |No )", text):
                    text = text[0].lower() + text[1:]
                text = pre + text + rng.choice(SUFFIXES)
            days = 90 * rng.random() ** 1.3
            raw.append((days, text, i))
    raw.sort(key=lambda r: -r[0])  # oldest first
    report_events = []
    for k, (days, text, i) in enumerate(raw):
        lat, lon = geo.random_point(i, nrng)
        created = now - timedelta(days=days, minutes=rng.randint(0, 600))
        conf = rng.choice([0, 0, 0, 0, 1, 1, 2, 3, 4, 6])
        r = state.make_report(text, lat, lon, extraction=nlp.extract_local(text), created_at=created, confirmations=conf,
                              rid=f"r-{k + 1:04d}")
        if r["geoid"] != geo.geoids[i]:
            r["geoid"], r["county"] = geo.geoids[i], geo.county[i]
        before = state._snapshot(r)
        store.put("reports", r)
        model.add_report(r)
        report_events.append((r, state._change(r, before), created))
    for r, ch, created in report_events[-16:]:
        state.log("report", state.report_activity_text(r, ch), r["geoid"], r["county"], at=created)

    # ---- volunteers -------------------------------------------------------------------------------------------
    vols = []
    names = iter(itertools.cycle(FIRST_NAMES))
    for fips, n in VOL_COUNTIES:
        for _ in range(n):
            i = pick_tract(fips, 1.0)
            lat, lon = geo.random_point(i, nrng)
            skills = list(dict.fromkeys(sum(rng.sample(PERSONAS, rng.choice([1, 1, 2])), []) + rng.sample(SKILL_POOL, rng.choice([0, 1]))))
            interests = rng.sample(CATS, rng.choice([1, 2, 3]))
            vols.append({"id": f"v-{len(vols) + 1:04d}", "name": f"{next(names)} {rng.choice(LAST_INITIALS)}.", "skills": skills,
                         "county": geo.county_name(fips), "fips": fips, "hours": rng.choice([2, 2, 3, 4, 4, 5, 6, 8, 10, 12]),
                         "lat": lat, "lon": lon, "interests": interests,
                         "created_at": iso(now - timedelta(days=rng.randint(5, 120)))})
    store.put_many("volunteers", vols)

    # ---- projects -------------------------------------------------------------------------------------------------
    specs = [  # fips, type, status, days ago, milestones done, role fill fraction
        ("063", "mobile_market", "in_progress", 24, 2, 0.5),
        ("063", "ride_vouchers", "approved", 12, 0, 0.17),
        ("135", "hotspot_lending", "proposed", 5, 0, 0.0),
        ("155", "popup_clinic", "in_progress", 30, 3, 0.6),
        ("065", "kid_meal_kits", "in_progress", 75, 5, 1.0),  # completed below
        ("183", "tenant_legal", "proposed", 3, 0, 0.0),
    ]
    reports_all = store.all("reports")
    projects = {}
    for fips, key, status, days, ndone, fill in specs:
        t = BY_KEY[key]
        site = best_site(geo, model, t, fips)
        item = evaluate_single(geo, model, reports_all, t, site)
        start = now - timedelta(days=days)
        p = create_project(state, item, None, created_at=start)
        if status != "proposed":
            at = start + timedelta(days=2)
            p["updates"].append({"at": iso(at), "text": "Status changed to approved."})
            state.log("project", f"{p['title']} was approved.", p["geoid"], p["county"], at=at)
        if status == "in_progress":
            at = start + timedelta(days=6)
            p["updates"].append({"at": iso(at), "text": "Status changed to in progress."})
            state.log("project", f"{p['title']} is now in progress.", p["geoid"], p["county"], at=at)
        p["status"] = status
        for m in p["milestones"][:ndone]:
            m["done"] = True
            p["updates"].append({"at": iso(min(now, parse_due(m["due"]) - timedelta(days=1))), "text": f"Milestone done: {m['title']}."})
        pool = [v for v in vols if v["fips"] == fips]
        used = set()
        for r in p["roles"]:
            want = int(round(r["slots"] * fill))
            ranked = sorted((v for v in pool if v["id"] not in used), key=lambda v: -skill_fit(r["skills"], v["skills"])[0])
            for v in ranked[:want]:
                r["filled"].append(v["id"])
                used.add(v["id"])
        p["progress"] = progress(p)
        if status in ("in_progress",):
            p["brief"], p["brief_engine"] = local_brief(brief_facts(state, p)), "local"
        store.put("projects", p)
        projects[key] = p

    # ---- opportunities ------------------------------------------------------------------------------------------
    def opp_tract(fips: str) -> int:
        idx = np.where((geo.fips == fips) & (geo.pop > 300))[0]
        top = idx[np.argsort(-need0[idx])[:12]]
        return int(top[rng.randrange(len(top))])

    def when_for(kind: str):
        if kind == "event":
            d = now + timedelta(days=rng.randint(3, 42))
            h = rng.choice([9, 10, 13, 17])
            dur = rng.choice([2, 3, 4])
            start = d.replace(hour=h, minute=0, second=0)
            return f"{start:%a, %b} {start.day} · {_hour(h)}–{_hour(h + dur)}", iso(start)
        if kind == "ongoing":
            h = rng.choice([9, 10, 16, 17])
            return f"{rng.choice(WEEKDAYS)} · {_hour(h)}–{_hour(h + 3)}, ongoing", None
        return "Flexible hours · remote", None

    opps = []

    def add_opp(org, cat, kind, title, desc, skills, hours, project=None, tract=None):
        i = tract if tract is not None else opp_tract(org["fips"])
        lat, lon = geo.random_point(i, nrng)
        when, date = when_for(kind)
        spots = rng.choice([4, 6, 8, 10, 12, 15, 20])
        opps.append({"id": f"o-{len(opps) + 1:04d}", "org": org["name"], "title": title, "description": desc, "category": cat,
                     "kind": kind, "geoid": geo.geoids[i], "county": geo.county[i], "lat": lat, "lon": lon, "when": when,
                     "date": date, "hours": hours, "skills": skills, "spots": spots, "filled": rng.randint(0, spots // 2),
                     "project_id": project["id"] if project else None, "url": None})

    org_by = {o["name"]: o for o in orgs}
    linked = [
        ("Bull City Community Pantry Network", "mobile_market", "food", "ongoing", "Mobile market driver",
         "Drive the mobile market truck on its twice-a-month route through East Durham.", ["driving", "reliable car"], 4),
        ("Bull City Community Pantry Network", "mobile_market", "food", "event", "Mobile market packing crew",
         "Pack produce boxes before the mobile market leaves the warehouse.", ["packing", "lifting", "organizing"], 3),
        ("Bull City Care Riders", "ride_vouchers", "transit", "ongoing", "Ride voucher dispatcher",
         "Take ride requests by phone and match them to drivers for the new ride voucher program.", ["scheduling", "phone", "organizing"], 3),
        ("Lumber River Health Outreach", "popup_clinic", "health", "event", "Pop-up clinic interpreter",
         "Interpret for Spanish-speaking patients at the monthly pop-up clinic.", ["spanish", "interpreting"], 4),
    ]
    for oname, pkey, cat, kind, title, desc, skills, hours in linked:
        p = projects[pkey]
        add_opp(org_by[oname], cat, kind, title, desc, skills, hours, project=p, tract=geo.idx[p["geoid"]])
    for k, org in enumerate(orgs):
        pool = [(c, t) for c in org["categories"] for t in OPP_TEMPLATES[c]]
        for c, (kind, title, desc, skills, hours) in rng.sample(pool, min(len(pool), 3 if k % 3 == 0 else 2)):
            add_opp(org, c, kind, title, desc, skills, hours)
    store.put_many("opportunities", opps)

    # ---- history: sign-ups, completion, a plan, county summaries ----------------------------------------------
    for o in rng.sample(opps, 5):
        v = rng.choice([v for v in vols if v["fips"] == o["geoid"][2:5]] or vols)
        state.log("signup", f"{v['name']} signed up for “{o['title']}” with {o['org']} in {o['county']}.", o["geoid"], o["county"],
                  at=now - timedelta(days=rng.randint(1, 20), hours=rng.randint(0, 12)))
    edge = projects["kid_meal_kits"]
    edge["brief"], edge["brief_engine"] = local_brief(brief_facts(state, edge)), "local"
    complete_project(state, edge, at=now - timedelta(days=9))

    for fips in ("063", "155", "119"):
        idx = np.where((geo.fips == fips) & geo.populated)[0]
        best = None
        for j in range(6):
            sel = idx[model.sumW[idx, j] > 0.25]
            if len(sel) < 2:
                continue
            w = geo.pop[sel]
            b = float((model.prior[sel, j] * w).sum() / w.sum() * 100)
            a = float((model.post[sel, j] * w).sum() / w.sum() * 100)
            if best is None or a - b > best[0]:
                best = (a - b, j, sel, b, a)
        if best is None or best[0] < 1.0:
            continue
        _, j, sel, b, a = best
        nrep = sum(1 for r in store.all("reports") if r["geoid"][2:5] == fips and r["primary"] == CATS[j])
        state.log("need", f"Resident reports raised {PHRASE[CATS[j]]} need in {len(sel)} {geo.county_name(fips)} neighborhoods "
                          f"from {b:.0f} to {a:.0f} over the last 90 days ({nrep} report{'s' if nrep != 1 else ''}).",
                  None, geo.county_name(fips), at=now - timedelta(hours=20))

    res = optimize(geo, model, store.all("reports"), "063", 250_000, 300, CATALOG, 3)
    name = "Durham County — $250k starter plan"
    sc = {"id": "s-0001", "name": name, "scope": "063", "budget": 250_000, "volunteers": 300, "created_at": iso(now - timedelta(days=2)),
          "portfolio": res["portfolio"], "totals": res["totals"]}
    store.put("scenarios", sc)
    tot = res["totals"]
    state.log("plan", f"A planner ran “{name}”: {len(res['portfolio'])} actions reaching {tot['people_reached']:,} people; "
                      f"need would fall from {tot['need_before']:.1f} to {tot['need_after']:.1f}.", None, "Durham County",
              at=now - timedelta(days=2))


def parse_due(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
