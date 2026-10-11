// Small hand-drawn line icons (24px grid, stroke = currentColor).
type P = { size?: number }
const S = ({ size = 18, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const IconIndex = (p: P) => (
  <S {...p}>
    <path d="M12 3 3 8l9 5 9-5-9-5z" />
    <path d="m3 13 9 5 9-5" />
    <path d="m3 17.5 9 4.5 9-4.5" opacity={0.55} />
  </S>
)
export const IconFilter = (p: P) => (
  <S {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </S>
)
export const IconPoverty = (p: P) => (
  <S {...p}>
    <path d="M4 9.5 12 4l8 5.5" />
    <path d="M6 9v10h12V9" />
    <path d="M10 19v-5h4v5" />
  </S>
)
export const IconIncome = (p: P) => (
  <S {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6.5 9.5v.01M17.5 14.5v.01" />
  </S>
)
export const IconFoodAid = (p: P) => (
  <S {...p}>
    <path d="M5 9h14l-1.4 9.2a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8L5 9z" />
    <path d="M9 9V7a3 3 0 0 1 6 0v2" />
  </S>
)
export const IconCar = (p: P) => (
  <S {...p}>
    <path d="M5 16V11l2-4.5h10L19 11v5" />
    <path d="M3.5 16h17" />
    <circle cx="7.5" cy="17.5" r="1.6" />
    <circle cx="16.5" cy="17.5" r="1.6" />
    <path d="m4 4 16 16" opacity={0.6} />
  </S>
)
export const IconFood = (p: P) => (
  <S {...p}>
    <path d="M12 7c-3.5-2.5-8 0-7 5s4 8 7 7c3 1 6-2 7-7s-3.5-7.5-7-5z" />
    <path d="M12 7c0-2 1-3.2 2.5-4" />
  </S>
)
export const IconHealth = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </S>
)
export const IconBus = (p: P) => (
  <S {...p}>
    <rect x="4.5" y="3.5" width="15" height="14" rx="2.5" />
    <path d="M4.5 10.5h15M8 20v-2.5M16 20v-2.5" />
    <path d="M8 14h.01M16 14h.01" />
  </S>
)
export const IconBook = (p: P) => (
  <S {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5v-15z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5v-15z" />
  </S>
)
export const IconAccess = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </S>
)
export const IconSpark = (p: P) => (
  <S {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </S>
)
