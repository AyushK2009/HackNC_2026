import { useEffect, useMemo, useState } from 'react'
import type { FeatureCollection, Geometry, Point } from 'geojson'
import MapView, { type PantryProps } from './MapView'
import TractPanel from './TractPanel'
import { METRICS, NO_DATA, type TractProps } from './metrics'
import { buildScale } from './scale'
import { fmtInt } from './format'
import './App.css'

type Model = { features: string[]; explained_variance_ratio: number[]; n_reference: number }
type Data = {
  tracts: FeatureCollection<Geometry, TractProps>
  pantries: FeatureCollection<Point, PantryProps>
  model: Model
}

const base = import.meta.env.BASE_URL
const load = (f: string) => fetch(`${base}data/${f}`).then((r) => r.json())

export default function App() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [metricKey, setMetricKey] = useState(METRICS[0].key)
  const [selected, setSelected] = useState<string | null>(null)
  const [showPantries, setShowPantries] = useState(true)

  useEffect(() => {
    Promise.all([load('tracts.geojson'), load('pantries.geojson'), load('model.json')])
      .then(([tracts, pantries, model]) => setData({ tracts, pantries, model }))
      .catch((e) => setError(String(e)))
  }, [])

  const metric = METRICS.find((m) => m.key === metricKey)!
  const props = useMemo(() => data?.tracts.features.map((f) => f.properties) ?? [], [data])
  const scale = useMemo(() => buildScale(metric, props), [metric, props])
  const tract = props.find((p) => p.geoid === selected) ?? null

  const summary = useMemo(() => {
    const scored = props.filter((p) => p.scored && p.hardship_pct != null)
    const high = scored.filter((p) => p.hardship_pct! >= 80)
    return { n: props.length, high: high.length, highPop: high.reduce((s, p) => s + p.pop, 0) }
  }, [props])

  if (error) return <div className="splash">Could not load data: {error}</div>
  if (!data) return <div className="splash">Loading AccessAtlas…</div>

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>AccessAtlas</h1>
          <p className="muted">Mapping community needs. Connecting people to resources.</p>
          <p className="region">Durham &amp; Orange Counties, NC</p>
        </header>

        <section className="panel">
          <h3>Map layer</h3>
          <div className="layer-list" role="radiogroup">
            {METRICS.map((m) => (
              <button
                key={m.key}
                role="radio"
                aria-checked={m.key === metricKey}
                className={`layer-btn ${m.key === metricKey ? 'active' : ''}`}
                onClick={() => setMetricKey(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="desc">{metric.description}</p>
          <p className="source">Source: {metric.source}</p>
        </section>

        <section className="panel">
          <h3>Legend</h3>
          <div className="legend-ramp">
            {scale.bins.map((b) => (
              <div key={b.label} className="legend-cell">
                <span className="swatch" style={{ background: b.color }} />
                <span className="legend-label">{b.label}</span>
              </div>
            ))}
          </div>
          <div className="legend-extra">
            <span className="legend-item">
              <span className="swatch hatched" style={{ background: NO_DATA }} /> Not scored (dorms / institutions)
            </span>
            <label className="legend-item toggle">
              <input type="checkbox" checked={showPantries} onChange={(e) => setShowPantries(e.target.checked)} />
              <span className="dot" /> Food pantries ({data.pantries.features.length}, Durham Co. only)
            </label>
          </div>
        </section>

        {tract ? (
          <TractPanel tract={tract} model={data.model} onClose={() => setSelected(null)} />
        ) : (
          <section className="panel">
            <h3>Overview</h3>
            <p className="stat">
              <b>{summary.high}</b> of {summary.n} tracts rank in North Carolina's top 20% for economic hardship, home to{' '}
              <b>{fmtInt(summary.highPop)}</b> residents.
            </p>
            <p className="muted">Click any neighborhood on the map for its measurements and what drives its score.</p>
          </section>
        )}
      </aside>

      <main className="map-wrap">
        <MapView
          tracts={data.tracts}
          pantries={data.pantries}
          metric={metric}
          scale={scale}
          selected={selected}
          onSelect={setSelected}
          showPantries={showPantries}
        />
      </main>
    </div>
  )
}
