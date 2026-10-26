"""Static geography: NC neighborhoods (census tracts), their centroids, inputs and access scores."""
from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import Point

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "public" / "data"
MILE = 1609.344  # meters
DURHAM = (36.0, -78.9)


class Geo:
    def __init__(self) -> None:
        gdf = gpd.read_file(DATA / "tracts.geojson")
        if gdf.crs is None:
            gdf = gdf.set_crs(4326)
        gdf = gdf.to_crs(4326)
        self.gdf = gdf
        proj = gdf.geometry.to_crs(32119)
        cent = proj.centroid
        self.x = cent.x.to_numpy(float)
        self.y = cent.y.to_numpy(float)
        cent_ll = gpd.GeoSeries(cent, crs=32119).to_crs(4326)
        self.lat = cent_ll.y.to_numpy(float)
        self.lon = cent_ll.x.to_numpy(float)
        self.n = len(gdf)

        self.geoids: list[str] = [str(g) for g in gdf["geoid"]]
        self.idx = {g: i for i, g in enumerate(self.geoids)}
        self.fips = np.array([g[2:5] for g in self.geoids])
        self.county: list[str] = [str(c) for c in gdf["county"]]
        num = lambda col: gdf[col].astype(float).to_numpy() if col in gdf else np.full(self.n, np.nan)
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
        self._to_xy = Transformer.from_crs(4326, 32119, always_xy=True)
        self.sindex = gdf.sindex

    # ---- helpers -----------------------------------------------------------------------------------------
    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        x, y = self._to_xy.transform(lon, lat)
        return float(x), float(y)

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
        geom = self.gdf.geometry.iloc[i]
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
