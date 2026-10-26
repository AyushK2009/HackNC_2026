import type { ReactNode } from 'react'
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL } from '../shared/api'
import { fmtDateTime, fmtMoney, fmtNeed, fmtNum, KIND_ORDER, KIND_SHORT, type SavedScenario } from './util'

export const COMPARE_COLOR = { a: '#18191b', b: '#0f766e' }

type Props = {
  scenarios: SavedScenario[]
  a: string | null
  b: string | null
  setA: (id: string) => void
  setB: (id: string) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}

type Better = 'higher' | 'lower' | null

function stats(s: SavedScenario) {
  const t = s.result.totals
  const kinds: Record<string, number> = {}
  for (const it of s.result.portfolio) {
    const k = s.kinds[it.type] ?? (it.type.startsWith('custom') ? 'custom' : 'program')
    kinds[k] = (kinds[k] ?? 0) + 1
  }
  return {
    cost: t.cost,
    volunteers: t.volunteers,
    people: t.people_reached,
    // Compare where each plan actually works; fall back to the area-wide average for older saved plans.
    before: t.reached_before ?? t.need_before,
    after: t.reached_after ?? t.need_after,
    drop: (t.reached_before ?? t.need_before) - (t.reached_after ?? t.need_after),
    per10k: t.cost > 0 ? (t.people_reached / t.cost) * 10000 : 0,
    kinds,
    by: t.by_category,
  }
}

function winner(a: number, b: number, better: Better): 'a' | 'b' | null {
  if (!better || Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) return null
  return (better === 'higher' ? a > b : a < b) ? 'a' : 'b'
}

function Row({ label, hint, a, b, va, vb, better }: { label: string; hint?: string; a: ReactNode; b: ReactNode; va: number; vb: number; better: Better }) {
  const w = winner(va, vb, better)
  return (
    <div className="pl-cmp-row">
      <div className="pl-cmp-label">
        {label}
        {hint && <span>{hint}</span>}
      </div>
      <div className={`pl-cmp-cell ${w === 'a' ? 'win' : ''}`}>{a}{w === 'a' && <em>Better</em>}</div>
      <div className={`pl-cmp-cell ${w === 'b' ? 'win' : ''}`}>{b}{w === 'b' && <em>Better</em>}</div>
    </div>
  )
}

export default function Compare(p: Props) {
  const A = p.scenarios.find((s) => s.id === p.a) ?? null
  const B = p.scenarios.find((s) => s.id === p.b) ?? null

  return (
    <div className="pl-compare">
      <div className="pl-head">
        <p className="pl-kicker">Compare plans</p>
        <h2>Which plan does more?</h2>
        <p className="pl-lead">Every plan you run is saved here. Pick two to see them side by side.</p>
      </div>

      {p.scenarios.length === 0 && (
        <div className="pl-empty">
          No plans yet. Run one, then try a variation — a smaller budget, more volunteers, or only short-term actions.
          <button className="pl-btn" onClick={p.onNew}>Start a plan</button>
        </div>
      )}

      {p.scenarios.length > 0 && (
        <ul className="pl-saved">
          {p.scenarios.map((s) => (
            <li key={s.id} className={s.id === p.a ? 'is-a' : s.id === p.b ? 'is-b' : ''}>
              <div className="pl-saved-pick">
                <button className={s.id === p.a ? 'on a' : ''} onClick={() => p.setA(s.id)} title="Compare as plan A">A</button>
                <button className={s.id === p.b ? 'on b' : ''} onClick={() => p.setB(s.id)} title="Compare as plan B">B</button>
              </div>
              <div className="pl-saved-body">
                <b>{s.name}</b>
                <span>{s.params.scopeName} · {fmtMoney(s.params.budget)} · {fmtNum(s.result.totals.people_reached)} people · {fmtDateTime(s.at)}</span>
              </div>
              <div className="pl-saved-actions">
                <button onClick={() => p.onOpen(s.id)}>Open</button>
                <button className="pl-x" aria-label="Delete plan" onClick={() => p.onDelete(s.id)}>×</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {p.scenarios.length === 1 && <p className="pl-hint">Run one more plan to compare. Try changing the budget or turning off the lasting builds.</p>}

      {A && B && A.id !== B.id && <Table A={A} B={B} />}
      {A && B && A.id === B.id && <p className="pl-hint">Pick two different plans.</p>}
    </div>
  )
}

function Table({ A, B }: { A: SavedScenario; B: SavedScenario }) {
  const a = stats(A)
  const b = stats(B)
  const kindsText = (k: Record<string, number>) =>
    KIND_ORDER.filter((x) => k[x])
      .map((x) => `${k[x]} ${KIND_SHORT[x].toLowerCase()}`)
      .join(' · ') || 'None'
  const maxDrop = Math.max(0.1, ...CATEGORIES.flatMap((c) => [(a.by[c]?.before ?? 0) - (a.by[c]?.after ?? 0), (b.by[c]?.before ?? 0) - (b.by[c]?.after ?? 0)]))

  return (
    <div className="pl-cmp">
      <div className="pl-cmp-row head">
        <div />
        <div className="pl-cmp-cell"><i className="pl-tag" style={{ background: COMPARE_COLOR.a }}>A</i><b>{A.name}</b><span>{A.params.scopeName}</span></div>
        <div className="pl-cmp-cell"><i className="pl-tag" style={{ background: COMPARE_COLOR.b }}>B</i><b>{B.name}</b><span>{B.params.scopeName}</span></div>
      </div>
      <Row label="Cost" a={fmtMoney(a.cost)} b={fmtMoney(b.cost)} va={a.cost} vb={b.cost} better="lower" />
      <Row label="Volunteer hours" hint="per month" a={fmtNum(a.volunteers)} b={fmtNum(b.volunteers)} va={a.volunteers} vb={b.volunteers} better="lower" />
      <Row label="People reached" a={fmtNum(a.people)} b={fmtNum(b.people)} va={a.people} vb={b.people} better="higher" />
      <Row
        label="Community need"
        hint="today → after"
        a={<>{fmtNeed(a.before)} → <b>{fmtNeed(a.after)}</b></>}
        b={<>{fmtNeed(b.before)} → <b>{fmtNeed(b.after)}</b></>}
        va={a.drop}
        vb={b.drop}
        better="higher"
      />
      <Row label="People per $10k" hint="value for money" a={fmtNum(a.per10k)} b={fmtNum(b.per10k)} va={a.per10k} vb={b.per10k} better="higher" />
      <Row label="Actions" a={kindsText(a.kinds)} b={kindsText(b.kinds)} va={0} vb={0} better={null} />

      <h3 className="pl-h3">Need removed, by kind</h3>
      <ul className="pl-cmp-cats">
        {CATEGORIES.map((c) => {
          const da = (a.by[c]?.before ?? 0) - (a.by[c]?.after ?? 0)
          const db = (b.by[c]?.before ?? 0) - (b.by[c]?.after ?? 0)
          const w = winner(da, db, 'higher')
          return (
            <li key={c}>
              <span className="pl-cbar-label"><i style={{ background: CATEGORY_COLOR[c] }} />{CATEGORY_LABEL[c]}</span>
              <span className="pl-cmp-bars">
                <span className={w === 'a' ? 'win' : ''}><i style={{ width: `${(Math.max(0, da) / maxDrop) * 100}%`, background: COMPARE_COLOR.a }} /><b>−{fmtNeed(Math.max(0, da))}</b></span>
                <span className={w === 'b' ? 'win' : ''}><i style={{ width: `${(Math.max(0, db) / maxDrop) * 100}%`, background: COMPARE_COLOR.b }} /><b>−{fmtNeed(Math.max(0, db))}</b></span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="pl-hint">Points of need removed (0–100 scale, weighted by population). Longer bar is better.</p>
    </div>
  )
}
