// Typed client for the local backend. Contract: docs/CAC_API.md.
export type Category = 'food' | 'health' | 'transit' | 'digital' | 'housing' | 'childcare'
export const CATEGORIES: Category[] = ['food', 'health', 'transit', 'digital', 'housing', 'childcare']
export const CATEGORY_LABEL: Record<Category, string> = {
  food: 'Food access',
  health: 'Health care',
  transit: 'Transportation',
  digital: 'Internet & library',
  housing: 'Housing',
  childcare: 'Childcare',
}
// Category colors kept outside the severity palette so they read as "kind", not "how bad".
export const CATEGORY_COLOR: Record<Category, string> = {
  food: '#1d4ed8',
  health: '#0891b2',
  transit: '#334155',
  digital: '#7c3aed',
  housing: '#b45309',
  childcare: '#db2777',
}

export type Extraction = {
  categories: Category[]
  primary: Category
  severity: 1 | 2 | 3 | 4 | 5
  urgency: 'low' | 'medium' | 'high'
  barriers: string[]
  groups: string[]
  summary: string
  confidence: number
  engine: 'claude' | 'local'
}
export type Report = Extraction & {
  id: string
  text: string
  lat: number
  lon: number
  geoid: string
  county: string
  created_at: string
  confirmations: number
  status: 'open' | 'addressed'
}
export type NeedCell = { prior: number; posterior: number; lo: number; hi: number; evidence: number }
export type NeedSummary = { need: number; pct: number; top: Category; by: Record<Category, number>; conf: number; reports: number }
export type NeedChange = { geoid: string; category: Category; before: number; after: number; need_before: number; need_after: number; pct_before: number; pct_after: number }
export type InterventionType = {
  key: string
  label: string
  kind: 'facility' | 'mobile' | 'program' | 'event' | 'custom'
  categories: Category[]
  effect: Partial<Record<Category, number>>
  reach_mi: number
  cost: number
  volunteers: number
  lead_weeks: number
  duration_months: number | null
  description: string
}
export type PortfolioItem = {
  id: string
  type: string
  label: string
  categories: Category[]
  geoid: string
  county: string
  lat: number
  lon: number
  cost: number
  volunteers: number
  people_reached: number
  need_reduction: Partial<Record<Category, number>>
  score: number
  why: string
}
export type Project = {
  id: string
  title: string
  type: string
  label: string
  categories: Category[]
  geoid: string
  county: string
  lat: number
  lon: number
  budget: number
  status: 'proposed' | 'approved' | 'in_progress' | 'complete'
  created_at: string
  milestones: { id: string; title: string; due: string; done: boolean }[]
  roles: { id: string; title: string; skills: string[]; slots: number; filled: string[] }[]
  progress: number
  expected: { people_reached: number; need_reduction: Partial<Record<Category, number>> }
  brief: string | null
  brief_engine: 'claude' | 'local' | null
  scenario: string | null
  updates: { at: string; text: string }[]
}
export type Opportunity = {
  id: string
  org: string
  title: string
  description: string
  category: Category
  kind: 'event' | 'ongoing' | 'remote'
  geoid: string
  county: string
  lat: number
  lon: number
  when: string
  hours: number
  skills: string[]
  spots: number
  filled: number
  project_id: string | null
  url: string | null
}
export type RankedOpportunity = Opportunity & {
  score: number
  parts: { need: number; relevance: number; distance: number; availability: number }
  distance_mi: number
  why: string
}
export type Activity = { id: string; at: string; kind: 'report' | 'need' | 'project' | 'signup' | 'complete' | 'plan'; text: string; geoid: string | null; county: string | null }
export type OptimizeResult = {
  scenario: string
  name: string
  portfolio: PortfolioItem[]
  totals: { cost: number; volunteers: number; people_reached: number; need_before: number; need_after: number; reached_before?: number; reached_after?: number; neighborhoods_improved?: number; by_category: Record<Category, { before: number; after: number }> }
  tracts: Record<string, { before: number; after: number }>
  solver: { method: string; status: string; time_ms: number; candidates: number; variables: number }
}
export type NeedDetail = {
  geoid: string
  county: string
  pop: number
  hardship_pct: number | null
  need: number
  pct: number
  by: Record<Category, NeedCell>
  reports: Report[]
  barriers: { key: string; count: number }[]
  groups: { key: string; count: number }[]
  projects: Project[]
  suggestions: { type: string; label: string; why: string }[]
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = `${r.status}`
    try {
      detail = (await r.json()).detail ?? detail
    } catch {
      /* not JSON */
    }
    throw new Error(`${method} ${path}: ${detail}`)
  }
  return r.json() as Promise<T>
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

export const api = {
  health: () => call<{ ok: boolean; ai_engine: 'claude' | 'local'; counts: Record<string, number> }>('GET', '/health'),
  needs: () => call<{ categories: Category[]; labels: Record<Category, string>; tracts: Record<string, NeedSummary>; updated_at: string }>('GET', '/needs'),
  need: (geoid: string) => call<NeedDetail>('GET', `/needs/${geoid}`),
  extract: (text: string) => call<Extraction>('POST', '/extract', { text }),
  report: (text: string, lat: number, lon: number, extraction?: Extraction) =>
    call<{ report: Report; change: NeedChange }>('POST', '/reports', { text, lat, lon, extraction }),
  reports: (county?: string, limit = 300) => call<Report[]>('GET', `/reports?${qs({ county, limit })}`),
  confirm: (id: string) => call<{ report: Report; change: NeedChange }>('POST', `/reports/${id}/confirm`),
  opportunities: (p: { lat?: number; lon?: number; skills?: string[]; interests?: Category[]; hours?: number; radius?: number; q?: string }) =>
    call<{ items: RankedOpportunity[] }>('GET', `/opportunities?${qs({ lat: p.lat, lon: p.lon, skills: p.skills?.join(','), interests: p.interests?.join(','), hours: p.hours, radius: p.radius, q: p.q })}`),
  signup: (id: string, name: string, skills: string[], hours: number) =>
    call<{ opportunity: Opportunity; project?: Project; activity: Activity }>('POST', `/opportunities/${id}/signup`, { name, skills, hours }),
  interventions: () => call<InterventionType[]>('GET', '/interventions'),
  parseIntervention: (text: string) => call<InterventionType>('POST', '/interventions/parse', { text }),
  optimize: (body: { scope: string; budget: number; volunteers: number; types: string[]; custom?: InterventionType[]; max_per_type?: number; name?: string }) =>
    call<OptimizeResult>('POST', '/optimize', body),
  createProject: (item: PortfolioItem, scenario?: string) => call<Project>('POST', '/projects', { item, scenario }),
  projects: () => call<Project[]>('GET', '/projects'),
  project: (id: string) => call<Project>('GET', `/projects/${id}`),
  updateProject: (id: string, body: { status?: Project['status']; milestone_id?: string; done?: boolean; note?: string }) =>
    call<Project>('PATCH', `/projects/${id}`, body),
  brief: (id: string) => call<Project>('POST', `/projects/${id}/brief`),
  staff: (id: string) =>
    call<{ project: Project; assignments: { role_id: string; role: string; volunteer: { id: string; name: string; skills: string[]; county: string; hours: number }; fit: number; reasons: string[] }[]; total_fit: number }>(
      'POST',
      `/projects/${id}/staff`,
    ),
  complete: (id: string) =>
    call<{ project: Project; changes: { geoid: string; county: string; category: Category; before: number; after: number }[]; need_before: number; need_after: number }>('POST', `/projects/${id}/complete`),
  activity: (limit = 30) => call<Activity[]>('GET', `/activity?limit=${limit}`),
  reset: () => call<{ ok: boolean }>('POST', '/reset'),
}

// Tiny pub/sub so any page can tell the rest of the app the shared model changed (report, completion, …).
type Listener = () => void
const listeners = new Set<Listener>()
export const modelEvents = {
  subscribe(fn: Listener) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  emit() {
    listeners.forEach((fn) => fn())
  },
}
