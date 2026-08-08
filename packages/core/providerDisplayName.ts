/**
 * Normalization of a human display name taken from an OAuth provider profile
 * (the OIDC `name` claim, or Microsoft Graph's `displayName`).
 *
 * §2.94 — before this existed, the claim was cast to `string` and `.trim()`ed
 * straight into `AccountMeta.name`. That value is not ours: it comes from a
 * provider response, so a compromised provider — or an actor able to present a
 * trusted TLS response — controls it end to end. Three things followed from
 * trusting it (codex-bg-review, 2026-08-02):
 *
 *   1. A non-string claim (`name: 42`, `name: {}`) reached `.trim()` and threw
 *      a TypeError *after* the user had already authorized, so the sign-in
 *      failed at its very last step with an opaque error.
 *   2. The value becomes the synthesized default identity's display name and
 *      is interpolated into the outgoing From mailbox as `${name} <${email}>`
 *      (`electron/main.ts`). Control characters — CR/LF above all — have no
 *      business in a header-adjacent string, whatever the transport library
 *      happens to do with them downstream.
 *   3. Nothing bounded the length, so an arbitrarily long claim was persisted
 *      and shipped on every outgoing message.
 *
 * The policy is deliberately conservative and lossy: this is preference data
 * (what to show, and what to sign mail as), never identity data. When in doubt
 * we return `undefined` and let the caller fall back — every caller's fallback
 * (a name the user edited, or the address local part) is safe, so there is no
 * reason to salvage a questionable claim.
 */

/** Upper bound on a persisted display name.
 *
 *  RFC 5322 caps header lines at 998 octets and folds beyond 78; a display
 *  name is only one part of the From mailbox, and no legitimate human name
 *  approaches this. 128 is generous for the longest real names — including
 *  scripts where one grapheme spans several UTF-16 units — while keeping the
 *  resulting header short. Over-length claims are rejected rather than
 *  truncated: a truncated name is a wrong name, and the fallback produces a
 *  sensible one. */
export const MAX_PROVIDER_DISPLAY_NAME_LENGTH = 128

/**
 * Characters that disqualify a display name outright.
 *
 *  - `\p{Cc}` — C0/C1 controls, i.e. CR, LF, TAB, NEL, DEL. CR/LF are the
 *    header-injection primitive; none of the rest belong in a name.
 *  - `\p{Zl}` / `\p{Zp}` — U+2028 / U+2029, line and paragraph separators that
 *    several parsers treat as line breaks.
 *  - `\p{Bidi_Control}` — LRO/RLO/LRI/RLI and friends, which make a rendered
 *    name read as something other than what is stored. That is a spoofing
 *    surface everywhere we answer "which account is this".
 *
 * Written as Unicode property escapes rather than literal ranges on purpose:
 * these characters are invisible in an editor, and a literal one pasted into
 * source is itself a hazard. Deliberately NOT rejected: ZWNJ/ZWJ (U+200C/D,
 * load-bearing in Persian, Indic scripts and emoji sequences) and the soft
 * hyphen — rejecting those would drop legitimate names.
 */
const DISALLOWED_IN_DISPLAY_NAME = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u

/**
 * Characters that carry meaning in RFC 5322 mailbox grammar.
 *
 * The send path builds the From header by concatenation —
 * `` `${displayName} <${fromEmail}>` `` in `electron/main.ts` — and hands the
 * result to nodemailer as a *string*, which nodemailer then parses as an
 * address list. A name ending in `Mallory <mallory@evil.test>,` therefore
 * stops being an inert label and becomes a second parsed mailbox
 * (codex-security-review, 2026-08-02).
 *
 * Rejecting these characters costs us names like `Doe, John` — the account
 * simply keeps no provider name and falls back, which is harmless. Accepting
 * them costs control of the From line to whoever controls the profile
 * response, which is not.
 *
 * This is a narrow guard for the one source this module owns: a name typed by
 * the user reaches the same concatenation and is NOT covered here. The real
 * fix is to hand nodemailer structured `{ name, address }` data so no caller
 * has to understand mailbox grammar — tracked as BACKLOG §2.97.
 */
const ADDRESS_GRAMMAR_CHARS = /[<>,;:"\\@()[\]]/

/**
 * Returns a display name safe to persist and to place in a From mailbox, or
 * `undefined` when the claim is absent, is not a string, is empty after
 * trimming, exceeds {@link MAX_PROVIDER_DISPLAY_NAME_LENGTH}, or carries a
 * character from {@link DISALLOWED_IN_DISPLAY_NAME} or
 * {@link ADDRESS_GRAMMAR_CHARS}.
 *
 * Never repairs its input — a claim either passes intact or is dropped.
 */
export function normalizeProviderDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined

  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_PROVIDER_DISPLAY_NAME_LENGTH) return undefined
  if (DISALLOWED_IN_DISPLAY_NAME.test(trimmed)) return undefined
  if (ADDRESS_GRAMMAR_CHARS.test(trimmed)) return undefined

  return trimmed
}
