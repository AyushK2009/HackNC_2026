import { useState } from 'react'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type NeedChange, type NeedDetail } from '../shared/api'
import { fmtInt } from '../format'
import { ago, barrierLabel, CatDot, catColor, CATEGORY_NOUN, fipsOf, groupLabel, loadLSArray, needPctScale, r0, saveLS, STATUS } from './common'

const CONFIRMED_KEY = 'allocate.confirmed'

type Props = {
  geoid: string
  detail: NeedDetail | null
  error: string | null
  onClose: () => void
}

export default function NeedPanel({ geoid, detail, error, onClose }: Props) {
  const [confirmed, setConfirmed] = useState<string[]>(() => loadLSArray<string>(CONFIRMED_KEY))
  const [busy, setBusy] = useState<string | null>(null)
  const [lastChange, setLastChange] = useState<{ id: string; change: NeedChange } | null>(null)

  if (error)
    return (
      <div className="cm-panel">
        <PanelHead title="This neighborhood" sub="" onClose={onClose} />
        <p className="cm-error">Couldn't load the details: {error}</p>
      </div>
    )
  if (!detail || detail.geoid !== geoid)
    return (
      <div className="cm-panel">
        <PanelHead title="Loading…" sub="" onClose={onClose} />
        <div className="cm-skel" />
        <div className="cm-skel short" />
        <div className="cm-skel" />
      </div>
    )

  const d = detail
  const fips = fipsOf(geoid)
  const cats = [...CATEGORIES].sort((a, b) => (d.by[b]?.posterior ?? 0) - (d.by[a]?.posterior ?? 0))
  const moved = cats.filter((c) => d.by[c] && Math.abs(d.by[c].posterior - d.by[c].prior) >= 1)

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

      <p className="cm-panel-kicker">Why this neighborhood is underserved</p>
      <div className="cm-hero">
        <div className="cm-hero-num" style={{ background: needPctScale.color(d.pct) }}>{r0(d.pct)}</div>
        <div>
          <b>Community need score</b>
          <span>Higher than {r0(d.pct)}% of North Carolina neighborhoods</span>
          {d.hardship_pct != null && <span className="cm-muted">Economic hardship: higher than {r0(d.hardship_pct)}% of NC</span>}
        </div>
      </div>

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
                <b>{Math.abs(diff) >= 1 ? <><s>{r0(cell.prior)}</s> → {r0(cell.posterior)}</> : r0(cell.posterior)}</b>
              </div>
              <div className="cm-range" title={`Likely between ${r0(cell.lo)} and ${r0(cell.hi)}`}>
                <div className="cm-range-band" style={{ left: `${cell.lo}%`, width: `${Math.max(1, cell.hi - cell.lo)}%`, background: catColor(c) }} />
                <div className="cm-range-prior" style={{ left: `${cell.prior}%` }} />
                <div className="cm-range-dot" style={{ left: `${cell.posterior}%`, background: catColor(c) }} />
              </div>
              {Math.abs(diff) >= 1 && (
                <p className="cm-cat-note">
                  {diff > 0 ? `Residents' reports raised this from ${r0(cell.prior)} → ${r0(cell.posterior)}` : `Recent reports and finished projects lowered this from ${r0(cell.prior)} → ${r0(cell.posterior)}`}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <div className="cm-range-key">
        <span><i className="k-prior" /> From public data</span>
        <span><i className="k-dot" /> Current estimate</span>
        <span><i className="k-band" /> Likely range</span>
      </div>
      {!moved.length && <p className="cm-muted small">No resident reports have changed these estimates yet — they come from public data only.</p>}

      {(d.barriers.length > 0 || d.groups.length > 0) && (
        <>
          <h4 className="cm-h4">What residents say gets in the way</h4>
          <div className="cm-tags">
            {d.barriers.slice(0, 6).map((b) => (
              <span key={b.key} className="cm-tag">{barrierLabel(b.key)} <em>{b.count}</em></span>
            ))}
          </div>
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
        </>
      )}

      <h4 className="cm-h4">Recent reports nearby</h4>
      {d.reports.length === 0 ? (
        <p className="cm-muted small">No one has reported a need near here yet. Be the first.</p>
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
                      ? `Thanks — estimated ${CATEGORY_NOUN[ch.category as Category] ?? ch.category} need here went from ${r0(ch.before)} to ${r0(ch.after)}.`
                      : 'Thanks — your voice was added to this report.'}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {d.projects.length > 0 && (
        <>
          <h4 className="cm-h4">Projects nearby</h4>
          <ul className="cm-projects">
            {d.projects.slice(0, 4).map((p) => (
              <li key={p.id}>
                <div className="cm-cat-row">
                  <span><CatDot c={p.categories[0] ?? 'food'} /> {p.title}</span>
                  <em className={`cm-status ${p.status}`}>{STATUS[p.status] ?? p.status}</em>
                </div>
                <div className="cm-progress"><div style={{ width: `${Math.max(2, Math.min(100, p.progress))}%` }} /></div>
                <span className="cm-muted small">{p.county} · {r0(p.progress)}% ready</span>
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
                <a className="cm-btn small" href={`#/plan?county=${fips}&type=${encodeURIComponent(s.type)}&geoid=${geoid}`}>Plan this</a>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="cm-actions">
        <a className="cm-btn primary" href={`#/report?geoid=${geoid}`}>Report a need here</a>
        <a className="cm-btn" href={`#/involved?geoid=${geoid}`}>Volunteer nearby</a>
      </div>
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
