// MAILCOPILOT_OFFICIAL_BUILD (BACKLOG §2.297): official builds do not connect
// NEW mailboxes through Google sign-in, because Google's lifetime cap on new
// users of an unverified app cannot be reset. Release pipelines set the
// variable; a self-build leaves it unset and keeps the sign-in.
//
// One parser for `vite.config.ts` (which bakes the flag) and for the refusal
// below, so the two cannot read the same value differently. A value that is
// set but not understood (`on`, `y`) must stop the build: reading it as "unset"
// would ship a release with the sign-in open, and that cannot be undone.
import { classifyBuildTier } from './check-release-vars.mjs'

const OFFICIAL = new Set(['1', 'true', 'yes'])
const SELF_BUILD = new Set(['', '0', 'false', 'no'])

/** `official` | `self` | `invalid`. */
export function parseOfficialBuildFlag(raw) {
  const value = (raw || '').trim().toLowerCase()
  if (OFFICIAL.has(value)) return 'official'
  if (SELF_BUILD.has(value)) return 'self'
  return 'invalid'
}

/**
 * Throws when the flag cannot be trusted for this build: any unrecognised
 * value, or (when `enforceRelease`, i.e. a production bundle) a release tag
 * built without the flag. Returns whether new Google mailboxes are allowed in
 * the build (`true` for a self-build).
 */
export function resolveNewGoogleMailboxes(env, { enforceRelease = true } = {}) {
  const parsed = parseOfficialBuildFlag(env.MAILCOPILOT_OFFICIAL_BUILD)
  if (parsed === 'invalid') {
    throw new Error(
      `MAILCOPILOT_OFFICIAL_BUILD="${env.MAILCOPILOT_OFFICIAL_BUILD}" is not understood. Use 1 for an official build or leave it unset.`,
    )
  }
  if (parsed === 'self' && enforceRelease && classifyBuildTier(env) === 'release') {
    throw new Error(
      'A release build must set MAILCOPILOT_OFFICIAL_BUILD=1: without it the shipped app would connect new mailboxes through Google sign-in and spend a cap that cannot be reset.',
    )
  }
  return parsed === 'self'
}
