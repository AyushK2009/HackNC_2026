"""Application state: geography, need model, language engine and store, plus the report workflow."""
from __future__ import annotations

import itertools
import threading
import uuid
from collections import Counter
from datetime import datetime

import numpy as np

from .catalog import BY_KEY, CATALOG
from .data import MILE, Geo, miles_between
from .needs import CATS, LABELS, PHRASE, NeedModel, iso, now_utc
from .nlp import LocalNLP
from .projects import public
from .store import Store


class State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.geo = Geo()
        self.nlp = LocalNLP()
        self.store = Store()
        self.model = NeedModel(self.geo)
        self._ids = itertools.count(1)
        if self.store.count("reports") == 0:
            from .seed import seed

            seed(self)
        else:
            self.rebuild()
            self._migrate_capacity()

    def _migrate_capacity(self) -> None:
        """Older data (before capacity limits): scale stored adjustments and refresh expected impact of open projects."""
        from .catalog import capacity_of
        from .optimize import evaluate_single, reach_scale

        projs = {p["id"]: p for p in self.store.all("projects")}
        changed = False
        for a in self.store.all("adjustments"):
            if "capacity_scale" in a:
                continue
            spec = (projs.get(a.get("project_id")) or {}).get("_spec") or {"reach_mi": a["sigma_mi"], "kind": "program", "effect": a["effect"]}
            x, y = self.geo.xy(a["lat"], a["lon"])
            sc = reach_scale(self.geo, {**spec, "reach_mi": a["sigma_mi"]}, x, y)[0]
            a["effect"] = {c: v * sc for c, v in a["effect"].items()}
            a["capacity_scale"] = round(sc, 5)
            self.store.put("adjustments", a)
            changed = True
        if changed:
            self.rebuild()
        reps = self.store.all("reports")
        for p in projs.values():
            spec = p.get("_spec") or {}
            if "capacity" in spec:
                continue
            spec["capacity"] = capacity_of(spec)
            if p["status"] != "complete" and p["geoid"] in self.geo.idx:
                try:
                    it = evaluate_single(self.geo, self.model, reps, spec, self.geo.idx[p["geoid"]])
                    p["expected"] = {"people_reached": it["people_reached"], "need_reduction": it["need_reduction"]}
                except Exception:
                    pass
            self.store.put("projects", p)
        for t in self.store.all("customs"):
            if "capacity" not in t:
                t["capacity"] = int(capacity_of(t))
                self.store.put("customs", t)

    # ---- infrastructure -----------------------------------------------------------------------------------
    def new_id(self, prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:8]}"

    def rebuild(self) -> None:
        self.model.rebuild(self.store.all("reports"), self.store.all("adjustments"))

    def log(self, kind: str, text: str, geoid: str | None = None, county: str | None = None, at: datetime | None = None) -> dict:
        a = {"id": self.new_id("a"), "at": iso(at or now_utc()), "kind": kind, "text": text, "geoid": geoid, "county": county}
        self.store.put("activity", a)
        return a

    def type_spec(self, key: str) -> dict | None:
        return BY_KEY.get(key) or self.store.get("customs", key)

    def remember_custom(self, t: dict) -> None:
        if t.get("key", "").startswith("custom-"):
            self.store.put("customs", {**t, "id": t["key"]})

    # ---- reports ------------------------------------------------------------------------------------------
    def make_report(self, text: str, lat: float, lon: float, extraction: dict | None = None, created_at: datetime | None = None,
                    confirmations: int = 0, rid: str | None = None) -> dict:
        i = self.geo.locate(lat, lon)
        if i is None:
            raise ValueError("That location is outside North Carolina")
        ex = extraction or self.nlp.extract(text)
        return {**ex, "id": rid or self.new_id("r"), "text": text.strip(), "lat": round(float(lat), 5), "lon": round(float(lon), 5),
                "geoid": self.geo.geoids[i], "county": self.geo.county[i], "created_at": iso(created_at or now_utc()),
                "confirmations": int(confirmations), "status": "open"}

    def _snapshot(self, r: dict) -> tuple[int, int, float, float, float]:
        i = self.geo.idx[r["geoid"]]
        j = CATS.index(r["primary"])
        m = self.model
        return i, j, float(m.post[i, j] * 100), float(m.need[i]), float(m.pct[i])

    def _change(self, r: dict, before) -> dict:
        i, j, b, nb, pb = before
        m = self.model
        return {"geoid": r["geoid"], "category": r["primary"], "before": round(b, 1), "after": round(float(m.post[i, j] * 100), 1),
                "need_before": round(nb, 1), "need_after": round(float(m.need[i]), 1),
                "pct_before": round(pb, 1), "pct_after": round(float(m.pct[i]), 1)}

    def report_activity_text(self, r: dict, ch: dict) -> str:
        quote = r["summary"] if len(r["summary"]) <= 90 else r["summary"][:87].rsplit(" ", 1)[0] + "…"
        if ch["after"] >= ch["before"] + 0.5:
            tail = f"{PHRASE[r['primary']]} need there rose from {ch['before']:.0f} to {ch['after']:.0f}"
        else:
            tail = f"{PHRASE[r['primary']]} need there is now {ch['after']:.0f}"
        return f"A resident in {r['county']} reported: “{quote}” — {tail}."

    def submit_report(self, text: str, lat: float, lon: float, extraction: dict | None = None) -> dict:
        r = self.make_report(text, lat, lon, extraction)
        before = self._snapshot(r)
        self.store.put("reports", r)
        self.model.add_report(r)
        ch = self._change(r, before)
        self.log("report", self.report_activity_text(r, ch), r["geoid"], r["county"])
        return {"report": r, "change": ch}

    def confirm_report(self, r: dict) -> dict:
        before = self._snapshot(r)
        r["confirmations"] = int(r.get("confirmations", 0)) + 1
        r["last_confirmed_at"] = iso(now_utc())
        if r.get("status") == "addressed":
            r["status"] = "open"  # a neighbor says the problem is back
        self.store.put("reports", r)
        self.model.update_report(r)
        ch = self._change(r, before)
        if r["confirmations"] in (1, 3, 5, 10):
            self.log("need", f"{r['confirmations']} neighbor{'s' if r['confirmations'] > 1 else ''} said “me too” to a report in "
                             f"{r['county']} — {PHRASE[r['primary']]} need there is now {ch['after']:.0f}.", r["geoid"], r["county"])
        return {"report": r, "change": ch}

    # ---- views ----------------------------------------------------------------------------------------------
    def need_detail(self, geoid: str) -> dict:
        geo, m = self.geo, self.model
        i = geo.idx[geoid]
        lat, lon = geo.lat[i], geo.lon[i]
        reps = self.store.all("reports")
        near = []
        if reps:
            d = miles_between(lat, lon, np.array([r["lat"] for r in reps]), np.array([r["lon"] for r in reps]))
            near = [r for r, dd in zip(reps, d) if dd <= 3.0 or r["geoid"] == geoid]
        near.sort(key=lambda r: r["created_at"], reverse=True)
        bar = Counter(b for r in near for b in r["barriers"])
        grp = Counter(g for r in near for g in r["groups"])
        projs = []
        for p in self.store.all("projects"):
            if float(miles_between(lat, lon, p["lat"], p["lon"])) <= 5.0:
                projs.append(public(p))
        return {
            "geoid": geoid, "county": geo.county[i], "pop": int(geo.pop[i]),
            "hardship_pct": None if np.isnan(geo.hardship_raw[i]) else round(float(geo.hardship_raw[i]), 1),
            "need": round(float(m.need[i]), 1), "pct": round(float(m.pct[i]), 1), "by": m.cells(i),
            "reports": near[:8],
            "barriers": [{"key": k, "count": v} for k, v in bar.most_common()],
            "groups": [{"key": k, "count": v} for k, v in grp.most_common()],
            "projects": projs, "suggestions": self.suggestions(i, bar),
        }

    def suggestions(self, i: int, bar: Counter) -> list[dict]:
        m = self.model
        order = np.argsort(-m.cat_pct[i])
        out, used = [], set()
        top_bar = bar.most_common(1)[0][0].replace("_", " ") if bar else None
        for j in order[:3]:
            c = CATS[int(j)]
            pct = int(min(99, round(m.cat_pct[i, j])))
            opts = [t for t in CATALOG if t["effect"].get(c, 0) > 0 and t["key"] not in used]
            if not opts:
                continue
            if pct >= 92:
                fac = [t for t in opts if t["kind"] == "facility" and t["categories"][0] == c]
                pick = fac[0] if fac else max(opts, key=lambda t: t["effect"][c] / np.sqrt(t["cost"]))
            else:
                pick = max(opts, key=lambda t: t["effect"][c] / np.sqrt(t["cost"]))
            used.add(pick["key"])
            why = f"{LABELS[c]} need here is higher than {pct}% of NC"
            if top_bar and len(out) == 0:
                why += f"; nearby reports most often mention {top_bar}"
            out.append({"type": pick["key"], "label": pick["label"], "why": why + "."})
            if len(out) >= 3:
                break
        return out
