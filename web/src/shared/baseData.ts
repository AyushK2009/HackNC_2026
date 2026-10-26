import { useEffect, useState } from 'react'
import type { FeatureCollection, Geometry, Point } from 'geojson'
import type { TractProps } from '../metrics'
import type { AccessData, FacilityProps, Model } from '../types'

// Static map data from the offline pipeline (web/public/data). Loaded once, shared by every page.
export type BaseData = {
  tracts: FeatureCollection<Geometry, TractProps>
  facilities: FeatureCollection<Point, FacilityProps>
  access: AccessData
  model: Model
  byId: Map<string, TractProps>
  centroid: Map<string, [number, number]> // geoid -> [lat, lon]
}

let cache: Promise<BaseData> | null = null
const load = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => r.json())

function center(g: Geometry): [number, number] {
  // Mean of the outer-ring vertices: good enough for labels and distances at tract scale.
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : []
  let x = 0, y = 0
  for (const [lx, ly] of ring) { x += lx; y += ly }
  return ring.length ? [y / ring.length, x / ring.length] : [35.5, -79.5]
}

export function loadBaseData(): Promise<BaseData> {
  cache ??= Promise.all([load('tracts.geojson'), load('facilities.geojson'), load('access.json'), load('model.json')]).then(
    ([tracts, facilities, access, model]) => {
      const byId = new Map<string, TractProps>()
      const centroid = new Map<string, [number, number]>()
      for (const f of (tracts as BaseData['tracts']).features) {
        byId.set(f.properties.geoid, f.properties)
        centroid.set(f.properties.geoid, center(f.geometry))
      }
      return { tracts, facilities, access, model, byId, centroid }
    },
  )
  return cache
}

export function useBaseData(): BaseData | null {
  const [d, setD] = useState<BaseData | null>(null)
  useEffect(() => {
    loadBaseData().then(setD)
  }, [])
  return d
}
