import { useEffect, useState } from 'react'
import { Logo } from '../Landing'
import NeedsMap from '../community/NeedsMap'
import Report from '../community/Report'
import Involved from '../community/Involved'
import Plan from '../plan/Plan'
import Tour from '../tour/Tour'
import { api, modelEvents, type Activity } from './api'
import './shell.css'

export type Route = 'map' | 'report' | 'involved' | 'plan' | 'tour'

const NAV: { route: Route; label: string; who: string }[] = [
  { route: 'map', label: 'Needs Map', who: 'See where help is needed and why' },
  { route: 'report', label: 'Report a need', who: 'For residents' },
  { route: 'involved', label: 'Get involved', who: 'For volunteers' },
  { route: 'plan', label: 'Plan & track', who: 'For organizations and planners' },
]

const KIND_DOT: Record<Activity['kind'], string> = {
  report: '#e2513c',
  need: '#94409a',
  project: '#1d4ed8',
  signup: '#0891b2',
  complete: '#1f7a3f',
  plan: '#334155',
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export default function AppShell({ route }: { route: Route }) {
  const [feed, setFeed] = useState<Activity[]>([])
  const [open, setOpen] = useState(false)
  const [engine, setEngine] = useState<'claude' | 'local' | 'offline'>('local')
  const [unseen, setUnseen] = useState(0)

  useEffect(() => {
    const refresh = () => {
      api.activity(40).then((a) => {
        setFeed((prev) => {
          if (prev.length && a.length && a[0].id !== prev[0].id) setUnseen((u) => u + 1)
          return a
        })
      }).catch(() => undefined)
    }
    api.health().then((h) => setEngine(h.ai_engine)).catch(() => setEngine('offline'))
    refresh()
    const off = modelEvents.subscribe(refresh)
    const t = window.setInterval(refresh, 15000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [])

  const Page = { map: NeedsMap, report: Report, involved: Involved, plan: Plan, tour: Tour }[route]

  return (
    <div className="shell">
      <header className="shell-top">
        <button className="shell-brand" onClick={() => (window.location.hash = '')} title="Back to the story">
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
        <div className="shell-right">
          <a className={`shell-tour ${route === 'tour' ? 'on' : ''}`} href="#/tour">▶ Watch the loop</a>
          <span className={`shell-engine ${engine}`} title={engine === 'claude' ? 'AI features use Claude' : engine === 'local' ? 'AI features use the built-in local models (no API key set)' : 'Backend not running'}>
            {engine === 'offline' ? 'Server offline' : engine === 'claude' ? 'AI: Claude' : 'AI: local models'}
          </span>
          <button className={`shell-feed-btn ${open ? 'on' : ''}`} onClick={() => { setOpen(!open); setUnseen(0) }}>
            Community pulse{unseen > 0 && <i>{unseen}</i>}
          </button>
        </div>
      </header>
      {engine === 'offline' && (
        <div className="shell-offline">
          The local server isn't running. Start it with <code>.venv/bin/uvicorn server.main:app --port 8000</code> from the project folder.
        </div>
      )}
      <main className="shell-main">
        <Page />
      </main>
      {open && (
        <aside className="shell-feed">
          <header>
            <b>Community pulse</b>
            <span>Every report, plan, sign-up and finished project updates the same model.</span>
          </header>
          <ul>
            {feed.map((a) => (
              <li key={a.id}>
                <i style={{ background: KIND_DOT[a.kind] }} />
                <div>
                  <p>{a.text}</p>
                  <span>{a.county ? `${a.county} · ` : ''}{ago(a.at)}</span>
                </div>
              </li>
            ))}
            {!feed.length && <li className="empty">No activity yet.</li>}
          </ul>
        </aside>
      )}
    </div>
  )
}
