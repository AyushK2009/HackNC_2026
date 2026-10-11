// Map layers. Each layer is a tract-level measure; `higherIsWorse` keeps "darker = more need"
// consistent across layers (income is the one measure where low values indicate hardship).

export type TractProps = {
  geoid: string
  county: string
  urban: number
  pop: number
  households: number
  land_sq_mi: number
  gq_share: number
  poverty_rate: number | null
  median_income: number | null
  snap_share: number | null
  no_vehicle_share: number | null
  low_access_share: number | null
  low_access_half_share: number | null
  pc1: number | null
  pc2: number | null
  hardship_pct: number | null
  scored: boolean
  income_imputed: boolean
  [key: string]: unknown
}

export type Metric = {
  key: keyof TractProps & string
  label: string
  short: string
  description: string
  source: string
  higherIsWorse: boolean
  format: (v: number) => string
  // Fixed class breaks; when omitted, breaks are quantiles of the displayed tracts.
  breaks?: number[]
}

const pct = (v: number) => `${v.toFixed(1)}%`
const usd = (v: number) => (v >= 250000 ? '$250k+' : `$${Math.round(v / 1000)}k`)

export const METRICS: Metric[] = [
  {
    key: 'hardship_pct',
    label: 'Economic Hardship Index',
    short: 'Hardship index',
    description:
      'Percentile rank among North Carolina tracts on the first principal component of poverty, income, SNAP use and vehicle access. 90 means more hardship than 90% of NC tracts.',
    source: 'PCA on USDA ERS tract data (fit on all NC tracts)',
    higherIsWorse: true,
    format: (v) => `${Math.round(v)}`,
    breaks: [20, 40, 60, 80, 90],
  },
  {
    key: 'poverty_rate',
    label: 'Poverty rate',
    short: 'Poverty',
    description: 'Share of residents with income at or below the federal poverty threshold.',
    source: 'USDA ERS · PovertyRate',
    higherIsWorse: true,
    format: pct,
  },
  {
    key: 'median_income',
    label: 'Median family income',
    short: 'Income',
    description: 'Tract median family income. Darker shading means lower income.',
    source: 'USDA ERS · MedianFamilyIncome',
    higherIsWorse: false,
    format: usd,
  },
  {
    key: 'snap_share',
    label: 'Households on SNAP',
    short: 'SNAP',
    description: 'Share of occupied housing units receiving SNAP (food stamp) benefits.',
    source: 'USDA ERS · TractSNAP ÷ OHU2020',
    higherIsWorse: true,
    format: pct,
  },
  {
    key: 'no_vehicle_share',
    label: 'Households without a vehicle',
    short: 'No vehicle',
    description: 'Share of occupied housing units with no vehicle available.',
    source: 'USDA ERS · TractHUNV ÷ OHU2020',
    higherIsWorse: true,
    format: pct,
  },
  {
    key: 'low_access_share',
    label: 'Far from a SNAP retailer',
    short: 'Retailer distance',
    description:
      'Share of residents more than 1 mile (urban) or 10 miles (rural) driving distance from any SNAP-authorized store. Stores, not food pantries.',
    source: 'USDA ERS · DD_SRAM_LAPOP1_10 ÷ POP2020',
    higherIsWorse: true,
    format: pct,
  },
]

// Index features in model.json order, with display names for the score breakdown.
export const INDEX_FEATURE_LABELS: Record<string, string> = {
  poverty_rate: 'Poverty rate',
  neg_log_income: 'Low income',
  snap_share: 'SNAP households',
  no_vehicle_share: 'No vehicle',
}

// Sequential single-hue ramp (light → dark = less → more need).
export const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281']
export const NO_DATA = '#e4e3df'
