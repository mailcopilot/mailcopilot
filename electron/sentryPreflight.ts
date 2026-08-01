// Lightweight preflight read of the persisted telemetry consent state.
//
// Rationale: the persisted state must be known BEFORE initSentry() runs so
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
// looks at `parsed.settings` and hands it to `isTelemetryAllowed`.
//
// Fail policy (§2.82 — uniformly fail-CLOSED, no exceptions):
//   Every branch that cannot positively prove an active consent for the
//   current disclosure version returns **false**: file absent (brand-new
//   install — nobody has been asked yet), file unreadable, empty, truncated,
//   malformed JSON, or `app.getPath` throwing. Before §2.82 the "absent" and
//   "cannot resolve the path" branches returned true, which meant a first
//   launch started shipping envelopes before the user had ever been asked —
//   exactly what ePrivacy art. 5(3) forbids. There is no longer any asymmetry
//   to reason about: unknown means silent.
//
// This function answers "may we send", not "did the user opt out". The
// consent record itself is written by electron/services/telemetryConsentService.ts.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isTelemetryAllowed } from './telemetryConsent'

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
    // Can't resolve userData — nothing to read, so no consent can be proven.
    // Fail CLOSED (§2.82 AC1).
    return false
  }

  const filePath = path.join(dataDir, 'settings.json')
  // First write hasn't happened — brand-new install, nobody has been asked
  // yet. Fail CLOSED: the consent screen will run and decide (§2.82 AC1).
  if (!fs.existsSync(filePath)) return false

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    // File exists but is unreadable (permissions, broken symlink,
    // mid-rotation). Fail CLOSED — we cannot see a consent record, so there
    // is none as far as this process is concerned.
    return false
  }

  // Strip UTF-8 BOM if present — JSON.parse does not tolerate it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  // Truncated/partial write snapshot — rare but possible if the preflight
  // races a conf fallback to non-atomic writeFileSync (cross-device rename).
  if (!raw.trim()) return false

  try {
    const parsed = JSON.parse(raw) as {
      settings?: { sentryEnabled?: unknown; telemetryConsent?: unknown }
    }
    // Single source of truth for the decision — see electron/telemetryConsent.ts.
    // Requires an active grant for the CURRENT disclosure version AND the
    // Settings → About switch not being off.
    return isTelemetryAllowed(parsed?.settings)
  } catch {
    // Malformed JSON on a file that DOES exist — same reasoning as the
    // read-error branch: prefer fail-closed over silent leakage.
    return false
  }
}
