import { useEffect, useState } from 'react'
import Explore from './Explore.tsx'
import Landing from './Landing.tsx'

// Two views: the story (landing) and the map (#explore), so a link can open either directly.
export default function Root() {
  const read = () => (window.location.hash === '#explore' ? 'explore' : 'story')
  const [view, setView] = useState(read)
  useEffect(() => {
    const onHash = () => {
      setView(read())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return view === 'explore' ? (
    <Explore onHome={() => (window.location.hash = '')} />
  ) : (
    <Landing onExplore={() => (window.location.hash = 'explore')} />
  )
}
