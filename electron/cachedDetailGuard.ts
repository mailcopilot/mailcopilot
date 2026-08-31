/**
 * §2.145 — deciding whether a stored `messages.cached_detail` row may be served.
 *
 * WHAT THIS IS FOR, stated first because the first version of it got this wrong:
 * it screens PATHOLOGY THAT NO CURRENT WRITER CAN PRODUCE. It is NOT an
 * enforcement of the EML soft cap on the cache, and it must never be read as
 * one.
 *
 * The distinction is the whole bug. Two writers put rows into this cache and
 * they have DIFFERENT, both legitimate, body bounds:
 *
 *   - the EML path — capped by §2.145 at `EML_BODY_SOFT_CAP_BYTES` (1 MiB per
 *     representation) and marked with `parseCap`;
 *   - the SERVER-DIRECT path (`fetchMessageDetails`, packages/net/message.ts) —
 *     capped by its own fetch bounds at `MAX_BODY_BYTES` = 5 MiB per part, and
 *     NOT marked, because no parse cap tripped. Nothing about that row is
 *     wrong.
 *
 * Judging the second writer's rows by the first writer's cap refused every
 * legitimate server-direct body above 1 MiB, on every reopen, forever: online
 * it refetched over the network and rewrote a row that would be refused again
 * next time (the rewrite is cap-less and the same size — no self-healing);
 * offline it threw away a perfectly good cached body and showed header facts.
 * A guard that rejects what the system itself legitimately produces is not a
 * guard, it is an outage.
 *
 * So the threshold is derived from the MAXIMUM A LEGITIMATE CURRENT WRITER CAN
 * EMIT, and anything above it can only be a row from before the caps existed —
 * the 50 MB body that froze the renderer on every open, which is the entire
 * reason this file exists.
 */

import type { MessageDetails } from '../packages/net/types'
// §2.145 wave 2.1 — imported, not copied. This module and `fetchMessageDetails`
// must agree on the server-direct body ceiling exactly; a hand-copied literal
// here is what let the two drift and made the guard refuse legitimate rows.
// `packages/net/limits.ts` is a leaf with no imports, so taking the constant
// costs this file (and its unit test) no dependency on the net layer.
import { SERVER_DIRECT_MAX_BODY_BYTES } from '../packages/net/limits'

/**
 * Largest body ONE representation may hold in a legitimately-written row.
 *
 * Not a number chosen here — it IS the server-direct fetch bound, imported from
 * the single place that defines it. `fetchMessageDetails`
 * (packages/net/message.ts) fetches the html part and the text part separately,
 * each through a reader that stops BEFORE appending a chunk that would cross
 * the bound, so it is a true ceiling and needs no headroom. The EML writer's
 * own cap (1 MiB) is far below this, so one number covers both writers — and
 * covering both with the LARGER is the point: the smaller is a property of one
 * writer, not of the cache.
 *
 * The alias exists so this file reads in its own terms ("the largest body a
 * legitimate cached row may hold") while the VALUE has exactly one definition.
 * Wave 1.2 wrote the number out by hand and pinned it with a test that asserted
 * the literal against itself; that test could never have failed, and the drift
 * it was supposed to catch is precisely what happens when `MAX_BODY_BYTES`
 * moves and nothing here notices.
 */
export const MAX_LEGITIMATE_CACHED_BODY_BYTES = SERVER_DIRECT_MAX_BODY_BYTES

/**
 * Allowance for everything in a row that is NOT body: envelope addresses,
 * message-id, references, and the attachment list — whose length follows the
 * message's PART COUNT and is therefore not bounded by any body cap. A message
 * with a few thousand parts (the "many small parts" shape §2.124 already tests)
 * carries a few hundred bytes of metadata each; 1 MiB clears that with room and
 * is negligible against the body terms below.
 */
const CACHED_DETAIL_METADATA_ALLOWANCE_CHARS = 1024 * 1024

/**
 * Worst-case expansion of one source character under JSON string escaping.
 *
 * Six, because that is the real maximum: a control character outside the small
 * set with short escapes (`\b \f \n \r \t`) is emitted as `\u00XX` — six
 * characters for one. Quotes and backslashes cost two, which is what ordinary
 * mail actually produces, but a bound built on "ordinary" is the same mistake
 * as the one this file documents above: a legitimate row that exceeded it would
 * be refused before it could even be parsed, and refused again on every reopen.
 * The factor has to be the arithmetic maximum, not the plausible one.
 */
const JSON_ESCAPE_WORST_CASE_FACTOR = 6

/**
 * Upper bound on the SERIALIZED row, checked before `JSON.parse`.
 *
 * Why before: parsing is itself the freeze this guards against — `JSON.parse`
 * of a 50 MB string blocks the main loop for as long as the string is long, so
 * a check behind it would have paid the exact cost it exists to refuse.
 *
 * Derivation: two representations (html and text are alternatives, each bounded
 * independently) × the largest a legitimate writer can emit × the worst-case
 * escape expansion, plus the metadata allowance.
 *
 * HONEST STATEMENT OF WHAT THIS DOES AND DOES NOT CATCH. The arithmetic puts
 * this bound ABOVE the legacy 50 MB pathology, so a 50 MB row is NOT refused
 * here — it is parsed once, refused by `isServableCachedDetail`, and then
 * INVALIDATED by the caller so it is never parsed again (see the caller's
 * `setCachedDetail(..., '')`). That one-time cost is deliberate and is the only
 * arrangement that is sound in both directions: any bound low enough to catch
 * 50 MB pre-parse is also low enough to refuse a legitimate 10 MiB-of-content
 * row whose body escapes badly, and that row would be refused forever. One
 * bounded parse, once per affected message, beats a permanent false positive.
 * What this bound still does is keep the parse BOUNDED — a 500 MB row is
 * refused outright, so the cost of the one-time parse can never be arbitrary.
 */
export const MAX_CACHED_DETAIL_JSON_CHARS =
  2 * MAX_LEGITIMATE_CACHED_BODY_BYTES * JSON_ESCAPE_WORST_CASE_FACTOR
  + CACHED_DETAIL_METADATA_ALLOWANCE_CHARS

/** First gate: on the serialized row, before it is parsed. */
export function isServableCachedDetailJson(dbJson: string): boolean {
  return dbJson.length <= MAX_CACHED_DETAIL_JSON_CHARS
}

/**
 * Second gate: on the parsed row.
 *
 * A row carrying `parseCap` came from the capped pipeline and is bounded by
 * construction, so it is accepted without measuring. Everything else is
 * measured against what a legitimate CAP-LESS writer can emit — which is the
 * server-direct path's 5 MiB per representation, NOT the EML path's 1 MiB.
 */
export function isServableCachedDetail(details: MessageDetails): boolean {
  if (details.parseCap) return true
  const withinCap = (value: string | undefined) =>
    value === undefined || Buffer.byteLength(value, 'utf8') <= MAX_LEGITIMATE_CACHED_BODY_BYTES
  return withinCap(details.html) && withinCap(details.text)
}
