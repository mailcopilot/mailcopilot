import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sha256hex, getGravatarUrl, precomputeGravatarHash, markGravatarNotFound, clearGravatarCache } from './gravatar'

beforeEach(() => {
  clearGravatarCache()
})

describe('sha256hex', () => {
  it('returns a correct SHA-256 hash', async () => {
    // Known hash for an empty string
    const hash = await sha256hex('')
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('returns lowercase hex', async () => {
    const hash = await sha256hex('test@example.com')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('getGravatarUrl', () => {
  it('returns null for an empty email', () => {
    expect(getGravatarUrl('')).toBeNull()
    expect(getGravatarUrl('  ')).toBeNull()
  })

  it('returns null when URL is not cached', () => {
    expect(getGravatarUrl('user@example.com')).toBeNull()
  })

  it('returns URL after caching via precompute', async () => {
    const onReady = vi.fn()
    precomputeGravatarHash('user@example.com', 72, onReady)
    // Wait for async operation
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    const url = getGravatarUrl('user@example.com')
    expect(url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?d=404&s=72$/)
  })

  it('normalizes email (trim + lowercase)', async () => {
    const onReady = vi.fn()
    precomputeGravatarHash('  User@Example.COM  ', 72, onReady)
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    // Request with different casing/whitespace should return the same URL
    expect(getGravatarUrl('user@example.com')).not.toBeNull()
    expect(getGravatarUrl('  USER@EXAMPLE.COM  ')).not.toBeNull()
  })
})

describe('precomputeGravatarHash', () => {
  it('calls onReady after computing the hash', async () => {
    const onReady = vi.fn()
    precomputeGravatarHash('a@b.com', 72, onReady)
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  it('is idempotent — repeated call does not duplicate the request', async () => {
    const onReady1 = vi.fn()
    const onReady2 = vi.fn()
    precomputeGravatarHash('dup@test.com', 72, onReady1)
    precomputeGravatarHash('dup@test.com', 72, onReady2)
    await vi.waitFor(() => expect(onReady1).toHaveBeenCalled())
    // Second callback should not be called (request is deduplicated)
    expect(onReady2).not.toHaveBeenCalled()
  })

  it('ignores empty email', () => {
    const onReady = vi.fn()
    precomputeGravatarHash('', 72, onReady)
    expect(onReady).not.toHaveBeenCalled()
  })
})

describe('markGravatarNotFound', () => {
  it('marks email as having no Gravatar', async () => {
    const onReady = vi.fn()
    precomputeGravatarHash('nf@test.com', 72, onReady)
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(getGravatarUrl('nf@test.com')).not.toBeNull()

    markGravatarNotFound('nf@test.com')
    expect(getGravatarUrl('nf@test.com')).toBeNull()
  })

  it('ignores empty email', () => {
    markGravatarNotFound('')
    markGravatarNotFound('  ')
    // Should not throw an error
  })
})

describe('clearGravatarCache', () => {
  it('clears all entries', async () => {
    const onReady = vi.fn()
    precomputeGravatarHash('clear@test.com', 72, onReady)
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(getGravatarUrl('clear@test.com')).not.toBeNull()

    clearGravatarCache()
    expect(getGravatarUrl('clear@test.com')).toBeNull()
  })
})
