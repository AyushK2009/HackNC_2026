import type { TractProps } from './metrics'
import { INDEX_FEATURE_LABELS, METRICS } from './metrics'
import { fmtInt, ordinal, tractName } from './format'

type Model = { features: string[] }

export default function TractPanel({ tract, model, onClose }: { tract: TractProps; model: Model; onClose: () => void }) {
  const measures = METRICS.filter((m) => m.key !== 'hardship_pct')
  const terms = model.features.map((f) => ({ f, v: tract[`term_${f}`] as number | null }))
  const maxAbs = Math.max(1, ...terms.map((t) => Math.abs(t.v ?? 0)))

  return (
    <section className="panel tract">
      <header className="tract-head">
        <div>
          <h2>{tractName(tract.geoid)}</h2>
          <div className="muted">
            {tract.county} · {fmtInt(tract.pop)} residents · {tract.urban ? 'Urban' : 'Rural'}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close tract details">
          ×
        </button>
      </header>

      {tract.scored && tract.hardship_pct != null ? (
        <div className="hero">
          <div className="hero-num">{Math.round(tract.hardship_pct)}</div>
          <div className="hero-text">
            <b>Economic Hardship Index</b>
            <span className="muted">
              More hardship than {Math.round(tract.hardship_pct)}% of North Carolina tracts
            </span>
          </div>
        </div>
      ) : (
        <div className="notice">
          Not scored: {Math.round(tract.gq_share)}% of residents live in group quarters (dorms, institutions) or
          the tract has too few residents for household statistics to be meaningful.
        </div>
      )}

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
      {tract.income_imputed && (
        <p className="footnote">USDA suppresses median income for this tract; the index uses an estimate from its other three measures.</p>
      )}

      {tract.scored && (
        <>
          <h3>What drives the index</h3>
          <p className="footnote">
            Each bar is weight × standardized value. Right of center pushes the score up (more hardship than the NC
            average); left pushes it down.
          </p>
          <ul className="terms">
            {terms.map(({ f, v }) => (
              <li key={f}>
                <span className="term-label">{INDEX_FEATURE_LABELS[f] ?? f}</span>
                <div className="term-track">
                  <div className="term-mid" />
                  {v != null && (
                    <div
                      className={`term-bar ${v >= 0 ? 'pos' : 'neg'}`}
                      style={
                        v >= 0
                          ? { left: '50%', width: `${(v / maxAbs) * 50}%` }
                          : { right: '50%', width: `${(-v / maxAbs) * 50}%` }
                      }
                    />
                  )}
                </div>
                <span className="term-val">{v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
