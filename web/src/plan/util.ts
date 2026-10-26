import L from 'leaflet'
import type { FeatureCollection, Geometry, Position } from 'geojson'
import type { TractProps } from '../metrics'
import { NO_DATA, SEVERITY } from '../metrics'
import type { Category, InterventionType, OptimizeResult, Project } from '../shared/api'

// ---------- number formatting ----------
export function fmtMoney(v: number): string {
  const a = Math.abs(v)
  if (a >= 995_000) {
    const m = v / 1_000_000
    return `$${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (a >= 10_000) return `$${Math.round(v / 1000)}k`
  if (a >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `$${Math.round(v)}`
}
export const fmtNum = (v: number) => Math.round(v).toLocaleString('en-US')
export const fmtNeed = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
export const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export const fmtDateTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^(GET|POST|PATCH) \S+: /, '')

// ---------- intervention kinds ----------
export type Kind = InterventionType['kind']
export const KIND_ORDER: Kind[] = ['facility', 'mobile', 'program', 'event', 'custom']
export const KIND_TITLE: Record<Kind, string> = {
  facility: 'Build something lasting',
  mobile: 'Mobile & pop-up',
  program: 'Programs',
  event: 'Events',
  custom: 'Your own ideas',
}
export const KIND_SHORT: Record<Kind, string> = {
  facility: 'Lasting',
  mobile: 'Mobile',
  program: 'Program',
  event: 'Event',
  custom: 'Custom',
}

// ---------- project status ----------
export const STATUSES: Project['status'][] = ['proposed', 'approved', 'in_progress', 'complete']
export const STATUS_LABEL: Record<Project['status'], string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  in_progress: 'In progress',
  complete: 'Complete',
}

// ---------- need color scale (severity palette, higher need = worse) ----------
export type NeedScale = { color: (v: number | null | undefined) => string; bins: { color: string; label: string }[] }

export function needScale(values: number[]): NeedScale {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = SEVERITY.length
  let breaks: number[] = []
  if (s.length >= n * 2) {
    const raw = Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))])
    breaks = raw.map((b) => Math.round(b)).filter((b, i, arr) => i === 0 || b > arr[i - 1])
  }
  if (breaks.length < 2) breaks = [20, 35, 50, 65, 80]
  const ramp = SEVERITY.slice(SEVERITY.length - (breaks.length + 1))
  const color = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return NO_DATA
    let i = 0
    while (i < breaks.length && v >= breaks[i]) i++
    return ramp[i]
  }
  const bins = ramp.map((c, i) => ({
    color: c,
    label: i === 0 ? `< ${breaks[0]}` : i === breaks.length ? `${breaks[i - 1]}+` : `${breaks[i - 1]}–${breaks[i]}`,
  }))
  return { color, bins }
}

// ---------- geography ----------
export const inScope = (geoid: string, scope: string) => scope === 'nc' || geoid.slice(2, 5) === scope

function eachPos(g: Geometry, fn: (p: Position) => void) {
  if (g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach(fn))
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach((r) => r.forEach(fn)))
}

const boundsCache = new Map<string, L.LatLngBounds>()
export function scopeBounds(tracts: FeatureCollection<Geometry, TractProps>, scope: string): L.LatLngBounds | null {
  if (boundsCache.has(scope)) return boundsCache.get(scope)!
  let s = 90, w = 180, n = -90, e = -180
  for (const f of tracts.features) {
    if (!inScope(f.properties.geoid, scope)) continue
    eachPos(f.geometry, ([x, y]) => {
      if (y < s) s = y
      if (y > n) n = y
      if (x < w) w = x
      if (x > e) e = x
    })
  }
  if (n < s) return null
  const b = L.latLngBounds([s, w], [n, e])
  boundsCache.set(scope, b)
  return b
}

// Bounds of a circle of `mi` miles around a point.
export function ringBounds(lat: number, lon: number, mi: number): L.LatLngBounds {
  const dLat = mi / 69
  const dLon = mi / (69 * Math.cos((lat * Math.PI) / 180))
  return L.latLngBounds([lat - dLat, lon - dLon], [lat + dLat, lon + dLon])
}

// Stretch bounds east so the target sits left of a right-side drawer of width `frac` of the visible map.
export function leaveRoomRight(b: L.LatLngBounds, frac: number): L.LatLngBounds {
  const w = b.getEast() - b.getWest()
  return L.latLngBounds(b.getSouthWest(), L.latLng(b.getNorth(), b.getEast() + w * frac))
}

// ---------- saved scenarios ----------
export type ScenarioParams = {
  scope: string
  scopeName: string
  budget: number
  volunteers: number
  types: string[]
  custom: InterventionType[]
  maxPerType: number
}
export type SavedScenario = {
  id: string
  name: string
  at: string
  params: ScenarioParams
  kinds: Record<string, Kind> // intervention key -> kind, captured at solve time
  reach: Record<string, number> // intervention key -> reach miles
  result: OptimizeResult
}

const LS_KEY = 'allocate.plan.scenarios.v1'
export function loadScenarios(): SavedScenario[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    const v = raw ? (JSON.parse(raw) as SavedScenario[]) : []
    return Array.isArray(v) ? v.filter((s) => s && s.result && s.params) : []
  } catch {
    return []
  }
}
export function saveScenarios(list: SavedScenario[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 12)))
  } catch {
    /* storage full or blocked: keep in memory only */
  }
}

// ---------- hash query ----------
export function hashQuery(): URLSearchParams {
  const h = window.location.hash
  const i = h.indexOf('?')
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : '')
}

export const sumReduction = (r: Partial<Record<Category, number>>) => Object.values(r).reduce((a, b) => a + (b ?? 0), 0)
