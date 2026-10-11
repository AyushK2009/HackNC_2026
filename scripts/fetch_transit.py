"""Download USDOT National Transit Map stops in a box around North Carolina to data/raw/nc_transit_stops.geojson."""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_National_Transit_Map_Stops/FeatureServer/0/query"
# Saved under the repo regardless of the folder it is run from.
OUT = Path(__file__).resolve().parents[1] / "data" / "raw" / "nc_transit_stops.geojson"
PAGE = 2000  # the layer's maxRecordCount

def fetch(params):
    body = urllib.parse.urlencode(params).encode()
    for attempt in range(1, 6):
        try:
            req = urllib.request.Request(BASE, data=body, headers={"User-Agent": "AccessAtlas/1.0"})
            # Short timeout: a stalled request fails fast and is retried instead of hanging for minutes.
            with urllib.request.urlopen(req, timeout=30) as r:
                result = json.load(r)
            if "error" in result:
                raise RuntimeError(str(result["error"]))
            return result
        except Exception as e:
            if attempt == 5:
                raise
            wait = 2 * attempt
            print(f"  request failed ({type(e).__name__}: {e}); retry {attempt}/4 in {wait}s")
            time.sleep(wait)

# Bounding rectangle around North Carolina (also catches parts of SC/GA/TN/VA).
# Points are clipped to the actual state boundary later.
spatial = {
    "where": "1=1",
    "geometry": "-84.4,33.7,-75.3,36.7",
    "geometryType": "esriGeometryEnvelope",
    "spatialRel": "esriSpatialRelIntersects",
    "inSR": "4326",
}

total = fetch({**spatial, "returnCountOnly": "true", "f": "json"})["count"]
print(f"Found {total} transit records in regional bounds")

# Page through results directly (the layer supports pagination) instead of listing every ID first.
features = []
while len(features) < total:
    result = fetch({
        **spatial,
        "outFields": "*",
        "outSR": "4326",
        "returnGeometry": "true",
        "orderByFields": "OBJECTID",
        "resultOffset": len(features),
        "resultRecordCount": PAGE,
        "f": "geojson",
    })
    rows = result.get("features", [])
    if not rows:
        break
    features.extend(rows)
    print(f"Downloaded {len(features)} / {total}")

if len(features) != total:
    raise RuntimeError(f"Expected {total} records, got {len(features)}")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
print(f"Saved {len(features)} features to {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
