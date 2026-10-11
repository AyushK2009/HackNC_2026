import type { Metric, TractProps } from './metrics'
import { NO_DATA, SEVERITY } from './metrics'

export type ColorScale = {
  color: (v: number | null | undefined) => string
  // Legend bins, ordered least → most need (hardship) or least → most access.
  bins: { color: string; label: string }[]
}

function quantileBreaks(values: number[], n: number): number[] {
  const s = [...values].sort((a, b) => a - b)
  const raw = Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))])
  // Ties (e.g. many zeros) can produce repeated breaks; keep them strictly increasing.
  return raw.filter((b, i) => i === 0 || b > raw[i - 1])
}

function binner(breaks: number[], ramp: string[]) {
  return (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return NO_DATA
    let i = 0
    while (i < breaks.length && v >= breaks[i]) i++
    return ramp[i]
  }
}

function labels(breaks: number[], f: (v: number) => string) {
  const e = breaks.map(f)
  return Array.from({ length: breaks.length + 1 }, (_, i) =>
    i === 0 ? `< ${e[0]}` : i === breaks.length ? `≥ ${e[i - 1]}` : `${e[i - 1]}–${e[i]}`,
  )
}

// Hardship layers: severity palette; breaks fixed or quantiles over all scored NC tracts.
export function hardshipScale(metric: Metric, tracts: TractProps[]): ColorScale {
  const values = tracts
    .filter((t) => t.status === 'ok')
    .map((t) => t[metric.key] as number | null)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const breaks = metric.breaks ?? quantileBreaks(values, SEVERITY.length)
  const n = breaks.length + 1
  const sev = SEVERITY.slice(SEVERITY.length - n)
  const ramp = metric.higherIsWorse ? sev : [...sev].reverse()
  const ls = labels(breaks, metric.format)
  let bins = ramp.map((color, i) => ({ color, label: ls[i] }))
  if (!metric.higherIsWorse) bins = bins.reverse()
  return { color: binner(breaks, ramp), bins }
}

// Accessibility layers: the same severity colors, reversed — poor access is alarming, good access is green.
// Bins are listed from worst to best access.
export function accessScale(kind: 'percentile' | 'score'): ColorScale {
  const breaks = kind === 'percentile' ? [10, 20, 40, 60, 80] : [20, 35, 50, 65, 80]
  const ramp = [...SEVERITY].reverse()
  const ls = labels(breaks, (v) => `${v}`)
  return { color: binner(breaks, ramp), bins: ramp.map((color, i) => ({ color, label: ls[i] })) }
}
