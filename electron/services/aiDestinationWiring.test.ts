/**
 * §2.119 — every route that can move the AI destination goes through the gate.
 *
 * WHY A SOURCE-LEVEL TEST. The guard's own behaviour is covered by
 * aiDestinationGuard.test.ts, but a guard is only worth its call sites: the
 * defect being fixed here was not a broken check, it was the absence of one on
 * a path nobody had listed. electron/main.ts cannot be imported by a unit test
 * (it builds windows, opens the database and registers ~300 IPC handlers at
 * module scope), so the wiring is asserted against its source.
 *
 * The precedent this guards against is recorded in CLAUDE.md §2.82: a
 * telemetry-consent restriction was placed on the consent channel only, and an
 * ordinary `settings:save` walked around it. A guard on one of two routes is
 * worse than none, because it reads as protection.
 *
 * The last case is the important one — it does not enumerate today's routes,
 * it fails on a FUTURE handler that starts reading these fields without asking
 * the guard.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * COMMENTS ARE STRIPPED before anything below looks at the source, and that is
 * not cosmetic. These handlers are heavily commented, and every comment names
 * the functions the assertions search for — so a substring check against the
 * raw text stays green when the real call is deleted and its explanation left
 * behind. The prose about the guard is not the guard.
 */
const MAIN_TS = stripComments(
  readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8'),
)

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Code of one `handleIpc('<channel>', …)` registration, up to the next one. */
function handlerSource(channel: string): string {
  const start = MAIN_TS.indexOf(`handleIpc('${channel}'`)
  expect(start, `handleIpc('${channel}') not found in electron/main.ts`).toBeGreaterThan(-1)
  const next = MAIN_TS.indexOf('\nhandleIpc(', start + 1)
  return MAIN_TS.slice(start, next === -1 ? undefined : next)
}

/** The name the handler binds the guard's verdict to, proving there is a real
 *  awaited call and giving the assertions something to follow. */
function verdictBinding(source: string, channel: string): string {
  const match = /const\s+(\w+)\s*=\s*await\s+ensureAiDestinationApproved\(/.exec(source)
  if (!match) {
    throw new Error(`${channel} does not await ensureAiDestinationApproved(...) — a mention is not a call`)
  }
  return match[1]
}

describe('settings:save', () => {
  const source = handlerSource('settings:save')

  it('actually calls the guard — and awaits it — before it writes anything', () => {
    const verdict = verdictBinding(source, 'settings:save')
    expect(source.indexOf('ensureAiDestinationApproved('))
      .toBeLessThan(source.indexOf('saveSettings('))
    // And the answer is used: it decides what is written, and what the
    // renderer is told. A call whose verdict is dropped is not a gate.
    expect(source).toMatch(new RegExp(`applyAiDestinationDecision\\([\\s\\S]*?${verdict}\\.ok`))
    expect(source).toContain(`!${verdict}.ok`)
  })

  it('judges the effective post-merge values, not the raw payload', () => {
    expect(source).toContain('resolveRequestedAiDestination')
  })

  it('puts the stored addresses back when the change was not confirmed', () => {
    expect(source).toContain('applyAiDestinationDecision')
  })

  it('tells the renderer the change was declined instead of reporting plain success', () => {
    expect(source).toContain('aiDestinationRejected')
    expect(source).toContain('aiDestinationRejectionMessage')
  })
})

describe('ai:checkAuth', () => {
  const source = handlerSource('ai:checkAuth')

  it('gates the not-yet-saved overrides before the key is sent anywhere', () => {
    const verdict = verdictBinding(source, 'ai:checkAuth')
    expect(source.indexOf('ensureAiDestinationApproved('))
      .toBeLessThan(source.indexOf('aiCheckAuth('))
    // A refusal returns instead of falling through to the request.
    expect(source).toContain(`!${verdict}.ok`)
    expect(source.indexOf(`!${verdict}.ok`)).toBeLessThan(source.indexOf('aiCheckAuth('))
  })

  it('reports a refusal rather than silently falling back to the stored address', () => {
    expect(source).toContain('aiDestinationRejectionMessage')
  })
})

describe('no ungated route into the destination fields', () => {
  it('every IPC handler in main.ts that touches them also consults the guard', () => {
    const registrations = [...MAIN_TS.matchAll(/\nhandleIpc\('([^']+)'/g)].map(m => ({
      channel: m[1],
      index: m.index ?? 0,
    }))
    const ungated: string[] = []
    for (let i = 0; i < registrations.length; i++) {
      const end = i + 1 < registrations.length ? registrations[i + 1].index : MAIN_TS.length
      const body = MAIN_TS.slice(registrations[i].index, end)
      const touchesDestination = body.includes('aiOpenAiBaseUrl') || body.includes('aiProxyUrl')
      if (!touchesDestination) continue
      if (!body.includes('ensureAiDestinationApproved')) ungated.push(registrations[i].channel)
    }
    expect(
      ungated,
      'these handlers read or write the AI destination without the §2.119 confirmation',
    ).toEqual([])
  })
})
