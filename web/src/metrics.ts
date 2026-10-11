// Map layers. Each layer is a tract-level measure; `higherIsWorse` keeps "darker/redder = more need"
// consistent across hardship layers (income is the one measure where low values indicate hardship).

export type TractProps = {
  geoid: string
  county: string
  urban: number
  pop: number
  gq_share: number
  poverty_rate: number | null
  median_income: number | null
  snap_share: number | null
  no_vehicle_share: number | null
  pc1: number | null
  hardship_pct: number | null
  status: 'ok' | 'group_quarters' | 'low_population' | 'invalid_data' | 'missing_data'
  income_imputed: boolean
  [key: string]: unknown
}

export type Metric = {
  key: string
  label: string
  short: string
  description: string
  source: string
  higherIsWorse: boolean
  format: (v: number) => string
  // Fixed class breaks; when omitted, breaks are quantiles of scored NC tracts.
  breaks?: number[]
}

const pct = (v: number) => `${v.toFixed(1)}%`
const usd = (v: number) => (v >= 250000 ? '$250k+' : `$${Math.round(v / 1000)}k`)

export const HARDSHIP_METRICS: Metric[] = [
  {
    key: 'hardship_pct',
    label: 'Economic Hardship Index',
    short: 'Hardship index',
    description: 'Rank among NC tracts on combined poverty, income, SNAP use and car access. 90 = more hardship than 90% of NC tracts.',
    source: 'PCA on USDA ERS tract data, fit on all NC tracts',
    higherIsWorse: true,
    format: (v) => `${Math.round(v)}`,
    breaks: [20, 40, 60, 80, 90],
  },
  {
    key: 'poverty_rate',
    label: 'Poverty',
    short: 'Poverty',
    description: 'Residents at or below the federal poverty line.',
    source: 'USDA ERS · PovertyRate',
    higherIsWorse: true,
    format: pct,
  },
  {
    key: 'median_income',
    label: 'Median family income',
    short: 'Income',
    description: 'Tract median family income. Redder = lower income.',
    source: 'USDA ERS · MedianFamilyIncome',
    higherIsWorse: false,
    format: usd,
  },
  {
    key: 'snap_share',
    label: 'SNAP participation',
    short: 'SNAP',
    description: 'Households receiving SNAP (food stamp) benefits.',
    source: 'USDA ERS · TractSNAP ÷ OHU2020',
    higherIsWorse: true,
    format: pct,
  },
  {
    key: 'no_vehicle_share',
    label: 'Households without vehicles',
    short: 'No vehicle',
    description: 'Households with no vehicle available.',
    source: 'USDA ERS · TractHUNV ÷ OHU2020',
    higherIsWorse: true,
    format: pct,
  },
]

// Index features in model.json order, with display names for the score breakdown.
export const INDEX_FEATURE_LABELS: Record<string, string> = {
  poverty_rate: 'Poverty rate',
  neg_log_income: 'Low income',
  snap_share: 'SNAP households',
  no_vehicle_share: 'No car',
}

export const STATUS_LABEL: Record<string, string> = {
  invalid_data: 'Inconsistent source data',
  missing_data: 'No residents or missing source data',
}

// Severity scale, air-quality style: green → yellow → orange → red → purple → maroon.
export const SEVERITY = ['#5bb36a', '#f2d44b', '#f59b3a', '#e2513c', '#94409a', '#6b1a33']
export const NO_DATA = '#d9d8d3'

export type ServiceKey = 'food' | 'health' | 'transit' | 'library'
// Marker colors chosen outside the severity hues so facilities stay distinct from the heatmap.
export const SERVICE_COLORS: Record<ServiceKey, string> = {
  food: '#1d4ed8',
  health: '#0891b2',
  transit: '#334155',
  library: '#111827',
}
export const SERVICE_SHORT: Record<ServiceKey, string> = {
  food: 'Food',
  health: 'Health',
  transit: 'Transit',
  library: 'Library',
}
export const SERVICE_NOUN: Record<ServiceKey, string> = {
  food: 'food assistance site',
  health: 'community health center',
  transit: 'transit stop',
  library: 'public library',
}
