import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import type { TractProps } from '../metrics'
import { NO_DATA } from '../metrics'
import { useBaseData } from '../shared/baseData'
import { usePlace } from '../shared/place'
import { api, CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, modelEvents, type Category, type InterventionType, type NeedSummary, type PortfolioItem, type Project } from '../shared/api'
import { tractName } from '../format'
import NewPlan, { type FormState } from './NewPlan'
import Results from './Results'
import SavedPlans, { CompareModal } from './Compare'
import { errText, fmtMoney, fmtNeed, fmtNum, hashQuery, inScope, loadScenarios, needScale, saveScenarios, scopeBounds, type Kind, type SavedScenario } from './util'
import './plan.css'

type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }

const MemoMap = memo(MapView)

function readQuery(): { scope: string | null; geoid: string | null; type: string | null } {
  const q = hashQuery()
  const geoid = q.get('geoid')
  const county = q.get('county')
  const scope = county ? county.padStart(3, '0') : geoid && geoid.length >= 5 ? geoid.slice(2, 5) : null
  return { scope, geoid, type: q.get('type') }
}

// Links may spell keys with dashes ("mobile-market"); the catalog uses underscores.
function matchType(t: string | null, keys: string[]): string | null {
  if (!t) return null
  return keys.find((k) => k === t || k === t.replace(/-/g, '_')) ?? null
}

const STARTERS: { label: string; scope: string; budget: number; volunteers: number }[] = [
  { label: 'Durham County · $500k', scope: '063', budget: 500000, volunteers: 400 },
  { label: 'Robeson County · $250k', scope: '155', budget: 250000, volunteers: 200 },
  { label: 'Statewide · $3M', scope: 'nc', budget: 3000000, volunteers: 1500 },
]

export default function Plan() {
  const base = useBaseData()
  const [place, setPlace] = usePlace()
  const initial = useRef(readQuery())
  const scroller = useRef<HTMLDivElement>(null)

  const [catalog, setCatalog] = useState<InterventionType[] | null>(null)
  const [catalogErr, setCatalogErr] = useState<string | null>(null)
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)

  const [form, setForm] = useState<FormState>(() => ({
    scope: initial.current.scope ?? place?.fips ?? 'nc',
    budget: 500000,
    volunteers: 400,
    types: [],
    custom: [],
    maxPerType: 2,
    name: '',
  }))
  const [suggested, setSuggested] = useState<string | null>(initial.current.type)
  const [solving, setSolving] = useState(false)
  const [solveErr, setSolveErr] = useState<string | null>(null)
  const [scenarios, setScenarios] = useState<SavedScenario[]>(loadScenarios)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [editing, setEditing] = useState(true)
  const [showAfter, setShowAfter] = useState(true)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [creating, setCreating] = useState<Set<string>>(new Set())
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [savedOpen, setSavedOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  const [selected, setSelected] = useState<string | null>(initial.current.geoid)

  const current = scenarios.find((s) => s.id === currentId) ?? null
  const showResults = !!current && !editing

  const update = useCallback((patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch })), [])

  // ---------- data loading ----------
  const loadProjects = useCallback(() => {
    api.projects().then(setProjects).catch(() => undefined)
  }, [])
  const loadNeeds = useCallback(() => {
    api.needs().then((n) => setNeeds(n.tracts)).catch(() => undefined)
  }, [])
  const loadCatalog = useCallback(() => {
    setCatalogErr(null)
    api.interventions().then(setCatalog).catch((e) => setCatalogErr(errText(e)))
  }, [])

  useEffect(() => {
    loadCatalog()
    loadProjects()
    loadNeeds()
    return modelEvents.subscribe(() => {
      loadProjects()
      loadNeeds()
    })
  }, [loadCatalog, loadProjects, loadNeeds])

  // Retry the catalog every few seconds while the server is down.
  useEffect(() => {
    if (!catalogErr) return
    const t = window.setTimeout(loadCatalog, 5000)
    return () => window.clearTimeout(t)
  }, [catalogErr, loadCatalog])

  // Default: every option on (or only the suggested one from a link).
  const typesInit = useRef(false)
  useEffect(() => {
    if (!catalog || typesInit.current) return
    typesInit.current = true
    const keys = catalog.map((t) => t.key)
    const s = matchType(initial.current.type, keys)
    update({ types: s ? [s] : keys })
    setSuggested(s)
  }, [catalog, update])

  // Links like #/plan?county=063&type=mobile-market can arrive while the page is open.
  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith('#/plan')) return
      const q = readQuery()
      if (!q.scope && !q.type && !q.geoid) return
      setEditing(true)
      if (q.scope) update({ scope: q.scope })
      if (q.geoid) setSelected(q.geoid)
      const t = catalog ? matchType(q.type, catalog.map((x) => x.key)) : null
      if (t) {
        update({ types: [t] })
        setSuggested(t)
      }
      scroller.current?.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [catalog, update])

  // Follow the app-wide county picker while building.
  const placeSeen = useRef(place?.fips ?? 'nc')
  useEffect(() => {
    const f = place?.fips ?? 'nc'
    if (f === placeSeen.current) return
    placeSeen.current = f
    update({ scope: f })
    setEditing(true)
  }, [place, update])

  // ---------- scope names ----------
  const counties = useMemo(() => base?.access.counties ?? [], [base])
  const nameOf = useCallback((scope: string) => (scope === 'nc' ? 'North Carolina' : counties.find((c) => c.fips === scope)?.name ?? `County ${scope}`), [counties])

  const onScope = (scope: string) => {
    update({ scope })
    const c = counties.find((x) => x.fips === scope)
    setPlace(c ? { fips: c.fips, name: c.name } : null)
  }

  // Biggest gaps in the chosen area, averaged over residents.
  const topNeeds = useMemo(() => {
    if (!needs || !base) return null
    const sum: Record<string, number> = {}
    let w = 0
    for (const [g, n] of Object.entries(needs)) {
      if (!inScope(g, form.scope)) continue
      const pop = Math.max(1, Number(base.byId.get(g)?.pop ?? 1))
      w += pop
      for (const c of CATEGORIES) sum[c] = (sum[c] ?? 0) + (n.by?.[c] ?? 0) * pop
    }
    if (!w) return []
    return CATEGORIES.map((c) => ({ cat: c as Category, value: (sum[c] ?? 0) / w }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
  }, [needs, base, form.scope])

  // ---------- optimize ----------
  const run = async () => {
    if (!catalog) return
    setSolving(true)
    setSolveErr(null)
    const keys = new Set(catalog.map((t) => t.key))
    const custom = form.custom.filter((c) => c.include).map((c) => c.type)
    const scopeName = nameOf(form.scope)
    const name = form.name.trim() || `${scopeName} · ${fmtMoney(form.budget)}`
    try {
      const res = await api.optimize({
        scope: form.scope,
        budget: form.budget,
        volunteers: form.volunteers,
        types: form.types.filter((k) => keys.has(k)),
        custom: custom.length ? custom : undefined,
        max_per_type: form.maxPerType,
        name: form.name.trim() || undefined,
      })
      const kinds: Record<string, Kind> = {}
      const reach: Record<string, number> = {}
      for (const t of [...catalog, ...custom]) {
        kinds[t.key] = t.kind
        reach[t.key] = t.reach_mi
      }
      const id = res.scenario || `s-${Date.now()}`
      const sc: SavedScenario = {
        id,
        name: res.name || name,
        at: new Date().toISOString(),
        params: { scope: form.scope, scopeName, budget: form.budget, volunteers: form.volunteers, types: form.types, custom, maxPerType: form.maxPerType },
        kinds,
        reach,
        result: res,
      }
      setScenarios((prev) => {
        const next = [sc, ...prev.filter((p) => p.id !== id)]
        saveScenarios(next)
        return next
      })
      // Compare defaults to: this plan vs the one before it.
      const prevId = currentId ?? scenarios.find((s) => s.id !== id)?.id
      setPicked(prevId && prevId !== id ? [id, prevId] : [id])
      setCurrentId(id)
      setEditing(false)
      setHighlight(null)
      setCreateErr(null)
      update({ name: '' })
      // Show today first, then the plan, so the change is the first thing people notice.
      setShowAfter(false)
      window.setTimeout(() => setShowAfter(true), 1400)
      scroller.current?.scrollTo({ top: 0 })
      modelEvents.emit()
    } catch (e) {
      setSolveErr(errText(e))
    } finally {
      setSolving(false)
    }
  }

  const starter = (s: (typeof STARTERS)[number]) => {
    update({ scope: s.scope, budget: s.budget, volunteers: s.volunteers })
    const c = counties.find((x) => x.fips === s.scope)
    setPlace(c ? { fips: c.fips, name: c.name } : null)
  }

  // ---------- projects ----------
  const projectFor = useCallback(
    (item: PortfolioItem) => (current ? projects?.find((p) => p.scenario === current.result.scenario && p.geoid === item.geoid && p.type === item.type) : undefined),
    [projects, current],
  )
  const setOne = (set: Dispatch<SetStateAction<Set<string>>>, id: string, on: boolean) =>
    set((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  const upsertProject = (p: Project) => setProjects((list) => (list ? (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]) : [p]))

  const createOne = async (item: PortfolioItem) => {
    if (!current) return
    setOne(setCreating, item.id, true)
    setCreateErr(null)
    try {
      const p = await api.createProject(item, current.result.scenario)
      upsertProject(p)
      return p
    } catch (e) {
      setCreateErr(`Couldn't create the project: ${errText(e)}`)
    } finally {
      setOne(setCreating, item.id, false)
    }
  }
  const onCreate = async (item: PortfolioItem) => {
    if (await createOne(item)) modelEvents.emit()
  }
  const onCreateAll = async () => {
    if (!current) return
    const todo = current.result.portfolio.filter((i) => !projectFor(i))
    todo.forEach((i) => setOne(setCreating, i.id, true))
    let any = false
    for (const item of todo) if (await createOne(item)) any = true
    if (any) modelEvents.emit()
  }

  // ---------- saved plans ----------
  const openScenario = (id: string) => {
    setCurrentId(id)
    setEditing(false)
    setHighlight(null)
    setShowAfter(true)
    setSavedOpen(false)
    scroller.current?.scrollTo({ top: 0 })
  }
  const deleteScenario = (id: string) => {
    setScenarios((prev) => {
      const next = prev.filter((s) => s.id !== id)
      saveScenarios(next)
      return next
    })
    setPicked((p) => p.filter((x) => x !== id))
    if (currentId === id) {
      setCurrentId(null)
      setEditing(true)
    }
  }
  useEffect(() => {
    if (!savedOpen && !comparing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setComparing(false)
      setSavedOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [savedOpen, comparing])
  const pick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))
  const A = scenarios.find((s) => s.id === picked[0]) ?? null
  const B = scenarios.find((s) => s.id === picked[1]) ?? null

  // ---------- results map ----------
  const mapScope = current?.params.scope ?? form.scope
  const focus = useMemo<Focus>(() => {
    if (!current || !base) return { key: 'nc', bounds: NC_BOUNDS, padding: [20, 20] }
    const pts = current.result.portfolio.map((i) => [i.lat, i.lon] as [number, number])
    const b = current.params.scope === 'nc' && pts.length ? L.latLngBounds(pts).pad(0.25) : scopeBounds(base.tracts, current.params.scope) ?? NC_BOUNDS
    return { key: `res-${current.id}`, bounds: b, padding: [24, 24] }
  }, [current, base])

  const mapModel = useMemo(() => {
    const res = current ? current.result.tracts : null
    const today = (g: string): number | null => {
      if (res?.[g]) return res[g].before
      if (needs) return needs[g]?.need ?? null
      return base?.byId.get(g)?.hardship_pct ?? null
    }
    const vals: number[] = []
    if (base) for (const g of base.byId.keys()) if (inScope(g, mapScope)) {
      const v = today(g)
      if (v != null) vals.push(v)
    }
    return { res, today, scale: needScale(vals) }
  }, [current, needs, base, mapScope])

  const afterOn = showResults && showAfter
  const fill = useCallback(
    (p: TractProps): string | null => {
      if (!inScope(p.geoid, mapScope)) return null
      if (afterOn && mapModel.res?.[p.geoid]) return mapModel.scale.color(mapModel.res[p.geoid].after)
      const v = mapModel.today(p.geoid)
      if (v == null) return p.status === 'ok' ? NO_DATA : null
      return mapModel.scale.color(v)
    },
    [mapModel, afterOn, mapScope],
  )
  const tooltip = useCallback(
    (p: TractProps): string => {
      const head = `<div class="tt-title">${tractName(p.geoid)}</div><div class="tt-sub">${p.county}</div>`
      if (!inScope(p.geoid, mapScope)) return head + `<div class="tt-row"><span>Outside this plan's area</span></div>`
      const r = mapModel.res?.[p.geoid]
      if (r) {
        const changed = r.before - r.after >= 0.05
        return head + `<div class="tt-row"><span>Community need</span><b>${fmtNeed(r.before)}${changed ? ` → ${fmtNeed(r.after)}` : ''}</b></div>` + (changed ? `<div class="tt-row good"><span>With this plan</span><b>−${fmtNeed(r.before - r.after)}</b></div>` : '')
      }
      const v = mapModel.today(p.geoid)
      const n = needs?.[p.geoid]
      return head + `<div class="tt-row"><span>Community need</span><b>${v == null ? 'No data' : fmtNeed(v)}</b></div>` + (n ? `<div class="tt-row"><span>Biggest gap</span><b>${CATEGORY_LABEL[n.top]}</b></div>` : '')
    },
    [mapModel, needs, mapScope],
  )
  const onSelect = useCallback((g: string) => setSelected((s) => (s === g ? null : g)), [])

  const markers = useMemo<MapMarker[]>(() => {
    if (!current) return []
    const many = current.result.portfolio.length > 8 // too many rings at once hides the map; show only the selected one
    const seen = new Map<string, number>() // actions in the same neighborhood would stack; nudge repeats sideways
    return current.result.portfolio.map((it, i) => {
      const k = `${it.lat.toFixed(4)},${it.lon.toFixed(4)}`
      const n = seen.get(k) ?? 0
      seen.set(k, n + 1)
      const on = highlight === it.id
      const color = it.categories[0] ? CATEGORY_COLOR[it.categories[0]] : '#18191b'
      const size = on ? 34 : 26
      return {
        id: it.id,
        lat: it.lat,
        lon: it.lon + n * 0.012,
        color,
        size,
        html: `<div class="pl-pin ${on ? 'on' : ''}" style="width:${size}px;height:${size}px;background:${color}">${i + 1}</div>`,
        ringMi: !many || on ? current.reach[it.type] ?? catalog?.find((t) => t.key === it.type)?.reach_mi ?? 2 : undefined,
        tooltip: `<div class="tt-title">${i + 1}. ${it.label}</div><div class="tt-sub">${tractName(it.geoid)} · ${it.county}</div><div class="tt-row"><span>Cost</span><b>${fmtMoney(it.cost)}</b></div><div class="tt-row"><span>People reached</span><b>${fmtNum(it.people_reached)}</b></div>`,
        onClick: () => setHighlight((h) => (h === it.id ? null : it.id)),
      }
    })
  }, [current, highlight, catalog])

  if (!base) return <div className="pl pl-loading">Loading…</div>

  const mapNode = current && (
    <>
      <div className="pp-map-head">
        <div>
          <h3 className="pp-h">Where the plan's actions go</h3>
          <p className="pp-cap">Each numbered pin is one action; dashed rings show how far it reaches.</p>
        </div>
        {current.result.portfolio.length > 0 && (
          <div className="pp-ba">
            <button className={!showAfter ? 'on today' : ''} onClick={() => setShowAfter(false)}>Today</button>
            <button className={showAfter ? 'on after' : ''} onClick={() => setShowAfter(true)}>With this plan</button>
          </div>
        )}
      </div>
      <div className="pp-map">
        <MemoMap tracts={base.tracts} fill={fill} tooltip={tooltip} selected={selected} onSelect={onSelect} markers={markers} focus={focus} />
      </div>
      <div className="pp-legend">
        <span>Less need</span>
        <div className="pl-legend-bar">
          {mapModel.scale.bins.map((b) => (
            <span key={b.label} style={{ background: b.color }} title={b.label} />
          ))}
        </div>
        <span>More need</span>
      </div>
    </>
  )

  return (
    <div className="pl pp" ref={scroller}>
      <div className="pp-wrap">
        <header className="pp-head">
          <div>
            <h1>Plan services</h1>
            <p>Pick a place and a budget. We find the mix of services and locations that lowers community need the most.</p>
          </div>
          <button className="pp-saved-btn" onClick={() => setSavedOpen(true)}>
            Saved plans <i>{scenarios.length}</i>
          </button>
        </header>

        {showResults && current ? (
          <>
            <div className="pp-summary">
              <div>
                <span className="pp-summary-k">Your plan</span>
                <b>{current.params.scopeName} · {fmtMoney(current.params.budget)} · {fmtNum(current.params.volunteers)} volunteer hrs/mo</b>
              </div>
              <div className="pp-summary-actions">
                {scenarios.length > 1 && (
                  <button className="pl-btn small ghost" onClick={() => setSavedOpen(true)}>Compare with another plan</button>
                )}
                <button className="pl-btn small" onClick={() => setEditing(true)}>Edit</button>
              </div>
            </div>
            <Results
              sc={current}
              map={mapNode}
              highlight={highlight}
              onHighlight={setHighlight}
              projectFor={projectFor}
              creating={creating}
              onCreate={onCreate}
              onCreateAll={onCreateAll}
              createErr={createErr}
            />
          </>
        ) : (
          <>
            {!current && (
              <div className="pp-starters">
                <span>Try an example</span>
                {STARTERS.map((s) => (
                  <button
                    key={s.label}
                    className={form.scope === s.scope && form.budget === s.budget && form.volunteers === s.volunteers ? 'on' : ''}
                    onClick={() => starter(s)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <NewPlan
              form={form}
              update={update}
              onScope={onScope}
              catalog={catalog}
              catalogErr={catalogErr}
              counties={counties}
              scopeName={nameOf(form.scope)}
              topNeeds={topNeeds}
              solving={solving}
              solveErr={solveErr}
              onRun={run}
              suggested={suggested}
              onBack={current ? () => setEditing(false) : null}
            />
          </>
        )}
      </div>

      {savedOpen && (
        <SavedPlans
          scenarios={scenarios}
          picked={picked}
          currentId={showResults ? currentId : null}
          onPick={pick}
          onOpen={openScenario}
          onDelete={deleteScenario}
          onCompare={() => {
            setSavedOpen(false)
            setComparing(true)
          }}
          onClose={() => setSavedOpen(false)}
        />
      )}
      {comparing && A && B && <CompareModal A={A} B={B} onClose={() => setComparing(false)} />}
    </div>
  )
}
