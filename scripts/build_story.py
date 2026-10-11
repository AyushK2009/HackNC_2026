"""Build the landing-page story data: one dot per NC tract plus the headline statistics.

Requires build_data.py and build_access.py outputs. Writes web/public/data/story.json.

Run:  .venv/bin/python scripts/build_story.py
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from build_data import read_usda

ROOT = Path(__file__).resolve().parents[1]
INTERIM = ROOT / "data" / "interim"
OUT = ROOT / "web" / "public" / "data"
CRS_M = 32119
WIDTH = 1000  # SVG viewBox width; height follows NC's shape
SHOWCASE_COUNTY = "063"  # Durham: the planner example on the landing page
HIGH, LOW = 75, 25  # "high hardship" = top 25% of NC tracts; "poor access" = bottom 25%


def main():
    tracts = gpd.read_file(INTERIM / "tracts_full.gpkg").to_crs(CRS_M)
    access = json.loads((OUT / "access.json").read_text())
    gen = read_usda("SRAM General Tract Characteristics Data.csv")
    gen = gen[gen.State == "North Carolina"]

    pts = tracts.geometry.representative_point()
    minx, miny, maxx, maxy = tracts.total_bounds
    scale = WIDTH / (maxx - minx)
    height = round((maxy - miny) * scale)
    x = ((pts.x - minx) * scale).round(1)
    y = ((maxy - pts.y) * scale).round(1)

    acc = {g: r for g, r in access["tracts"].items() if r}
    miles = {g: r for g, r in access["miles"].items() if r}
    dots = []
    for i, g in enumerate(tracts.geoid):
        if tracts["pop"].iloc[i] <= 0:
            continue
        h = tracts.hardship_pct.iloc[i]
        a = acc.get(g)
        dots.append([float(x.iloc[i]), float(y.iloc[i]), None if pd.isna(h) else round(float(h)),
                     None if a is None else round(a[5]), tracts.COUNTYFP.iloc[i] == SHOWCASE_COUNTY])

    # Headline statistics, all computed from the same data the app uses.
    d = pd.DataFrame({"geoid": tracts.geoid, "pop": tracts["pop"], "urban": tracts.urban,
                      "h": tracts.hardship_pct, "county": tracts.COUNTYFP})
    d["pct"] = d.geoid.map(lambda g: acc[g][5] if g in acc else np.nan)
    d["health_mi"] = d.geoid.map(lambda g: miles[g][1] if g in miles else np.nan)
    d = d.dropna(subset=["pct", "health_mi"])

    def wmean(s, col):
        return float((s[col] * s["pop"]).sum() / s["pop"].sum())

    both = d[(d.h >= HIGH) & (d.pct <= LOW)]
    hh = gen.set_index("CensusTract20")[["OHU2020", "TractHUNV", "TractSNAP"]]
    top = d[d.h >= HIGH].join(hh, on="geoid")
    rest = d[d.h < HIGH].join(hh, on="geoid")
    plan = json.loads((OUT / "plans" / f"{SHOWCASE_COUNTY}.json").read_text())["food+health+transit+library"][:3]
    sites = gpd.GeoSeries(gpd.points_from_xy([s["lon"] for s in plan], [s["lat"] for s in plan]), crs=4326).to_crs(CRS_M)
    county = tracts[tracts.COUNTYFP == SHOWCASE_COUNTY]
    cminx, cminy, cmaxx, cmaxy = county.total_bounds

    stats = {
        "population": int(gen.POP2020.sum()),
        "below_poverty": int(round((gen.PovertyRate.fillna(0) / 100 * gen.POP2020).sum(), -3)),
        "households_no_car": int(round(gen.TractHUNV.sum(), -3)),
        "health_miles_rural": round(wmean(d[d.urban == 0], "health_mi"), 1),
        "health_miles_urban": round(wmean(d[d.urban == 1], "health_mi"), 1),
        "health_miles_median": access["services"]["health"]["D_miles"],
        "top_quarter_people": int(round(top["pop"].sum(), -5)),
        "top_quarter_no_car_one_in": round(float(top.OHU2020.sum() / top.TractHUNV.sum())),
        "rest_no_car_one_in": round(float(rest.OHU2020.sum() / rest.TractHUNV.sum())),
        "top_quarter_snap_one_in": round(float(top.OHU2020.sum() / top.TractSNAP.sum())),
        "overlap_people": int(round(both["pop"].sum(), -3)),
        "overlap_tracts": int(len(both)),
        "overlap_counties": int(both.county.nunique()),
        "overlap_rural_share": round(float((both.urban == 0).mean() * 100)),
        "tracts": int(len(d)),
        "showcase": {
            "county": county.county.iloc[0],
            "sites": [{"cat": s["cat"], "residents_closer": s["residents_closer"], "avg_miles_closer": s["avg_miles_closer"],
                       "x": round((p.x - minx) * scale, 1), "y": round((maxy - p.y) * scale, 1)}
                      for s, p in zip(plan, sites)],
            "bounds": [round((cminx - minx) * scale, 1), round((maxy - cmaxy) * scale, 1),
                       round((cmaxx - minx) * scale, 1), round((maxy - cminy) * scale, 1)],
        },
    }
    # State outline for masking everything outside North Carolina on the map.
    outline = tracts.to_crs(4326).union_all().simplify(0.003)
    gpd.GeoSeries([outline], crs=4326).to_file(OUT / "nc_outline.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)

    out = {"width": WIDTH, "height": height, "dots": dots, "stats": stats}
    (OUT / "story.json").write_text(json.dumps(out, separators=(",", ":")))
    print(json.dumps(stats, indent=1))
    print(f"story.json {(OUT / 'story.json').stat().st_size / 1024:.0f} KB, {len(dots)} dots, {WIDTH}x{height}")


if __name__ == "__main__":
    main()
