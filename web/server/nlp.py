"""Local language engine: multi-label need classifier + lexicons for barriers, groups, severity and urgency."""
from __future__ import annotations

import hashlib
import re

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.pipeline import FeatureUnion
from sklearn.preprocessing import MultiLabelBinarizer

from . import ai
from .corpus import TRAINING
from .needs import CATS, LABELS

BARRIERS = ["cost", "distance", "no_transportation", "hours", "eligibility", "language", "disability", "safety",
            "information", "waitlist", "closure"]
GROUPS = ["seniors", "children", "families", "disabled", "veterans", "non_english", "students", "unhoused"]

_I = re.IGNORECASE
BARRIER_RX = {
    "cost": r"\$\s?\d|\bcosts?\b|afford|expensive|price|too much|paycheck|fixed income|can'?t pay|power bill|raised the rent|cara\b",
    "distance": r"\b\d+\s?(miles?|mi)\b|\bfar\b|too far|\baway\b|across the county|minutes away|hours? away|walking distance|closest|nearest|three towns over|each way",
    "no_transportation": r"no car|don'?t have a car|without (a )?cars?|no ride|without a ride|car broke|car acts up|share one car|no (public )?transportation|no bus|bus (was|got) cut|\bstuck\b|no tengo carro|can'?t get (there|to)|no way to get|without a car",
    "hours": r"\bhours\b|only open|closes at|closed by|evenings?|weekends?|overnight|work(s|ing)? nights|once an hour|stops at|\b\d{1,2}(:\d\d)?\s?(am|pm)\b|mornings?|one thursday|once a month|sundays?",
    "eligibility": r"eligib|qualif|too much for|made (a little|\$\d+) too much|earn too much|make too much|medicaid|voucher|proof of|stopped taking|won'?t take|won'?t accept|doesn'?t take|accepts new|insurance|uninsured",
    "language": r"spanish|español|espanol|habla|interpret|translat|\b(no hay|no tenemos|mi familia|mis hijos|nadie)\b",
    "disability": r"wheelchair|disab|curb ramp|autism|blind|deaf|mobility|walker|homebound",
    "safety": r"dangerous|unsafe|in the dark|no sidewalk|crosswalk|\bmold\b|\brats\b|broken locks|scam|\b911\b|asthma|heat (has been|hasn'?t|is) (out|off|worked)",
    "information": r"nobody told|no one told|didn'?t know|don'?t know|not posted|nobody posted|no one has shown|where it went|my rights|no one taught",
    "waitlist": r"wait ?list|waiting list|on a wait|year long|months? (wait|long)|booked a week ahead|filled up",
    "closure": r"\bclosed\b|shut down|\bcut\b|stopped (coming|running|taking|happening)|no longer|was sold|closes? its|ended|ran out",
}
GROUP_RX = {
    "seniors": r"senior|elderly|older (folks|people|adults|homeowners)|grandmother|grandfather|grandparents|\bi'?m (6|7|8|9)\d\b|retired|fixed income|my parents|my dad|my mom|\babuel",
    "children": r"\bkids?\b|children|\bchild\b|baby|babies|infant|toddler|teen|\bson\b|daughter|grandkids|head start|pre-?k|hijos",
    "families": r"famil|parents|single moms?|households|my (kids|children)|three kids|two kids",
    "disabled": r"disab|wheelchair|autism|special needs|homebound",
    "veterans": r"veteran|\bva\b",
    "non_english": r"spanish|español|habla|interpret|\b(no hay|no tenemos|mi familia|mis hijos|nadie)\b",
    "students": r"students?|homework|college|school",
    "unhoused": r"homeless|sleeping in (their|my|our) cars?|couch surf|living in (the |a )?motels?|without homes|unhoused|nowhere to (go|live|sleep)",
}
CAT_LEX = {
    "food": r"grocer|food|pantry|meals?\b|snap\b|food stamps|hungry|\beat(ing)?\b|produce|lunch|dinner|formula|diaper|comida|despensa|farmers market|cereal",
    "health": r"clinic|doctor|health|medicaid|dentist|insulin|pharmac|prescription|hospital|counsel|mental|\ber\b|emergency room|specialist|blood pressure|flu shot|dialysis|prenatal|appointment",
    "transit": r"\bbus\b|route|\brides?\b|\bcar\b|\bvan\b|transportation|sidewalk|\bstop\b|drive|uber|\bgas\b|paratransit|autobús|carro|crosswalk",
    "digital": r"internet|broadband|wi-?fi|computer|library|online|cell service|hotspot|laptop|portal|email|telehealth|video call|satellite",
    "housing": r"\brent\b|landlord|evict|\bmold\b|apartment|housing|motel|homeless|\bheat\b|roof|mobile home|trailer park|utility|power bill|renta|dueño|section 8|sleeping in",
    "childcare": r"daycare|child ?care|after-?school|pre-?k|head start|babysit|infant care|playgroup|guardería|summer camp|caregiver|co-?op|diaper|toddler|infant",
}
SEV_UP = [r"emergency", r"can'?t\b", r"cannot", r"no way", r"nowhere", r"hungry", r"evict", r"sleeping in", r"homeless",
          r"ration", r"every (day|month|week)", r"dangerous", r"in the dark", r"\b911\b", r"skip(ping)? meals", r"lost my job",
          r"quit my job", r"home alone", r"asthma", r"turned away", r"\bstuck\b", r"\bmold\b", r"heat has been out",
          r"stay warm", r"getting worse", r"please help", r"no one|nobody", r"don'?t get enough", r"the er\b|emergency room",
          r"no hay|no tenemos|no tiene"]
SEV_DOWN = [r"would be nice", r"it would help", r"would love", r"would be great", r"nice to have", r"\bmaybe\b",
            r"sometimes", r"would help a lot", r"would make a (huge )?difference"]
URGENT = [r"emergency", r"eviction notice", r"court is", r"\b30 days\b", r"\b60 days\b", r"heat", r"\b911\b", r"tonight",
          r"this week", r"ration", r"nowhere to go", r"sleeping in", r"hungry", r"insulin"]
SPANISH = re.compile(r"\b(el|la|los|las|mi|mis|no|hay|en|y|de|que|para|nuestra|tengo|tenemos|nadie)\b", _I)


def _hits(rx: str, t: str) -> int:
    return len(re.findall(rx, t, _I))


class LocalNLP:
    def __init__(self) -> None:
        texts = [t for t, _ in TRAINING]
        labels = [l.split(",") for _, l in TRAINING]
        self.mlb = MultiLabelBinarizer(classes=CATS)
        Y = self.mlb.fit_transform(labels)
        self.vec = FeatureUnion([
            ("word", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1, lowercase=True)),
            ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True, min_df=1)),
        ])
        X = self.vec.fit_transform(texts)
        self.clf = OneVsRestClassifier(LogisticRegression(C=8.0, class_weight="balanced", max_iter=2000))
        self.clf.fit(X, Y)
        self.n_train = len(texts)

    # ---- categories ----------------------------------------------------------------------------------------
    def category_probs(self, text: str) -> tuple[np.ndarray, np.ndarray]:
        p = self.clf.predict_proba(self.vec.transform([text]))[0]
        lex = np.array([min(1.0, _hits(CAT_LEX[c], text) / 2.0) for c in CATS])
        return 0.65 * p + 0.35 * lex, p

    def categories(self, text: str, threshold: float = 0.42, max_n: int = 3):
        blend, p = self.category_probs(text)
        order = np.argsort(-blend)
        primary = CATS[int(order[0])]
        cats = [CATS[int(j)] for j in order if blend[j] >= threshold][:max_n]
        if primary not in cats:
            cats = [primary] + cats[: max_n - 1]
        return cats, primary, blend, p

    # ---- full extraction -------------------------------------------------------------------------------------
    def extract_local(self, text: str) -> dict:
        t = " ".join(text.split())
        cats, primary, blend, p = self.categories(t)
        barriers = [b for b in BARRIERS if re.search(BARRIER_RX[b], t, _I)]
        groups = [g for g in GROUPS if re.search(GROUP_RX[g], t, _I)]
        up = sum(1 for rx in SEV_UP if re.search(rx, t, _I))
        down = any(re.search(rx, t, _I) for rx in SEV_DOWN)
        vuln = any(g in groups for g in ("children", "seniors", "disabled", "unhoused"))
        sev = 2.6 + 0.65 * min(up, 4) - (1.4 if down else 0) + (0.35 if vuln else 0)
        severity = int(min(5, max(1, round(sev))))
        if severity >= 5 or (severity >= 4 and any(re.search(rx, t, _I) for rx in URGENT)):
            urgency = "high"
        elif severity >= 3:
            urgency = "medium"
        else:
            urgency = "low"
        lex_top = CATS[int(np.argmax([_hits(CAT_LEX[c], t) for c in CATS]))]
        lex_has = _hits(CAT_LEX[primary], t) > 0
        agree = 1.0 if lex_top == primary and lex_has else (0.5 if lex_has else 0.0)
        conf = 0.55 * float(p[CATS.index(primary)]) + 0.3 * agree + 0.15 * min(1.0, len(t) / 80)
        return {
            "categories": cats,
            "primary": primary,
            "severity": severity,
            "urgency": urgency,
            "barriers": barriers,
            "groups": groups,
            "summary": summarize(t, primary, barriers, groups),
            "confidence": round(min(0.97, max(0.3, conf)), 2),
            "engine": "local",
        }

    def extract(self, text: str) -> dict:
        res = ai.extract(text)
        if res:
            try:
                return _validate_claude(res, text, self)
            except Exception:
                pass
        return self.extract_local(text)

    # ---- custom intervention ------------------------------------------------------------------------------
    def parse_intervention(self, text: str) -> dict:
        t = " ".join(text.split())
        cats, primary, blend, _ = self.categories(t, threshold=0.38, max_n=3)
        low = t.lower()
        if re.search(r"\b(build|building|open(ing)? a|new|permanent|center|facility|hub|site)\b", low) and not re.search(r"giveaway|fair|event|day\b", low):
            style = "facility"
        elif re.search(r"\b(van|truck|mobile|bus|pop-?up|traveling|bookmobile)\b", low):
            style = "mobile"
        elif re.search(r"giveaway|\bfair\b|event|festival|drive\b|day\b|night\b|saturday|sunday|clinic day|block party|one-?time", low):
            style = "event"
        else:
            style = "program"
        recurring = bool(re.search(r"weekly|every (week|saturday|sunday|month)|monthly|ongoing|each (week|month)", low))
        base = {
            "facility": dict(cost=250000, reach=1.5, vol=100, lead=26, dur=None, eff=0.3),
            "mobile": dict(cost=30000, reach=2.5, vol=60, lead=8, dur=12, eff=0.22),
            "program": dict(cost=20000, reach=2.5, vol=40, lead=6, dur=12, eff=0.22),
            "event": dict(cost=5000, reach=1.5, vol=30, lead=3, dur=1, eff=0.12),
        }[style]
        cost, vol, dur, eff = base["cost"], base["vol"], base["dur"], base["eff"]
        if style == "event" and recurring:
            cost, vol, dur, eff = cost * 3, vol * 2, 6, 0.18
        elif recurring and style in ("program", "mobile"):
            cost, vol = int(cost * 1.3), int(vol * 1.3)
        m = re.search(r"\$\s?([\d,.]+)\s*(k|thousand|m|million)?", low)
        if m:
            try:
                v = float(m.group(1).replace(",", ""))
                mult = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6}.get(m.group(2) or "", 1)
                cost = int(v * mult)
            except ValueError:
                pass
        m = re.search(r"(\d+)\s+volunteers?", low)
        if m:
            vol = int(m.group(1)) * (4 if style == "event" else 8)
        capacity = {"facility": 3000, "mobile": 1500, "program": 400, "event": 1000}[style]
        if style == "event" and recurring:
            capacity = 2000
        m = re.search(r"(\d[\d,]*)\s+(people|residents|families|households|kids|children|seniors|students|tenants|patients)", low)
        if m:
            n = int(m.group(1).replace(",", ""))
            capacity = n * (2.5 if m.group(2) in ("families", "households") else 1)
        reach = base["reach"]
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:-| )?(?:miles?|mi)\b", low)
        if m:
            reach = max(0.5, min(15.0, float(m.group(1)) / 2.0))  # a stated radius ~ 2 sigma
        effect = {c: 0.0 for c in CATS}
        for k, c in enumerate(cats):
            effect[c] = round(eff if k == 0 else eff * 0.6, 3)
        label = re.sub(r"^(a|an|the|we want|we need|let'?s do|how about)\s+", "", t, flags=_I).strip(" .")
        label = label[0].upper() + label[1:] if label else "Custom action"
        if len(label) > 60:
            label = label[:57].rsplit(" ", 1)[0] + "…"
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:28]
        key = f"custom-{slug}-{hashlib.md5(t.encode()).hexdigest()[:5]}"
        cat_txt = ", ".join(LABELS[c].lower() for c in cats)
        desc = (f"Your idea, read as a {'recurring ' if recurring else ''}{'one-time event' if style == 'event' and not recurring else style}"
                f" for {cat_txt}. Rough estimate: ${cost:,}, about {vol} volunteer-hours a month, reaching people within "
                f"about {reach:g} miles; it can serve roughly {int(capacity):,} people a year. Edit these numbers if you know better.")
        return {
            "key": key, "label": label, "kind": "custom", "categories": cats, "effect": effect,
            "reach_mi": reach, "cost": int(cost), "volunteers": int(vol), "lead_weeks": base["lead"],
            "duration_months": dur, "description": desc, "style": style, "capacity": int(capacity),
        }


def _validate_claude(res: dict, text: str, nlp: LocalNLP) -> dict:
    cats = [c for c in res.get("categories", []) if c in CATS]
    primary = res.get("primary") if res.get("primary") in CATS else (cats[0] if cats else None)
    if not primary:
        raise ValueError("no category")
    if primary not in cats:
        cats = [primary] + cats
    return {
        "categories": cats[:3],
        "primary": primary,
        "severity": int(min(5, max(1, int(res.get("severity", 3))))),
        "urgency": res.get("urgency") if res.get("urgency") in ("low", "medium", "high") else "medium",
        "barriers": [b for b in res.get("barriers", []) if b in BARRIERS],
        "groups": [g for g in res.get("groups", []) if g in GROUPS],
        "summary": (str(res.get("summary") or "").strip() or summarize(text, primary, [], []))[:120],
        "confidence": round(min(1.0, max(0.0, float(res.get("confidence", 0.8)))), 2),
        "engine": "claude",
    }


# ---- summary ---------------------------------------------------------------------------------------------------
_PAST_OR_MODAL = {"can't", "cannot", "can", "could", "couldn't", "would", "will", "won't", "should", "must", "might",
                  "was", "got", "lost", "had", "did", "didn't", "made", "used", "went", "quit", "walked", "missed",
                  "waited", "tried", "called", "heard", "saw", "skip"}
_IRREG = {"have": "has", "do": "does", "am": "is", "go": "goes", "don't": "doesn't", "haven't": "hasn't"}
_FILLER = re.compile(r"^(honestly|just want(ed)? (someone )?to (say|know|let you know)|this keeps happening\.?|so|hi|hello|ok|well)[,:.!]?\s+", _I)


def _third_person(s: str) -> str:
    s = re.sub(r"\bI'm\b", "Resident is", s)
    s = re.sub(r"\bI've\b", "Resident has", s)
    s = re.sub(r"\bI'll\b", "Resident will", s)

    def verb(m):
        w = m.group(1)
        lw = w.lower()
        if lw in _PAST_OR_MODAL or lw.endswith("ed"):
            return f"resident {w}"
        if lw in _IRREG:
            return f"resident {_IRREG[lw]}"
        if re.search(r"(s|sh|ch|x|z)$", lw):
            return f"resident {w}es"
        if re.search(r"[^aeiou]y$", lw):
            return f"resident {w[:-1]}ies"
        return f"resident {w}s"

    s = re.sub(r"\bI ([A-Za-z']+)", verb, s)
    s = re.sub(r"\band I\b", "and the resident", s)
    s = re.sub(r"\bwe're\b", "residents are", s, flags=_I)
    s = re.sub(r"\bwe've\b", "residents have", s, flags=_I)
    s = re.sub(r"\bwe\b", "residents", s, flags=_I)
    s = re.sub(r"\bnear us\b", "nearby", s, flags=_I)
    s = re.sub(r"\b(gave|told|for|to|with) us\b", r"\1 residents", s, flags=_I)
    s = re.sub(r"\bus\b", "them", s, flags=_I)
    s = re.sub(r"\bour\b", "the", s, flags=_I)
    s = re.sub(r"\bmy\b", "their", s, flags=_I)
    s = re.sub(r"\bme\b", "them", s, flags=_I)
    s = re.sub(r"\bmyself\b", "themselves", s, flags=_I)
    return s


def summarize(text: str, primary: str, barriers: list[str], groups: list[str]) -> str:
    t = text.strip()
    for _ in range(3):
        t = _FILLER.sub("", t)
    if len(SPANISH.findall(t)) >= 4 and not re.search(r"\b(the|and|is|our|my)\b", t, _I):
        b = {"cost": "it costs too much", "language": "no one speaks Spanish", "closure": "a service closed"}
        why = next((b[x] for x in barriers if x in b), "")
        out = f"Spanish-speaking resident reports a {LABELS[primary].lower()} problem" + (f"; {why}" if why else "")
        return out[:120]
    sents = [s for s in re.split(r"(?<=[.!?])\s+", t) if s]
    s = sents[0] if sents else t
    if len(s) < 45 and len(sents) > 1 and len(s) + len(sents[1]) < 118:
        nxt = sents[1]
        if not re.match(r"(I\b|I'|[A-Z][a-z]+ [A-Z])", nxt):
            nxt = nxt[0].lower() + nxt[1:]
        s = s.rstrip(".!?") + "; " + nxt
    s = _third_person(s).strip().rstrip(".!? ")
    if len(s) > 120:
        cut = s[:118]
        for sep in ["; ", ", ", " and ", " but ", " so "]:
            k = cut.rfind(sep)
            if k > 50:
                cut = cut[:k]
                break
        else:
            cut = cut.rsplit(" ", 1)[0]
        s = cut.rstrip(",;: ") + ("…" if len(cut) < len(s) else "")
    s = s[0].upper() + s[1:] if s else LABELS[primary]
    return s[:120]
