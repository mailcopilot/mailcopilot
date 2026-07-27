import { describe, expect, it } from 'vitest'
import {
  defaultCustomScheduleValue,
  mondayMorning,
  nextHalfHour,
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
  tomorrowMorning,
} from './schedule'

describe('src/utils/schedule', () => {
  it('nextHalfHour rounds up to the nearest 30 minutes', () => {
    const at1010 = nextHalfHour(new Date('2026-02-10T10:10:45'))
    expect(at1010.getHours()).toBe(10)
    expect(at1010.getMinutes()).toBe(30)
    expect(at1010.getSeconds()).toBe(0)

    const at1030 = nextHalfHour(new Date('2026-02-10T10:30:00'))
    expect(at1030.getHours()).toBe(11)
    expect(at1030.getMinutes()).toBe(0)
    expect(at1030.getSeconds()).toBe(0)
  })

  it('tomorrowMorning sets tomorrow at 09:00', () => {
    const at = tomorrowMorning(new Date('2026-02-10T20:15:00'))
    expect(at.getDate()).toBe(11)
    expect(at.getHours()).toBe(9)
    expect(at.getMinutes()).toBe(0)
  })

  it('mondayMorning correctly calculates the next Monday', () => {
    // Tuesday -> next Monday (+6)
    const tue = mondayMorning(new Date('2026-02-10T10:00:00'))
    expect(tue.getDay()).toBe(1)
    expect(tue.getDate()).toBe(16)
    expect(tue.getHours()).toBe(9)

    // Monday -> next Monday (+7)
    const mon = mondayMorning(new Date('2026-02-09T10:00:00'))
    expect(mon.getDay()).toBe(1)
    expect(mon.getDate()).toBe(16)
    expect(mon.getHours()).toBe(9)
  })

  it('toDateTimeLocalValue + parseDateTimeLocalValue produce a valid roundtrip', () => {
    const src = new Date('2026-02-10T18:42:33')
    const local = toDateTimeLocalValue(src)
    const parsed = parseDateTimeLocalValue(local)
    expect(parsed).not.toBeNull()
    expect(parsed?.getFullYear()).toBe(src.getFullYear())
    expect(parsed?.getMonth()).toBe(src.getMonth())
    expect(parsed?.getDate()).toBe(src.getDate())
    expect(parsed?.getHours()).toBe(src.getHours())
    expect(parsed?.getMinutes()).toBe(src.getMinutes())
  })

  it('parseDateTimeLocalValue returns null for invalid input', () => {
    expect(parseDateTimeLocalValue('')).toBeNull()
    expect(parseDateTimeLocalValue('2026/02/10 12:00')).toBeNull()
    expect(parseDateTimeLocalValue('2026-99-10T12:00')).toBeNull()
  })

  it('defaultCustomScheduleValue returns a value for input datetime-local', () => {
    const val = defaultCustomScheduleValue(new Date('2026-02-10T10:15:27'))
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})
