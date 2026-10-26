import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS } from '../MapView'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type Extraction, type NeedChange, type Report as ReportT } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import Combobox from '../shared/Combobox'
import { getPlace } from '../shared/place'
import type { TractProps } from '../metrics'
import { BARRIERS, CatDot, catColor, CATEGORY_NOUN, countyBounds, countyCenter, countyNameOf, fipsOf, GROUPS, nearestTract, normalizeExtraction, needPctScale, r0, useHashParams } from './common'

const EXAMPLES = [
  "Since the 12 bus was cut, my mom can't get to her dialysis appointments anymore.",
  "The only grocery store closed and the pantry is only open Tuesday mornings while I'm at work.",
  'Our apartment has no internet and my kids do their homework in the library parking lot.',
  "There's no daycare nearby that takes vouchers, so I had to turn down a full-time job.",
]
const SEVERITY_LABEL = ['Minor', 'Inconvenient', 'Serious', 'Very serious', 'Dangerous']
const URGENCY: Extraction['urgency'][] = ['low', 'medium', 'high']
const URGENCY_LABEL: Record<Extraction['urgency'], string> = { low: 'Can wait', medium: 'Soon', high: 'Right now' }
type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }

export default function Report() {
  const base = useBaseData()
  const params = useHashParams()
  const [text, setText] = useState('')
  const [geoid, setGeoid] = useState<string | null>(null)
  const [point, setPoint] = useState<[number, number] | null>(null)
  const [county, setCounty] = useState('')
  const [focus, setFocus] = useState<Focus>({ key: 'nc', bounds: NC_BOUNDS, padding: [20, 20] })
  const [ex, setEx] = useState<Extraction | null>(null)
  const [exBusy, setExBusy] = useState(false)
  const [exErr, setExErr] = useState<string | null>(null)
  const [edited, setEdited] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ report: ReportT; change: NeedChange } | null>(null)
  const [locMsg, setLocMsg] = useState<string | null>(null)
  const reqId = useRef(0)

  const pick = (g: string, pt?: [number, number]) => {
    if (!base) return
    setGeoid(g)
    setPoint(pt ?? base.centroid.get(g) ?? null)
    setCounty(fipsOf(g))
  }

  // Jump to a county: drop the pin at its center so the report can be sent right away.
  const goCounty = (f: string) => {
    if (!base) return
    setCounty(f)
    setGeoid(null)
    setPoint(f ? countyCenter(base, f) : null)
    const b = f ? countyBounds(base, f) : null
    setFocus(b ? { key: `c-${f}-${Date.now()}`, bounds: b, padding: [20, 20] } : { key: `nc-${Date.now()}`, bounds: NC_BOUNDS, padding: [20, 20] })
  }

  // '#/report?geoid=…' picks that neighborhood; otherwise start from the county chosen elsewhere in the app.
  const qGeoid = params.get('geoid')
  useEffect(() => {
    if (!base) return
    if (qGeoid && base.byId.has(qGeoid)) {
      pick(qGeoid)
      const b = countyBounds(base, fipsOf(qGeoid))
      if (b) setFocus({ key: `q-${qGeoid}`, bounds: b, padding: [20, 20] })
      return
    }
    const pl = getPlace()
    if (pl && !point) goCounty(pl.fips)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, qGeoid])

  const runExtract = async (t: string, force: boolean) => {
    const id = ++reqId.current
    setExBusy(true)
    setExErr(null)
    try {
      const r = normalizeExtraction(await api.extract(t))
      if (id !== reqId.current) return
      setEx((prev) => (force || !edited || !prev ? r : prev))
      if (force) setEdited(false)
    } catch (e) {
      if (id === reqId.current) setExErr(String((e as Error).message ?? e))
    } finally {
      if (id === reqId.current) setExBusy(false)
    }
  }

  // Re-read the report ~800 ms after typing pauses (unless the person has already corrected the result).
  useEffect(() => {
    if (text.trim().length <= 25 || edited) return
    const t = window.setTimeout(() => runExtract(text.trim(), false), 800)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, edited])

  const edit = (patch: Partial<Extraction>) => {
    if (!ex) return
    setEx({ ...ex, ...patch })
    setEdited(true)
  }
  const toggleCat = (c: Category) => {
    if (!ex) return
    const on = ex.categories.includes(c)
    if (on && ex.categories.length === 1) return
    const categories = on ? ex.categories.filter((x) => x !== c) : [...ex.categories, c]
    edit({ categories, primary: categories.includes(ex.primary) ? ex.primary : categories[0] })
  }
  const toggleIn = (key: 'barriers' | 'groups', v: string) => {
    if (!ex) return
    const cur = ex[key]
    edit({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<Extraction>)
  }

  const send = async () => {
    if (!point || text.trim().length < 10) return
    setSending(true)
    setSendErr(null)
    try {
      const r = await api.report(text.trim(), point[0], point[1], ex ?? undefined)
      setDone(r)
      modelEvents.emit()
    } catch (e) {
      setSendErr(String((e as Error).message ?? e))
    } finally {
      setSending(false)
    }
  }

  const useMyLocation = () => {
    if (!base || !navigator.geolocation) return setLocMsg('Location is not available in this browser.')
    setLocMsg('Finding you…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: la, longitude: lo } = pos.coords
        const g = nearestTract(base, la, lo)
        if (!g || la < 33.7 || la > 36.7 || lo < -84.4 || lo > -75.3) return setLocMsg("You seem to be outside North Carolina — pick a spot on the map instead.")
        pick(g, [la, lo])
        const b = countyBounds(base, fipsOf(g))
        if (b) setFocus({ key: `me-${Date.now()}`, bounds: b, padding: [20, 20] })
        setLocMsg(null)
      },
      () => setLocMsg("Couldn't get your location — pick a spot on the map instead."),
      { timeout: 8000 },
    )
  }

  const reset = () => {
    setDone(null)
    setText('')
    setEx(null)
    setEdited(false)
  }

  const countyOptions = useMemo(
    () => [...(base?.access.counties ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.fips, label: c.name })),
    [base],
  )
  const fips = geoid ? fipsOf(geoid) : county
  const fill = useMemo(
    () => (p: TractProps) => (p.geoid === geoid ? '#e2513c' : fips && fipsOf(p.geoid) === fips ? '#f4cfc4' : '#ebe8e2'),
    [geoid, fips],
  )

  const pin = useMemo(() => (point ? [{ id: 'pin', lat: point[0], lon: point[1], color: '#18191b', size: 14 }] : undefined), [point])

  if (!base) return <div className="cm-splash">Loading…</div>
  const placeName = geoid ? countyNameOf(base, geoid) : null

  if (done) return <Success done={done} county={done.report.county || countyNameOf(base, done.report.geoid || geoid || '')} onAgain={reset} />

  return (
    <div className="cm-page cm-scroll">
      <div className="cm-report">
        <section className="cm-report-main">
          <p className="ex-kicker">For residents</p>
          <h1 className="cm-h1">Tell us what's missing</h1>
          <p className="cm-intro">
            Your words become part of the shared map that nonprofits, volunteers and local planners use to decide where help goes
            next. No account needed.
          </p>

          <label className="cm-label" htmlFor="cm-text">What makes it hard for you or your neighbors to get what you need?</label>
          <textarea
            id="cm-text"
            className="cm-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe it in your own words — what's hard, who it affects, and since when."
            rows={6}
            maxLength={1500}
          />
          <div className="cm-examples">
            <span>Examples:</span>
            {EXAMPLES.map((e) => (
              <button key={e} className="cm-example" onClick={() => { setText(e); setEdited(false) }}>
                {e.length > 64 ? `${e.slice(0, 62)}…` : e}
              </button>
            ))}
          </div>
          <p className="cm-privacy">Please don't include names, addresses, phone numbers or other personal details. Reports are shown publicly without your name.</p>

          <div className="cm-loc">
            <div className="cm-loc-head">
              <div>
                <span className="cm-label">Where is this happening?</span>
                <p className="cm-muted small">Click the map to pick the neighborhood, or jump to a county.</p>
              </div>
              <div className="cm-loc-tools">
                <Combobox
                  options={countyOptions}
                  value={fips || null}
                  onChange={goCounty}
                  placeholder="Type a county"
                />
                <button className="cm-btn small" onClick={useMyLocation}>Use my location</button>
              </div>
            </div>
            <div className="cm-minimap">
              <MapView
                tracts={base.tracts}
                fill={fill}
                tooltip={(p) => `<div class="tt-title">${p.county}</div><div class="tt-sub">Click to choose this neighborhood</div>`}
                selected={geoid}
                onSelect={(g) => pick(g)}
                focus={focus}
                markers={pin}
              />
            </div>
            <p className={`cm-loc-chosen ${geoid || point ? 'ok' : ''}`}>
              {locMsg ?? (placeName ? <>✓ A neighborhood in <b>{placeName}</b></> : point && county ? <>✓ Somewhere in <b>{countyNameOf(base, `37${county}000000`)}</b> · click the map to pin the exact neighborhood</> : 'No neighborhood chosen yet')}
            </p>
          </div>
        </section>

        <aside className="cm-report-side">
          <div className="cm-card cm-understood">
            <div className="cm-understood-head">
              <h3>What we understood</h3>
              {ex && <span className={`cm-engine ${ex.engine}`}>{ex.engine === 'claude' ? 'Understood by Claude' : 'Understood by the local language model'}</span>}
            </div>
            {!ex && !exBusy && (
              <p className="cm-muted">
                Start writing and we'll show how the system reads your report — the kind of need, how serious it is, and who it
                affects. You can fix anything before sending.
              </p>
            )}
            {exBusy && !ex && <><div className="cm-skel" /><div className="cm-skel short" /><div className="cm-skel" /></>}
            {exErr && <p className="cm-error">Couldn't read the report right now ({exErr}). You can still send it.</p>}
            {ex && (
              <div className={`cm-ex ${exBusy ? 'busy' : ''}`}>
                <div className="cm-field">
                  <span>Summary</span>
                  <input className="cm-input" value={ex.summary} maxLength={140} onChange={(e) => edit({ summary: e.target.value })} />
                </div>
                <div className="cm-field">
                  <span>Kind of need <em>tap to add or remove · ★ main concern</em></span>
                  <div className="ex-chips">
                    {CATEGORIES.map((c) => {
                      const on = ex.categories.includes(c)
                      return (
                        <button
                          key={c}
                          className={`ex-chip cm-catchip ${on ? 'on' : ''}`}
                          style={on ? { borderColor: catColor(c), color: catColor(c) } : undefined}
                          onClick={() => toggleCat(c)}
                        >
                          <CatDot c={c} /> {CATEGORY_LABEL[c]}
                          {ex.primary === c && <b className="cm-star">★</b>}
                        </button>
                      )
                    })}
                  </div>
                  {ex.categories.length > 1 && (
                    <div className="cm-primary">
                      Main concern:
                      {ex.categories.map((c) => (
                        <button key={c} className={ex.primary === c ? 'on' : ''} onClick={() => edit({ primary: c })}>{CATEGORY_LABEL[c]}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cm-field">
                  <span>How serious is it?</span>
                  <div className="cm-sev">
                    {SEVERITY_LABEL.map((l, i) => (
                      <button key={l} className={ex.severity === i + 1 ? 'on' : ''} style={ex.severity === i + 1 ? { background: needPctScale.bins[i + 1] } : undefined} onClick={() => edit({ severity: (i + 1) as Extraction['severity'] })}>
                        <b>{i + 1}</b>
                        <span>{l}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cm-field">
                  <span>How urgent?</span>
                  <div className="cm-seg">
                    {URGENCY.map((u) => (
                      <button key={u} className={ex.urgency === u ? 'on' : ''} onClick={() => edit({ urgency: u })}>{URGENCY_LABEL[u]}</button>
                    ))}
                  </div>
                </div>
                <div className="cm-field">
                  <span>What gets in the way</span>
                  <div className="cm-tags">
                    {Object.entries(BARRIERS).map(([k, l]) => (
                      <button key={k} className={`cm-tag btn ${ex.barriers.includes(k) ? 'on' : ''}`} onClick={() => toggleIn('barriers', k)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="cm-field">
                  <span>Who it affects</span>
                  <div className="cm-tags">
                    {Object.entries(GROUPS).map(([k, l]) => (
                      <button key={k} className={`cm-tag btn ${ex.groups.includes(k) ? 'on' : ''}`} onClick={() => toggleIn('groups', k)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="cm-conf">
                  <span>How sure the system is</span>
                  <div className="cm-bar"><div style={{ width: `${Math.round(ex.confidence * 100)}%`, background: ex.confidence > 0.66 ? 'var(--good)' : ex.confidence > 0.4 ? '#f59b3a' : '#e2513c' }} /></div>
                  <b>{Math.round(ex.confidence * 100)}%</b>
                </div>
                {edited && <p className="cm-muted small">You've corrected this — your version will be saved.</p>}
              </div>
            )}
            <div className="cm-send">
              <button className="cm-btn" disabled={text.trim().length < 10 || exBusy} onClick={() => runExtract(text.trim(), true)}>
                {exBusy ? 'Reading…' : ex ? 'Check again' : 'Check my report'}
              </button>
              <button className="cm-btn primary big" disabled={!point || text.trim().length < 10 || sending} onClick={send}>
                {sending ? 'Sending…' : 'Send report'}
              </button>
            </div>
            {(!point || text.trim().length < 10) && (
              <p className="cm-muted small center">{text.trim().length < 10 ? 'Write a sentence or two first.' : 'Pick where this is happening on the map.'}</p>
            )}
            {sendErr && <p className="cm-error">Couldn't send: {sendErr}</p>}
          </div>
        </aside>
      </div>
    </div>
  )
}

function Success({ done, county, onAgain }: { done: { report: ReportT; change: NeedChange }; county: string; onAgain: () => void }) {
  const { change: c, report } = done
  const g = c.geoid || report.geoid
  const noun = CATEGORY_NOUN[c.category] ?? c.category
  const rose = Math.round(c.after) > Math.round(c.before)
  return (
    <div className="cm-page cm-scroll">
      <div className="cm-success">
        <div className="cm-check">✓</div>
        <h1 className="cm-h1">Thank you — your report is on the map</h1>
        <p className="cm-success-lead">
          {rose ? (
            <>Your report raised the estimated <b>{noun}</b> need in this {county} neighborhood from <b>{r0(c.before)}</b> to <b>{r0(c.after)}</b>.</>
          ) : (
            <>Your report was added to the evidence for this {county} neighborhood. The estimated <b>{noun}</b> need there is <b>{r0(c.after)}</b> out of 100.</>
          )}{' '}
          Overall need there is now higher than <b>{r0(c.pct_after)}%</b> of North Carolina.
        </p>
        <div className="cm-ba">
          <BeforeAfter label={`${CATEGORY_LABEL[c.category] ?? c.category} need`} before={c.before} after={c.after} color={catColor(c.category)} />
          <BeforeAfter label="Overall need, compared with NC" before={c.pct_before} after={c.pct_after} color={needPctScale.color(c.pct_after)} suffix="%" />
        </div>
        <div className="cm-understood-mini">
          <span className="cm-muted small">Saved as</span>
          <p>“{report.summary || report.text}”</p>
          <div className="cm-tags">
            {report.categories.map((k) => <span key={k} className="cm-tag"><CatDot c={k} /> {CATEGORY_LABEL[k]}</span>)}
            <span className="cm-tag soft">Seriousness {report.severity}/5</span>
          </div>
        </div>
        <p className="cm-muted">Planners and nonprofits see this right away. If neighbors say "me too", it counts even more.</p>
        <div className="cm-actions center">
          <a className="cm-btn primary big" href={`#/map?geoid=${g}`}>See it on the map</a>
          <a className="cm-btn big" href={`#/involved?geoid=${g}`}>Ways to help nearby</a>
          <button className="cm-btn ghost" onClick={onAgain}>Report something else</button>
        </div>
      </div>
    </div>
  )
}

function BeforeAfter({ label, before, after, color, suffix = '' }: { label: string; before: number; after: number; color: string; suffix?: string }) {
  return (
    <div className="cm-ba-item">
      <span className="cm-ba-label">{label}</span>
      <div className="cm-ba-row">
        <span>Before</span>
        <div className="cm-bar big"><div style={{ width: `${Math.max(0, Math.min(100, before))}%`, background: '#b9b6ae' }} /></div>
        <b>{r0(before)}{suffix}</b>
      </div>
      <div className="cm-ba-row">
        <span>Now</span>
        <div className="cm-bar big"><div className="grow" style={{ width: `${Math.max(0, Math.min(100, after))}%`, background: color }} /></div>
        <b>{r0(after)}{suffix}</b>
      </div>
    </div>
  )
}
