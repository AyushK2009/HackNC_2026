import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import MapView, { NC_BOUNDS, type MapMarker } from '../MapView'
import { api, CATEGORIES, CATEGORY_LABEL, modelEvents, type Category, type NeedSummary, type Project, type RankedOpportunity } from '../shared/api'
import { useBaseData } from '../shared/baseData'
import type { TractProps } from '../metrics'
import { fmtInt } from '../format'
import { as01, Bar, CatDot, clamp01, catColor, countyBounds, countyCenter, countyNameOf, esc, fipsOf, loadLS, loadLSArray, r0, saveLS, SOFT_RAMP, softNeedColor, useHashParams } from './common'

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
const PROFILE_KEY = 'allocate.volunteer'
const SIGNUPS_KEY = 'allocate.signups'

type Profile = { name: string; county: string; geoid: string | null; skills: string[]; interests: Category[]; hours: number; radius: number }
const EMPTY: Profile = { name: '', county: '', geoid: null, skills: [], interests: [], hours: 4, radius: 20 }
type Signup = { id: string; title: string; org: string; county: string; category: Category; hours: number; project_id: string | null; project_title: string | null; at: string }
type Confirm = { id: string; text: string }
type Focus = { key: string; bounds: L.LatLngBoundsExpression; padding?: [number, number] }

const PARTS: { key: keyof RankedOpportunity['parts']; label: string }[] = [
  { key: 'need', label: 'Need there' },
  { key: 'relevance', label: 'Fits your skills' },
  { key: 'distance', label: 'Close to you' },
  { key: 'availability', label: 'Fits your time' },
]

export default function Involved() {
  const base = useBaseData()
  const params = useHashParams()
  const [profile, setProfile] = useState<Profile>(() => loadLS(PROFILE_KEY, EMPTY))
  const [signups, setSignups] = useState<Signup[]>(() => loadLSArray<Signup>(SIGNUPS_KEY))
  const [items, setItems] = useState<RankedOpportunity[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [joining, setJoining] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [needs, setNeeds] = useState<Record<string, NeedSummary> | null>(null)
  const [focus, setFocus] = useState<Focus>({ key: 'nc', bounds: NC_BOUNDS, padding: [20, 20] })
  const [nameMissing, setNameMissing] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const autoRan = useRef(false)

  useEffect(() => saveLS(PROFILE_KEY, profile), [profile])
  useEffect(() => saveLS(SIGNUPS_KEY, signups), [signups])
  const set = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }))

  useEffect(() => {
    const load = () => api.needs().then((n) => setNeeds(n.tracts)).catch(() => undefined)
    load()
    return modelEvents.subscribe(load)
  }, [])

  const home = useMemo((): [number, number] | null => {
    if (!base) return null
    if (profile.geoid && base.centroid.has(profile.geoid)) return base.centroid.get(profile.geoid)!
    return profile.county ? countyCenter(base, profile.county) : null
  }, [base, profile.geoid, profile.county])

  const search = useCallback(async (p: Profile, at: [number, number] | null) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.opportunities({ lat: at?.[0], lon: at?.[1], skills: termsFor(p.skills), interests: p.interests, hours: p.hours, radius: p.radius })
      const list: RankedOpportunity[] = Array.isArray(r) ? r : r.items ?? []
      setItems(list)
      setActive(null)
      const pts: [number, number][] = list.slice(0, 15).map((o) => [o.lat, o.lon])
      if (at) pts.push(at)
      if (pts.length) setFocus({ key: `s-${Date.now()}`, bounds: L.latLngBounds(pts).pad(0.15), padding: [30, 30] })
      listRef.current?.scrollTo({ top: 0 })
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }, [])

  // '#/involved?geoid=…' sets the neighborhood; returning visitors with a saved profile see matches right away.
  const qGeoid = params.get('geoid')
  useEffect(() => {
    if (!base) return
    if (qGeoid && base.byId.has(qGeoid)) {
      const next = { ...profile, geoid: qGeoid, county: fipsOf(qGeoid) }
      setProfile(next)
      search(next, base.centroid.get(qGeoid) ?? null)
      autoRan.current = true
      return
    }
    if (!autoRan.current && profile.county) {
      autoRan.current = true
      search(profile, home)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, qGeoid])

  const signup = async (o: RankedOpportunity) => {
    if (!profile.name.trim()) {
      setNameMissing(true)
      nameRef.current?.focus()
      nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setJoining(o.id)
    try {
      const mine = termsFor(profile.skills)
      const r = await api.signup(o.id, profile.name.trim(), mine, profile.hours)
      const opp = r.opportunity
      const project: Project | undefined = r.project
      const s: Signup = {
        id: o.id, title: o.title, org: o.org, county: o.county, category: o.category, hours: o.hours,
        project_id: o.project_id ?? project?.id ?? null, project_title: project?.title ?? null, at: new Date().toISOString(),
      }
      setSignups((prev) => [s, ...prev.filter((x) => x.id !== o.id)])
      const left = Math.max(0, (opp?.spots ?? o.spots) - (opp?.filled ?? o.filled + 1))
      // The backend fills the role that best overlaps the volunteer's and the opportunity's skills.
      const want = new Set([...mine, ...o.skills.map((k) => k.toLowerCase())])
      const role = project?.roles.slice().sort((a, b) => b.skills.filter((k) => want.has(k.toLowerCase())).length - a.skills.filter((k) => want.has(k.toLowerCase())).length)[0] ?? null
      const what = role ? `“${role.title}” spots` : 'volunteer spots'
      const total = role?.slots ?? opp?.spots ?? o.spots
      const tail = project ? ` — that project is now ${r0(project.progress)}% ready.` : left > 0 ? `. ${left} spot${left > 1 ? 's' : ''} still open.` : '. That was the last open spot.'
      setConfirm({ id: o.id, text: `You're in. You fill 1 of ${total} ${what} for ${project?.title ?? o.title}${tail}` })
      setItems((prev) => prev?.map((x) => (x.id === o.id ? { ...x, filled: opp?.filled ?? x.filled + 1, spots: opp?.spots ?? x.spots } : x)) ?? prev)
      modelEvents.emit()
    } catch (e) {
      setConfirm({ id: o.id, text: `Couldn't sign you up: ${(e as Error).message}` })
    } finally {
      setJoining(null)
    }
  }

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = (items ?? []).slice(0, 25).map((o, i) => {
      const on = o.id === active || o.id === hover
      const size = on ? 32 : 24
      return {
        id: o.id,
        lat: o.lat,
        lon: o.lon,
        color: catColor(o.category),
        size,
        label: String(i + 1),
        html: `<div class="mk cm-mk ${on ? 'on' : ''}" style="width:${size}px;height:${size}px;background:${catColor(o.category)}">${i + 1}</div>`,
        tooltip: `<div class="tt-title">${esc(o.title)}</div><div class="tt-sub">${esc(o.org)} · ${esc(o.county)}</div>`,
        onClick: () => {
          setActive(o.id)
          document.getElementById(`opp-${o.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        },
      }
    })
    if (home) out.push({ id: 'home', lat: home[0], lon: home[1], color: '#18191b', size: 16, ringMi: profile.radius, tooltip: '<div class="tt-title">You</div><div class="tt-sub">Dashed circle: how far you said you\'d travel</div>', html: '<div class="mk cm-home"></div>' })
    return out
  }, [items, active, hover, home, profile.radius])

  const fill = useMemo(
    () => (p: TractProps) => {
      if (p.geoid === profile.geoid) return '#18191b'
      const n = needs?.[p.geoid]
      return n ? softNeedColor(n.pct) : '#f2efe9'
    },
    [needs, profile.geoid],
  )

  if (!base) return <div className="cm-splash">Loading…</div>

  // Scores are small absolute numbers; show each one relative to this person's best match.
  const best = Math.max(1e-9, ...(items ?? []).map((o) => o.score || 0))
  const fit = (o: RankedOpportunity) => clamp01((o.score || 0) / best)
  const hoursPledged = signups.reduce((t, s) => t + (s.hours || 0), 0)
  const projects = new Set(signups.map((s) => s.project_id).filter(Boolean)).size
  const causes = [...new Set(signups.map((s) => s.category))]
  const signedUp = new Set(signups.map((s) => s.id))
  const hoodName = profile.geoid ? countyNameOf(base, profile.geoid) : null

  return (
    <div className="cm-page cm-inv">
      {signups.length > 0 && (
        <div className="cm-impact">
          <b className="cm-impact-title">My impact</b>
          <div><b>{signups.length}</b><span>sign-up{signups.length > 1 ? 's' : ''}</span></div>
          <div><b>{fmtInt(hoursPledged)}</b><span>hours pledged</span></div>
          <div><b>{projects}</b><span>project{projects === 1 ? '' : 's'} supported</span></div>
          <div className="cm-impact-causes">
            {causes.map((c) => <span key={c} className="cm-tag"><CatDot c={c} /> {CATEGORY_LABEL[c]}</span>)}
          </div>
          <span className="cm-impact-last">Latest: {signups[0].title}</span>
        </div>
      )}
      <div className="cm-inv-grid">
        <section className="cm-inv-profile">
          <p className="ex-kicker">For volunteers</p>
          <h2 className="cm-h2">Find where you're needed</h2>
          <p className="cm-muted">Tell us a little about yourself. We'll match you to the places where your time does the most good.</p>

          <div className="cm-field">
            <span>Your first name</span>
            <input ref={nameRef} className={`cm-input ${nameMissing && !profile.name ? 'warn' : ''}`} value={profile.name} placeholder="So organizers know who's coming" onChange={(e) => { set({ name: e.target.value }); setNameMissing(false) }} />
            {nameMissing && !profile.name && <em className="cm-warn">Add your first name to sign up.</em>}
          </div>
          <div className="cm-field">
            <span>Where you live</span>
            <select
              className="cm-input"
              value={profile.county}
              onChange={(e) => {
                const f = e.target.value
                set({ county: f, geoid: null })
                const b = f ? countyBounds(base, f) : null
                if (b) setFocus({ key: `c-${f}-${Date.now()}`, bounds: b, padding: [30, 30] })
              }}
            >
              <option value="">Choose your county…</option>
              {base.access.counties.map((c) => <option key={c.fips} value={c.fips}>{c.name}</option>)}
            </select>
            <em className="cm-hint">
              {hoodName ? <>Neighborhood picked in {hoodName} · <button className="cm-link" onClick={() => set({ geoid: null })}>clear</button></> : 'Optional: click your neighborhood on the map for closer matches.'}
            </em>
          </div>
          <div className="cm-field">
            <span>What you're good at</span>
            <div className="cm-tags">
              {SKILLS.map((k) => (
                <button key={k} className={`cm-tag btn ${profile.skills.includes(k) ? 'on' : ''}`} onClick={() => set({ skills: profile.skills.includes(k) ? profile.skills.filter((x) => x !== k) : [...profile.skills, k] })}>{k}</button>
              ))}
            </div>
          </div>
          <div className="cm-field">
            <span>Causes you care about</span>
            <div className="cm-tags">
              {CATEGORIES.map((c) => {
                const on = profile.interests.includes(c)
                return (
                  <button key={c} className={`cm-tag btn ${on ? 'on' : ''}`} onClick={() => set({ interests: on ? profile.interests.filter((x) => x !== c) : [...profile.interests, c] })}>
                    <CatDot c={c} /> {CATEGORY_LABEL[c]}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="cm-field">
            <span>Time you can give <b className="cm-val">{profile.hours} hour{profile.hours > 1 ? 's' : ''} a week</b></span>
            <input type="range" min={1} max={20} value={profile.hours} onChange={(e) => set({ hours: +e.target.value })} />
          </div>
          <div className="cm-field">
            <span>How far you'll travel <b className="cm-val">{profile.radius} miles</b></span>
            <input type="range" min={5} max={50} step={5} value={profile.radius} onChange={(e) => set({ radius: +e.target.value })} />
          </div>
          <button className="cm-btn primary big wide" onClick={() => search(profile, home)} disabled={busy}>
            {busy ? 'Finding matches…' : "Find where I'm needed"}
          </button>
          {!profile.county && <p className="cm-muted small center">Tip: choose your county for nearby matches.</p>}
        </section>

        <section className="cm-inv-list" ref={listRef}>
          {items === null && !busy && !err && (
            <div className="cm-empty">
              <h3>Your matches will appear here</h3>
              <p>We rank by how much need there is where the opportunity happens, how well it fits your skills, how close it is, and whether it fits your time.</p>
            </div>
          )}
          {err && <p className="cm-error">Couldn't load opportunities: {err}</p>}
          {busy && items === null && <><div className="cm-skel tall" /><div className="cm-skel tall" /><div className="cm-skel tall" /></>}
          {items && (
            <>
              <div className="cm-list-head">
                <h3>{items.length ? `${items.length} ways to help${hoodName || profile.county ? ` near ${hoodName ?? countyNameOf(base, `37${profile.county}000000`)}` : ''}` : 'No matches yet'}</h3>
                <p className="cm-muted small">We rank by how much need there is where the opportunity happens, how well it fits your skills, how close it is, and whether it fits your time.</p>
              </div>
              {!items.length && <p className="cm-muted">Try a bigger travel distance or fewer filters.</p>}
              <ol className="cm-opps">
                {items.map((o, i) => {
                  const left = Math.max(0, o.spots - o.filled)
                  const mine = signedUp.has(o.id)
                  const on = o.id === active
                  return (
                    <li
                      key={o.id}
                      id={`opp-${o.id}`}
                      className={`cm-opp ${on ? 'on' : ''}`}
                      onMouseEnter={() => setHover(o.id)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => setActive(o.id)}
                    >
                      <span className="cm-rank" style={{ background: catColor(o.category) }}>{i + 1}</span>
                      <div className="cm-opp-body">
                        <div className="cm-opp-top">
                          <div>
                            <b className="cm-opp-title">{o.title}</b>
                            <span className="cm-opp-org">{o.org}</span>
                          </div>
                          <div className="cm-match" title="How well this fits you, compared with your best match">
                            <b>{Math.round(fit(o) * 100)}</b>
                            <span>{i === 0 ? 'best match' : 'match'}</span>
                          </div>
                        </div>
                        <div className="cm-opp-meta">
                          <span><CatDot c={o.category} /> {CATEGORY_LABEL[o.category] ?? o.category}</span>
                          <span>{o.kind === 'remote' ? 'Remote' : `${o.county}${Number.isFinite(o.distance_mi) ? ` · ${o.distance_mi.toFixed(1)} mi` : ''}`}</span>
                          <span>{o.when}</span>
                          <span>{o.hours} h</span>
                          <span className={left <= 2 ? 'hot' : ''}>{left} of {o.spots} spots left</span>
                        </div>
                        <Bar value={fit(o)} color={catColor(o.category)} height={5} />
                        {(on || i < 3) && (
                          <div className="cm-why">
                            <p className="cm-why-title">Why this match</p>
                            <div className="cm-parts">
                              {PARTS.map((pt) => (
                                <div key={pt.key}>
                                  <span>{pt.label}</span>
                                  <Bar value={as01(o.parts?.[pt.key])} color="#4b4f56" height={4} />
                                </div>
                              ))}
                            </div>
                            {o.why && <p className="cm-why-text">{o.why}</p>}
                          </div>
                        )}
                        {!(on || i < 3) && o.why && <p className="cm-why-text short">{o.why}</p>}
                        <div className="cm-opp-actions">
                          {mine ? (
                            <span className="cm-signed">✓ You're signed up</span>
                          ) : (
                            <button className="cm-btn primary small" disabled={joining === o.id || left === 0} onClick={(e) => { e.stopPropagation(); signup(o) }}>
                              {joining === o.id ? 'Signing up…' : left === 0 ? 'Full' : 'Sign up'}
                            </button>
                          )}
                          <a className="cm-link" href={`#/map?geoid=${o.geoid}`} onClick={(e) => e.stopPropagation()}>See the need there</a>
                          {o.url && <a className="cm-link" href={o.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Details ↗</a>}
                        </div>
                        {confirm?.id === o.id && <p className={`cm-confirm ${confirm.text.startsWith("You're in") ? 'ok' : 'bad'}`}>{confirm.text}</p>}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </>
          )}
        </section>

        <section className="cm-inv-map cm-mapwrap">
          <MapView
            tracts={base.tracts}
            fill={fill}
            tooltip={(p) => `<div class="tt-title">${p.county}</div><div class="tt-sub">Click to set this as your neighborhood</div>`}
            selected={profile.geoid}
            onSelect={(g) => set({ geoid: g, county: fipsOf(g) })}
            markers={markers}
            focus={focus}
          />
          <div className="cm-maplegend">
            <span>Shading: community need</span>
            <div className="cm-soft">{SOFT_RAMP.map((c) => <i key={c} style={{ background: c }} />)}</div>
            <span className="cm-muted">less → more</span>
          </div>
        </section>
      </div>
    </div>
  )
}
