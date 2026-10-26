"""Volunteer matching: need-weighted relevance ranking of opportunities, and sign-ups."""
from __future__ import annotations

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel

from .data import DURHAM, miles_between
from .needs import CATS, LABELS, PHRASE, iso, now_utc
from .projects import fill_role_for, public, skill_fit

_vec_cache: dict = {"key": None}
REMOTE_DISTANCE = 0.45  # remote roles help, but hands-on work within ~10 mi of you ranks higher
REL_SCALE = 0.4  # short queries give small cosines; a cosine of 0.4 already means a strong match


def _doc(o: dict) -> str:
    return " ".join([o["title"], o["description"], " ".join(o["skills"]), LABELS[o["category"]], o["org"]])


def _vectorizer(opps: list[dict]):
    key = tuple(o["id"] for o in opps)
    if _vec_cache["key"] != key:
        vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, stop_words="english")
        X = vec.fit_transform([_doc(o) for o in opps])
        _vec_cache.update(key=key, vec=vec, X=X)
    return _vec_cache["vec"], _vec_cache["X"]


def _join(words: list[str]) -> str:
    words = [w for w in words if w]
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + " and " + words[-1]


def rank(state, lat=None, lon=None, skills=None, interests=None, hours=None, radius=25.0, q=None) -> list[dict]:
    opps = [o for o in state.store.all("opportunities")]
    if not opps:
        return []
    lat = DURHAM[0] if lat is None else lat
    lon = DURHAM[1] if lon is None else lon
    skills = [s.strip().lower() for s in (skills or []) if s.strip()]
    interests = [c for c in (interests or []) if c in CATS]
    radius = max(1.0, float(radius or 25.0))
    hours = None if hours is None else max(0.0, float(hours))
    vec, X = _vectorizer(opps)
    query = " ".join(skills + [LABELS[c] for c in interests] + [q or ""]).strip()
    if query:
        rel = linear_kernel(vec.transform([query]), X)[0]
    else:
        rel = np.full(len(opps), 0.3)
    d = miles_between(lat, lon, np.array([o["lat"] for o in opps]), np.array([o["lon"] for o in opps]))
    geo, model = state.geo, state.model
    out = []
    for k, o in enumerate(opps):
        remote = o["kind"] == "remote"
        if not remote and d[k] > radius:
            continue
        if o["filled"] >= o["spots"]:
            continue
        i = geo.idx.get(o["geoid"])
        j = CATS.index(o["category"])
        # Category percentile (0-1) so that food, housing, ... needs compare on the same scale.
        need = float(model.cat_pct[i, j]) / 100.0 if i is not None else 0.5
        r = float(rel[k]) / REL_SCALE + (0.25 if o["category"] in interests else 0.0)
        r = min(1.0, r)
        dist = REMOTE_DISTANCE if remote else float(np.exp(-d[k] / (radius / 2)))
        avail = 1.0 if hours is None else min(1.0, hours / max(o["hours"], 0.5))
        score = need * (0.35 + 0.65 * r) * dist * avail
        why = []
        if i is not None:
            pct = int(min(99, round(model.cat_pct[i, j])))
            why.append(f"Need for {PHRASE[o['category']]} here is higher than {pct}% of NC")
        _, matched = skill_fit(o["skills"], skills)
        if matched:
            why.append(f"matches your {_join([m.title() if m == 'spanish' else m for m in matched])} skill{'s' if len(matched) > 1 else ''}")
        elif o["category"] in interests:
            why.append(f"matches your interest in {PHRASE[o['category']]}")
        why.append("remote" if remote else f"{d[k]:.1f} mi away")
        if avail < 1:
            why.append(f"asks for {o['hours']:g} h, more than the {hours:g} you have")
        s = "; ".join(why)
        out.append({**o, "score": round(score, 4),
                    "parts": {"need": round(need, 3), "relevance": round(r, 3), "distance": round(dist, 3), "availability": round(avail, 3)},
                    "distance_mi": round(float(d[k]), 1), "why": s[0].upper() + s[1:]})
    out.sort(key=lambda o: -o["score"])
    best = out[0]["score"] if out and out[0]["score"] > 0 else 1.0
    for o in out:  # display score: 1.0 = the best match in this result set
        o["match"] = round(o["score"] / best, 3)
    return out


def signup(state, o: dict, name: str, skills: list[str], hours: float) -> dict:
    if o["filled"] >= o["spots"]:
        raise ValueError("This opportunity is already full")
    at = now_utc()
    vol = {"id": state.new_id("v"), "name": name.strip()[:60] or "A volunteer", "skills": [s.strip().lower() for s in skills if s.strip()],
           "county": o["county"], "fips": o["geoid"][2:5], "hours": float(hours or 2), "lat": o["lat"], "lon": o["lon"],
           "interests": [o["category"]], "created_at": iso(at)}
    state.store.put("volunteers", vol)
    o["filled"] += 1
    state.store.put("opportunities", o)
    project = None
    if o.get("project_id"):
        p = state.store.get("projects", o["project_id"])
        if p and p["status"] != "complete":
            role = fill_role_for(p, vol["id"], vol["skills"] + o["skills"])
            if role:
                p["updates"].append({"at": iso(at), "text": f"{vol['name']} signed up as {role['title'].lower()}."})
            state.store.put("projects", p)
            project = public(p)
    act = state.log("signup", f"{vol['name']} signed up for “{o['title']}” with {o['org']} in {o['county']}.", o["geoid"], o["county"], at=at)
    res = {"opportunity": o, "activity": act}
    if project:
        res["project"] = project
    return res
