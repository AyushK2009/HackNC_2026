"""Optional Claude path. Used only when ANTHROPIC_API_KEY is set; every caller falls back to the local engine."""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger("allocate.ai")
MODEL = "claude-opus-5-5"
_client = None


def enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(timeout=20.0, max_retries=1)
    return _client


def _create(timeout: float, **kw):
    """messages.create with server-side refusal fallback; retried once without it if the beta is rejected."""
    import anthropic

    client = _get_client().with_options(timeout=timeout)
    try:
        return client.messages.create(
            model=MODEL,
            extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
            extra_body={"fallbacks": "default"},
            **kw,
        )
    except anthropic.BadRequestError:
        return client.messages.create(model=MODEL, **kw)


def _text(resp) -> str | None:
    if resp is None or getattr(resp, "stop_reason", None) in ("refusal", "max_tokens"):
        return None
    for b in resp.content:
        if getattr(b, "type", None) == "text":
            return b.text
    return None


EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {"type": "array", "items": {"type": "string", "enum": ["food", "health", "transit", "digital", "housing", "childcare"]}},
        "primary": {"type": "string", "enum": ["food", "health", "transit", "digital", "housing", "childcare"]},
        "severity": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "urgency": {"type": "string", "enum": ["low", "medium", "high"]},
        "barriers": {"type": "array", "items": {"type": "string", "enum": ["cost", "distance", "no_transportation", "hours", "eligibility", "language", "disability", "safety", "information", "waitlist", "closure"]}},
        "groups": {"type": "array", "items": {"type": "string", "enum": ["seniors", "children", "families", "disabled", "veterans", "non_english", "students", "unhoused"]}},
        "summary": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["categories", "primary", "severity", "urgency", "barriers", "groups", "summary", "confidence"],
    "additionalProperties": False,
}

EXTRACT_SYSTEM = (
    "You read short reports from North Carolina residents about unmet community needs and classify them. "
    "Categories: food (food access), health (health care), transit (transportation), digital (internet, devices, "
    "libraries), housing, childcare. Severity 1-5: 1 = a nice-to-have, 3 = a real recurring problem, 5 = an "
    "emergency or someone going without food, care, shelter or safety. The summary is one plain-language line in "
    "the third person, at most 120 characters, no jargon (e.g. \"Bus route cut; seniors can't reach the clinic\"). "
    "Confidence is your 0-1 certainty in the primary category. Reports may be in Spanish; summarize in English."
)


def extract(text: str) -> dict | None:
    if not enabled():
        return None
    try:
        resp = _create(
            12.0,
            max_tokens=1024,
            system=EXTRACT_SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
            messages=[{"role": "user", "content": f"Resident report:\n{text}"}],
        )
        raw = _text(resp)
        return json.loads(raw) if raw else None
    except Exception as e:  # network, auth, rate limit, bad JSON -> local engine
        log.warning("Claude extraction failed, using local engine: %s", e)
        return None


BRIEF_SYSTEM = (
    "You write concise project briefs for community nonprofits and local governments in North Carolina. "
    "Use only the facts in the provided data; never invent statistics, names or quotes. Say 'neighborhood', never "
    "'tract'. Write markdown with exactly these sections as level-2 headings: Situation, Goal, Plan, Partners, "
    "Risks & mitigations, How we'll measure success. Keep it under 450 words, plain language, short bullets."
)


def brief(facts: dict) -> str | None:
    if not enabled():
        return None
    try:
        resp = _create(
            30.0,
            max_tokens=4000,
            system=BRIEF_SYSTEM,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": "Write the brief from this data:\n" + json.dumps(facts, indent=1)}],
        )
        out = _text(resp)
        return out.strip() if out and "## " in out else None
    except Exception as e:
        log.warning("Claude brief failed, using local generator: %s", e)
        return None
