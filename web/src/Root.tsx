import { useEffect, useState } from 'react'
import Landing from './Landing.tsx'
import AppShell, { type Route } from './shared/AppShell.tsx'

// Hash routes: '' story · '#/home' · '#/map' · '#/report' · '#/involved' · '#/plan' · '#/projects' · '#/tour'.
// Old '#explore' links open the map.
const ROUTES: Route[] = ['home', 'map', 'report', 'involved', 'plan', 'projects', 'tour']
function read(): Route | 'story' {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h === 'explore') return 'map'
  if (h === 'app') return 'home'
  const base = h.split('?')[0] as Route
  return ROUTES.includes(base) ? base : 'story'
}

export default function Root() {
  const [view, setView] = useState(read)
  useEffect(() => {
    const onHash = () => {
      setView(read())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return view === 'story' ? <Landing onExplore={() => (window.location.hash = '/home')} /> : <AppShell route={view} />
}
