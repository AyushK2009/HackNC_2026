import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type NeedDetail, type NeedSummary, type Project, type Report } from '../shared/api'
import { useBaseData, type BaseData } from '../shared/baseData'
import PlacePicker from '../shared/PlacePicker'
import { shortCounty, usePlace, type Place } from '../shared/place'
import { HARDSHIP_METRICS, type TractProps } from '../metrics'
import { accessScale, hardshipScale } from '../scale'
import { fmtInt } from '../format'
import NeedPanel, { HowEstimated } from './NeedPanel'
import { CatDot, catColor, CATEGORY_TEXT, countyBounds, countyCenter, esc, fipsOf, LegendBar, needPctScale, needValueScale, r0, replaceHash, STATUS, useHashParams } from './common'

type Lens = 'need' | 'hardship' | 'access'
type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number]; paddingBR?: [number, number] }
// Room for the floating cards: left column (place + legend), right column (at a glance / neighborhood).
const PAD_TL: [number, number] = [356, 24]
const PAD_BR: [number, number] = [416, 24]
const NC_FOCUS: Focus = { key: 'nc', bounds: NC_BOUNDS, padding: PAD_TL, paddingBR: PAD_BR }
const DAY = 86400000
// Below this zoom (and with no county chosen) individual report dots are grouped by county.
const DOT_ZOOM = 9

const LENSES: { key: Lens; label: string }[] = [
  { key: 'need', label: 'Need' },
  { key: 'hardship', label: 'Hardship' },
  { key: 'access', label: 'Access' },
]

function tractBounds(base: BaseData, geoid: string): L.LatLngBounds | null {
  const f = base.tracts.features.find((x) => x.properties.geoid === geoid)
  return f ? L.geoJSON(f).getBounds() : null
}

export default function NeedsMap() {
  const base = useBaseData()
  const params = useHashParams()
  const [place, setPlace] = usePlace()
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [needsErr, setNeedsErr] = useState<string | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [lens, setLens] = useState<Lens>('need')
  const [cat, setCat] = useState<Category | 'overall'>('overall')
  const [showReports, setShowReports] = useState(true)
  const [showProjects, setShowProjects] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<NeedDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus>(NC_FOCUS)
  const [zoom, setZoom] = useState(7)
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
    api.projects().then(setProjects).catch(() => undefined)
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

  // The map's focus follows the shared place: fit that county, or the whole state.
  const fips = place?.fips ?? null
  const skipFit = useRef<string | null>(null)
  useEffect(() => {
    if (!base) return
    if (skipFit.current && skipFit.current === fips) {
      skipFit.current = null
      return
    }
    const b = fips ? countyBounds(base, fips) : null
    setFocus(b ? { key: `c-${fips}`, bounds: b, padding: PAD_TL, paddingBR: PAD_BR } : NC_FOCUS)
  }, [base, fips])

  // '#/map?geoid=…' → work in that county and open the neighborhood.
  const qGeoid = params.get('geoid')
  const selRefPlace = useRef<string | null>(fips)
  selRefPlace.current = fips
  useEffect(() => {
    if (!base || !qGeoid || !base.byId.has(qGeoid)) return
    const f = fipsOf(qGeoid)
    const c = base.access.counties.find((x) => x.fips === f)
    if (c && c.fips !== selRefPlace.current) {
      skipFit.current = c.fips
      setPlace({ fips: c.fips, name: c.name })
    }
    const b = tractBounds(base, qGeoid)
    if (b) setFocus({ key: `g-${qGeoid}-${Date.now()}`, bounds: b.pad(2.5), padding: PAD_TL, paddingBR: PAD_BR })
    select(qGeoid)
  }, [base, qGeoid, select, setPlace])

  const zoomTo = useCallback((g: string) => {
    if (!base) return
    const b = tractBounds(base, g)
    if (b) setFocus({ key: `t-${g}-${Date.now()}`, bounds: b.pad(1.2), padding: PAD_TL, paddingBR: PAD_BR })
    select(g)
  }, [base, select])

  const props = useMemo(() => base?.tracts.features.map((f) => f.properties) ?? [], [base])
  const hScale = useMemo(() => hardshipScale(HARDSHIP_METRICS[0], props), [props])
  const aScale = useMemo(() => accessScale('percentile'), [])

  const recent = useMemo(() => {
    const cutoff = Date.now() - 90 * DAY
    return reports.filter((r) => new Date(r.created_at).getTime() >= cutoff)
  }, [reports])

  const shownReports = useMemo(() => (cat === 'overall' ? reports : reports.filter((r) => r.primary === cat || r.categories?.includes(cat))), [reports, cat])
  const liveProjects = useMemo(() => projects.filter((p) => p.status !== 'complete'), [projects])
  const detailed = zoom >= DOT_ZOOM || !!place

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = []
    if (showReports && base) {
      const asDot = (r: Report) => zoom >= DOT_ZOOM || (!!fips && fipsOf(r.geoid) === fips)
      {
        for (const r of shownReports.filter(asDot).slice(0, 600))
          out.push({
            id: r.id,
            lat: r.lat,
            lon: r.lon,
            color: catColor(r.primary),
            size: 10,
            tooltip: `<div class="tt-title">${esc(r.county)}</div><div class="tt-quote">${esc(r.summary || r.text.slice(0, 110))}</div><div class="tt-sub">${esc(CATEGORY_LABEL[r.primary] ?? '')} · click to open this neighborhood</div>`,
            onClick: () => select(r.geoid),
          })
        // Zoomed out: other counties get one circle with how many people wrote in.
        const by = new Map<string, number>()
        for (const r of shownReports) if (!asDot(r)) by.set(fipsOf(r.geoid), (by.get(fipsOf(r.geoid)) ?? 0) + 1)
        for (const [f, n] of by) {
          const c = countyCenter(base, f)
          const co = base.access.counties.find((x) => x.fips === f)
          if (!c || !co) continue
          const size = Math.round(16 + Math.min(14, Math.sqrt(n) * 2.8))
          out.push({
            id: `agg-${f}`,
            lat: c[0],
            lon: c[1],
            color: '#18191b',
            size,
            html: `<div class="cm-agg" style="width:${size}px;height:${size}px">${n}</div>`,
            tooltip: `<div class="tt-title">${esc(co.name)}</div><div class="tt-sub">${n} resident report${n > 1 ? 's' : ''} · click to look closer</div>`,
            onClick: () => setPlace({ fips: co.fips, name: co.name }),
          })
        }
      }
    }
    if (showProjects)
      for (const p of liveProjects)
        out.push({
          id: `p-${p.id}`,
          lat: p.lat,
          lon: p.lon,
          color: catColor(p.categories[0] ?? 'food'),
          size: 22,
          html: `<div class="cm-pin" style="background:${catColor(p.categories[0] ?? 'food')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M5 12l4 4 10-10"/></svg></div>`,
          tooltip: `<div class="tt-title">${esc(p.title)}</div><div class="tt-sub">${esc(STATUS[p.status] ?? p.status)} · ${esc(p.county)} · click for the project</div>`,
          onClick: () => {
            window.location.hash = `#/projects?id=${p.id}`
          },
        })
    return out
  }, [base, shownReports, showReports, showProjects, liveProjects, zoom, fips, select, setPlace])

  const fade = useCallback((p: TractProps) => !!fips && fipsOf(p.geoid) !== fips, [fips])

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
    return head + main + (n.reports ? `<div class="tt-sub">${n.reports} resident report${n.reports > 1 ? 's' : ''} nearby</div>` : '') + '<div class="tt-sub">Click to see why</div>'
  }

  const placeReports = fips ? recent.filter((r) => fipsOf(r.geoid) === fips).length : recent.length

  return (
    <div className={`cm-page cm-mapwrap cm-needs ${pulse ? 'pulse' : ''}`}>
      <MapView tracts={base.tracts} fill={fill} tooltip={tooltip} selected={selected} onSelect={select} markers={markers} focus={focus} fade={fade} onZoom={setZoom} />

      <section className="cm-card cm-focus">
        <h1>Where is help needed most?</h1>
        <PlacePicker label="Showing" className="cm-focus-pick" />
      </section>

      <section className="cm-card cm-key" aria-label="What you're seeing">
        <p className="cm-key-title">What you're seeing</p>

        <div className="cm-key-row">
          <span className="cm-key-sw areas" />
          <div className="cm-key-body">
            <div className="cm-key-head">
              <b>Shaded areas</b>
              <div className="cm-seg cm-key-seg" role="tablist" aria-label="Shade the map by">
                {LENSES.map((l) => (
                  <button key={l.key} role="tab" aria-selected={lens === l.key} className={lens === l.key ? 'on' : ''} onClick={() => setLens(l.key)}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            {lens === 'need' && (
              <>
                <p className="cm-key-text">
                  {cat === 'overall' ? 'Estimated need, from hardship, distance to services and resident reports.' : CATEGORY_TEXT[cat]}
                </p>
                <LegendBar bins={cat === 'overall' ? needPctScale.bins : needValueScale.bins} low="Less need" high="More need" />
              </>
            )}
            {lens === 'hardship' && (
              <>
                <p className="cm-key-text">How hard it is to cover the basics: poverty, income, SNAP use, car ownership.</p>
                <LegendBar bins={hScale.bins.map((b) => b.color)} low="Less hardship" high="More hardship" />
              </>
            )}
            {lens === 'access' && (
              <>
                <p className="cm-key-text">How close people live to food help, clinics, transit and libraries.</p>
                <LegendBar bins={aScale.bins.map((b) => b.color)} low="Farther from help" high="Closer to help" />
              </>
            )}
          </div>
        </div>

        <div className="cm-key-chips" role="group" aria-label="Kind of need">
          <button className={`cm-kchip ${cat === 'overall' ? 'on' : ''}`} onClick={() => setCat('overall')}>All</button>
          {CATEGORIES.map((c) => (
            <button key={c} className={`cm-kchip ${cat === c ? 'on' : ''}`} onClick={() => { setCat(cat === c ? 'overall' : c); setLens('need') }}>
              <CatDot c={c} size={8} /> {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <label className="cm-key-row toggle">
          <span className="cm-key-sw dots"><i /><i /><i /></span>
          <span className="cm-key-body">
            <b>{detailed ? 'Dots' : 'Circles'}: resident reports</b>
            <span className="cm-key-text">
              {!showReports
                ? 'Hidden.'
                : detailed
                  ? 'Colored by kind. They cluster where more people have written in.'
                  : `How many people wrote in from each county. Pick a county or zoom in to see all ${fmtInt(shownReports.length)}.`}
            </span>
          </span>
          <input type="checkbox" checked={showReports} onChange={(e) => setShowReports(e.target.checked)} />
          <span className="cm-switch" />
        </label>

        {liveProjects.length > 0 && (
          <label className="cm-key-row toggle">
            <span className="cm-key-sw pin" />
            <span className="cm-key-body">
              <b>Pins: projects in the works</b>
              <span className="cm-key-text">{liveProjects.length} planned or underway. Click one to follow it.</span>
            </span>
            <input type="checkbox" checked={showProjects} onChange={(e) => setShowProjects(e.target.checked)} />
            <span className="cm-switch" />
          </label>
        )}
        {needsErr && <p className="cm-error">The live estimate isn't reachable right now ({needsErr}). Hardship and Access still work.</p>}
      </section>

      {!selected && (
        <>
          <div className="cm-tip2">Click any shaded area to see what's behind it</div>
          <aside className="cm-drawer">
            <AtAGlance
              base={base}
              place={place}
              needs={needs}
              reports={placeReports}
              projects={liveProjects}
              pulse={pulse}
              cat={cat}
              onPickTract={zoomTo}
              onPickCounty={(p) => setPlace(p)}
            />
          </aside>
        </>
      )}

      {selected && (
        <aside className="cm-drawer" key={selected}>
          <NeedPanel geoid={selected} detail={detail} error={detailErr} onClose={() => select(null)} />
        </aside>
      )}
    </div>
  )
}

type Agg = { pct: number; by: Record<Category, number>; pop: number; n: number }

function aggregate(base: BaseData, needs: Record<string, NeedSummary>, keep: (g: string) => boolean): Agg {
  let pop = 0, pct = 0, n = 0
  const by = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  for (const [g, s] of Object.entries(needs)) {
    if (!keep(g)) continue
    const w = Math.max(1, base.byId.get(g)?.pop ?? 1)
    pop += w
    n++
    pct += s.pct * w
    for (const c of CATEGORIES) by[c] += (s.by?.[c] ?? 0) * w
  }
  if (!pop) return { pct: 0, by, pop: 0, n: 0 }
  for (const c of CATEGORIES) by[c] /= pop
  return { pct: pct / pop, by, pop, n }
}

function AtAGlance({ base, place, needs, reports, projects, pulse, cat, onPickTract, onPickCounty }: {
  base: BaseData
  place: Place
  needs: Record<string, NeedSummary> | null
  reports: number
  projects: Project[]
  pulse: boolean
  cat: Category | 'overall'
  onPickTract: (g: string) => void
  onPickCounty: (p: Place) => void
}) {
  const fips = place?.fips ?? null
  const here = useMemo(() => (needs ? aggregate(base, needs, (g) => !fips || fipsOf(g) === fips) : null), [base, needs, fips])
  const state = useMemo(() => (needs ? aggregate(base, needs, () => true) : null), [base, needs])

  // Ranked by overall need, or by the kind picked in the legend.
  const top = useMemo(() => {
    if (!needs) return []
    const scaleOf = cat === 'overall' ? needPctScale : needValueScale
    if (fips)
      return Object.entries(needs)
        .filter(([g]) => fipsOf(g) === fips)
        .map(([g, s]) => ({ g, s, v: cat === 'overall' ? s.pct : (s.by?.[cat] ?? 0) }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 5)
        .map(({ g, s, v }) => ({ key: g, v, color: scaleOf.color(v), title: `Neighborhood of ${fmtInt(base.byId.get(g)?.pop ?? 0)}`, sub: `Biggest gap: ${CATEGORY_LABEL[s.top] ?? s.top}` }))
    return base.access.counties
      .map((c) => ({ c, a: aggregate(base, needs, (g) => fipsOf(g) === c.fips) }))
      .filter((x) => x.a.n > 0)
      .map((x) => ({ ...x, v: cat === 'overall' ? x.a.pct : x.a.by[cat] }))
      .sort((x, y) => y.v - x.v)
      .slice(0, 5)
      .map(({ c, a, v }) => {
        const k = [...CATEGORIES].sort((p, q) => a.by[q] - a.by[p])[0]
        return { key: c.fips, v, color: scaleOf.color(v), title: c.name, sub: `Biggest gap: ${CATEGORY_LABEL[k]}` }
      })
  }, [base, needs, fips, cat])

  const placeProjects = fips ? projects.filter((p) => fipsOf(p.geoid) === fips) : projects
  const kinds = here ? [...CATEGORIES].sort((a, b) => here.by[b] - here.by[a]).slice(0, 3) : []
  const name = place?.name ?? 'North Carolina'

  return (
    <div className="cm-glance">
      <p className="cm-panel-kicker">At a glance</p>
      <h2 className="cm-glance-name">{name}</h2>
      {here && <p className="cm-muted">{fmtInt(here.pop)} residents · {fmtInt(here.n)} neighborhoods</p>}

      {!here ? (
        <>
          <div className="cm-skel" />
          <div className="cm-skel short" />
        </>
      ) : (
        <>
          {fips && (
            <div className="cm-hero">
              <div className="cm-hero-num" style={{ background: needPctScale.color(here.pct) }}>{r0(here.pct)}</div>
              <div>
                <b>Need score</b>
                <span>The typical resident lives somewhere with more need than {r0(here.pct)}% of NC</span>
              </div>
            </div>
          )}

          <div className={`cm-glance-stats ${pulse ? 'flash' : ''}`}>
            <div><b>{fmtInt(reports)}</b><span>reports in the last 90 days</span></div>
            <div><b>{placeProjects.length}</b><span>project{placeProjects.length === 1 ? '' : 's'} in the works</span></div>
          </div>

        </>
      )}

      <div className="cm-glance-tasks">
        <a className="cm-btn primary" href="#/report">Report a need here</a>
        <a className="cm-btn" href="#/involved">Find ways to help</a>
        <a className="cm-btn" href={fips ? `#/plan?county=${fips}` : '#/plan'}>{fips ? `Plan services for ${shortCounty(name)}` : 'Plan services'}</a>
      </div>

      {here && (
        <>
          <h4 className="cm-h4">Biggest needs</h4>
          <ul className="cm-glance-kinds">
            {kinds.map((c) => (
              <li key={c}>
                <span><CatDot c={c} /> {CATEGORY_LABEL[c]}</span>
                <div className="cm-bar"><div style={{ width: `${Math.round(here.by[c])}%`, background: catColor(c) }} /></div>
                <b>{r0(here.by[c])}</b>
                {fips && state && <em>NC {r0(state.by[c])}</em>}
              </li>
            ))}
          </ul>

          <h4 className="cm-h4">{cat === 'overall' ? 'Where need is highest' : `Where ${CATEGORY_LABEL[cat].toLowerCase()} need is highest`}</h4>
          <ol className="cm-glance-top">
            {top.map((t) => (
              <li key={t.key}>
                <button
                  onClick={() => {
                    if (fips) onPickTract(t.key)
                    else {
                      const c = base.access.counties.find((x) => x.fips === t.key)
                      if (c) onPickCounty({ fips: c.fips, name: c.name })
                    }
                  }}
                >
                  <i style={{ background: t.color }}>{r0(t.v)}</i>
                  <span><b>{t.title}</b><em>{t.sub}</em></span>
                  <span className="cm-go" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      <details className="cm-more">
        <summary>How need is estimated</summary>
        <HowEstimated />
      </details>
    </div>
  )
}
