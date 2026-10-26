import { useState } from 'react'
import { api, CATEGORY_COLOR, CATEGORY_LABEL, type Category, type Project } from '../shared/api'
import { tractName } from '../format'
import Markdown from './Markdown'
import { MOVE_LABEL, nextStatus, prevStatus } from './Board'
import { CatChips } from './NewPlan'
import { errText, fmtDate, fmtDateTime, fmtMoney, fmtNeed, fmtNum, STATUS_LABEL, sumReduction } from './util'

export type Completion = Awaited<ReturnType<typeof api.complete>>
type Staffing = Awaited<ReturnType<typeof api.staff>>

type Props = {
  project: Project
  completion: Completion | null
  busy: boolean
  onClose: () => void
  onUpdate: (p: Project) => void
  onMove: (p: Project, to: Project['status']) => void
}

function Ring({ value }: { value: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value))
  return (
    <svg className="pl-ring" width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={`${Math.round(v)}% done`}>
      <circle cx="34" cy="34" r={r} fill="none" stroke="#ecebe7" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--good)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 34 34)" />
      <text x="34" y="38" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--ink)">{Math.round(v)}%</text>
    </svg>
  )
}

function Timeline({ p }: { p: Project }) {
  const ms = [...p.milestones].filter((m) => !Number.isNaN(new Date(m.due).getTime())).sort((a, b) => +new Date(a.due) - +new Date(b.due))
  if (!ms.length) return null
  const start = Math.min(+new Date(p.created_at) || Date.now(), +new Date(ms[0].due))
  const end = Math.max(+new Date(ms[ms.length - 1].due), start + 86400000)
  const pos = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100))}%`
  const now = Date.now()
  return (
    <div className="pl-gantt" aria-hidden>
      <div className="pl-gantt-track">
        {ms.map((m, i) => {
          const from = i === 0 ? start : +new Date(ms[i - 1].due)
          const to = +new Date(m.due)
          return (
            <span
              key={m.id}
              className={`pl-gantt-seg ${m.done ? 'done' : ''}`}
              style={{ left: pos(from), width: `calc(${pos(to)} - ${pos(from)})` }}
              title={`${m.title} · due ${fmtDate(m.due)}`}
            />
          )
        })}
        {ms.map((m) => (
          <i key={m.id} className={`pl-gantt-dot ${m.done ? 'done' : ''}`} style={{ left: pos(+new Date(m.due)) }} title={`${m.title} · due ${fmtDate(m.due)}`} />
        ))}
        {now > start && now < end && <b className="pl-gantt-now" style={{ left: pos(now) }} title="Today" />}
      </div>
      <div className="pl-gantt-ends">
        <span>{fmtDate(new Date(start).toISOString())}</span>
        <span>{fmtDate(new Date(end).toISOString())}</span>
      </div>
    </div>
  )
}

export default function ProjectDrawer({ project: p, completion, busy, onClose, onUpdate, onMove }: Props) {
  const [staffing, setStaffing] = useState<Staffing | null>(null)
  const [staffBusy, setStaffBusy] = useState(false)
  const [briefBusy, setBriefBusy] = useState(false)
  const [note, setNote] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [msBusy, setMsBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = async <T,>(fn: () => Promise<T>, done: (v: T) => void, setBusy: (b: boolean) => void) => {
    setBusy(true)
    setErr(null)
    try {
      done(await fn())
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleMs = (id: string, done: boolean) => {
    setMsBusy(id)
    setErr(null)
    api
      .updateProject(p.id, { milestone_id: id, done })
      .then(onUpdate)
      .catch((e) => setErr(errText(e)))
      .finally(() => setMsBusy(null))
  }

  const nx = nextStatus(p.status)
  const pv = prevStatus(p.status)
  const reduction = Object.entries(p.expected?.need_reduction ?? {}).filter(([, v]) => (v ?? 0) > 0) as [Category, number][]
  const slots = p.roles.reduce((s, r) => s + r.slots, 0)
  const filled = p.roles.reduce((s, r) => s + r.filled.length, 0)
  const doneMs = p.milestones.filter((m) => m.done).length

  return (
    <aside className="pl-drawer" aria-label="Project details">
      <header className="pl-dr-head">
        <div>
          <p className="pl-kicker">{p.label}</p>
          <h2>{p.title}</h2>
          <span className="pl-dr-where">{tractName(p.geoid)} · {p.county}</span>
        </div>
        <button className="pl-x big" aria-label="Close" onClick={onClose}>×</button>
      </header>

      <div className="pl-dr-top">
        <Ring value={p.progress} />
        <div className="pl-dr-stats">
          <div><span>Status</span><b><span className={`pl-pill st-${p.status}`}>{STATUS_LABEL[p.status]}</span></b></div>
          <div><span>Budget</span><b>{fmtMoney(p.budget)}</b></div>
          <div><span>People reached</span><b>{fmtNum(p.expected?.people_reached ?? 0)}</b></div>
          <div><span>Need reduction</span><b>−{fmtNeed(sumReduction(p.expected?.need_reduction ?? {}))} pts</b></div>
        </div>
      </div>
      <CatChips cats={p.categories} />
      {reduction.length > 1 && (
        <p className="pl-hint">
          Expected:{' '}
          {reduction.map(([c, v], i) => (
            <span key={c}>{i > 0 && ' · '}{CATEGORY_LABEL[c]} −{fmtNeed(v)}</span>
          ))}
        </p>
      )}

      <div className="pl-dr-actions">
        {pv && <button className="pl-btn ghost small" disabled={busy} onClick={() => onMove(p, pv)}>← {STATUS_LABEL[pv]}</button>}
        {nx && (
          <button className={`pl-btn small ${nx === 'complete' ? 'good' : ''}`} disabled={busy} onClick={() => onMove(p, nx)}>
            {busy ? 'Saving…' : nx === 'complete' ? 'Mark complete' : `${MOVE_LABEL[nx]} →`}
          </button>
        )}
      </div>
      {err && <div className="pl-error">{err}</div>}

      {completion && (
        <div className="pl-complete">
          <b>Need in the neighborhoods it reaches fell from {fmtNeed(completion.need_before)} to {fmtNeed(completion.need_after)}.</b>
          <span>The shared map has been updated for everyone.</span>
          {completion.changes.length > 0 && (
            <ul>
              {completion.changes.slice(0, 8).map((c, i) => (
                <li key={`${c.geoid}-${c.category}-${i}`}>
                  <i style={{ background: CATEGORY_COLOR[c.category] }} />
                  <span>{tractName(c.geoid)} · {c.county} · {CATEGORY_LABEL[c.category]}</span>
                  <b>{fmtNeed(c.before)} → {fmtNeed(c.after)}</b>
                </li>
              ))}
              {completion.changes.length > 8 && <li className="more">+ {completion.changes.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}

      <section className="pl-dr-sec">
        <h3 className="pl-h3">Milestones · {doneMs} of {p.milestones.length} done</h3>
        <Timeline p={p} />
        <ul className="pl-ms">
          {p.milestones.map((m) => (
            <li key={m.id} className={m.done ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={m.done} disabled={msBusy === m.id || p.status === 'complete'} onChange={(e) => toggleMs(m.id, e.target.checked)} />
                <span>{m.title}</span>
              </label>
              <em>{fmtDate(m.due)}</em>
            </li>
          ))}
          {!p.milestones.length && <li className="pl-muted">No milestones.</li>}
        </ul>
      </section>

      <section className="pl-dr-sec">
        <h3 className="pl-h3">Volunteers · {filled} of {slots} spots filled</h3>
        <ul className="pl-roles">
          {p.roles.map((r) => (
            <li key={r.id}>
              <div>
                <b>{r.title}</b>
                {r.skills.length > 0 && <span>{r.skills.join(', ')}</span>}
              </div>
              <span className="pl-slots">
                {Array.from({ length: r.slots }, (_, i) => (
                  <i key={i} className={i < r.filled.length ? 'on' : ''} />
                ))}
                <em>{r.filled.length}/{r.slots}</em>
              </span>
            </li>
          ))}
        </ul>
        {p.roles.length > 0 && (
          <button
            className="pl-btn ghost"
            disabled={staffBusy || p.status === 'complete'}
            onClick={() =>
              run(
                () => api.staff(p.id),
                (r) => {
                  setStaffing(r)
                  onUpdate(r.project)
                },
                setStaffBusy,
              )
            }
          >
            {staffBusy ? 'Matching volunteers…' : 'Staff with best-matched volunteers'}
          </button>
        )}
        {staffing && (
          <div className="pl-staff">
            <p className="pl-hint">Assigned with the Hungarian algorithm to maximize total fit{staffing.assignments.length ? ` — average fit ${Math.round((staffing.total_fit / staffing.assignments.length) * 100)}%` : ''}.</p>
            {staffing.assignments.length === 0 ? (
              <p className="pl-muted">No open spots, or no available volunteers nearby.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Role</th><th>Volunteer</th><th>Fit</th></tr>
                </thead>
                <tbody>
                  {staffing.assignments.map((a, i) => (
                    <tr key={`${a.role_id}-${a.volunteer.id}-${i}`}>
                      <td>{a.role}</td>
                      <td>
                        <b>{a.volunteer.name}</b>
                        <span>{a.volunteer.county}</span>
                        {a.reasons.length > 0 && <span className="why">{a.reasons.join(' · ')}</span>}
                      </td>
                      <td><b className="pl-fit">{Math.round(a.fit <= 1 ? a.fit * 100 : a.fit)}%</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <section className="pl-dr-sec">
        <div className="pl-sec-head">
          <h3 className="pl-h3">Project brief</h3>
          {p.brief && p.brief_engine && (
            <span className={`pl-engine ${p.brief_engine}`}>{p.brief_engine === 'claude' ? 'Written by Claude' : 'Written by the local model'}</span>
          )}
        </div>
        {p.brief ? <Markdown text={p.brief} /> : <p className="pl-hint">A one-page brief for funders and partners, written from this neighborhood's data and residents' reports.</p>}
        <button className="pl-btn ghost" disabled={briefBusy} onClick={() => run(() => api.brief(p.id), onUpdate, setBriefBusy)}>
          {briefBusy ? 'Writing…' : p.brief ? 'Rewrite the brief' : 'Write project brief'}
        </button>
      </section>

      <section className="pl-dr-sec">
        <h3 className="pl-h3">Updates</h3>
        <div className="pl-note">
          <textarea rows={2} value={note} placeholder="Add a note for the team…" onChange={(e) => setNote(e.target.value)} />
          <button
            className="pl-btn small"
            disabled={noteBusy || !note.trim()}
            onClick={() =>
              run(
                () => api.updateProject(p.id, { note: note.trim() }),
                (np) => {
                  setNote('')
                  onUpdate(np)
                },
                setNoteBusy,
              )
            }
          >
            {noteBusy ? 'Saving…' : 'Add note'}
          </button>
        </div>
        <ul className="pl-updates">
          {[...p.updates].sort((a, b) => +new Date(b.at) - +new Date(a.at)).map((u, i) => (
            <li key={`${u.at}-${i}`}>
              <span>{fmtDateTime(u.at)}</span>
              <p>{u.text}</p>
            </li>
          ))}
          {!p.updates.length && <li className="pl-muted">No updates yet.</li>}
        </ul>
      </section>
    </aside>
  )
}
