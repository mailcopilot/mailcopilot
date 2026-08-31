import { describe, expect, it, vi } from 'vitest'
import { IPC_TEXT_TRANSPORT_CAP, quickActionRewriteSchema, instantReplyGenerateSchema } from './ipcSchemas'

/**
 * §3.3 B4 Compose Quick Actions + Instant Reply — `ai:quickAction:rewrite` /
 * `ai:instantReply:generate` IPC handler tests (mirror pattern, same
 * technique as `main.threadSummary.test.ts` and `main.pendingMoves.test.ts`).
 *
 * `electron/main.ts` cannot be imported directly in unit tests (module-level
 * side effects: BrowserWindow creation, IPC registration, DB open, IDLE
 * cycle, etc.), so this file mirrors the handler's forward-verbatim behavior
 * with an injectable-generator shim. Unlike the schemas (which used to be a
 * hand-maintained mirror — see below), the schemas here are imported from the
 * REAL production module (`electron/ipcSchemas.ts`), the same module
 * `electron/main.ts` itself imports. A regression in the production schema
 * (e.g. dropping the `messageId` strip that backs the cache-poisoning
 * defense, or widening the preset enum) now fails THIS test instead of
 * silently passing against a stale hand-maintained copy.
 *
 * Coverage this file adds:
 *   - quickActionRewriteSchema (REAL, from ipcSchemas.ts): preset enum bounded
 *     to the four known values; other fields required/typed as declared.
 *   - instantReplyGenerateSchema (REAL, from ipcSchemas.ts): a renderer-supplied
 *     `messageId` is an UNKNOWN key to this schema and is silently stripped by
 *     zod (never reaches the generator) — pinning the cache-poisoning defense
 *     described in the production JSDoc; `uid` must be a positive integer;
 *     `folder` is required and bounded.
 *   - Handler forward semantics: the parsed request is passed to the
 *     generator, and the generator's result is returned to the caller
 *     VERBATIM (main never re-maps/re-wraps the discriminated union).
 */

// ---------------------------------------------------------------------------
// Mirror: handler logic with an injectable generator (forward-verbatim shape).
// This part still mirrors electron/main.ts's handler BODY (thin
// parse-then-forward), but `.parse()` below runs the REAL imported schema —
// not a local copy — so schema drift is caught here.
// ---------------------------------------------------------------------------

// §2.78 — the result unions are IMPORTED from the production service, not
// re-declared here. They used to be a hand-maintained copy, which is exactly
// the drift that let a new refusal reason (`too_long`) exist in the generator
// while the mirror still described the old four-reason union. `import type` is
// erased at build time, so this pulls in no module side effects.
import type { QuickActionRewriteResult, InstantReplyDraftsResult } from './services/ai'

/** Mirrors the `ai:quickAction:rewrite` handler body verbatim, using the REAL schema. */
async function mirrorQuickActionHandler(
  payload: unknown,
  generateQuickActionRewrite: (req: { accountId: number; preset: string; text: string }) => Promise<QuickActionRewriteResult>,
): Promise<QuickActionRewriteResult> {
  const req = quickActionRewriteSchema.parse(payload)
  return generateQuickActionRewrite(req)
}

/** Mirrors the `ai:instantReply:generate` handler body verbatim, using the REAL schema. */
async function mirrorInstantReplyHandler(
  payload: unknown,
  generateInstantReplyDrafts: (req: { accountId: number; folder: string; uid: number }) => Promise<InstantReplyDraftsResult>,
): Promise<InstantReplyDraftsResult> {
  const req = instantReplyGenerateSchema.parse(payload)
  return generateInstantReplyDrafts(req)
}

describe('quickActionRewriteSchema — §3.3 B4 (real production schema)', () => {
  it('accepts a well-formed payload with a valid preset', () => {
    for (const preset of ['improve', 'shorter', 'formal', 'grammar']) {
      const result = quickActionRewriteSchema.safeParse({ accountId: 1, preset, text: 'draft body' })
      expect(result.success).toBe(true)
    }
  })

  it('rejects a preset outside the four-value enum', () => {
    const result = quickActionRewriteSchema.safeParse({ accountId: 1, preset: 'rewrite-completely', text: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects a missing preset', () => {
    const result = quickActionRewriteSchema.safeParse({ accountId: 1, text: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-positive / non-integer accountId', () => {
    for (const accountId of [0, -1, 1.5]) {
      const result = quickActionRewriteSchema.safeParse({ accountId, preset: 'improve', text: 'x' })
      expect(result.success).toBe(false)
    }
  })

  it('accepts an empty-string text (empty_input refusal is the generator’s job, not the schema’s)', () => {
    const result = quickActionRewriteSchema.safeParse({ accountId: 1, preset: 'improve', text: '' })
    expect(result.success).toBe(true)
  })

  it('rejects a non-string text field', () => {
    const result = quickActionRewriteSchema.safeParse({ accountId: 1, preset: 'improve', text: 12345 })
    expect(result.success).toBe(false)
  })

  it('accepts an over-cap text so the generator can answer too_long (§2.78) — the schema must not reject it as malformed', () => {
    // The length verdict belongs to the generator, which returns a structured
    // `too_long` refusal the renderer can explain. A zod max() here would turn
    // the same situation into a thrown IPC error with no actionable reason.
    const result = quickActionRewriteSchema.safeParse({ accountId: 1, preset: 'improve', text: 'x'.repeat(200_000) })
    expect(result.success).toBe(true)
  })

  it('accepts a text exactly at the transport ceiling — the ceiling bounds the payload, it does not shrink the refusable range', () => {
    const result = quickActionRewriteSchema.safeParse({
      accountId: 1,
      preset: 'improve',
      text: 'x'.repeat(IPC_TEXT_TRANSPORT_CAP),
    })
    expect(result.success).toBe(true)
  })

  it('rejects a text past the transport ceiling — same channel class as the B7 sibling, so the same bound applies', () => {
    // Pins the drift fix: `text` here sat unbounded while the B7
    // `proofreadCheckSchema.text` carried the ceiling, even though both are
    // renderer free text crossing into main under the same threat model. The
    // bound belongs to the channel class, not to one feature.
    const result = quickActionRewriteSchema.safeParse({
      accountId: 1,
      preset: 'improve',
      text: 'x'.repeat(IPC_TEXT_TRANSPORT_CAP + 1),
    })
    expect(result.success).toBe(false)
  })

  it('keeps the transport ceiling far above the 8000-char product cap, so the structured too_long refusal stays reachable', () => {
    // Pins the RELATIONSHIP, not the ceiling itself: lowering it towards the
    // generator's QUICK_ACTION_INPUT_CHAR_CAP would start converting legitimate
    // long drafts from a `too_long` refusal into a thrown zod error. The 8000 is
    // spelled out rather than imported on purpose — importing it would drag
    // `services/ai.ts` (and the whole Electron module graph) into this file,
    // which is exactly what the ipcSchemas.ts extraction exists to avoid.
    expect(IPC_TEXT_TRANSPORT_CAP).toBeGreaterThan(8000 * 100)
  })
})

describe('instantReplyGenerateSchema — §3.3 B4 (real production schema)', () => {
  it('accepts a well-formed (accountId, folder, uid) payload', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: 'INBOX', uid: 42 })
    expect(result.success).toBe(true)
  })

  it('strips an unknown messageId field to EXACTLY the (accountId, folder, uid) keys — a renderer-supplied messageId never reaches the parsed request', () => {
    const parsed = instantReplyGenerateSchema.parse({
      accountId: 1,
      folder: 'INBOX',
      uid: 42,
      messageId: '<forged@evil>',
    })
    expect(parsed).toEqual({ accountId: 1, folder: 'INBOX', uid: 42 })
    // Pin the exact key set — a regression that stops stripping `messageId`
    // (or that silently adds a new field) fails here even if the individual
    // field values still happen to match.
    expect(Object.keys(parsed).sort()).toEqual(['accountId', 'folder', 'uid'])
  })

  it('rejects a non-positive uid', () => {
    for (const uid of [0, -1, -42]) {
      const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: 'INBOX', uid })
      expect(result.success).toBe(false)
    }
  })

  it('rejects a non-integer uid', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: 'INBOX', uid: 4.2 })
    expect(result.success).toBe(false)
  })

  it('rejects a missing folder', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, uid: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects an empty-string folder', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: '', uid: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects a folder longer than 1024 characters', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: 'x'.repeat(1025), uid: 42 })
    expect(result.success).toBe(false)
  })

  it('accepts a folder exactly at the 1024-character bound', () => {
    const result = instantReplyGenerateSchema.safeParse({ accountId: 1, folder: 'x'.repeat(1024), uid: 42 })
    expect(result.success).toBe(true)
  })

  it('rejects a non-positive / non-integer accountId', () => {
    for (const accountId of [0, -1, 2.5]) {
      const result = instantReplyGenerateSchema.safeParse({ accountId, folder: 'INBOX', uid: 42 })
      expect(result.success).toBe(false)
    }
  })
})

describe('ai:quickAction:rewrite handler — forward-verbatim contract (real schema)', () => {
  it('forwards the parsed request to the generator and returns its result verbatim on success', async () => {
    const generate = vi.fn(async (): Promise<QuickActionRewriteResult> => ({ ok: true, rewritten: 'Better.', provider: 'anthropic-api' }))
    const result = await mirrorQuickActionHandler({ accountId: 1, preset: 'improve', text: 'raw' }, generate)
    expect(generate).toHaveBeenCalledWith({ accountId: 1, preset: 'improve', text: 'raw' })
    expect(result).toEqual({ ok: true, rewritten: 'Better.', provider: 'anthropic-api' })
  })

  it('forwards a structured refusal from the generator verbatim (no re-mapping of the reason code)', async () => {
    const generate = vi.fn(async (): Promise<QuickActionRewriteResult> => ({ ok: false, reason: 'budget' }))
    const result = await mirrorQuickActionHandler({ accountId: 1, preset: 'grammar', text: 'raw' }, generate)
    expect(result).toEqual({ ok: false, reason: 'budget' })
  })

  it('forwards the §2.78 too_long refusal verbatim, with the full draft still handed to the generator', async () => {
    const generate = vi.fn(async (): Promise<QuickActionRewriteResult> => ({ ok: false, reason: 'too_long' }))
    const longDraft = 'x'.repeat(200_000)
    const result = await mirrorQuickActionHandler({ accountId: 1, preset: 'improve', text: longDraft }, generate)
    // main forwards the draft untouched — it is the generator, not the IPC
    // layer, that decides on the length (and it refuses rather than truncates).
    expect(generate).toHaveBeenCalledWith({ accountId: 1, preset: 'improve', text: longDraft })
    expect(result).toEqual({ ok: false, reason: 'too_long' })
  })

  it('throws (never reaches the generator) on a malformed payload', async () => {
    const generate = vi.fn()
    await expect(mirrorQuickActionHandler({ accountId: 1, preset: 'not-a-real-preset', text: 'raw' }, generate)).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('ai:instantReply:generate handler — forward-verbatim contract (real schema)', () => {
  it('forwards ONLY (accountId, folder, uid) to the generator — a renderer messageId never arrives', async () => {
    const generate = vi.fn(async (): Promise<InstantReplyDraftsResult> => ({ ok: true, drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.' }] }))
    const result = await mirrorInstantReplyHandler(
      { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<forged@evil>' },
      generate,
    )
    expect(generate).toHaveBeenCalledWith({ accountId: 1, folder: 'INBOX', uid: 42 })
    expect(result).toEqual({ ok: true, drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.' }] })
  })

  it('forwards a structured refusal from the generator verbatim', async () => {
    const generate = vi.fn(async (): Promise<InstantReplyDraftsResult> => ({ ok: false, reason: 'no_provider' }))
    const result = await mirrorInstantReplyHandler({ accountId: 1, folder: 'INBOX', uid: 42 }, generate)
    expect(result).toEqual({ ok: false, reason: 'no_provider' })
  })

  it('throws (never reaches the generator) when uid is non-positive', async () => {
    const generate = vi.fn()
    await expect(mirrorInstantReplyHandler({ accountId: 1, folder: 'INBOX', uid: -1 }, generate)).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })

  it('throws (never reaches the generator) when folder is missing', async () => {
    const generate = vi.fn()
    await expect(mirrorInstantReplyHandler({ accountId: 1, uid: 42 }, generate)).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
})
