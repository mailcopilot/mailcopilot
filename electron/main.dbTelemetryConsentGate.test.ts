import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.82 — the packages/db telemetry seam buffers spans, and buffering is
 * COLLECTION, so it obeys the same gate as metrics.ts's aggregate window.
 * packages/db cannot import electron/telemetryGate (layer purity), so the gate
 * is INJECTED here and the reset hook registered here.
 *
 * Missing wiring is harmless (the seam is fail-closed and retains nothing —
 * asserted in packages/db/telemetry.test.ts), so what this file guards is the
 * opposite: a constant `true` injected instead of the gate, or a gate without
 * the transition hook, which leaves a backlog alive across a withdrawal.
 *
 * main.ts is not importable (module-level side effects), so this reads the
 * source, like main.headersIncompleteGate.test.ts.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('main.ts — the db telemetry span buffer obeys the consent gate', () => {
  it('injects the real gate function, not a constant', () => {
    expect(MAIN_TS).toContain('setDbTelemetryCollectionGate(isTelemetryCollectionAllowed)')
    expect(MAIN_TS).not.toMatch(/setDbTelemetryCollectionGate\(\s*\(\s*\)\s*=>\s*true\s*\)/)
  })

  it('registers the buffer reset on every consent transition', () => {
    expect(MAIN_TS).toContain('registerTelemetryCollectionResetHook(resetDbTelemetryBuffer)')
  })

  it('takes both from their canonical modules', () => {
    // The gate is the one in electron/telemetryGate.ts (single driver:
    // setSentryUserEnabled), not a local mirror of the settings flag.
    expect(MAIN_TS).toMatch(
      /import \{[^}]*isTelemetryCollectionAllowed[^}]*registerTelemetryCollectionResetHook[^}]*\} from '\.\/telemetryGate'/,
    )
    expect(MAIN_TS).toMatch(
      /import \{[^}]*setDbTelemetryCollectionGate[^}]*\} from '\.\.\/packages\/db\/telemetry'/,
    )
  })
})
