// Lightweight preflight read of the persisted sentryEnabled flag.
//
// Rationale: the persisted flag must be known BEFORE initSentry() runs so
// the SDK is initialized with the correct `enabled` state — session
// envelopes and any pre-settings throw bypass beforeSend, so the SDK's own
// flag is the only reliable kill switch. But we cannot call the regular
// getSettings() from packages/net/config for this, because that module
// imports packages/db (better-sqlite3 native binding), keytar, zod, and
// electron-store — pulling heavy native startup work in front of Sentry.
// If any of those imports throws during module load, Sentry is not yet
// initialized and the error is lost.
//
// Instead, we read the electron-store JSON file directly with fs + path,
// importing only `app` from electron (to resolve userData). The file is
// produced by `new Store({ name: 'settings' })` in packages/net/config.ts
// — electron-store's `name` option controls the **filename** (settings.json),
// not a wrapper key. The top-level object contains the store's schema
// keys directly: `accounts`, `account`, `settings`. `store.get('settings')`
// in config.ts reads the TOP-LEVEL `settings` object — so this preflight
// looks at `parsed.settings.sentryEnabled`.
//
// Fail policy (intentional asymmetry, prefers privacy over observability):
//   - File absent (brand-new install, user never opened Settings): return
//     true — defaults apply, no opt-out has been recorded yet.
//   - File exists but unreadable/empty/malformed: return **false**. We
//     cannot verify the user's preference, so we assume they may have
//     opted out and keep quiet. Silent loss of startup events is better
//     than silent leakage of a stable anonymous id from an opted-out user.
//   - app.getPath or env resolution throws: return true. Same reasoning as
//     "file absent" — we can't even find where the file would live, so
//     there's no plausible opt-out state to honor.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function readSentryEnabledPreflight(): boolean {
  // Honor MAILCOPILOT_DATA_DIR override up front — main.ts re-applies
  // app.setPath('userData', ...) later, but at this point in module
  // load that has not happened yet, so we resolve the env var
  // ourselves. Keep this in sync with the config.ts store options.
  let dataDir: string
  try {
    dataDir = process.env.MAILCOPILOT_DATA_DIR
      ? path.resolve(process.env.MAILCOPILOT_DATA_DIR)
      : app.getPath('userData')
  } catch {
    // Can't resolve userData — nothing to read. Fail-open: user hasn't
    // had a chance to opt out yet, defaults apply.
    return true
  }

  const filePath = path.join(dataDir, 'settings.json')
  // First write hasn't happened — brand-new install. Default-enabled.
  if (!fs.existsSync(filePath)) return true

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    // File exists but is unreadable (permissions, broken symlink,
    // mid-rotation). Fail CLOSED — assume the user may have opted out
    // and we just cannot see it. Surface is small because this path is
    // rare, and silent leakage is worse than silent loss.
    return false
  }

  // Strip UTF-8 BOM if present — JSON.parse does not tolerate it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  // Truncated/partial write snapshot — rare but possible if the preflight
  // races a conf fallback to non-atomic writeFileSync (cross-device rename).
  if (!raw.trim()) return false

  try {
    const parsed = JSON.parse(raw) as { settings?: { sentryEnabled?: unknown } }
    // Default-enabled: missing key or any non-false value → on.
    return parsed?.settings?.sentryEnabled !== false
  } catch {
    // Malformed JSON on a file that DOES exist — same reasoning as the
    // read-error branch: prefer fail-closed over silent leakage.
    return false
  }
}
