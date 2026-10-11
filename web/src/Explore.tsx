import { useEffect, useMemo, useState, type ReactNode } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type ProposedSite } from './MapView'
import TractPanel from './TractPanel'
import { HARDSHIP_METRICS, NO_DATA, SERVICE_COLORS, SERVICE_NOUN, STATUS_LABEL, type ServiceKey, type TractProps } from './metrics'
import { accessScale, hardshipScale, type ColorScale } from './scale'
import { fmtInt } from './format'
import { applyPlan, type AccessView } from './access'
import { Logo } from './Landing'
import { IconAccess, IconBook, IconBus, IconCar, IconFilter, IconFood, IconFoodAid, IconHealth, IconIncome, IconIndex, IconPoverty, IconSpark } from './icons'
import type { AppData, PlanStep } from './types'
import './App.css'
import './Explore.css'

type Chapter = 1 | 2 | 3
type HLayer = 'hardship_pct' | 'poverty_rate' | 'median_income' | 'snap_share' | 'no_vehicle_share'
type ALayer = ServiceKey | 'pct'

const load = (f: string) =>
  fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`)
    return r.json()
  })
const SERVICES: ServiceKey[] = ['food', 'health', 'transit', 'library']
const IDX: Record<ServiceKey, number> = { food: 0, health: 1, transit: 2, library: 3 }

const INGREDIENTS: { key: HLayer; label: string; icon: ReactNode; text: string }[] = [
  { key: 'poverty_rate', label: 'Poverty', icon: <IconPoverty />, text: 'Share of residents living below the federal poverty line.' },
  { key: 'median_income', label: 'Income', icon: <IconIncome />, text: 'Typical family income. Lower income counts as more hardship.' },
  { key: 'snap_share', label: 'Food aid', icon: <IconFoodAid />, text: 'Share of households that rely on SNAP (food stamps) to buy groceries.' },
  { key: 'no_vehicle_share', label: 'No car', icon: <IconCar />, text: 'Share of households without a car — every trip depends on walking, rides or transit.' },
]
const SERVICE_INFO: Record<ServiceKey, { label: string; icon: ReactNode; text: string }> = {
  food: { label: 'Food', icon: <IconFood />, text: 'Food pantries and free meal sites.' },
  health: { label: 'Health', icon: <IconHealth />, text: 'Community health centers that see patients regardless of ability to pay.' },
  transit: { label: 'Transit', icon: <IconBus />, text: 'Bus and transit stops.' },
  library: { label: 'Library', icon: <IconBook />, text: 'Public library branches — internet, job help, programs for kids.' },
}
const CHAPTERS: { n: Chapter; title: string }[] = [
  { n: 1, title: "Who's struggling" },
  { n: 2, title: 'How far is help' },
  { n: 3, title: 'What to build' },
]

type Result = { scopeName: string; steps: PlanStep[] }
type StoryStats = { top_quarter_people: number; top_quarter_snap_one_in: number; top_quarter_no_car_one_in: number; health_miles_median: number }

export default function Explore({ onHome }: { onHome: () => void }) {
  const [data, setData] = useState<AppData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chapter, setChapter] = useState<Chapter>(1)
  const [hLayer, setHLayer] = useState<HLayer>('hardship_pct')
  const [aLayer, setALayer] = useState<ALayer>('pct')
  const [openH, setOpenH] = useState(false)
  const [openA, setOpenA] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [scope, setScope] = useState('063')
  const [cats, setCats] = useState<ServiceKey[]>(SERVICES)
  const [nSites, setNSites] = useState(3)
  const [result, setResult] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)
  const [showAfter, setShowAfter] = useState(true)
  const [siteSel, setSiteSel] = useState<number | null>(null)
  const [editing, setEditing] = useState(true)
  const [focus, setFocus] = useState<{ key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }>({
    key: 'nc',
    bounds: NC_BOUNDS,
    padding: [430, 20],
  })

  const [story, setStory] = useState<StoryStats | null>(null)
  useEffect(() => {
    load('story.json').then((s) => setStory(s.stats)).catch(() => setStory(null))
    Promise.all([load('tracts.geojson'), load('facilities.geojson'), load('access.json'), load('model.json')])
      .then(([tracts, facilities, access, model]) => setData({ tracts, facilities, access, model }))
      .catch((e) => setError(String(e)))
  }, [])

  const props = useMemo(() => data?.tracts.features.map((f) => f.properties) ?? [], [data])
  const byId = useMemo(() => new Map(props.map((p) => [p.geoid, p])), [props])
  const metric = HARDSHIP_METRICS.find((m) => m.key === hLayer)!
  const hScale = useMemo(() => hardshipScale(metric, props), [metric, props])
  const hIndexScale = useMemo(() => hardshipScale(HARDSHIP_METRICS[0], props), [props])
  const pctScale = useMemo(() => accessScale('percentile'), [])
  const scoreScale = useMemo(() => accessScale('score'), [])

  const before: AccessView | null = useMemo(() => (data ? applyPlan(data.access, []) : null), [data])
  const after: AccessView | null = useMemo(() => (data && result ? applyPlan(data.access, result.steps) : null), [data, result])
  const mode = chapter === 1 ? 'hardship' : 'access'
  const view = chapter === 3 && showAfter && after ? after : before

  const facilities = useMemo(
    () => (data && chapter === 2 ? data.facilities.features.filter((f) => !f.properties.modeled && (aLayer === 'pct' || f.properties.category === aLayer)) : []),
    [data, chapter, aLayer],
  )
  const proposed: ProposedSite[] = useMemo(
    () =>
      chapter === 3 && result
        ? result.steps.map((s, i) => ({ lat: s.lat, lon: s.lon, label: String(i + 1), title: `New ${SERVICE_NOUN[s.cat]} · ${fmtInt(s.residents_closer)} people closer · click for details`, color: SERVICE_COLORS[s.cat], radiusMi: 0, cat: s.cat, active: siteSel === i }))
        : [],
    [chapter, result, siteSel],
  )

  if (error) return <div className="splash">Could not load data: {error}</div>
  if (!data || !before || !view) return <div className="splash">Loading the map of North Carolina…</div>

  const { access } = data
  const aScale = aLayer === 'pct' ? pctScale : scoreScale
  const accessValue = (geoid: string, v: AccessView): number | null => {
    const r = v.rows[geoid]
    if (!r) return null
    return aLayer === 'pct' ? r.pct : r.cov[IDX[aLayer]]
  }
  const fill = (p: TractProps): string | null => {
    if (mode === 'hardship') {
      if (p.status !== 'ok') return null
      const v = p[hLayer] as number | null
      return v == null ? NO_DATA : hScale.color(v)
    }
    const v = accessValue(p.geoid, view)
    return v == null ? null : aScale.color(v)
  }
  const tooltip = (p: TractProps) => {
    const head = `<div class="tt-title">${p.county}</div>`
    if (mode === 'hardship') {
      const v = p[hLayer] as number | null
      const val = p.status !== 'ok' ? STATUS_LABEL[p.status] : v == null ? 'No data' : metric.format(v)
      return head + `<div class="tt-row"><span>${hLayer === 'hardship_pct' ? 'Hardship score' : metric.label}</span><b>${val}</b></div>`
    }
    const b = accessValue(p.geoid, before)
    const a = accessValue(p.geoid, view)
    if (b == null) return head + `<div class="tt-row"><span>No residents</span></div>`
    const label = aLayer === 'pct' ? 'Access score' : `${SERVICE_INFO[aLayer].label} access`
    const fmt = (v: number) => `${Math.round(v)}`
    return head + `<div class="tt-row"><span>${label}</span><b>${fmt(b)}${a != null && a > b + 0.5 ? ` → ${fmt(a)}` : ''}</b></div>`
  }

  const go = (c: Chapter) => {
    setChapter(c)
    setSelected(null)
    if (c !== 3) setFocus({ key: `nc-${Date.now()}`, bounds: NC_BOUNDS, padding: [430, 20] })
  }

  const findBest = async () => {
    setRunning(true)
    try {
      const plans: Record<string, PlanStep[]> = await load(`plans/${scope}.json`)
      const key = SERVICES.filter((c) => cats.includes(c)).join('+')
      const steps = (plans[key] ?? []).slice(0, nSites)
      const scopeName = scope === 'nc' ? 'North Carolina' : access.counties.find((c) => c.fips === scope)?.name ?? scope
      setResult({ scopeName, steps })
      setEditing(false)
      setSiteSel(null)
      // Show today's map first, then switch to the new sites so the change is the first thing people see.
      setShowAfter(false)
      window.setTimeout(() => setShowAfter(true), 1600)
      setALayer('pct')
      setSelected(null)
      if (steps.length) setFocus({ key: `r-${Date.now()}`, bounds: L.latLngBounds(steps.map((s) => [s.lat, s.lon] as [number, number])).pad(1.2), padding: [450, 60] })
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const scored = props.filter((p) => p.status === 'ok')
  const tract = selected ? byId.get(selected) ?? null : null
  const ingredient = INGREDIENTS.find((i) => i.key === hLayer)

  return (
    <div className="ex">
      <header className="ex-top">
        <button className="ex-brand" onClick={onHome} title="Back to the story">
          <Logo size={22} />
          <span>Allocate <b>NC</b></span>
        </button>
        <nav className="ex-steps" aria-label="Chapters">
          {CHAPTERS.map((c, i) => (
            <div key={c.n} className="ex-step-wrap">
              {i > 0 && <span className="ex-step-line" />}
              <button className={`ex-step ${chapter === c.n ? 'on' : ''} ${chapter > c.n ? 'done' : ''}`} onClick={() => go(c.n)}>
                <span className="ex-step-n">{c.n}</span>
                {c.title}
              </button>
            </div>
          ))}
        </nav>
        <span className="ex-top-right">All of North Carolina · {fmtInt(scored.length)} neighborhoods</span>
      </header>

      <main className="ex-map">
        <MapView tracts={data.tracts} fill={fill} tooltip={tooltip} selected={selected} onSelect={(g) => { setSelected(g); setSiteSel(null) }} facilities={facilities} proposed={proposed} focus={focus} onSiteClick={(i) => { setSiteSel(i); setSelected(null) }} />
        {chapter === 3 && result && result.steps.length > 0 ? (
          <div className="ex-ba">
            <button className={!showAfter ? 'on today' : ''} onClick={() => setShowAfter(false)}>Today</button>
            <button className={showAfter ? 'on after' : ''} onClick={() => setShowAfter(true)}>With {result.steps.length} new site{result.steps.length > 1 ? 's' : ''}</button>
          </div>
        ) : (
          <div className="ex-tip">Hover over any neighborhood for its score · click it for the details</div>
        )}
        <HowItWorks chapter={chapter} access={access} />

        <aside className="ex-card" key={chapter}>
          {chapter === 1 && (
            <>
              <p className="ex-kicker">Chapter 1</p>
              <h2>Who's struggling?</h2>
              <p className="ex-lead">
                Every shape is a county neighborhood. County averages hide where families are really struggling, so Allocate NC
                scores all {fmtInt(scored.length)} neighborhoods in the state on one comparable scale.
              </p>
              <div className="ex-layer">
                <button className={`ex-main ${hLayer === 'hardship_pct' ? 'on' : ''}`} onClick={() => setHLayer('hardship_pct')}>
                  <IconIndex /> Economic Hardship Index
                </button>
                <button className={`ex-filter ${openH ? 'on' : 'pulse'}`} onClick={() => setOpenH(!openH)} aria-expanded={openH}>
                  <IconFilter /> What's in it?
                </button>
              </div>
              {openH && (
                <div className="ex-ingredients">
                  <p>The index blends four measures, weighted about equally. Tap one to see it on its own:</p>
                  <div className="ex-chips">
                    {INGREDIENTS.map((i) => (
                      <button key={i.key} className={`ex-chip ${hLayer === i.key ? 'on' : ''}`} onClick={() => setHLayer(hLayer === i.key ? 'hardship_pct' : i.key)}>
                        {i.icon} {i.label}
                      </button>
                    ))}
                  </div>
                  {ingredient && <p className="ex-explain">{ingredient.text}</p>}
                </div>
              )}
              <Legend scale={hScale} low={hLayer === 'median_income' ? 'Higher income' : 'Less hardship'} high={hLayer === 'median_income' ? 'Lower income' : 'More hardship'} note={hLayer === 'hardship_pct' ? 'Compared with all NC neighborhoods' : `${metric.label}, by neighborhood`} />
              {story && (
                <div className="ex-stat">
                  <b>{(story.top_quarter_people / 1e6).toFixed(1)} million</b> North Carolinians live in the quarter of neighborhoods
                  facing the most hardship. There, 1 in {story.top_quarter_snap_one_in} households relies on SNAP and 1 in{' '}
                  {story.top_quarter_no_car_one_in} has no car.
                </div>
              )}
              <button className="ex-next" onClick={() => go(2)}>Next: How far is help? →</button>
            </>
          )}

          {chapter === 2 && (
            <>
              <p className="ex-kicker">Chapter 2</p>
              <h2>How far is help?</h2>
              <p className="ex-lead">
                Hardship is only half the picture. The same neighborhoods, now scored on how close residents live to four
                services a community depends on: food assistance, health care, transit and libraries.
              </p>
              <div className="ex-layer">
                <button className={`ex-main ${aLayer === 'pct' ? 'on' : ''}`} onClick={() => setALayer('pct')}>
                  <IconAccess /> Access Score
                </button>
                <button className={`ex-filter ${openA ? 'on' : 'pulse'}`} onClick={() => setOpenA(!openA)} aria-expanded={openA}>
                  <IconFilter /> What's in it?
                </button>
              </div>
              {openA && (
                <div className="ex-ingredients">
                  <p>The score averages four services. Tap one to see it on its own:</p>
                  <div className="ex-chips">
                    {SERVICES.map((k) => (
                      <button key={k} className={`ex-chip ${aLayer === k ? 'on' : ''}`} onClick={() => setALayer(aLayer === k ? 'pct' : k)}>
                        <span style={{ color: SERVICE_COLORS[k] }}>{SERVICE_INFO[k].icon}</span> {SERVICE_INFO[k].label}
                      </button>
                    ))}
                  </div>
                  {aLayer !== 'pct' && (
                    <p className="ex-explain">
                      {SERVICE_INFO[aLayer].text} Half of North Carolinians live within {access.services[aLayer].D_miles} miles of one.
                    </p>
                  )}
                </div>
              )}
              <Legend scale={aScale} low="Farther from help" high="Closer to help" note={aLayer === 'pct' ? 'Compared with all NC neighborhoods' : 'Score from 0 to 100'} reverse />
              {story && (
                <div className="ex-stat">
                  Half of North Carolinians live more than <b>{story.health_miles_median} miles</b> from a community health center.
                </div>
              )}
              <p className="ex-note">Zoom in to see the sites on the map.</p>
              <button className="ex-next" onClick={() => go(3)}>Next: What should we build? →</button>
            </>
          )}

          {chapter === 3 && (
            <>
              <p className="ex-kicker">Chapter 3</p>
              <h2>What should we build?</h2>
              <p className="ex-lead">
                Pick an area and the kinds of services you could add. Allocate NC tests thousands of locations and finds the ones
                that bring the most people closer to help — putting neighborhoods with the most hardship first.
              </p>
              {(editing || !result) ? (
                <>
                  <label className="ex-field">
                    <span>1. Where?</span>
                    <select value={scope} onChange={(e) => setScope(e.target.value)}>
                      <option value="nc">All of North Carolina</option>
                      {access.counties.map((c) => (
                        <option key={c.fips} value={c.fips}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="ex-field">
                    <span>2. What could you build?</span>
                    <div className="ex-chips">
                      {SERVICES.map((k) => {
                        const on = cats.includes(k)
                        return (
                          <button key={k} className={`ex-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setCats(on ? (cats.length > 1 ? cats.filter((c) => c !== k) : cats) : [...cats, k])}>
                            <span style={{ color: on ? SERVICE_COLORS[k] : undefined }}>{SERVICE_INFO[k].icon}</span> {SERVICE_INFO[k].label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="ex-field">
                    <span>3. How many new sites?</span>
                    <div className="ex-chips">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} className={`ex-chip num ${nSites === n ? 'on' : ''}`} onClick={() => setNSites(n)}>{n}</button>
                      ))}
                    </div>
                  </div>
                  <button className="ex-run" onClick={findBest} disabled={running}>
                    <IconSpark /> {running ? 'Searching…' : 'Find the best sites'}
                  </button>
                </>
              ) : (
                <div className="ex-results">
                  <div className="ex-query">
                    <span>{result.scopeName} · {cats.length === 4 ? 'all services' : cats.map((c) => SERVICE_INFO[c].label).join(', ')} · {result.steps.length} site{result.steps.length > 1 ? 's' : ''}</span>
                    <button onClick={() => setEditing(true)}>Change</button>
                  </div>
                  {result.steps.length === 0 ? (
                    <p className="ex-note">No location in this area would bring anyone closer to the selected services.</p>
                  ) : (
                    <>
                      <div className="ex-headline">
                        <b>{fmtInt(result.steps.reduce((t, st) => t + st.residents_closer, 0))}</b>
                        <span>people would live closer to a service they need</span>
                      </div>
                      <p className="ex-sub">across {Object.keys(after?.gain ?? {}).length} neighborhoods whose access improves.</p>
                      <ol className="ex-sites">
                        {result.steps.map((st, i) => (
                          <li key={i} className={siteSel === i ? 'on' : ''} onClick={() => { setSiteSel(i); setSelected(null) }}>
                            <span className="ex-site-n" style={{ background: SERVICE_COLORS[st.cat] }}>{i + 1}</span>
                            <div>
                              <b>New {SERVICE_NOUN[st.cat]}</b>
                              <span>{fmtInt(st.residents_closer)} people · {st.avg_miles_closer.toFixed(1)} mi closer</span>
                            </div>
                            <span className="ex-chev">›</span>
                          </li>
                        ))}
                      </ol>
                      <p className="ex-note">Click a site here or on the map for details. Sites are planning suggestions, not specific parcels.</p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </aside>

        {chapter === 3 && result && siteSel != null && result.steps[siteSel] && (
          <div className="ex-detail">
            <SiteDetail
              n={siteSel + 1}
              step={result.steps[siteSel]}
              access={access}
              before={before}
              hardshipOf={(g) => byId.get(g)?.hardship_pct ?? null}
              county={byId.get(result.steps[siteSel].geoid)?.county ?? ''}
              onClose={() => setSiteSel(null)}
            />
          </div>
        )}
        {tract && siteSel == null && (
          <div className="ex-detail">
            <TractPanel
              tract={tract}
              model={data.model}
              mode={mode}
              hardshipColor={hIndexScale.color}
              pctColor={pctScale.color}
              access={access}
              before={before.rows[tract.geoid] ?? null}
              after={chapter === 3 ? after?.rows[tract.geoid] ?? null : null}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </main>
    </div>
  )
}

function Legend({ scale, low, high, note, reverse }: { scale: ColorScale; low: string; high: string; note: string; reverse?: boolean }) {
  // Access bins are listed worst → best; show "far" on the left for both scales so red sits on the right for hardship only.
  const bins = scale.bins
  return (
    <div className="ex-legend">
      <div className="ex-legend-bar">
        {bins.map((b) => (
          <span key={b.label} style={{ background: b.color }} title={b.label} />
        ))}
      </div>
      <div className="ex-legend-ends">
        <span>{reverse ? low : low}</span>
        <span>{high}</span>
      </div>
      <p>{note}</p>
    </div>
  )
}

const HOW: Record<Chapter, { title: string; inputs: { icon: ReactNode; label: string }[]; output: string; points: (a: AppData['access']) => string[] }> = {
  1: {
    title: 'How the hardship score is built',
    inputs: INGREDIENTS.map((i) => ({ icon: i.icon, label: i.label })),
    output: 'Hardship score',
    points: () => [
      'Four public measures for every neighborhood, from USDA and U.S. Census data.',
      'Together, they show how hard it is for a household to cover the basics: food, rent, and getting to work or a doctor.',
      'Every neighborhood is ranked against all of North Carolina. A score of 90 means more hardship than 90% of the state.',
    ],
  },
  2: {
    title: 'How the access score is built',
    inputs: (['food', 'health', 'transit', 'library'] as ServiceKey[]).map((k) => ({ icon: <span style={{ color: SERVICE_COLORS[k] }}>{SERVICE_INFO[k].icon}</span>, label: SERVICE_INFO[k].label })),
    output: 'Access score',
    points: (a) => [
      `We measured the distance from homes in every neighborhood to the nearest food assistance site, and to the nearest of ${fmtInt(a.services.health.facilities)} health centers, ${fmtInt(a.services.transit.facilities)} transit stops and ${fmtInt(a.services.library.facilities)} libraries.`,
      'Each distance is judged against what is typical in that county and across the state, so rural and city neighborhoods are compared fairly.',
      'The four results are averaged and ranked against all of North Carolina.',
    ],
  },
  3: {
    title: 'How sites are chosen',
    inputs: [
      { icon: <IconSpark />, label: '125,000+ test sites' },
      { icon: <IconAccess />, label: 'Access gained' },
      { icon: <IconIndex />, label: 'Hardship weight' },
    ],
    output: 'Best sites',
    points: () => [
      'Every possible location is tested for each kind of service you allow.',
      'Each one is scored by how much closer it brings people to help, counting neighborhoods with more hardship more heavily.',
      'The best one is placed, the map is updated, and the search repeats — so no one is counted twice.',
    ],
  },
}

function HowItWorks({ chapter, access }: { chapter: Chapter; access: AppData['access'] }) {
  const h = HOW[chapter]
  return (
    <div className="ex-how" key={chapter}>
      <p className="ex-how-title">{h.title}</p>
      <div className="ex-how-flow">
        <div className="ex-how-inputs">
          {h.inputs.map((i) => (
            <span key={i.label} className="ex-how-in">{i.icon}{i.label}</span>
          ))}
        </div>
        <span className="ex-how-arrow">→</span>
        <span className="ex-how-out">{h.output}</span>
      </div>
      <ol className="ex-how-points">
        {h.points(access).map((t) => <li key={t}>{t}</li>)}
      </ol>
    </div>
  )
}

function SiteDetail({ n, step, access, before, hardshipOf, county, onClose }: {
  n: number
  step: PlanStep
  access: AppData['access']
  before: AccessView
  hardshipOf: (g: string) => number | null
  county: string
  onClose: () => void
}) {
  const solo = applyPlan(access, [step])
  let w = 0, b = 0, a = 0, hw = 0, h = 0
  for (const [g, , people] of step.tracts) {
    const rb = before.rows[g], ra = solo.rows[g]
    if (!rb || !ra) continue
    w += people; b += rb.pct * people; a += ra.pct * people
    const hp = hardshipOf(g)
    if (hp != null) { hw += people; h += hp * people }
  }
  const info = SERVICE_INFO[step.cat]
  return (
    <div className="ex-site">
      <header>
        <span className="ex-site-n big" style={{ background: SERVICE_COLORS[step.cat] }}>{n}</span>
        <div>
          <p className="ex-kicker">Recommended site</p>
          <h3>New {SERVICE_NOUN[step.cat]}</h3>
          <span className="muted">{county}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="ex-site-big">
        <b>{fmtInt(step.residents_closer)}</b>
        <span>people would live closer to {step.cat === 'transit' ? 'a transit stop' : `a ${SERVICE_NOUN[step.cat]}`}</span>
      </div>
      <div className="ex-site-grid">
        <div><b>{step.avg_miles_closer.toFixed(1)} mi</b><span>closer on average</span></div>
        <div><b>{step.tracts.length}</b><span>neighborhoods improve</span></div>
        <div>
          <b>{Math.round(b / Math.max(w, 1))} → {Math.round(a / Math.max(w, 1))}</b>
          <span>their access score (out of 100)</span>
        </div>
        <div><b>{hw ? Math.round(h / hw) : '–'}</b><span>average hardship score of the people helped</span></div>
      </div>
      <p className="ex-note">
        <span style={{ color: SERVICE_COLORS[step.cat] }}>{info.icon}</span> Chosen because it brings the most people closer to {info.label.toLowerCase() === 'health' ? 'health care' : info.label.toLowerCase() === 'food' ? 'food assistance' : info.label.toLowerCase() === 'transit' ? 'transit' : 'a library'}, counting neighborhoods with more hardship more heavily.
      </p>
    </div>
  )
}
