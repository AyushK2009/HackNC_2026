import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import MapView, { type MapMarker } from '../MapView'
import { useBaseData } from '../shared/baseData'
import { api, modelEvents, CATEGORY_COLOR, CATEGORY_LABEL, type Extraction, type NeedChange, type NeedSummary, type OptimizeResult, type Project } from '../shared/api'
import { SEVERITY, NO_DATA, type TractProps } from '../metrics'
import { fmtInt } from '../format'
import './tour.css'

// A guided, fully live run of the whole loop: every step calls the real backend and changes the shared model.
const COUNTY_FIPS = '063'
const COUNTY_NAME = 'Durham County'
const REPORT_TEXT =
  "Since the Route 12 bus was cut, my neighbors and I can't get to the clinic on Fayetteville Street. Most of us don't have cars, and the seniors on our block have missed appointments for weeks."

const BREAKS = [20, 40, 60, 80, 90]
const color = (v: number | null | undefined) => {
  if (v == null) return NO_DATA
  let i = 0
  while (i < BREAKS.length && v >= BREAKS[i]) i++
  return SEVERITY[i]
}

type Step = 0 | 1 | 2 | 3 | 4 | 5

export default function Tour() {
  const base = useBaseData()
  const [step, setStep] = useState<Step>(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [typed, setTyped] = useState('')
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [change, setChange] = useState<NeedChange | null>(null)
  const [plan, setPlan] = useState<OptimizeResult | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [staff, setStaff] = useState<Awaited<ReturnType<typeof api.staff>> | null>(null)
  const [done, setDone] = useState<Awaited<ReturnType<typeof api.complete>> | null>(null)

  const refreshNeeds = () => api.needs().then((n) => setNeeds(n.tracts)).catch((e) => setErr(String(e)))
  useEffect(() => {
    refreshNeeds()
  }, [])

  // The neighborhood the resident writes about: the highest-need populated neighborhood in the county.
  const target = useMemo(() => {
    if (!base || !needs) return null
    let best: { geoid: string; need: number } | null = null
    for (const f of base.tracts.features) {
      const p = f.properties
      if (!p.geoid.startsWith(`37${COUNTY_FIPS}`) || p.pop < 1500 || !p.urban || (p.hardship_pct ?? 0) < 75) continue
      const n = needs[p.geoid]?.by?.transit ?? -1
      if (!best || n > best.need) best = { geoid: p.geoid, need: n }
    }
    return best?.geoid ?? null
  }, [base, needs])
  const where = target && base ? base.centroid.get(target) ?? null : null

  // Typing animation for step 1.
  useEffect(() => {
    if (step !== 1) return
    setTyped('')
    let i = 0
    const t = window.setInterval(() => {
      i += 3
      setTyped(REPORT_TEXT.slice(0, i))
      if (i >= REPORT_TEXT.length) window.clearInterval(t)
    }, 18)
    return () => window.clearInterval(t)
  }, [step])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const sendReport = () =>
    run(async () => {
      if (!where) return
      const ex = await api.extract(REPORT_TEXT)
      setExtraction(ex)
      const r = await api.report(REPORT_TEXT, where[0], where[1], ex)
      setChange(r.change)
      await refreshNeeds()
      modelEvents.emit()
      setStep(2)
    })

  const makePlan = () =>
    run(async () => {
      const types = (await api.interventions()).map((t) => t.key)
      const res = await api.optimize({ scope: COUNTY_FIPS, budget: 400000, volunteers: 600, types, max_per_type: 2, name: 'Guided tour plan' })
      setPlan(res)
      modelEvents.emit()
      setStep(3)
    })

  const makeProject = () =>
    run(async () => {
      if (!plan?.portfolio.length) return
      // The item that serves the most people makes the clearest before/after.
      const top = [...plan.portfolio].sort((a, b) => b.people_reached - a.people_reached)[0]
      const pr = await api.createProject(top, plan.scenario)
      await api.updateProject(pr.id, { status: 'in_progress' })
      const st = await api.staff(pr.id)
      setProject(st.project)
      setStaff(st)
      modelEvents.emit()
      setStep(4)
    })

  const finish = () =>
    run(async () => {
      if (!project) return
      const c = await api.complete(project.id)
      setDone(c)
      await refreshNeeds()
      modelEvents.emit()
      setStep(5)
    })

  const restart = () =>
    run(async () => {
      await api.reset()
      setExtraction(null)
      setChange(null)
      setPlan(null)
      setProject(null)
      setStaff(null)
      setDone(null)
      await refreshNeeds()
      modelEvents.emit()
      setStep(0)
    })

  // Statewide rank (0–100) of a raw need score, against today's distribution.
  const sortedNeed = useMemo(() => (needs ? Object.values(needs).map((n) => n.need).sort((a, b) => a - b) : []), [needs])
  const rankOf = (v: number) => {
    let lo = 0, hi = sortedNeed.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedNeed[m] < v) lo = m + 1; else hi = m }
    return (lo / Math.max(1, sortedNeed.length)) * 100
  }

  const countyBounds = useMemo(() => {
    if (!base) return null
    const fc = { type: 'FeatureCollection' as const, features: base.tracts.features.filter((f) => f.properties.county === COUNTY_NAME) }
    return L.geoJSON(fc).getBounds()
  }, [base])

  const markers: MapMarker[] = useMemo(() => {
    const m: MapMarker[] = []
    if (where && step >= 1)
      m.push({ id: 'report', lat: where[0], lon: where[1], color: '#e2513c', size: 18, label: '!', tooltip: 'The resident’s report' })
    if (plan && step >= 3)
      plan.portfolio.forEach((p, i) =>
        m.push({ id: p.id, lat: p.lat, lon: p.lon, color: CATEGORY_COLOR[p.categories[0]], size: 26, label: String(i + 1), tooltip: `${p.label} · ${fmtInt(p.people_reached)} people reached` }),
      )
    return m
  }, [where, plan, step])

  if (!base || !countyBounds) return <div className="page-placeholder">Loading the map…</div>

  const fill = (p: TractProps) => {
    const n = needs?.[p.geoid]
    if (!n) return null
    if (step >= 3 && step < 5 && plan?.tracts[p.geoid]) return color(rankOf(plan.tracts[p.geoid].after))
    return color(n.pct)
  }
  const tooltip = (p: TractProps) => {
    const n = needs?.[p.geoid]
    return `<div class="tt-title">${p.county}</div>` + (n ? `<div class="tt-row"><span>Community need</span><b>${Math.round(n.pct)}</b></div>` : '')
  }

  const STEPS = [
    { title: 'From one report to a finished project', sub: 'Five live steps in Durham County. Each one changes the same map everyone uses.' },
    { title: '1 · A resident reports a problem', sub: `A neighbor in ${COUNTY_NAME} describes, in their own words, what's hard to reach.` },
    { title: '2 · The map learns', sub: 'The report is read, pinned to the neighborhood, and weighed as evidence.' },
    { title: '3 · A planner builds a plan', sub: 'With $400k and 600 volunteer hours a month, Allocate NC picks the mix that helps most.' },
    { title: '4 · It becomes a staffed project', sub: 'Volunteers are matched to every role by skills, distance and time.' },
    { title: '5 · The work is done, and the map learns again', sub: 'Finishing the project lowers need where it reaches.' },
  ]

  return (
    <div className="tour">
      <MapView tracts={base.tracts} fill={fill} tooltip={tooltip} selected={step >= 1 ? target : null} onSelect={() => undefined} markers={markers} focus={{ key: 'tour', bounds: countyBounds, padding: [40, 40] }} />
      <aside className="tour-panel">
        <div className="tour-progress">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={step >= n ? 'on' : ''} />
          ))}
        </div>
        <h2>{STEPS[step].title}</h2>
        <p className="tour-sub">{STEPS[step].sub}</p>
        {err && <p className="tour-err">{err}. Is the local server running?</p>}

        {step === 0 && (
          <>
            <ol className="tour-list">
              <li>A resident reports a missing bus route</li>
              <li>The need estimate rises where they live</li>
              <li>A planner optimizes a budget across the county</li>
              <li>The top project is staffed with matched volunteers</li>
              <li>It's completed, and need falls on the map</li>
            </ol>
            <button className="tour-btn" onClick={() => setStep(1)}>Start →</button>
          </>
        )}

        {step === 1 && (
          <>
            <div className="tour-quote">
              <p>{typed}<span className="caret" /></p>
              <span>Report from {COUNTY_NAME}</span>
            </div>
            <button className="tour-btn" disabled={busy || typed.length < REPORT_TEXT.length} onClick={sendReport}>
              {busy ? 'Reading the report…' : 'Send report →'}
            </button>
          </>
        )}

        {step === 2 && extraction && change && (
          <>
            <div className="tour-card">
              <p className="tour-label">What the system understood ({extraction.engine === 'claude' ? 'Claude' : 'local language model'})</p>
              <p className="tour-summary">“{extraction.summary}”</p>
              <div className="tour-chips">
                {extraction.categories.map((c) => (
                  <span key={c} style={{ borderColor: CATEGORY_COLOR[c], color: CATEGORY_COLOR[c] }}>{CATEGORY_LABEL[c]}</span>
                ))}
                {extraction.barriers.map((b) => (
                  <span key={b}>{b.replace(/_/g, ' ')}</span>
                ))}
                {extraction.groups.map((g) => (
                  <span key={g}>{g.replace(/_/g, ' ')}</span>
                ))}
              </div>
              <p className="tour-meta">Severity {extraction.severity} of 5 · confidence {Math.round(extraction.confidence * 100)}%</p>
            </div>
            <div className="tour-change">
              <div>
                <span>{CATEGORY_LABEL[change.category]} need here</span>
                <b>{Math.round(change.before)} → {Math.round(change.after)}</b>
              </div>
              <div>
                <span>Overall need, vs. all of NC</span>
                <b>{Math.round(change.pct_before)} → {Math.round(change.pct_after)}</b>
              </div>
            </div>
            <button className="tour-btn" disabled={busy} onClick={makePlan}>{busy ? 'Solving the plan…' : 'Build a plan for the county →'}</button>
          </>
        )}

        {step === 3 && plan && (
          <>
            <div className="tour-tiles">
              <div><b>{fmtInt(plan.totals.people_reached)}</b><span>people reached</span></div>
              <div><b>${fmtInt(plan.totals.cost / 1000)}k</b><span>of $400k used</span></div>
              <div><b>{Math.round(plan.totals.reached_before ?? plan.totals.need_before)} → {Math.round(plan.totals.reached_after ?? plan.totals.need_after)}</b><span>need where it reaches</span></div>
            </div>
            <ol className="tour-items">
              {plan.portfolio.map((p, i) => (
                <li key={p.id}>
                  <i style={{ background: CATEGORY_COLOR[p.categories[0]] }}>{i + 1}</i>
                  <div>
                    <b>{p.label}</b>
                    <span>{p.why}</span>
                  </div>
                </li>
              ))}
            </ol>
            <p className="tour-meta">Exact integer program · {fmtInt(plan.solver.candidates)} options tested in {Math.round(plan.solver.time_ms)} ms</p>
            <button className="tour-btn" disabled={busy || !plan.portfolio.length} onClick={makeProject}>{busy ? 'Matching volunteers…' : 'Turn the biggest item into a project →'}</button>
          </>
        )}

        {step === 4 && project && staff && (
          <>
            <div className="tour-card">
              <p className="tour-label">{project.title}</p>
              <div className="tour-bar"><i style={{ width: `${project.progress}%` }} /></div>
              <p className="tour-meta">{Math.round(project.progress)}% ready · {project.milestones.length} milestones · budget ${fmtInt(project.budget)}</p>
            </div>
            <ul className="tour-staff">
              {staff.assignments.slice(0, 6).map((a) => (
                <li key={a.role_id + a.volunteer.id}>
                  <b>{a.volunteer.name}</b>
                  <span>{a.role} · {a.volunteer.county}</span>
                  <em>{Math.round(a.fit * 100)}% fit</em>
                </li>
              ))}
            </ul>
            <p className="tour-meta">{staff.assignments.length} volunteers assigned with the Hungarian algorithm to maximize total fit.</p>
            <button className="tour-btn" disabled={busy} onClick={finish}>{busy ? 'Updating the map…' : 'Mark the project complete →'}</button>
          </>
        )}

        {step === 5 && done && (() => {
          const drops = [...done.changes].sort((a, b) => b.before - b.after - (a.before - a.after))
          const best = drops[0]
          const improved = new Set(done.changes.filter((c) => c.before - c.after >= 0.5).map((c) => c.geoid)).size
          const cat = best?.category
          return (
          <>
            <div className="tour-change good">
              <div>
                <span>{cat ? CATEGORY_LABEL[cat] : 'Need'} need where it serves the most people</span>
                <b>{best ? `${Math.round(best.before)} → ${Math.round(best.after)}` : '–'}</b>
              </div>
              <div>
                <span>Neighborhoods where need fell</span>
                <b>{improved}</b>
              </div>
            </div>
            <p className="tour-sub">The next resident report, plan, or volunteer search starts from this updated picture.</p>
            <div className="tour-row">
              <button className="tour-btn ghost" onClick={() => (window.location.hash = '/map')}>See it on the community map</button>
              <button className="tour-btn ghost" onClick={() => (window.location.hash = project ? `/projects?id=${project.id}` : '/projects')}>Open the project</button>
              <button className="tour-btn ghost" disabled={busy} onClick={restart}>Reset demo data</button>
            </div>
          </>
          )
        })()}
      </aside>
    </div>
  )
}
