import { useEffect, useState } from 'react'

// The county the visitor is working in. One shared choice that every page starts from.
// `null` = all of North Carolina. Stored per browser; any page can change it.
export type Place = { fips: string; name: string } | null

const KEY = 'allocate.place'
const listeners = new Set<(p: Place) => void>()

function read(): Place {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return v && typeof v.fips === 'string' && typeof v.name === 'string' ? v : null
  } catch {
    return null
  }
}

let current: Place = read()

export function getPlace(): Place {
  return current
}

export function setPlace(p: Place) {
  current = p
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage blocked */
  }
  listeners.forEach((fn) => fn(p))
}

export function usePlace(): [Place, (p: Place) => void] {
  const [p, setP] = useState<Place>(current)
  useEffect(() => {
    listeners.add(setP)
    return () => {
      listeners.delete(setP)
    }
  }, [])
  return [p, setPlace]
}

// "Durham County" → "Durham"
export const shortCounty = (name: string) => name.replace(/ County$/, '')
