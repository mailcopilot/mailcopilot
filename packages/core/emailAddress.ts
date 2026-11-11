// ──────────────────────────────────────────────────────────────────────────
// emailAddress.ts — the ONE email-address shape this app validates against.
//
// WHY THIS FILE EXISTS
//
// zod 4's default `z.email()` / `z.string().email()` validates against
// `z.regexes.email` — NOT `html5Email`, which zod also ships and which is a
// different (equally ASCII-only) pattern. Measured on the zod version pinned
// in this repo (4.4.3), the default is
//
//     ^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$
//
// which is ASCII-only on both sides and, separately, has no `=` in its local
// part. Hence:
//
//     z.string().email().safeParse('info@xn--80a1acny.xn--p1ai')  -> false
//     z.string().email().safeParse('user@почта.рф')               -> false
//     z.string().email().safeParse('a=b@example.com')             -> false
//
// The first is a plain punycode `.рф` domain — the exact form every IDN mail
// server hands us in a header. The second is its unicode spelling. The third
// is an ASCII address whose local part uses `=`, which RFC 5322 `atext`
// allows and mailing-list software emits routinely. All three were rejected,
// which meant: Reply/Reply-all on a message carrying such an address in
// From/To/Cc failed the whole `ui:openCompose` payload and no compose window
// opened at all, and a mailbox on a `.рф` domain could not be saved.
//
// The replacement pattern is NOT hand written. zod ships one for exactly this
// case — `z.regexes.unicodeEmail`, the same pattern its own `z.email()` uses
// under `{ pattern: z.regexes.unicodeEmail }`. Taking the library's pattern is
// deliberate: an email grammar maintained here would be a permanent source of
// the very bug this file fixes.
//
// WHAT THE LIBRARY PATTERN ACCEPTS, SAID OUT LOUD
//
// `z.regexes.unicodeEmail` is `^[^\s@"]{1,64}@[^\s@]{1,255}$` — deliberately
// loose. It accepts a dotless domain (`a@b`) and bracketed IP literals, which
// the old ASCII pattern refused. That widening is accepted: these schemas
// guard addresses that either came out of a message WE already accepted, or
// that the user typed for their own mailbox, and the authority on whether an
// address is deliverable is the receiving MTA — not a regex here (CLAUDE.md §5
// "Кто владеет правдой").
//
// WHAT STAYS FORBIDDEN, AND WHY IT IS NOT NEGOTIABLE
//
//   * Whitespace — excluded by the library pattern itself. CR and LF are `\s`,
//     so no value accepted here can smuggle a second header line into a From/To
//     we compose.
//   * Control and format characters, and `"` — excluded by
//     {@link FORBIDDEN_ADDRESS_CHARS} below. The library pattern excludes `"`
//     only in the LOCAL part (`[^\s@"]` vs `[^\s@]`), and excludes non-`\s`
//     control characters nowhere at all: measured on zod 4.4.3,
//     `a@ex"ample.com`, `a@b\u0001c.com` and `abc\u0000d@e.com` all pass it.
//     A NUL or a C0 byte in an address is either a truncation bug waiting to
//     happen in some downstream C string or a way to make two different bytes
//     render as one address; `\p{Cf}` additionally covers the invisible
//     bidi/zero-width characters (U+200B, U+202E) that make one address look
//     like another. None of them occur in a real address, so this is a free
//     narrowing — the old ASCII pattern excluded all of them too.
//   * `, ; : < >` — excluded by {@link ADDRESS_LIST_SEPARATORS} below, applied
//     on top of the library pattern. The library pattern permits them, and
//     they are precisely the RFC 5322 `specials` that turn ONE address into an
//     address LIST or a group (`a@x.com,b@y.com`, `Label:a@x;`, `<a@x>`). Every
//     schema here validates a SINGLE address; without this check, widening the
//     grammar would also have widened "one sender" into "many senders" on the
//     stored account/identity address that builds the From header. The old
//     ASCII pattern rejected all five characters, so this keeps a guarantee
//     rather than adding one. Same belt-and-suspenders check, same reasoning,
//     as `electron/services/inviteBridge.ts`.
//
// This module is intentionally kept out of `packages/core/index.ts` (the same
// treatment as `language.ts`): the barrel is pulled into the RENDERER bundle,
// which today has no zod dependency at all, and there is no reason to add one
// for a validator only the main process needs. Import it by path:
// `@mailcopilot/core/emailAddress`.
// ──────────────────────────────────────────────────────────────────────────
import { z } from 'zod'

/**
 * The email grammar, taken verbatim from zod. Exported so the one place that
 * ever needs to talk about the pattern (tests, a future non-zod caller) does
 * not re-derive it.
 */
export const EMAIL_ADDRESS_PATTERN = z.regexes.unicodeEmail

/**
 * RFC 5322 `specials` that separate addresses from one another. See the header
 * block: their absence is what makes "one address" mean one address.
 */
const ADDRESS_LIST_SEPARATORS = /[,;:<>]/

/**
 * Characters that never belong to an address and that the library pattern lets
 * through: C0/C1 controls (`\p{Cc}`, which includes NUL — `\s` covers only the
 * whitespace subset), invisible format characters (`\p{Cf}` — zero-width and
 * bidi overrides, the homograph toolkit), and the double quote the library
 * pattern excludes from the local part but not from the domain. See the header
 * block for the measurements.
 */
const FORBIDDEN_ADDRESS_CHARS = /[\p{Cc}\p{Cf}"]/u

/**
 * Upper bound implied by the library pattern (64 local + `@` + 255 domain).
 * Named so the cheap length rejection below reads as a bound and not a magic
 * number; it is a cost guard, not a second grammar.
 */
export const EMAIL_ADDRESS_MAX_LENGTH = 64 + 1 + 255

const isSingleAddress = (value: string): boolean =>
  value.length <= EMAIL_ADDRESS_MAX_LENGTH
  && !ADDRESS_LIST_SEPARATORS.test(value)
  && !FORBIDDEN_ADDRESS_CHARS.test(value)

/**
 * A single email address. Unicode and punycode domains accepted; address
 * lists, groups and angle-bracketed forms rejected.
 */
export const emailAddressSchema = z
  .email({ pattern: EMAIL_ADDRESS_PATTERN })
  .refine(isSingleAddress, { message: 'Invalid email address' })

/**
 * Same shape, with surrounding whitespace stripped first — the drop-in
 * replacement for the former `z.string().trim().email()`.
 */
export const trimmedEmailAddressSchema = z.string().trim().pipe(emailAddressSchema)

/**
 * Predicate form, for call sites that filter rather than reject. Accepts
 * `unknown` so a caller can hand it raw IPC data without a pre-check.
 */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && emailAddressSchema.safeParse(value).success
}

/**
 * Cap on a prefill address list. Reply-all on a real message tops out in the
 * low dozens; anything past this is noise and gets dropped, not refused.
 */
export const PREFILL_ADDRESS_LIST_MAX = 200

/**
 * A list of addresses used ONLY to pre-fill a compose window (`ui:openCompose`
 * `originalRecipients`: the From/To/Cc pool of the message being replied to,
 * which feeds identity auto-selection and the misdirection warning).
 *
 * No CONTENT of the list can make this schema fail — that is its whole point,
 * and the guarantee stops exactly there: a value that is not an array at all
 * is still rejected, because that is a caller bug rather than a message we
 * received. The list is derived from headers of a message that already
 * arrived, so its ENTRIES are chosen by the sender, not by us — and refusing
 * the payload means the user clicks "Reply" and no window opens at all, with
 * nothing on screen explaining why. One odd address in a Cc must not cost the
 * user the ability to reply. So: over-long lists are truncated, entries that
 * are not a single well-formed address are dropped, and whatever survives is
 * used.
 *
 * Dropping is safe in the direction that matters: the misdirection check warns
 * when a recipient's domain is NOT among the original recipients' domains, so a
 * dropped entry can only produce an extra warning, never a missing one.
 */
export const prefillAddressListSchema = z
  .array(z.unknown())
  .transform((list) => list.slice(0, PREFILL_ADDRESS_LIST_MAX).filter(isEmailAddress))
