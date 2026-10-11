import type { ServiceKey, TractProps } from './metrics'
import { HARDSHIP_METRICS, INDEX_FEATURE_LABELS, SERVICE_COLORS, STATUS_LABEL } from './metrics'
import { fmtInt, ordinal, tractName } from './format'
import type { AccessData, Model } from './types'
import type { ColorScale } from './scale'
import type { AccessRow } from './access'

type Props = {
  tract: TractProps
  model: Model
  mode: 'hardship' | 'access'
  hardshipColor: ColorScale['color']
  pctColor: ColorScale['color']
  access: AccessData
  before: AccessRow | null
  after: AccessRow | null
  onClose: () => void
}

const SERVICES: ServiceKey[] = ['food', 'health', 'transit', 'library']

function Header({ tract, onClose }: { tract: TractProps; onClose: () => void }) {
  return (
    <header className="tract-head">
      <div>
        <h2>{tractName(tract.geoid)}</h2>
        <div className="muted">
          {tract.county} · {fmtInt(tract.pop)} residents
        </div>
      </div>
      <button className="icon-btn" onClick={onClose} aria-label="Close tract details">
        ×
      </button>
    </header>
  )
}

function HardshipBadge({ tract, color }: { tract: TractProps; color: ColorScale['color'] }) {
  if (tract.status !== 'ok' || tract.hardship_pct == null)
    return <div className="notice">Not scored: {STATUS_LABEL[tract.status] ?? 'insufficient data'}.</div>
  return (
    <div className="hero">
      <div className="hero-num" style={{ background: color(tract.hardship_pct) }}>
        {Math.round(tract.hardship_pct)}
      </div>
      <div className="hero-text">
        <b>Economic Hardship Index</b>
        <span className="muted">More hardship than {Math.round(tract.hardship_pct)}% of NC tracts</span>
      </div>
    </div>
  )
}

export default function TractPanel({ tract, model, mode, hardshipColor, pctColor, access, before, after, onClose }: Props) {
  if (mode === 'access') {
    const changed = after && before && after.A > before.A + 1e-6
    return (
      <section className="panel tract">
        <Header tract={tract} onClose={onClose} />
        {before ? (
          <>
            <div className="hero">
              <div className="hero-num" style={{ background: pctColor((changed ? after! : before).pct) }}>
                {Math.round((changed ? after! : before).pct)}
              </div>
              <div className="hero-text">
                <b>Service Accessibility Percentile</b>
                <span className="muted">
                  {changed ? `Up from ${Math.round(before.pct)} with the proposed sites` : `Better access than ${Math.round(before.pct)}% of NC neighborhoods`}
                </span>
              </div>
            </div>
            <h3>Access by service</h3>
            <ul className="measures">
              {SERVICES.map((k, i) => {
                const s = access.services[k]
                const b = before.cov[i]
                const a = changed ? after!.cov[i] : b
                const mi = access.miles[tract.geoid]?.[i]
                return (
                  <li key={k}>
                    <div className="measure-row">
                      <span>
                        <span className="dot" style={{ background: SERVICE_COLORS[k] }} /> {s.label}{' '}
                        {mi != null && <span className="muted">· avg {mi.toFixed(1)} mi</span>}
                      </span>
                      <b>
                        {b.toFixed(0)}{a > b + 0.5 && <span className="gain"> → {a.toFixed(0)}</span>}
                      </b>
                    </div>
                    <div className="nc-bar">
                      <div className="nc-fill after" style={{ width: `${a}%` }} />
                      <div className="nc-fill" style={{ width: `${b}%`, background: SERVICE_COLORS[k] }} />
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="footnote">Scores 0–100: closer than typical for the county scores higher; very long distances are penalized statewide.</p>
            {tract.hardship_pct != null && (
              <p className="footnote">Economic hardship: {Math.round(tract.hardship_pct)}th percentile in NC.</p>
            )}
          </>
        ) : (
          <p className="muted">No residents in this tract.</p>
        )}
      </section>
    )
  }

  const measures = HARDSHIP_METRICS.filter((m) => m.key !== 'hardship_pct')
  const terms = model.features.map((f) => ({ f, v: tract[`term_${f}`] as number | null }))
  const maxAbs = Math.max(1, ...terms.map((t) => Math.abs(t.v ?? 0)))
  return (
    <section className="panel tract">
      <Header tract={tract} onClose={onClose} />
      <HardshipBadge tract={tract} color={hardshipColor} />
      <h3>Measurements</h3>
      <ul className="measures">
        {measures.map((m) => {
          const v = tract[m.key] as number | null
          const nc = tract[`${m.key}_ncpct`] as number | null
          return (
            <li key={m.key}>
              <div className="measure-row">
                <span>{m.label}</span>
                <b>{v == null ? '—' : m.format(v)}</b>
              </div>
              {nc != null && (
                <div className="nc-row" title={`Higher than ${Math.round(nc)}% of NC tracts`}>
                  <div className="nc-bar">
                    <div className="nc-fill" style={{ width: `${nc}%` }} />
                  </div>
                  <span className="nc-label">{ordinal(nc)} pctl. in NC</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {tract.income_imputed && <p className="footnote">Income not published for this tract; the index uses an estimate.</p>}
      {tract.status === 'ok' && (
        <>
          <h3>What drives the score</h3>
          <ul className="terms">
            {terms.map(({ f, v }) => (
              <li key={f}>
                <span className="term-label">{INDEX_FEATURE_LABELS[f] ?? f}</span>
                <div className="term-track">
                  <div className="term-mid" />
                  {v != null && (
                    <div
                      className={`term-bar ${v >= 0 ? 'pos' : 'neg'}`}
                      style={v >= 0 ? { left: '50%', width: `${(v / maxAbs) * 50}%` } : { right: '50%', width: `${(-v / maxAbs) * 50}%` }}
                    />
                  )}
                </div>
                <span className="term-val">{v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <p className="footnote">Right of center = above the NC average, pushing the score up.</p>
        </>
      )}
    </section>
  )
}
