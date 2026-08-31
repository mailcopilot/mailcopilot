/**
 * `cid:` parts of a message body — two questions, deliberately answered by two
 * different rules, because a wrong answer costs a different amount in each.
 *
 * ## 1. Which parts does the body inline? — {@link selectCidPartsToInline}
 *
 * A wrong answer costs an IPC round-trip and some base64 in the srcdoc, so the
 * rule is broad on purpose: every eligible part whose `cid:` token appears
 * anywhere in the body. That is exactly the set `replaceCidImages` substitutes,
 * so "what we fetch" and "what gets substituted" cannot drift apart — and a
 * layout image referenced from a CSS background, a `srcset` candidate or a
 * media query keeps being drawn, whatever position it was written in.
 *
 * ## 2. Which parts lose their attachment chip? — {@link selectPartsToHide}
 *
 * A wrong answer takes away the user's only access to a file. Three review
 * rounds of §2.128 kept finding new ways to write a real attachment's `cid`
 * somewhere a browser never draws it: inside a CSS comment, inside a
 * `content:"url(cid:…)"` string, under `@media not all`, in an unused custom
 * property, behind an escaped `@\69mport`, in a `<source media="not all">`, in a
 * `srcset` candidate the browser will not pick. Every one of them hid a real
 * file.
 *
 * The root cause was never the parser. Whether a rule applies, what the cascade
 * resolves to, which `srcset` candidate wins — the browser owns those answers;
 * we could only estimate them, and we were removing access to files on an
 * estimate (CLAUDE.md §5 «Кто владеет правдой»). So the promise was narrowed
 * rather than the parser widened. A part is hidden only when ALL of these hold:
 *
 *   1. the part carries a `cid`;
 *   2. its `Content-Disposition` is explicitly `inline` (parameters are fine;
 *      absent is not `inline`);
 *   3. that `cid` appears in an image `src` **attribute** — `<img src>` or
 *      `<input type=image src>` — and nowhere else counts;
 *   4. its bytes were fetched and substituted into the body (established by the
 *      caller, which is the only place that knows).
 *
 * Everything else keeps its chip. A logo drawn as a CSS background therefore
 * shows one redundant chip. That is the accepted price and it is the cheap
 * direction: an unrecognised reference costs a chip, an invented one costs a
 * file. Keeping the chip row compact is the ceiling's job
 * (`capAttachmentList`), not the filter's.
 */

import { normalizeCid } from './mail'

// --- Shared vocabulary -------------------------------------------------------

/** The part fields both rules read. Structural, so `AttachmentMeta` and test doubles fit. */
export interface InlineCidCandidate {
  cid?: string | null
  disposition?: string | null
}

export interface ResolvedCidPart<T extends InlineCidCandidate> {
  /** Normalized `cid` (no angle brackets) — the key `replaceCidImages` keys on. */
  cid: string
  /** The MIME part that `cid` resolves to. */
  attachment: T
}

/** The disposition type without its parameters, lowercased. */
function dispositionType(disposition?: string | null): string {
  return (disposition || '').toLowerCase().split(';')[0].trim()
}

// --- 1. Parts the body inlines ----------------------------------------------

/**
 * How many parts one message may inline.
 *
 * A ceiling exists because each inlined part costs an IPC round-trip and a
 * base64 copy of the bytes in the srcdoc. Parts past it are simply not fetched,
 * so they are not substituted either — and by condition 4 they keep their chip.
 */
export const MAX_INLINE_CID_PARTS = 25

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the body mentions `cid:<id>` in the exact shape `replaceCidImages`
 * substitutes: case-insensitive, angle brackets optional. Same shape on both
 * sides means we never fetch bytes that would not be substituted, and never
 * skip bytes that would.
 */
function mentionsCid(html: string, cid: string): boolean {
  return new RegExp(`cid:<?${escapeRegExp(cid)}>?`, 'i').test(html)
}

/**
 * The parts to fetch and substitute into the body, in attachment order, capped.
 *
 * Position-blind on purpose (see the module header): the substitution itself is
 * position-blind, so anything narrower would stop drawing images that render
 * today. `Content-Disposition: attachment` is the sender saying "this is a
 * file" and is excluded; a repeated `cid` resolves to its first part, which is
 * the one the substitution addresses.
 *
 * Pure and total: any input, including malformed markup, yields an array.
 */
export function selectCidPartsToInline<T extends InlineCidCandidate>(
  attachments?: readonly T[] | null,
  html?: string | null,
  options: { limit?: number } = {},
): ResolvedCidPart<T>[] {
  const parts = Array.isArray(attachments) ? attachments : []
  const source = typeof html === 'string' ? html : ''
  if (parts.length === 0 || !/cid:/i.test(source)) return []

  const rawLimit = options.limit ?? MAX_INLINE_CID_PARTS
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : MAX_INLINE_CID_PARTS

  const out: ResolvedCidPart<T>[] = []
  const seen = new Set<string>()
  for (const att of parts) {
    if (out.length >= limit) break
    if (!att || dispositionType(att.disposition) === 'attachment') continue
    const cid = normalizeCid(att.cid || '')
    const key = cid.toLowerCase()
    if (!key || seen.has(key)) continue
    if (!mentionsCid(source, cid)) continue
    seen.add(key)
    out.push({ cid, attachment: att })
  }
  return out
}

// --- 2. Parts that lose their chip -------------------------------------------

/**
 * Regions whose text a browser does not parse as markup. Removed before the tag
 * scan so an `<img src="cid:…">` written inside one cannot pass for a rendered
 * image — `<style>` included: its content is CSS, and CSS is not a position
 * this rule accepts at all any more.
 */
const IGNORED_REGIONS_RE =
  /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<noscript\b[\s\S]*?<\/noscript\s*>|<textarea\b[\s\S]*?<\/textarea\s*>|<title\b[\s\S]*?<\/title\s*>/gi

/**
 * The same regions left UNTERMINATED, which a parser swallows to the end of the
 * document. Applied after {@link IGNORED_REGIONS_RE}, so a match here is by
 * construction an opener with no closer.
 */
const UNTERMINATED_REGION_RE =
  /(?:<!--|<script\b|<style\b|<noscript\b|<textarea\b|<title\b)[\s\S]*$/i

/**
 * One start tag: name plus its attribute blob. Quoted attribute values are
 * consumed as units, so neither a `>` inside `alt="a>b"` ends the tag early,
 * nor does an `<img …>` written inside another element's attribute value read
 * as a tag of its own.
 */
const TAG_RE = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/** One attribute: `name=value`, value double-quoted, single-quoted or bare. */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** Parse one attribute blob into lowercased-name → raw-value pairs. */
function readAttributes(blob: string): Map<string, string> {
  const out = new Map<string, string>()
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(blob))) {
    const name = m[1].toLowerCase()
    if (out.has(name)) continue // first occurrence wins, as in a real parser
    out.set(name, m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/**
 * The `cid`s written in an image `src` attribute — `<img src>` and
 * `<input type=image src>`, normalized, unique, first-seen order.
 *
 * This is the whole of condition 3, and it is deliberately the narrowest
 * position that exists: one attribute, on two elements. `srcset`, `<source>`,
 * `style`, `<style>`, `href`, `background` and every other position is ignored,
 * which at worst leaves a redundant chip.
 *
 * Entity-encoded values (`cid&#58;x`) are not decoded either: this runs on the
 * sanitized html, where the parser has already decoded them, and an undecoded
 * leftover falls on the harmless side.
 */
export function extractImageSrcCids(html?: string | null): string[] {
  const source = typeof html === 'string' ? html : ''
  if (!/cid:/i.test(source)) return []

  const scannable = source.replace(IGNORED_REGIONS_RE, ' ').replace(UNTERMINATED_REGION_RE, ' ')

  const out: string[] = []
  const seen = new Set<string>()
  TAG_RE.lastIndex = 0
  let tag: RegExpExecArray | null
  while ((tag = TAG_RE.exec(scannable))) {
    const name = tag[1].toLowerCase()
    if (name !== 'img' && name !== 'input') continue
    const attrs = readAttributes(tag[2] || '')
    // `<input src>` only fetches for the image type; any other type ignores it.
    if (name === 'input' && (attrs.get('type') || '').trim().toLowerCase() !== 'image') continue
    const src = (attrs.get('src') || '').trim()
    if (!/^cid:/i.test(src)) continue
    const cid = normalizeCid(src.slice(4).trim())
    if (!cid || seen.has(cid.toLowerCase())) continue
    seen.add(cid.toLowerCase())
    out.push(cid)
  }
  return out
}

/**
 * The parts whose attachment chip is dropped — conditions 2 and 3 applied to
 * the parts the caller has already fetched and substituted (conditions 1 and 4).
 *
 * @param inlined parts whose bytes really made it into `html`'s successor. The
 *   caller passes only successes: a failed fetch must leave the chip in place,
 *   because the body shows a broken image and the file is then reachable from
 *   nowhere.
 * @param html the html the substitution ran on (sanitized, before substitution)
 *   — a position the sanitizer removed cannot retire a part.
 */
export function selectPartsToHide<T extends InlineCidCandidate>(
  inlined?: readonly ResolvedCidPart<T>[] | null,
  html?: string | null,
): T[] {
  if (!inlined || inlined.length === 0) return []
  const imageSrc = new Set(extractImageSrcCids(html).map(cid => cid.toLowerCase()))
  if (imageSrc.size === 0) return []

  const out: T[] = []
  for (const entry of inlined) {
    if (dispositionType(entry.attachment?.disposition) !== 'inline') continue
    if (!imageSrc.has(entry.cid.toLowerCase())) continue
    out.push(entry.attachment)
  }
  return out
}
