"""Static geography: NC neighborhoods (census tracts), their centroids, inputs and access scores."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from shapely import STRtree
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parent.parent  # web/
DATA = ROOT / "public" / "data"
MILE = 1609.344  # meters
DURHAM = (36.0, -78.9)
# Local planar projection centred on North Carolina (meters). Accurate to ~1% across the state, and keeps the
# deployed function free of the heavy GIS stack.
LAT0, LON0 = 35.5, -79.5
KX = 111_320.0 * np.cos(np.radians(LAT0))
KY = 110_574.0


class Geo:
    def __init__(self) -> None:
        fc = json.loads((DATA / "tracts.geojson").read_text())
        feats = fc["features"]
        self.geoms = [shape(f["geometry"]) for f in feats]
        props = [f["properties"] for f in feats]
        cent = [g.centroid for g in self.geoms]
        self.lat = np.array([c.y for c in cent], float)
        self.lon = np.array([c.x for c in cent], float)
        self.x = (self.lon - LON0) * KX
        self.y = (self.lat - LAT0) * KY
        self.n = len(feats)

        self.geoids: list[str] = [str(p["geoid"]) for p in props]
        self.idx = {g: i for i, g in enumerate(self.geoids)}
        self.fips = np.array([g[2:5] for g in self.geoids])
        self.county: list[str] = [str(p.get("county")) for p in props]

        def num(col: str) -> np.ndarray:
            return np.array([np.nan if p.get(col) is None else float(p[col]) for p in props], float)

        self.pop = np.nan_to_num(num("pop"), nan=0.0)
        self.poverty = num("poverty_rate")
        self.income = num("median_income")
        self.snap = num("snap_share")
        self.no_car = num("no_vehicle_share")
        self.hardship_raw = num("hardship_pct")
        self.hardship = np.where(np.isnan(self.hardship_raw), 50.0, self.hardship_raw)
        self.populated = self.pop > 0

        acc = json.loads((DATA / "access.json").read_text())
        self.county_names = {c["fips"]: c["name"] for c in acc["counties"]}
        self.access = np.full((self.n, 4), np.nan)  # food, health, transit, library scores 0-100
        self.miles = np.full((self.n, 4), np.nan)
        for g, v in acc["tracts"].items():
            i = self.idx.get(g)
            if i is not None and v:
                self.access[i] = [np.nan if s is None else s for s in v[:4]]
        for g, v in acc["miles"].items():
            i = self.idx.get(g)
            if i is not None and v:
                self.miles[i] = [np.nan if s is None else s for s in v[:4]]

        self.tree = cKDTree(np.c_[self.x, self.y])
        self.sindex = STRtree(self.geoms)

    # ---- helpers -----------------------------------------------------------------------------------------
    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return float((lon - LON0) * KX), float((lat - LAT0) * KY)

    def locate(self, lat: float, lon: float) -> int | None:
        """Neighborhood containing a point (or nearest centroid within 3 miles)."""
        try:
            hits = self.sindex.query(Point(lon, lat), predicate="intersects")
            if len(hits):
                return int(hits[0])
        except Exception:
            pass
        x, y = self.xy(lat, lon)
        d, i = self.tree.query([x, y])
        return int(i) if d < 3 * MILE else None

    def near(self, x: float, y: float, r_m: float) -> np.ndarray:
        return np.array(self.tree.query_ball_point([x, y], r_m), dtype=int)

    def dist_m(self, x: float, y: float, idxs) -> np.ndarray:
        return np.hypot(self.x[idxs] - x, self.y[idxs] - y)

    def county_name(self, fips: str) -> str:
        return self.county_names.get(fips, f"County {fips}")

    def county_fips(self, name_or_fips: str) -> str | None:
        s = (name_or_fips or "").strip()
        if s.isdigit():
            s = s.zfill(3)
            return s if s in self.county_names else None
        low = s.lower().replace(" county", "")
        for f, n in self.county_names.items():
            if n.lower().replace(" county", "") == low:
                return f
        return None

    def random_point(self, i: int, rng) -> tuple[float, float]:
        """Random point inside neighborhood i (lat, lon)."""
        geom = self.geoms[i]
        minx, miny, maxx, maxy = geom.bounds
        for _ in range(60):
            lon = rng.uniform(minx, maxx)
            lat = rng.uniform(miny, maxy)
            if geom.contains(Point(lon, lat)):
                return round(lat, 5), round(lon, 5)
        p = geom.representative_point()
        return round(p.y, 5), round(p.x, 5)


def miles_between(lat1, lon1, lat2, lon2):
    """Great-circle distance in miles (vectorized)."""
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
