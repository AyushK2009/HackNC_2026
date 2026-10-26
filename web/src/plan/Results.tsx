import { useEffect } from 'react'
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, type Category, type PortfolioItem, type Project } from '../shared/api'
import { tractName } from '../format'
import { fmtMoney, fmtNeed, fmtNum, type SavedScenario } from './util'

type Props = {
  sc: SavedScenario
  highlight: string | null
  onHighlight: (id: string | null) => void
  projectFor: (item: PortfolioItem) => Project | undefined
  creating: Set<string>
  onCreate: (item: PortfolioItem) => void
  onCreateAll: () => void
  onOpenProject: (id: string) => void
  onEdit: () => void
  onOpenBoard: () => void
  onCompare: () => void
  canCompare: boolean
  createErr: string | null
}

export function CategoryBars({ by }: { by: Record<Category, { before: number; after: number }> }) {
  const max = Math.max(10, ...CATEGORIES.map((c) => by[c]?.before ?? 0))
  const top = Math.min(100, Math.ceil(max / 10) * 10)
  return (
    <ul className="pl-cbars">
      {CATEGORIES.map((c) => {
        const v = by[c]
        if (!v) return null
        const drop = v.before - v.after
        return (
          <li key={c}>
            <span className="pl-cbar-label"><i style={{ background: CATEGORY_COLOR[c] }} />{CATEGORY_LABEL[c]}</span>
            <span className="pl-cbar-track" title={`${CATEGORY_LABEL[c]}: ${fmtNeed(v.before)} today → ${fmtNeed(v.after)} with this plan`}>
              <span className="pl-cbar-before" style={{ width: `${(v.before / top) * 100}%`, background: CATEGORY_COLOR[c] }} />
              <span className="pl-cbar-after" style={{ width: `${(v.after / top) * 100}%`, background: CATEGORY_COLOR[c] }} />
            </span>
            <span className="pl-cbar-val">
              {fmtNeed(v.before)} → <b>{fmtNeed(v.after)}</b>
              {drop >= 0.05 && <em>−{fmtNeed(drop)}</em>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function solverLine(s: SavedScenario['result']['solver']): string {
  const secs = s.time_ms / 1000
  const t = secs < 0.1 ? secs.toFixed(2) : secs.toFixed(1)
  const exact = /optimal/i.test(s.status)
  return `Tested ${fmtNum(s.candidates)} options with an exact integer program — ${exact ? 'solved' : 'best found'} in ${t} s.`
}

export default function Results(p: Props) {
  const { result, params } = p.sc
  const t = result.totals
  const drop = t.need_before - t.need_after
  const pending = result.portfolio.filter((i) => !p.projectFor(i))
  const busyAll = pending.length > 0 && pending.every((i) => p.creating.has(i.id))

  // Clicking a pin on the map brings its row into view.
  useEffect(() => {
    if (p.highlight) document.querySelector(`[data-item="${CSS.escape(p.highlight)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [p.highlight])

  return (
    <div className="pl-results">
      <div className="pl-query">
        <div>
          <b>{result.name || p.sc.name}</b>
          <span>{params.scopeName} · {fmtMoney(params.budget)} · {fmtNum(params.volunteers)} volunteer hrs/mo</span>
        </div>
        <button onClick={p.onEdit}>Change</button>
      </div>

      <div className="pl-tiles">
        <div className="pl-tile">
          <span>Budget used</span>
          <b>{fmtMoney(t.cost)}</b>
          <em>of {fmtMoney(params.budget)}</em>
          <i className="pl-meter"><i style={{ width: `${Math.min(100, (t.cost / Math.max(1, params.budget)) * 100)}%` }} /></i>
        </div>
        <div className="pl-tile">
          <span>Volunteer hours</span>
          <b>{fmtNum(t.volunteers)}<small> /mo</small></b>
          <em>of {fmtNum(params.volunteers)} available</em>
          <i className="pl-meter"><i style={{ width: `${params.volunteers ? Math.min(100, (t.volunteers / params.volunteers) * 100) : 0}%` }} /></i>
        </div>
        <div className="pl-tile">
          <span>People reached</span>
          <b>{fmtNum(t.people_reached)}</b>
          <em>live where the plan helps</em>
        </div>
        <div className="pl-tile good">
          {t.reached_before != null && t.reached_after != null ? (
            <>
              <span>Need where the plan reaches</span>
              <b>{fmtNeed(t.reached_before)} → {fmtNeed(t.reached_after)}</b>
              <em>across {fmtNum(t.neighborhoods_improved ?? 0)} neighborhoods · county {fmtNeed(t.need_before)} → {fmtNeed(t.need_after)}</em>
            </>
          ) : (
            <>
              <span>Community need</span>
              <b>{fmtNeed(t.need_before)} → {fmtNeed(t.need_after)}</b>
              <em>{drop > 0 ? `−${fmtNeed(drop)} points, weighted by population` : 'weighted by population'}</em>
            </>
          )}
        </div>
      </div>

      {t.cost < params.budget * 0.8 && params.volunteers > 0 && t.volunteers >= params.volunteers * 0.9 && (
        <p className="pl-insight">Volunteer time ran out before the money did. Add volunteer hours to put more of the budget to work.</p>
      )}
      {t.cost < params.budget * 0.8 && t.volunteers < params.volunteers * 0.9 && result.portfolio.length > 0 && (
        <p className="pl-insight">Not every dollar was needed: more spending here would add little. Try a wider area or allow more of each option.</p>
      )}

      <h3 className="pl-h3">Need by kind, today → with this plan</h3>
      <CategoryBars by={t.by_category} />

      <p className="pl-solver">
        <span aria-hidden>∑</span>
        {solverLine(result.solver)}
      </p>

      <div className="pl-list-head">
        <h3 className="pl-h3">The plan · {result.portfolio.length} action{result.portfolio.length === 1 ? '' : 's'}</h3>
        {pending.length > 0 && (
          <button className="pl-btn small" disabled={busyAll} onClick={p.onCreateAll}>
            {busyAll ? 'Creating…' : `Make all ${pending.length} projects`}
          </button>
        )}
      </div>
      {p.createErr && <div className="pl-error">{p.createErr}</div>}
      {result.portfolio.length === 0 && (
        <div className="pl-empty">Nothing fits within this budget and volunteer time. Try a larger budget or turn on lower-cost options like events and programs.</div>
      )}
      <ol className="pl-items">
        {result.portfolio.map((item, i) => {
          const proj = p.projectFor(item)
          const on = p.highlight === item.id
          const c = item.categories[0]
          return (
            <li key={item.id} data-item={item.id} className={on ? 'on' : ''} onClick={() => p.onHighlight(on ? null : item.id)}>
              <span className="pl-num" style={{ background: c ? CATEGORY_COLOR[c] : '#18191b' }}>{i + 1}</span>
              <div className="pl-item-body">
                <b>{item.label}</b>
                <span className="pl-item-where">{tractName(item.geoid)} · {item.county}</span>
                <span className="pl-item-stats">
                  <span><b>{fmtMoney(item.cost)}</b> cost</span>
                  <span><b>{fmtNum(item.people_reached)}</b> people</span>
                  {item.volunteers > 0 && <span><b>{fmtNum(item.volunteers)}</b> hrs/mo</span>}
                </span>
                {item.why && <p className="pl-why">{item.why}</p>}
                <div className="pl-item-actions" onClick={(e) => e.stopPropagation()}>
                  {proj ? (
                    <button className="pl-btn small done" onClick={() => p.onOpenProject(proj.id)}>✓ Project created · Open</button>
                  ) : (
                    <button className="pl-btn small" disabled={p.creating.has(item.id)} onClick={() => p.onCreate(item)}>
                      {p.creating.has(item.id) ? 'Creating…' : 'Make it a project'}
                    </button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="pl-next">
        {result.portfolio.length > 0 && pending.length === 0 && (
          <button className="pl-btn" onClick={p.onOpenBoard}>Open the project board →</button>
        )}
        <div>
          <button className="pl-btn ghost small" onClick={p.onEdit}>Try a variation</button>
          {p.canCompare && <button className="pl-btn ghost small" onClick={p.onCompare}>Compare plans</button>}
        </div>
      </div>
    </div>
  )
}
