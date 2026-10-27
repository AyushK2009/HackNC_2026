import { useEffect, useState } from 'react'
import { Logo } from '../Landing'
import Home from '../home/Home'
import NeedsMap from '../community/NeedsMap'
import Report from '../community/Report'
import Involved from '../community/Involved'
import Plan from '../plan/Plan'
import Projects from '../plan/Projects'
import Tour from '../tour/Tour'
import { api } from './api'
import { announceMode, getMode, primeMode, useMode, type Mode } from './mode'
import './shell.css'

export type Route = 'home' | 'org' | 'map' | 'report' | 'involved' | 'plan' | 'projects' | 'tour'

type NavItem = { route: Route; label: string; who: string }
// Two different places: one for residents and volunteers, one for organizations and planners.
const NAV: Record<Mode, NavItem[]> = {
  community: [
    { route: 'home', label: 'Home', who: 'Your county at a glance' },
    { route: 'map', label: 'Community map', who: 'Where help is needed and why' },
    { route: 'report', label: 'Report a need', who: 'Tell us what is hard where you live' },
    { route: 'involved', label: 'Volunteer', who: 'Ways to help, ranked by need' },
  ],
  planner: [
    { route: 'org', label: 'Overview', who: 'Your county at a glance' },
    { route: 'map', label: 'Community map', who: 'Where help is needed and why' },
    { route: 'plan', label: 'Plan services', who: 'Find the best mix of services for a budget' },
    { route: 'projects', label: 'Projects', who: 'Track work from plan to finish' },
  ],
}
// Pages that belong to one mode switch to it; the map and walkthrough keep whichever you came from.
const ROUTE_MODE: Partial<Record<Route, Mode>> = { home: 'community', report: 'community', involved: 'community', org: 'planner', plan: 'planner', projects: 'planner' }

export default function AppShell({ route }: { route: Route }) {
  const [engine, setEngine] = useState<'claude' | 'local' | 'offline'>('local')
  const fixed = ROUTE_MODE[route]
  if (fixed && fixed !== getMode()) primeMode(fixed)
  const mode = useMode()
  const m = fixed ?? mode

  useEffect(() => {
    api.health().then((h) => setEngine(h.ai_engine)).catch(() => setEngine('offline'))
  }, [])
  useEffect(() => announceMode(), [route])

  const Page = { home: Home, org: Home, map: NeedsMap, report: Report, involved: Involved, plan: Plan, projects: Projects, tour: Tour }[route]

  return (
    <div className={`shell mode-${m}`}>
      <header className="shell-top">
        <button className="shell-brand" onClick={() => (window.location.hash = '')} title="Back to the start, to switch between community and planning">
          <Logo size={22} />
          <span>Allocate <b>NC</b></span>
        </button>
        <span className="shell-mode">{m === 'planner' ? 'Planning workspace' : 'Community'}</span>
        <nav className="shell-nav">
          {NAV[m].map((n) => (
            <a key={n.route} href={`#/${n.route}`} className={route === n.route ? 'on' : ''} title={n.who}>
              {n.label}
            </a>
          ))}
        </nav>
        <a className={`shell-walk ${route === 'tour' ? 'on' : ''}`} href="#/tour">▶ 1-minute walkthrough</a>
      </header>
      {engine === 'offline' && (
        <div className="shell-offline">
          The local server isn't running. Start it with <code>.venv/bin/uvicorn server.main:app --port 8000</code> from the project folder.
        </div>
      )}
      <main className="shell-main">
        <Page />
      </main>
    </div>
  )
}
