export type {
  ImapConfig,
  SmtpConfig,
  AccountConfig,
  AutoconfigResult,
  AccountMeta,
  Identity,
  OAuthConnectStage,
  OAuthProgress,
} from './account'

export type {
  Mailbox,
  FolderHeaderSyncMode,
  FolderOfflineMode,
  FolderPreference,
  FolderRoles,
  TlsPin,
} from './folder'

export type {
  MailSummary,
  MailAddress,
  MessageEnvelope,
  AttachmentMeta,
  MessageDetails,
  // §2.145 — two-tier parse caps.
  MessageParseCap,
  UnsubscribeAttemptResult,
  ComposeAttachment,
  ComposeInit,
  // §2.22 Wave A — ICS / iTIP invite bridge.
  CalendarInvite,
  CalendarInvitePublic,
  RsvpMethod,
} from './mail'

// ─── §3.3 B2 — Thread AI Summary IPC contract ──────────────────────────────
//
// Shared main↔renderer payload types for the `ai:threadSummary:*` IPC channels.
// The main-side generator lives in `electron/services/aiThreadSummary.ts`; the
// renderer AI panel (agent 3) imports THESE types so both sides agree on the
// exact request/response shapes. No email content ever appears in a response
// payload beyond the model-generated summary the user explicitly asked for.

/**
 * A message reference the renderer hands to the generate handler. Main fetches
 * the canonical body AND the identity token from the local SQLite cache by
 * `(accountId, folder, uid)` — the renderer never supplies body text, and the
 * thread-identity hash is ALWAYS computed by main from trusted, cache-sourced
 * data.
 *
 * `messageId` is IGNORED by main (it is not in the IPC validation schema — zod
 * strips it). It is retained here only so existing renderer call sites that
 * still populate it type-check; a renderer-supplied Message-ID can NOT influence
 * the identity/hash (cross-thread cache-poisoning defense, CLAUDE.md §5). Main's
 * identity token is the DB row's Message-ID or a synthetic `account:folder:uid`
 * fallback — never this field.
 */
export type ThreadSummaryMessageRef = {
  folder: string
  uid: number
  /** Ignored by main (see type doc). Retained for renderer call-site compat. */
  messageId?: string | null
}

/**
 * The generated summary payload. `oneLine` is the collapsed one-liner shown
 * above the message stack; `bullets` is always the 5-bullet expanded form.
 * `cached` is true when the result was served from the `ai_summaries` cache
 * without a fresh provider call. `provider` is the AI provider that produced
 * the (possibly cached) summary. `wasLocal` reflects whether a local provider
 * generated it (always false today — T2.5 Ollama not shipped — reserved for
 * the local-preferred path).
 */
export type ThreadSummary = {
  threadHash: string
  oneLine: string
  bullets: string[]
  provider: string
  cached: boolean
  wasLocal: boolean
  /** Creation time of the underlying cache row, epoch ms. */
  createdAt: number
}

/**
 * Request payload for the `ai:threadSummary:generate` IPC channel.
 *
 * There is deliberately NO caller-supplied `threadHash`: main ALWAYS recomputes
 * the identity hash from the DB-sourced identity tokens, so a compromised
 * renderer cannot read or poison another thread's cache row by forging a hash
 * (CLAUDE.md §5).
 */
export type ThreadSummaryGenerateRequest = {
  accountId: number
  messages: ThreadSummaryMessageRef[]
}

/**
 * Structured refusal reasons surfaced to the renderer instead of throwing.
 * Mirrors the discriminated-refusal discipline of the AI service so the panel
 * can render a graceful message rather than a raw error toast.
 *   - `budget`       — daily/monthly AI budget cap exceeded.
 *   - `opt_out`      — the account's Thread Summary setting is OFF.
 *   - `too_short`    — fewer than the minimum messages for a summary.
 *   - `no_provider`  — no AI provider configured.
 *   - `provider_error` — the provider call failed / returned unusable output.
 */
export type ThreadSummaryRefusalReason =
  | 'budget'
  | 'opt_out'
  | 'too_short'
  | 'no_provider'
  | 'provider_error'

/**
 * Discriminated result of a `ai:threadSummary:generate` call. The renderer
 * branches on `ok`: `true` carries the summary, `false` carries a structured
 * `reason` (never an exception) so budget/opt-out/etc. degrade gracefully.
 */
export type ThreadSummaryResult =
  | { ok: true; summary: ThreadSummary }
  | { ok: false; reason: ThreadSummaryRefusalReason }

// ─── §3.3 B4 / B7 — Compose AI contract (quick actions, instant reply, ──────
//     proofread)
//
// §3.3.B4.f3(c): these types used to exist as TWO hand-synchronized copies —
// one in `electron/services/ai.ts`, one in `src/utils/quickActions.ts` — with a
// comment on each asking the other side not to drift. A contract kept in two
// places is a contract that drifts; both copies now re-export from here, so
// adding a refusal reason on one side is a compile error on the other until it
// is handled.
//
// Invariants these shapes encode (CLAUDE.md §5 AI/MCP):
//   - The renderer NEVER builds a model instruction. It sends a low-cardinality
//     action identifier plus the user's OWN draft text; main maps that to a
//     system prompt and wraps the text with `wrapUntrusted()` before it reaches
//     any provider.
//   - Refusals are STRUCTURAL. Every failure the user can hit is a value in a
//     discriminated union, never a rejected IPC promise.
//   - Nothing is written back into the draft by the backend. Every result is a
//     proposal the user reviews and applies explicitly.

/**
 * The four compose quick-action presets (§3.3 B4).
 *   - `improve`  — polish clarity/tone while preserving meaning.
 *   - `shorter`  — condense to the essential message.
 *   - `formal`   — raise register to a formal/professional tone.
 *   - `grammar`  — fix grammar/spelling only, minimal wording change.
 *
 * B7 (proofread) is deliberately NOT a fifth preset: a preset returns ONE
 * rewritten string, and B7 returns a LIST of individually acceptable edits. The
 * two carry different result shapes, so they are different channels.
 */
export type QuickActionPreset = 'improve' | 'shorter' | 'formal' | 'grammar'

/**
 * Request payload for the `ai:quickAction:rewrite` IPC channel.
 *
 * `text` is what `splitComposeBody()` (§2.78) classified as the user's OWN part
 * of the draft, verbatim. A RECOGNIZED quoted original, forwarded message or
 * signature is cut off before this payload is built and stays in the renderer.
 * The splitter is best-effort over flat text (§2.173): a quoting style it does
 * not recognize is classified as own text and IS sent. Treat this as "the
 * recognized tail never leaves the renderer", not as "no quoted text ever does".
 */
export type QuickActionRequest = {
  accountId: number
  preset: QuickActionPreset
  text: string
}

/**
 * Structured refusal reasons for a quick action, surfaced inline (never thrown).
 *   - `budget`         — daily/monthly AI budget cap exceeded.
 *   - `no_provider`    — no AI provider configured.
 *   - `provider_error` — provider call failed / returned unusable output.
 *   - `empty_input`    — draft body was empty/whitespace (nothing to rewrite).
 *   - `too_long`       — draft exceeds the backend input cap (§2.78). Main
 *                        refuses honestly instead of truncating, because a
 *                        truncated rewrite pasted back over the draft would
 *                        destroy the tail of the user's text.
 */
export type QuickActionRefusalReason =
  | 'budget'
  | 'no_provider'
  | 'provider_error'
  | 'empty_input'
  | 'too_long'

/**
 * Discriminated result of a `ai:quickAction:rewrite` call. `ok: true` carries
 * the whole rewritten text (shown in the review panel); `ok: false` carries a
 * structured reason.
 */
export type QuickActionResult =
  | { ok: true; rewritten: string; provider: string }
  | { ok: false; reason: QuickActionRefusalReason }

/**
 * Request payload for the `ai:instantReply:generate` IPC channel. The renderer
 * supplies only a message REF — NEVER body text; main resolves the canonical
 * body from the local SQLite cache by `(accountId, folder, uid)`.
 */
export type InstantReplyRequest = {
  accountId: number
  folder: string
  uid: number
  /** Ignored by main (compat only); identity is cache-derived. */
  messageId?: string | null
}

/** Instant Reply refusal reasons — a subset of the quick-action set. */
export type InstantReplyRefusalReason =
  | 'budget'
  | 'no_provider'
  | 'provider_error'

/**
 * A single generated draft option. `text` prefills a new Compose body verbatim
 * on selection; nothing is ever sent automatically (no-auto-send invariant).
 * `tone` is an optional short model-authored hint the UI may show as a chip
 * label; the renderer treats it as opaque display text.
 */
export type InstantReplyDraft = {
  text: string
  tone?: string
}

/** Discriminated result of a `ai:instantReply:generate` call. */
export type InstantReplyResult =
  | { ok: true; drafts: InstantReplyDraft[] }
  | { ok: false; reason: InstantReplyRefusalReason }

// --- §3.3 B7 AI Proofread ---------------------------------------------------

/**
 * What kind of mistake one proofread edit fixes. A CLOSED, low-cardinality set
 * so the renderer can group/label edits from six interface languages without
 * showing model-authored English category names. A proposal whose category is
 * not in this set is normalized to `wording` rather than dropped — the fix may
 * still be good, only its label is unusable.
 */
export type ProofreadEditCategory =
  | 'spelling'
  | 'grammar'
  | 'punctuation'
  | 'wording'
  | 'clarity'

/**
 * ONE individually acceptable proofread edit (§3.3 B7).
 *
 * ## Addressing: a span in the draft, not a position in a list
 *
 * An edit is addressed as `(offset, length)` into the EXACT string the renderer
 * sent in {@link ProofreadRequest.text}, plus the `replacement` that goes there
 * — the shape LanguageTool's HTTP API uses for `matches[].offset` /
 * `matches[].length` / `matches[].replacements[]`
 * (https://languagetool.org/http-api/languagetool-swagger.json).
 *
 * This is what makes per-edit acceptance correct across a regeneration, and it
 * is why B7 does NOT reuse the positional `b{N}` block ids of
 * `packages/core/composeDiff.ts` (§2.251): a block id is an index into one
 * particular preview, so re-running the check renumbers it and an acceptance
 * recorded against `b3` silently lands on a different edit. A span is anchored
 * in the draft itself, and the draft does not change while the panel is open —
 * so the same span means the same place, in this preview and the next.
 *
 * `id` is an INJECTIVE encoding of the edit's CONTENT (`offset`, `length`,
 * `original`, `replacement`), never its index — distinct edits get distinct ids
 * by construction, not by a hash that a hostile provider could collide. So
 * re-running the check over an unchanged draft yields the same id for the same
 * proposed fix and an acceptance survives regeneration; a fix the model changed
 * its mind about gets a different id and the stale acceptance simply finds
 * nothing to apply — it can never land on a different edit. The id therefore
 * embeds draft text: display and state plumbing only, never logged, never in
 * telemetry.
 *
 * ## Guarantees main has already enforced before you see this
 *
 *   - `text.slice(offset, offset + length) === original`, byte for byte. Main
 *     RESOLVES every model proposal against the draft and DROPS any it cannot
 *     locate (§3.3 B7 AC-e) — the renderer never has to handle a span that does
 *     not match.
 *   - Every span lies inside the region MAIN's own `splitComposeBody()` read
 *     classifies as the user's own text: main re-runs the split on the received
 *     string and offsets the results past `lead`, so a renderer that sent its
 *     quote, forward banner or signature cannot get an edit addressed into the
 *     part main recognized as one (§2.78). Honest limit (§2.173): that split is
 *     a best-effort read of flat text, so a quoting style it does not recognize
 *     is classified as own text and an edit CAN land inside it.
 *   - Spans are sorted ascending by `offset` and never overlap, so any SUBSET
 *     can be applied in one left-to-right pass.
 *
 * `message` is a short model-authored explanation in the DRAFT's language (not
 * the interface language — the draft may be in any language). Treat it as
 * opaque display text: it is third-party free text and must never be logged,
 * put in telemetry, or interpreted.
 */
export type ProofreadEdit = {
  /** Content-derived stable identity (see the docblock). Never an index. */
  id: string
  /** Start of the replaced span, in UTF-16 code units into the request text. */
  offset: number
  /** Length of the replaced span. Always > 0 — B7 v1 proposes no pure insertions. */
  length: number
  /** The exact draft substring being replaced. Verified against the draft by main. */
  original: string
  /** The corrected text that replaces `original`. */
  replacement: string
  category: ProofreadEditCategory
  /** Short explanation in the DRAFT's language. Opaque display text. */
  message: string
}

/**
 * Request payload for the `ai:proofread:check` IPC channel.
 *
 * `text` is the user's OWN part of the draft, as identified by
 * `splitComposeBody()` (§2.78) — the quoted original, forwarded message and
 * signature it RECOGNIZES stay in the renderer; recognition is a best-effort
 * read of flat text (§2.173), not a guarantee. Returned offsets are into THIS
 * string exactly as sent, so the renderer applies accepted edits to it and
 * re-joins the untouched tail with `joinComposeBody()` byte for byte.
 *
 * Main does NOT trust that split: it re-runs `splitComposeBody()` on whatever
 * arrives and confines both the prompt and every returned span to ITS OWN read
 * of the own-text part (defense in depth for a compromised renderer — a second
 * best-effort split, not a stronger kind of check).
 */
export type ProofreadRequest = {
  accountId: number
  text: string
}

/**
 * Structured refusal reasons for a proofread check. Same discipline as the
 * quick-action set — the send path NEVER depends on any of them (§3.3 B7: the
 * corrector is informational and can never block sending).
 *   - `not_enabled`    — the account's per-account Proofread opt-in is OFF
 *                        (default). Distinct from `no_provider` on purpose: the
 *                        actionable fix is a toggle, not a provider key
 *                        (§3.3.B4.f3(a) is the same mistake, not repeated here).
 *   - `no_own_text`    — the draft is nothing but a quote/forward/signature, so
 *                        there is no text of the user's own to check (§2.78).
 *   - `empty_input`    — the draft was empty/whitespace.
 *   - `too_long`       — the draft exceeds the backend input cap. An honest
 *                        refusal, never a truncated partial check.
 *   - `budget`         — daily/monthly AI budget cap exceeded.
 *   - `no_provider`    — no AI provider configured.
 *   - `provider_error` — provider call failed / returned unusable output.
 */
export type ProofreadRefusalReason =
  | 'not_enabled'
  | 'no_own_text'
  | 'empty_input'
  | 'too_long'
  | 'budget'
  | 'no_provider'
  | 'provider_error'

/**
 * Discriminated result of a `ai:proofread:check` call.
 *
 * `ok: true` with an EMPTY `edits` array is a success, not a refusal: it is the
 * "no mistakes found" answer and the renderer says so. `dropped` is the number
 * of model proposals main could not resolve against the draft and discarded
 * (§3.3 B7 AC-e) — exposed so the panel can stay honest ("some suggestions
 * could not be placed") instead of silently showing a short list.
 */
export type ProofreadResult =
  | { ok: true; edits: ProofreadEdit[]; provider: string; dropped: number }
  | { ok: false; reason: ProofreadRefusalReason }

// --- §3.3 B6 AI Translate (read side) ---------------------------------------

/**
 * Closed set of languages the translate feature accepts as a TARGET, and as a
 * user-stated SOURCE override.
 *
 * Closed by necessity, not by taste. The target code is the ONLY renderer-
 * supplied value that influences the model instruction, and it does so through
 * a fixed code → English-name table (`TRANSLATE_LANGUAGE_NAMES` in
 * `packages/core/language.ts`) — never as free text spliced into the prompt.
 * That is the §3.3 B4 invariant restated for B6: the renderer sends a
 * low-cardinality identifier plus a message reference, and main builds the
 * instruction. A free-form `targetLang` would be a prompt-shaping channel with
 * no boundary marker around it, since the instruction is the one part of the
 * prompt that is deliberately NOT inside `wrapUntrusted()`.
 *
 * The set is the six interface languages plus the ten most common additional
 * mail languages; growing it is a table edit plus interface labels, and every
 * member must have an entry in `TRANSLATE_LANGUAGE_NAMES` (the compiler
 * enforces that — the table is typed `Record<TranslateLanguageCode, string>`).
 */
export type TranslateLanguageCode =
  | 'en' | 'ru' | 'uk' | 'de' | 'fr' | 'es'
  | 'it' | 'pt' | 'nl' | 'pl' | 'tr' | 'ar'
  | 'zh' | 'ja' | 'ko' | 'hi'

/**
 * Request payload for the `ai:translate:message` IPC channel.
 *
 * The renderer supplies ONLY a message REF and a language identifier — NEVER
 * body text. Main resolves the canonical text from the local SQLite cache by
 * `(accountId, folder, uid)`, exactly as the B4 instant-reply path does, so a
 * compromised renderer cannot get arbitrary attacker-chosen text translated
 * (and paid for) by handing it to main directly, and cannot poison the identity
 * of the message being translated.
 *
 * `sourceLang` is OPTIONAL and CORRECTS A LABEL — it does not unlock anything.
 * The instruction names only the TARGET language (see
 * `buildTranslateSystemPrompt`), so the source language is not an input to the
 * translation at all; it is the caption the interface shows above the result.
 * Local detection therefore does not gate the request: text the detector cannot
 * read confidently is still translated, with no caption. This field is how a
 * user who disagrees with (or misses) that caption states it themselves. Because
 * it never enters the prompt, a wrong or hostile value cannot change what the
 * model is asked to do — it can only mislabel a translation the user asked for.
 */
export type TranslateMessageRequest = {
  accountId: number
  folder: string
  uid: number
  targetLang: TranslateLanguageCode
  /** User-stated source language. Corrects the caption; never gates the request. */
  sourceLang?: TranslateLanguageCode
}

/**
 * Structured refusal reasons for a translation. Same discipline as the B4/B7
 * sets: every failure mode is a VALUE, never a thrown exception, so the IPC
 * promise never rejects and the reading pane always has something to say.
 *
 * There is deliberately NO `undetermined_language` member, and re-adding one
 * would be a defect rather than a feature. It existed until §3.3.B6.f1 and
 * refused the whole translation whenever local detection would not name the
 * source language — a gate demanding an input that provably changes nothing:
 * `buildTranslateSystemPrompt` names only the TARGET, and the user prompt is the
 * boundary-wrapped message text, so the source language never reaches the model
 * on any path. What the gate actually bought was a second click for the exact
 * same result. Undetectable text is now translated with `sourceLang: null` — the
 * caption is simply absent. The "we do not guess" guarantee is untouched: we
 * still never substitute a detector guess we do not trust; we just no longer
 * stand in the way of the translation.
 *
 *   - `opt_out`               — the account's per-account translate opt-in is
 *                               OFF (the default). Distinct from `no_provider`
 *                               on purpose: the actionable fix is a toggle, not
 *                               a provider key (§3.3.B4.f3(a)).
 *   - `empty_input`           — no cached text for this message yet (body not
 *                               downloaded, or the message is empty). Nothing
 *                               was sent to a provider.
 *   - `too_long`              — the text exceeds the input cap. An honest
 *                               refusal, never a silently truncated half
 *                               translation.
 *   - `budget`                — daily/monthly AI budget cap exceeded.
 *   - `no_provider`           — no AI provider configured.
 *   - `answer_too_long`       — the provider ANSWERED but ran out of output
 *                               room, so the translation came back cut off or
 *                               empty. Split out of `provider_error` on
 *                               2026-08-31, and the split is the whole point:
 *                               the two demand OPPOSITE advice. A provider
 *                               hiccup is worth another attempt; running out of
 *                               room is a property of this message and this
 *                               ceiling, so a retry very likely buys the
 *                               identical nothing — at the price of a fresh
 *                               billed call. "Very likely", not "certainly":
 *                               providers are not promised to be deterministic
 *                               and these calls carry a non-zero temperature, so
 *                               the evidence is about the answer already given.
 *                               Telling a reader to "try again" there is the
 *                               product recommending a repeat it expects to
 *                               fail, and charging for the demonstration.
 *
 *                               Emitted ONLY on direct evidence from the
 *                               provider: a `length` stop verdict, or reported
 *                               output tokens sitting on the ceiling. An
 *                               unreadable or absent verdict stays
 *                               `provider_error` — an unexplained failure must
 *                               not be dressed up as an explained one.
 *   - `provider_error`        — the provider call failed or returned nothing
 *                               usable, with no evidence of why.
 */
export type TranslateRefusalReason =
  | 'budget'
  | 'no_provider'
  | 'provider_error'
  | 'answer_too_long'
  | 'empty_input'
  | 'too_long'
  | 'opt_out'

/**
 * A produced translation.
 *
 * ## `translatedText` is TEXT, and the contract has no HTML half
 *
 * There is deliberately no `translatedHtml` field, and there never should be.
 * The translated string is third-party model output derived from untrusted
 * email content: rendering it as markup would hand an attacker who controls the
 * source message a path to markup in our reading pane, one that the sanitizer
 * on the ORIGINAL body never sees because this string does not come from the
 * message — it comes back from the provider. The field name says what it is and
 * the type carries nothing else, so "render it as HTML" is not a thing a caller
 * can do by accident; it would require inventing a field that does not exist.
 * Renderers MUST place it as text (`textContent` / a React text child), never
 * through `dangerouslySetInnerHTML`.
 *
 * `sourceIsTextProjection` is always `true` today and is still carried on the
 * wire rather than assumed by the renderer: what main translates is
 * `messages.body_text`, the plain-text projection the local cache stores — the
 * cache holds no HTML part at all. For an HTML mail that projection is a
 * flattening of the rendered body, so the user is looking at a translation of
 * something slightly different from what the reading pane shows them, and the
 * interface has to say so in one line. The field exists so that disclosure is
 * driven by the payload (and can go `false` the day a richer source path
 * exists) instead of by a renderer-side assumption that would then be wrong.
 *
 * `sourceLang` is ADVISORY and may be `null` even on success — for two distinct
 * reasons that the contract deliberately does not distinguish, because the
 * interface does the same thing in both: the detector would not name the
 * language confidently, or it named one our sixteen-code set has no member for.
 * Either way the caption is absent and the translation is the same translation:
 * the source language never influenced the instruction the model was given, so a
 * wrong value costs a label in the interface and nothing else, and a missing one
 * costs only the label.
 *
 * `cached` is true when the result came from the local translation cache with
 * no provider call — no money spent, no audit row written.
 */
export type TranslatedMessage = {
  /** PLAIN TEXT. Never rendered as markup — see the type docblock. */
  translatedText: string
  /** Detected or user-stated source language. Advisory; may be null. */
  sourceLang: TranslateLanguageCode | null
  targetLang: TranslateLanguageCode
  /** Provider that produced it (possibly on an earlier, now-cached run). */
  provider: string
  /** True when served from the local cache without a provider call. */
  cached: boolean
  /** The source was the cached plain-text projection of the message. */
  sourceIsTextProjection: true
}

/** Discriminated result of an `ai:translate:message` call. */
export type TranslateMessageResult =
  | { ok: true; translation: TranslatedMessage }
  | { ok: false; reason: TranslateRefusalReason }

// --- §3.3 B6 AI Translate (draft side) ---------------------------------------

/**
 * Request payload for the `ai:translate:draft` IPC channel.
 *
 * ## Why this channel carries TEXT while its reading-side sibling carries a REF
 *
 * `TranslateMessageRequest` deliberately never carries body text: the message
 * exists in the local cache, so main can resolve the canonical bytes itself and
 * a compromised renderer cannot substitute attacker-chosen text. A DRAFT has no
 * such canonical copy — it lives in an uncommitted textarea in the compose
 * window and nowhere else — so the text has to cross. That is the same
 * concession `ProofreadRequest` (§3.3 B7) makes for the same reason, and it is
 * bounded the same way:
 *
 *   - `text` is expected to be `splitComposeBody(body).own`, but main does NOT
 *     trust that claim. It re-splits whatever arrives and prompts only the part
 *     ITS OWN split calls the user's text (§2.78), returning the tail it
 *     recognized byte-for-byte.
 *   - The text is boundary-wrapped with `wrapUntrusted()` before it reaches the
 *     model, exactly like mail content.
 *   - There is no free-form instruction field. `targetLang` is a member of the
 *     closed sixteen-value enum and reaches the prompt only through the fixed
 *     code → English-name table, so the renderer cannot shape the instruction.
 *
 * The honest residue: a compromised renderer can spend the user's provider key
 * translating a string of its choosing. That is true of every compose-side AI
 * channel (B4 quick actions, B7 proofread) and is bounded by the same per-account
 * opt-in, the same §2.51 budget admission and the same audit row — not by the
 * shape of this type.
 */
export type TranslateDraftRequest = {
  accountId: number
  /** The user's OWN part of the draft. Re-split server-side; never trusted. */
  text: string
  targetLang: TranslateLanguageCode
}

/**
 * Structured refusal reasons for a draft translation.
 *
 * The six reading-side members mean exactly what they mean in
 * `TranslateRefusalReason` — this set is that set plus one, and the shared
 * members are deliberately spelled by reusing the type rather than by copying
 * six literals that would then drift.
 *
 *   - `no_own_text` — the draft has nothing but a quoted original, a forwarded
 *     block or a signature, so there is nothing of the user's own to translate.
 *     Its own reason, never collapsed into `empty_input`: the actionable answer
 *     is "write something above the quote", not "your draft is empty", and a
 *     bottom-posted reply legitimately reaches it (see the v1 limitation in
 *     `packages/core/composeBody.ts`).
 *
 * There is deliberately no `undetermined_language` member here either, for the
 * reason its reading-side twin does not have one: the instruction names only the
 * TARGET, so the source language is not an input to the translation at all.
 */
export type TranslateDraftRefusalReason = TranslateRefusalReason | 'no_own_text'

/**
 * A produced draft translation.
 *
 * ## `translatedText` replaces exactly the string that was sent
 *
 * NOT "the translation of the own part". Main re-splits the received string
 * (§2.78 server-side boundary) and translates only what that split calls the
 * user's own text — so if the renderer sent more than it promised, the
 * translation of a SUBSET would be a lossy replacement for the whole. What comes
 * back is therefore `joinComposeBody(splitOfWhatArrived, translatedOwn)`: the
 * translated own part with any quote / forward banner / signature main
 * recognized inside the payload restored byte-for-byte around it.
 *
 * The caller substitutes it for the string it sent — normally
 * `joinComposeBody(splitComposeBody(body), translatedText)` — so the byte
 * guarantee holds at both levels and the parts the renderer withheld are
 * untouchable by construction.
 *
 * ## PLAIN TEXT, and there is no HTML half
 *
 * Same rule as `TranslatedMessage`, and for a sharper reason: this string is
 * model output derived from text that may itself contain a quoted attacker
 * message. There is no `translatedHtml` field and there must never be one —
 * renderers place it as text, never through `dangerouslySetInnerHTML`.
 */
export type TranslatedDraft = {
  /** PLAIN TEXT replacement for exactly the string that was sent. */
  translatedText: string
  targetLang: TranslateLanguageCode
  /** Provider that produced it. */
  provider: string
}

/** Discriminated result of an `ai:translate:draft` call. */
export type TranslateDraftResult =
  | { ok: true; translation: TranslatedDraft }
  | { ok: false; reason: TranslateDraftRefusalReason }
