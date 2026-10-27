# Allocate NC

**A shared, living picture of what North Carolina communities are missing — and a place to act on it.**

Residents describe what's hard to reach in their own words. The model updates the need estimate where they live.
Volunteers are matched to where they're needed most. Nonprofits and planners turn the same picture into budgeted,
optimized, trackable projects — and when a project is finished, need falls on the map where it reaches.

## What's in the app
Pick your county once (top bar, or the start box on the landing page) and every page starts there.

| Section | Who it's for | What you can do |
|---|---|---|
| **Home** (`#/home`) | Everyone | Your county at a glance: its biggest needs against the state average, the neighborhoods with the most need, the latest reports, sign-ups and projects there, and a starting point for each task. |
| **Community map** (`#/map`) | Everyone | Community need for every NC neighborhood across six kinds of need (food, health care, transportation, internet & library, housing, childcare). A legend explains each layer; open any neighborhood to see *why* it's underserved, read and confirm resident reports, and jump straight to reporting, volunteering or planning there. |
| **Report a need** (`#/report`) | Residents | Write a problem in plain words; the system extracts the kind of need, barriers, who's affected, seriousness and urgency (editable), pins it to a neighborhood and shows how the estimate changed. Neighbors can confirm reports ("me too"). |
| **Volunteer** (`#/involved`) | Volunteers | Say where you are, what you care about and how much time you have; get opportunities ranked by how much need there is where they happen, fit, distance and time, with the reason for each match; sign up and fill real project roles. |
| **Plan services** (`#/plan`) | Nonprofits, planners | A three-step builder (where, resources, kinds of help) with sensible defaults. An integer program picks the best mix of permanent facilities, mobile and pop-up services, programs, events, or your own idea in plain words. See where each action goes, how need changes, and compare saved plans. |
| **Projects** (`#/projects`) | Nonprofits, planners | A board from proposed to complete: milestones, volunteer roles, optimal staffing, an auto-written project brief, and completion that lowers need on the map. |
| **Walkthrough** (`#/tour`) | Anyone new | A live, five-step run of the whole cycle in Durham County: report → need rises → plan → staffed project → need falls. |

## Run locally
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm install && cd ..
./dev.sh            # backend on :8000 (FastAPI) + web app on :5173 (Vite, proxies /api)
```
Open http://localhost:5173. The backend creates and seeds `web/server/allocate.db` on first run (demo data:
simulated reports, organizations, opportunities, volunteers and projects with fictional names);
`POST /api/reset` reseeds it. Set `ANTHROPIC_API_KEY` to use Claude for report understanding, custom-idea
parsing and project briefs; without it, built-in local models do the same jobs.

## Models at a glance
- **Economic Hardship Index** — PCA of poverty, income, SNAP use and car access (below).
- **Service access** — continuous distance model to food, health, transit and library sites (below).
- **Community need** — Bayesian evidence fusion: public-data priors per neighborhood and need type, updated by
  resident reports weighted by credibility, seriousness, recency and distance; with uncertainty intervals.
- **Report understanding** — TF-IDF + logistic-regression multi-label classifier with barrier/group lexicons
  (or Claude when a key is set).
- **Planning** — budgeted maximum-coverage integer program (scipy `milp`) over intervention types × sites with
  budget, volunteer-hour, capacity and spacing constraints.
- **Matching** — need-weighted TF-IDF relevance for opportunities; Hungarian algorithm for volunteer staffing.

## How it works

### Economic Hardship Index (statewide)
Four tract measures — poverty rate, median family income (log, sign-flipped), share of households on SNAP,
share of households without a vehicle — were chosen as indicators of economic hardship. They are standardized
against all North Carolina tracts and combined with PCA. The first principal component explains 72% of the
variance and weights the four measures almost equally; each tract's score is reported as a percentile among
NC tracts (0–100). It is a relative ranking of economic hardship, not a measure of food insecurity.

The PCA is fit on typical residential tracts (at least 500 residents, under 67% in group quarters such as
dorms or prisons); every tract with valid measurements is then scored with that fitted model. Tracts are left
unscored only when an input is missing or impossible (a share above 100%). Suppressed median incomes are
estimated from the other three measures by linear regression.

### Service Access (statewide) — a separate, distance-based model
Service Access is **not** derived from the hardship PCA. It measures how far residents live from four kinds of
sites — food assistance, community health centers (HRSA-funded, permanent, non-school), transit stops, and public
libraries (central + branch) — using straight-line distance in NC State Plane meters.

**Residents.** Each tract is represented by evenly spaced sample points (at most 500 m apart, at least ~20 per
tract) that share its population equally; residents are assumed evenly spread within a tract.

**Score per service.** For a sample point and service *c*, with *d* the distance to the nearest site of *c*:

    A_c(d) = max(0, 100 / (1 + d / m) − (d / D)²)

- *m* — population-weighted **mean** distance to service *c* among residents of the point's **county**
  (what is typical locally).
- *D* — population-weighted **median** distance to service *c* across **all of North Carolina** (a statewide
  yardstick).

The first term rewards being close relative to what is normal in the county (a resident at the county's typical
distance scores 50); the second independently penalizes long absolute distances (it costs 1 point at *d* = *D*
and 100 points at *d* = 10*D*). *m* and *D* are computed once from existing sites and held fixed when proposed
sites are evaluated; both are floored at 50 m. A tract's service score is the population-weighted mean of its
points' scores. There are no fixed service radii.

**Service Accessibility Percentile.** For tract *i*:

    A_i = (A_food,i + A_health,i + A_transit,i + A_library,i) / 4

A_i is ranked against all populated NC tracts at baseline (ties split evenly) — one statewide reference, no
separate county or urban/rural rankings. 10 means better access than only 10% of NC neighborhoods. Before/after
comparisons rank against the same baseline. Equal weights are a transparent modeling choice.


### Finding the best improvements
The planner evaluates every allowed service type *c* (all four by default, or any subset) at candidate
locations *x* on a regular grid over populated areas (1.5 km for food, 3 km for health centers, 2 km for
libraries, 1 km for transit in urban tracts only):

    S(c, x) = Σ_i P_i · (Hardship_i / 100) · ΔA_i(c, x)

where P_i is tract *i*'s population, Hardship_i its hardship percentile, and ΔA_i(c, x) the increase in its
overall score A_i (on a 0–1 scale) when residents closer to *x* than to any existing *c* site get *x* as their
nearest site. Only service *c* changes — a new library never improves food access. The best (c, x) is chosen,
distances are updated, and gains are recomputed before the next pick, so later sites can be different types and
no improvement is counted twice. Results are precomputed for all of NC and for each county, for every
combination of services and up to 5 sites.

The planner reports how many residents end up closer to a service, the average distance saved, and each affected
neighborhood's access percentile before and after. Hardship only sets priority; a new site changes access, not
the hardship score. Proposed sites are planning scenarios, not vetted parcels; cost and feasibility are not
modeled.

## Data sources
Raw files are not stored in this repository. Download them into `data/raw/` with these names:

| Local file | Contents | Source |
|---|---|---|
| `usda_sram_2025.zip` | Tract socioeconomic + SNAP-retailer access measures | USDA ERS, Food Access Research Atlas — SNAP-authorized Retailer Access Map: https://ers.usda.gov/data-products/food-access-research-atlas/download-the-data |
| `nc_tracts_2020.zip` | NC census tract boundaries | U.S. Census Bureau TIGER/Line 2020: https://www2.census.gov/geo/tiger/TIGER2020/TRACT/tl_2020_37_tract.zip |
| `durham_food_pantries.geojson` | Food pantry locations (Durham County) | City of Durham Food Resources, layer 2: https://webgis2.durhamnc.gov/server/rest/services/PublicServices/Food_Resources/MapServer/2 |
| `orange_food_resources.xlsx` | Food resource list with addresses (Orange County) | NC Cooperative Extension, Orange County Center: https://go.ncsu.edu/foodfororange |
| `wake_food_pantries.geojson` | Food pantry locations (Wake County, 2018 directory) | Wake County GIS food pantry map |
| `new_hanover_food_pantries.geojson` | Food pantry locations (New Hanover County) | New Hanover County GIS food pantry map |
| `hrsa_health_centers.csv` | Health center service delivery sites | HRSA Data Warehouse, Health Center Service Delivery and Look-Alike Sites: https://data.hrsa.gov/data/download |
| `nc_transit_stops.geojson` | Transit stops | USDOT National Transit Map — run `python scripts/fetch_transit.py` |
| `imls_libraries_2024.zip` | Public library outlets (FY2023 survey) | IMLS Public Libraries Survey: https://www.imls.gov/research-evaluation/data-collection/public-libraries-survey |

Orange County addresses are geocoded with the U.S. Census Bureau geocoder on first run (cached in `data/interim/`).

## Rebuild the map data (optional)
The processed data the app needs is committed in `web/public/data/`, so the app runs from a clean clone:

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

To rebuild that data from the raw sources (see Data sources):

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_transit.py      # transit stops (once)
.venv/bin/python scripts/build_data.py         # statewide hardship index
.venv/bin/python scripts/build_access.py       # statewide service access + recommendations (several minutes)
.venv/bin/python scripts/build_story.py        # landing-page story data
```

## Deploy
The original map site is static. On Vercel, set **Root Directory** to `web`; `web/vercel.json` runs `npm ci` and
`npm run build` and serves `dist`. No server or environment variables are needed.

The community features (reports, planning, matching) use the FastAPI backend in `web/server/`. Locally it runs with `./dev.sh`; on Vercel it runs as a Python function (`web/api/index.py`) next to the static site.

## Limitations
- Distances are straight-line, not walking or driving routes; residents are assumed evenly spread within a tract.
- Facility lists may be incomplete or out of date; a missing record is not proof a service doesn't exist.
- Transit stops say nothing about service frequency.
- Poverty rates in some tracts near universities likely include students; the index does not adjust for this.

## Stack
Python (pandas, GeoPandas, Shapely, scikit-learn, SciPy) for offline processing and the FastAPI + SQLite backend; React + TypeScript + Vite + Leaflet for the app; optional Claude API.
