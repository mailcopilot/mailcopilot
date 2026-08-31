import { describe, expect, it } from 'vitest'
import { IPC_TEXT_TRANSPORT_CAP, proofreadCheckSchema } from './ipcSchemas'
import type { ProofreadResult } from '../packages/types'

/**
 * §3.3 B7 AI Proofread — `ai:proofread:check` IPC handler schema tests.
 *
 * The handler body in `electron/main.ts` is a thin parse-then-forward:
 *   const req = proofreadCheckSchema.parse(payload)
 *   return generateProofread(deps, req)
 *
 * This file pins the REAL imported schema (not a hand-maintained copy) so that
 * a regression in the production schema fails here. Two properties are pinned,
 * and they pull in opposite directions:
 *   - the generous TRANSPORT ceiling must stay (the renderer is a separate
 *     process; main copies the string before any generator refusal runs), and
 *   - it must stay far above the 8000-char product cap, so a merely long draft
 *     still reaches the generator's structured `too_long` refusal instead of
 *     being thrown out as a zod validation error at the IPC boundary.
 *
 * Mirror pattern identical to `main.quickActionsInstantReply.test.ts`.
 */

/** Mirrors the `ai:proofread:check` handler body with an injectable generator. */
async function mirrorProofreadHandler(
  payload: unknown,
  generateProofread: (req: { accountId: number; text: string }) => Promise<ProofreadResult>,
): Promise<ProofreadResult> {
  const req = proofreadCheckSchema.parse(payload)
  return generateProofread(req)
}

describe('proofreadCheckSchema — §3.3 B7 (real production schema)', () => {
  it('accepts a well-formed (accountId, text) payload', () => {
    const result = proofreadCheckSchema.safeParse({ accountId: 1, text: 'Hello world.' })
    expect(result.success).toBe(true)
  })

  it('accepts an empty text — the too_long / empty_input refusal is the generator job, not the schema', () => {
    // A zod min(1) here would turn "your draft is empty" into a thrown IPC
    // error. The structured refusal is the generator discipline (§2.78).
    const result = proofreadCheckSchema.safeParse({ accountId: 1, text: '' })
    expect(result.success).toBe(true)
  })

  it('accepts a text far past the 8000-char product cap so the generator can answer too_long — that cap is a generator refusal, not a schema error', () => {
    // Same reasoning as the B4 quickActionRewriteSchema test: the PRODUCT cap
    // is a REFUSAL the generator owns, not a validation error at the boundary.
    const result = proofreadCheckSchema.safeParse({ accountId: 1, text: 'x'.repeat(500_000) })
    expect(result.success).toBe(true)
  })

  it('accepts a text exactly at the transport ceiling — the ceiling bounds the payload, it does not shrink the refusable range', () => {
    const result = proofreadCheckSchema.safeParse({
      accountId: 1,
      text: 'x'.repeat(IPC_TEXT_TRANSPORT_CAP),
    })
    expect(result.success).toBe(true)
  })

  it('rejects a text past the transport ceiling — the renderer is a separate process and main copies the string before any generator refusal can run', () => {
    // A compromised renderer can call the whitelisted channel directly with a
    // multi-megabyte payload; main materializes it on IPC receipt, before the
    // generator's `too_long` ever executes. Only absurd sizes reach this: the
    // ceiling sits ~125x above the 8000-char product cap, so no human draft is
    // ever converted from a structured refusal into a throw.
    const result = proofreadCheckSchema.safeParse({
      accountId: 1,
      text: 'x'.repeat(IPC_TEXT_TRANSPORT_CAP + 1),
    })
    expect(result.success).toBe(false)
  })

  it('keeps the transport ceiling far above the 8000-char product cap, so the structured too_long refusal stays reachable', () => {
    // Pins the RELATIONSHIP, not the ceiling itself: lowering it towards the
    // generator's QUICK_ACTION_INPUT_CHAR_CAP would start converting legitimate
    // long drafts from a `too_long` refusal into a thrown zod error. The 8000
    // is spelled out rather than imported on purpose — importing it would drag
    // `services/ai.ts` (and the whole Electron module graph) into this file,
    // which is exactly what the ipcSchemas.ts extraction exists to avoid.
    expect(IPC_TEXT_TRANSPORT_CAP).toBeGreaterThan(8000 * 100)
  })

  it('rejects a non-positive accountId', () => {
    for (const accountId of [0, -1, -42]) {
      const result = proofreadCheckSchema.safeParse({ accountId, text: 'draft' })
      expect(result.success).toBe(false)
    }
  })

  it('rejects a non-integer accountId', () => {
    const result = proofreadCheckSchema.safeParse({ accountId: 1.5, text: 'draft' })
    expect(result.success).toBe(false)
  })

  it('rejects a missing accountId', () => {
    const result = proofreadCheckSchema.safeParse({ text: 'draft' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-string text field', () => {
    const result = proofreadCheckSchema.safeParse({ accountId: 1, text: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects a missing text field', () => {
    const result = proofreadCheckSchema.safeParse({ accountId: 1 })
    expect(result.success).toBe(false)
  })

  it('strips unknown extra fields from the payload (cache-poisoning defence consistent with B4)', () => {
    const parsed = proofreadCheckSchema.parse({ accountId: 1, text: 'draft', injected: 'evil' })
    expect(Object.keys(parsed).sort()).toEqual(['accountId', 'text'])
  })
})

describe('proofreadCheckSchema — handler forward-verbatim shape', () => {
  it('forwards the parsed request to the generator and returns its result unchanged', async () => {
    const fakeResult: ProofreadResult = { ok: true, edits: [], dropped: 0, provider: 'anthropic-api' }
    const generate = async (req: { accountId: number; text: string }): Promise<ProofreadResult> => {
      expect(req).toEqual({ accountId: 7, text: 'Some draft.' })
      return fakeResult
    }
    const result = await mirrorProofreadHandler({ accountId: 7, text: 'Some draft.' }, generate)
    expect(result).toBe(fakeResult)
  })

  it('throws (propagates schema error) when the payload is malformed — main handleIpc logs this for the renderer', async () => {
    const generate = async (): Promise<ProofreadResult> => ({ ok: true, edits: [], dropped: 0, provider: 'p' })
    await expect(mirrorProofreadHandler({ accountId: 'not-a-number', text: 'hi' }, generate))
      .rejects.toThrow()
  })
})
