"""Allocate NC API. Run from the project root:  .venv/bin/uvicorn server.main:app --port 8000"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import ai
from .catalog import BY_KEY, CATALOG, capacity_of
from .match import rank, signup
from .needs import CATS, PHRASE, iso, now_utc
from .nlp import BARRIERS, GROUPS
from .optimize import optimize
from .projects import complete_project, create_project, make_brief, patch_project, public, staff_project

log = logging.getLogger("allocate")
STATE: Any = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global STATE
    from .state import State

    t0 = time.perf_counter()
    STATE = State()
    log.warning("Allocate NC ready in %.1fs (%d reports, engine=%s)", time.perf_counter() - t0,
                STATE.store.count("reports"), "claude" if ai.enabled() else "local")
    yield


app = FastAPI(title="Allocate NC API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"],
    allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError):
    msgs = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x not in ("body", "query", "path"))
        msgs.append(f"{loc}: {e.get('msg')}" if loc else str(e.get("msg")))
    return JSONResponse(status_code=422, content={"detail": "; ".join(msgs) or "Invalid request"})


@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception):
    log.exception("Unhandled error")
    return JSONResponse(status_code=500, content={"detail": f"Server error: {type(exc).__name__}"})


def S():
    if STATE is None:
        raise HTTPException(503, "Server is still starting")
    return STATE


def _get(coll: str, id_: str, what: str) -> dict:
    o = S().store.get(coll, id_)
    if o is None:
        raise HTTPException(404, f"{what} not found")
    return o


# ---- request bodies --------------------------------------------------------------------------------------------
class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ReportIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    lat: float = Field(ge=33.0, le=37.5)
    lon: float = Field(ge=-85.0, le=-75.0)
    extraction: Optional[dict] = None


class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    skills: list[str] = []
    hours: float = Field(default=2, ge=0, le=80)


class OptimizeIn(BaseModel):
    scope: str = "nc"
    budget: float = Field(ge=0, le=1e9)
    volunteers: float = Field(ge=0, le=1e6)
    types: list[str] = []
    custom: Optional[list[dict]] = None
    max_per_type: int = Field(default=3, ge=1, le=20)
    name: Optional[str] = None


class ProjectIn(BaseModel):
    item: dict
    scenario: Optional[str] = None


class PatchIn(BaseModel):
    status: Optional[Literal["proposed", "approved", "in_progress", "complete"]] = None
    milestone_id: Optional[str] = None
    done: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=1000)


# ---- sanitizers ------------------------------------------------------------------------------------------------------
def _clean_extraction(d: dict, text: str) -> dict:
    st = S()
    cats = [c for c in d.get("categories", []) if c in CATS]
    primary = d.get("primary") if d.get("primary") in CATS else (cats[0] if cats else None)
    if not primary:
        return st.nlp.extract(text)
    if primary not in cats:
        cats = [primary] + cats
    try:
        sev = int(min(5, max(1, int(d.get("severity", 3)))))
        conf = float(min(1.0, max(0.0, float(d.get("confidence", 0.7)))))
    except (TypeError, ValueError):
        raise HTTPException(422, "extraction.severity and extraction.confidence must be numbers")
    return {
        "categories": cats[:3], "primary": primary, "severity": sev,
        "urgency": d.get("urgency") if d.get("urgency") in ("low", "medium", "high") else "medium",
        "barriers": [b for b in d.get("barriers", []) if b in BARRIERS],
        "groups": [g for g in d.get("groups", []) if g in GROUPS],
        "summary": str(d.get("summary") or "")[:120] or st.nlp.extract_local(text)["summary"],
        "confidence": round(conf, 2), "engine": d.get("engine") if d.get("engine") in ("claude", "local") else "local",
    }


def _clean_custom(t: dict) -> dict:
    try:
        cats = [c for c in t.get("categories", []) if c in CATS]
        eff = {c: float(min(0.6, max(0.0, float((t.get("effect") or {}).get(c, 0) or 0)))) for c in CATS}
        if not any(eff.values()):
            for k, c in enumerate(cats):
                eff[c] = 0.2 if k == 0 else 0.12
        if not cats:
            cats = [c for c in CATS if eff[c] > 0]
        if not cats:
            raise ValueError("custom intervention needs at least one category")
        key = str(t.get("key") or "")
        if not key.startswith("custom-"):
            key = "custom-" + (key or str(abs(hash(str(t.get("label")))) % 10**6))
        dur = t.get("duration_months")
        return {"key": key[:80], "label": str(t.get("label") or "Custom action")[:80], "kind": "custom", "categories": cats,
                "effect": eff, "reach_mi": float(min(20, max(0.25, float(t.get("reach_mi", 3))))),
                "cost": int(max(0, float(t.get("cost", 0)))), "volunteers": int(max(0, float(t.get("volunteers", 0)))),
                "lead_weeks": int(max(1, float(t.get("lead_weeks", 4)))), "duration_months": None if dur is None else int(dur),
                "description": str(t.get("description") or "")[:500], "style": t.get("style"),
                "capacity": int(max(10, float(t.get("capacity") or capacity_of({"kind": "custom", "style": t.get("style"), "duration_months": dur}))))}
    except (TypeError, ValueError) as e:
        raise HTTPException(422, f"Invalid custom intervention: {e}")


# ---- routes -----------------------------------------------------------------------------------------------------------
@app.get("/api/health")
def health():
    st = S()
    return {"ok": True, "ai_engine": "claude" if ai.enabled() else "local",
            "counts": {c: st.store.count(c) for c in ("reports", "projects", "opportunities", "volunteers")}}


@app.get("/api/needs")
def needs():
    return Response(content=S().model.needs_json(), media_type="application/json")


@app.get("/api/needs/{geoid}")
def need_detail(geoid: str):
    st = S()
    if geoid not in st.geo.idx:
        raise HTTPException(404, "Neighborhood not found")
    return st.need_detail(geoid)


@app.post("/api/extract")
def extract(body: TextIn):
    return S().nlp.extract(body.text)


@app.post("/api/reports")
def post_report(body: ReportIn):
    st = S()
    ex = _clean_extraction(body.extraction, body.text) if body.extraction else None
    with st.lock:
        try:
            return st.submit_report(body.text, body.lat, body.lon, ex)
        except ValueError as e:
            raise HTTPException(422, str(e))


@app.get("/api/reports")
def get_reports(county: Optional[str] = None, limit: int = Query(200, ge=1, le=5000)):
    st = S()
    reps = st.store.all("reports")
    if county:
        fips = st.geo.county_fips(county)
        if fips is None:
            raise HTTPException(404, "County not found")
        reps = [r for r in reps if r["geoid"][2:5] == fips]
    reps = sorted(reps, key=lambda r: r["created_at"], reverse=True)
    return reps[:limit]


@app.post("/api/reports/{rid}/confirm")
def confirm(rid: str):
    st = S()
    with st.lock:
        r = _get("reports", rid, "Report")
        return st.confirm_report(r)


@app.get("/api/opportunities")
def opportunities(lat: Optional[float] = None, lon: Optional[float] = None, skills: Optional[str] = None,
                  interests: Optional[str] = None, hours: Optional[float] = Query(None, ge=0),
                  radius: float = Query(25.0, gt=0, le=600), q: Optional[str] = None):
    sk = [s for s in (skills or "").split(",") if s.strip()]
    it = [s.strip() for s in (interests or "").split(",") if s.strip()]
    return {"items": rank(S(), lat, lon, sk, it, hours, radius, q)}


@app.post("/api/opportunities/{oid}/signup")
def opp_signup(oid: str, body: SignupIn):
    st = S()
    with st.lock:
        o = _get("opportunities", oid, "Opportunity")
        try:
            return signup(st, o, body.name, body.skills, body.hours)
        except ValueError as e:
            raise HTTPException(409, str(e))


@app.get("/api/interventions")
def interventions():
    return [{k: v for k, v in t.items()} for t in CATALOG]


@app.post("/api/interventions/parse")
def parse_intervention(body: TextIn):
    st = S()
    t = st.nlp.parse_intervention(body.text)
    with st.lock:
        st.remember_custom(t)
    return t


@app.post("/api/optimize")
def run_optimize(body: OptimizeIn):
    st = S()
    keys = body.types or [t["key"] for t in CATALOG]
    types = [BY_KEY[k] for k in keys if k in BY_KEY]
    customs = [_clean_custom(t) for t in (body.custom or [])]
    have = {t["key"] for t in customs}
    for k in keys:
        if k.startswith("custom-") and k not in have and st.store.get("customs", k):
            customs.append(st.store.get("customs", k))
    types += customs
    if not types:
        raise HTTPException(422, "Pick at least one intervention type")
    with st.lock:
        for t in customs:
            st.remember_custom(t)
        try:
            res = optimize(st.geo, st.model, st.store.all("reports"), body.scope, body.budget, body.volunteers, types, body.max_per_type)
        except KeyError as e:
            raise HTTPException(404, str(e.args[0]) if e.args else "Unknown area")
        label = res.pop("scope_label")
        budget_txt = f"${body.budget / 1e6:.1f}M" if body.budget >= 1e6 else f"${body.budget / 1e3:.0f}k"
        name = (body.name or f"{label} — {budget_txt} plan").strip()[:120]
        sid = st.new_id("s")
        st.store.put("scenarios", {"id": sid, "name": name, "scope": body.scope, "budget": body.budget, "volunteers": body.volunteers,
                                   "types": [t["key"] for t in types], "created_at": iso(now_utc()),
                                   "portfolio": res["portfolio"], "totals": res["totals"]})
        tot = res["totals"]
        st.log("plan", f"A planner ran “{name}”: {len(res['portfolio'])} actions reaching {tot['people_reached']:,} people; "
                       f"need would fall from {tot['need_before']:.1f} to {tot['need_after']:.1f}.", None,
               None if body.scope.lower() == "nc" else label)
    return {"scenario": sid, "name": name, **res}


@app.post("/api/projects")
def post_project(body: ProjectIn):
    st = S()
    it = dict(body.item)
    for f in ("type", "label", "geoid"):
        if not it.get(f):
            raise HTTPException(422, f"item.{f} is required")
    i = st.geo.idx.get(str(it["geoid"]))
    if i is None:
        raise HTTPException(422, "item.geoid is not a known neighborhood")
    it.setdefault("county", st.geo.county[i])
    it.setdefault("lat", round(float(st.geo.lat[i]), 5))
    it.setdefault("lon", round(float(st.geo.lon[i]), 5))
    it.setdefault("categories", (st.type_spec(it["type"]) or {}).get("categories", []))
    try:
        it["cost"] = int(float(it.get("cost", 0)))
        it["people_reached"] = int(float(it.get("people_reached", 0)))
    except (TypeError, ValueError):
        raise HTTPException(422, "item.cost and item.people_reached must be numbers")
    with st.lock:
        return public(create_project(st, it, body.scenario))


@app.get("/api/projects")
def list_projects():
    ps = sorted(S().store.all("projects"), key=lambda p: p["created_at"], reverse=True)
    return [public(p) for p in ps]


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return public(_get("projects", pid, "Project"))


@app.patch("/api/projects/{pid}")
def patch(pid: str, body: PatchIn):
    st = S()
    with st.lock:
        p = _get("projects", pid, "Project")
        if body.status == "complete":
            complete_project(st, p)
            return public(p)
        try:
            return public(patch_project(st, p, body.status, body.milestone_id, body.done, body.note))
        except KeyError as e:
            raise HTTPException(404, str(e.args[0]))
        except ValueError as e:
            raise HTTPException(422, str(e))


@app.post("/api/projects/{pid}/brief")
def brief(pid: str):
    st = S()
    p = _get("projects", pid, "Project")
    with st.lock:
        return public(make_brief(st, p))


@app.post("/api/projects/{pid}/staff")
def staff(pid: str):
    st = S()
    with st.lock:
        p = _get("projects", pid, "Project")
        return staff_project(st, p)


@app.post("/api/projects/{pid}/complete")
def complete(pid: str):
    st = S()
    with st.lock:
        p = _get("projects", pid, "Project")
        if p["status"] == "complete":
            raise HTTPException(409, "Project is already complete")
        return complete_project(st, p)


@app.get("/api/activity")
def activity(limit: int = Query(30, ge=1, le=500)):
    acts = sorted(S().store.all("activity"), key=lambda a: a["at"], reverse=True)
    return acts[:limit]


@app.get("/api/orgs")
def orgs():
    return S().store.all("orgs")


@app.get("/api/scenarios")
def scenarios():
    return sorted(S().store.all("scenarios"), key=lambda s: s["created_at"], reverse=True)


@app.post("/api/reset")
def reset():
    st = S()
    from .seed import seed

    with st.lock:
        seed(st)
    return {"ok": True}
