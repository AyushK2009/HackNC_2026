import type { AccessData, PlanStep } from './types'

// Per-tract access under a set of proposed sites. Service scores are 0–100; A is their mean; the
// percentile always ranks against the fixed baseline distribution in access.json.
export type AccessRow = { cov: [number, number, number, number]; A: number; pct: number }
export type AccessView = {
  rows: Record<string, AccessRow | null>
  gain: Record<string, number> // residents now closer to a service (summed over proposed sites), per tract
}

const CAT_INDEX = { food: 0, health: 1, transit: 2, library: 3 } as const

export function midrankPct(sorted: number[], v: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (sorted[m] < v) lo = m + 1
    else hi = m
  }
  let up = lo
  let hi2 = sorted.length
  while (up < hi2) {
    const m = (up + hi2) >> 1
    if (sorted[m] <= v) up = m + 1
    else hi2 = m
  }
  return ((lo + up) / 2 / sorted.length) * 100
}

export function applyPlan(access: AccessData, steps: PlanStep[]): AccessView {
  const delta: Record<string, [number, number, number, number]> = {}
  const closer: Record<string, number> = {}
  for (const s of steps)
    for (const [g, d, n] of s.tracts) {
      const row = (delta[g] ??= [0, 0, 0, 0])
      row[CAT_INDEX[s.cat]] += d
      closer[g] = (closer[g] ?? 0) + n
    }
  const rows: Record<string, AccessRow | null> = {}
  const gain: Record<string, number> = {}
  for (const [g, r] of Object.entries(access.tracts)) {
    if (!r) {
      rows[g] = null
      continue
    }
    const d = delta[g]
    if (!d) {
      rows[g] = { cov: [r[0], r[1], r[2], r[3]], A: r[4], pct: r[5] }
      continue
    }
    const cov = [0, 1, 2, 3].map((i) => Math.min(100, r[i] + d[i])) as [number, number, number, number]
    const A = (cov[0] + cov[1] + cov[2] + cov[3]) / 4
    rows[g] = { cov, A, pct: midrankPct(access.reference_A_sorted, A) }
    gain[g] = closer[g] ?? 0
  }
  return { rows, gain }
}
