import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseOfficialBuildFlag, resolveNewGoogleMailboxes } from './officialBuildFlag.mjs'

// §2.297 — the parser behind `__GOOGLE_NEW_MAILBOXES__`. Every env below is an
// explicit plain object: the real process.env (CI_COMMIT_TAG, CI, ...) must
// never leak into a verdict.
const RELEASE_ENV = { CI: 'true', GITLAB_CI: 'true', CI_COMMIT_TAG: 'v1.26.1' }

describe('parseOfficialBuildFlag', () => {
  const table = [
    ['1', 'official'],
    ['true', 'official'],
    ['YES', 'official'],
    [' True ', 'official'],
    ['', 'self'],
    [undefined, 'self'],
    ['0', 'self'],
    ['false', 'self'],
    ['no', 'self'],
    ['   ', 'self'],
    ['on', 'invalid'],
    ['y', 'invalid'],
    ['2', 'invalid'],
    ['enabled', 'invalid'],
  ]
  for (const [raw, expected] of table) {
    test(`${JSON.stringify(raw)} -> ${expected}`, () => {
      assert.equal(parseOfficialBuildFlag(raw), expected)
    })
  }
})

describe('resolveNewGoogleMailboxes', () => {
  test('a self-build outside a release keeps new Google mailboxes open', () => {
    assert.equal(resolveNewGoogleMailboxes({}), true)
    assert.equal(resolveNewGoogleMailboxes({ MAILCOPILOT_OFFICIAL_BUILD: '0' }), true)
  })

  test('an official build closes them', () => {
    assert.equal(resolveNewGoogleMailboxes({ MAILCOPILOT_OFFICIAL_BUILD: '1' }), false)
    assert.equal(resolveNewGoogleMailboxes({ MAILCOPILOT_OFFICIAL_BUILD: 'true' }), false)
  })

  test('throws on a value that is set but not understood', () => {
    assert.throws(
      () => resolveNewGoogleMailboxes({ MAILCOPILOT_OFFICIAL_BUILD: 'on' }),
      /not understood/,
    )
  })

  test('throws on an invalid value even when the release check is off', () => {
    assert.throws(
      () => resolveNewGoogleMailboxes({ MAILCOPILOT_OFFICIAL_BUILD: 'y' }, { enforceRelease: false }),
      /not understood/,
    )
  })

  test('throws when a release tag is built with the flag unset', () => {
    assert.throws(() => resolveNewGoogleMailboxes({ ...RELEASE_ENV }), /release build must set/)
  })

  test('throws when a release tag is built with the flag explicitly off', () => {
    assert.throws(
      () => resolveNewGoogleMailboxes({ ...RELEASE_ENV, MAILCOPILOT_OFFICIAL_BUILD: '0' }),
      /release build must set/,
    )
  })

  test('enforceRelease defaults to true', () => {
    assert.throws(() => resolveNewGoogleMailboxes({ ...RELEASE_ENV }, {}))
  })

  test('does not throw for the same release env when enforceRelease is false (non-production bundle)', () => {
    assert.equal(resolveNewGoogleMailboxes({ ...RELEASE_ENV }, { enforceRelease: false }), true)
  })

  test('does not throw for a release tag with the flag set to 1', () => {
    assert.equal(resolveNewGoogleMailboxes({ ...RELEASE_ENV, MAILCOPILOT_OFFICIAL_BUILD: '1' }), false)
  })

  test('a non-release CI build with the flag unset stays open', () => {
    assert.equal(resolveNewGoogleMailboxes({ CI: 'true', GITLAB_CI: 'true', CI_COMMIT_REF_NAME: 'develop' }), true)
  })

  test('a tag that is not vX.Y.Z is not a release', () => {
    assert.equal(resolveNewGoogleMailboxes({ CI: 'true', CI_COMMIT_TAG: 'nightly-2026' }), true)
  })
})
