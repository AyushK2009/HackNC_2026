import { useEffect, useMemo, useRef, useState } from 'react'
import './combobox.css'

// A dropdown you can also type into: the full list shows on open, and typing narrows it.
export type Option = { value: string; label: string; hint?: string }

type Props = {
  options: Option[]
  value: string | null
  onChange: (value: string) => void
  placeholder?: string
  label?: string // visible prefix inside the control, e.g. "County"
  className?: string
  size?: 'md' | 'lg'
  autoFocus?: boolean
}

export default function Combobox({ options, value, onChange, placeholder = 'Search…', label, className = '', size = 'md', autoFocus }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value) ?? null

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    const starts = options.filter((o) => o.label.toLowerCase().startsWith(s))
    const has = options.filter((o) => !o.label.toLowerCase().startsWith(s) && o.label.toLowerCase().includes(s))
    return [...starts, ...has]
  }, [q, options])

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])

  useEffect(() => setHi(0), [q])
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  function openList() {
    setOpen(true)
    setQ('')
    const i = options.findIndex((o) => o.value === value)
    setHi(i >= 0 ? i : 0)
  }
  function close() {
    setOpen(false)
    setQ('')
  }
  function pick(o: Option) {
    onChange(o.value)
    close()
    input.current?.blur()
  }

  return (
    <div ref={root} className={`cbx cbx-${size} ${open ? 'open' : ''} ${className}`}>
      <div className="cbx-control" onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus(); if (!open) openList() } }}>
        {label && <span className="cbx-label">{label}</span>}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={open ? q : selected?.label ?? ''}
          placeholder={open && selected ? selected.label : placeholder}
          onFocus={() => !open && openList()}
          onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openList(); else setHi((h) => Math.min(shown.length - 1, h + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[hi]) pick(shown[hi]) }
            else if (e.key === 'Escape') { close(); input.current?.blur() }
          }}
          aria-expanded={open}
          role="combobox"
        />
        <span className="cbx-caret" aria-hidden>▾</span>
      </div>
      {open && (
        <ul ref={list} className="cbx-list" role="listbox">
          {shown.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`${i === hi ? 'on' : ''} ${o.value === value ? 'sel' : ''}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o) }}
            >
              <span>{o.label}</span>
              {o.hint && <em>{o.hint}</em>}
            </li>
          ))}
          {!shown.length && <li className="none">No match for “{q}”</li>}
        </ul>
      )}
    </div>
  )
}
