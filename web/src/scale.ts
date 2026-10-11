import type { Metric, TractProps } from './metrics'
import { NO_DATA, RAMP } from './metrics'

export type ColorScale = {
  color: (v: number | null | undefined) => string
  // Legend bins, ordered least → most need.
  bins: { color: string; label: string }[]
}

function quantileBreaks(values: number[], n: number): number[] {
  const s = [...values].sort((a, b) => a - b)
  return Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))])
}

export function buildScale(metric: Metric, tracts: TractProps[]): ColorScale {
  const values = tracts
    .filter((t) => t.scored)
    .map((t) => t[metric.key] as number | null)
    .filter((v): v is number => v != null && Number.isFinite(v))

  const breaks = metric.breaks ?? quantileBreaks(values, RAMP.length)
  // For "lower is worse" measures, reverse so the darkest class still means the most need.
  const ramp = metric.higherIsWorse ? RAMP : [...RAMP].reverse()

  const color = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return NO_DATA
    let i = 0
    while (i < breaks.length && v >= breaks[i]) i++
    return ramp[i]
  }

  const f = metric.format
  const edges = breaks.map(f)
  let bins = ramp.map((c, i) => ({
    color: c,
    label: i === 0 ? `< ${edges[0]}` : i === ramp.length - 1 ? `≥ ${edges[i - 1]}` : `${edges[i - 1]} – ${edges[i]}`,
  }))
  if (!metric.higherIsWorse) bins = bins.reverse()
  return { color, bins }
}
