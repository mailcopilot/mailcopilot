/**
 * OS secret-store / keychain "backend unavailable" classifier.
 *
 * §2.33 (M3) — relocated here from electron/sentry.ts to become the single,
 * layer-pure source of truth for the predicate that decides whether a raw error
 * means "the OS secret store is missing or unresponsive" (Secret Service down,
 * libsecret/keytar unable to reach the daemon, macOS Keychain access error) — as
 * opposed to an ordinary transient network blip.
 *
 * Consumers:
 *   - electron/sentry.ts — re-exports `isKeychainUnavailableError` for
 *     back-compat (callers that already hold a raw error and want to label it).
 *   - electron/services/secretStore.ts (§2.33) — classifies a keytar failure to
 *     decide whether to activate the machine-bound AES-256-GCM disk fallback.
 *
 * §2.33 (dbus-disabled) — the predicate now covers TWO distinct failure classes,
 * kept as two separately-named regexes so the concerns stay visually and
 * semantically distinct:
 *   1. KEYCHAIN_UNAVAILABLE_RE     — a specific secret-service backend is down
 *      (Secret Service / libsecret / gnome-keyring / kwallet / SecKeychain).
 *   2. DBUS_SESSION_UNAVAILABLE_RE — the whole D-Bus SESSION BUS is unavailable
 *      (transport 'disabled:', no autolaunch on headless, NoServer). Because
 *      every Linux secret service rides the session bus, a session-bus-down
 *      condition NECESSARILY takes the secret service down with it, so it too
 *      means "OS secret store unavailable" and must trigger the disk fallback.
 *
 * SECURITY NOTE (§2.33 + §2.34 review): broadening the DETECTOR is safe. This
 * predicate is NOT consulted by Sentry's `beforeSend` for send/keep decisions —
 * that path is PROVENANCE-based (our own `tags.category === 'keychain_unavailable'`
 * / `extra.source === 'keychain.read'` markers, see electron/sentry.ts around the
 * re-export at line 18 and the beforeSend body), never content-based. A crafted
 * error message containing one of these new substrings therefore cannot smuggle
 * an unrelated (possibly PII-bearing) event past the transient/installer noise
 * filters. The only effect of a match is: secretStore falls back to the
 * encrypted disk store instead of hard-failing.
 *
 * Pure, side-effect-free, no Node/Electron/Sentry dependency (lives in
 * @mailcopilot/core so both the main process and any future layer can share it
 * without pulling @sentry/node into their graph).
 */

// §2.33 (M1) — Why this pattern is intentionally BROAD and CROSS-PLATFORM.
//
// "OS secret store unavailable" surfaces with completely different backend
// strings depending on the platform and desktop environment, and keytar wraps
// whichever one is active underneath. We must recognise the canonical marker of
// EVERY backend keytar can sit on, because the same root cause ("no reachable
// secret service") presents as wildly different text:
//   - Linux / GNOME:  'org.freedesktop.secrets' (the D-Bus interface),
//                     'Secret Service' / 'SecretService', 'libsecret',
//                     'gnome-keyring'
//   - Linux / KDE:    'kwallet'
//   - macOS:          'SecKeychain'
// Narrowing the regex to a single platform would silently miss the others and
// leave those installs in the pre-§2.34 "invisible failure" state — the exact
// problem the keychain-observability work set out to fix.
//
// Why the bare D-Bus method name ('StartServiceByName') is deliberately NOT
// matched on its own: the reported incident message is
//   "Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached"
// We anchor ONLY on the `org.freedesktop.secrets` association, never on
// 'StartServiceByName' alone — an activation timeout for a DIFFERENT D-Bus
// service (e.g. `org.freedesktop.Notifications`) must NOT be classified as a
// keychain failure. This keeps the predicate specific to the secret store while
// still spanning every backend keytar might use.
//
// SECURITY NOTE (§2.34 review, preserved): this predicate is a side-effect-free
// DETECTOR. It is NOT consulted by Sentry's `beforeSend` to decide send/keep —
// that path is provenance-based (our own `tags.category` / `extra.source`
// markers) — so a crafted error message containing one of these substrings can
// no longer smuggle an unrelated (possibly PII-bearing) event past the
// transient/installer noise filters. See electron/sentry.ts `beforeSend`.
export const KEYCHAIN_UNAVAILABLE_RE =
  /org\.freedesktop\.secrets|Secret Service|SecretService|libsecret|gnome-keyring|kwallet|SecKeychain/i

// §2.33 (dbus-disabled) — the D-Bus SESSION BUS is unavailable, which is a
// SUPERSET failure of the per-service class above: on Linux the secret service
// (org.freedesktop.secrets) is reached over the session bus, so if the bus
// itself is down / disabled / cannot be autolaunched, keytar→libsecret can
// never reach ANY secret service. This is a bus-WIDE fatal condition and
// therefore belongs in the keychain-unavailable class.
//
// Confirmed CI marker (pipeline 2293): on managed Linux / CI without a session
// bus the bus address is `disabled:`, and libdbus throws exactly
//   "Unknown or unsupported transport 'disabled' for address 'disabled:'"
// which the previous secret-service-only regex did NOT match, so
// secretStore.probeKeytar took the hard-fail branch and ai:saveApiKey threw —
// the exact §2.33 degradation this fallback exists to prevent.
//
// Each alternation, with its reason (no cargo-cult broadening):
//   - `Unknown or unsupported transport`  — libdbus rejecting the bus address
//     scheme; the confirmed CI marker (covers the `'disabled'` transport).
//   - `disabled:`                          — the disabled bus-address form
//     itself (matches when the address, not the transport phrase, is quoted).
//   - `Cannot autolaunch D-Bus` / `autolaunch a dbus-daemon` / `without a
//     $DISPLAY` — no running bus and headless autolaunch is impossible.
//   - `org.freedesktop.DBus.Error.NoServer` — canonical D-Bus "no bus running".
//   - `Failed to connect to (the )?(D-Bus )?session bus` / `session bus socket`
//     — the connect-to-bus-socket failure form.
//
// CRITICAL specificity — why this is NOT the same over-broadening the file
// warns against for `StartServiceByName`: an activation timeout for a DIFFERENT
// service (e.g. org.freedesktop.Notifications) is a per-SERVICE fault that says
// nothing about the secret store, so it must NOT be classified (and is not —
// see KEYCHAIN_UNAVAILABLE_RE's rationale above). By contrast a session-bus-DOWN
// / transport-disabled condition is bus-WIDE and necessarily kills the secret
// service too. Service-specific activation failure ≠ session-bus-wide
// unavailability. Only the latter is matched here.
export const DBUS_SESSION_UNAVAILABLE_RE =
  /Unknown or unsupported transport|disabled:|Cannot autolaunch D-Bus|autolaunch a dbus-daemon|without a \$DISPLAY|org\.freedesktop\.DBus\.Error\.NoServer|Failed to connect to (?:the )?(?:D-Bus )?session bus|session bus socket/i

// Max recursion depth when walking a wrapped error's `cause` chain. Bounded to
// defend against cyclic / adversarially-deep cause references.
const MAX_CAUSE_DEPTH = 3

function extractKeychainText(input: unknown, depth = 0): string {
  if (input == null || depth > MAX_CAUSE_DEPTH) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object') {
    const obj = input as { message?: unknown; code?: unknown; cause?: unknown }
    const parts: string[] = []
    if (typeof obj.message === 'string') parts.push(obj.message)
    if (typeof obj.code === 'string') parts.push(obj.code)
    if (obj.cause !== undefined && obj.cause !== obj) parts.push(extractKeychainText(obj.cause, depth + 1))
    return parts.join(' ')
  }
  return ''
}

/**
 * True when `input` looks like an OS secret-store/keychain backend failure —
 * either a specific secret-service backend being down (Secret Service /
 * libsecret / gnome-keyring / kwallet / macOS Keychain) OR the whole D-Bus
 * session bus being unavailable (transport disabled / no autolaunch / NoServer),
 * which on Linux necessarily takes the secret service down with it. Pure,
 * side-effect-free. Accepts a string, Error, or any unknown payload and walks a
 * bounded `err.cause` chain.
 */
export function isKeychainUnavailableError(input: unknown): boolean {
  const text = extractKeychainText(input)
  if (!text) return false
  return KEYCHAIN_UNAVAILABLE_RE.test(text) || DBUS_SESSION_UNAVAILABLE_RE.test(text)
}
