import { z } from 'zod'
// Imported BY PATH rather than through the `packages/core` barrel, matching
// `services/aiTranslate.ts`: `language.ts` is the module the franc-facing code
// sits next to, and the barrel is bundled into the renderer. The import itself
// is pure data — the sixteen-entry code table — and pulls in no Electron, AI or
// database module, so this file keeps the property its header claims.
import { TRANSLATE_LANGUAGE_CODES } from '../packages/core/language'
import type { TranslateLanguageCode } from '@mailcopilot/types'

/**
 * Shared zod schemas for the compose-side AI IPC handlers: §3.3 B4 Quick
 * Actions + Instant Reply (`ai:quickAction:rewrite` /
 * `ai:instantReply:generate`), §3.3 B7 Proofread (`ai:proofread:check`) and
 * §3.3 B6 draft translation (`ai:translate:draft`).
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
 * Transport-level ceiling for renderer-supplied free-text fields (chars).
 *
 * Applies to EVERY free-text field this module accepts from the renderer —
 * today `quickActionRewriteSchema.text` (§3.3 B4), `proofreadCheckSchema.text`
 * (§3.3 B7) and `translateDraftSchema.text` (§3.3 B6 draft side). A new renderer
 * free-text field added to this module gets it too:
 * the bound is a property of the channel CLASS (renderer free text crossing into
 * main), not of any one feature, so leaving a sibling field unbounded is drift
 * rather than a deliberate exemption.
 *
 * NOT a product limit. Each feature owns its own product cap inside its
 * generator, and each answers with a structured `too_long` refusal instead of a
 * throw: `QUICK_ACTION_INPUT_CHAR_CAP` (`services/ai.ts`) for B4 and
 * `PROOFREAD_INPUT_CHAR_CAP` (`services/composeAi.ts`) for B7. Those two are
 * INDEPENDENT constants that happen to share a value today — neither is derived
 * from the other, and either may move without the other.
 *
 * What this ceiling actually buys, stated precisely: it does NOT prevent the
 * allocation of the incoming payload. Electron's structured clone has already
 * materialized the string in main's heap by the time a handler — and therefore
 * this schema — runs, so that copy exists before zod can reject it. What the cap
 * bounds is the work and the retained copy DOWNSTREAM of receipt: the
 * `splitComposeBody()` line array (O(n) over the draft), the wrapped prompt, and
 * the outbound request body — none of which are built for a rejected payload,
 * and none of which are bounded by anything else. This is the earliest bound
 * available at this layer; it is effective one layer later, not a no-op.
 *
 * Deliberately generous (~125x the product caps) so it fires only on payloads no
 * human draft can produce, leaving the "structured refusals, never throws"
 * discipline intact for every legitimate input.
 *
 * Declared here rather than imported from `services/ai.ts` on purpose: this
 * module stays free of the Electron/AI module graph (see the file header).
 */
export const IPC_TEXT_TRANSPORT_CAP = 1_000_000

/**
 * §3.3 B4 quick-action rewrite payload. `text` is the raw draft body — main
 * does NOT build the rewrite instruction (the generator maps `preset` to a
 * system prompt and wraps the untrusted draft with wrapUntrusted()).
 *
 * `text` carries the same `IPC_TEXT_TRANSPORT_CAP` as the B7 sibling below, for
 * the same reason and with the same non-consequence for the product contract:
 * the ceiling sits ~125x above `QUICK_ACTION_INPUT_CHAR_CAP` (8000), so every
 * draft a human can write still parses cleanly and reaches the generator to be
 * answered with a structured `too_long` refusal rather than a thrown zod error.
 * See the constant's docblock for what the bound does and does not buy.
 */
export const quickActionRewriteSchema = z.object({
  accountId: accountIdSchema,
  preset: z.enum(['improve', 'shorter', 'formal', 'grammar']),
  text: z.string().max(IPC_TEXT_TRANSPORT_CAP),
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

/**
 * §3.3 B7 proofread payload. `text` is the user's OWN part of the draft, as
 * identified by `splitComposeBody()` (§2.78) — the quoted original, forwarded
 * message and signature it RECOGNIZES stay in the renderer; that split is a
 * best-effort read of flat text (§2.173), and main re-runs it on whatever
 * actually arrives rather than trusting this claim.
 *
 * Two levels bound this field, and they answer different questions:
 *
 *  1. The PRODUCT cap (`PROOFREAD_INPUT_CHAR_CAP`, 8000 chars, declared in
 *     `services/composeAi.ts`) lives in the generator and is a REFUSAL it owns
 *     (`too_long`, with an aggregate counter), not a validation error. A
 *     `.max(8000)` here would turn "your draft is too long to check in one pass"
 *     into a thrown zod error at the IPC boundary — exactly the "structured
 *     refusals, never throws" discipline B4/B7 exist to hold. So a legitimate
 *     long draft (8000..cap below) must still parse cleanly and reach the
 *     generator to be refused structurally. Note this is B7's OWN cap, not B4's
 *     `QUICK_ACTION_INPUT_CHAR_CAP`: the two are independent constants that
 *     currently share a value, and neither follows the other.
 *
 *  2. The TRANSPORT cap below is a resource bound, not a product decision, and
 *     it binds one layer later than "reject the incoming payload". The renderer
 *     is a SEPARATE process: `window.api.invoke` serializes this string and
 *     Electron's structured clone has already materialized a copy in main's heap
 *     by the time this handler — and so this schema — runs. The clone is
 *     therefore NOT what the cap prevents. What it bounds is the work and the
 *     retained copy downstream of receipt: the `splitComposeBody()` re-run over
 *     the arriving text, the wrapped prompt, and the outbound request body, all
 *     of which are skipped for a rejected payload. `IPC_TEXT_TRANSPORT_CAP` sits
 *     two orders of magnitude above the product cap so it can only ever fire on
 *     absurd payloads — no human draft reaches it, so no legitimate input is
 *     converted from a structured refusal into a throw.
 */
export const proofreadCheckSchema = z.object({
  accountId: accountIdSchema,
  text: z.string().max(IPC_TEXT_TRANSPORT_CAP),
})

/**
 * §3.3 B6 draft-side payload for `ai:translate:draft`.
 *
 * Three fields, and the shape is the security statement:
 *
 *  1. `text` — the user's OWN part of the draft as the renderer split it
 *     (§2.78). Main does not trust that: `services/composeTranslate.ts` re-runs
 *     `splitComposeBody()` on whatever arrives and prompts only the part its own
 *     split calls the user's text, exactly as the B7 sibling does. Bounded by
 *     `IPC_TEXT_TRANSPORT_CAP` for the transport reason spelled out on that
 *     constant, NOT by the product cap: the product cap is
 *     `TRANSLATE_INPUT_CHAR_CAP` (3000, `services/aiTranslate.ts`) and it is
 *     answered with a structured `too_long` REFUSAL inside the generator, never
 *     with a thrown zod error at the boundary. The two caps sit ~330x apart, so
 *     no draft a human writes is ever converted from a refusal into a throw.
 *
 *  2. `targetLang` — a member of the closed sixteen-value enum, reaching the
 *     system prompt only through the fixed code → English-name table in
 *     `packages/core/language.ts`. The instruction is the one part of the prompt
 *     that is deliberately OUTSIDE the untrusted markers, so the renderer must
 *     not be able to put characters into it; an enum is what makes that
 *     structural rather than a matter of escaping.
 *
 *  3. `accountId` — whose opt-in, whose budget, whose audit row.
 *
 * What is deliberately ABSENT is the point: there is no instruction field, no
 * tone field, no "extra context" field. zod strips unknown keys, so a renderer
 * that invents one gets it dropped here and it never reaches the generator.
 * There is also no source-language field — the instruction names only the
 * TARGET (`buildTranslateSystemPrompt`), so a source language would be an input
 * the translation does not have.
 */
export const translateDraftSchema = z.object({
  accountId: accountIdSchema,
  text: z.string().max(IPC_TEXT_TRANSPORT_CAP),
  targetLang: z.enum(
    TRANSLATE_LANGUAGE_CODES as [TranslateLanguageCode, ...TranslateLanguageCode[]],
  ),
})
