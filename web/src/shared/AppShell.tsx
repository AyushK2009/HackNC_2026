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
import './shell.css'

export type Route = 'home' | 'map' | 'report' | 'involved' | 'plan' | 'projects' | 'tour'

// Grouped by what people come to do: see, speak up, help, act.
const NAV: { route: Route; label: string; who: string }[] = [
  { route: 'home', label: 'Home', who: 'Your county at a glance' },
  { route: 'map', label: 'Needs map', who: 'Where help is needed and why' },
  { route: 'report', label: 'Report a need', who: 'Tell us what is hard where you live' },
  { route: 'involved', label: 'Volunteer', who: 'Ways to help, ranked by need' },
  { route: 'plan', label: 'Plan services', who: 'Find the best mix of services for a budget' },
  { route: 'projects', label: 'Projects', who: 'Track work from plan to finish' },
]

export default function AppShell({ route }: { route: Route }) {
  const [engine, setEngine] = useState<'claude' | 'local' | 'offline'>('local')

  useEffect(() => {
    api.health().then((h) => setEngine(h.ai_engine)).catch(() => setEngine('offline'))
  }, [])

  const Page = { home: Home, map: NeedsMap, report: Report, involved: Involved, plan: Plan, projects: Projects, tour: Tour }[route]

  return (
    <div className="shell">
      <header className="shell-top">
        <button className="shell-brand" onClick={() => (window.location.hash = '')} title="About Allocate NC">
          <Logo size={22} />
          <span>Allocate <b>NC</b></span>
        </button>
        <nav className="shell-nav">
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} className={route === n.route ? 'on' : ''} title={n.who}>
              {n.label}
            </a>
          ))}
        </nav>
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
