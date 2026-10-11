import { useEffect, useRef, useState } from 'react'
import { IconBook, IconBus, IconFood, IconHealth } from './icons'
import { SERVICE_COLORS } from './metrics'

// Wordless explainer: a scattered town of homes, mostly far from help (warm colors). Service sites appear one
// by one; homes inside each site's reach ripple to green. Plays once while visible; replays after leaving view.
const W = 380
const H = 470
const WARM = ['#f59b3a', '#e2513c', '#94409a', '#6b1a33']
const NEAR = '#5bb36a'
const MID = '#f2d44b'
const FIRST_DELAY = 700
const STEP = 1500

type Site = { x: number; y: number; r: number; icon: React.ReactNode; color: string }
const SITES: Site[] = [
  { x: 108, y: 118, r: 84, icon: <IconHealth size={16} />, color: SERVICE_COLORS.health },
  { x: 286, y: 92, r: 62, icon: <IconBus size={16} />, color: SERVICE_COLORS.transit },
  { x: 214, y: 262, r: 96, icon: <IconFood size={16} />, color: SERVICE_COLORS.food },
  { x: 76, y: 368, r: 70, icon: <IconBook size={16} />, color: SERVICE_COLORS.library },
  { x: 312, y: 398, r: 58, icon: <IconHealth size={16} />, color: SERVICE_COLORS.health },
]

// Deterministic pseudo-random numbers so the town looks hand-scattered but identical on every load.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HOMES = (() => {
  const rand = rng(7)
  const out: { x: number; y: number; s: number; base: string }[] = []
  for (let r = 0; r < 12; r++)
    for (let c = 0; c < 10; c++) {
      if (rand() < 0.16) continue // gaps, so it reads as a town rather than a grid
      const x = 22 + c * 37 + (r % 2) * 14 + (rand() - 0.5) * 20
      const y = 24 + r * 38 + (rand() - 0.5) * 18
      if (x > W - 14 || y > H - 12) continue
      out.push({ x, y, s: 0.85 + rand() * 0.35, base: WARM[Math.floor(rand() * WARM.length)] })
    }
  return out
})()

export default function HeroArt() {
  const [shown, setShown] = useState(0)
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let timers: number[] = []
    const clear = () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers = []
    }
    const io = new IntersectionObserver(([e]) => {
      clear()
      if (e.isIntersecting) {
        SITES.forEach((_, i) => timers.push(window.setTimeout(() => setShown(i + 1), FIRST_DELAY + i * STEP)))
      } else {
        setShown(0) // left the view: reset so it replays on return
      }
    })
    if (ref.current) io.observe(ref.current)
    return () => {
      clear()
      io.disconnect()
    }
  }, [])

  const active = SITES.slice(0, shown)
  return (
    <svg ref={ref} className="hero-art" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Homes far from services turn green as new service sites appear">
      {SITES.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} className={`ha-ring ${i < shown ? 'on' : ''}`} style={{ stroke: s.color }} />
      ))}
      {HOMES.map((h, i) => {
        // Closest active site relative to its reach: 0 at the site, 1 at the edge of its ring.
        let best = Infinity
        for (const s of active) best = Math.min(best, Math.hypot(s.x - h.x, s.y - h.y) / s.r)
        const fill = best <= 0.6 ? NEAR : best <= 1 ? MID : h.base
        const delay = best <= 1 ? `${(best * 0.45).toFixed(2)}s` : '0s'
        return (
          <path
            key={i}
            className="ha-home"
            d={`M${h.x - 7 * h.s} ${h.y}l${7 * h.s} ${-7 * h.s} ${7 * h.s} ${7 * h.s}v${8 * h.s}h${-14 * h.s}z`}
            style={{ fill, transitionDelay: delay }}
          />
        )
      })}
      {SITES.map((s, i) => (
        <g key={i} className={`ha-site ${i < shown ? 'on' : ''}`} transform={`translate(${s.x - 15} ${s.y - 15})`}>
          <rect width={30} height={30} rx={15} fill="#fff" stroke={s.color} strokeWidth={2} />
          <g transform="translate(7 7)" style={{ color: s.color }}>{s.icon}</g>
        </g>
      ))}
    </svg>
  )
}
