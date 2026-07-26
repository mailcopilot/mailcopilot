import { z } from 'zod'

/**
 * Shared zod schemas for §3.3 B4 Compose Quick Actions + Instant Reply IPC
 * handlers (`ai:quickAction:rewrite` / `ai:instantReply:generate`).
 *
 * These live in their own module — mirroring the `queueComposeBridge.ts`
 * precedent — so the schemas that `electron/main.ts` actually registers are
 * importable in unit tests WITHOUT pulling in the Electron module graph
 * (BrowserWindow creation, IPC registration, DB open, IDLE cycle). Tests
 * import the REAL schemas from here rather than a hand-maintained mirror, so a
 * regression in the production schema (e.g. dropping the `messageId` strip
 * that backs the cache-poisoning defense) fails the test instead of passing on
 * a stale copy.
 *
 * Runtime contract is unchanged from the former inline definitions in
 * `main.ts` — this is a pure extraction, not a behavior change.
 */

/** Account identifier: a positive integer row id. Local to this module so the
 *  extracted schemas carry their own dependency and do not couple back to
 *  `main.ts`. Semantically identical to the module-level `accountIdSchema` in
 *  `main.ts`. */
const accountIdSchema = z.number().int().positive()

/**
 * §3.3 B4 quick-action rewrite payload. `text` is the raw draft body — main
 * does NOT build the rewrite instruction (the generator maps `preset` to a
 * system prompt and wraps the untrusted draft with wrapUntrusted()).
 */
export const quickActionRewriteSchema = z.object({
  accountId: accountIdSchema,
  preset: z.enum(['improve', 'shorter', 'formal', 'grammar']),
  text: z.string(),
})

/**
 * §3.3 B4 instant-reply payload. The renderer supplies ONLY a message REF —
 * never body text. A renderer-supplied `messageId` is intentionally NOT in this
 * schema: zod strips unknown keys, so even if the renderer still sends one it is
 * dropped here and never reaches the generator. Message identity is entirely
 * cache-derived from (accountId, folder, uid) — cross-thread cache-poisoning
 * defense, matching the B2 thread-summary discipline (CLAUDE.md §5). The
 * generator fetches the canonical body from the local SQLite cache and wraps it
 * with wrapUntrusted() before prompting.
 */
export const instantReplyGenerateSchema = z.object({
  accountId: accountIdSchema,
  folder: z.string().min(1).max(1024),
  uid: z.number().int().positive(),
})
