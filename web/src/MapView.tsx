import { useEffect, useLayoutEffect, useRef } from 'react'
import { MapContainer, Pane, TileLayer, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'
import type { TractProps, ServiceKey } from './metrics'
import { SERVICE_COLORS } from './metrics'
import type { FacilityProps } from './types'

// Esri light-gray canvas: keyless; base and labels are separate layers so labels sit above the choropleth.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'
const MILE = 1609.344
export const NC_BOUNDS: L.LatLngBoundsExpression = [[33.84, -84.32], [36.59, -75.46]]

// Generic clickable markers (reports, opportunities, projects…). `html` overrides the default dot.
export type MapMarker = {
  id: string
  lat: number
  lon: number
  color: string
  size?: number
  label?: string
  tooltip?: string
  html?: string
  ringMi?: number
  onClick?: () => void
}

function MarkerLayer({ markers }: { markers: MapMarker[] }) {
  const map = useMap()
  useEffect(() => {
    const items: L.Layer[] = []
    for (const m of markers) {
      if (m.ringMi)
        items.push(L.circle([m.lat, m.lon], { pane: 'reach', radius: m.ringMi * MILE, color: m.color, weight: 1.5, dashArray: '5 5', fillColor: m.color, fillOpacity: 0.07, interactive: false }))
      const size = m.size ?? 14
      const html = m.html ?? `<div class="mk" style="width:${size}px;height:${size}px;background:${m.color}">${m.label ?? ''}</div>`
      const mk = L.marker([m.lat, m.lon], { pane: 'markers', icon: L.divIcon({ className: 'mk-wrap', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) })
      if (m.tooltip) mk.bindTooltip(m.tooltip, { direction: 'top', offset: [0, -size / 2], className: 'tt' })
      if (m.onClick) mk.on('click', m.onClick)
      items.push(mk)
    }
    const group = L.layerGroup(items).addTo(map)
    return () => {
      group.remove()
    }
  }, [map, markers])
  return null
}

export type ProposedSite = { lat: number; lon: number; label: string; title: string; color: string; radiusMi: number; cat?: ServiceKey; active?: boolean }

type Props = {
  tracts: FeatureCollection<Geometry, TractProps>
  fill: (p: TractProps) => string | null
  tooltip: (p: TractProps) => string
  selected: string | null
  onSelect: (geoid: string) => void
  facilities?: Feature<Point, FacilityProps>[]
  proposed?: ProposedSite[]
  onSiteClick?: (i: number) => void
  markers?: MapMarker[]
  focus: { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number]; paddingBR?: [number, number] }
  // Optional: areas outside the current focus are drawn faintly.
  fade?: (p: TractProps) => boolean
  // Optional: told the zoom level after every zoom (and once on load).
  onZoom?: (zoom: number) => void
}

// Tract choropleth drawn imperatively so restyling 2,600+ polygons doesn't rebuild the layer.
function Choropleth({ data, fill, tooltip, selected, onSelect, fade }: Pick<Props, 'fill' | 'tooltip' | 'selected' | 'onSelect' | 'fade'> & { data: Props['tracts'] }) {
  const map = useMap()
  const layer = useRef<L.GeoJSON | null>(null)
  const style = (p: TractProps): L.PathOptions => {
    const c = fill(p)
    const isSel = p.geoid === selected
    const faded = !isSel && !!fade?.(p)
    return {
      fillColor: c ?? '#d9d8d3',
      fillOpacity: faded ? (c ? 0.14 : 0.08) : c ? 0.8 : 0.35,
      color: isSel ? '#111111' : '#ffffff',
      weight: isSel ? 2.5 : faded ? 0.25 : 0.5,
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

// Small service glyphs for the proposed-site pins (same shapes as icons.tsx).
const PIN_ICON: Record<ServiceKey, string> = {
  food: '<path d="M12 7c-3.5-2.5-8 0-7 5s4 8 7 7c3 1 6-2 7-7s-3.5-7.5-7-5z"/><path d="M12 7c0-2 1-3.2 2.5-4"/>',
  health: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  transit: '<rect x="4.5" y="3.5" width="15" height="14" rx="2.5"/><path d="M4.5 10.5h15M8 20v-2.5M16 20v-2.5"/>',
  library: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5v-15z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5v-15z"/>',
}

function ProposedLayer({ proposed, onSiteClick }: { proposed: ProposedSite[]; onSiteClick?: (i: number) => void }) {
  const map = useMap()
  const click = useRef(onSiteClick)
  useLayoutEffect(() => {
    click.current = onSiteClick
  })
  useEffect(() => {
    const items: L.Layer[] = []
    proposed.forEach((s, i) => {
      if (s.radiusMi > 0)
        items.push(
          L.circle([s.lat, s.lon], { pane: 'reach', radius: s.radiusMi * MILE, color: s.color, weight: 2, dashArray: '6 5', fillColor: s.color, fillOpacity: 0.08, interactive: false }),
        )
      const glyph = s.cat
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PIN_ICON[s.cat]}</svg>`
        : ''
      const size = s.active ? 54 : 44
      items.push(
        L.marker([s.lat, s.lon], {
          pane: 'proposed',
          icon: L.divIcon({
            className: `site-pin2 ${s.active ? 'active' : ''}`,
            html: `<div class="sp" style="background:${s.color}">${glyph}<b>${s.label}</b></div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
        })
          .bindTooltip(s.title, { direction: 'top', offset: [0, -size / 2] })
          .on('click', () => click.current?.(i)),
      )
    })
    const group = L.layerGroup(items).addTo(map)
    return () => {
      group.remove()
    }
  }, [map, proposed])
  return null
}

// Covers everything outside North Carolina so only the state being analyzed is visible.
function NCMask() {
  const map = useMap()
  useEffect(() => {
    let layer: L.Polygon | null = null
    fetch(`${import.meta.env.BASE_URL}data/nc_outline.geojson`)
      .then((r) => r.json())
      .then((fc) => {
        const g = fc.features[0].geometry
        const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
        const holes = polys.map((poly) => poly[0].map(([x, y]) => [y, x] as [number, number]))
        const world: [number, number][] = [[-89, -179], [-89, 179], [89, 179], [89, -179]]
        layer = L.polygon([world, ...holes], { pane: 'mask', stroke: false, fillColor: '#f4f2ee', fillOpacity: 1, interactive: false }).addTo(map)
        L.polygon(holes, { pane: 'mask', color: '#8a857a', weight: 1.2, fill: false, interactive: false }).addTo(map)
      })
    return () => {
      layer?.remove()
    }
  }, [map])
  return null
}

function Focus({ focus }: { focus: Props['focus'] }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(focus.bounds, { paddingTopLeft: focus.padding ?? [40, 40], paddingBottomRight: focus.paddingBR ?? [30, 30], maxZoom: 12 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focus.key])
  return null
}

function ZoomWatch({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMap()
  const cb = useRef(onZoom)
  useLayoutEffect(() => {
    cb.current = onZoom
  })
  useEffect(() => {
    const on = () => cb.current(map.getZoom())
    on()
    map.on('zoomend', on)
    return () => {
      map.off('zoomend', on)
    }
  }, [map])
  return null
}

const EMPTY_P: ProposedSite[] = []
const EMPTY_F: Feature<Point, FacilityProps>[] = []
const EMPTY_M: MapMarker[] = []

export default function MapView(props: Props) {
  return (
    <MapContainer
      className="map"
      bounds={NC_BOUNDS}
      boundsOptions={{ padding: [20, 20] }}
      maxBounds={[[32.5, -86.5], [37.8, -73.5]]}
      zoomControl={false}
      preferCanvas={true}
      minZoom={6}
      zoomSnap={0.25}
    >
      <TileLayer url={`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`} attribution={ATTRIBUTION} maxZoom={16} />
      <Choropleth data={props.tracts} fill={props.fill} tooltip={props.tooltip} selected={props.selected} onSelect={props.onSelect} fade={props.fade} />
      <Pane name="labels" style={{ zIndex: 450, pointerEvents: 'none' }}>
        <TileLayer url={`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`} maxZoom={16} />
      </Pane>
      <ZoomControl position="bottomright" />
      <Pane name="mask" style={{ zIndex: 460, pointerEvents: 'none' }} />
      <NCMask />
      <Pane name="reach" style={{ zIndex: 500, pointerEvents: 'none' }} />
      <Pane name="markers" style={{ zIndex: 630 }} />
      <Pane name="proposed" style={{ zIndex: 640 }} />
      <ProposedLayer proposed={props.proposed ?? EMPTY_P} onSiteClick={props.onSiteClick} />
      <FacilityLayer facilities={props.facilities ?? EMPTY_F} />
      <MarkerLayer markers={props.markers ?? EMPTY_M} />
      <Focus focus={props.focus} />
      {props.onZoom && <ZoomWatch onZoom={props.onZoom} />}
    </MapContainer>
  )
}
