/**
 * composeBody — split a compose draft into "what the user wrote themselves"
 * and the tail that no AI rewrite is allowed to touch (§2.78).
 *
 * A draft body is rarely just the user's own words. Replying prepends
 * `['', '', attribution, quoteText(original)]` (see `src/App.tsx` +
 * `quoteText()` in `./mail`), forwarding prepends a dashed header block, and a
 * new message gets the identity signature appended after a `--` separator
 * (`src/windows/Compose.tsx`). Feeding all of that to a rewrite model made the
 * model rewrite the correspondent's quoted message and the user's signature,
 * and "Replace" then wrote the result over the WHOLE body — silently destroying
 * text the user never asked to change.
 *
 * This module is the boundary detector: pure, DOM-free, and deliberately
 * structural. Everything here keys off punctuation that the wire format itself
 * carries (`>` quote prefix, `--` signature separator, `---- ... ----` forward
 * marker) rather than off localized template strings such as
 * `compose.templates.replyIntro` — those exist in six languages, and any
 * detector anchored to them breaks in five of them.
 *
 * Round-trip contract: `lead + own + tail === body`, always. `joinComposeBody`
 * therefore restores the exact layout with the rewritten text spliced in for
 * `own`, and no byte outside `own` can be lost by a rewrite. Line endings are
 * NEVER normalized: lines are cut on `\n` alone, so a CRLF body keeps its `\r`
 * bytes inside the returned pieces and every classifier here has to tolerate a
 * trailing `\r` itself. `QUOTE_LINE_RE` matches a prefix (indifferent),
 * `isForwardMarkerLine` and `isAttributionLine` strip it via `trim()` /
 * `trimEnd()`, and `SIGNATURE_SEPARATOR_RE` spells `\r?` explicitly. CRLF
 * drafts are the normal case for a draft resumed from an IMAP server.
 *
 * ## Known v1 limitation — bottom posting is NOT segmented
 *
 * The split is a single boundary: the FIRST quote/forward/signature marker ends
 * the user's own part, and everything below it is tail. A reply typed UNDER the
 * quoted block therefore lands entirely in `tail` and is reported as "no own
 * text" by the caller rather than rewritten. This is intentional for v1 — it
 * fails towards "we touch nothing" instead of towards "we rewrite the
 * correspondent's words". A multi-segment model (own text above AND below the
 * quote, quote preserved in the middle) is a separate task; do not "fix" this
 * by moving the boundary to the LAST marker, which would put the quoted message
 * into the rewritable part.
 *
 * ## Known v1 limitation — quoting styles this detector does NOT recognize
 *
 * The markers above (`>` prefix, `--` separator, `---- text ----` banner) cover
 * what MailCopilot itself writes and what the common clients write alongside
 * it. Several real quoting styles carry no such marker, and on those drafts no
 * boundary is found at all — the whole body becomes `own`, so a rewrite can
 * reword the correspondent's words inside it. Honest list, so nobody has to
 * rediscover it:
 *
 *  - **Vertical-bar quoting** (`| their text`) — used by some mailing-list
 *    digests and text-mode clients instead of `>`.
 *  - **Indentation-only quoting** — the quoted block is set off by leading
 *    spaces or a tab and nothing else.
 *  - **Bare Outlook header blocks** (`From:` / `Sent:` / `To:` / `Subject:`)
 *    with neither the dashed `-----Original Message-----` banner above them nor
 *    the long underscore rule some builds emit.
 *  - **A plain-text rendering of an HTML quote** — the conversion drops the `>`
 *    prefixes entirely and leaves the correspondent's paragraphs bare.
 *  - **Localized "Begin forwarded message:" style forwards** with no dashes
 *    (Apple Mail), and the long-underscore separator (some Outlook builds).
 *
 * This is a deliberate v1 limitation, NOT a backlog of regexes to fill in.
 * Two reasons. First, it is not a regression: before §2.78 every such draft was
 * rewritten whole, so these bodies behave exactly as they always did — the fix
 * strictly improved the cases it does recognize. Second, the durable fix is a
 * change of DATA FORMAT, not of parsing: the composer already knows which bytes
 * are quoted material at the moment it assembles a reply or forward, so the
 * answer is to carry that segmentation forward as structure instead of trying
 * to re-derive it from prose downstream. Growing this file into a stack of
 * per-client heuristics is the known losing move — each new pattern buys one
 * client and adds a false-positive surface that silently narrows `own` for
 * everyone else. If you are about to add a sixth marker regex here, that is the
 * signal to build the structured segmentation instead.
 *
 * What IS guaranteed on these drafts: the round-trip contract still holds
 * byte-for-byte (`lead + own + tail === body`), so nothing is ever lost by the
 * split itself; the user still reviews every rewrite in the before/after panel
 * before any substitution happens; and the tests below pin this direction so a
 * future change that starts eating these bodies differently is visible.
 */

/** A line belonging to a quoted block: `> text`, `>> nested`, `  > indented`. */
const QUOTE_LINE_RE = /^[ \t]*>/

/**
 * Signature separator. RFC 3676 §4.3 spells it `-- ` (with the trailing space),
 * but MailCopilot's own composer writes `--` WITHOUT it (`sigSep = '\n\n--\n'`
 * in `src/windows/Compose.tsx`, plus the template-insert path). A detector that
 * knows only the RFC form finds no signature we ever produced ourselves, so
 * both forms are accepted.
 *
 * The trailing `\r?` is load-bearing, not defensive noise. Lines are cut on
 * `\n` alone (see `splitComposeBody`) precisely so the split stays byte-exact,
 * which means a CRLF body hands every classifier a line with a trailing `\r`:
 * the separator arrives as `"--\r"`. Without `\r?` it failed to match and the
 * signature was classified as the user's own text — so a rewrite could reword
 * or drop it. CRLF bodies are not exotic: an IMAP-stored draft resumed through
 * `ComposeInit.text` carries wire line endings verbatim. Normalizing the body
 * to `\n` instead would be the wrong fix — it breaks the `lead + own + tail ===
 * body` byte contract that keeps the tail untouchable.
 */
const SIGNATURE_SEPARATOR_RE = /^--[ \t]*\r?$/

/**
 * Forward marker: a dashed banner with text inside, e.g.
 * `---------- Forwarded message ----------` (ours, localized) or
 * `-----Original Message-----` (Outlook). Structural, so the localized words in
 * the middle are irrelevant. A bare rule of dashes (`--------`) does NOT match:
 * users type those as separators inside their own text.
 */
function isForwardMarkerLine(line: string): boolean {
  const s = line.trim()
  if (!/^-{3,}/.test(s) || !/-{3,}$/.test(s)) return false
  const inner = s.replace(/^-+/, '').replace(/-+$/, '').trim()
  return inner.length > 0
}

/**
 * Whether `line` is the attribution that introduces the quote right below it
 * ("On <date>, <who> wrote:"). Locale-independent test: a non-empty, non-quoted
 * line whose last visible character is a colon — true for all six of our
 * `compose.templates.replyIntro*` variants (`wrote:`, `писал(а):`, `a écrit :`,
 * `schrieb:`, `escribió:`, `ha scritto:`) and for other clients' equivalents.
 *
 * False positives cost the user nothing but scope: a line of their own ending
 * in a colon immediately above a quote is left out of the rewrite instead of
 * being rewritten. Text is never lost either way.
 */
function isAttributionLine(line: string): boolean {
  if (QUOTE_LINE_RE.test(line)) return false
  const s = line.trimEnd()
  if (s.trim().length === 0) return false
  return s.endsWith(':')
}

/**
 * Index of the first tail line, or `lines.length` when the draft is all the
 * user's own text. Scans top-down and stops at the first marker of any kind, so
 * the earliest boundary always wins (a signature above a quote makes both the
 * signature and the quote tail).
 */
function findTailStart(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (QUOTE_LINE_RE.test(line)) {
      // Pull the attribution line above the quote into the tail as well — it
      // names the correspondent and belongs to their message, not to the draft.
      if (i > 0 && isAttributionLine(lines[i - 1])) return i - 1
      return i
    }
    if (isForwardMarkerLine(line) || SIGNATURE_SEPARATOR_RE.test(line)) return i
  }
  return lines.length
}

/**
 * A draft body cut into three verbatim pieces. Concatenating them in order
 * reproduces the original body exactly.
 */
export type ComposeBodySplit = {
  /** Blank lines above the user's own text (layout only, never sent to a model). */
  lead: string
  /** The user's own text — the ONLY part an AI rewrite may see or replace. */
  own: string
  /** Quoted / forwarded / signature tail, plus the blank lines separating it. */
  tail: string
}

/**
 * Split `body` into `{ lead, own, tail }` with `lead + own + tail === body`.
 *
 * `own` is empty when the draft has nothing but a quote/forward/signature (for
 * example a fresh reply the user has not typed into yet, or a bottom-posted
 * reply — see the v1 limitation in the module docblock). Callers surface that
 * as a refusal instead of sending an empty prompt.
 */
export function splitComposeBody(body: string): ComposeBodySplit {
  const lines = body.split('\n')
  const tailStart = findTailStart(lines)
  if (tailStart >= lines.length) return { lead: '', own: body, tail: '' }

  // Blank lines directly above the boundary are the separator between the two
  // parts, not content: keep them out of the prompt and restore them verbatim.
  let ownEnd = tailStart
  while (ownEnd > 0 && lines[ownEnd - 1].trim() === '') ownEnd--
  // Same for blank lines at the very top of the draft.
  let ownStart = 0
  while (ownStart < ownEnd && lines[ownStart].trim() === '') ownStart++

  const leadLines = lines.slice(0, ownStart)
  const ownLines = lines.slice(ownStart, ownEnd)
  const tailLines = lines.slice(ownEnd)

  // The '\n' that glued two adjacent segments together belongs to exactly one
  // of them: to `lead` when it exists, otherwise to `tail`.
  const lead = leadLines.length > 0 ? `${leadLines.join('\n')}\n` : ''
  const own = ownLines.join('\n')
  const tail = tailLines.length > 0
    ? `${ownLines.length > 0 ? '\n' : ''}${tailLines.join('\n')}`
    : ''

  return { lead, own, tail }
}

/**
 * Rebuild a full draft body from `split`, substituting `own` for the user's own
 * part. `joinComposeBody(split, split.own)` is the identity on the original
 * body; with a rewritten `own` it is the "Replace" result — rewritten text in
 * place, quoted message and signature byte-identical.
 */
export function joinComposeBody(split: ComposeBodySplit, own: string): string {
  return `${split.lead}${own}${split.tail}`
}
