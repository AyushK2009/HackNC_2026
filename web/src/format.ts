// "37063001505" → "Tract 15.05"; "37063000200" → "Tract 2"
export function tractName(geoid: string): string {
  const ce = geoid.slice(5)
  const base = String(parseInt(ce.slice(0, 4), 10))
  const suffix = ce.slice(4)
  return `Tract ${suffix === '00' ? base : `${base}.${suffix}`}`
}

export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US')

export function ordinal(n: number): string {
  const r = Math.round(n)
  const s = ['th', 'st', 'nd', 'rd']
  const v = r % 100
  return r + (s[(v - 20) % 10] || s[v] || s[0])
}
