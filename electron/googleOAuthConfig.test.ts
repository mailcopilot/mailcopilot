import { describe, it, expect, afterEach } from 'vitest'
import {
  GOOGLE_OAUTH_UNCONFIGURED_MESSAGE,
  getGoogleOAuthCredentials,
  isGoogleOAuthConfigured,
  requireGoogleOAuthCredentials,
  resolveGoogleOAuthCredentials,
} from './googleOAuthConfig'

// All fixtures are deliberately fake — no real credential may appear in the
// tree, that is the whole point of this module.
const FAKE_ENV_ID = 'env-client-id.apps.googleusercontent.com'
const FAKE_ENV_SECRET = 'env-client-secret'
const FAKE_BUILT_IN_ID = 'built-in-client-id.apps.googleusercontent.com'
const FAKE_BUILT_IN_SECRET = 'built-in-client-secret'

const ENV_KEYS = ['MAILCOPILOT_GOOGLE_CLIENT_ID', 'MAILCOPILOT_GOOGLE_CLIENT_SECRET'] as const

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => {
  setEnv({})
})

describe('resolveGoogleOAuthCredentials', () => {
  it('prefers the environment over the build-time value', () => {
    expect(resolveGoogleOAuthCredentials({
      envClientId: FAKE_ENV_ID,
      envClientSecret: FAKE_ENV_SECRET,
      builtInClientId: FAKE_BUILT_IN_ID,
      builtInClientSecret: FAKE_BUILT_IN_SECRET,
    })).toEqual({ clientId: FAKE_ENV_ID, clientSecret: FAKE_ENV_SECRET })
  })

  it('falls back to the build-time value when the environment is unset', () => {
    expect(resolveGoogleOAuthCredentials({
      builtInClientId: FAKE_BUILT_IN_ID,
      builtInClientSecret: FAKE_BUILT_IN_SECRET,
    })).toEqual({ clientId: FAKE_BUILT_IN_ID, clientSecret: FAKE_BUILT_IN_SECRET })
  })

  it('treats a blank environment value as unset rather than as an override', () => {
    expect(resolveGoogleOAuthCredentials({
      envClientId: '   ',
      envClientSecret: '',
      builtInClientId: FAKE_BUILT_IN_ID,
      builtInClientSecret: FAKE_BUILT_IN_SECRET,
    })).toEqual({ clientId: FAKE_BUILT_IN_ID, clientSecret: FAKE_BUILT_IN_SECRET })
  })

  it('trims surrounding whitespace', () => {
    expect(resolveGoogleOAuthCredentials({
      envClientId: `  ${FAKE_ENV_ID}\n`,
      envClientSecret: ` ${FAKE_ENV_SECRET} `,
    })).toEqual({ clientId: FAKE_ENV_ID, clientSecret: FAKE_ENV_SECRET })
  })

  it('resolves an id/secret pair coming from different sources', () => {
    expect(resolveGoogleOAuthCredentials({
      envClientId: FAKE_ENV_ID,
      builtInClientSecret: FAKE_BUILT_IN_SECRET,
    })).toEqual({ clientId: FAKE_ENV_ID, clientSecret: FAKE_BUILT_IN_SECRET })
  })

  it('allows a secret-less (public PKCE) client', () => {
    expect(resolveGoogleOAuthCredentials({ envClientId: FAKE_ENV_ID }))
      .toEqual({ clientId: FAKE_ENV_ID, clientSecret: '' })
  })

  it('returns null when no client id is available anywhere', () => {
    expect(resolveGoogleOAuthCredentials({})).toBeNull()
    expect(resolveGoogleOAuthCredentials({ envClientSecret: FAKE_ENV_SECRET })).toBeNull()
    expect(resolveGoogleOAuthCredentials({ builtInClientSecret: FAKE_BUILT_IN_SECRET })).toBeNull()
  })
})

describe('getGoogleOAuthCredentials / isGoogleOAuthConfigured', () => {
  // Under vitest the `define` substitution does not happen, so the built-in
  // values are empty — this doubles as the "build without credentials" case.
  it('is unconfigured when neither environment nor build supplies an id', () => {
    setEnv({})
    expect(getGoogleOAuthCredentials()).toBeNull()
    expect(isGoogleOAuthConfigured()).toBe(false)
  })

  it('reads the environment on every call, not once at module load', () => {
    setEnv({ MAILCOPILOT_GOOGLE_CLIENT_ID: FAKE_ENV_ID, MAILCOPILOT_GOOGLE_CLIENT_SECRET: FAKE_ENV_SECRET })
    expect(getGoogleOAuthCredentials()).toEqual({ clientId: FAKE_ENV_ID, clientSecret: FAKE_ENV_SECRET })
    expect(isGoogleOAuthConfigured()).toBe(true)

    setEnv({})
    expect(getGoogleOAuthCredentials()).toBeNull()
  })
})

describe('requireGoogleOAuthCredentials', () => {
  it('throws an actionable message when the build has no credentials', () => {
    setEnv({})
    expect(() => requireGoogleOAuthCredentials()).toThrow(GOOGLE_OAUTH_UNCONFIGURED_MESSAGE)
    // The message must point the user at the fix, not just state a failure.
    expect(GOOGLE_OAUTH_UNCONFIGURED_MESSAGE).toMatch(/Desktop app/)
    expect(GOOGLE_OAUTH_UNCONFIGURED_MESSAGE).toMatch(/MAILCOPILOT_GOOGLE_CLIENT_ID/)
    expect(GOOGLE_OAUTH_UNCONFIGURED_MESSAGE).toMatch(/README/)
  })

  it('returns the credentials when configured', () => {
    setEnv({ MAILCOPILOT_GOOGLE_CLIENT_ID: FAKE_ENV_ID, MAILCOPILOT_GOOGLE_CLIENT_SECRET: FAKE_ENV_SECRET })
    expect(requireGoogleOAuthCredentials()).toEqual({ clientId: FAKE_ENV_ID, clientSecret: FAKE_ENV_SECRET })
  })
})
