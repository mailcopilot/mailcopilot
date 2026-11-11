import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { finalSendFailureText } from '../packages/net/smtp'
import { presentedTaggedText } from '../src/utils/errorPresentation'

/**
 * electron/main.sendQueueFailureText.test.ts — wiring guard for the final
 * failure branch of `processSendQueue()` in electron/main.ts.
 *
 * main.ts is a 10k+ LOC hotspot with module-load side effects that nothing in
 * this repo imports (same rationale as electron/main.imapAuthLatchWiring.test.ts),
 * so the branch cannot be executed from a test without refactoring production
 * code. What CAN be pinned without mirroring any logic:
 *
 *   1. the text computed by the REAL `finalSendFailureText` is the one that
 *      reaches all three sinks of the final-failure branch (the stored
 *      `last_error`, the `mail:sendFailed` broadcast, the notification body) —
 *      checked on the actual source text of the branch;
 *   2. the renderer decodes what that function produces (real producer -> real
 *      consumer), so a tag format drift between main and renderer fails here.
 *
 * What this does NOT prove: that the branch is reached at runtime (that needs
 * the processSendQueue extraction noted in the test-gen report).
 */

const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

const permanentBranch = (): string =>
  sliceBetween(
    source,
    '// Permanent error (5xx) or max attempts reached',
    '} finally {\n        notifyQueueChanged(item.accountId)',
  )

describe('main.ts — send-queue final-failure branch uses finalSendFailureText', () => {
  it('imports finalSendFailureText from the net package instead of redefining it', () => {
    const importList = source.match(/import \{([^}]*)\} from '\.\.\/packages\/net\/index'/)?.[1] ?? ''
    expect(importList.split(',').map((n) => n.trim())).toContain('finalSendFailureText')
    expect(source).not.toMatch(/function finalSendFailureText\b/)
  })

  it('computes the text once from the caught error', () => {
    expect(permanentBranch()).toContain('const failureText = finalSendFailureText(e)')
  })

  it('stores, broadcasts and notifies with that same text, not String(e)', () => {
    const branch = permanentBranch()
    expect(branch).toMatch(/markSendQueueFailed\(item\.id, failureText\)/)
    expect(branch).toMatch(/broadcast\('mail:sendFailed', \{[^}]*error: failureText,/s)
    expect(branch).toMatch(/addNotification\(\s*'send_failed',\s*subj \|\| 'Send failed',\s*failureText,/)
    // The raw text is still allowed in the local log line only.
    const outsideLog = branch
      .split('\n')
      .filter((line) => !line.includes('logMail.'))
      .join('\n')
    expect(outsideLog).not.toContain('String(e)')
  })

  it('reschedules only on the verdict of classifySmtpError, with nothing else widening it', () => {
    expect(source).toContain('const { code, isTransient } = classifySmtpError(e)')
    expect(source).toContain('if (isTransient && item.attemptCount < 5) {')
    // The scheduled-send and manual "send now" paths all go through processSendQueue.
    expect(source.match(/rescheduleSendQueue\(item\.id, retryAt\)/g)).toHaveLength(1)
  })

  it('resets stuck "sending" rows from exactly one place, after the pass mutex is taken', () => {
    // listDueSendQueue() un-sticks rows left in `sending` for over two minutes. A send that is
    // still in flight is safe from it only because every pass holds sendQueueProcessing for its
    // whole duration and this is the only caller.
    expect(source.match(/listDueSendQueue\(/g)).toHaveLength(1)
    const start = source.indexOf('async function processSendQueue() {')
    const guard = source.indexOf('if (sendQueueProcessing) return', start)
    const call = source.indexOf('listDueSendQueue(', start)
    expect(start).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(start)
    expect(call).toBeGreaterThan(guard)
    expect(source.indexOf('sendQueueProcessing = true', guard)).toBeLessThan(call)
  })

  it('leaves the transient (retry) branch storing no failure text', () => {
    const transient = sliceBetween(source, 'if (isTransient && item.attemptCount < 5) {', '// Permanent error (5xx)')
    expect(transient).not.toContain('finalSendFailureText')
    expect(transient).not.toContain('markSendQueueFailed')
  })
})

describe('final failure text -> renderer decoding (real producer, real consumer)', () => {
  const t = ((key: string) => `<${key}>`) as unknown as Parameters<typeof presentedTaggedText>[0]

  it('a pre-greeting failure is shown as the network/VPN sentence, not the raw errno text', () => {
    const err = Object.assign(new Error('connect ENETUNREACH 2a00::1:465'), {
      code: 'ESOCKET',
      command: 'CONN',
      syscall: 'connect',
    })
    expect(presentedTaggedText(t, finalSendFailureText(err))).toBe('<app.errors.presented.pre_greeting>')
  })

  it('a session that broke after the server was reached is shown as the unknown-delivery sentence', () => {
    const err = Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' })
    expect(presentedTaggedText(t, finalSendFailureText(err))).toBe('<app.errors.presented.delivery_unknown>')
  })

  it('a server refusal keeps its own text through the same decoder', () => {
    const err = Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550 })
    expect(presentedTaggedText(t, finalSendFailureText(err))).toBe('Error: 550 5.1.1 no such user')
  })
})

describe('Gmail 465 -> 587 fallback in sendMailWithAccountConfig', () => {
  it('is taken only after a failure before the greeting (a later timeout may follow an accepted message)', () => {
    const fallback = sliceBetween(source, 'const canFallbackGmail', 'result = await trySend({ ...cfg.smtp, port: 587')
    expect(fallback).toContain('isTimeout && canFallbackGmail && isPreGreetingFailure(e)')
  })
})
