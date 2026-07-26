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
    /\[([^\]]*)\]\((mailref:\/\/\d+\/.+?\/\d+)\)/g,
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

  return result
}
