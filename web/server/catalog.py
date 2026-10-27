"""Intervention catalog: permanent facilities, mobile / pop-up services, programs and events.

effect[c]  = fraction of local need in category c removed at the site (decays with a Gaussian of sigma reach_mi)
cost       = capital cost (facilities) or cost for the full duration (mobile, programs, events), US dollars
volunteers = volunteer-hours per month while running
"""
from __future__ import annotations

from .needs import CATS


def _t(key, label, kind, effect, reach, cost, vol, lead, dur, desc):
    eff = {c: float(effect.get(c, 0.0)) for c in CATS}
    cats = [c for c, _ in sorted(effect.items(), key=lambda kv: -kv[1]) if effect[c] > 0]
    return {"key": key, "label": label, "kind": kind, "categories": cats, "effect": eff, "reach_mi": reach,
            "cost": cost, "volunteers": vol, "lead_weeks": lead, "duration_months": dur, "description": desc}


CATALOG = [
    _t("food_pantry", "Neighborhood food pantry", "facility", {"food": 0.35}, 1.5, 120_000, 160, 16, None,
       "A permanent pantry with fresh and shelf-stable food, open evenings and Saturdays."),
    _t("health_clinic", "Community health clinic", "facility", {"health": 0.40}, 2.5, 1_200_000, 60, 52, None,
       "A full-time clinic that takes Medicaid and uninsured patients on a sliding scale."),
    _t("digital_hub", "Library & digital hub", "facility", {"digital": 0.35, "childcare": 0.08}, 2.0, 450_000, 80, 36, None,
       "A small library branch with free Wi-Fi, computers, printing and after-school homework help."),
    _t("bus_stop", "New bus stop + route extension", "facility", {"transit": 0.30}, 1.2, 300_000, 10, 26, None,
       "Extends an existing bus route with new sheltered, accessible stops."),
    _t("mobile_market", "Mobile food market", "mobile", {"food": 0.18}, 2.5, 18_000, 60, 6, 12,
       "A grocery truck with fresh produce that stops in the neighborhood twice a month."),
    _t("popup_clinic", "Pop-up health clinic", "mobile", {"health": 0.15}, 2.5, 25_000, 40, 6, 6,
       "Monthly pop-up clinic with screenings, vaccines and referrals, staffed with interpreters."),
    _t("wifi_van", "Mobile library & Wi-Fi van", "mobile", {"digital": 0.18}, 2.5, 60_000, 50, 10, 12,
       "A van with books, laptops and a Wi-Fi hotspot that parks at schools and community centers."),
    _t("ride_vouchers", "Ride voucher program", "program", {"transit": 0.22, "health": 0.06}, 3.0, 40_000, 30, 4, 12,
       "Free rides to clinics, groceries and job interviews through local drivers and taxis."),
    _t("hotspot_lending", "Wi-Fi hotspot lending", "program", {"digital": 0.18}, 2.5, 8_000, 12, 3, 12,
       "Families borrow a Wi-Fi hotspot like a library book, with help getting set up."),
    _t("kid_meal_kits", "Weekend meal kits for kids", "program", {"food": 0.14, "childcare": 0.10}, 2.0, 15_000, 50, 4, 9,
       "Backpacks of easy weekend meals sent home with children who rely on school lunch."),
    _t("tenant_legal", "Tenant legal clinic", "program", {"housing": 0.22}, 3.0, 20_000, 40, 6, 12,
       "Weekly free legal help for tenants facing eviction, repairs disputes or rent hikes."),
    _t("childcare_coop", "Childcare co-op", "program", {"childcare": 0.25}, 2.0, 30_000, 80, 8, 12,
       "Parents and volunteers share childcare shifts, including evenings, in a licensed space."),
    _t("resource_fair", "Community resource fair", "event",
       {"food": 0.10, "health": 0.10, "housing": 0.10, "digital": 0.08, "childcare": 0.08}, 1.5, 6_000, 30, 4, 1,
       "A one-day fair with food boxes, health screenings, benefits sign-up, legal help and childcare info."),
]
# People each type can actually serve per year (capacity limits how much of a crowded area it can help).
CAPACITY = {"food_pantry": 3000, "health_clinic": 8000, "digital_hub": 15000, "bus_stop": 4000, "mobile_market": 1500,
            "popup_clinic": 800, "wifi_van": 2500, "ride_vouchers": 600, "hotspot_lending": 400, "kid_meal_kits": 500,
            "tenant_legal": 350, "childcare_coop": 120, "resource_fair": 1200}
STYLE_CAPACITY = {"facility": 3000, "mobile": 1500, "program": 400, "event": 1000}
for _t_ in CATALOG:
    _t_["capacity"] = CAPACITY[_t_["key"]]
BY_KEY = {t["key"]: t for t in CATALOG}


def capacity_of(t: dict) -> float:
    if t.get("capacity"):
        return float(t["capacity"])
    if t.get("key") in CAPACITY:
        return float(CAPACITY[t["key"]])
    return float(STYLE_CAPACITY.get(kind_style(t), 500))

MILESTONES = {
    "facility": ["Secure a site and permits", "Hold a community input meeting", "Hire staff and recruit volunteers",
                 "Build out and equip the space", "Opening day"],
    "mobile": ["Confirm route and stops with residents", "Recruit drivers and volunteers", "Secure vehicle and supplies",
               "Spread the word in the neighborhood", "First run"],
    "program": ["Design eligibility and sign-up", "Line up partners", "Train volunteers", "Outreach to residents",
                "Launch"],
    "event": ["Book the venue", "Line up partner tables", "Recruit volunteers", "Promote the event", "Event day"],
}

ROLES = {
    "food": [("Drivers", ["driving", "reliable car"]), ("Packers & sorters", ["packing", "lifting", "organizing"]),
             ("Intake & greeters", ["customer service", "spanish", "data entry"])],
    "health": [("Nurses & medical volunteers", ["nursing", "medical", "cpr"]), ("Interpreters", ["spanish", "interpreting"]),
               ("Patient intake", ["customer service", "data entry"])],
    "transit": [("Volunteer drivers", ["driving", "reliable car", "patience"]), ("Ride dispatch", ["scheduling", "phone", "organizing"])],
    "digital": [("Tech tutors", ["tech support", "teaching", "patience"]), ("Device setup & repair", ["computer repair", "tech support"])],
    "housing": [("Legal aides", ["legal", "paralegal"]), ("Neighborhood outreach", ["outreach", "spanish", "phone"])],
    "childcare": [("Caregivers", ["childcare", "cpr", "teaching"]), ("Activity leaders", ["tutoring", "teaching", "organizing"])],
}
SLOTS_BY_KIND = {"facility": 3, "mobile": 3, "program": 2, "event": 4}


def kind_style(t: dict) -> str:
    if t.get("kind") != "custom":
        return t["kind"]
    if t.get("style") in MILESTONES:
        return t["style"]
    if t.get("duration_months") is None:
        return "facility"
    return "event" if (t.get("duration_months") or 12) <= 1 else "program"
