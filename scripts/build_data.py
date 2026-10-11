"""Build the statewide Economic Hardship data for AccessAtlas.

Inputs (data/raw/, not committed):
  usda_sram_2025.zip   USDA ERS Food Access Research Atlas — SNAP-authorized Retailer Access Map (2026 release)
  nc_tracts_2020.zip   Census TIGER/Line 2020 NC census tracts

Outputs (web/public/data/):
  tracts.geojson   every NC tract with raw measures, PCA score, NC percentile
  model.json       fitted standardization + PCA parameters (NC reference)

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
INTERIM = ROOT / "data" / "interim"
OUT = ROOT / "web" / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)
INTERIM.mkdir(parents=True, exist_ok=True)

# Features entering the PCA index. All oriented so higher = more hardship.
INDEX_FEATURES = ["poverty_rate", "neg_log_income", "snap_share", "no_vehicle_share"]
SHARE_FEATURES = ["poverty_rate", "snap_share", "no_vehicle_share"]

# Reference-population filter for fitting: tracts whose household statistics are meaningful.
MIN_POP = 500

# Raw measures shown in the UI, with the share of NC reference tracts each value exceeds.
DISPLAY_MEASURES = ["poverty_rate", "median_income", "snap_share", "no_vehicle_share"]

# Web geometry simplification (degrees; ~30 m) — statewide map at county-to-neighborhood zoom.
SIMPLIFY_DEG = 0.0003


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
    df = gen.merge(drv[["CensusTract20", "DD_SRAM_lapop1share"]], on="CensusTract20", how="left")
    assert len(df) == len(gen), "driving-distance join changed row count"

    ohu = df.OHU2020.replace(0, np.nan)
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
        # Food Access Risk: % of residents > 1 mile driving distance from any SNAP-authorized retailer.
        # One threshold for every tract (USDA's 1-mile measure), not the mixed 1-mile urban / 10-mile rural one.
        "food_access_risk": df.DD_SRAM_lapop1share,
    })
    out["neg_log_income"] = -np.log(out.median_income)
    return out


def score_status(df: pd.DataFrame) -> pd.Series:
    """Whether a tract can be scored: only missing or invalid inputs prevent a score."""
    status = pd.Series("ok", index=df.index)
    status[df[SHARE_FEATURES].isna().any(axis=1)] = "missing_data"
    # A share above 100% is impossible (e.g. more SNAP households than households) — inconsistent source data.
    status[(df[SHARE_FEATURES] > 100).any(axis=1)] = "invalid_data"
    return status


def fit_index(df: pd.DataFrame):
    df = df.copy()
    df["status"] = score_status(df)
    # Fitting uses only typical residential tracts; small and group-quarters tracts are still scored afterward
    # with the fitted transformation, since their measurements are valid.
    ref_mask = (df.status == "ok") & df.neg_log_income.notna() & (df["pop"] >= MIN_POP) & (df.gq_flag != 1)
    ref = df[ref_mask]
    scaler = StandardScaler().fit(ref[INDEX_FEATURES])
    pca = PCA().fit(scaler.transform(ref[INDEX_FEATURES]))

    # Orient PC1 so that poverty loads positively (higher score = more hardship).
    if pca.components_[0][INDEX_FEATURES.index("poverty_rate")] < 0:
        pca.components_[0] *= -1

    # USDA suppresses median income for some tracts. Rather than drop them (several are high-need),
    # impute log income from the other three features with a linear regression fit on the reference set.
    others = [f for f in INDEX_FEATURES if f != "neg_log_income"]
    reg = LinearRegression().fit(ref[others], ref["neg_log_income"])
    impute = df.neg_log_income.isna() & (df.status == "ok")
    df["income_imputed"] = impute
    df.loc[impute, "neg_log_income"] = reg.predict(df.loc[impute, others])

    scored = df.status == "ok"
    z = np.full((len(df), len(INDEX_FEATURES)), np.nan)
    z[scored.values] = scaler.transform(df.loc[scored, INDEX_FEATURES])
    df["pc1"] = z @ pca.components_[0]
    # PC1 = sum_i w_i * z_i; keep each term so the UI can show what drives a tract's score.
    for i, f in enumerate(INDEX_FEATURES):
        df[f"term_{f}"] = z[:, i] * pca.components_[0][i]

    # Percentile of each tract's PC1 against the fixed NC reference distribution.
    ref_scores = np.sort(df.loc[ref_mask, "pc1"].values)
    df["hardship_pct"] = np.where(scored, np.searchsorted(ref_scores, df.pc1.fillna(0), side="right") / len(ref_scores) * 100, np.nan)
    df["in_reference"] = ref_mask

    model = {
        "features": INDEX_FEATURES,
        "reference": f"North Carolina census tracts with population >= {MIN_POP}, <67% group quarters, "
                     "complete data, and no share above 100% (all tracts with valid inputs are scored)",
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


def add_nc_percentiles(df: pd.DataFrame) -> pd.DataFrame:
    ref = df[df.in_reference]
    for m in DISPLAY_MEASURES:
        vals = np.sort(ref[m].dropna().values)
        df[f"{m}_ncpct"] = np.where(df[m].notna(), np.searchsorted(vals, df[m].fillna(0), side="right") / len(vals) * 100, np.nan)
    return df


def build_tracts(df: pd.DataFrame) -> gpd.GeoDataFrame:
    tracts = gpd.read_file(f"zip://{RAW / 'nc_tracts_2020.zip'}")[["GEOID", "COUNTYFP", "ALAND", "geometry"]]
    # Inner join drops the 12 water-only tract polygons, which have no USDA record.
    g = tracts.merge(df, left_on="GEOID", right_on="geoid", how="inner").drop(columns="GEOID")
    assert len(g) == len(df), "USDA tract without a polygon"
    g = g.to_crs(4326)
    # Full-resolution copy for area/coverage calculations in build_access.py.
    g[["geoid", "COUNTYFP", "county", "urban", "pop", "hardship_pct", "status", "geometry"]].to_file(
        INTERIM / "tracts_full.gpkg", driver="GPKG")
    g["geometry"] = g.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True)
    keep = ["geoid", "county", "urban", "pop", "gq_share", "poverty_rate", "median_income", "snap_share",
            "no_vehicle_share", "pc1", "hardship_pct"] + [f"term_{f}" for f in INDEX_FEATURES] + \
           ["status", "income_imputed"] + [f"{m}_ncpct" for m in DISPLAY_MEASURES] + ["geometry"]
    g = g[keep]
    num = g.select_dtypes("number").columns
    g[num] = g[num].round(2)
    return g


def main():
    df = load_features()
    df, model = fit_index(df)
    df = add_nc_percentiles(df)
    tracts = build_tracts(df)

    tracts.to_file(OUT / "tracts.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
    (OUT / "model.json").write_text(json.dumps(model))

    ev = np.array(model["explained_variance_ratio"])
    print(f"Reference tracts: {model['n_reference']}")
    print("Explained variance:", ev.round(4), "cumulative:", ev.cumsum().round(4))
    print(pd.DataFrame(np.array(model["components"]).T, index=INDEX_FEATURES,
                       columns=[f"PC{i + 1}" for i in range(len(INDEX_FEATURES))]).round(4).to_string())
    print("Status counts:", tracts.status.value_counts().to_dict())
    for f in ("tracts.geojson", "model.json"):
        print(f, f"{(OUT / f).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
