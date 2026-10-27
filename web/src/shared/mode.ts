import { useEffect, useState } from 'react'

// Two ways to use Allocate NC. 'community' = residents and volunteers; 'planner' = nonprofits, council members,
// planners. Chosen on the landing page; pages that belong to one mode switch to it, shared pages keep it.
export type Mode = 'community' | 'planner'

const KEY = 'allocate.mode'
const listeners = new Set<(m: Mode) => void>()

function read(): Mode {
  try {
    return localStorage.getItem(KEY) === 'planner' ? 'planner' : 'community'
  } catch {
    return 'community'
  }
}

let current: Mode = read()

export function getMode(): Mode {
  return current
}

export function setMode(m: Mode) {
  if (m === current) return
  current = m
  try {
    localStorage.setItem(KEY, m)
  } catch {
    /* storage blocked */
  }
  listeners.forEach((fn) => fn(m))
}

// Set during render (no notifications), then announce after commit — avoids cross-component updates mid-render.
export function primeMode(m: Mode) {
  current = m
  try {
    localStorage.setItem(KEY, m)
  } catch {
    /* storage blocked */
  }
}
export function announceMode() {
  listeners.forEach((fn) => fn(current))
}

export function useMode(): Mode {
  const [m, setM] = useState<Mode>(current)
  useEffect(() => {
    listeners.add(setM)
    setM(current)
    return () => {
      listeners.delete(setM)
    }
  }, [])
  return m
}
