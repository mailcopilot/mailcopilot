// What an update request may carry besides what the library puts there itself.
//
// electron-updater issues every request (channel file, installer download,
// blockmap) through Electron's `net` module on one named session. Chromium's
// network stack adds the user's UI language as `Accept-Language` to such a
// request, so the feed would learn the language of every installation. The
// update check discloses an IP address and, through the file name, the OS and
// architecture; the language is not part of that promise, so it is removed here.
//
// The narrowest mechanism that works is a `webRequest` hook on the updater's own
// session: it sees only updater traffic (the app's windows and the mail/AI
// clients use other sessions or their own stacks), runs on every redirect hop,
// and touches nothing but the one header. `session.setUserAgent(ua, '')` also
// empties it, but it overrides the user agent for the whole session as well.
//
// `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: no-cors` and `Sec-Fetch-Dest: empty`
// are constants of Chromium's stack for a request with no initiating page; they
// carry nothing about the user and are left as they are.
import type { Session } from 'electron'

/**
 * The session electron-updater's `ElectronHttpExecutor` uses (`NET_SESSION_NAME`
 * in electron-updater/out/electronHttpExecutor.js, with `{ cache: false }`).
 * A contract test pins this to the library's own constant: a different name
 * would silently leave the real updater traffic untouched.
 */
export const UPDATER_SESSION_PARTITION = 'electron-updater'

/** Header names (lowercase) that must never leave on an updater request. */
const FORBIDDEN_UPDATER_HEADERS: ReadonlySet<string> = new Set(['accept-language'])

/** A copy of `headers` without the forbidden ones (names compared case-insensitively). */
export function stripUpdaterRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!FORBIDDEN_UPDATER_HEADERS.has(name.toLowerCase())) out[name] = value
  }
  return out
}

/**
 * Install the hook on `ses`. A failure inside the hook lets the request go out
 * unchanged: the update check must not break because of this.
 */
export function installUpdaterRequestPolicy(ses: Pick<Session, 'webRequest'>): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let requestHeaders: Record<string, string> | undefined
    try {
      requestHeaders = stripUpdaterRequestHeaders(details.requestHeaders)
    } catch {
      requestHeaders = undefined
    }
    // Exactly one answer either way; `{}` leaves the request as it was.
    callback(requestHeaders ? { requestHeaders } : {})
  })
}
