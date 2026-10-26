import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import { api, CATEGORIES, CATEGORY_LABEL, type Category, type NeedSummary, type Project, type RankedOpportunity } from '../shared/api'
import { modelEvents } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import PlacePicker from '../shared/PlacePicker'
import { usePlace, shortCounty } from '../shared/place'
import type { TractProps } from '../metrics'
import { fmtInt } from '../format'
import { as01, Bar, CatDot, catColor, clamp01, countyCenter, countyNameOf, esc, fipsOf, loadLS, loadLSArray, r0, replaceHash, saveLS, softNeedColor, useHashParams } from './common'
import './involved.css'

const SKILLS = ['driving', 'cooking', 'tutoring', 'Spanish', 'nursing/health', 'tech help', 'childcare', 'legal', 'construction', 'logistics', 'data entry', 'event setup']
// Chip label → the words organizations use for that skill (sent to the matcher).
const SKILL_TERMS: Record<string, string[]> = {
  driving: ['driving', 'reliable car'],
  cooking: ['cooking', 'packing'],
  tutoring: ['tutoring', 'teaching'],
  Spanish: ['spanish'],
  'nursing/health': ['nursing', 'health'],
  'tech help': ['tech support', 'computer repair'],
  childcare: ['childcare'],
  legal: ['legal', 'paralegal'],
  construction: ['construction', 'carpentry'],
  logistics: ['logistics', 'organizing', 'lifting', 'packing'],
  'data entry': ['data entry', 'scheduling'],
  'event setup': ['event setup', 'lifting', 'organizing'],
}
const termsFor = (skills: string[]) => [...new Set(skills.flatMap((k) => SKILL_TERMS[k] ?? [k.toLowerCase()]))]

const HOURS = [2, 4, 8, 12] // per month; 12 means "12 or more"
const RADII = [5, 10, 25, 50]
const KINDS: { key: Kind; label: string }[] = [
  { key: 'all', label: 'Any' },
  { key: 'event', label: 'One-time' },
  { key: 'ongoing', label: 'Ongoing' },
  { key: 'remote', label: 'Remote' },
]
const CHIP: Record<Category, string> = { food: 'Food', health: 'Health', transit: 'Transit', digital: 'Internet', housing: 'Housing', childcare: 'Childcare' }
const NEED_WORD: Record<Category, string> = { food: 'Food', health: 'Health care', transit: 'Transportation', digital: 'Internet access', housing: 'Housing', childcare: 'Childcare' }
const PARTS: { key: keyof RankedOpportunity['parts']; label: string }[] = [
  { key: 'need', label: 'Need there' },
  { key: 'relevance', label: 'Fits your skills' },
  { key: 'distance', label: 'Close to you' },
  { key: 'availability', label: 'Fits your time' },
]
const NC_CENTER: [number, number] = [35.55, -79.4]
const PROFILE_KEY = 'allocate.volunteer'
const SIGNUPS_KEY = 'allocate.signups'

type Kind = 'all' | 'event' | 'ongoing' | 'remote'
type Profile = { name: string; skills: string[]; interests: Category[]; hours: number; radius: number; kind: Kind; q: string }
const DEFAULTS: Profile = { name: '', skills: [], interests: [], hours: 4, radius: 25, kind: 'all', q: '' }
type Signup = { id: string; title: string; org: string; county: string; category: Category; hours: number; project_id: string | null; project_title: string | null; at: string }
type Done = { ok: boolean; text: string; project_id: string | null }
type Opp = RankedOpportunity & { match?: number }

const snap = (v: number, opts: number[]) => opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), opts[0])
function loadProfile(): Profile {
  const p = loadLS<Profile>(PROFILE_KEY, DEFAULTS)
  return {
    ...DEFAULTS,
    name: typeof p.name === 'string' ? p.name : '',
    skills: Array.isArray(p.skills) ? p.skills : [],
    interests: Array.isArray(p.interests) ? p.interests.filter((c) => CATEGORIES.includes(c)) : [],
    hours: snap(Number(p.hours) || 4, HOURS),
    radius: snap(Number(p.radius) || 25, RADII),
    kind: KINDS.some((k) => k.key === p.kind) ? p.kind : 'all',
    q: typeof p.q === 'string' ? p.q : '',
  }
}

// The server's "why" starts with the need sentence, which we show on its own line.
function whyLine(o: Opp): string {
  const parts = (o.why || '').split('; ').filter((s) => s && !/^need for /i.test(s)).map((s) => (s === 'remote' ? 'you can do this from home' : s))
  const s = parts.join(' · ')
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}
const needLine = (o: Opp) => `${NEED_WORD[o.category] ?? CATEGORY_LABEL[o.category]} need where this helps is higher than ${Math.min(99, Math.round(as01(o.parts?.need) * 100))}% of North Carolina`
const spotsLeft = (o: Opp) => Math.max(0, o.spots - o.filled)

export default function Involved() {
  const base = useBaseData()
  const params = useHashParams()
  const [place, setPlace] = usePlace()
  const [profile, setProfile] = useState<Profile>(loadProfile)
  const [signups, setSignups] = useState<Signup[]>(() => loadLSArray<Signup>(SIGNUPS_KEY))
  const [items, setItems] = useState<Opp[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hood, setHood] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [form, setForm] = useState<string | null>(null)
  const [joining, setJoining] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, Done>>({})
  const [why, setWhy] = useState<Set<string>>(new Set())
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(() => profile.kind !== 'all' || !!profile.q)
  const [qDraft, setQDraft] = useState(profile.q)
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [nameMissing, setNameMissing] = useState(false)
  const skillsRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)

  useEffect(() => saveLS(PROFILE_KEY, profile), [profile])
  useEffect(() => saveLS(SIGNUPS_KEY, signups), [signups])
  const set = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }))

  useEffect(() => {
    const load = () => api.needs().then((n) => setNeeds(n.tracts)).catch(() => undefined)
    load()
    return modelEvents.subscribe(load)
  }, [])

  // '#/involved?geoid=…' ranks from that neighborhood and moves the shared place to its county.
  const qGeoid = params.get('geoid')
  useEffect(() => {
    if (!base || !qGeoid || !base.byId.has(qGeoid)) return
    setHood(qGeoid)
    const f = fipsOf(qGeoid)
    if (place?.fips !== f) {
      const c = base.access.counties.find((x) => x.fips === f)
      if (c) setPlace({ fips: c.fips, name: c.name })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, qGeoid])

  // Search text waits for a pause in typing.
  useEffect(() => {
    if (qDraft === profile.q) return
    const t = window.setTimeout(() => set({ q: qDraft }), 350)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft])

  useEffect(() => {
    if (!skillsOpen) return
    const off = (e: MouseEvent) => {
      if (!skillsRef.current?.contains(e.target as Node)) setSkillsOpen(false)
    }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [skillsOpen])

  const home = useMemo((): [number, number] | null => {
    if (!base) return null
    if (hood && base.centroid.has(hood)) return base.centroid.get(hood)!
    return place ? countyCenter(base, place.fips) : null
  }, [base, hood, place])

  const areaName = hood && base ? `a neighborhood in ${shortCounty(countyNameOf(base, hood))} County` : place ? place.name : 'North Carolina'

  // Ask the ranker whenever anything that changes the ranking changes.
  const skillKey = profile.skills.join('|')
  const intKey = profile.interests.join('|')
  useEffect(() => {
    if (!base) return
    const id = ++reqId.current
    setBusy(true)
    setErr(null)
    const at = home ?? NC_CENTER
    api
      .opportunities({ lat: at[0], lon: at[1], skills: termsFor(profile.skills), interests: profile.interests, hours: profile.hours, radius: home ? profile.radius : 600, q: profile.q || undefined })
      .then((r) => {
        if (id !== reqId.current) return
        setItems(Array.isArray(r) ? r : r.items ?? [])
      })
      .catch((e) => id === reqId.current && setErr(String((e as Error).message ?? e)))
      .finally(() => id === reqId.current && setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, home, skillKey, intKey, profile.hours, profile.radius, profile.q])

  // What the person sees: the ranked list narrowed by their choices.
  const passes = (o: Opp, p: Profile) => {
    if (p.interests.length && !p.interests.includes(o.category)) return false
    if (p.hours < 12 && o.hours > p.hours) return false
    if (p.kind !== 'all' && o.kind !== p.kind) return false
    if (p.q.trim()) {
      const s = p.q.trim().toLowerCase()
      const hay = [o.title, o.org, o.description, o.county, ...o.skills].join(' ').toLowerCase()
      if (!s.split(/\s+/).every((w) => hay.includes(w))) return false
    }
    return true
  }
  const shown = useMemo(() => (items ?? []).filter((o) => passes(o, profile)), [items, profile])
  const best = Math.max(1e-9, ...shown.map((o) => o.score || 0))
  const matchPct = (o: Opp) => Math.round((o.match != null && shown[0] && items?.[0]?.id === shown[0].id ? o.match : clamp01((o.score || 0) / best)) * 100)

  const signup = async (o: Opp) => {
    const name = profile.name.trim()
    if (!name) return setNameMissing(true)
    setJoining(o.id)
    try {
      const mine = termsFor(profile.skills)
      const r = await api.signup(o.id, name, mine, profile.hours)
      const opp = r.opportunity
      const project: Project | undefined = r.project
      const pid = o.project_id ?? project?.id ?? null
      setSignups((prev) => [
        { id: o.id, title: o.title, org: o.org, county: o.county, category: o.category, hours: o.hours, project_id: pid, project_title: project?.title ?? null, at: new Date().toISOString() },
        ...prev.filter((x) => x.id !== o.id),
      ])
      const left = Math.max(0, (opp?.spots ?? o.spots) - (opp?.filled ?? o.filled + 1))
      const tail = project
        ? `${project.title} is now ${r0(project.progress)}% staffed and ready.`
        : left > 0 ? `${left} spot${left > 1 ? 's' : ''} still open — share it with a friend.` : 'You took the last open spot.'
      setDone((d) => ({ ...d, [o.id]: { ok: true, text: `${o.org} will expect you: ${o.when}. ${tail}`, project_id: pid } }))
      setItems((prev) => prev?.map((x) => (x.id === o.id ? { ...x, filled: opp?.filled ?? x.filled + 1, spots: opp?.spots ?? x.spots } : x)) ?? prev)
      setForm(null)
      modelEvents.emit()
    } catch (e) {
      setDone((d) => ({ ...d, [o.id]: { ok: false, text: `Couldn't sign you up: ${(e as Error).message}`, project_id: null } }))
    } finally {
      setJoining(null)
    }
  }

  const focus = useMemo(() => {
    if (home) return { key: `a-${home.join(',')}-${profile.radius}`, bounds: L.latLng(home[0], home[1]).toBounds(profile.radius * 1609.344 * 2.1), padding: [12, 12] as [number, number] }
    return { key: 'nc', bounds: NC_BOUNDS, padding: [10, 10] as [number, number] }
  }, [home, profile.radius])

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = shown.slice(0, 30).map((o, i) => {
      const on = o.id === active || o.id === hover
      const size = on ? 30 : 22
      return {
        id: o.id,
        lat: o.lat,
        lon: o.lon,
        color: catColor(o.category),
        size,
        html: `<div class="mk cm-mk ${on ? 'on' : ''}" style="width:${size}px;height:${size}px;background:${catColor(o.category)}">${i + 1}</div>`,
        tooltip: `<div class="tt-title">${esc(o.title)}</div><div class="tt-sub">${esc(o.org)} · ${o.kind === 'remote' ? 'remote, helps ' : ''}${esc(o.county)}</div>`,
        onClick: () => {
          setActive(o.id)
          document.getElementById(`opp-${o.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        },
      }
    })
    if (home) out.push({ id: 'home', lat: home[0], lon: home[1], color: '#18191b', size: 16, ringMi: profile.radius, tooltip: `<div class="tt-title">You</div><div class="tt-sub">Dashed circle: ${profile.radius} miles</div>`, html: '<div class="mk cm-home"></div>' })
    return out
  }, [shown, active, hover, home, profile.radius])

  const fill = useMemo(
    () => (p: TractProps) => {
      if (p.geoid === hood) return '#18191b'
      if (place && fipsOf(p.geoid) !== place.fips) return '#f2efe9'
      const n = needs?.[p.geoid]
      return n ? softNeedColor(n.pct) : '#f2efe9'
    },
    [needs, hood, place],
  )

  if (!base) return <div className="inv-page"><div className="inv-wrap"><div className="cm-skel tall" /></div></div>

  const signedUp = new Set(signups.map((s) => s.id))
  const hoursPledged = signups.reduce((t, s) => t + (s.hours || 0), 0)
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  // One-click ways out of an empty list, each with how many it would bring back.
  const fixes: { label: string; n: number | null; apply: () => void }[] = []
  if (items && !shown.length) {
    const count = (p: Partial<Profile>) => items.filter((o) => passes(o, { ...profile, ...p })).length
    if (profile.interests.length) fixes.push({ label: 'Show every cause', n: count({ interests: [] }), apply: () => set({ interests: [] }) })
    if (profile.hours < 12) fixes.push({ label: 'Allow more time', n: count({ hours: 12 }), apply: () => set({ hours: 12 }) })
    if (profile.kind !== 'all') fixes.push({ label: 'Any kind of role', n: count({ kind: 'all' }), apply: () => set({ kind: 'all' }) })
    if (profile.q) fixes.push({ label: 'Clear the search', n: count({ q: '' }), apply: () => { set({ q: '' }); setQDraft('') } })
    const all = count({ interests: [], hours: 12, kind: 'all', q: '' })
    if (fixes.filter((f) => f.n).length !== 1 && all > 0 && fixes.length > 1) fixes.push({ label: 'Clear all filters', n: all, apply: () => { set({ interests: [], hours: 12, kind: 'all', q: '' }); setQDraft('') } })
    for (let i = fixes.length - 1; i >= 0; i--) if (!fixes[i].n) fixes.splice(i, 1)
    if (home && profile.radius < 50) fixes.unshift({ label: 'Widen to 50 miles', n: null, apply: () => set({ radius: 50 }) })
  }
  const andJoin = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(''))
  const reasons = [
    profile.interests.length ? `${profile.interests.map((c) => CATEGORY_LABEL[c].toLowerCase()).join(' or ')}` : null,
    profile.hours < 12 ? `${profile.hours} hours or less` : null,
    profile.kind !== 'all' ? `${KINDS.find((k) => k.key === profile.kind)?.label.toLowerCase()} roles` : null,
    profile.q ? `“${profile.q}”` : null,
  ].filter((x): x is string => !!x)

  const [top, ...rest] = shown
  const nMore = (profile.kind !== 'all' ? 1 : 0) + (profile.q ? 1 : 0) + (home && profile.radius !== DEFAULTS.radius ? 1 : 0)

  const card = (o: Opp, i: number, featured: boolean) => {
    const left = spotsLeft(o)
    const mine = signedUp.has(o.id)
    const d = done[o.id]
    const open = form === o.id
    const showWhy = featured || why.has(o.id)
    const w = whyLine(o)
    return (
      <article
        key={o.id}
        id={`opp-${o.id}`}
        className={`inv-card ${featured ? 'featured' : ''} ${o.id === active ? 'on' : ''}`}
        onMouseEnter={() => setHover(o.id)}
        onMouseLeave={() => setHover(null)}
        onClick={() => setActive(o.id)}
      >
        {featured && <p className="inv-kicker">Best match for you</p>}
        <div className="inv-card-top">
          {!featured && <span className="inv-rank" style={{ background: catColor(o.category) }}>{i + 1}</span>}
          <div className="inv-card-title">
            <h3>{o.title}</h3>
            <span className="inv-org">{o.org}</span>
          </div>
          <div className="inv-match" title="How well this fits you, compared with your best match">
            <b>{matchPct(o)}%</b>
            <span>match</span>
          </div>
        </div>
        {featured && o.description && <p className="inv-desc">{o.description}</p>}
        {w && <p className="inv-why">{w}</p>}
        <p className="inv-need"><CatDot c={o.category} /> {needLine(o)}</p>
        <ul className="inv-meta">
          <li>{o.when}</li>
          <li>{o.kind === 'remote' ? `Helps ${o.county}` : `${o.county}${Number.isFinite(o.distance_mi) ? ` · ${o.distance_mi.toFixed(1)} mi` : ''}`}</li>
          <li>{o.hours} hours</li>
          <li className={left <= 2 ? 'hot' : ''}>{left} of {o.spots} spots left</li>
        </ul>
        {showWhy && (
          <div className="inv-parts">
            {PARTS.map((pt) => (
              <div key={pt.key}>
                <span>{pt.label}</span>
                <Bar value={as01(o.parts?.[pt.key])} color={featured ? catColor(o.category) : '#4b4f56'} height={4} />
              </div>
            ))}
          </div>
        )}

        {d?.ok ? (
          <div className="inv-done" onClick={(e) => e.stopPropagation()}>
            <b>You're signed up{profile.name ? `, ${profile.name.trim()}` : ''}.</b>
            <p>{d.text}</p>
            <div className="inv-done-links">
              {d.project_id && <a className="cm-btn small primary" href={`#/projects?id=${d.project_id}`}>See the project</a>}
              <a className="cm-link" href={`#/map?geoid=${o.geoid}`}>See the need there</a>
            </div>
          </div>
        ) : open ? (
          <form
            className="inv-form"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              signup(o)
            }}
          >
            <label>
              <span>Your first name</span>
              <input
                autoFocus
                className={`cm-input ${nameMissing && !profile.name.trim() ? 'warn' : ''}`}
                value={profile.name}
                placeholder="So the organizer knows who's coming"
                onChange={(e) => { set({ name: e.target.value }); setNameMissing(false) }}
              />
            </label>
            <button className="cm-btn primary" type="submit" disabled={joining === o.id}>{joining === o.id ? 'Signing up…' : 'Confirm'}</button>
            <button className="cm-btn ghost" type="button" onClick={() => setForm(null)}>Cancel</button>
            {nameMissing && !profile.name.trim() && <em className="inv-warn">Add your first name to sign up.</em>}
            {d && !d.ok && <em className="inv-warn">{d.text}</em>}
          </form>
        ) : (
          <div className="inv-actions" onClick={(e) => e.stopPropagation()}>
            {mine ? (
              <span className="inv-signed">You're signed up</span>
            ) : (
              <button className={`cm-btn primary ${featured ? '' : 'small'}`} disabled={left === 0} onClick={() => { setForm(o.id); setActive(o.id) }}>
                {left === 0 ? 'Full' : 'Sign up'}
              </button>
            )}
            <a className="cm-link" href={`#/map?geoid=${o.geoid}`}>See the need there</a>
            {o.url && <a className="cm-link" href={o.url} target="_blank" rel="noreferrer">Details</a>}
            {!featured && (
              <button className="cm-link inv-whybtn" onClick={() => setWhy((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n })}>
                {why.has(o.id) ? 'Hide why' : 'Why this rank?'}
              </button>
            )}
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="inv-page">
      <div className="inv-wrap">
        <header className="inv-head">
          <h1>Find ways to help</h1>
          <p>Ranked by where need is highest and what fits you.</p>
        </header>

        <section className="inv-about" aria-label="About you">
          <div className="inv-ctl where">
            <span className="inv-lab">Where</span>
            <PlacePicker placeholder="Type your county" onPick={() => { setHood(null); if (qGeoid) replaceHash('#/involved') }} />
            {hood && (
              <span className="inv-hood">
                Near your neighborhood
                <button aria-label="Use the whole county" onClick={() => { setHood(null); replaceHash('#/involved') }}>×</button>
              </span>
            )}
          </div>
          <div className="inv-ctl">
            <span className="inv-lab">What you care about</span>
            <div className="inv-chips">
              <button className={`inv-chip ${profile.interests.length ? '' : 'on'}`} onClick={() => set({ interests: [] })}>Any</button>
              {CATEGORIES.map((c) => {
                const on = profile.interests.includes(c)
                return (
                  <button key={c} className={`inv-chip ${on ? 'on' : ''}`} onClick={() => set({ interests: toggle(profile.interests, c) })}>
                    <CatDot c={c} size={8} /> {CHIP[c]}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="inv-ctl">
            <span className="inv-lab">Time per month</span>
            <div className="inv-seg">
              {HOURS.map((h) => (
                <button key={h} className={profile.hours === h ? 'on' : ''} onClick={() => set({ hours: h })}>{h === 12 ? '12+ h' : `${h} h`}</button>
              ))}
            </div>
          </div>
          <div className="inv-ctl inv-skills" ref={skillsRef}>
            <span className="inv-lab">Skills</span>
            <button className={`inv-skillbtn ${skillsOpen ? 'open' : ''} ${profile.skills.length ? 'has' : ''}`} onClick={() => setSkillsOpen((v) => !v)} aria-expanded={skillsOpen} title={profile.skills.join(', ') || undefined}>
              {profile.skills.length ? `${profile.skills.length} skill${profile.skills.length > 1 ? 's' : ''}` : '+ Skills'}
            </button>
            {skillsOpen && (
              <div className="inv-pop" role="dialog" aria-label="Your skills">
                <p>Pick anything you're good at. Matching roles move up.</p>
                <div className="inv-chips wrap">
                  {SKILLS.map((k) => (
                    <button key={k} className={`inv-chip ${profile.skills.includes(k) ? 'on' : ''}`} onClick={() => set({ skills: toggle(profile.skills, k) })}>{k}</button>
                  ))}
                </div>
                <div className="inv-pop-foot">
                  {profile.skills.length > 0 && <button className="cm-link" onClick={() => set({ skills: [] })}>Clear</button>}
                  <button className="cm-btn small primary" onClick={() => setSkillsOpen(false)}>Done</button>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="inv-bar">
          <h2>
            {items === null ? 'Finding matches…' : `${shown.length} way${shown.length === 1 ? '' : 's'} to help ${home ? `near ${areaName}` : 'across North Carolina'}`}
            {busy && items !== null && <span className="inv-busy">updating</span>}
          </h2>
          <button className={`inv-morebtn ${moreOpen ? 'open' : ''}`} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
            More filters{nMore ? ` (${nMore})` : ''} <span aria-hidden>{moreOpen ? '▴' : '▾'}</span>
          </button>
        </div>
        {moreOpen && (
          <div className="inv-more">
            <div className="inv-ctl">
              <span className="inv-lab">Distance</span>
              <div className="inv-seg" title={home ? undefined : 'Choose a county to limit distance'}>
                {RADII.map((r) => (
                  <button key={r} disabled={!home} className={profile.radius === r ? 'on' : ''} onClick={() => set({ radius: r })}>{r} mi</button>
                ))}
              </div>
            </div>
            <div className="inv-ctl">
              <span className="inv-lab">Kind</span>
              <div className="inv-seg">
                {KINDS.map((k) => (
                  <button key={k.key} className={profile.kind === k.key ? 'on' : ''} onClick={() => set({ kind: k.key })}>{k.label}</button>
                ))}
              </div>
            </div>
            <div className="inv-ctl grow">
              <span className="inv-lab">Search</span>
              <input className="cm-input inv-search" value={qDraft} placeholder="Organization, role or skill" onChange={(e) => setQDraft(e.target.value)} />
            </div>
          </div>
        )}

        <div className="inv-grid">
          <main className="inv-list">
            {err && <p className="cm-error">Couldn't load opportunities: {err}</p>}
            {items === null && !err && <><div className="cm-skel tall" /><div className="cm-skel tall" /><div className="cm-skel tall" /></>}
            {items !== null && !shown.length && (
              <div className="inv-empty">
                <h3>Nothing matches all of that yet</h3>
                <p>
                  {reasons.length
                    ? <>No open role {home ? `within ${profile.radius} miles ` : ''}matches {andJoin(reasons)}.</>
                    : <>No open roles {home ? `within ${profile.radius} miles of ${areaName}` : 'right now'}.</>}
                  {' '}Try one of these:
                </p>
                <div className="inv-fixes">
                  {fixes.map((f) => (
                    <button key={f.label} className="cm-btn small" onClick={f.apply}>
                      {f.label}{f.n != null ? ` (${f.n})` : ''}
                    </button>
                  ))}
                  {!fixes.length && <button className="cm-btn small" onClick={() => setPlace(null)}>Look across North Carolina</button>}
                </div>
              </div>
            )}
            {top && card(top, 0, true)}
            {rest.length > 0 && <div className="inv-cards">{rest.map((o, i) => card(o, i + 1, false))}</div>}
          </main>

          <aside className="inv-side">
            <div className="inv-mapcard">
              <div className="inv-map">
                <MapView
                  tracts={base.tracts}
                  fill={fill}
                  tooltip={(p) => `<div class="tt-title">${esc(p.county)}</div><div class="tt-sub">Click to rank from this neighborhood</div>`}
                  selected={hood}
                  onSelect={(g) => setHood(g)}
                  markers={markers}
                  focus={focus}
                />
              </div>
              <p className="inv-maplegend">Numbers match the list. Darker shading means more need. Click a neighborhood to rank from there.</p>
            </div>
            {signups.length > 0 && (
              <div className="inv-mine">
                <h3>Your sign-ups</h3>
                <div className="inv-mine-stats">
                  <div><b>{signups.length}</b><span>sign-up{signups.length > 1 ? 's' : ''}</span></div>
                  <div><b>{fmtInt(hoursPledged)}</b><span>hours given</span></div>
                  <div><b>{new Set(signups.map((s) => s.project_id).filter(Boolean)).size}</b><span>projects helped</span></div>
                </div>
                <ul>
                  {signups.slice(0, 3).map((s) => (
                    <li key={s.id}>
                      <CatDot c={s.category} />
                      <div>
                        <b>{s.title}</b>
                        <span>{s.org} · {shortCounty(s.county)}{s.project_id ? <> · <a href={`#/projects?id=${s.project_id}`}>project</a></> : null}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
