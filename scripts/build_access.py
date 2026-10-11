"""Build statewide Service Accessibility data and infrastructure recommendations for AccessAtlas.

Requires scripts/build_data.py to have run first (uses data/interim/tracts_full.gpkg).

Inputs (data/raw/, not committed):
  durham_food_pantries.geojson       City of Durham Food Resources layer 2
  orange_food_resources.xlsx         Orange County Cooperative Extension food resource list (addresses; geocoded here)
  wake_food_pantries.geojson         Wake County food pantry map (2018 directory)
  new_hanover_food_pantries.geojson  New Hanover County food pantry map
  hrsa_health_centers.csv            HRSA Health Center Service Delivery Sites
  nc_transit_stops.geojson           USDOT National Transit Map stops (scripts/fetch_transit.py)
  imls_libraries_2024.zip            IMLS Public Libraries Survey outlet file (FY2023 data)

Outputs (web/public/data/):
  facilities.geojson   every facility used, one schema for all services (modeled food sites flagged)
  access.json          per-tract coverage F, H, T, L; overall A; statewide access percentile
  plans/<scope>.json   recommended interventions for NC ("nc") and each county (FIPS), for every
                       combination of allowed service categories and up to 5 sites

Accessibility model. Each tract is represented by evenly spaced demand points that share its population
(residents assumed evenly spread within a tract). For each point and service c, with d = straight-line distance
(NC State Plane meters) to the nearest site of c:

    A_c(d) = max(0, 100 / (1 + d / m) - (d / D)^2)

  m = population-weighted mean of d within the point's county (what is typical locally)
  D = population-weighted median of d across North Carolina (statewide yardstick)

m and D are computed once from baseline sites and held fixed when evaluating new sites. A tract's score for c
is the population-weighted mean of its points; overall A_i = mean of the four service scores; the access
percentile ranks A_i against all populated NC tracts at baseline.

Recommendations. For service c at candidate x, S(c, x) = sum_i P_i * (Hardship_i / 100) * dA_i(c, x), with
dA_i the change in tract i's overall score (0-1 scale) when x becomes the nearest c site for points closer to x
than to any existing c site. Sites are chosen greedily among the allowed services; distances are updated
before the next pick, so improvements are never counted twice.

Run:  .venv/bin/python scripts/build_access.py
"""

import csv
import io
import itertools
import json
import re
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
OUT = ROOT / "web" / "public" / "data"

CRS_M = 32119  # NC State Plane (meters): distances and areas are computed in this projection
MILE = 1609.344

SERVICES = {
    "food": {"label": "Food assistance"},
    "health": {"label": "Community health centers"},
    "transit": {"label": "Transit stops"},
    "library": {"label": "Public libraries"},
}
CATS = list(SERVICES)

# Counties with a real food-assistance inventory. Everywhere else, food sites are modeled (see synthetic_food).
FOOD_INVENTORY = {"063": "City of Durham GIS", "135": "Orange County Cooperative Extension (Aug 2026)",
                  "183": "Wake County pantry map (2018)", "129": "New Hanover County pantry map"}
# Counties used to estimate typical food-site density (current, county-wide inventories).
DENSITY_COUNTIES = ["063", "135"]
SEED = 42

POINT_SPACING_M = 500
MIN_POINTS = 20
# Candidate grid spacing per service (meters): finer where sites are typically closer together.
CANDIDATE_SPACING = {"food": 1500, "health": 3000, "transit": 1000, "library": 2000}
MIN_REF_M = 50.0  # floor for m and D so a zero reference distance can't divide by zero
N_SITES = 5


# ---------------------------------------------------------------- facilities

def _addr_key(addr) -> str | None:
    """'1902 West Main St' and '1902 W Main Street, Durham' -> '1902 main'."""
    if not isinstance(addr, str) or not addr.strip():
        return None
    toks = re.findall(r"[a-z0-9]+", addr.lower())
    toks = [t for t in toks if t not in {"n", "s", "e", "w", "north", "south", "east", "west"}]
    return " ".join(toks[:2]) if toks and toks[0].isdigit() else None


def durham_food() -> gpd.GeoDataFrame:
    p = gpd.read_file(RAW / "durham_food_pantries.geojson")
    p = p[p.status.fillna("") != "Inactive"].copy()
    # Same site listed twice (e.g. "5123 Revere Rd" / "5123 Revere Road"): keep one per street address.
    p["_key"] = p.fulladdr.map(_addr_key)
    p = pd.concat([p[p._key.isna()], p[p._key.notna()].drop_duplicates("_key")])
    return gpd.GeoDataFrame({
        "name": p.name, "address": p.fulladdr, "detail": p.operdays, "source": "City of Durham Food Resources",
    }, geometry=p.geometry, crs=p.crs)


def _census_geocode(rows: list[tuple[str, str, str]]) -> dict[str, tuple[float, float]]:
    """Census Bureau batch geocoder. rows = (id, street, city). Returns id -> (lon, lat)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    for rid, street, city in rows:
        w.writerow([rid, street, city, "NC", ""])
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"benchmark\"\r\n\r\nPublic_AR_Current\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"addressFile\"; filename=\"a.csv\"\r\n"
            f"Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n").encode()
    req = urllib.request.Request("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode()
    out = {}
    for rec in csv.reader(io.StringIO(text)):
        if len(rec) >= 6 and rec[2] == "Match":
            lon, lat = map(float, rec[5].split(","))
            out[rec[0]] = (lon, lat)
    return out


def orange_food() -> gpd.GeoDataFrame:
    df = pd.read_excel(RAW / "orange_food_resources.xlsx", header=None)
    rows, section = [], None
    for _, r in df.iloc[4:].iterrows():
        name, addr = r[0], r[1]
        if isinstance(name, str) and pd.isna(addr):
            section = name.strip()
            continue
        # "Across County" entries are delivery programs or rotating sites, not fixed locations.
        if not isinstance(addr, str) or (section or "").startswith("Across County"):
            continue
        parts = [s.strip() for s in addr.split("\n")[0].split(",")]
        idx = next((i for i, s in enumerate(parts) if re.match(r"^\d+\s+\S", s)), None)
        if idx is None:
            continue
        city = parts[idx + 1] if idx + 1 < len(parts) else section
        rows.append({"id": str(len(rows)), "name": name.strip(), "street": parts[idx], "city": city,
                     "address": f"{parts[idx]}, {city}", "detail": r[2] if isinstance(r[2], str) else None})
    rows = pd.DataFrame(rows)

    cache = INTERIM / "orange_food_geocoded.csv"
    if cache.exists():
        geo = pd.read_csv(cache, dtype={"id": str})
    else:
        hits = _census_geocode(list(rows[["id", "street", "city"]].itertuples(index=False)))
        # Batch misses: retry each with the single-line geocoder, which matches some route-style addresses.
        for r in rows[~rows.id.isin(hits)].itertuples():
            q = urllib.parse.urlencode({"address": f"{r.street}, {r.city}, NC", "benchmark": "Public_AR_Current",
                                        "format": "json"})
            with urllib.request.urlopen(f"https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?{q}",
                                        timeout=30) as resp:
                m = json.load(resp)["result"]["addressMatches"]
            if m:
                hits[r.id] = (m[0]["coordinates"]["x"], m[0]["coordinates"]["y"])
        geo = pd.DataFrame([{"id": k, "lon": v[0], "lat": v[1]} for k, v in hits.items()])
        geo.to_csv(cache, index=False)
    rows = rows.merge(geo, on="id", how="left")
    missed = rows[rows.lon.isna()]
    if len(missed):
        print(f"  Orange: {len(missed)} of {len(rows)} addresses not geocoded:", missed.address.tolist())
    rows = rows.dropna(subset=["lon"])
    return gpd.GeoDataFrame({
        "name": rows.name, "address": rows.address, "detail": rows.detail,
        "source": "Orange County Cooperative Extension food resource list (Aug 2026)",
    }, geometry=gpd.points_from_xy(rows.lon, rows.lat), crs=4326)


def health_centers() -> gpd.GeoDataFrame:
    h = pd.read_csv(RAW / "hrsa_health_centers.csv", low_memory=False)
    h = h[(h["Site State Abbreviation"] == "NC")
          & (h["Site Status Description"] == "Active")
          & (h["Health Center Location Type Description"] == "Permanent")          # no mobile vans / seasonal sites
          & (h["Health Center Type Description"] != "Administrative")              # must deliver services
          & (h["Health Center Service Delivery Site Location Setting Description"] != "School")]  # students only
    return gpd.GeoDataFrame({
        "name": h["Site Name"], "address": h["Site Address"] + ", " + h["Site City"],
        "detail": h["Health Center Type"], "source": "HRSA Health Center Service Delivery Sites",
    }, geometry=gpd.points_from_xy(h["Geocoding Artifact Address Primary X Coordinate"],
                                   h["Geocoding Artifact Address Primary Y Coordinate"]), crs=4326)


def transit_stops() -> gpd.GeoDataFrame:
    s = gpd.read_file(RAW / "nc_transit_stops.geojson")
    s = s[s.location_type.fillna("").isin(["0", "", "Null"])]  # boarding points, not station parents
    # The same physical stop can appear in several agencies' feeds: keep one per ~10 m.
    s = s.loc[~pd.Series(list(zip(s.geometry.x.round(4), s.geometry.y.round(4))), index=s.index).duplicated()]
    return gpd.GeoDataFrame({
        "name": s.stop_name, "address": None, "detail": s.stop_type_text.str.replace('"', ""),
        "source": "USDOT National Transit Map stops",
    }, geometry=s.geometry, crs=4326)


def libraries() -> gpd.GeoDataFrame:
    with zipfile.ZipFile(RAW / "imls_libraries_2024.zip") as z:
        o = pd.read_csv(z.open("CSV/pls_fy23_outlet_pud23i.csv"), encoding="latin-1", low_memory=False)
    # Central and branch public-library outlets only (no bookmobiles); drop temporarily closed (STATSTRU 23).
    o = o[(o.STABR == "NC") & o.C_OUT_TY.isin(["CE", "BR"]) & (o.STATSTRU != 23)]
    return gpd.GeoDataFrame({
        "name": o.LIBNAME.str.title(), "address": o.ADDRESS.str.title() + ", " + o.CITY.str.title(),
        "detail": o.C_OUT_TY.map({"CE": "Central library", "BR": "Branch library"}),
        "source": "IMLS Public Libraries Survey FY2023 (outlets)",
    }, geometry=gpd.points_from_xy(o.LONGITUD, o.LATITUDE), crs=4326)



def wake_food() -> gpd.GeoDataFrame:
    w = gpd.read_file(RAW / "wake_food_pantries.geojson")
    return gpd.GeoDataFrame({
        "name": w.AllPantries0418_txt_Name, "address": w.AllPantries0418_txt_Address, "detail": w.Operating_Hours,
        "source": "Wake County food pantry map (2018 directory)",
    }, geometry=w.geometry, crs=4326)


def new_hanover_food() -> gpd.GeoDataFrame:
    n = gpd.read_file(RAW / "new_hanover_food_pantries.geojson")
    return gpd.GeoDataFrame({
        "name": n.Name, "address": n.Address, "detail": n.PopupInfo, "source": "New Hanover County food pantry map",
    }, geometry=n.geometry, crs=4326)


def synthetic_food(tracts: gpd.GeoDataFrame, real: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Modeled food-assistance sites for counties without an inventory.

    Count per county = county population / (residents per site in Durham + Orange, which have current
    county-wide inventories). Each site is placed at a random point inside a tract drawn with probability
    proportional to tract population. Fixed seed, so results are reproducible."""
    pop_d = tracts[tracts.COUNTYFP.isin(DENSITY_COUNTIES)]["pop"].sum()
    real_in = gpd.sjoin(real, tracts[["COUNTYFP", "geometry"]], predicate="within")
    per_site = pop_d / real_in.COUNTYFP.isin(DENSITY_COUNTIES).sum()
    rng = np.random.default_rng(SEED)
    pts, names = [], []
    for fips, g in tracts[~tracts.COUNTYFP.isin(FOOD_INVENTORY) & (tracts["pop"] > 0)].groupby("COUNTYFP"):
        n = max(1, round(g["pop"].sum() / per_site))
        picks = rng.choice(len(g), size=n, p=(g["pop"] / g["pop"].sum()).values)
        for k in picks:
            poly = g.geometry.iloc[k]
            minx, miny, maxx, maxy = poly.bounds
            for _ in range(200):
                x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
                if poly.contains(shapely.Point(x, y)):
                    break
            else:
                x, y = poly.representative_point().coords[0]
            pts.append(shapely.Point(x, y))
            names.append(f"Modeled food site ({g.county.iloc[0]})")
    print(f"  modeled food sites: {len(pts)} (1 per {per_site:,.0f} residents)")
    return gpd.GeoDataFrame({"name": names, "address": None, "detail": None,
                             "source": "Modeled location (no county inventory available)"},
                            geometry=pts, crs=CRS_M), per_site


def load_facilities(tracts: gpd.GeoDataFrame):
    real_food = gpd.GeoDataFrame(pd.concat([durham_food(), orange_food(), wake_food(), new_hanover_food()]),
                                 crs=4326).to_crs(CRS_M)
    modeled, per_site = synthetic_food(tracts, real_food)
    real_food["modeled"] = False
    modeled["modeled"] = True
    parts = {"food": pd.concat([real_food, modeled]), "health": health_centers(), "transit": transit_stops(),
             "library": libraries()}
    nc = tracts.union_all()
    frames = []
    for cat, g in parts.items():
        g = gpd.GeoDataFrame(g, crs=g.crs or 4326).to_crs(CRS_M)
        g = g[g.geometry.within(nc)].copy()
        g["category"] = cat
        g["modeled"] = g.get("modeled", False)
        g["modeled"] = g["modeled"].fillna(False).astype(bool)
        frames.append(g)
        print(f"  {cat}: {len(g)} facilities ({int(g.modeled.sum())} modeled)")
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=CRS_M), per_site


# ---------------------------------------------------------------- demand points

def demand_points(tracts: gpd.GeoDataFrame):
    """Evenly spaced points inside each populated tract, each carrying an equal share of its population."""
    xs, ys, tid = [], [], []
    for i, (geom, pop) in enumerate(zip(tracts.geometry, tracts["pop"])):
        if pop <= 0:
            continue
        s = min(POINT_SPACING_M, np.sqrt(geom.area / MIN_POINTS))
        minx, miny, maxx, maxy = geom.bounds
        gx, gy = np.meshgrid(np.arange(minx + s / 2, maxx, s), np.arange(miny + s / 2, maxy, s))
        gx, gy = gx.ravel(), gy.ravel()
        inside = shapely.contains_xy(geom, gx, gy)
        if not inside.any():
            rp = geom.representative_point()
            gx, gy, inside = np.array([rp.x]), np.array([rp.y]), np.array([True])
        xs.append(gx[inside]); ys.append(gy[inside]); tid.append(np.full(inside.sum(), i))
    xy = np.column_stack([np.concatenate(xs), np.concatenate(ys)])
    tid = np.concatenate(tid)
    counts = np.bincount(tid, minlength=len(tracts))
    w = tracts["pop"].values[tid] / counts[tid]
    return xy, tid, w


def access_score(d, m, D):
    """A(d) = max(0, 100/(1 + d/m) - (d/D)^2). Decreasing in d; equals 0 for every d >= 10 D."""
    return np.maximum(0.0, 100.0 / (1.0 + d / m) - (d / D) ** 2)


def weighted_median(x, w):
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    return float(x[o][np.searchsorted(cw, cw[-1] / 2)])


def midrank_pct(sorted_ref: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Percent of reference tracts with lower access, ties split evenly."""
    lo = np.searchsorted(sorted_ref, v, side="left")
    hi = np.searchsorted(sorted_ref, v, side="right")
    return (lo + hi) / 2 / len(sorted_ref) * 100


# ---------------------------------------------------------------- recommendations

class Planner:
    """Greedy joint (service, location) search over the continuous distance model."""

    def __init__(self, tracts, xy, tid, w, dist, m_pt, D):
        self.tracts, self.xy, self.tid, self.w = tracts, xy, tid, w
        self.pop = tracts["pop"].values.astype(float)
        self.tree = cKDTree(xy)
        h = np.nan_to_num(tracts.hardship_pct.values, nan=0.0)[tid] / 100  # unscored tracts: no priority weight
        # S counts a point's score gain (0-100) as P_i * H_i/100 * dA_i with dA_i on a 0-1 scale, over 4 services.
        self.value = w * h / len(CATS) / 100
        self.dist0, self.m_pt, self.D = dist, m_pt, D
        self.A0 = {c: access_score(dist[c], m_pt[c], D[c]) for c in CATS}
        self.cands, self.cand_tree, self.cand_county, self.gain0 = {}, {}, {}, {}
        urban = tracts.urban.values[tid] == 1
        for c in CATS:
            g = CANDIDATE_SPACING[c]
            keep = urban if c == "transit" else np.ones(len(xy), bool)  # fixed-route transit: urban tracts only
            cells = np.unique(np.floor(xy[keep] / g).astype(np.int64), axis=0)
            cxy = (cells + 0.5) * g
            _, nearest = self.tree.query(cxy)
            self.cands[c], self.cand_tree[c] = cxy, cKDTree(cxy)
            self.cand_county[c] = tracts.COUNTYFP.values[tid[nearest]]
            pts = np.nonzero(self.value > 0)[0]
            self.gain0[c] = self._pair_gains(c, pts, self.dist0[c][pts], self.A0[c][pts])
            print(f"  {c}: {len(cxy):,} candidate sites")

    def _pair_gains(self, c, pts, d_now, a_now, chunk=40000):
        """Sum over points of value * (A(dist to candidate) - A(now)), for candidates closer than the current site."""
        out = np.zeros(len(self.cands[c]))
        cap = 10 * self.D[c]  # A is 0 beyond 10 D, so farther candidates can't help
        for s in range(0, len(pts), chunk):
            p = pts[s:s + chunk]
            r = np.minimum(d_now[s:s + chunk], cap)
            lists = self.cand_tree[c].query_ball_point(self.xy[p], r)
            lens = np.fromiter((len(l) for l in lists), int, len(lists))
            if lens.sum() == 0:
                continue
            ci = np.fromiter(itertools.chain.from_iterable(lists), int, lens.sum())
            pi = np.repeat(np.arange(len(p)), lens)
            dd = np.linalg.norm(self.cands[c][ci] - self.xy[p[pi]], axis=1)
            gain = self.value[p[pi]] * np.maximum(0, access_score(dd, self.m_pt[c][p[pi]], self.D[c]) - a_now[s:s + chunk][pi])
            out += np.bincount(ci, weights=gain, minlength=len(out))
        return out

    def run(self, allowed, county=None, k=N_SITES):
        dist = {c: self.dist0[c].copy() for c in allowed}
        A = {c: self.A0[c].copy() for c in allowed}
        gains = {c: self.gain0[c].copy() for c in allowed}
        masks = {c: (self.cand_county[c] == county) if county else None for c in allowed}
        steps = []
        for _ in range(k):
            best = None
            for c in allowed:
                g = gains[c] if masks[c] is None else np.where(masks[c], gains[c], -1)
                j = int(np.argmax(g))
                if best is None or g[j] > best[2]:
                    best = (c, j, g[j])
            c, j, s = best
            if s <= 0:
                break
            x = self.cands[c][j]
            ball = np.array(self.tree.query_ball_point(x, 10 * self.D[c]), dtype=int)
            dnew = np.linalg.norm(self.xy[ball] - x, axis=1)
            closer = dnew < dist[c][ball]
            aff, dnew = ball[closer], dnew[closer]
            anew = access_score(dnew, self.m_pt[c][aff], self.D[c])
            dold, aold = dist[c][aff].copy(), A[c][aff].copy()
            # Marginal gains of other candidates change only through these points: remove old, add new contributions.
            v = self.value[aff] > 0
            gains[c] -= self._pair_gains(c, aff[v], dold[v], aold[v])
            gains[c] += self._pair_gains(c, aff[v], dnew[v], anew[v])
            dist[c][aff], A[c][aff] = dnew, anew

            dA = np.bincount(self.tid[aff], weights=self.w[aff] * (anew - aold), minlength=len(self.pop))
            better = anew > aold + 1e-9
            nres = np.bincount(self.tid[aff[better]], weights=self.w[aff[better]], minlength=len(self.pop))
            hit = np.nonzero(nres >= 1)[0]
            lon, lat = shapely.get_coordinates(gpd.GeoSeries([shapely.Point(x)], crs=CRS_M).to_crs(4326).values[0])[0]
            _, nearest = self.tree.query(x)
            wb = self.w[aff[better]]
            steps.append({
                "cat": c, "lat": round(float(lat), 5), "lon": round(float(lon), 5),
                "geoid": self.tracts.geoid.iloc[self.tid[nearest]],
                "residents_closer": round(float(wb.sum())),
                "avg_miles_closer": round(float((wb * (dold[better] - dnew[better])).sum() / max(wb.sum(), 1) / MILE), 2),
                "score": round(float(s), 1),
                # [geoid, change in this service's tract score (0-100 points), residents now closer]
                "tracts": [[self.tracts.geoid.iloc[i], round(float(dA[i] / self.pop[i]), 2), round(float(nres[i]))] for i in hit],
            })
        return steps


# ---------------------------------------------------------------- main

def main():
    tracts = gpd.read_file(INTERIM / "tracts_full.gpkg").to_crs(CRS_M).reset_index(drop=True)

    print("Facilities:")
    fac, per_site = load_facilities(tracts)

    print("Demand points:")
    xy, tid, w = demand_points(tracts)
    print(f"  {len(xy):,} points over {int((tracts['pop'] > 0).sum())} populated tracts")
    county_pt = tracts.COUNTYFP.values[tid]
    pop = tracts["pop"].values.astype(float)

    dist, m_pt, D, refs = {}, {}, {}, {}
    scores = pd.DataFrame(index=tracts.geoid)
    miles = pd.DataFrame(index=tracts.geoid)
    with np.errstate(invalid="ignore", divide="ignore"):
        for c in CATS:
            fxy = shapely.get_coordinates(fac[fac.category == c].geometry.values)
            dist[c], _ = cKDTree(fxy).query(xy)
            # Reference distances from baseline sites, fixed for all later evaluations.
            dfc = pd.DataFrame({"county": county_pt, "wd": w * dist[c], "w": w}).groupby("county").sum()
            m_county = (dfc.wd / dfc.w).clip(lower=MIN_REF_M)
            m_pt[c] = m_county.reindex(county_pt).values
            D[c] = max(weighted_median(dist[c], w), MIN_REF_M)
            a = access_score(dist[c], m_pt[c], D[c])
            scores[c] = np.bincount(tid, weights=w * a, minlength=len(tracts)) / pop
            miles[c] = np.bincount(tid, weights=w * dist[c], minlength=len(tracts)) / pop / MILE
            refs[c] = {"D_miles": round(D[c] / MILE, 2),
                       "m_miles_county_median": round(float(m_county.median() / MILE), 2),
                       "m_miles_county_range": [round(float(m_county.min() / MILE), 2), round(float(m_county.max() / MILE), 2)],
                       "statewide_mean_score": round(float((w * a).sum() / w.sum()), 1)}
            print(f"  {c}: D = {D[c] / MILE:.2f} mi, county m median {m_county.median() / MILE:.2f} mi "
                  f"(range {m_county.min() / MILE:.2f}-{m_county.max() / MILE:.2f}), mean score {refs[c]['statewide_mean_score']}")
    scores["A"] = scores[CATS].mean(axis=1)
    ref = np.sort(scores.A.dropna().values)
    scores["pct"] = np.where(scores.A.notna(), midrank_pct(ref, scores.A.fillna(0).values), np.nan)

    print("Recommendations:")
    planner = Planner(tracts, xy, tid, w, dist, m_pt, D)
    subsets = [s for n in range(1, len(CATS) + 1) for s in itertools.combinations(CATS, n)]
    counties = sorted(tracts.COUNTYFP.unique())
    (OUT / "plans").mkdir(parents=True, exist_ok=True)
    for scope in ["nc"] + counties:
        plans = {"+".join(s): planner.run(list(s), None if scope == "nc" else scope) for s in subsets}
        (OUT / "plans" / f"{scope}.json").write_text(json.dumps(plans, separators=(",", ":")))
    ex = json.loads((OUT / "plans" / "nc.json").read_text())["+".join(CATS)]
    for i, st in enumerate(ex):
        print(f"    NC #{i + 1}: {st['cat']} in {st['geoid']}: {st['residents_closer']:,} residents closer "
              f"(avg {st['avg_miles_closer']} mi), S={st['score']:,}")

    county_names = tracts.groupby("COUNTYFP").county.first().to_dict()
    access = {
        "services": {c: {**SERVICES[c], **refs[c], "facilities": int((fac.category == c).sum()),
                         "modeled": int(((fac.category == c) & fac.modeled).sum())} for c in CATS},
        "food_inventory_counties": FOOD_INVENTORY,
        "food_residents_per_modeled_site": round(float(per_site)),
        "counties": [{"fips": f, "name": county_names[f]} for f in counties],
        "reference_A_sorted": np.round(ref, 3).tolist(),
        # geoid -> [F, H, T, L, A, percentile] (scores 0-100); null where the tract has no residents
        "tracts": {g: (None if pd.isna(r.A) else [round(float(r[c]), 2) for c in CATS] + [round(float(r.A), 3), round(float(r.pct), 1)])
                   for g, r in scores.iterrows()},
        # geoid -> population-weighted mean straight-line miles to the nearest site, per service
        "miles": {g: (None if pd.isna(r.food) else [round(float(r[c]), 2) for c in CATS]) for g, r in miles.iterrows()},
    }
    (OUT / "access.json").write_text(json.dumps(access, separators=(",", ":")))

    out = fac.to_crs(4326)[["category", "name", "address", "detail", "source", "modeled", "geometry"]]
    out.loc[out.category == "transit", ["address", "detail", "source"]] = None  # keep the transit layer light
    out.to_file(OUT / "facilities.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    for f in ("access.json", "facilities.geojson", "plans/nc.json"):
        print(f, f"{(OUT / f).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
