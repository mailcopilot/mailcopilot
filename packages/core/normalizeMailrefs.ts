/**
 * Normalize mailref:// URLs in AI markdown output so CommonMark can parse them.
 *
 * Two problems:
 * 1. Folder paths may contain spaces and brackets (e.g. `[Gmail]/Вся почта`)
 *    which break CommonMark link parsing: `[text](mailref://1/[Gmail]/Вся почта/37084)`
 *    → encode folder segments so the URL has no raw spaces/brackets.
 * 2. Models sometimes output bare `mailref://` URLs not wrapped in markdown link syntax
 *    → wrap them as `[email](url)`.
 *
 * The downstream markdown `<a>` handler in AiPanel already calls
 * `decodeURIComponent()` on the folder path, so encoded URLs work transparently.
 */
export function normalizeMailrefs(text: string): string {
  // Step 1: Encode problematic chars in mailref URLs inside existing markdown links.
  // Pattern: [link text](mailref://accountId/folder.../uid)
  let result = text.replace(
    // Both quantifiers are bounded: this runs on model output, and an unbounded `[^\]]*` / `.+?` is
    // quadratic on a text full of `[` (80 000 of them cost ~5 s of a thread, main process included).
    /\[([^[\]]{0,512})\]\((mailref:\/\/\d+\/.{1,1024}?\/\d+)\)/g,
    (_match, linkText: string, url: string) => {
      if (!/[\s[\]]/.test(url)) return `[${linkText}](${url})`
      const m = url.match(/^(mailref:\/\/\d+\/)(.+)\/(\d+)$/)
      if (!m) return `[${linkText}](${url})`
      const [, prefix, folder, uid] = m
      const encodedFolder = folder!.split('/').map((seg: string) => encodeURIComponent(seg)).join('/')
      return `[${linkText}](${prefix}${encodedFolder}/${uid})`
    }
  )

  // Step 2: Convert bare mailref:// URLs (not already inside a markdown link) to [email](url).
  result = result.replace(
    /(?<!\]\()(?<!\()mailref:\/\/\d+\/[^\s)\]]+/g,
    (url) => `[email](${url})`
  )
  // The same for a bare citation link (`mailref://c/<ticket>`, a fixed-width ticket). It must END there: at the end of
  // the text, at a space, or at sentence punctuation that is itself followed by a space or the end. Anything that goes
  // on (`...ab1`, `...ab.txt`, `...ab/x`) is a distorted link, and stays text: it is never repaired into a valid one.
  // Not where a markdown construct already holds it as a destination: `](` + optional spaces, `<...>` (an autolink or an
  // angle-bracket destination), or a reference definition `]: `.
  result = result.replace(
    /(?<!\]\(\s*)(?<!<)(?<!\]:\s*)mailref:\/\/c\/[a-z2-7]{8}(?=$|\s|[.,;:!?)\]}>"'«»]+(?:\s|$))/g,
    (url) => `[email](${url})`
  )

  return result
}

/** Longest model text `extractMailrefTargets` reads; links beyond it are not citations. */
export const MAILREF_SCAN_MAX_CHARS = 200_000

/** The message a `mailref://` link points at. */
export interface MailrefTarget { accountId: number; folder: string; uid: number }

/** Identity of a message reference; the one key renderer and main compare confirmed sources by. */
export function mailrefKey(ref: MailrefTarget): string {
  return JSON.stringify([ref.accountId, ref.folder, ref.uid])
}

const isPositiveInt = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/**
 * Parse `mailref://accountId/folder/uid`. The folder may itself contain slashes
 * (first slash ends the account id, last slash starts the uid) and is
 * percent-decoded. `null` for anything that is not a well-formed reference.
 */
export function parseMailrefHref(href: string | undefined | null): MailrefTarget | null {
  if (typeof href !== 'string' || !href.startsWith('mailref://')) return null
  const path = href.slice('mailref://'.length)
  const firstSlash = path.indexOf('/')
  const lastSlash = path.lastIndexOf('/')
  if (firstSlash <= 0 || lastSlash <= firstSlash) return null
  const idText = path.slice(0, firstSlash)
  const uidText = path.slice(lastSlash + 1)
  if (!/^\d+$/.test(idText) || !/^\d+$/.test(uidText)) return null
  let folder: string
  try { folder = decodeURIComponent(path.slice(firstSlash + 1, lastSlash)) } catch { return null }
  const accountId = Number(idText)
  const uid = Number(uidText)
  if (!folder.trim() || !isPositiveInt(accountId) || !isPositiveInt(uid)) return null
  return { accountId, folder, uid }
}

/**
 * Every `mailref://` target a piece of assistant text points at, in order of
 * first appearance, deduplicated. The text goes through the same normalisation
 * the renderer applies before it renders links, so a link that is clickable
 * on screen is also found here.
 */
export function extractMailrefTargets(text: string): MailrefTarget[] {
  const out: MailrefTarget[] = []
  const seen = new Set<string>()
  // The limit belongs to the function, not to its callers: model output has no size bound of its own.
  let head = text
  if (text.length > MAILREF_SCAN_MAX_CHARS) {
    // Cut back to the last delimiter so a link straddling the limit is dropped, not read with a shortened uid.
    head = text.slice(0, MAILREF_SCAN_MAX_CHARS)
    const k = Math.max(head.lastIndexOf(')'), head.lastIndexOf(']'), head.lastIndexOf(' '), head.lastIndexOf('\n'))
    if (k > 0) head = head.slice(0, k + 1)
  }
  const normalized = normalizeMailrefs(head)
  const rx = /mailref:\/\/[^\s)\]]+/g
  let match: RegExpExecArray | null
  while ((match = rx.exec(normalized)) !== null) {
    const target = parseMailrefHref(match[0])
    if (!target) continue
    const key = mailrefKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}
