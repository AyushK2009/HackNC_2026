import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type NeedDetail, type NeedSummary, type Report } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import { HARDSHIP_METRICS, type TractProps } from '../metrics'
import { accessScale, hardshipScale } from '../scale'
import { fmtInt } from '../format'
import { IconAccess, IconIndex, IconSpark } from '../icons'
import NeedPanel from './NeedPanel'
import { CatDot, catColor, CATEGORY_TEXT, countyBounds, esc, fipsOf, LegendBar, needPctScale, needValueScale, r0, replaceHash, useHashParams } from './common'

type Lens = 'need' | 'hardship' | 'access'
type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }
const NC_FOCUS: Focus = { key: 'nc', bounds: NC_BOUNDS, padding: [440, 20] }
const DAY = 86400000

const LENSES: { key: Lens; label: string }[] = [
  { key: 'need', label: 'Community need' },
  { key: 'hardship', label: 'Economic hardship' },
  { key: 'access', label: 'Service access' },
]

export default function NeedsMap() {
  const base = useBaseData()
  const params = useHashParams()
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [needsErr, setNeedsErr] = useState<string | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [lens, setLens] = useState<Lens>('need')
  const [cat, setCat] = useState<Category | 'overall'>('overall')
  const [showReports, setShowReports] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<NeedDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus>(NC_FOCUS)
  const [pulse, setPulse] = useState(false)
  const selRef = useRef<string | null>(null)

  const loadDetail = useCallback((g: string) => {
    setDetailErr(null)
    api.need(g).then((d) => {
      if (selRef.current === g) setDetail(d)
    }).catch((e) => {
      if (selRef.current === g) setDetailErr(String(e.message ?? e))
    })
  }, [])

  const refresh = useCallback((flash = false) => {
    api.needs().then((n) => {
      setNeeds(n.tracts)
      setNeedsErr(null)
      if (flash) {
        setPulse(true)
        window.setTimeout(() => setPulse(false), 1800)
      }
    }).catch((e) => setNeedsErr(String(e.message ?? e)))
    api.reports(undefined, 2000).then(setReports).catch(() => undefined)
    if (selRef.current) loadDetail(selRef.current)
  }, [loadDetail])

  useEffect(() => {
    refresh()
    return modelEvents.subscribe(() => refresh(true))
  }, [refresh])

  const select = useCallback((g: string | null) => {
    selRef.current = g
    setSelected(g)
    if (g) {
      setDetail((d) => (d?.geoid === g ? d : null))
      loadDetail(g)
      replaceHash(`#/map?geoid=${g}`)
    } else {
      setDetail(null)
      replaceHash('#/map')
    }
  }, [loadDetail])

  // '#/map?geoid=…' → zoom to that county and open the neighborhood.
  const qGeoid = params.get('geoid')
  useEffect(() => {
    if (!base || !qGeoid || !base.byId.has(qGeoid)) return
    const b = countyBounds(base, fipsOf(qGeoid), 0.9)
    if (b) setFocus({ key: `g-${qGeoid}-${Date.now()}`, bounds: b, padding: [440, 40] })
    select(qGeoid)
  }, [base, qGeoid, select])

  const props = useMemo(() => base?.tracts.features.map((f) => f.properties) ?? [], [base])
  const hScale = useMemo(() => hardshipScale(HARDSHIP_METRICS[0], props), [props])
  const aScale = useMemo(() => accessScale('percentile'), [])

  const recent = useMemo(() => {
    const cutoff = Date.now() - 90 * DAY
    return reports.filter((r) => new Date(r.created_at).getTime() >= cutoff)
  }, [reports])

  const markers: MapMarker[] = useMemo(
    () =>
      showReports
        ? reports.slice(0, 600).map((r) => ({
            id: r.id,
            lat: r.lat,
            lon: r.lon,
            color: catColor(r.primary),
            size: 10,
            tooltip: `<div class="tt-title">${esc(r.county)}</div><div class="tt-quote">${esc(r.summary || r.text.slice(0, 110))}</div><div class="tt-sub">${esc(CATEGORY_LABEL[r.primary] ?? '')} · click to open this neighborhood</div>`,
            onClick: () => select(r.geoid),
          }))
        : [],
    [reports, showReports, select],
  )

  if (!base) return <div className="cm-splash">Loading the map of North Carolina…</div>

  const fill = (p: TractProps): string | null => {
    if (lens === 'hardship') {
      if (p.status !== 'ok') return null
      return hScale.color(p.hardship_pct)
    }
    if (lens === 'access') {
      const row = base.access.tracts[p.geoid]
      return row ? aScale.color(row[5]) : null
    }
    const n = needs?.[p.geoid]
    if (!n) return null
    return cat === 'overall' ? needPctScale.color(n.pct) : needValueScale.color(n.by?.[cat])
  }

  const tooltip = (p: TractProps) => {
    const head = `<div class="tt-title">${esc(p.county)}</div>`
    if (lens === 'hardship')
      return head + `<div class="tt-row"><span>Hardship score</span><b>${p.status === 'ok' ? r0(p.hardship_pct) : 'Not scored'}</b></div>`
    if (lens === 'access') {
      const row = base.access.tracts[p.geoid]
      return head + `<div class="tt-row"><span>Access score</span><b>${row ? r0(row[5]) : 'No residents'}</b></div>`
    }
    const n = needs?.[p.geoid]
    if (!n) return head + `<div class="tt-row"><span>${needs ? 'No estimate' : 'Loading…'}</span></div>`
    const main = cat === 'overall'
      ? `<div class="tt-row"><span>Community need</span><b>${r0(n.pct)}</b></div><div class="tt-row"><span>Biggest gap</span><b>${esc(CATEGORY_LABEL[n.top] ?? n.top)}</b></div>`
      : `<div class="tt-row"><span>${esc(CATEGORY_LABEL[cat])} need</span><b>${r0(n.by?.[cat])}</b></div>`
    return head + main + (n.reports ? `<div class="tt-sub">${n.reports} resident report${n.reports > 1 ? 's' : ''} nearby</div>` : '')
  }

  const nHoods = needs ? Object.keys(needs).length : props.filter((p) => p.status === 'ok').length

  return (
    <div className={`cm-page cm-mapwrap ${pulse ? 'pulse' : ''}`}>
      <MapView tracts={base.tracts} fill={fill} tooltip={tooltip} selected={selected} onSelect={select} markers={markers} focus={focus} />

      <aside className="cm-card cm-left">
        <p className="ex-kicker">The shared model</p>
        <h2>Where is help needed most?</h2>
        <p className="cm-stats">
          <b>{fmtInt(nHoods)}</b> neighborhoods · <b>{fmtInt(recent.length)}</b> resident reports in the last 90 days
        </p>

        <div className="cm-tabs" role="tablist">
          {LENSES.map((l) => (
            <button key={l.key} role="tab" aria-selected={lens === l.key} className={lens === l.key ? 'on' : ''} onClick={() => setLens(l.key)}>
              {l.label}
            </button>
          ))}
        </div>

        {lens === 'need' && (
          <>
            <p className="ex-lead cm-lead">
              <b>Community need</b> starts from public data — economic hardship and how far people live from services — and is
              updated by what residents report. Recent, specific reports that neighbors confirm count more, and nearby
              neighborhoods are affected a little too.
            </p>
            <div className="ex-chips cm-catchips">
              <button className={`ex-chip ${cat === 'overall' ? 'on' : ''}`} onClick={() => setCat('overall')}>
                <IconIndex size={15} /> Overall
              </button>
              {CATEGORIES.map((c) => (
                <button key={c} className={`ex-chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? 'overall' : c)}>
                  <CatDot c={c} /> {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <p className="ex-explain cm-explain">
              {cat === 'overall' ? 'All six kinds of need combined, compared with every neighborhood in North Carolina.' : CATEGORY_TEXT[cat]}
            </p>
            <LegendBar
              bins={cat === 'overall' ? needPctScale.bins : needValueScale.bins}
              low="Less need"
              high="More need"
              note={cat === 'overall' ? 'Compared with all NC neighborhoods' : `${CATEGORY_LABEL[cat]} need, from 0 to 100`}
            />
            {needsErr && <p className="cm-error">The live model isn't reachable right now ({needsErr}). Try the other two views, which use public data only.</p>}
          </>
        )}
        {lens === 'hardship' && (
          <>
            <p className="ex-lead cm-lead">
              How hard it is for households to cover the basics, from poverty, income, SNAP use and car ownership. This is
              one of the two public-data starting points for community need.
            </p>
            <LegendBar bins={hScale.bins.map((b) => b.color)} low="Less hardship" high="More hardship" note="Compared with all NC neighborhoods" />
          </>
        )}
        {lens === 'access' && (
          <>
            <p className="ex-lead cm-lead">
              How close residents live to food assistance, health care, transit and libraries. Red means help is far away —
              the second public-data starting point for community need.
            </p>
            <LegendBar bins={aScale.bins.map((b) => b.color)} low="Farther from help" high="Closer to help" note="Compared with all NC neighborhoods" />
          </>
        )}

        <label className="cm-toggle">
          <input type="checkbox" checked={showReports} onChange={(e) => setShowReports(e.target.checked)} />
          <span className="cm-switch" />
          Show resident reports
        </label>
        {showReports && (
          <div className="cm-catkey">
            {CATEGORIES.map((c) => (
              <span key={c}><CatDot c={c} size={8} /> {CATEGORY_LABEL[c]}</span>
            ))}
          </div>
        )}
        <div className="cm-cta-row">
          <a className="cm-btn primary" href="#/report">Report a need</a>
          <a className="cm-btn" href="#/involved">Find ways to help</a>
        </div>
      </aside>

      {!selected && (
        <>
          <div className="cm-tip">Click any neighborhood to see why it's underserved</div>
          <div className="ex-how cm-how">
            <p className="ex-how-title">How community need is estimated</p>
            <div className="ex-how-flow">
              <div className="ex-how-inputs">
                <span className="ex-how-in"><IconIndex /> Hardship</span>
                <span className="ex-how-in"><IconAccess /> Distance to services</span>
                <span className="ex-how-in"><IconSpark /> Resident reports</span>
              </div>
              <span className="ex-how-arrow">→</span>
              <span className="ex-how-out">Community need</span>
            </div>
            <ol className="ex-how-points">
              <li>Public data gives every neighborhood a starting estimate for six kinds of need.</li>
              <li>Each resident report adds evidence where it was made, weighted by how recent, specific and confirmed it is.</li>
              <li>Finished projects lower the need in the places they reach — so the map keeps changing as people act.</li>
            </ol>
          </div>
        </>
      )}

      {selected && (
        <div className="cm-right">
          <NeedPanel geoid={selected} detail={detail} error={detailErr} onClose={() => select(null)} />
        </div>
      )}
    </div>
  )
}

