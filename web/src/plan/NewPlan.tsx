import { useEffect, useState } from 'react'
import { api, CATEGORY_COLOR, CATEGORY_LABEL, type InterventionType } from '../shared/api'
import { errText, fmtMoney, fmtNum, KIND_ORDER, KIND_TITLE, type Kind } from './util'

export type CustomIdea = { type: InterventionType; include: boolean; text: string; est: { cost: number; reach_mi: number; volunteers: number } }
export type FormState = {
  scope: string
  budget: number
  volunteers: number
  types: string[]
  custom: CustomIdea[]
  maxPerType: number
  name: string
}

type Props = {
  form: FormState
  update: (patch: Partial<FormState>) => void
  catalog: InterventionType[] | null
  catalogErr: string | null
  counties: { fips: string; name: string }[]
  scopeName: string
  solving: boolean
  solveErr: string | null
  onRun: () => void
  suggested: string | null
  onBack: (() => void) | null
}

const STYLE_NOUN: Record<string, string> = { facility: 'a lasting build', mobile: 'a mobile service', program: 'a program', event: 'a one-time event' }

const SOLVE_STEPS = [
  'Reading community need for every neighborhood…',
  'Placing each option where it could help most…',
  'Testing combinations that fit your budget and volunteers…',
  'Proving no better combination exists…',
]

export function Dots({ cats }: { cats: InterventionType['categories'] }) {
  return (
    <span className="pl-dots">
      {cats.map((c) => (
        <i key={c} style={{ background: CATEGORY_COLOR[c] }} title={CATEGORY_LABEL[c]} />
      ))}
    </span>
  )
}

export function CatChips({ cats }: { cats: InterventionType['categories'] }) {
  return (
    <span className="pl-catchips">
      {cats.map((c) => (
        <span key={c}>
          <i style={{ background: CATEGORY_COLOR[c] }} />
          {CATEGORY_LABEL[c]}
        </span>
      ))}
    </span>
  )
}

function TypeCard({ t, on, onToggle }: { t: InterventionType; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`pl-type ${on ? 'on' : ''}`} onClick={onToggle} title={t.description} aria-pressed={on}>
      <span className="pl-check" aria-hidden>{on ? '✓' : ''}</span>
      <span className="pl-type-body">
        <b>{t.label}</b>
        <span className="pl-type-meta">
          {fmtMoney(t.cost)} · reaches ~{t.reach_mi} mi{t.volunteers ? ` · ${fmtNum(t.volunteers)} volunteer hrs/mo` : ''}
        </span>
        <CatChips cats={t.categories} />
      </span>
    </button>
  )
}

export default function NewPlan(p: Props) {
  const { form, update, catalog } = p
  const [idea, setIdea] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!p.solving) return
    const t0 = Date.now()
    setStep(0)
    setElapsed(0)
    const t = window.setInterval(() => {
      const s = (Date.now() - t0) / 1000
      setElapsed(s)
      setStep(Math.min(SOLVE_STEPS.length - 1, Math.floor(s / 0.9)))
    }, 150)
    return () => window.clearInterval(t)
  }, [p.solving])

  const on = new Set(form.types)
  const toggle = (k: string) => update({ types: on.has(k) ? form.types.filter((x) => x !== k) : [...form.types, k] })
  const setGroup = (keys: string[], value: boolean) =>
    update({ types: value ? [...new Set([...form.types, ...keys])] : form.types.filter((x) => !keys.includes(x)) })

  const editCustom = (i: number, patch: Partial<InterventionType>) =>
    update({ custom: form.custom.map((x, j) => (j === i ? { ...x, type: { ...x.type, ...patch } } : x)) })

  const parse = async () => {
    const text = idea.trim()
    if (!text) return
    setParsing(true)
    setParseErr(null)
    try {
      const t = await api.parseIntervention(text)
      update({ custom: [...form.custom, { type: t, include: true, text, est: { cost: t.cost, reach_mi: t.reach_mi, volunteers: t.volunteers } }] })
      setIdea('')
    } catch (e) {
      setParseErr(errText(e))
    } finally {
      setParsing(false)
    }
  }

  const nOn = form.types.filter((k) => catalog?.some((t) => t.key === k)).length + form.custom.filter((c) => c.include).length
  const groups = KIND_ORDER.filter((k) => k !== 'custom')
    .map((k) => ({ kind: k as Kind, items: (catalog ?? []).filter((t) => t.kind === k) }))
    .filter((g) => g.items.length)
  const counties = [...p.counties].sort((a, b) => a.name.localeCompare(b.name))
  const canRun = !p.solving && nOn > 0 && !!catalog

  return (
    <div className="pl-form">
      <div className="pl-head">
        <p className="pl-kicker">New plan</p>
        <h2>Find the best way to spend a budget</h2>
        <p className="pl-lead">Pick an area and what you have to work with. We test every combination of options and places, and show the plan that lowers community need the most.</p>
        {p.onBack && (
          <button className="pl-linkbtn" onClick={p.onBack}>
            ← Back to the last results
          </button>
        )}
      </div>

      <section className="pl-sec">
        <label className="pl-label" htmlFor="pl-scope">Area</label>
        <select id="pl-scope" className="pl-select" value={form.scope} onChange={(e) => update({ scope: e.target.value })}>
          <option value="nc">All of North Carolina</option>
          {counties.map((c) => (
            <option key={c.fips} value={c.fips}>{c.name}</option>
          ))}
        </select>
      </section>

      <section className="pl-sec">
        <div className="pl-slider-head">
          <label className="pl-label" htmlFor="pl-budget">Budget</label>
          <b>{fmtMoney(form.budget)}</b>
        </div>
        <input id="pl-budget" type="range" min={25000} max={3000000} step={25000} value={form.budget} onChange={(e) => update({ budget: Number(e.target.value) })} />
        <div className="pl-range-ends"><span>$25k</span><span>$3M</span></div>

        <div className="pl-slider-head">
          <label className="pl-label" htmlFor="pl-vol">Volunteer hours per month</label>
          <b>{fmtNum(form.volunteers)} hrs</b>
        </div>
        <input id="pl-vol" type="range" min={0} max={2000} step={25} value={form.volunteers} onChange={(e) => update({ volunteers: Number(e.target.value) })} />
        <div className="pl-range-ends"><span>None</span><span>2,000 hrs</span></div>
      </section>

      <section className="pl-sec">
        <div className="pl-sec-head">
          <span className="pl-label">What you could do</span>
          <span className="pl-muted">{nOn} option{nOn === 1 ? '' : 's'} on</span>
        </div>
        {p.suggested && catalog && (
          <div className="pl-suggest">
            Started from a suggestion: <b>{catalog.find((t) => t.key === p.suggested)?.label ?? p.suggested}</b>.{' '}
            <button className="pl-linkbtn" onClick={() => update({ types: catalog.map((t) => t.key) })}>Turn every option on</button>
          </div>
        )}
        {!catalog && !p.catalogErr && <div className="pl-skel" />}
        {p.catalogErr && <div className="pl-error">Couldn't load the list of options: {p.catalogErr}</div>}
        {groups.map((g) => {
          const keys = g.items.map((t) => t.key)
          const allOn = keys.every((k) => on.has(k))
          return (
            <div key={g.kind} className="pl-group">
              <div className="pl-group-head">
                <span>{KIND_TITLE[g.kind]}</span>
                <button className="pl-linkbtn" onClick={() => setGroup(keys, !allOn)}>{allOn ? 'Turn off' : 'Turn all on'}</button>
              </div>
              {g.items.map((t) => (
                <TypeCard key={t.key} t={t} on={on.has(t.key)} onToggle={() => toggle(t.key)} />
              ))}
            </div>
          )
        })}
      </section>

      <section className="pl-sec">
        <span className="pl-label">Add your own idea</span>
        <p className="pl-hint">Describe it in plain words. We estimate what it costs, how far it reaches and which needs it helps.</p>
        <textarea
          className="pl-textarea"
          rows={3}
          value={idea}
          placeholder="e.g. Saturday van rides from senior apartments to the grocery store and pharmacy"
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) parse()
          }}
        />
        <button className="pl-btn ghost" onClick={parse} disabled={parsing || !idea.trim()}>
          {parsing ? 'Estimating…' : 'Estimate my idea'}
        </button>
        {parseErr && <div className="pl-error">{parseErr}</div>}
        {form.custom.map((c, i) => (
          <div key={c.type.key} className={`pl-custom ${c.include ? 'on' : ''}`}>
            <div className="pl-custom-top">
              <b>{c.type.label}</b>
              <button className="pl-x" aria-label="Remove idea" onClick={() => update({ custom: form.custom.filter((_, j) => j !== i) })}>×</button>
            </div>
            <p>{STYLE_NOUN[(c.type as { style?: string }).style ?? ''] ? <>We read this as <b>{STYLE_NOUN[(c.type as { style?: string }).style ?? '']}</b> that helps with:</> : 'Helps with:'}</p>
            <div className="pl-custom-grid">
              <label><span>Est. cost ($)</span><input type="number" min={0} step={1000} value={c.type.cost} onChange={(e) => editCustom(i, { cost: Math.max(0, Number(e.target.value) || 0) })} /></label>
              <label><span>Reach (mi)</span><input type="number" min={0.5} max={25} step={0.5} value={c.type.reach_mi} onChange={(e) => editCustom(i, { reach_mi: Math.max(0.5, Number(e.target.value) || 0.5) })} /></label>
              <label><span>Volunteer hrs/mo</span><input type="number" min={0} step={10} value={c.type.volunteers} onChange={(e) => editCustom(i, { volunteers: Math.max(0, Number(e.target.value) || 0) })} /></label>
            </div>
            <p className="pl-hint">Our estimate: {fmtMoney(c.est.cost)} · ~{c.est.reach_mi} mi · {fmtNum(c.est.volunteers)} hrs/mo. Change the numbers if you know better.</p>
            <CatChips cats={c.type.categories} />
            <label className="pl-switch">
              <input type="checkbox" checked={c.include} onChange={(e) => update({ custom: form.custom.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)) })} />
              <span>Include in the plan</span>
            </label>
          </div>
        ))}
      </section>

      <section className="pl-sec">
        <span className="pl-label">Most of any one option</span>
        <p className="pl-hint">So the plan doesn't spend everything on a single kind of help.</p>
        <div className="pl-seg">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={form.maxPerType === n ? 'on' : ''} onClick={() => update({ maxPerType: n })}>{n}</button>
          ))}
        </div>
      </section>

      <section className="pl-sec">
        <label className="pl-label" htmlFor="pl-name">Plan name</label>
        <input id="pl-name" className="pl-input" value={form.name} placeholder={`${p.scopeName} · ${fmtMoney(form.budget)}`} onChange={(e) => update({ name: e.target.value })} />
      </section>

      <div className="pl-run-wrap">
        {p.solving ? (
          <div className="pl-solving" role="status">
            <span className="pl-spin" />
            <div>
              <b>{SOLVE_STEPS[step]}</b>
              <span>{elapsed.toFixed(1)} s</span>
            </div>
          </div>
        ) : (
          <button className="pl-run" onClick={p.onRun} disabled={!canRun}>Find the best plan</button>
        )}
        {nOn === 0 && catalog && <p className="pl-hint">Turn on at least one option.</p>}
        {p.solveErr && <div className="pl-error">Couldn't find a plan: {p.solveErr}</div>}
      </div>
    </div>
  )
}
