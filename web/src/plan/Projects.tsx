import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import Combobox from '../shared/Combobox'
import { api, modelEvents, type Project } from '../shared/api'
import Board from './Board'
import ProjectDrawer, { type Completion } from './ProjectDrawer'
import { errText, fmtMoney, fmtNum, hashQuery } from './util'
import './plan.css'

const idFromHash = () => (window.location.hash.startsWith('#/projects') ? hashQuery().get('id') : null)

export default function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [boardErr, setBoardErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(idFromHash)
  const [moving, setMoving] = useState<Set<string>>(new Set())
  const [completions, setCompletions] = useState<Record<string, Completion>>({})
  const [county, setCounty] = useState('all')

  const load = useCallback(() => {
    api
      .projects()
      .then((p) => {
        setProjects(p)
        setErr(null)
      })
      .catch((e) => setErr(errText(e)))
  }, [])
  useEffect(() => {
    load()
    return modelEvents.subscribe(load)
  }, [load])

  // #/projects?id=… from other pages, also while this page is open.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.startsWith('#/projects')) setOpenId(idFromHash())
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const open = (id: string | null) => {
    setOpenId(id)
    try {
      window.history.replaceState(null, '', id ? `#/projects?id=${encodeURIComponent(id)}` : '#/projects')
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const setOne = (set: Dispatch<SetStateAction<Set<string>>>, id: string, on: boolean) =>
    set((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  const upsert = (p: Project) => setProjects((list) => (list ? (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]) : [p]))

  const onMove = async (p: Project, to: Project['status']) => {
    setOne(setMoving, p.id, true)
    setBoardErr(null)
    try {
      if (to === 'complete') {
        const r = await api.complete(p.id)
        upsert(r.project)
        setCompletions((c) => ({ ...c, [p.id]: r }))
        open(p.id)
      } else {
        upsert(await api.updateProject(p.id, { status: to }))
      }
      modelEvents.emit()
    } catch (e) {
      setBoardErr(`Couldn't move “${p.title}”: ${errText(e)}`)
    } finally {
      setOne(setMoving, p.id, false)
    }
  }
  const onUpdate = (p: Project) => {
    upsert(p)
    modelEvents.emit()
  }

  const all = useMemo(() => projects ?? [], [projects])
  const options = useMemo(() => {
    const by = new Map<string, { name: string; n: number }>()
    for (const p of all) {
      const f = p.geoid.slice(2, 5)
      const e = by.get(f) ?? { name: p.county, n: 0 }
      e.n++
      by.set(f, e)
    }
    return [
      { value: 'all', label: 'All counties', hint: `${all.length}` },
      ...[...by.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([f, e]) => ({ value: f, label: e.name, hint: `${e.n}` })),
    ]
  }, [all])
  const shown = county === 'all' ? all : all.filter((p) => p.geoid.slice(2, 5) === county)

  const active = shown.filter((p) => p.status !== 'complete')
  const done = shown.filter((p) => p.status === 'complete')
  const people = active.reduce((s, p) => s + (p.expected?.people_reached ?? 0), 0)
  const openRoles = active.reduce((s, p) => s + p.roles.reduce((a, r) => a + Math.max(0, r.slots - r.filled.length), 0), 0)
  const budget = active.reduce((s, p) => s + p.budget, 0)
  const drawer = openId ? all.find((p) => p.id === openId) ?? null : null

  return (
    <div className="pl pp">
      <div className="pp-wrap wide">
        <header className="pp-head">
          <div>
            <h1>Projects</h1>
            <p>Every action you approve from a plan, from proposal to finished work.</p>
          </div>
          <div className="pj-head-right">
            {all.length > 0 && <Combobox options={options} value={county} onChange={setCounty} label="County" placeholder="All counties" />}
            <a className="pl-btn ghost" href="#/plan">+ New plan</a>
          </div>
        </header>

        {err && (
          <div className="pl-error">
            Couldn't load projects: {err} <button className="pl-linkbtn" onClick={load}>Try again</button>
          </div>
        )}
        {!projects && !err && <div className="pl-skel" />}

        {projects && all.length === 0 && (
          <div className="pj-empty">
            <h2>No projects yet</h2>
            <p>Projects start from a plan. Build one, then turn its actions into projects to approve, staff and track here.</p>
            <a className="pl-run" href="#/plan">Build a plan</a>
            <span>When a project is marked complete, need goes down on the Needs map for everyone.</span>
          </div>
        )}

        {all.length > 0 && (
          <>
            <div className="pj-strip">
              <div><span>Active projects</span><b>{fmtNum(active.length)}</b><em>{fmtMoney(budget)} budgeted</em></div>
              <div><span>People expected to reach</span><b>{fmtNum(people)}</b><em>across active projects</em></div>
              <div><span>Open volunteer roles</span><b>{fmtNum(openRoles)}</b><em>{openRoles ? 'staff them from a project' : 'every role is filled'}</em></div>
              <div className="good"><span>Finished</span><b>{fmtNum(done.length)}</b><em>{done.length ? 'need already lowered on the map' : 'finish one to lower need'}</em></div>
            </div>
            {boardErr && <div className="pl-error">{boardErr}</div>}
            <Board projects={shown} selected={openId} busy={moving} onOpen={(id) => open(id)} onMove={onMove} />
          </>
        )}
      </div>

      {drawer && (
        <div className="pp-overlay" onMouseDown={(e) => e.target === e.currentTarget && open(null)}>
          <ProjectDrawer
            key={drawer.id}
            project={drawer}
            completion={completions[drawer.id] ?? null}
            busy={moving.has(drawer.id)}
            onClose={() => open(null)}
            onUpdate={onUpdate}
            onMove={onMove}
          />
        </div>
      )}
    </div>
  )
}
