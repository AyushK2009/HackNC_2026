"""Build app-ready data for AccessAtlas.

Inputs (data/raw/, not committed):
  usda_sram_2025.zip            USDA ERS Food Access Research Atlas — SNAP-authorized Retailer Access Map (2026 release)
  nc_tracts_2020.zip            Census TIGER/Line 2020 NC census tracts
  durham_food_pantries.geojson  City of Durham Food Resources MapServer layer 2

Outputs (web/public/data/, committed — small):
  tracts.geojson    Durham + Orange tracts with raw measures, PCA scores, percentiles
  pantries.geojson  De-duplicated active food pantry points
  model.json        Fitted standardization + PCA parameters (NC reference)

Run:  .venv/bin/python scripts/build_data.py
"""

import json
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

DISPLAY_COUNTIES = {"063": "Durham County", "135": "Orange County"}

# Features entering the PCA index. All oriented so higher = more hardship.
INDEX_FEATURES = ["poverty_rate", "neg_log_income", "snap_share", "no_vehicle_share"]

# Reference-population filter for fitting: tracts whose household statistics are meaningful.
MIN_POP = 500


def read_usda(name: str) -> pd.DataFrame:
    with zipfile.ZipFile(RAW / "usda_sram_2025.zip") as z:
        # Files are Windows-1252 encoded (e.g. "Doña Ana County").
        df = pd.read_csv(z.open(name), dtype={"CensusTract20": str}, encoding="cp1252", low_memory=False)
    df.columns = [c.replace("ï»¿", "").lstrip("﻿") for c in df.columns]
    return df


def load_features() -> pd.DataFrame:
    gen = read_usda("SRAM General Tract Characteristics Data.csv")
    drv = read_usda("SRAM Driving Distance Data.csv")
    gen = gen[gen.State == "North Carolina"]
    drv = drv[drv.State == "North Carolina"]
    df = gen.merge(drv[["CensusTract20", "DD_SRAM_LAPOP1_10", "DD_SRAM_lapophalfshare"]], on="CensusTract20", how="left")
    assert len(df) == len(gen), "driving-distance join changed row count"

    ohu = df.OHU2020.replace(0, np.nan)
    pop = df.POP2020.replace(0, np.nan)
    out = pd.DataFrame({
        "geoid": df.CensusTract20,
        "county": df.County20,
        "urban": df.Urban.astype(int),
        "pop": df.POP2020,
        "households": df.OHU2020,
        "gq_share": df.PCTGQTRS,
        "gq_flag": df.GroupQuartersFlag.fillna(0).astype(int),
        "poverty_rate": df.PovertyRate,                       # % of people below poverty line
        "median_income": df.MedianFamilyIncome,               # $; top-coded at 250,001
        "snap_share": df.TractSNAP / ohu * 100,               # % of households receiving SNAP
        "no_vehicle_share": df.TractHUNV / ohu * 100,         # % of households without a vehicle
        # % of people beyond 1 mi (urban) / 10 mi (rural) driving distance of any SNAP-authorized retailer
        "low_access_share": df.DD_SRAM_LAPOP1_10 / pop * 100,
        "low_access_half_share": df.DD_SRAM_lapophalfshare,  # % beyond 1/2 mile driving distance
    })
    out["neg_log_income"] = -np.log(out.median_income)
    return out


def fit_index(df: pd.DataFrame):
    ref_mask = (df["pop"] >= MIN_POP) & (df.gq_flag != 1) & df[INDEX_FEATURES].notna().all(axis=1)
    ref = df[ref_mask]
    scaler = StandardScaler().fit(ref[INDEX_FEATURES])
    pca = PCA().fit(scaler.transform(ref[INDEX_FEATURES]))

    # Orient PC1 so that poverty loads positively (higher score = more hardship).
    if pca.components_[0][INDEX_FEATURES.index("poverty_rate")] < 0:
        pca.components_[0] *= -1

    # USDA suppresses median income for some tracts. Rather than drop them (several are high-need),
    # impute log income from the other three features with a linear regression fit on the reference set.
    df = df.copy()
    others = [f for f in INDEX_FEATURES if f != "neg_log_income"]
    reg = LinearRegression().fit(ref[others], ref["neg_log_income"])
    impute = df.neg_log_income.isna() & df[others].notna().all(axis=1)
    df["income_imputed"] = impute
    df.loc[impute, "neg_log_income"] = reg.predict(df.loc[impute, others])

    scorable = df[INDEX_FEATURES].notna().all(axis=1)
    pcs = np.full((len(df), len(INDEX_FEATURES)), np.nan)
    pcs[scorable.values] = pca.transform(scaler.transform(df.loc[scorable, INDEX_FEATURES]))
    df["pc1"] = pcs[:, 0]
    df["pc2"] = pcs[:, 1]
    # PC1 = sum_i w_i * z_i; keep each term so the UI can show what drives a tract's score.
    z = np.full((len(df), len(INDEX_FEATURES)), np.nan)
    z[scorable.values] = scaler.transform(df.loc[scorable, INDEX_FEATURES])
    for i, f in enumerate(INDEX_FEATURES):
        df[f"term_{f}"] = z[:, i] * pca.components_[0][i]

    # Percentile of each tract's PC1 against the fixed NC reference distribution.
    ref_scores = np.sort(df.loc[ref_mask, "pc1"].values)
    df["hardship_pct"] = np.where(
        scorable, np.searchsorted(ref_scores, df.pc1.fillna(0), side="right") / len(ref_scores) * 100, np.nan
    )
    df["in_reference"] = ref_mask
    df["scored"] = scorable & (df["pop"] >= MIN_POP) & (df.gq_flag != 1)

    model = {
        "features": INDEX_FEATURES,
        "reference": f"North Carolina census tracts with population >= {MIN_POP}, <67% group quarters, complete data",
        "n_reference": int(ref_mask.sum()),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "components": pca.components_.tolist(),
        "explained_variance_ratio": pca.explained_variance_ratio_.tolist(),
        "income_imputation": {"inputs": others, "coef": reg.coef_.tolist(), "intercept": float(reg.intercept_),
                              "r2_on_reference": float(reg.score(ref[others], ref["neg_log_income"]))},
        "reference_pc1_sorted": ref_scores.round(4).tolist(),
    }
    return df, model


# Raw measures shown in the UI, with the share of NC reference tracts each value exceeds.
DISPLAY_MEASURES = ["poverty_rate", "median_income", "snap_share", "no_vehicle_share", "low_access_share"]


def add_nc_percentiles(df: pd.DataFrame) -> pd.DataFrame:
    ref = df[df.in_reference]
    for m in DISPLAY_MEASURES:
        vals = np.sort(ref[m].dropna().values)
        df[f"{m}_ncpct"] = np.where(df[m].notna(), np.searchsorted(vals, df[m].fillna(0), side="right") / len(vals) * 100, np.nan)
    return df


def build_tracts(df: pd.DataFrame) -> gpd.GeoDataFrame:
    tracts = gpd.read_file(f"zip://{RAW / 'nc_tracts_2020.zip'}")
    tracts = tracts[tracts.COUNTYFP.isin(DISPLAY_COUNTIES)][["GEOID", "ALAND", "geometry"]]
    g = tracts.merge(df, left_on="GEOID", right_on="geoid", how="left").drop(columns="GEOID")
    assert g.geoid.notna().all(), "tract polygon without USDA record"
    g = g.to_crs(4326)
    g["geometry"] = g.geometry.simplify(0.00015, preserve_topology=True)
    g["land_sq_mi"] = g.ALAND / 2_589_988.11
    keep = ["geoid", "county", "urban", "pop", "households", "land_sq_mi", "gq_share", "poverty_rate", "median_income",
            "snap_share", "no_vehicle_share", "low_access_share", "low_access_half_share", "pc1", "pc2",
            "hardship_pct"] + [f"term_{f}" for f in INDEX_FEATURES] + ["scored", "income_imputed"] + [f"{m}_ncpct" for m in DISPLAY_MEASURES] + ["geometry"]
    g = g[keep]
    num = g.select_dtypes("number").columns
    g[num] = g[num].round(3)
    return g


def build_pantries() -> gpd.GeoDataFrame:
    p = gpd.read_file(RAW / "durham_food_pantries.geojson")
    p = p[p.status.fillna("") != "Inactive"]
    # Same site listed twice (e.g. different schedules): keep one point per ~10 m location.
    p["_key"] = p.geometry.x.round(4).astype(str) + "," + p.geometry.y.round(4).astype(str)
    p = p.drop_duplicates("_key")
    p = p[["name", "fulladdr", "operdays", "operhours", "geometry"]].rename(columns={"fulladdr": "address", "operdays": "days", "operhours": "hours"})
    return p.to_crs(4326)


def main():
    df = load_features()
    df, model = fit_index(df)
    df = add_nc_percentiles(df)
    tracts = build_tracts(df)
    pantries = build_pantries()

    tracts.to_file(OUT / "tracts.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    pantries.to_file(OUT / "pantries.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    (OUT / "model.json").write_text(json.dumps(model))

    ev = np.array(model["explained_variance_ratio"])
    print(f"Reference tracts: {model['n_reference']}")
    print("Explained variance:", ev.round(3), "cumulative:", ev.cumsum().round(3))
    print(pd.DataFrame(np.array(model["components"]).T, index=INDEX_FEATURES,
                       columns=[f"PC{i + 1}" for i in range(len(INDEX_FEATURES))]).round(3).to_string())
    print(f"Display tracts: {len(tracts)} (scored: {int(tracts.scored.sum())}) | pantries: {len(pantries)}")
    for f in ("tracts.geojson", "pantries.geojson", "model.json"):
        print(f, f"{(OUT / f).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
