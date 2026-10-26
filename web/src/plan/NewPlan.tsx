import { useEffect, useState } from 'react'
import Combobox from '../shared/Combobox'
import { api, CATEGORY_COLOR, CATEGORY_LABEL, type Category, type InterventionType } from '../shared/api'
import { errText, fmtMoney, fmtNeed, fmtNum, KIND_ORDER, type Kind } from './util'

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
  onScope: (scope: string) => void
  catalog: InterventionType[] | null
  catalogErr: string | null
  counties: { fips: string; name: string }[]
  scopeName: string
  topNeeds: { cat: Category; value: number }[] | null
  solving: boolean
  solveErr: string | null
  onRun: () => void
  suggested: string | null
  onBack: (() => void) | null
}

const STYLE_NOUN: Record<string, string> = { facility: 'a lasting build', mobile: 'a mobile service', program: 'a program', event: 'a one-time event' }
const KIND_GROUP: Record<Exclude<Kind, 'custom'>, string> = { facility: 'Facilities', mobile: 'Mobile services', program: 'Programs', event: 'Events' }

const BUDGETS: { v: number; label: string }[] = [
  { v: 100000, label: '$100k' },
  { v: 250000, label: '$250k' },
  { v: 500000, label: '$500k' },
  { v: 1000000, label: '$1M' },
  { v: 3000000, label: '$3M statewide' },
]
const HOURS = [0, 200, 400, 800, 1500]

const SOLVE_STEPS = [
  'Reading community need for every neighborhood…',
  'Placing each option where it could help most…',
  'Testing combinations that fit your budget and volunteers…',
  'Checking that no better combination exists…',
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
    <button type="button" className={`pp-type ${on ? 'on' : ''}`} onClick={onToggle} title={t.description} aria-pressed={on}>
      <span className="pl-check" aria-hidden>{on ? '✓' : ''}</span>
      <span className="pp-type-body">
        <b>{t.label}</b>
        <span className="pp-type-meta">
          {fmtMoney(t.cost)} · ~{t.reach_mi} mi{t.volunteers ? ` · ${fmtNum(t.volunteers)} hrs/mo` : ''}
        </span>
        <CatChips cats={t.categories} />
      </span>
    </button>
  )
}

function Amount({ value, onChange, prefix, suffix, step, label }: { value: number; onChange: (v: number) => void; prefix?: string; suffix?: string; step: number; label: string }) {
  return (
    <label className="pp-amount">
      {prefix && <span>{prefix}</span>}
      <input type="number" min={0} step={step} value={value} aria-label={label} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
      {suffix && <span>{suffix}</span>}
    </label>
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
  const groups = KIND_ORDER.filter((k): k is Exclude<Kind, 'custom'> => k !== 'custom')
    .map((k) => ({ kind: k, items: (catalog ?? []).filter((t) => t.kind === k) }))
    .filter((g) => g.items.length)
  const options = [{ value: 'nc', label: 'All of North Carolina' }, ...[...p.counties].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.fips, label: c.name }))]
  const canRun = !p.solving && nOn > 0 && !!catalog
  const customBudget = !BUDGETS.some((b) => b.v === form.budget)
  const customHours = !HOURS.includes(form.volunteers)
  const nCustom = form.custom.filter((c) => c.include).length

  return (
    <div className="pp-builder">
      {p.onBack && (
        <button className="pl-linkbtn pp-back" onClick={p.onBack}>
          ← Back to the plan
        </button>
      )}

      <section className="pp-step">
        <header>
          <i>1</i>
          <div>
            <h3>Where</h3>
            <p>The county you want to help, or the whole state.</p>
          </div>
        </header>
        <div className="pp-where">
          <Combobox options={options} value={form.scope} onChange={p.onScope} placeholder="Type a county" size="lg" />
          <div className="pp-needs">
            {p.topNeeds === null && <span className="pl-muted">Loading what this area needs most…</span>}
            {p.topNeeds && p.topNeeds.length > 0 && (
              <>
                <span className="pp-needs-label">Biggest gaps in {p.scopeName}</span>
                <div className="pp-needchips">
                  {p.topNeeds.map((n) => (
                    <span key={n.cat} className="pp-needchip">
                      <i style={{ background: CATEGORY_COLOR[n.cat] }} />
                      {CATEGORY_LABEL[n.cat]}
                      <b>{fmtNeed(n.value)}</b>
                    </span>
                  ))}
                </div>
                <span className="pl-muted">Need on a 0–100 scale, averaged over everyone who lives there.</span>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="pp-step">
        <header>
          <i>2</i>
          <div>
            <h3>Resources</h3>
            <p>What you have to spend, and how much volunteer time you can count on.</p>
          </div>
        </header>
        <div className="pp-res">
          <div>
            <span className="pl-label">Budget</span>
            <div className="pp-chips">
              {BUDGETS.map((b) => (
                <button key={b.v} className={form.budget === b.v ? 'on' : ''} onClick={() => update({ budget: b.v })}>
                  {b.label}
                </button>
              ))}
            </div>
            <div className={`pp-custom-amt ${customBudget ? 'on' : ''}`}>
              <span>Other amount</span>
              <Amount value={form.budget} onChange={(v) => update({ budget: v })} prefix="$" step={25000} label="Custom budget in dollars" />
            </div>
          </div>
          <div>
            <span className="pl-label">Volunteer hours per month</span>
            <div className="pp-chips">
              {HOURS.map((h) => (
                <button key={h} className={form.volunteers === h ? 'on' : ''} onClick={() => update({ volunteers: h })}>
                  {h === 0 ? 'None' : fmtNum(h)}
                </button>
              ))}
            </div>
            <div className={`pp-custom-amt ${customHours ? 'on' : ''}`}>
              <span>Other amount</span>
              <Amount value={form.volunteers} onChange={(v) => update({ volunteers: v })} suffix="hrs/mo" step={25} label="Custom volunteer hours per month" />
            </div>
          </div>
        </div>
      </section>

      <section className="pp-step">
        <header>
          <i>3</i>
          <div>
            <h3>Kinds of help</h3>
            <p>The plan picks the best mix from the ones you leave on · {nOn} of {(catalog?.length ?? 0) + form.custom.length} on</p>
          </div>
        </header>
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
            <div key={g.kind} className="pp-group">
              <div className="pp-group-head">
                <span>{KIND_GROUP[g.kind]}</span>
                <button className="pl-linkbtn" onClick={() => setGroup(keys, !allOn)}>{allOn ? 'Turn all off' : 'Turn all on'}</button>
              </div>
              <div className="pp-types">
                {g.items.map((t) => (
                  <TypeCard key={t.key} t={t} on={on.has(t.key)} onToggle={() => toggle(t.key)} />
                ))}
              </div>
            </div>
          )
        })}

        <details className="pp-fine" open={form.custom.length > 0 || undefined}>
          <summary>
            Fine-tune
            <span>
              At most {form.maxPerType} of each{nCustom ? ` · ${nCustom} idea${nCustom === 1 ? '' : 's'} of your own` : ''}
            </span>
          </summary>
          <div className="pp-fine-body">
            <div>
              <span className="pl-label">Most of any one option</span>
              <p className="pl-hint">Keeps the plan from spending everything on a single kind of help.</p>
              <div className="pl-seg">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={form.maxPerType === n ? 'on' : ''} onClick={() => update({ maxPerType: n })}>{n}</button>
                ))}
              </div>
              <label className="pl-label pp-name-label" htmlFor="pl-name">Plan name</label>
              <input id="pl-name" className="pl-input" value={form.name} placeholder={`${p.scopeName} · ${fmtMoney(form.budget)}`} onChange={(e) => update({ name: e.target.value })} />
            </div>
            <div>
              <span className="pl-label">Add your own idea</span>
              <p className="pl-hint">Describe it in plain words. We estimate the cost, how far it reaches and which needs it helps.</p>
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
            </div>
          </div>
        </details>
      </section>

      <div className="pp-run">
        {p.solving ? (
          <div className="pl-solving" role="status">
            <span className="pl-spin" />
            <div>
              <b>{SOLVE_STEPS[step]}</b>
              <span>{elapsed.toFixed(1)} s</span>
            </div>
          </div>
        ) : (
          <button className="pl-run" onClick={p.onRun} disabled={!canRun}>Build the plan</button>
        )}
        <span className="pl-muted">
          {nOn === 0 && catalog ? 'Turn on at least one kind of help.' : `${p.scopeName} · ${fmtMoney(form.budget)} · ${fmtNum(form.volunteers)} volunteer hrs/mo · ${nOn} kinds of help`}
        </span>
      </div>
      {p.solveErr && <div className="pl-error">Couldn't build a plan: {p.solveErr}</div>}
    </div>
  )
}
