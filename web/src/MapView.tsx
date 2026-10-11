import { useEffect, useLayoutEffect, useRef } from 'react'
import { MapContainer, Pane, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'
import type { TractProps, ServiceKey } from './metrics'
import { SERVICE_COLORS } from './metrics'
import type { FacilityProps } from './types'

// Esri light-gray canvas: keyless; base and labels are separate layers so labels sit above the choropleth.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'
const MILE = 1609.344

export type ProposedSite = { lat: number; lon: number; label: string; title: string; color: string; radiusMi: number }

type Props = {
  tracts: FeatureCollection<Geometry, TractProps>
  fill: (p: TractProps) => string | null
  tooltip: (p: TractProps) => string
  selected: string | null
  onSelect: (geoid: string) => void
  facilities: Feature<Point, FacilityProps>[]
  proposed: ProposedSite[]
  focus: { key: string; bounds: L.LatLngBoundsExpression }
}

// Tract choropleth drawn imperatively so restyling 2,600+ polygons doesn't rebuild the layer.
function Choropleth({ data, fill, tooltip, selected, onSelect }: Pick<Props, 'fill' | 'tooltip' | 'selected' | 'onSelect'> & { data: Props['tracts'] }) {
  const map = useMap()
  const layer = useRef<L.GeoJSON | null>(null)
  const style = (p: TractProps): L.PathOptions => {
    const c = fill(p)
    const isSel = p.geoid === selected
    return {
      fillColor: c ?? '#d9d8d3',
      fillOpacity: c ? 0.8 : 0.35,
      color: isSel ? '#111111' : '#ffffff',
      weight: isSel ? 2.5 : 0.5,
      dashArray: c ? undefined : '2 3',
    }
  }
  // Latest callbacks for Leaflet handlers bound once when the layer is created.
  const refs = useRef({ style, tooltip, onSelect })
  useLayoutEffect(() => {
    refs.current = { style, tooltip, onSelect }
  })

  useEffect(() => {
    const gj = L.geoJSON(data, {
      style: (f) => refs.current.style(f!.properties as TractProps),
      onEachFeature: (f, l) => {
        const p = f.properties as TractProps
        l.bindTooltip(() => refs.current.tooltip(p), { sticky: true, direction: 'top', offset: [0, -8], className: 'tt' })
        l.on({
          click: () => refs.current.onSelect(p.geoid),
          mouseover: (e) => (e.target as L.Path).setStyle({ weight: 2, color: '#111111' }),
          mouseout: (e) => gj.resetStyle(e.target as L.Path),
        })
      },
    }).addTo(map)
    layer.current = gj
    return () => {
      gj.remove()
    }
  }, [map, data])

  useEffect(() => {
    layer.current?.setStyle((f) => refs.current.style(f!.properties as TractProps))
  })
  return null
}

// Markers appear only when zoomed in enough to read them, so they never bury the heatmap.
const MIN_ZOOM: Record<ServiceKey, number> = { food: 11, health: 9, transit: 13, library: 10 }

function FacilityLayer({ facilities }: { facilities: Feature<Point, FacilityProps>[] }) {
  const map = useMap()
  useEffect(() => {
    const groups = new Map<ServiceKey, L.LayerGroup>()
    for (const f of facilities) {
      const p = f.properties
      const cat = p.category as ServiceKey
      const small = cat === 'transit'
      const color = SERVICE_COLORS[cat]
      // Drawn on the tracts' canvas (overlay pane): a separate canvas on top would swallow tract clicks.
      const m = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        radius: small ? 2.5 : 4.5,
        color: p.modeled ? color : '#ffffff',
        weight: p.modeled ? 1.5 : 1.2,
        fillColor: p.modeled ? '#ffffff' : color,
        fillOpacity: 1,
      })
      m.bindPopup(
        `<div class="pp-name">${p.name ?? 'Transit stop'}</div>` +
          (p.address ? `<div class="pp-row">${p.address}</div>` : '') +
          (p.detail ? `<div class="pp-row">${p.detail}</div>` : '') +
          (p.source ? `<div class="pp-src">${p.source}</div>` : ''),
      )
      if (!groups.has(cat)) groups.set(cat, L.layerGroup())
      groups.get(cat)!.addLayer(m)
    }
    const sync = () => {
      for (const [cat, g] of groups) {
        const show = map.getZoom() >= MIN_ZOOM[cat]
        if (show && !map.hasLayer(g)) g.addTo(map)
        if (!show && map.hasLayer(g)) g.remove()
      }
    }
    sync()
    map.on('zoomend', sync)
    return () => {
      map.off('zoomend', sync)
      for (const g of groups.values()) g.remove()
    }
  }, [map, facilities])
  return null
}

function ProposedLayer({ proposed }: { proposed: ProposedSite[] }) {
  const map = useMap()
  useEffect(() => {
    const items: L.Layer[] = []
    for (const s of proposed) {
      if (s.radiusMi > 0)
        items.push(
        L.circle([s.lat, s.lon], {
          pane: 'reach',
          radius: s.radiusMi * MILE,
          color: s.color,
          weight: 2,
          dashArray: '6 5',
          fillColor: s.color,
          fillOpacity: 0.08,
          interactive: false,
        }),
      )
      items.push(
        L.marker([s.lat, s.lon], {
          pane: 'proposed',
          icon: L.divIcon({ className: 'site-pin', html: `<span style="background:${s.color}">${s.label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        }).bindTooltip(s.title, { direction: 'top', offset: [0, -14] }),
      )
    }
    const group = L.layerGroup(items).addTo(map)
    return () => {
      group.remove()
    }
  }, [map, proposed])
  return null
}

function Focus({ focus }: { focus: Props['focus'] }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(focus.bounds, { padding: [40, 40], maxZoom: 12 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focus.key])
  return null
}

export default function MapView(props: Props) {
  return (
    <MapContainer className="map" center={[35.95, -78.9]} zoom={10} zoomControl={true} preferCanvas={true} minZoom={6}>
      <TileLayer url={`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`} attribution={ATTRIBUTION} maxZoom={16} />
      <Choropleth data={props.tracts} fill={props.fill} tooltip={props.tooltip} selected={props.selected} onSelect={props.onSelect} />
      <Pane name="labels" style={{ zIndex: 450, pointerEvents: 'none' }}>
        <TileLayer url={`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`} maxZoom={16} />
      </Pane>
      <Pane name="reach" style={{ zIndex: 500, pointerEvents: 'none' }} />
      <Pane name="proposed" style={{ zIndex: 640 }} />
      <ProposedLayer proposed={props.proposed} />
      <FacilityLayer facilities={props.facilities} />
      <Focus focus={props.focus} />
    </MapContainer>
  )
}
