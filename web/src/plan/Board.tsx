import type { Project } from '../shared/api'
import { Dots } from './NewPlan'
import { fmtMoney, fmtNum, STATUSES, STATUS_LABEL } from './util'

type Props = {
  projects: Project[] | null
  error: string | null
  selected: string | null
  busy: Set<string>
  compact: boolean
  onOpen: (id: string) => void
  onMove: (p: Project, to: Project['status']) => void
  onRetry: () => void
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
  const total = list.reduce((s, x) => s + x.budget, 0)
  const people = list.reduce((s, x) => s + (x.expected?.people_reached ?? 0), 0)

  return (
    <div className="pl-boardwrap">
      <div className="pl-head">
        <p className="pl-kicker">Projects</p>
        <h2>From plan to finished work</h2>
        <p className="pl-lead">
          {list.length
            ? `${list.length} project${list.length === 1 ? '' : 's'} · ${fmtMoney(total)} budgeted · ${fmtNum(people)} people expected to be reached. Finishing a project lowers need on the shared map.`
            : 'Turn any action from a plan into a project, then track it here until it’s done.'}
        </p>
      </div>
      {p.error && (
        <div className="pl-error">
          Couldn't load projects: {p.error} <button className="pl-linkbtn" onClick={p.onRetry}>Try again</button>
        </div>
      )}
      {!p.projects && !p.error && <div className="pl-skel" />}
      <div className={`pl-board ${p.compact ? 'compact' : ''}`}>
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
                return (
                  <article key={x.id} className={`pl-card ${p.selected === x.id ? 'on' : ''}`} onClick={() => p.onOpen(x.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && p.onOpen(x.id)}>
                    <b className="pl-card-title">{x.title}</b>
                    <span className="pl-card-where">{x.county}</span>
                    <div className="pl-card-meta">
                      <span>{fmtMoney(x.budget)}</span>
                      <Dots cats={x.categories} />
                    </div>
                    <div className="pl-progress" title={`${Math.round(x.progress)}% done`}>
                      <i style={{ width: `${Math.max(0, Math.min(100, x.progress))}%` }} />
                    </div>
                    <div className="pl-card-actions" onClick={(e) => e.stopPropagation()}>
                      {pv && <button disabled={busy} onClick={() => p.onMove(x, pv)} title={`Move back to ${STATUS_LABEL[pv]}`}>←</button>}
                      {nx && (
                        <button disabled={busy} className="fwd" onClick={() => p.onMove(x, nx)}>
                          {busy ? '…' : `${MOVE_LABEL[nx]} →`}
                        </button>
                      )}
                      {!nx && <span className="pl-done">✓ Done</span>}
                    </div>
                  </article>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
