import { useEffect, useState } from 'react'
import L from 'leaflet'
import type { Geometry } from 'geojson'
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, type Category, type Extraction } from '../shared/api'
import type { BaseData } from '../shared/baseData'
import { NO_DATA, SEVERITY } from '../metrics'
import '../App.css'
import '../Explore.css'
import './community.css'

// ---------- Routing helpers (hash routes like '#/report?geoid=…') ----------
export function readHashParams(): URLSearchParams {
  const h = window.location.hash
  const i = h.indexOf('?')
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : '')
}

export function useHashParams(): URLSearchParams {
  const [p, setP] = useState(readHashParams)
  useEffect(() => {
    const on = () => setP(readHashParams())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return p
}

// Keep the address bar in sync without triggering a route change.
export function replaceHash(h: string) {
  if (window.location.hash !== h) window.history.replaceState(null, '', h)
}

export const fipsOf = (geoid: string) => geoid.slice(2, 5)

// ---------- Text ----------
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const CATEGORY_NOUN: Record<Category, string> = {
  food: 'food access',
  health: 'health care',
  transit: 'transportation',
  digital: 'internet and library',
  housing: 'housing',
  childcare: 'childcare',
}

export const CATEGORY_TEXT: Record<Category, string> = {
  food: 'How hard it is to get groceries or food help close to home.',
  health: 'How far people live from affordable health care, and what residents say about getting it.',
  transit: 'Whether people can get to work, school and appointments without a car.',
  digital: 'Access to home internet, computers and library services.',
  housing: 'Pressure from rent, low income and unstable housing.',
  childcare: 'Whether families can find affordable, nearby care for their kids.',
}

export const BARRIERS: Record<string, string> = {
  cost: 'Too expensive',
  distance: 'Too far away',
  no_transportation: 'No way to get there',
  hours: "Hours don't work",
  eligibility: 'Eligibility rules',
  language: 'Language',
  disability: 'Disability access',
  safety: 'Safety',
  information: "Hard to find out what's available",
  waitlist: 'Long waitlists',
  closure: 'A place closed',
}
export const GROUPS: Record<string, string> = {
  seniors: 'Seniors',
  children: 'Children',
  families: 'Families',
  disabled: 'People with disabilities',
  veterans: 'Veterans',
  non_english: 'Non-English speakers',
  students: 'Students',
  unhoused: 'People without housing',
}
export const barrierLabel = (k: string) => BARRIERS[k] ?? k.replace(/_/g, ' ')
export const groupLabel = (k: string) => GROUPS[k] ?? k.replace(/_/g, ' ')

export const STATUS: Record<string, string> = { proposed: 'Proposed', approved: 'Approved', in_progress: 'In progress', complete: 'Complete' }

export function ago(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const r0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v)))
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
// Scores from the backend may be 0–1 or 0–100; show them as 0–1 fractions either way.
export const as01 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : clamp01(v > 1.5 ? v / 100 : v))

// Make an extraction safe to edit: primary is always one of the categories, lists always exist.
export function normalizeExtraction(x: Extraction): Extraction {
  const valid = (c: unknown): c is Category => CATEGORIES.includes(c as Category)
  const cats = [...new Set([x.primary, ...(x.categories ?? [])].filter(valid))]
  const categories = cats.length ? cats : (['food'] as Category[])
  return {
    ...x,
    categories,
    primary: valid(x.primary) ? x.primary : categories[0],
    severity: (Math.min(5, Math.max(1, Math.round(x.severity ?? 3))) as Extraction['severity']),
    urgency: x.urgency ?? 'medium',
    barriers: x.barriers ?? [],
    groups: x.groups ?? [],
    summary: x.summary ?? '',
    confidence: as01(x.confidence),
  }
}

// ---------- Colors ----------
function binner(breaks: number[], ramp: string[]) {
  return (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return NO_DATA
    let i = 0
    while (i < breaks.length && v >= breaks[i]) i++
    return ramp[i]
  }
}
export type Scale = { color: (v: number | null | undefined) => string; bins: string[] }
// Overall need percentile (same breaks as the hardship index) — higher = more need.
export const needPctScale: Scale = { color: binner([20, 40, 60, 80, 90], SEVERITY), bins: SEVERITY }
// Per-category need, 0–100, fixed breaks so colors mean the same thing everywhere.
export const needValueScale: Scale = { color: binner([25, 35, 45, 55, 70], SEVERITY), bins: SEVERITY }
// Soft warm ramp used as quiet background context under markers.
const SOFT = ['#f2efe9', '#efe1d6', '#e9cdbb', '#e0b39b', '#d3947a']
export const softNeedColor = binner([40, 60, 80, 90], SOFT)
export { SOFT as SOFT_RAMP }

export const catColor = (c: string) => CATEGORY_COLOR[c as Category] ?? '#64748b'
export const catLabel = (c: string) => CATEGORY_LABEL[c as Category] ?? c

// ---------- Geography ----------
export function countyBounds(base: BaseData, fips: string, extendEast = 0): L.LatLngBounds | null {
  let s = 90, w = 180, n = -90, e = -180
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[]
      if (y < s) s = y
      if (y > n) n = y
      if (x < w) w = x
      if (x > e) e = x
    } else if (Array.isArray(c)) c.forEach(visit)
  }
  for (const f of base.tracts.features) {
    if (fipsOf(f.properties.geoid) !== fips) continue
    const g = f.geometry as Geometry
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') visit(g.coordinates)
  }
  if (n < s) return null
  return L.latLngBounds([s, w], [n, e + (e - w) * extendEast])
}

export function countyCenter(base: BaseData, fips: string): [number, number] | null {
  let w = 0, la = 0, lo = 0
  for (const [g, c] of base.centroid) {
    if (fipsOf(g) !== fips) continue
    const p = Math.max(1, base.byId.get(g)?.pop ?? 1)
    w += p; la += c[0] * p; lo += c[1] * p
  }
  return w ? [la / w, lo / w] : null
}

export function nearestTract(base: BaseData, lat: number, lon: number): string | null {
  let best: string | null = null, bd = Infinity
  const k = Math.cos((lat * Math.PI) / 180)
  for (const [g, c] of base.centroid) {
    const d = (c[0] - lat) ** 2 + ((c[1] - lon) * k) ** 2
    if (d < bd) { bd = d; best = g }
  }
  return best
}

export const countyNameOf = (base: BaseData, geoid: string) => base.byId.get(geoid)?.county ?? base.access.counties.find((c) => c.fips === fipsOf(geoid))?.name ?? 'North Carolina'

// ---------- localStorage (never throws) ----------
export function loadLS<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key)
    return v ? { ...fallback, ...JSON.parse(v) } : fallback
  } catch {
    return fallback
  }
}
export function loadLSArray<T>(key: string): T[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
export function saveLS(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

// ---------- Small shared pieces ----------
export function CatDot({ c, size = 9 }: { c: string; size?: number }) {
  return <i className="cm-dot" style={{ background: catColor(c), width: size, height: size }} />
}

export function LegendBar({ bins, low, high, note }: { bins: string[]; low: string; high: string; note?: string }) {
  return (
    <div className="ex-legend">
      <div className="ex-legend-bar">
        {bins.map((b) => (
          <span key={b} style={{ background: b }} />
        ))}
      </div>
      <div className="ex-legend-ends">
        <span>{low}</span>
        <span>{high}</span>
      </div>
      {note && <p>{note}</p>}
    </div>
  )
}

export function Bar({ value, color = 'var(--ink)', height = 6 }: { value: number; color?: string; height?: number }) {
  return (
    <div className="cm-bar" style={{ height }}>
      <div style={{ width: `${Math.round(clamp01(value) * 100)}%`, background: color }} />
    </div>
  )
}
