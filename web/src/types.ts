import type { FeatureCollection, Geometry, Point } from 'geojson'
import type { ServiceKey, TractProps } from './metrics'

export type FacilityProps = {
  category: ServiceKey
  name: string | null
  address: string | null
  detail: string | null
  source: string | null
  modeled: boolean
}

export type PlanStep = {
  cat: ServiceKey
  lat: number
  lon: number
  geoid: string
  residents_closer: number
  avg_miles_closer: number
  score: number
  tracts: [string, number, number][] // [geoid, change in this service's score (0-100), residents now closer]
}

// geoid -> [F, H, T, L, A, percentile] (scores 0-100), null for tracts without residents
export type AccessRowRaw = [number, number, number, number, number, number] | null

export type AccessData = {
  services: Record<ServiceKey, { label: string; D_miles: number; m_miles_county_median: number; statewide_mean_score: number; facilities: number; modeled: number }>
  food_inventory_counties: Record<string, string>
  food_residents_per_modeled_site: number
  counties: { fips: string; name: string }[]
  reference_A_sorted: number[]
  tracts: Record<string, AccessRowRaw>
  miles: Record<string, [number, number, number, number] | null>
}

export type Model = { features: string[]; explained_variance_ratio: number[]; n_reference: number }

export type AppData = {
  tracts: FeatureCollection<Geometry, TractProps>
  facilities: FeatureCollection<Point, FacilityProps>
  access: AccessData
  model: Model
}
