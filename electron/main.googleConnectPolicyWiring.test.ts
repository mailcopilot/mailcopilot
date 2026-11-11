import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * electron/main.googleConnectPolicyWiring.test.ts — structural wiring guard
 * for §2.297 (no new mailboxes through Google sign-in in the official build).
 *
 * What this file is NOT: a test of the policy. The refusals and their order
 * (plan before the browser, token address before any write, mailbox identity
 * before and after the probes, refresh token before the save on a conversion)
 * are real code in electron/services/googleConnectService.ts and are driven
 * with fake dependencies in googleConnectService.test.ts; the address and
 * save-guard rules are in googleConnectPolicy.test.ts. A previous version of
 * this file searched main.ts for the order of strings inside the handler and
 * gave false coverage — those tests are gone on purpose.
 *
 * What remains is the part no unit test can see because main.ts (a 10k+ LOC
 * hotspot nothing imports) is the only place it lives: the handlers delegate
 * to the extracted symbols instead of restating them.
 */

const electronDir = __dirname
const mainSource = fs.readFileSync(path.join(electronDir, 'main.ts'), 'utf8')
const preloadSource = fs.readFileSync(path.join(electronDir, 'preload.ts'), 'utf8')

function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

const connectHandler = sliceBetween(mainSource, "handleIpc('oauth:google:connect'", "handleIpc('oauth:microsoft:connect'")

describe('oauth:google:connect handler is thin (§2.297)', () => {
  it('keeps the e2e guard before anything else', () => {
    const guard = connectHandler.indexOf("if (IS_E2E) throw new Error('Google OAuth is not available in e2e mode')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(connectHandler.indexOf('connectGoogleAccount('))
  })

  it('delegates the whole connect sequence to connectGoogleAccount and inlines none of its steps', () => {
    expect(connectHandler).toContain('const res = await connectGoogleAccount(existingId, {')
    for (const inlined of ['planGoogleConnect(', 'verifyTokenAddress(', 'mailboxIdentity(', 'await saveAccount(', 'await setOauthRefreshToken(']) {
      expect(connectHandler, `${inlined} must live in the service, not the handler`).not.toContain(inlined)
    }
  })

  it('injects the real build switch and configured state as functions (read per call, not captured)', () => {
    expect(connectHandler).toContain('configured: isGoogleOAuthConfigured,')
    expect(connectHandler).toContain('newMailboxesAllowed: areNewGoogleMailboxesAllowed,')
  })

  it('returns a refusal verdict to the renderer before any success-path reporting', () => {
    const refusal = connectHandler.indexOf('if (!res.ok) return res')
    expect(refusal).toBeGreaterThan(connectHandler.indexOf('connectGoogleAccount('))
    expect(refusal).toBeLessThan(connectHandler.indexOf('accountAuthState.noteSignedIn('))
    expect(refusal).toBeLessThan(connectHandler.indexOf('clearImapAuthLatch('))
    expect(refusal).toBeLessThan(connectHandler.indexOf("broadcast('accounts:changed'"))
  })

  it('reports the sign-in only when the IMAP test passed, and clears the latch unconditionally', () => {
    expect(connectHandler).toContain(
      'if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)\n  clearImapAuthLatch(res.id)',
    )
  })

  it('never revokes a token at Google: revoking would remove the whole grant of an unrelated connected account', () => {
    expect(connectHandler).not.toMatch(/revoke/i)
  })

  it('forwards the login hint from doGoogleOAuthFlow to runGoogleOAuthFlow', () => {
    const helper = sliceBetween(mainSource, 'async function doGoogleOAuthFlow(', 'googleOAuthBusy = false')
    expect(helper).toContain('loginHint?: string')
    expect(helper).toMatch(/runGoogleOAuthFlow\(\{[\s\S]*loginHint,/)
  })
})

describe('accounts:save OAuth identity guard wiring (§2.297)', () => {
  const saveHandler = sliceBetween(mainSource, "handleIpc('accounts:save'", "handleIpc('accounts:removePreview'")

  // The guard refuses first; the write it performs runs inside the per-id save queue.
  const GUARDED_CALL = `saveAccountGuarded(parsed, {
    getAccountMeta,
    saveAccount: (input, gate) => saveAccountFenced(saveAccount, input, gate),
  })`

  it('goes through saveAccountGuarded with the real store functions, saving through the fence', () => {
    expect(saveHandler).toContain(`await ${GUARDED_CALL}`)
  })

  it('does not call saveAccount directly (that would bypass the guard)', () => {
    const withoutGuardedCall = saveHandler.replace(GUARDED_CALL, '')
    expect(withoutGuardedCall).not.toMatch(/\bsaveAccount\b/)
    expect(saveHandler).not.toContain('refuseOAuthIdentityRewrite(')
  })

  it('imports the guard and the service from their modules', () => {
    expect(mainSource).toContain("import { saveAccountGuarded } from './googleConnectPolicy'")
    expect(mainSource).toContain("import { connectGoogleAccount } from './services/googleConnectService'")
  })
})

describe('oauth:google:availability wiring (§2.297)', () => {
  it('is registered in main and reports the configured state and the new-mailbox switch', () => {
    const handler = sliceBetween(mainSource, "handleIpc('oauth:google:availability'", "handleIpc('oauth:google:connect'")
    expect(handler).toContain('configured: isGoogleOAuthConfigured()')
    expect(handler).toContain('newMailboxes: areNewGoogleMailboxesAllowed()')
  })

  it('is whitelisted in the preload bridge', () => {
    expect(preloadSource).toContain("'oauth:google:availability'")
  })

  it('keeps the connect channel whitelisted too', () => {
    expect(preloadSource).toContain("'oauth:google:connect'")
  })
})

describe('accounts:autoconfig Gmail-card preset wiring (§2.297)', () => {
  const handler = sliceBetween(mainSource, "handleIpc('accounts:autoconfig'", 'return autoconfig(parsedEmail)')

  it('answers the "gmail" preset with the gmail.com servers before any domain lookup or e2e shortcut', () => {
    const preset = handler.indexOf('return gmailPresetAutoconfig()')
    expect(preset).toBeGreaterThan(-1)
    expect(preset).toBeLessThan(handler.indexOf('if (IS_E2E)'))
  })

  it('accepts only the literal "gmail" as the preset argument', () => {
    expect(handler).toContain("z.literal('gmail').optional().parse(preset ?? undefined) === 'gmail'")
  })
})
