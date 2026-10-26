import type { Project } from '../shared/api'
import { Dots } from './NewPlan'
import { fmtMoney, fmtNum, STATUSES, STATUS_LABEL } from './util'

type Props = {
  projects: Project[] | null
  selected: string | null
  busy: Set<string>
  onOpen: (id: string) => void
  onMove: (p: Project, to: Project['status']) => void
}

export function nextStatus(s: Project['status']): Project['status'] | null {
  const i = STATUSES.indexOf(s)
  return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null
}
export function prevStatus(s: Project['status']): Project['status'] | null {
  const i = STATUSES.indexOf(s)
  return i > 0 && s !== 'complete' ? STATUSES[i - 1] : null
}
export const MOVE_LABEL: Record<Project['status'], string> = {
  proposed: 'Propose',
  approved: 'Approve',
  in_progress: 'Start work',
  complete: 'Mark complete',
}

export default function Board(p: Props) {
  const list = p.projects ?? []
  return (
    <div className="pj-board">
      {STATUSES.map((s) => {
        const col = list.filter((x) => x.status === s)
        return (
          <section key={s} className={`pl-col st-${s}`}>
            <header>
              <span className={`pl-pill st-${s}`}>{STATUS_LABEL[s]}</span>
              <span className="pl-muted">{col.length}</span>
            </header>
            {col.length === 0 && <div className="pl-col-empty">Nothing here yet</div>}
            {col.map((x) => {
              const nx = nextStatus(x.status)
              const pv = prevStatus(x.status)
              const busy = p.busy.has(x.id)
              const slots = x.roles.reduce((a, r) => a + r.slots, 0)
              const filled = x.roles.reduce((a, r) => a + r.filled.length, 0)
              return (
                <article key={x.id} className={`pl-card ${p.selected === x.id ? 'on' : ''}`} onClick={() => p.onOpen(x.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && p.onOpen(x.id)}>
                  <b className="pl-card-title">{x.title.replace(/ — [^—]+ County$/, '')}</b>
                  <span className="pl-card-where">{x.county}</span>
                  <div className="pl-card-meta">
                    <span>{fmtMoney(x.budget)}</span>
                    <Dots cats={x.categories} />
                  </div>
                  <div className="pl-progress" title={`${Math.round(x.progress)}% done`}>
                    <i style={{ width: `${Math.max(0, Math.min(100, x.progress))}%` }} />
                  </div>
                  <div className="pj-card-foot">
                    <span>{Math.round(x.progress)}% done</span>
                    {slots > 0 && <span>{filled}/{slots} volunteers</span>}
                  </div>
                  <div className="pl-card-actions" onClick={(e) => e.stopPropagation()}>
                    {pv && <button disabled={busy} onClick={() => p.onMove(x, pv)} title={`Move back to ${STATUS_LABEL[pv]}`}>←</button>}
                    {nx && (
                      <button disabled={busy} className="fwd" onClick={() => p.onMove(x, nx)}>
                        {busy ? '…' : `${MOVE_LABEL[nx]} →`}
                      </button>
                    )}
                    {!nx && <span className="pl-done">✓ Done · {fmtNum(x.expected?.people_reached ?? 0)} people</span>}
                  </div>
                </article>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
