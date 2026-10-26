"""Projects: creation from a portfolio item, progress, staffing (Hungarian assignment), briefs, completion."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

import numpy as np
from scipy.optimize import linear_sum_assignment

from . import ai
from .catalog import MILESTONES, ROLES, SLOTS_BY_KIND, kind_style
from .data import MILE, miles_between
from .needs import CATS, LABELS, PHRASE, iso, now_utc, parse_iso

STATUSES = ["proposed", "approved", "in_progress", "complete"]
STAFF_RADIUS_MI = 40.0


def public(p: dict | None) -> dict | None:
    if p is None:
        return None
    return {k: v for k, v in p.items() if not k.startswith("_")}


def progress(p: dict) -> int:
    if p["status"] == "complete":
        return 100
    ms = p["milestones"]
    done = sum(1 for m in ms if m["done"]) / len(ms) if ms else 0.0
    slots = sum(r["slots"] for r in p["roles"])
    filled = sum(min(len(r["filled"]), r["slots"]) for r in p["roles"])
    return int(round(70 * done + 30 * (filled / slots if slots else 0.0)))


def _spec_from_item(item: dict) -> dict:
    cats = item.get("categories") or ["food"]
    return {"key": item["type"], "label": item["label"], "kind": "custom", "categories": cats,
            "effect": {c: (0.2 if k == 0 else 0.12) for k, c in enumerate(cats)}, "reach_mi": 3.0,
            "cost": item.get("cost", 0), "volunteers": item.get("volunteers", 0), "lead_weeks": 6,
            "duration_months": 6, "description": item["label"], "style": "program", "capacity": 500}


def create_project(state, item: dict, scenario: str | None = None, created_at: datetime | None = None) -> dict:
    spec = state.type_spec(item["type"]) or _spec_from_item(item)
    style = kind_style(spec)
    start = created_at or now_utc()
    titles = MILESTONES[style]
    lead_days = max(14, int(spec.get("lead_weeks", 6)) * 7)
    pid = state.new_id("p")
    milestones = [{"id": f"{pid}-m{k + 1}", "title": t, "due": iso(start + timedelta(days=round(lead_days * (k + 1) / len(titles)))), "done": False}
                  for k, t in enumerate(titles)]
    roles, seen = [], set()
    cats = [c for c in (spec.get("categories") or item.get("categories") or []) if c in ROLES]
    for n, c in enumerate(cats[:2]):
        for title, skills in ROLES[c][: (3 if n == 0 else 1)]:
            if title in seen or len(roles) >= 4:
                continue
            seen.add(title)
            roles.append({"id": f"{pid}-r{len(roles) + 1}", "title": title, "skills": skills,
                          "slots": SLOTS_BY_KIND[style], "filled": []})
    p = {
        "id": pid, "title": f"{item['label']} — {item['county']}", "type": item["type"], "label": item["label"],
        "categories": list(spec.get("categories") or item.get("categories") or []), "geoid": item["geoid"],
        "county": item["county"], "lat": item["lat"], "lon": item["lon"], "budget": int(item.get("cost", spec.get("cost", 0))),
        "status": "proposed", "created_at": iso(start), "milestones": milestones, "roles": roles, "progress": 0,
        "expected": {"people_reached": int(item.get("people_reached", 0)), "need_reduction": item.get("need_reduction", {})},
        "brief": None, "brief_engine": None, "scenario": scenario,
        "updates": [{"at": iso(start), "text": "Project created" + (" from a saved plan." if scenario else ".")}],
        "_spec": spec,
    }
    p["progress"] = progress(p)
    state.store.put("projects", p)
    state.log("project", f"New project proposed: {p['title']} — expected to reach {p['expected']['people_reached']:,} people.",
              p["geoid"], p["county"], at=start)
    return p


def patch_project(state, p: dict, status=None, milestone_id=None, done=None, note=None) -> dict:
    at = now_utc()
    if status is not None:
        if status not in STATUSES:
            raise ValueError(f"status must be one of {', '.join(STATUSES)}")
        if status == "complete":
            raise ValueError("Use POST /projects/{id}/complete to complete a project")
        if status != p["status"]:
            p["status"] = status
            nice = status.replace("_", " ")
            p["updates"].append({"at": iso(at), "text": f"Status changed to {nice}."})
            state.log("project", f"{p['title']} is now {nice}.", p["geoid"], p["county"], at=at)
    if milestone_id is not None:
        m = next((m for m in p["milestones"] if m["id"] == milestone_id), None)
        if m is None:
            raise KeyError("Unknown milestone")
        m["done"] = True if done is None else bool(done)
        p["updates"].append({"at": iso(at), "text": f"Milestone {'done' if m['done'] else 'reopened'}: {m['title']}."})
        if m["done"] and p["status"] in ("proposed", "approved"):
            p["status"] = "in_progress"
    if note:
        p["updates"].append({"at": iso(at), "text": str(note)[:500]})
    p["progress"] = progress(p)
    state.store.put("projects", p)
    return p


# ---- staffing ----------------------------------------------------------------------------------------------
def _norm(skills) -> set[str]:
    return {s.strip().lower() for s in skills if s and s.strip()}


def skill_fit(role_skills, vol_skills) -> tuple[float, list[str]]:
    R, V = _norm(role_skills), _norm(vol_skills)
    match = sorted(R & V)
    if not R:
        return 0.0, []
    cover = len(match) / len(R)
    jac = len(match) / len(R | V) if (R | V) else 0.0
    return 0.7 * cover + 0.3 * jac, match


def staff_project(state, p: dict) -> dict:
    slots = []
    for r in p["roles"]:
        for _ in range(max(0, r["slots"] - len(r["filled"]))):
            slots.append(r)
    taken = {v for r in p["roles"] for v in r["filled"]}
    vols = [v for v in state.store.all("volunteers") if v["id"] not in taken]
    if not slots or not vols:
        return {"project": public(p), "assignments": [], "total_fit": 0.0}
    vlat = np.array([v["lat"] for v in vols]); vlon = np.array([v["lon"] for v in vols])
    d = miles_between(p["lat"], p["lon"], vlat, vlon)
    near = np.where(d <= STAFF_RADIUS_MI)[0]
    if len(near) == 0:
        return {"project": public(p), "assignments": [], "total_fit": 0.0}
    F = np.zeros((len(slots), len(near)))
    for a, r in enumerate(slots):
        for b, j in enumerate(near):
            sk, _ = skill_fit(r["skills"], vols[j]["skills"])
            prox = max(0.0, 1 - d[j] / STAFF_RADIUS_MI)
            hrs = min(1.0, vols[j].get("hours", 2) / 4.0)
            F[a, b] = 0.5 * sk + 0.3 * prox + 0.2 * hrs
    rows, cols = linear_sum_assignment(-F)
    out, total = [], 0.0
    for a, b in zip(rows, cols):
        r, v = slots[a], vols[near[b]]
        sk, match = skill_fit(r["skills"], v["skills"])
        if F[a, b] < 0.35 or sk == 0:
            continue
        r["filled"].append(v["id"])
        reasons = [f"Has {', '.join(match)} skills" if match else "Willing to learn",
                   f"{d[near[b]]:.1f} mi away", f"Available {v.get('hours', 2)} h/week"]
        out.append({"role_id": r["id"], "role": r["title"],
                    "volunteer": {"id": v["id"], "name": v["name"], "skills": v["skills"], "county": v["county"], "hours": v.get("hours", 2)},
                    "fit": round(float(F[a, b]), 3), "reasons": reasons})
        total += float(F[a, b])
    if out:
        p["updates"].append({"at": iso(now_utc()), "text": f"Matched {len(out)} volunteers to open roles."})
        p["progress"] = progress(p)
        state.store.put("projects", p)
        state.log("project", f"{len(out)} volunteers were matched to roles on {p['title']}.", p["geoid"], p["county"])
    return {"project": public(p), "assignments": out, "total_fit": round(total, 3)}


def fill_role_for(p: dict, vol_id: str, skills: list[str]) -> dict | None:
    open_roles = [r for r in p["roles"] if len(r["filled"]) < r["slots"]]
    if not open_roles:
        return None
    best = max(open_roles, key=lambda r: skill_fit(r["skills"], skills)[0])
    best["filled"].append(vol_id)
    p["progress"] = progress(p)
    return best


# ---- completion ----------------------------------------------------------------------------------------------
def complete_project(state, p: dict, at: datetime | None = None) -> dict:
    at = at or now_utc()
    geo, model = state.geo, state.model
    spec = p["_spec"]
    sigma = float(spec.get("reach_mi", 3.0))
    x, y = geo.xy(p["lat"], p["lon"])
    region = geo.near(x, y, 3 * sigma * MILE)
    region = region[geo.populated[region]]
    before_post = model.post[region].copy()
    need_before = model.pop_mean_need(region) if len(region) else 0.0
    from .optimize import allocate

    # Same rule as the optimizer: serve the nearest neighborhoods fully until capacity runs out.
    gidx, frac, ker, served, cap = allocate(geo, spec, x, y)
    eff = {c: float(v) for c, v in spec["effect"].items() if v and v > 0}
    served_idx = [int(g) for g, f in zip(gidx, frac) if f > 0]
    tracts = {geo.geoids[int(g)]: {c: round(e * float(f * kk), 5) for c, e in eff.items()}
              for g, f, kk in zip(gidx, frac, ker) if f > 0}
    state.store.put("adjustments", {"id": f"adj-{p['id']}", "project_id": p["id"], "lat": p["lat"], "lon": p["lon"],
                                    "sigma_mi": sigma, "effect": eff, "tracts": tracts, "capacity_scale": 1.0,
                                    "allocation": "nearest_first", "people_served": int(round(served)), "created_at": iso(at)})
    # Reports this project addresses keep only part of their weight.
    cats = set(eff)
    changed = []
    for r in state.store.all("reports"):
        if r["status"] == "open" and r["primary"] in cats and parse_iso(r["created_at"]) <= at:
            if r["geoid"] in tracts:
                r["status"] = "addressed"
                changed.append(r)
    if changed:
        state.store.put_many("reports", changed)
    state.rebuild()
    after_post = model.post[region]
    need_after = model.pop_mean_need(region) if len(region) else 0.0
    changes = []
    for k, i in enumerate(region):
        for c in cats:
            j = CATS.index(c)
            b, a = before_post[k, j] * 100, after_post[k, j] * 100
            if b - a >= 0.1:
                changes.append({"geoid": geo.geoids[i], "county": geo.county[i], "category": c, "before": round(b, 1), "after": round(a, 1)})
    changes.sort(key=lambda ch: ch["after"] - ch["before"])
    for m in p["milestones"]:
        m["done"] = True
    p["status"] = "complete"
    p["progress"] = 100
    main = spec["categories"][0] if spec.get("categories") else next(iter(cats), "food")
    p["updates"].append({"at": iso(at), "text": f"Completed. Served about {int(round(served, -1)):,} people in {len(served_idx)} nearby neighborhood{'s' if len(served_idx) != 1 else ''}; need within its reach fell from {need_before:.1f} to {need_after:.1f}."})
    state.store.put("projects", p)
    j = CATS.index(main)
    served_set = set(served_idx)
    core = np.array([int(i) in served_set for i in region], dtype=bool) if len(region) else np.zeros(0, bool)
    if not core.any():
        core = np.ones(len(region), bool)
    w = geo.pop[region][core]
    mb = float((before_post[core, j] * w).sum() / max(w.sum(), 1) * 100) if len(region) else 0
    ma = float((after_post[core, j] * w).sum() / max(w.sum(), 1) * 100) if len(region) else 0
    fmt = (lambda v: f"{v:.0f}") if round(mb) != round(ma) else (lambda v: f"{v:.1f}")
    state.log("complete", f"{p['title']} was completed — {PHRASE[main]} need nearby fell from {fmt(mb)} to {fmt(ma)}.",
              p["geoid"], p["county"], at=at)
    return {"project": public(p), "changes": changes[:200], "need_before": round(need_before, 2), "need_after": round(need_after, 2)}


# ---- briefs ----------------------------------------------------------------------------------------------------
RISKS = {
    "no_transportation": "**Residents can't get there.** Pick a stop within walking distance of the highest-need blocks, and pair with ride vouchers.",
    "hours": "**Hours don't fit work schedules.** Run at least one evening or Saturday shift.",
    "language": "**Spanish-speaking neighbors may not come.** Recruit interpreters and print every flyer in English and Spanish.",
    "cost": "**Hidden costs keep people away.** Keep it free, with no fees or purchase required.",
    "eligibility": "**Paperwork turns people away.** Ask for as little ID and income proof as possible; allow self-declared eligibility.",
    "information": "**People don't hear about it.** Flyers at schools, churches, laundromats and bus stops, plus text reminders.",
    "distance": "**Still too far for some.** Rotate between two locations or add a second stop.",
    "disability": "**Access for people with disabilities.** Use an accessible site with seating, and offer a delivery option.",
    "safety": "**Safety concerns.** Choose a well-lit, familiar site and work with trusted neighborhood leaders.",
    "waitlist": "**Demand outgrows capacity.** Keep a waitlist with text updates and add sessions when lines grow.",
    "closure": "**It ends like past services did.** Line up a second funder before launch and share results publicly.",
}
MEASURES = {
    "food": "Households served each month, and the share who report skipping fewer meals (2-question survey).",
    "health": "Patients seen, screenings done, and referrals that turned into a real appointment.",
    "transit": "Rides given, and missed appointments or shifts that residents report.",
    "digital": "Devices or hotspots loaned, and people who finished an online application.",
    "housing": "Tenants helped, and evictions avoided or delayed.",
    "childcare": "Children served, and parents who kept or started a job.",
}


def brief_facts(state, p: dict) -> dict:
    geo, model = state.geo, state.model
    i = geo.idx[p["geoid"]]
    spec = p["_spec"]
    sigma = float(spec.get("reach_mi", 3.0))
    x, y = geo.xy(p["lat"], p["lon"])
    region = geo.near(x, y, 2 * sigma * MILE)
    region = region[geo.populated[region]]
    cats = list(spec.get("categories") or p["categories"])
    reps = []
    for r in state.store.all("reports"):
        dmi = float(miles_between(p["lat"], p["lon"], r["lat"], r["lon"]))
        if dmi <= max(3.0, 2 * sigma) and (r["primary"] in cats or set(cats) & set(r["categories"])):
            reps.append(r)
    reps.sort(key=lambda r: (-r["severity"], r["created_at"]), reverse=False)
    bar = Counter(b for r in reps for b in r["barriers"])
    grp = Counter(g for r in reps for g in r["groups"])
    fips = geo.fips[i]
    orgs = [o for o in state.store.all("orgs") if o["fips"] == fips and set(o["categories"]) & set(cats)]
    match = bool(orgs)
    if not orgs:
        orgs = [o for o in state.store.all("orgs") if o["fips"] == fips][:2]
    quote = None
    if reps:
        q = sorted(reps, key=lambda r: (-r["severity"], -parse_iso(r["created_at"]).timestamp()))[0]
        txt = q["text"] if len(q["text"]) <= 170 else q["text"][:167].rsplit(" ", 1)[0] + "…"
        quote = {"text": txt, "date": q["created_at"][:10]}
    by = {c: {"need": round(float(model.post[i, CATS.index(c)] * 100), 1), "pct": round(float(model.cat_pct[i, CATS.index(c)]))} for c in cats}
    return {
        "project": p["title"], "intervention": spec.get("label"), "description": spec.get("description"),
        "county": p["county"], "budget": p["budget"], "status": p["status"],
        "need_index": round(float(model.need[i]), 1), "need_pct": round(float(model.pct[i])),
        "hardship_pct": None if np.isnan(geo.hardship_raw[i]) else round(float(geo.hardship_raw[i])),
        "category_need": by, "population_within_reach": int(geo.pop[region].sum()), "neighborhoods_within_reach": int(len(region)),
        "reach_mi": sigma, "no_car_pct": None if np.isnan(geo.no_car[i]) else round(float(geo.no_car[i]), 1),
        "poverty_pct": None if np.isnan(geo.poverty[i]) else round(float(geo.poverty[i]), 1),
        "reports_nearby": len(reps), "top_barriers": bar.most_common(4), "groups": grp.most_common(3), "quote": quote,
        "milestones": [{"title": m["title"], "due": m["due"][:10], "done": m["done"]} for m in p["milestones"]],
        "roles": [{"title": r["title"], "slots": r["slots"], "filled": len(r["filled"])} for r in p["roles"]],
        "partners": [{"name": o["name"], "focus": o["description"]} for o in orgs],
        "partners_match": match, "expected": p["expected"], "categories": cats,
    }


def local_brief(f: dict) -> str:
    cats = f["categories"] or ["food"]
    main = cats[0]
    L = [f"# {f['project']}", ""]
    L += ["## Situation"]
    mc = f["category_need"].get(main)
    s = f"This {f['intervention'].lower()} would serve a neighborhood in {f['county']}"
    if mc:
        s += f" where **{LABELS[main].lower()} need is {mc['need']:.0f}** — higher than {mc['pct']}% of North Carolina neighborhoods"
    s += f". Its overall need index is {f['need_index']:.0f} (higher than {f['need_pct']}% of NC)"
    s += f" and its hardship score is {f['hardship_pct']} of 100." if f["hardship_pct"] is not None else "."
    L.append(s)
    L.append(f"About **{f['population_within_reach']:,} people** live in the {f['neighborhoods_within_reach']} neighborhoods within "
             f"{2 * f['reach_mi']:g} miles of the site.")
    stats = []
    for c, v in f["category_need"].items():
        if c == main:
            continue
        stats.append(f"{LABELS[c].lower()} need {v['need']:.0f} (higher than {v['pct']}% of NC)")
    if stats:
        L.append("- Model estimate here: " + "; ".join(stats) + ".")
    if f["no_car_pct"] is not None and "transit" in cats:
        L.append(f"- {f['no_car_pct']:.0f}% of households in the neighborhood have no car.")
    if f["poverty_pct"] is not None:
        L.append(f"- {f['poverty_pct']:.0f}% of residents live below the poverty line.")
    if f["reports_nearby"]:
        bars = ", ".join(f"{b.replace('_', ' ')} ({n})" for b, n in f["top_barriers"]) or "none named"
        L.append(f"- Residents nearby filed **{f['reports_nearby']} reports** about {', '.join(LABELS[c].lower() for c in cats)}. "
                 f"Barriers they named most: {bars}.")
        if f["groups"]:
            L.append("- Groups mentioned most: " + ", ".join(f"{g.replace('_', ' ')} ({n})" for g, n in f["groups"]) + ".")
    if f["quote"]:
        L += ["", f"> \"{f['quote']['text']}\" — resident report, {f['quote']['date']}"]
    L += ["", "## Goal"]
    red = f["expected"].get("need_reduction") or {}
    red_txt = ", ".join(f"{LABELS[c].lower()} by about {v:.1f} points" for c, v in red.items()) or "measurably"
    L.append(f"Reach about **{f['expected'].get('people_reached', 0):,} people** and lower unmet need for those residents — "
             f"{red_txt} — during its first year. Budget: **${f['budget']:,}**.")
    L += ["", "## Plan"]
    for m in f["milestones"]:
        L.append(f"- [{'x' if m['done'] else ' '}] {m['title']} — by {m['due']}")
    if f["roles"]:
        L.append("")
        L.append("Volunteer roles: " + "; ".join(f"{r['title']} ({r['filled']}/{r['slots']} filled)" for r in f["roles"]) + ".")
    L += ["", "## Partners"]
    if f["partners"] and not f.get("partners_match"):
        L.append(f"No {LABELS[main].lower()}-focused groups are listed in {f['county']} yet. These local groups could help with outreach:")
    if f["partners"]:
        for o in f["partners"]:
            L.append(f"- **{o['name']}** — {o['focus']}")
    else:
        L.append(f"- No partner organizations are listed in {f['county']} yet; start with schools, churches and the county library.")
    L += ["", "## Risks & mitigations"]
    used = [b for b, _ in f["top_barriers"] if b in RISKS][:3]
    for b in used:
        L.append(f"- {RISKS[b]}")
    L.append("- **Volunteers drop off.** Keep shifts short, keep a backup list, and thank people publicly.")
    L += ["", "## How we'll measure success"]
    for c in cats[:2]:
        L.append(f"- {MEASURES.get(c, MEASURES['food'])}")
    L.append(f"- Allocate NC check: the need index here is {f['need_index']:.0f} today. After completion the model applies the "
             f"project's effect and new resident reports nearby should turn milder; we'll compare at 3 and 6 months.")
    return "\n".join(L)


def make_brief(state, p: dict) -> dict:
    facts = brief_facts(state, p)
    text = ai.brief(facts)
    engine = "claude"
    if not text:
        text, engine = local_brief(facts), "local"
    p["brief"], p["brief_engine"] = text, engine
    p["updates"].append({"at": iso(now_utc()), "text": "Project brief written."})
    state.store.put("projects", p)
    return p
