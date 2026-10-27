import { useState } from 'react'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type NeedChange, type NeedDetail } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import { getMode } from '../shared/mode'
import { fmtInt } from '../format'
import { IconAccess, IconIndex, IconSpark } from '../icons'
import { ago, barrierLabel, CatDot, catColor, CATEGORY_NOUN, fipsOf, groupLabel, loadLSArray, needPctScale, r0, saveLS, STATUS } from './common'

const CONFIRMED_KEY = 'allocate.confirmed'

type Props = {
  geoid: string
  detail: NeedDetail | null
  error: string | null
  onClose: () => void
}

// The three inputs to the need estimate and how reports and projects move it.
export function HowEstimated() {
  return (
    <div className="cm-how2">
      <div className="ex-how-flow">
        <div className="ex-how-inputs">
          <span className="ex-how-in"><IconIndex /> Hardship</span>
          <span className="ex-how-in"><IconAccess /> Distance to services</span>
          <span className="ex-how-in"><IconSpark /> Resident reports</span>
        </div>
        <span className="ex-how-arrow">→</span>
        <span className="ex-how-out">Need</span>
      </div>
      <ol className="ex-how-points">
        <li>Public data gives every neighborhood a starting estimate for six kinds of need.</li>
        <li>Each resident report adds evidence where it was made, weighted by how recent, specific and confirmed it is. Nearby neighborhoods move a little too.</li>
        <li>Finished projects lower the need in the places they reach, so the map keeps changing as people act.</li>
      </ol>
    </div>
  )
}

export default function NeedPanel({ geoid, detail, error, onClose }: Props) {
  const base = useBaseData()
  const [confirmed, setConfirmed] = useState<string[]>(() => loadLSArray<string>(CONFIRMED_KEY))
  const [busy, setBusy] = useState<string | null>(null)
  const [lastChange, setLastChange] = useState<{ id: string; change: NeedChange } | null>(null)

  const tasks = (
    <div className="cm-tasks">
      {getMode() === 'planner' ? (
        <a className="cm-task primary" href={`#/plan?geoid=${geoid}`}>Plan for this area</a>
      ) : (
        <>
          <a className="cm-task primary" href={`#/report?geoid=${geoid}`}>Report something here</a>
          <a className="cm-task" href={`#/involved?geoid=${geoid}`}>Ways to help nearby</a>
        </>
      )}
    </div>
  )

  if (error)
    return (
      <div className="cm-panel">
        <PanelHead title="This neighborhood" sub="" onClose={onClose} />
        {tasks}
        <p className="cm-error">Couldn't load the details: {error}</p>
      </div>
    )
  if (!detail || detail.geoid !== geoid)
    return (
      <div className="cm-panel">
        <PanelHead title="Loading…" sub="" onClose={onClose} />
        {tasks}
        <div className="cm-skel" />
        <div className="cm-skel short" />
        <div className="cm-skel" />
      </div>
    )

  const d = detail
  const fips = fipsOf(geoid)
  const cats = [...CATEGORIES].sort((a, b) => (d.by[b]?.posterior ?? 0) - (d.by[a]?.posterior ?? 0))
  const moved = cats.filter((c) => d.by[c] && Math.abs(d.by[c].posterior - d.by[c].prior) >= 1)
  const access = base?.access.tracts[geoid]?.[5]

  const meToo = async (id: string) => {
    setBusy(id)
    try {
      const r = await api.confirm(id)
      const next = [...confirmed, id]
      setConfirmed(next)
      saveLS(CONFIRMED_KEY, next)
      setLastChange({ id, change: r.change })
      modelEvents.emit()
    } catch {
      setLastChange(null)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="cm-panel">
      <PanelHead title={d.county} sub={`A neighborhood of ${fmtInt(d.pop)} residents`} onClose={onClose} />
      {tasks}

      <div className="cm-hero">
        <div className="cm-hero-num" style={{ background: needPctScale.color(d.pct) }}>{r0(d.pct)}</div>
        <div>
          <b>Need score</b>
          <span>Higher than {r0(d.pct)}% of North Carolina neighborhoods</span>
        </div>
      </div>

      <ul className="cm-drivers">
        <li>
          <IconIndex size={15} />
          <span>Hardship</span>
          <b>{d.hardship_pct != null ? `higher than ${r0(d.hardship_pct)}% of NC` : 'not scored'}</b>
        </li>
        <li>
          <IconAccess size={15} />
          <span>Distance to services</span>
          <b>{access != null ? `farther than ${r0(100 - access)}% of NC` : 'not scored'}</b>
        </li>
        <li>
          <IconSpark size={15} />
          <span>Resident reports</span>
          <b>{d.reports.length ? `${d.reports.length} nearby${moved.length ? `, raised ${moved.length} kind${moved.length > 1 ? 's' : ''}` : ''}` : 'none yet'}</b>
        </li>
      </ul>

      <h4 className="cm-h4">Need by kind</h4>
      <ul className="cm-cats">
        {cats.map((c) => {
          const cell = d.by[c]
          if (!cell) return null
          const diff = cell.posterior - cell.prior
          return (
            <li key={c}>
              <div className="cm-cat-row">
                <span><CatDot c={c} /> {CATEGORY_LABEL[c]}</span>
                <b className={Math.abs(diff) >= 1 ? (diff > 0 ? 'cm-up' : 'cm-down') : ''} title={Math.abs(diff) >= 1 ? (diff > 0 ? "Raised by residents' reports" : 'Lowered by recent reports and finished projects') : undefined}>
                  {Math.abs(diff) >= 1 ? <><s>{r0(cell.prior)}</s> → {r0(cell.posterior)}</> : r0(cell.posterior)}
                </b>
              </div>
              <div className="cm-range" title={`Likely between ${r0(cell.lo)} and ${r0(cell.hi)}`}>
                <div className="cm-range-band" style={{ left: `${cell.lo}%`, width: `${Math.max(1, cell.hi - cell.lo)}%`, background: catColor(c) }} />
                <div className="cm-range-prior" style={{ left: `${cell.prior}%` }} />
                <div className="cm-range-dot" style={{ left: `${cell.posterior}%`, background: catColor(c) }} />
              </div>
            </li>
          )
        })}
      </ul>
      <div className="cm-range-key">
        <span><i className="k-prior" /> From public data</span>
        <span><i className="k-dot" /> Current estimate</span>
        <span><i className="k-band" /> Likely range</span>
      </div>
      {moved.length > 0 ? (
        <p className="cm-muted small cm-moved">
          {(() => {
            const up = moved.filter((c) => d.by[c].posterior > d.by[c].prior).length
            const down = moved.length - up
            const parts = [up ? `raised ${up}` : '', down ? `lowered ${down}` : ''].filter(Boolean).join(' and ')
            return `What residents reported, and any finished projects, ${parts} of these. The first number is from public data alone.`
          })()}
        </p>
      ) : (
        <p className="cm-muted small">No resident reports have changed these estimates yet. They come from public data only.</p>
      )}

      <h4 className="cm-h4">Recent reports nearby</h4>
      {d.reports.length === 0 ? (
        <p className="cm-muted small">No one has reported a need near here yet. <a className="cm-link" href={`#/report?geoid=${geoid}`}>Be the first</a>.</p>
      ) : (
        <ul className="cm-quotes">
          {d.reports.slice(0, 5).map((r) => {
            const done = confirmed.includes(r.id)
            const ch = lastChange?.id === r.id ? lastChange.change : null
            return (
              <li key={r.id}>
                <q>{r.text.length > 170 ? `${r.text.slice(0, 167)}…` : r.text}</q>
                <div className="cm-quote-meta">
                  <span><CatDot c={r.primary} /> {CATEGORY_LABEL[r.primary] ?? r.primary} · {ago(r.created_at)}{r.confirmations > 0 ? ` · ${r.confirmations} ${r.confirmations === 1 ? 'neighbor agrees' : 'neighbors agree'}` : ''}</span>
                  <button className={`cm-metoo ${done ? 'done' : ''}`} disabled={done || busy === r.id} onClick={() => meToo(r.id)}>
                    {done ? '✓ You agreed' : busy === r.id ? 'Adding…' : 'Me too'}
                  </button>
                </div>
                {ch && (
                  <p className="cm-gain">
                    {ch.after > ch.before + 0.4
                      ? `Thanks. Estimated ${CATEGORY_NOUN[ch.category as Category] ?? ch.category} need here went from ${r0(ch.before)} to ${r0(ch.after)}.`
                      : 'Thanks. Your voice was added to this report.'}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {d.projects.length > 0 && (
        <>
          <h4 className="cm-h4">Projects here</h4>
          <ul className="cm-projects">
            {d.projects.slice(0, 4).map((p) => (
              <li key={p.id}>
                <a className="cm-proj-link" href={`#/projects?id=${p.id}`}>
                  <div className="cm-cat-row">
                    <span><CatDot c={p.categories[0] ?? 'food'} /> {p.title}</span>
                    <em className={`cm-status ${p.status}`}>{STATUS[p.status] ?? p.status}</em>
                  </div>
                  <div className="cm-progress"><div style={{ width: `${Math.max(2, Math.min(100, p.progress))}%` }} /></div>
                  <span className="cm-muted small">{p.county} · {r0(p.progress)}% ready</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {d.suggestions.length > 0 && (
        <>
          <h4 className="cm-h4">What could help here</h4>
          <ul className="cm-suggest">
            {d.suggestions.slice(0, 3).map((s) => (
              <li key={s.type}>
                <div>
                  <b>{s.label}</b>
                  <p>{s.why}</p>
                </div>
                {getMode() === 'planner' && <a className="cm-btn small" href={`#/plan?county=${fips}&type=${encodeURIComponent(s.type)}&geoid=${geoid}`}>Plan this</a>}
              </li>
            ))}
          </ul>
        </>
      )}

      {(d.barriers.length > 0 || d.groups.length > 0) && (
        <details className="cm-more">
          <summary>What residents say gets in the way <em>{d.barriers.length + d.groups.length}</em></summary>
          {d.barriers.length > 0 && (
            <div className="cm-tags">
              {d.barriers.slice(0, 6).map((b) => (
                <span key={b.key} className="cm-tag">{barrierLabel(b.key)} <em>{b.count}</em></span>
              ))}
            </div>
          )}
          {d.groups.length > 0 && (
            <>
              <p className="cm-sublabel">Who is affected</p>
              <div className="cm-tags">
                {d.groups.slice(0, 6).map((g) => (
                  <span key={g.key} className="cm-tag soft">{groupLabel(g.key)} <em>{g.count}</em></span>
                ))}
              </div>
            </>
          )}
        </details>
      )}

      <details className="cm-more">
        <summary>How this is estimated</summary>
        <HowEstimated />
      </details>
    </div>
  )
}

function PanelHead({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  return (
    <header className="cm-panel-head">
      <div>
        <h2>{title}</h2>
        {sub && <span className="cm-muted">{sub}</span>}
      </div>
      <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
    </header>
  )
}
