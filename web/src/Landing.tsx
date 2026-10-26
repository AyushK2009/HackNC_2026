import { useEffect, useRef, useState } from 'react'
import { SERVICE_COLORS, SEVERITY, type ServiceKey } from './metrics'
import { fmtInt } from './format'
import HeroArt from './HeroArt'
import './Landing.css'

type Dot = [number, number, number | null, number | null, boolean] // x, y, hardship pct, access pct, in showcase county
type Story = {
  width: number
  height: number
  dots: Dot[]
  stats: {
    population: number
    below_poverty: number
    households_no_car: number
    health_miles_rural: number
    health_miles_urban: number
    health_miles_median: number
    top_quarter_people: number
    top_quarter_no_car_one_in: number
    rest_no_car_one_in: number
    top_quarter_snap_one_in: number
    overlap_people: number
    overlap_tracts: number
    overlap_counties: number
    overlap_rural_share: number
    tracts: number
    showcase: {
      county: string
      sites: { cat: ServiceKey; residents_closer: number; avg_miles_closer: number; x: number; y: number }[]
      bounds: [number, number, number, number]
    }
  }
}

const NEUTRAL = '#cfc8b8'
const FADED = '#e4ded1'
const ACCESS = [...SEVERITY].reverse()

function bin(v: number, breaks: number[], ramp: string[]) {
  let i = 0
  while (i < breaks.length && v >= breaks[i]) i++
  return ramp[i]
}

// What the pinned map shows at each step of the story.
function dotColor(d: Dot, step: number): string {
  const [, , h, a] = d
  if (step === 1) return h == null ? FADED : bin(h, [20, 40, 60, 80, 90], SEVERITY)
  if (step === 2 || step === 4) return a == null ? FADED : bin(a, [10, 20, 40, 60, 80], ACCESS)
  if (step === 3) return h != null && h >= 75 ? '#6b1a33' : FADED
  return NEUTRAL
}

const CAPTIONS: Record<number, { text: string; scale?: { colors: string[]; low: string; high: string } }> = {
  0: { text: 'Each dot is one North Carolina neighborhood (a census tract).' },
  1: { text: 'Economic hardship', scale: { colors: SEVERITY, low: 'Less', high: 'More' } },
  2: { text: 'Access to food assistance, health care, transit and libraries', scale: { colors: ACCESS, low: 'Worse', high: 'Better' } },
  3: { text: 'The quarter of NC neighborhoods facing the most hardship' },
  4: { text: 'Recommended new sites in Durham County' },
}

export default function Landing({ onExplore }: { onExplore: () => void }) {
  const [story, setStory] = useState<Story | null>(null)
  const [step, setStep] = useState(0)
  const stepsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/story.json`)
      .then((r) => r.json())
      .then(setStory)
      .catch(() => setStory(null))
  }, [])

  useEffect(() => {
    const els = stepsRef.current?.querySelectorAll<HTMLElement>('[data-step]')
    if (!els) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step))
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [story])

  const s = story?.stats
  const zoomed = step === 4 && story
  let transform = 'translate(0px, 0px) scale(1)'
  if (zoomed) {
    const [x0, y0, x1, y1] = story.stats.showcase.bounds
    const k = Math.min(story.width / (x1 - x0), story.height / (y1 - y0)) * 0.85
    const tx = story.width / 2 - ((x0 + x1) / 2) * k
    const ty = story.height / 2 - ((y0 + y1) / 2) * k
    transform = `translate(${tx}px, ${ty}px) scale(${k})`
  }
  const health = s?.showcase.sites.filter((x) => x.cat === 'health').reduce((t, x) => t + x.residents_closer, 0) ?? 0
  const library = s?.showcase.sites.filter((x) => x.cat === 'library').reduce((t, x) => t + x.residents_closer, 0) ?? 0
  const cap = CAPTIONS[step]

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-logo">
          <Logo size={34} />
          <span>Allocate <b>NC</b></span>
        </div>
        <button className="lp-nav-button" onClick={onExplore}>Open Allocate NC →</button>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">North Carolina · {s ? fmtInt(s.tracts) : '2,655'} neighborhoods</p>
          <h1>Where you live shouldn't decide how far you travel for help.</h1>
          <p className="lp-lede">
            Allocate NC is a living map of what North Carolina communities are missing, built from public data and from
            residents themselves, and a workspace for turning it into action.
          </p>
          <p className="lp-who">
            Tell us what's hard in your neighborhood, find where your time helps most, or plan the next pantry, clinic,
            ride program or library with a real budget. Every action updates the same picture, so help reaches the
            neighbors who have been farthest from it.
          </p>
          <div className="lp-actions">
            <button className="lp-button" onClick={onExplore}>Open the map →</button>
            <button className="lp-button ghost" onClick={() => (window.location.hash = '/report')}>Report a need</button>
            <span className="lp-scroll-cue">Scroll to see the problem ↓</span>
          </div>
        </div>
        <figure className="lp-photo">
          <HeroArt />
        </figure>
      </section>

      <section className="lp-scrolly">
        <div className="lp-graphic">
          <div className="lp-graphic-inner">
            {story && (
              <svg viewBox={`0 0 ${story.width} ${story.height}`} role="img" aria-label="Dot map of North Carolina neighborhoods">
                <g className="lp-dots" style={{ transform }}>
                  {story.dots.map((d, i) => (
                    <circle
                      key={i}
                      cx={d[0]}
                      cy={d[1]}
                      style={{ fill: dotColor(d, step), r: `${zoomed ? 0.9 : step === 3 && d[2] != null && d[2] >= 75 ? 3.0 : 2.6}px` }}
                    />
                  ))}
                  {story.stats.showcase.sites.map((p, i) => (
                    <g key={i} className={`lp-pin ${zoomed ? 'on' : ''}`} style={{ transitionDelay: `${0.9 + i * 0.25}s` }}>
                      <circle cx={p.x} cy={p.y} r={1.7} style={{ fill: SERVICE_COLORS[p.cat] }} />
                      <text x={p.x} y={p.y + 0.6}>{i + 1}</text>
                    </g>
                  ))}
                </g>
              </svg>
            )}
            <div className="lp-caption">
              <span>{cap.text}</span>
              {cap.scale && (
                <span className="lp-scale">
                  <em>{cap.scale.low}</em>
                  {cap.scale.colors.map((c) => <i key={c} style={{ background: c }} />)}
                  <em>{cap.scale.high}</em>
                </span>
              )}
              {step === 4 && s && (
                <span className="lp-scale">
                  {s.showcase.sites.map((p, i) => (
                    <em key={i}><b style={{ background: SERVICE_COLORS[p.cat] }}>{i + 1}</b>{p.cat === 'health' ? 'Health center' : 'Library'}</em>
                  ))}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="lp-steps" ref={stepsRef}>
          <div className="lp-step" data-step="1">
            <div className="lp-card">
              <div className="lp-big">{s ? `${(s.below_poverty / 1e6).toFixed(2)} million` : '—'}</div>
              <p className="lp-claim">North Carolinians live below the poverty line.</p>
              <p className="lp-detail">
                Hardship isn't spread evenly. Darker neighborhoods are where poverty, low income, food assistance (SNAP)
                and households without a car pile up together.
              </p>
            </div>
          </div>
          <div className="lp-step" data-step="2">
            <div className="lp-card">
              <div className="lp-big">{s ? `${s.health_miles_median} miles` : '—'}</div>
              <p className="lp-claim">
                Half of North Carolinians live farther than this from a community health center — the clinics that see
                patients whether or not they can pay.
              </p>
              <p className="lp-detail">
                And {s ? fmtInt(s.households_no_car) : '—'} households across the state don't have a car to cover that
                distance. The darkest neighborhoods are the farthest from food assistance, health care, transit and libraries.
              </p>
            </div>
          </div>
          <div className="lp-step" data-step="3">
            <div className="lp-card">
              <div className="lp-big">1 in {s?.top_quarter_no_car_one_in ?? '—'}</div>
              <p className="lp-claim">
                households has no car in the neighborhoods facing the most hardship — three times the rate in the rest of the
                state (1 in {s?.rest_no_car_one_in ?? '—'}).
              </p>
              <p className="lp-detail">
                These neighborhoods are home to {s ? `${(s.top_quarter_people / 1e6).toFixed(1)} million` : '—'} people, and
                1 in {s?.top_quarter_snap_one_in ?? '—'} of their households relies on SNAP for groceries. Every extra mile to a
                clinic, pantry or library lands hardest here.
              </p>
            </div>
          </div>
          <div className="lp-step" data-step="4">
            <div className="lp-card">
              <div className="lp-big lp-big-sm">What should we build, and where?</div>
              <p className="lp-claim">
                Allocate NC tests thousands of possible locations for each kind of service and picks the ones that help the
                most people — putting the neighborhoods with the most hardship first.
              </p>
              <p className="lp-detail">
                For example, in {s?.showcase.county ?? 'Durham County'}, one new health center and two libraries would bring{' '}
                {fmtInt(Math.round(health / 1000) * 1000)} residents closer to health care and {fmtInt(Math.round(library / 1000) * 1000)} closer
                to a library.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-loop">
        <p className="lp-eyebrow">One shared picture, four ways in</p>
        <h2>Residents, volunteers and planners all work from the same map.</h2>
        <button className="lp-button" onClick={() => (window.location.hash = '/tour')}>▶ Watch the whole loop, live</button>
        <ol className="lp-loop-steps">
          <li>
            <b>1</b>
            <h3>Residents report</h3>
            <p>Anyone describes what's hard to reach, in their own words. The system reads it and pins it to the neighborhood.</p>
            <button onClick={() => (window.location.hash = '/report')}>Report a need →</button>
          </li>
          <li>
            <b>2</b>
            <h3>The map learns</h3>
            <p>Public data sets the starting point. Recent, specific, confirmed reports raise the need estimate where they happen.</p>
            <button onClick={() => (window.location.hash = '/map')}>See the Needs Map →</button>
          </li>
          <li>
            <b>3</b>
            <h3>Planners decide</h3>
            <p>Set a budget and volunteer hours. Allocate NC picks the mix of projects and places that helps the most people.</p>
            <button onClick={() => (window.location.hash = '/plan')}>Plan &amp; track →</button>
          </li>
          <li>
            <b>4</b>
            <h3>Neighbors pitch in</h3>
            <p>Volunteers see the opportunities where they're needed most and that fit their skills and time.</p>
            <button onClick={() => (window.location.hash = '/involved')}>Get involved →</button>
          </li>
          <li>
            <b>5</b>
            <h3>Results feed back</h3>
            <p>When a project is finished, need falls on the map where it reaches, and the next plan starts from there.</p>
          </li>
        </ol>
      </section>

      <section className="lp-cta">
        <h2>Start with your county.</h2>
        <p>Every neighborhood in North Carolina, one shared picture of what's missing, and a plan for what to do about it.</p>
        <button className="lp-button" onClick={onExplore}>Open Allocate NC →</button>
        <p className="lp-sources">
          Data: USDA Economic Research Service, U.S. Census Bureau, HRSA, U.S. Department of Transportation, Institute of
          Museum and Library Services, and county food-assistance lists.
        </p>
      </section>
    </div>
  )
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2c-5.5 0-10 4.3-10 9.7C6 19 16 30 16 30s10-11 10-18.3C26 6.3 21.5 2 16 2z" fill="#e2513c" />
      <circle cx="16" cy="11.5" r="4" fill="#fff" />
    </svg>
  )
}
