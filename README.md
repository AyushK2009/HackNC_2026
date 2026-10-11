# AccessAtlas

**Mapping community needs. Connecting people to resources.**

Government data on poverty, transportation and food access exists, but it's hard for nonprofits and local
planners to read — and knowing *where* need is doesn't tell you *where to put* a limited resource.
AccessAtlas turns public tract-level data into an interactive map of community hardship, then (in progress)
recommends where a new service site would reach the most underserved residents.

Current region: Durham and Orange Counties, North Carolina.

## What works now
- Interactive census-tract map of an **Economic Hardship Index** (PCA of poverty, income, SNAP use, vehicle
  access; percentile vs. all NC tracts).
- Switchable layers for each underlying measure, including distance to SNAP-authorized retailers.
- Click a tract for its measurements, NC percentiles, and a breakdown of what drives its index score.
- Existing Durham food pantry locations.

## Data sources
Raw files are not stored in this repository. Download them into `data/raw/` with these names:

| Local file | Contents | Source |
|---|---|---|
| `usda_sram_2025.zip` | Tract socioeconomic + SNAP-retailer access measures | USDA ERS, Food Access Research Atlas — SNAP-authorized Retailer Access Map: https://ers.usda.gov/data-products/food-access-research-atlas/download-the-data |
| `nc_tracts_2020.zip` | NC census tract boundaries | U.S. Census Bureau TIGER/Line 2020: https://www2.census.gov/geo/tiger/TIGER2020/TRACT/tl_2020_37_tract.zip |
| `durham_food_pantries.geojson` | Food pantry locations (Durham County) | City of Durham Food Resources, layer 2: https://webgis2.durhamnc.gov/server/rest/services/PublicServices/Food_Resources/MapServer/2 |

## Method (current)
**Economic Hardship Index.** Four tract measures — poverty rate, median family income (log, sign-flipped),
share of households on SNAP, share of households without a vehicle — are standardized against all North
Carolina tracts and combined with PCA. The first principal component explains 72% of the variance and weights
the four measures almost equally; each tract's score is reported as a percentile among NC tracts (0–100).
It is a relative ranking of economic hardship, not a measure of food insecurity.

Distance to SNAP-authorized retailers is shown as its own layer rather than folded into the index: across NC
it correlates *negatively* with the hardship measures, so including it would lower scores for tracts far from stores.

## Run locally
```bash
# 1. Build the app data from the raw files (writes web/public/data/)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/build_data.py

# 2. Start the app
cd web
npm install
npm run dev        # http://localhost:5173
```

## Stack
Python (pandas, GeoPandas, scikit-learn) for offline processing; React + TypeScript + Vite + Leaflet for the app.
