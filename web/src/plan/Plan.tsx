import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import type { TractProps } from '../metrics'
import { NO_DATA } from '../metrics'
import { useBaseData } from '../shared/baseData'
import { api, CATEGORY_COLOR, CATEGORY_LABEL, modelEvents, type InterventionType, type NeedSummary, type PortfolioItem, type Project } from '../shared/api'
import { tractName } from '../format'
import NewPlan, { type FormState } from './NewPlan'
import Results from './Results'
import Compare, { COMPARE_COLOR } from './Compare'
import Board from './Board'
import ProjectDrawer, { type Completion } from './ProjectDrawer'
import {
  errText,
  fmtMoney,
  fmtNeed,
  fmtNum,
  hashQuery,
  inScope,
  leaveRoomRight,
  loadScenarios,
  needScale,
  ringBounds,
  saveScenarios,
  scopeBounds,
  STATUS_LABEL,
  type Kind,
  type SavedScenario,
} from './util'
import './plan.css'

type Tab = 'new' | 'compare' | 'projects'
type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }

const MemoMap = memo(MapView)
const PANEL = 420
const DRAWER = 420
const wideWidth = () => Math.min(960, window.innerWidth - 480)

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

export default function Plan() {
  const base = useBaseData()
  const initial = useRef(readQuery())

  const [tab, setTab] = useState<Tab>('new')
  const [catalog, setCatalog] = useState<InterventionType[] | null>(null)
  const [catalogErr, setCatalogErr] = useState<string | null>(null)
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectsErr, setProjectsErr] = useState<string | null>(null)

  const [form, setForm] = useState<FormState>(() => ({
    scope: initial.current.scope ?? '063',
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
  const [cmpA, setCmpA] = useState<string | null>(null)
  const [cmpB, setCmpB] = useState<string | null>(null)

  const [projectId, setProjectId] = useState<string | null>(null)
  const [moving, setMoving] = useState<Set<string>>(new Set())
  const [completions, setCompletions] = useState<Record<string, Completion>>({})
  const [boardErr, setBoardErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(initial.current.geoid)
  const [focus, setFocus] = useState<Focus>({ key: 'init', bounds: NC_BOUNDS, padding: [PANEL + 40, 40] })

  const current = scenarios.find((s) => s.id === currentId) ?? null
  const showResults = tab === 'new' && !!current && !editing
  const drawerProject = tab === 'projects' && projectId ? projects?.find((p) => p.id === projectId) ?? null : null
  const panelWide = tab === 'projects' && !drawerProject

  const update = useCallback((patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch })), [])

  // ---------- data loading ----------
  const loadProjects = useCallback(() => {
    api
      .projects()
      .then((p) => {
        setProjects(p)
        setProjectsErr(null)
      })
      .catch((e) => setProjectsErr(errText(e)))
  }, [])
  const loadNeeds = useCallback(() => {
    api
      .needs()
      .then((n) => setNeeds(n.tracts))
      .catch(() => undefined)
  }, [])
  const loadCatalog = useCallback(() => {
    setCatalogErr(null)
    api
      .interventions()
      .then(setCatalog)
      .catch((e) => setCatalogErr(errText(e)))
  }, [])

  useEffect(() => {
    loadCatalog()
    loadProjects()
    loadNeeds()
    const off = modelEvents.subscribe(() => {
      loadProjects()
      loadNeeds()
    })
    return off
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
      setTab('new')
      setEditing(true)
      if (q.scope) update({ scope: q.scope })
      if (q.geoid) setSelected(q.geoid)
      const t = catalog ? matchType(q.type, catalog.map((x) => x.key)) : null
      if (t) {
        update({ types: [t] })
        setSuggested(t)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [catalog, update])

  // ---------- map focus ----------
  const padX = (wide = false) => (wide ? wideWidth() : PANEL) + 48
  const focusScope = useCallback(
    (scope: string, wide = false) => {
      if (!base) return
      const b = scopeBounds(base.tracts, scope)
      setFocus({ key: `scope-${scope}-${Date.now()}`, bounds: b ?? NC_BOUNDS, padding: [(wide ? wideWidth() : PANEL) + 48, 40] })
    },
    [base],
  )
  const focusPoint = (lat: number, lon: number, mi: number, drawer: boolean) => {
    let b = ringBounds(lat, lon, Math.max(1.5, mi * 1.6))
    if (drawer) {
      const free = window.innerWidth - padX() - 30 - DRAWER
      b = leaveRoomRight(b, free > 120 ? (DRAWER + 16) / free : 1.2)
    }
    setFocus({ key: `pt-${lat}-${lon}-${Date.now()}`, bounds: b, padding: [padX(), 40] })
  }

  // Follow the area picker while building a plan.
  const shownScope = showResults && current ? current.params.scope : form.scope
  useEffect(() => {
    if (tab === 'new') focusScope(shownScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownScope, tab, base])

  // ---------- scope names ----------
  const counties = useMemo(() => base?.access.counties ?? [], [base])
  const nameOf = useCallback((scope: string) => (scope === 'nc' ? 'North Carolina' : counties.find((c) => c.fips === scope)?.name ?? `County ${scope}`), [counties])

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
      setCurrentId(id)
      setEditing(false)
      setHighlight(null)
      setCreateErr(null)
      // Compare tab defaults to: this plan (A) vs the one before it (B).
      setCmpA(id)
      setCmpB(scenarios.find((s) => s.id !== id)?.id ?? null)
      update({ name: '' })
      // Show today first, then the plan, so the change is the first thing people notice.
      setShowAfter(false)
      window.setTimeout(() => setShowAfter(true), 1400)
      if (res.portfolio.length && form.scope === 'nc') {
        const b = L.latLngBounds(res.portfolio.map((i) => [i.lat, i.lon] as [number, number])).pad(0.3)
        setFocus({ key: `res-${id}-${Date.now()}`, bounds: b, padding: [padX(), 40] })
      } else focusScope(form.scope)
      modelEvents.emit()
    } catch (e) {
      setSolveErr(errText(e))
    } finally {
      setSolving(false)
    }
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
  const upsertProject = useCallback((p: Project) => setProjects((list) => (list ? (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]) : [p])), [])

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

  const openProject = (id: string) => {
    setTab('projects')
    setProjectId(id)
    const p = projects?.find((x) => x.id === id)
    if (p) focusPoint(p.lat, p.lon, catalogReach(p.type), true)
  }
  const catalogReach = (type: string) => catalog?.find((t) => t.key === type)?.reach_mi ?? current?.reach[type] ?? 2

  const onUpdateProject = (p: Project) => {
    upsertProject(p)
    modelEvents.emit()
  }

  const onMove = async (p: Project, to: Project['status']) => {
    setOne(setMoving, p.id, true)
    setBoardErr(null)
    try {
      if (to === 'complete') {
        const r = await api.complete(p.id)
        upsertProject(r.project)
        setCompletions((c) => ({ ...c, [p.id]: r }))
        setProjectId(p.id)
        focusPoint(p.lat, p.lon, catalogReach(p.type), true)
      } else {
        upsertProject(await api.updateProject(p.id, { status: to }))
      }
      modelEvents.emit()
    } catch (e) {
      setBoardErr(`Couldn't move “${p.title}”: ${errText(e)}`)
    } finally {
      setOne(setMoving, p.id, false)
    }
  }

  // ---------- tabs ----------
  const switchTab = (t: Tab) => {
    setTab(t)
    if (t === 'projects') {
      setProjectId(null)
      const list = projects ?? []
      if (list.length) {
        const b = L.latLngBounds(list.map((p) => [p.lat, p.lon] as [number, number])).pad(0.25)
        setFocus({ key: `proj-${Date.now()}`, bounds: b, padding: [wideWidth() + 48, 40] })
      } else focusScope('nc', true)
    }
    if (t === 'compare') {
      if (!cmpA && scenarios[0]) setCmpA(scenarios[0].id)
      if (!cmpB && scenarios[1]) setCmpB(scenarios[1].id)
    }
  }

  const A = scenarios.find((s) => s.id === cmpA) ?? null
  const B = scenarios.find((s) => s.id === cmpB) ?? null
  useEffect(() => {
    if (tab !== 'compare') return
    const pts = [...(A?.result.portfolio ?? []), ...(B?.result.portfolio ?? [])].map((i) => [i.lat, i.lon] as [number, number])
    if (pts.length) setFocus({ key: `cmp-${A?.id}-${B?.id}`, bounds: L.latLngBounds(pts).pad(0.25), padding: [PANEL + 48, 40] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, A?.id, B?.id])

  // ---------- map model ----------
  const mapModel = useMemo(() => {
    const scopes: string[] =
      tab === 'projects' ? ['nc'] : tab === 'compare' ? ([A?.params.scope, B?.params.scope].filter(Boolean) as string[]) : [shownScope]
    if (!scopes.length) scopes.push('nc')
    const res = showResults ? current!.result.tracts : null
    const today = (g: string): number | null => {
      if (res?.[g]) return res[g].before
      if (needs) return needs[g]?.need ?? null
      const h = base?.byId.get(g)?.hardship_pct
      return h ?? null
    }
    const inAny = (g: string) => scopes.some((s) => inScope(g, s))
    const vals: number[] = []
    if (base) for (const g of base.byId.keys()) if (inAny(g)) {
      const v = today(g)
      if (v != null) vals.push(v)
    }
    return { scopes, res, today, inAny, scale: needScale(vals), fallback: !needs && !res }
  }, [tab, A?.params.scope, B?.params.scope, shownScope, showResults, current, needs, base])

  const afterOn = showResults && showAfter
  const fill = useCallback(
    (p: TractProps): string | null => {
      if (!mapModel.inAny(p.geoid)) return null
      if (afterOn && mapModel.res?.[p.geoid]) return mapModel.scale.color(mapModel.res[p.geoid].after)
      const v = mapModel.today(p.geoid)
      if (v == null) return p.status === 'ok' ? NO_DATA : null
      return mapModel.scale.color(v)
    },
    [mapModel, afterOn],
  )
  const tooltip = useCallback(
    (p: TractProps): string => {
      const head = `<div class="tt-title">${tractName(p.geoid)}</div><div class="tt-sub">${p.county}</div>`
      if (!mapModel.inAny(p.geoid)) return head + `<div class="tt-row"><span>Outside this plan's area</span></div>`
      const r = mapModel.res?.[p.geoid]
      const label = mapModel.fallback ? 'Hardship score' : 'Community need'
      if (r) {
        const changed = r.before - r.after >= 0.05
        return head + `<div class="tt-row"><span>${label}</span><b>${fmtNeed(r.before)}${changed ? ` → ${fmtNeed(r.after)}` : ''}</b></div>` + (changed ? `<div class="tt-row good"><span>With this plan</span><b>−${fmtNeed(r.before - r.after)}</b></div>` : '')
      }
      const v = mapModel.today(p.geoid)
      const n = needs?.[p.geoid]
      return (
        head +
        `<div class="tt-row"><span>${label}</span><b>${v == null ? 'No data' : fmtNeed(v)}</b></div>` +
        (n ? `<div class="tt-row"><span>Biggest gap</span><b>${CATEGORY_LABEL[n.top]}</b></div>` : '')
      )
    },
    [mapModel, needs],
  )
  const onSelect = useCallback((g: string) => setSelected((s) => (s === g ? null : g)), [])

  const markers = useMemo<MapMarker[]>(() => {
    if (tab === 'new' && showResults && current) {
      const many = current.result.portfolio.length > 8 // too many rings at once hides the map; show only the selected one
      return current.result.portfolio.map((it, i) => {
        const on = highlight === it.id
        const color = it.categories[0] ? CATEGORY_COLOR[it.categories[0]] : '#18191b'
        const size = on ? 34 : 26
        return {
          id: it.id,
          lat: it.lat,
          lon: it.lon,
          color,
          size,
          html: `<div class="pl-pin ${on ? 'on' : ''}" style="width:${size}px;height:${size}px;background:${color}">${i + 1}</div>`,
          ringMi: !many || on ? current.reach[it.type] ?? catalog?.find((t) => t.key === it.type)?.reach_mi ?? 2 : undefined,
          tooltip: `<div class="tt-title">${i + 1}. ${it.label}</div><div class="tt-sub">${tractName(it.geoid)} · ${it.county}</div><div class="tt-row"><span>Cost</span><b>${fmtMoney(it.cost)}</b></div><div class="tt-row"><span>People reached</span><b>${fmtNum(it.people_reached)}</b></div>`,
          onClick: () => setHighlight((h) => (h === it.id ? null : it.id)),
        }
      })
    }
    if (tab === 'compare') {
      const out: MapMarker[] = []
      for (const [tag, s] of [['A', A], ['B', B]] as const) {
        if (!s || (tag === 'B' && A?.id === B?.id)) continue
        const color = tag === 'A' ? COMPARE_COLOR.a : COMPARE_COLOR.b
        s.result.portfolio.forEach((it) =>
          out.push({
            id: `${tag}-${it.id}`,
            lat: it.lat,
            lon: it.lon,
            color,
            size: 22,
            html: `<div class="pl-pin cmp" style="width:22px;height:22px;background:${color}">${tag}</div>`,
            tooltip: `<div class="tt-title">Plan ${tag}: ${it.label}</div><div class="tt-sub">${it.county}</div>`,
          }),
        )
      }
      return out
    }
    if (tab === 'projects' && projects) {
      return projects.map((p) => {
        const on = p.id === projectId
        const color = p.categories[0] ? CATEGORY_COLOR[p.categories[0]] : '#18191b'
        const size = on ? 30 : 18
        return {
          id: p.id,
          lat: p.lat,
          lon: p.lon,
          color,
          size,
          html: `<div class="pl-pin proj st-${p.status} ${on ? 'on' : ''}" style="width:${size}px;height:${size}px;background:${color}">${p.status === 'complete' ? '✓' : ''}</div>`,
          ringMi: on ? catalog?.find((t) => t.key === p.type)?.reach_mi ?? 2 : undefined,
          tooltip: `<div class="tt-title">${p.title}</div><div class="tt-sub">${p.county} · ${STATUS_LABEL[p.status]}</div>`,
          onClick: () => openProject(p.id),
        }
      })
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, showResults, current, highlight, A, B, projects, projectId, catalog])

  const onHighlight = (id: string | null) => {
    setHighlight(id)
    const it = current?.result.portfolio.find((x) => x.id === id)
    if (it) focusPoint(it.lat, it.lon, current?.reach[it.type] ?? 2, false)
  }

  const openScenario = (id: string) => {
    setCurrentId(id)
    setEditing(false)
    setHighlight(null)
    setShowAfter(true)
    setTab('new')
  }
  const deleteScenario = (id: string) => {
    setScenarios((prev) => {
      const next = prev.filter((s) => s.id !== id)
      saveScenarios(next)
      return next
    })
    if (currentId === id) {
      setCurrentId(null)
      setEditing(true)
    }
    if (cmpA === id) setCmpA(null)
    if (cmpB === id) setCmpB(null)
  }

  if (!base) return <div className="pl pl-loading">Loading the map of North Carolina…</div>

  const nProjects = projects?.length ?? 0
  const legendTitle = mapModel.fallback ? 'Economic hardship (server offline)' : showResults ? (afterOn ? 'Community need with this plan' : 'Community need today') : 'Community need today'

  return (
    <div className="pl">
      <div className="pl-map">
        <MemoMap tracts={base.tracts} fill={fill} tooltip={tooltip} selected={selected} onSelect={onSelect} markers={markers} focus={focus} />
      </div>

      <div className={`pl-panel ${panelWide ? 'wide' : ''}`} style={panelWide ? { width: wideWidth() } : undefined}>
        <nav className="pl-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => switchTab('new')}>
            New plan
          </button>
          <button role="tab" aria-selected={tab === 'compare'} className={tab === 'compare' ? 'on' : ''} onClick={() => switchTab('compare')}>
            Compare{scenarios.length > 0 && <i>{scenarios.length}</i>}
          </button>
          <button role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'on' : ''} onClick={() => switchTab('projects')}>
            Projects{nProjects > 0 && <i>{nProjects}</i>}
          </button>
        </nav>
        <div className="pl-body" key={tab}>
          {tab === 'new' &&
            (showResults && current ? (
              <Results
                sc={current}
                highlight={highlight}
                onHighlight={onHighlight}
                projectFor={projectFor}
                creating={creating}
                onCreate={onCreate}
                onCreateAll={onCreateAll}
                onOpenProject={openProject}
                onEdit={() => setEditing(true)}
                onOpenBoard={() => switchTab('projects')}
                onCompare={() => switchTab('compare')}
                canCompare={scenarios.length > 1}
                createErr={createErr}
              />
            ) : (
              <NewPlan
                form={form}
                update={update}
                catalog={catalog}
                catalogErr={catalogErr}
                counties={counties}
                scopeName={nameOf(form.scope)}
                solving={solving}
                solveErr={solveErr}
                onRun={run}
                suggested={suggested}
                onBack={current ? () => setEditing(false) : null}
              />
            ))}
          {tab === 'compare' && (
            <Compare scenarios={scenarios} a={cmpA} b={cmpB} setA={setCmpA} setB={setCmpB} onOpen={openScenario} onDelete={deleteScenario} onNew={() => { setTab('new'); setEditing(true) }} />
          )}
          {tab === 'projects' && (
            <>
              {boardErr && <div className="pl-error">{boardErr}</div>}
              <Board
                projects={projects}
                error={projectsErr}
                selected={projectId}
                busy={moving}
                compact={!panelWide}
                onOpen={openProject}
                onMove={onMove}
                onRetry={loadProjects}
              />
            </>
          )}
        </div>
      </div>

      {showResults && current && current.result.portfolio.length > 0 && (
        <div className="pl-ba" style={{ left: `calc(${PANEL + 16}px + (100% - ${PANEL + 16}px) / 2)` }}>
          <button className={!showAfter ? 'on today' : ''} onClick={() => setShowAfter(false)}>Today</button>
          <button className={showAfter ? 'on after' : ''} onClick={() => setShowAfter(true)}>With this plan</button>
        </div>
      )}

      {!drawerProject && (
        <div className="pl-legend" style={{ left: (panelWide ? wideWidth() : PANEL) + 32 }}>
          <b>{legendTitle}</b>
          <div className="pl-legend-bar">
            {mapModel.scale.bins.map((b) => (
              <span key={b.label} style={{ background: b.color }} title={b.label} />
            ))}
          </div>
          <div className="pl-legend-ends"><span>Less need</span><span>More need</span></div>
          {tab !== 'projects' && <p>Gray areas are outside the plan's area.</p>}
        </div>
      )}

      {drawerProject && (
        <ProjectDrawer
          key={drawerProject.id}
          project={drawerProject}
          completion={completions[drawerProject.id] ?? null}
          busy={moving.has(drawerProject.id)}
          onClose={() => setProjectId(null)}
          onUpdate={onUpdateProject}
          onMove={onMove}
        />
      )}
    </div>
  )
}
