import { useMemo } from 'react'
import Combobox from './Combobox'
import { useBaseData } from './baseData'
import { usePlace, type Place } from './place'

// County picker bound to the shared place. "All of North Carolina" clears it.
export default function PlacePicker({ label, size, className, placeholder = 'Type your county', onPick, allowState = true }: {
  label?: string
  size?: 'md' | 'lg'
  className?: string
  placeholder?: string
  onPick?: (p: Place) => void
  allowState?: boolean
}) {
  const base = useBaseData()
  const [place, setPlace] = usePlace()
  const options = useMemo(() => {
    const cs = [...(base?.access.counties ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.fips, label: c.name }))
    return allowState ? [{ value: 'nc', label: 'All of North Carolina' }, ...cs] : cs
  }, [base, allowState])
  return (
    <Combobox
      options={options}
      value={place?.fips ?? (allowState ? 'nc' : null)}
      label={label}
      size={size}
      className={className}
      placeholder={placeholder}
      onChange={(v) => {
        const c = base?.access.counties.find((x) => x.fips === v)
        const p = c ? { fips: c.fips, name: c.name } : null
        setPlace(p)
        onPick?.(p)
      }}
    />
  )
}
