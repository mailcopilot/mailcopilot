import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Guard for `mail:snoozeAdd`'s UTC canonicalisation.
 *
 * `listDueSnooze` (packages/db) decides what is due by comparing
 * `snoozed.wake_at` as TEXT against `new Date().toISOString()` — the same
 * string-comparison contract `electron/services/aiScheduleInput.ts` exists to
 * protect on the MCP tool path (see its header comment and
 * `aiScheduleInput.test.ts`). `snoozeWakeAtSchema` only proves the renderer
 * sent a datetime WITH an explicit offset; it does not by itself make the
 * stored value comparable — `2026-09-23T09:00:00+03:00` and
 * `2026-09-23T06:00:00Z` name the same instant but sort differently as
 * strings. Before this fix the handler stored the schema's own output
 * unchanged, so a non-UTC offset from the renderer's `Date` (any timezone
 * except UTC) fired hours late.
 *
 * `electron/main.ts` cannot be imported in a unit test (module-level window
 * creation, IPC registration, DB open — see main.emailAddressSchema.test.ts
 * for the same constraint), so this reads the source, the established mirror
 * pattern for this file.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('mail:snoozeAdd canonicalises the wake time to UTC', () => {
  const marker = "handleIpc('mail:snoozeAdd'"
  const start = MAIN_TS.indexOf(marker)

  it('the handler exists', () => {
    expect(start).toBeGreaterThan(-1)
  })

  const body = MAIN_TS.slice(start, start + 800)

  it('re-parses the wake time through Date before storing it, not the raw schema output', () => {
    // The regression this guards: `snoozeWakeAtSchema.parse(wakeAt)` alone
    // returns whatever offset the caller sent — a valid ISO 8601 string, but
    // not necessarily UTC, and `wake_at` is compared as TEXT.
    expect(body).toContain('new Date(snoozeWakeAtSchema.parse(wakeAt)).toISOString()')
  })

  it('stores the canonicalised value, not a second parse of the raw input', () => {
    const wakeAssignment = body.split('\n').find(l => /const wake =/.test(l))
    expect(wakeAssignment).toBeDefined()
    expect(wakeAssignment).toContain('.toISOString()')

    const insertLine = body.split('\n').find(l => l.includes('insertSnooze('))
    expect(insertLine).toBeDefined()
    // `wake`, not `wakeAt` — passing the unparsed IPC argument through here
    // would silently undo the canonicalisation above.
    expect(insertLine).toMatch(/insertSnooze\([^)]*\bwake\b[^)]*\)/)
    expect(insertLine).not.toMatch(/insertSnooze\([^)]*\bwakeAt\b[^)]*\)/)
  })
})

/**
 * Behavioural pin for the exact transform the handler applies
 * (`new Date(schema.parse(x)).toISOString()`), using the SAME grammar the
 * schema is declared with (`z.string().datetime({ offset: true })` — see
 * `snoozeWakeAtSchema` a few lines above the handler). This cannot import the
 * schema itself (main.ts is not importable), so it is pinned by construction
 * against the source-mirror check above: if the handler's literal transform
 * ever changes, that check fails first and this one is updated alongside it,
 * rather than drifting silently.
 */
describe('the canonicalisation transform itself', () => {
  const schema = z.string().datetime({ offset: true })
  const canonicalize = (raw: string) => new Date(schema.parse(raw)).toISOString()

  it('an explicit non-UTC offset becomes the equivalent UTC instant', () => {
    // 09:00+03:00 IS 06:00Z. Stored as text unchanged, "09:00+03:00" sorts
    // after "06:00:00.000Z" and the row fires three hours late.
    expect(canonicalize('2026-09-23T09:00:00+03:00')).toBe('2026-09-23T06:00:00.000Z')
  })

  it('a Z-suffixed instant round-trips to itself, in millisecond form', () => {
    expect(canonicalize('2026-09-23T06:00:00Z')).toBe('2026-09-23T06:00:00.000Z')
  })

  it('two instants normalised from different offsets sort by real time', () => {
    const a = canonicalize('2026-09-23T09:00:00+03:00')
    const b = canonicalize('2026-09-23T08:00:00+00:00')
    expect(a < b).toBe(true)
  })

  it('rejects a wall-clock time with no offset before it ever reaches Date', () => {
    expect(() => schema.parse('2026-09-23T09:00:00')).toThrow()
  })

  it('rejects natural language', () => {
    expect(() => schema.parse('tomorrow 09:00')).toThrow()
  })
})
