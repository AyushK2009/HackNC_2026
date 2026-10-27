import { useEffect, useMemo, useState } from 'react'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import { api, modelEvents, CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, type Activity, type Category, type NeedSummary, type Project } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import { usePlace, setPlace, shortCounty } from '../shared/place'
import PlacePicker from '../shared/PlacePicker'
import { useMode } from '../shared/mode'
import { countyBounds, countyCenter, fipsOf, needPctScale, ago, LegendBar, STATUS } from '../community/common'
import { ordinal } from '../format'
import './home.css'

const ACTIVE: Project['status'][] = ['proposed', 'approved', 'in_progress']

const KIND_DOT: Record<Activity['kind'], string> = {
  report: '#e2513c',
  need: '#94409a',
  project: '#1d4ed8',
  signup: '#0891b2',
  complete: '#1f7a3f',
  plan: '#334155',
}

type Agg = { by: Record<Category, number>; need: number; pop: number }

function aggregate(rows: [NeedSummary, number][]): Agg {
  const by = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  let need = 0, pop = 0
  for (const [s, w] of rows) {
    pop += w
    need += s.need * w
    for (const c of CATEGORIES) by[c] += (s.by[c] ?? 0) * w
  }
  if (pop) {
    need /= pop
    for (const c of CATEGORIES) by[c] /= pop
  }
  return { by, need, pop }
}

export default function Home() {
  const base = useBaseData()
  const [place] = usePlace()
  const planner = useMode() === 'planner'
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [feed, setFeed] = useState<Activity[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [ways, setWays] = useState<number | null>(null)
  const [reports, setReports] = useState<number | null>(null)

  useEffect(() => {
    const load = () => {
      api.needs().then((n) => setNeeds(n.tracts)).catch(() => undefined)
      api.activity(80).then(setFeed).catch(() => undefined)
      api.projects().then(setProjects).catch(() => undefined)
    }
    load()
    const off = modelEvents.subscribe(load)
    const t = window.setInterval(load, 20000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!base) return
    const c = place ? countyCenter(base, place.fips) : null
    api.opportunities(c ? { lat: c[0], lon: c[1], radius: 25 } : {}).then((r) => setWays(r.items.length)).catch(() => setWays(null))
    api.reports(place?.name, 2000).then((r) => setReports(r.length)).catch(() => setReports(null))
  }, [base, place])

  const where = place?.name ?? 'North Carolina'
  const short = place ? shortCounty(place.name) : 'North Carolina'

  // Population-weighted need for the place, the state, and every county (for the rank line).
  const stats = useMemo(() => {
    if (!base || !needs) return null
    const rows: [string, NeedSummary, number][] = []
    for (const [g, s] of Object.entries(needs)) rows.push([g, s, Math.max(1, base.byId.get(g)?.pop ?? 1)])
    const state = aggregate(rows.map(([, s, w]) => [s, w]))
    const byCounty = new Map<string, [NeedSummary, number][]>()
    for (const [g, s, w] of rows) {
      const f = fipsOf(g)
      if (!byCounty.has(f)) byCounty.set(f, [])
      byCounty.get(f)!.push([s, w])
    }
    const counties = [...byCounty.entries()].map(([f, r]) => ({ fips: f, ...aggregate(r) })).sort((a, b) => b.need - a.need)
    const local = place ? aggregate(byCounty.get(place.fips) ?? []) : state
    const rank = place ? counties.findIndex((c) => c.fips === place.fips) + 1 : 0
    const ranked = CATEGORIES.map((c) => ({ c, v: local.by[c], s: state.by[c], ratio: local.by[c] / Math.max(1, state.by[c]) })).sort((a, b) => b.v - a.v)
    const above = [...ranked].filter((r) => r.ratio >= 1.08).sort((a, b) => b.ratio - a.ratio)
    const scaleMax = Math.max(50, ...ranked.map((r) => Math.max(r.v, r.s))) * 1.1
    const hotspots = rows
      .filter(([g, , w]) => (place ? fipsOf(g) === place.fips : true) && w >= 800)
      .sort((a, b) => b[1].pct - a[1].pct)
      .slice(0, 4)
    return { local, state, rank, total: counties.length, ranked, above, scaleMax, hotspots, topCounties: counties.slice(0, 4) }
  }, [base, needs, place])

  const localFeed = useMemo(
    () => (place ? feed.filter((a) => a.county === place.name) : feed).filter((a) => !planner || a.kind === 'report' || a.kind === 'need').slice(0, 7),
    [feed, place, planner],
  )
  const localProjects = useMemo(() => (place ? projects.filter((p) => p.county === place.name) : projects), [projects, place])
  const active = localProjects.filter((p) => ACTIVE.includes(p.status)).length
  const done = localProjects.filter((p) => p.status === 'complete').length

  const markers = useMemo<MapMarker[]>(
    () =>
      localProjects
        .filter((p) => p.status !== 'complete')
        .map((p) => ({
          id: p.id,
          lat: p.lat,
          lon: p.lon,
          color: CATEGORY_COLOR[p.categories[0]] ?? '#18191b',
          size: 14,
          tooltip: `<b>${p.title}</b><br/>Project · ${p.status.replace('_', ' ')}`,
          onClick: () => (window.location.hash = `/projects?id=${p.id}`),
        })),
    [localProjects],
  )

  const focus = useMemo(() => {
    const b = base && place ? countyBounds(base, place.fips) : null
    return { key: place?.fips ?? 'nc', bounds: b ?? NC_BOUNDS, padding: [24, 24] as [number, number], paddingBR: [24, 24] as [number, number] }
  }, [base, place])

  const lead = stats?.ranked.slice(0, 2) ?? []

  return (
    <div className="hm">
      <div className="hm-inner">
        <section className="hm-head">
          <div className="hm-head-text">
            <span className="hm-eyebrow">{planner ? 'Planning workspace' : place ? 'Your community' : 'Start here'}</span>
            <h1>{place ? where : 'Where is your community?'}</h1>
            {place && stats ? (
              <p className="hm-sum">
                {lead.length === 2 && (
                  <>
                    The biggest needs here are <b>{CATEGORY_LABEL[lead[0].c].toLowerCase()}</b> and <b>{CATEGORY_LABEL[lead[1].c].toLowerCase()}</b>.{' '}
                  </>
                )}
                {stats.above[0] && (
                  <>
                    <b>{CATEGORY_LABEL[stats.above[0].c]}</b> is well above the state average.{' '}
                  </>
                )}
                {stats.rank <= stats.total / 3
                  ? <>Overall, one of the highest-need counties in North Carolina (<b>{ordinal(stats.rank)} of {stats.total}</b>).</>
                  : stats.rank <= (2 * stats.total) / 3
                    ? <>Overall need is near the middle of North Carolina's counties (<b>{ordinal(stats.rank)} of {stats.total}</b>).</>
                    : <>Overall need is lower than in most counties (<b>{ordinal(stats.rank)} of {stats.total}</b>), but some neighborhoods are far above it.</>}
              </p>
            ) : (
              <p className="hm-sum">
                {planner
                  ? 'Pick the county you serve. Plans, projects and the map all start there.'
                  : 'Pick your county and everything here starts there: the map, reporting a need, and ways to help.'}
              </p>
            )}
          </div>
          {place ? (
            <PlacePicker label="Change county" className="hm-picker small" placeholder="Type your county" />
          ) : (
            <PlacePicker size="lg" className="hm-picker" placeholder="Type your county" allowState={false} />
          )}
        </section>

        {planner ? (
          <section className="hm-tasks">
            <a className="hm-task primary" href={place ? `#/plan?county=${place.fips}` : '#/plan'}>
              <span className="hm-task-k">Deciding where services go?</span>
              <b>Plan services</b>
              <p>Set a budget and volunteer hours. Get the mix of services and places that reaches the most need.</p>
              <em>Plans in about a second</em>
            </a>
            <a className="hm-task" href="#/projects">
              <span className="hm-task-k">Already doing the work?</span>
              <b>Projects</b>
              <p>Track milestones, staff volunteers, and see need drop on the map when you finish.</p>
              <em>{active} underway · {done} finished{place ? ` in ${short}` : ''}</em>
            </a>
            <a className="hm-task" href="#/map">
              <span className="hm-task-k">Need the evidence?</span>
              <b>Community map</b>
              <p>Need by neighborhood, what drives it, and what residents are reporting.</p>
              <em>{reports != null ? `${reports.toLocaleString()} resident report${reports === 1 ? '' : 's'} in ${short}` : '\u00a0'}</em>
            </a>
          </section>
        ) : (
          <section className="hm-tasks">
            <a className="hm-task primary" href="#/report">
              <span className="hm-task-k">Something is hard where you live?</span>
              <b>Report a need</b>
              <p>Say it in your own words. The map updates the moment you send it.</p>
              <em>{reports != null ? `${reports.toLocaleString()} report${reports === 1 ? '' : 's'} in ${short} so far` : '\u00a0'}</em>
            </a>
            <a className="hm-task" href="#/involved">
              <span className="hm-task-k">Have time to give?</span>
              <b>Volunteer</b>
              <p>Opportunities ranked by where need is highest and what fits you.</p>
              <em>{ways != null ? `${ways} way${ways === 1 ? '' : 's'} to help ${place ? `near ${short}` : 'statewide'}` : '\u00a0'}</em>
            </a>
            <a className="hm-task" href="#/map">
              <span className="hm-task-k">Curious what your area needs?</span>
              <b>Community map</b>
              <p>See every neighborhood, why it's underserved, and what neighbors are saying.</p>
              <em>{active} project{active === 1 ? '' : 's'} underway{place ? ` in ${short}` : ''}</em>
            </a>
          </section>
        )}

        <section className="hm-grid">
          <div className="hm-card hm-mapcard">
            <header>
              <div>
                <h2>Where help is needed{place ? ` in ${short}` : ''}</h2>
                <span>Darker neighborhoods have more need. Click one to see why.</span>
              </div>
              <a className="hm-link" href="#/map">Open the community map →</a>
            </header>
            <div className="hm-map">
              {base && needs ? (
                <MapView
                  tracts={base.tracts}
                  fill={(p) => (place && fipsOf(p.geoid) !== place.fips ? '#ebe9e4' : needPctScale.color(needs[p.geoid]?.pct))}
                  tooltip={(p) => `<b>${p.county}</b><br/>A neighborhood of ${p.pop.toLocaleString()} · need higher than ${Math.round(needs[p.geoid]?.pct ?? 0)}% of NC`}
                  selected={null}
                  onSelect={(g) => (window.location.hash = `/map?geoid=${g}`)}
                  markers={markers}
                  focus={focus}
                />
              ) : (
                <div className="hm-loading">Loading the map…</div>
              )}
            </div>
            <footer>
              <LegendBar bins={needPctScale.bins} low="Less need" high="More need" />
              {markers.length > 0 && (
                <span className="hm-pin-key"><i />Projects underway</span>
              )}
            </footer>
          </div>

          <div className="hm-side">
            <div className="hm-card">
              <h2>{place ? `What ${short} needs most` : 'What North Carolina needs most'}</h2>
              {place && <span className="hm-sub">Line marks the state average</span>}
              <ul className="hm-bars">
                {stats?.ranked.map(({ c, v, s }) => (
                  <li key={c}>
                    <span className="hm-bar-label">{CATEGORY_LABEL[c]}</span>
                    <span className="hm-bar-track">
                      <span style={{ width: `${(v / (stats?.scaleMax ?? 100)) * 100}%`, background: CATEGORY_COLOR[c] }} />
                      {place && <i style={{ left: `${(s / (stats?.scaleMax ?? 100)) * 100}%` }} title={`State average ${Math.round(s)}`} />}
                    </span>
                    <span className="hm-bar-val">{Math.round(v)}</span>
                  </li>
                ))}
              </ul>
              <h3>{place ? 'Neighborhoods with the most need' : 'Counties with the most need'}</h3>
              <ol className="hm-hot">
                {place
                  ? stats?.hotspots.map(([g, s]) => (
                      <li key={g}>
                        <a href={`#/map?geoid=${g}`}>
                          <span>Neighborhood of {(base?.byId.get(g)?.pop ?? 0).toLocaleString()}</span>
                          <em style={{ color: CATEGORY_COLOR[s.top] }}>Biggest gap: {CATEGORY_LABEL[s.top]}</em>
                        </a>
                      </li>
                    ))
                  : stats?.topCounties.map((c) => {
                      const name = base?.access.counties.find((x) => x.fips === c.fips)?.name ?? c.fips
                      return (
                        <li key={c.fips}>
                          <a href="#/home" onClick={(e) => { e.preventDefault(); setPlace({ fips: c.fips, name }) }}>
                            <span>{name}</span>
                            <em>Look closer</em>
                          </a>
                        </li>
                      )
                    })}
              </ol>
            </div>
          </div>
        </section>

        <section className="hm-grid lower">
          <div className="hm-card hm-feed">
            <header>
              <div>
                <h2>{planner ? 'What residents are reporting' : `Latest ${place ? `in ${short}` : 'across the state'}`}</h2>
                <span>{planner ? 'New reports raise need on the map, so the next plan starts from them.' : 'Every report, sign-up and finished project changes the map for everyone.'}</span>
              </div>
            </header>
            <ul>
              {localFeed.map((a) => {
                const href = planner && (a.kind === 'project' || a.kind === 'complete' || a.kind === 'signup') ? '#/projects' : a.geoid ? `#/map?geoid=${a.geoid}` : '#/map'
                return (
                  <li key={a.id}>
                    <a href={href}>
                      <i style={{ background: KIND_DOT[a.kind] }} />
                      <div>
                        <p>{a.text}</p>
                        <span>{!place && a.county ? `${a.county} · ` : ''}{ago(a.at)}</span>
                      </div>
                    </a>
                  </li>
                )
              })}
              {!localFeed.length && (
                <li className="empty">
                  Nothing yet in {short}. <a href="#/report">Be the first to report a need</a>.
                </li>
              )}
            </ul>
          </div>

{planner ? (
          <div className="hm-card hm-projects">
            <header>
              <div>
                <h2>Projects{place ? ` in ${short}` : ''}</h2>
                <span>From plan to finished work</span>
              </div>
              <a className="hm-link" href="#/projects">Board →</a>
            </header>
            <ul>
              {localProjects.filter((p) => p.status !== 'complete').slice(0, 5).map((p) => (
                <li key={p.id}>
                  <a href={`#/projects?id=${p.id}`}>
                    <b>{p.label}</b>
                    <span>{STATUS[p.status] ?? p.status} · {Math.round(p.progress)}% done</span>
                    <i><i style={{ width: `${Math.round(p.progress)}%` }} /></i>
                  </a>
                </li>
              ))}
              {!localProjects.some((p) => p.status !== 'complete') && (
                <li className="empty">
                  No projects yet{place ? ` in ${short}` : ''}. <a href="#/plan">Build a plan</a> to start one.
                </li>
              )}
            </ul>
          </div>
          ) : (
          <a className="hm-card hm-walk" href="#/tour">
            <span className="hm-eyebrow">See how it connects</span>
            <h2>Follow one report from a resident to a finished project</h2>
            <p>A live walkthrough in Durham County: a report raises need, a plan responds, volunteers are matched, and need falls when the work is done.</p>
            <ol>
              <li>Report</li>
              <li>Need rises</li>
              <li>Plan</li>
              <li>Volunteers</li>
              <li>Need falls</li>
            </ol>
            <b>Start the walkthrough →</b>
          </a>
          )}
        </section>
      </div>
    </div>
  )
}
