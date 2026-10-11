import { useEffect, useMemo } from 'react'
import { CircleMarker, GeoJSON, MapContainer, Pane, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'
import type { Metric, TractProps } from './metrics'
import type { ColorScale } from './scale'
import { tractName } from './format'

export type PantryProps = { name: string; address: string | null; days: string | null; hours: string | null }

type Props = {
  tracts: FeatureCollection<Geometry, TractProps>
  pantries: FeatureCollection<Point, PantryProps>
  metric: Metric
  scale: ColorScale
  selected: string | null
  onSelect: (geoid: string | null) => void
  showPantries: boolean
}

// Esri light-gray canvas: keyless; base and labels are separate layers so labels sit above the choropleth.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'

function FitBounds({ data }: { data: FeatureCollection }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(L.geoJSON(data).getBounds(), { padding: [16, 16] })
  }, [map, data])
  return null
}

export default function MapView({ tracts, pantries, metric, scale, selected, onSelect, showPantries }: Props) {
  const baseStyle = useMemo(
    () => (f?: Feature<Geometry, TractProps>): L.PathOptions => {
      const p = f!.properties
      const isSel = p.geoid === selected
      return {
        fillColor: p.scored ? scale.color(p[metric.key] as number | null) : undefined,
        fillOpacity: p.scored ? 0.82 : 0.35,
        fill: true,
        color: isSel ? '#0b0b0b' : '#ffffff',
        weight: isSel ? 2.5 : 0.8,
        dashArray: p.scored ? undefined : '3 3',
        ...(p.scored ? {} : { fillColor: '#e4e3df', color: '#8a8984' }),
      }
    },
    [metric, scale, selected],
  )

  return (
    <MapContainer className="map" center={[35.99, -79.0]} zoom={10} zoomControl={false} preferCanvas={false}>
      <TileLayer url={`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`} attribution={ATTRIBUTION} maxZoom={16} />
      <GeoJSON
        key={`${metric.key}-${selected}`}
        data={tracts}
        style={baseStyle}
        onEachFeature={(f: Feature<Geometry, TractProps>, layer) => {
          const p = f.properties
          const v = p[metric.key] as number | null
          const value = !p.scored ? 'Not scored' : v == null ? 'No data' : metric.format(v)
          layer.bindTooltip(
            `<div class="tt-title">${tractName(p.geoid)} · ${p.county.replace(' County', '')}</div>` +
              `<div class="tt-row"><span>${metric.short}</span><b>${value}</b></div>`,
            { sticky: true, direction: 'top', offset: [0, -8], className: 'tt' },
          )
          layer.on({
            click: () => onSelect(p.geoid),
            mouseover: (e) => (e.target as L.Path).setStyle({ weight: 2.5, color: '#0b0b0b' }),
            mouseout: (e) => (e.target as L.Path).setStyle(baseStyle(f)),
          })
        }}
      />
      <Pane name="labels" style={{ zIndex: 450, pointerEvents: 'none' }}>
        <TileLayer url={`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`} maxZoom={16} />
      </Pane>
      {showPantries && (
        <Pane name="pantries" style={{ zIndex: 620 }}>
          {pantries.features.map((f, i) => (
            <CircleMarker
              key={i}
              center={[f.geometry.coordinates[1], f.geometry.coordinates[0]]}
              radius={5}
              pathOptions={{ color: '#ffffff', weight: 1.5, fillColor: '#eb6834', fillOpacity: 1 }}
            >
              <Popup>
                <div className="pp-name">{f.properties.name}</div>
                {f.properties.address && <div className="pp-row">{f.properties.address}</div>}
                {f.properties.days && <div className="pp-row">{f.properties.days}</div>}
                {f.properties.hours && <div className="pp-row">{f.properties.hours}</div>}
              </Popup>
            </CircleMarker>
          ))}
        </Pane>
      )}
      <FitBounds data={tracts} />
    </MapContainer>
  )
}
