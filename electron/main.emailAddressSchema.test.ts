import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Guard for the IPC-facing half of the IDN-address fix.
 *
 * The behaviour itself is unit-tested in packages/core/emailAddress.test.ts.
 * What cannot be tested there is that `electron/main.ts` actually USES those
 * schemas: main.ts has module-level side effects (window creation, IPC
 * registration, DB open) and cannot be imported in a unit test, so this suite
 * reads the source — the same mirror pattern as main.settingsClamp.test.ts and
 * friends.
 *
 * What it protects: the regression was `z.string().email()` on an IPC payload,
 * and the likely way it comes back is a NEW schema written the obvious way.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const MAIN_TS_CODE = MAIN_TS.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

describe('main.ts email address validation', () => {
  it('has no zod email validator of its own', () => {
    // zod 4's `z.email()` / `z.string().email()` is ASCII-only: it rejects
    // `info@xn--80a1acny.xn--p1ai`, `user@почта.рф` and `a=b@example.com`.
    // Every address in main.ts goes through @mailcopilot/core/emailAddress.
    expect(MAIN_TS_CODE.match(/\.email\(/g) ?? []).toHaveLength(0)
  })

  it('imports the shared address schemas by path, not through the core barrel', () => {
    // The barrel is bundled into the RENDERER, which has no zod today.
    expect(MAIN_TS).toContain("from '@mailcopilot/core/emailAddress'")
  })

  it('validates the autoconfig address with the shared schema', () => {
    const marker = "handleIpc('accounts:autoconfig'"
    const start = MAIN_TS.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, start + 400)
    expect(body).toContain('trimmedEmailAddressSchema.parse(email)')
  })

  it('never refuses ui:openCompose over a prefill recipient', () => {
    // `originalRecipients` carries the From/To/Cc pool of the message being
    // replied to — addresses chosen by the SENDER. Validating them strictly
    // meant one odd address rejected the whole payload and "Reply" opened no
    // window at all. prefillAddressListSchema drops bad entries instead.
    const line = MAIN_TS.split('\n').find(l => l.trim().startsWith('originalRecipients:'))
    expect(line).toBeDefined()
    expect(line).toContain('prefillAddressListSchema')
  })
})
