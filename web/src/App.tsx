import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import MapView, { type ProposedSite } from './MapView'
import TractPanel from './TractPanel'
import { HARDSHIP_METRICS, NO_DATA, SERVICE_COLORS, SERVICE_NOUN, SERVICE_SHORT, STATUS_LABEL, type ServiceKey, type TractProps } from './metrics'
import { accessScale, hardshipScale } from './scale'
import { fmtInt, ordinal, tractName } from './format'
import { applyPlan, type AccessView } from './access'
import type { AppData, PlanStep } from './types'
import './App.css'

type Mode = 'hardship' | 'access'
type AccessLayer = ServiceKey | 'pct'

const base = import.meta.env.BASE_URL
const load = (f: string) =>
  fetch(`${base}data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`)
    return r.json()
  })
const TRIANGLE: L.LatLngBoundsExpression = [[35.62, -79.25], [36.2, -78.45]]
const SERVICES: ServiceKey[] = ['food', 'health', 'transit', 'library']
const IDX: Record<ServiceKey, number> = { food: 0, health: 1, transit: 2, library: 3 }

type Result = { scopeName: string; steps: PlanStep[] }

export default function App() {
  const [data, setData] = useState<AppData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('hardship')
  const [metricKey, setMetricKey] = useState(HARDSHIP_METRICS[0].key)
  const [layer, setLayer] = useState<AccessLayer>('pct')
  const [selected, setSelected] = useState<string | null>(null)
  // Planner inputs, applied only when the user clicks "Find best improvements".
  const [scope, setScope] = useState('nc')
  const [cats, setCats] = useState<ServiceKey[]>(SERVICES)
  const [nSites, setNSites] = useState(3)
  const [result, setResult] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)
  const [showAfter, setShowAfter] = useState(true)
  const [focusKey, setFocusKey] = useState('hardship')
  const [focusBounds, setFocusBounds] = useState<L.LatLngBoundsExpression>(TRIANGLE)

  useEffect(() => {
    Promise.all([load('tracts.geojson'), load('facilities.geojson'), load('access.json'), load('model.json')])
      .then(([tracts, facilities, access, model]) => setData({ tracts, facilities, access, model }))
      .catch((e) => setError(String(e)))
  }, [])

  const props = useMemo(() => data?.tracts.features.map((f) => f.properties) ?? [], [data])
  const byId = useMemo(() => new Map(props.map((p) => [p.geoid, p])), [props])
  const metric = HARDSHIP_METRICS.find((m) => m.key === metricKey)!
  const hScale = useMemo(() => hardshipScale(metric, props), [metric, props])
  const hIndexScale = useMemo(() => hardshipScale(HARDSHIP_METRICS[0], props), [props])
  const pctScale = useMemo(() => accessScale('percentile'), [])
  const covScale = useMemo(() => accessScale('score'), [])

  // Access before and after the recommended sites (both ranked against the same baseline distribution).
  const before: AccessView | null = useMemo(() => (data ? applyPlan(data.access, []) : null), [data])
  const after: AccessView | null = useMemo(() => (data && result ? applyPlan(data.access, result.steps) : null), [data, result])
  const view = showAfter && after ? after : before

  const facilities = useMemo(
    () => (data && mode === 'access' ? data.facilities.features.filter((f) => layer === 'pct' || f.properties.category === layer) : []),
    [data, mode, layer],
  )
  const proposed: ProposedSite[] = useMemo(
    () =>
      mode === 'access' && result && data
        ? result.steps.map((s, i) => ({
            lat: s.lat,
            lon: s.lon,
            label: String(i + 1),
            title: `#${i + 1} Proposed ${SERVICE_NOUN[s.cat]} (planning scenario)`,
            color: SERVICE_COLORS[s.cat],
            radiusMi: 0,
          }))
        : [],
    [mode, result, data],
  )

  if (error) return <div className="splash">Could not load data: {error}. Run the scripts in README → Run locally.</div>
  if (!data || !before || !view) return <div className="splash">Loading AccessAtlas…</div>

  const { access } = data
  const accessValue = (geoid: string, v: AccessView): number | null => {
    const r = v.rows[geoid]
    if (!r) return null
    return layer === 'pct' ? r.pct : r.cov[IDX[layer]]
  }
  const fill = (p: TractProps): string | null => {
    if (mode === 'hardship') {
      if (p.status !== 'ok') return null
      const v = p[metric.key] as number | null
      return v == null ? NO_DATA : hScale.color(v)
    }
    const v = accessValue(p.geoid, view)
    return v == null ? null : (layer === 'pct' ? pctScale : covScale).color(v)
  }
  const tooltip = (p: TractProps) => {
    const head = `<div class="tt-title">${tractName(p.geoid)} · ${p.county.replace(' County', '')}</div>`
    if (mode === 'hardship') {
      const v = p[metric.key] as number | null
      const val = p.status !== 'ok' ? STATUS_LABEL[p.status] : v == null ? 'No data' : metric.format(v)
      return head + `<div class="tt-row"><span>${metric.short}</span><b>${val}</b></div>`
    }
    const b = accessValue(p.geoid, before)
    const a = accessValue(p.geoid, view)
    if (b == null) return head + `<div class="tt-row"><span>No residents</span></div>`
    const fmt = (v: number) => `${Math.round(v)}`
    const label = layer === 'pct' ? 'Access percentile' : 'Access score'
    return head + `<div class="tt-row"><span>${label}</span><b>${fmt(b)}${a != null && a > b + 0.5 ? ` → ${fmt(a)}` : ''}</b></div>`
  }

  const switchMode = (m: Mode) => {
    setMode(m)
    setSelected(null)
    setFocusKey(`${m}-${Date.now()}`)
    setFocusBounds(TRIANGLE)
  }

  const findBest = async () => {
    setRunning(true)
    try {
      const plans: Record<string, PlanStep[]> = await load(`plans/${scope}.json`)
      const key = SERVICES.filter((c) => cats.includes(c)).join('+')
      const steps = (plans[key] ?? []).slice(0, nSites)
      const scopeName = scope === 'nc' ? 'North Carolina' : access.counties.find((c) => c.fips === scope)?.name ?? scope
      setResult({ scopeName, steps })
      setShowAfter(true)
      setLayer('pct')
      setSelected(null)
      if (steps.length) {
        setFocusBounds(L.latLngBounds(steps.map((s) => [s.lat, s.lon] as [number, number])).pad(0.5))
        setFocusKey(`result-${Date.now()}`)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  // Neighborhoods that benefit from the current result, by residents newly within reach.
  const benefit = result && after
    ? Object.keys(after.gain)
        .map((g) => ({ g, gained: after.gain[g], b: before.rows[g]!.pct, a: after.rows[g]!.pct, h: byId.get(g)?.hardship_pct ?? null }))
        .sort((x, y) => y.gained - x.gained)
    : []
  const totalCloser = result ? result.steps.reduce((s, st) => s + st.residents_closer, 0) : 0

  const scored = props.filter((p) => p.status === 'ok')
  const top10 = scored.filter((p) => (p.hardship_pct ?? 0) >= 90)
  const tract = selected ? byId.get(selected) ?? null : null
  const activeScale = layer === 'pct' ? pctScale : covScale

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>AccessAtlas</h1>
          <p className="muted">Where North Carolina needs services most — and what to build.</p>
        </header>

        <div className="mode-switch" role="tablist">
          <button role="tab" aria-selected={mode === 'hardship'} className={mode === 'hardship' ? 'on' : ''} onClick={() => switchMode('hardship')}>
            Economic Hardship
          </button>
          <button role="tab" aria-selected={mode === 'access'} className={mode === 'access' ? 'on' : ''} onClick={() => switchMode('access')}>
            Service Access
          </button>
        </div>

        {mode === 'hardship' ? (
          <>
            <section className="panel">
              <div className="layer-list" role="radiogroup">
                {HARDSHIP_METRICS.map((m) => (
                  <button key={m.key} role="radio" aria-checked={m.key === metricKey} className={`layer-btn ${m.key === metricKey ? 'active' : ''}`} onClick={() => setMetricKey(m.key)}>
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="desc">{metric.description}</p>
              <p className="source">Source: {metric.source}</p>
            </section>
            <section className="panel">
              <Legend bins={hScale.bins} caption={metric.key === 'hardship_pct' ? 'Hardship percentile (higher = more hardship)' : metric.label} />
              <div className="legend-extra">
                <span className="legend-item"><span className="swatch hatched" /> No score (no residents or missing data)</span>
              </div>
            </section>
            {!tract && (
              <section className="panel">
                <p className="stat">
                  <b>{fmtInt(top10.reduce((s, p) => s + p.pop, 0))}</b> North Carolinians live in the {fmtInt(top10.length)} neighborhoods in the state's top 10% for economic hardship.
                </p>
                <p className="muted">Click any neighborhood for its measurements.</p>
              </section>
            )}
          </>
        ) : (
          <>
            <section className="panel">
              <div className="layer-list" role="radiogroup">
                <button role="radio" aria-checked={layer === 'pct'} className={`layer-btn ${layer === 'pct' ? 'active' : ''}`} onClick={() => setLayer('pct')}>
                  <span>Service Accessibility Percentile</span>
                </button>
                {SERVICES.map((k) => {
                  const s = access.services[k]
                  return (
                    <button key={k} role="radio" aria-checked={layer === k} className={`layer-btn ${layer === k ? 'active' : ''}`} onClick={() => setLayer(k)}>
                      <span><span className="dot" style={{ background: SERVICE_COLORS[k] }} /> {s.label}</span>
                      <span className="layer-meta">typical {s.D_miles} mi</span>
                    </button>
                  )
                })}
              </div>
              <p className="desc">
                {layer === 'pct'
                  ? 'Average of four distance-based access scores (food assistance, health care, transit, libraries), ranked against all NC neighborhoods. 10 = better access than only 10% of NC.'
                  : `Score 0–100 from residents' distance to the nearest ${SERVICE_NOUN[layer]}, compared with what's typical in their county and statewide (typical NC distance: ${access.services[layer].D_miles} mi).`}
              </p>
              {(layer === 'pct' || layer === 'food') && (
                <p className="source">Food sites come from county inventories in Durham, Orange, Wake and New Hanover; elsewhere they are modeled (hollow markers).</p>
              )}
            </section>
            <section className="panel">
              <Legend bins={activeScale.bins} caption={layer === 'pct' ? 'Access percentile (lower = worse access)' : 'Access score (lower = worse access)'} />
            </section>

            <section className="panel planner">
              <h3>Find the best improvements</h3>
              <label className="field">
                <span>Area</span>
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="nc">All of North Carolina</option>
                  {access.counties.map((c) => (
                    <option key={c.fips} value={c.fips}>{c.name}</option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>Services to consider</span>
                <div className="chips">
                  {SERVICES.map((k) => {
                    const on = cats.includes(k)
                    return (
                      <button
                        key={k}
                        className={`chip-btn ${on ? 'on' : ''}`}
                        style={on ? { borderColor: SERVICE_COLORS[k], color: SERVICE_COLORS[k] } : undefined}
                        onClick={() => setCats(on ? (cats.length > 1 ? cats.filter((c) => c !== k) : cats) : [...cats, k])}
                        aria-pressed={on}
                      >
                        {SERVICE_SHORT[k]}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="field">
                <span>New sites</span>
                <div className="chips">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} className={`chip-btn num ${nSites === n ? 'on' : ''}`} onClick={() => setNSites(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <button className="primary" onClick={findBest} disabled={running}>
                {running ? 'Finding…' : 'Find best improvements'}
              </button>
              <p className="footnote">Compares every service type and location by how much it improves modeled access, weighted by neighborhood hardship.</p>

              {result && (
                <div className="results">
                  <div className="before-after">
                    <button className={!showAfter ? 'on' : ''} onClick={() => setShowAfter(false)}>Before</button>
                    <button className={showAfter ? 'on' : ''} onClick={() => setShowAfter(true)}>After</button>
                  </div>
                  {result.steps.length === 0 ? (
                    <p className="muted">No location in this area adds access for the selected services.</p>
                  ) : (
                    <>
                      <div className="result">
                        <div className="result-num">{fmtInt(totalCloser)}</div>
                        <div className="muted">residents brought closer to a service ({result.scopeName})</div>
                      </div>
                      <ol className="sites">
                        {result.steps.map((s, i) => (
                          <li key={i} onClick={() => setSelected(s.geoid)}>
                            <span className="site-num" style={{ background: SERVICE_COLORS[s.cat] }}>{i + 1}</span>
                            <div>
                              <b>{capital(SERVICE_NOUN[s.cat])}</b>
                              <div className="muted">{byId.get(s.geoid)?.county} · {tractName(s.geoid)}</div>
                            </div>
                            <span className="site-gain">{fmtInt(s.residents_closer)}<small>{s.avg_miles_closer} mi closer</small></span>
                          </li>
                        ))}
                      </ol>
                      <h3>Neighborhoods that benefit most</h3>
                      <ul className="served">
                        {benefit.slice(0, 6).map((b) => (
                          <li key={b.g} onClick={() => setSelected(b.g)}>
                            <span className="chip" style={{ background: b.h != null ? hIndexScale.color(b.h) : NO_DATA }} title="Hardship percentile">
                              {b.h != null ? Math.round(b.h) : '–'}
                            </span>
                            <span>{tractName(b.g)}, {byId.get(b.g)?.county.replace(' County', '')}</span>
                            <span className="pct-change">{ordinal(b.b)} → <b>{ordinal(b.a)}</b></span>
                          </li>
                        ))}
                      </ul>
                      <p className="footnote">Chip = hardship percentile. Right = access percentile, before → after. Proposed sites are planning scenarios, not vetted parcels.</p>
                    </>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {tract && (
          <TractPanel
            tract={tract}
            model={data.model}
            mode={mode}
            hardshipColor={hIndexScale.color}
            pctColor={pctScale.color}
            access={access}
            before={before.rows[tract.geoid] ?? null}
            after={after?.rows[tract.geoid] ?? null}
            onClose={() => setSelected(null)}
          />
        )}
      </aside>

      <main className="map-wrap">
        <MapView
          tracts={data.tracts}
          fill={fill}
          tooltip={tooltip}
          selected={selected}
          onSelect={setSelected}
          facilities={facilities}
          proposed={proposed}
          focus={{ key: focusKey, bounds: focusBounds }}
        />
        {mode === 'access' && (
          <div className="map-legend">
            {SERVICES.filter((k) => layer === 'pct' || layer === k).map((k) => (
              <span key={k}><span className="dot" style={{ background: SERVICE_COLORS[k] }} /> {SERVICE_SHORT[k]}</span>
            ))}
            {(layer === 'pct' || layer === 'food') && <span><span className="dot hollow" /> Modeled food site</span>}
            {result && <span><span className="pin-mini" /> Proposed site</span>}
            <span className="muted">Zoom in to see sites</span>
          </div>
        )}
      </main>
    </div>
  )
}

const capital = (s: string) => s[0].toUpperCase() + s.slice(1)

function Legend({ bins, caption }: { bins: { color: string; label: string }[]; caption?: string }) {
  return (
    <>
      {caption && <h3>{caption}</h3>}
      <div className="legend-ramp" style={{ gridTemplateColumns: `repeat(${bins.length}, 1fr)` }}>
        {bins.map((b) => (
          <div key={b.label} className="legend-cell">
            <span className="swatch" style={{ background: b.color }} />
            <span className="legend-label">{b.label}</span>
          </div>
        ))}
      </div>
    </>
  )
}
