import { describe, it, expect } from 'vitest'
import { computeIsE2E, mayRunAlongsideOtherInstances } from './e2eFlag'

/**
 * The e2e opt-in decides whether ~60 branches in `main.ts` serve in-memory
 * fixtures instead of the user's real mail, and whether two confirmation gates
 * (native certificate trust, audit-log clear) short-circuit. The whole point of
 * the function is the packaged column below: an environment variable is
 * settable by anything running as the user, so on a shipped build it must
 * decide nothing at all.
 *
 * Truth table (mirrors the doc comment on `computeIsE2E`):
 *
 *   isPackaged | MAILCOPILOT_E2E=1 | result
 *   -----------+-------------------+--------
 *   true       | true              | false
 *   true       | false             | false
 *   false      | true              | true
 *   false      | false             | false
 */
describe('computeIsE2E — truth table', () => {
  it('refuses a packaged build even with the env opt-in (env-injection attack)', () => {
    expect(computeIsE2E({ MAILCOPILOT_E2E: '1' }, true)).toBe(false)
  })

  it('refuses a packaged build without the env opt-in', () => {
    expect(computeIsE2E({}, true)).toBe(false)
  })

  it('accepts an unpackaged build with the env opt-in (dev run / Playwright harness)', () => {
    expect(computeIsE2E({ MAILCOPILOT_E2E: '1' }, false)).toBe(true)
  })

  it('refuses an unpackaged build without the env opt-in (plain `electron .`)', () => {
    expect(computeIsE2E({}, false)).toBe(false)
  })
})

describe('computeIsE2E — the opt-in value itself', () => {
  // The harness sets exactly '1' (tests/e2e/helpers.ts). Accepting anything
  // truthy would widen the surface for no benefit — and `'0'` / `'false'`
  // would then read as an opt-IN, which is the wrong direction for a flag
  // whose "on" state disables security gates.
  it.each(['0', 'true', 'yes', '', ' 1', '1 ', 'TRUE'])(
    'does not treat %j as an opt-in',
    (value) => {
      expect(computeIsE2E({ MAILCOPILOT_E2E: value }, false)).toBe(false)
    },
  )

  it('treats an explicitly undefined variable as absent', () => {
    expect(computeIsE2E({ MAILCOPILOT_E2E: undefined }, false)).toBe(false)
  })

  it('is packaged-first: the value is never even consulted on a shipped build', () => {
    // Guards against a future refactor that reorders the checks into
    // `env.MAILCOPILOT_E2E === '1' && !isPackaged` and then loses the second
    // half in a merge. A getter is the only way to observe the read.
    let reads = 0
    const env = {
      get MAILCOPILOT_E2E() {
        reads += 1
        return '1'
      },
    }
    expect(computeIsE2E(env, true)).toBe(false)
    expect(reads).toBe(0)
  })
})

describe('mayRunAlongsideOtherInstances — the single-instance lock decision', () => {
  // Two instances on one profile share the send queue; the second one resends a
  // send the first is still performing. Only the e2e harness may skip the lock.
  const lock = (granted: boolean) => {
    let calls = 0
    return { request: () => { calls += 1; return granted }, calls: () => calls }
  }

  it('a packaged build takes the lock even with the e2e environment variable set', () => {
    const granted = lock(true)
    expect(mayRunAlongsideOtherInstances({ MAILCOPILOT_E2E: '1' }, true, granted.request)).toBe(true)
    expect(granted.calls()).toBe(1)
    // ...and quits when another instance holds it.
    const refused = lock(false)
    expect(mayRunAlongsideOtherInstances({ MAILCOPILOT_E2E: '1' }, true, refused.request)).toBe(false)
    expect(refused.calls()).toBe(1)
  })

  it('a packaged build without the variable takes the lock too', () => {
    const refused = lock(false)
    expect(mayRunAlongsideOtherInstances({}, true, refused.request)).toBe(false)
    expect(refused.calls()).toBe(1)
  })

  it('an unpackaged run without the variable takes the lock (a plain dev run)', () => {
    const refused = lock(false)
    expect(mayRunAlongsideOtherInstances({}, false, refused.request)).toBe(false)
    expect(refused.calls()).toBe(1)
  })

  it('the e2e harness (unpackaged and opted in) skips the lock and never asks for it', () => {
    const refused = lock(false)
    expect(mayRunAlongsideOtherInstances({ MAILCOPILOT_E2E: '1' }, false, refused.request)).toBe(true)
    expect(refused.calls()).toBe(0)
  })

  it('reads the same opt-in value as computeIsE2E, nothing looser', () => {
    for (const value of ['0', 'true', '', ' 1']) {
      const refused = lock(false)
      expect(mayRunAlongsideOtherInstances({ MAILCOPILOT_E2E: value }, false, refused.request)).toBe(false)
      expect(refused.calls()).toBe(1)
    }
  })
})
