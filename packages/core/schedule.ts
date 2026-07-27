export function toDateTimeLocalValue(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function parseDateTimeLocalValue(value: string): Date | null {
  const raw = (value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

export function defaultCustomScheduleValue(now = new Date()): string {
  const at = new Date(now)
  at.setSeconds(0, 0)
  at.setHours(at.getHours() + 1)
  return toDateTimeLocalValue(at)
}

export function nextHalfHour(now = new Date()): Date {
  const at = new Date(now)
  at.setSeconds(0, 0)
  const minutes = at.getMinutes()
  const delta = minutes < 30 ? (30 - minutes) : (60 - minutes)
  at.setMinutes(minutes + delta)
  return at
}

export function tomorrowMorning(now = new Date()): Date {
  const at = new Date(now)
  at.setDate(at.getDate() + 1)
  at.setHours(9, 0, 0, 0)
  return at
}

export function mondayMorning(now = new Date()): Date {
  const at = new Date(now)
  const day = at.getDay()
  const delta = day === 0 ? 1 : day === 1 ? 7 : (8 - day)
  at.setDate(at.getDate() + delta)
  at.setHours(9, 0, 0, 0)
  return at
}
