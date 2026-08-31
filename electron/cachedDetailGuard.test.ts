import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { MessageDetails } from '../packages/net/types'
import { SERVER_DIRECT_MAX_BODY_BYTES } from '../packages/net/limits'
import {
  isServableCachedDetail,
  isServableCachedDetailJson,
  MAX_CACHED_DETAIL_JSON_CHARS,
  MAX_LEGITIMATE_CACHED_BODY_BYTES,
} from './cachedDetailGuard'

/**
 * §2.145 fix wave 1.2 — the guard screens PATHOLOGY, it does not enforce the
 * EML soft cap on the cache.
 *
 * The wave-1.1 version judged every cap-less row by the EML path's 1 MiB cap,
 * and the cache has a second, equally legitimate writer: the server-direct path
 * (`fetchMessageDetails`, packages/net/message.ts) fetches html and text at
 * `MAX_BODY_BYTES` = 5 MiB each and writes them WITHOUT a `parseCap`, because
 * no parse cap tripped. Every such body over 1 MiB was refused on every reopen
 * — online that meant a network refetch that rewrote a row which would be
 * refused again (no self-healing, since the rewrite is cap-less and the same
 * size); offline it meant throwing away a good cached body for header facts.
 *
 * These tests are behavioural against real row shapes rather than source
 * mirrors: the predicates were extracted from main.ts precisely so the
 * threshold could be stated as an executable claim.
 */

/** A row as the server-direct path writes it: real body, no `parseCap`. */
function serverDirectRow(bodyBytes: number, field: 'html' | 'text' = 'html'): MessageDetails {
  return {
    uid: 1,
    envelope: { subject: 'server-direct' },
    [field]: 'x'.repeat(bodyBytes),
  }
}

describe('§2.145 — cap-less rows are judged by what a legitimate writer can emit', () => {
  // THE REGRESSION, inverted. Wave 1.1 refused this row; it is ordinary output
  // of the server-direct path and must be served.
  it('serves a cap-less row with a server-direct-sized body', () => {
    expect(isServableCachedDetail(serverDirectRow(3 * 1024 * 1024))).toBe(true)
    expect(isServableCachedDetail(serverDirectRow(3 * 1024 * 1024, 'text'))).toBe(true)
  })

  it('serves a cap-less row at the exact server-direct ceiling', () => {
    expect(isServableCachedDetail(serverDirectRow(MAX_LEGITIMATE_CACHED_BODY_BYTES))).toBe(true)
  })

  it('serves a cap-less row carrying BOTH representations at the ceiling', () => {
    // html and text are alternatives and are bounded independently by the
    // fetch path, so a row holding both at the ceiling is legitimate.
    const row: MessageDetails = {
      uid: 1,
      html: 'x'.repeat(MAX_LEGITIMATE_CACHED_BODY_BYTES),
      text: 'y'.repeat(MAX_LEGITIMATE_CACHED_BODY_BYTES),
    }
    expect(isServableCachedDetail(row)).toBe(true)
  })

  // The pathology the guard exists for: no current writer can emit this, so it
  // can only be a row from before the caps existed.
  it('refuses a cap-less row no current writer could have produced', () => {
    expect(isServableCachedDetail(serverDirectRow(MAX_LEGITIMATE_CACHED_BODY_BYTES + 1))).toBe(false)
    expect(isServableCachedDetail(serverDirectRow(12 * 1024 * 1024))).toBe(false)
  })

  // Mutation killed: measuring only `html`. A 50 MB body in `text` is the same
  // pathology and used to be waved through by a one-field check.
  it('measures both representations, not just the commoner one', () => {
    expect(isServableCachedDetail(serverDirectRow(12 * 1024 * 1024, 'text'))).toBe(false)
  })

  // Mutation killed: measuring `String.length`. A multi-byte body of N
  // characters is up to 4N bytes, so a code-unit check would admit up to four
  // times the intended size.
  it('measures bytes, not UTF-16 code units', () => {
    // Just under the ceiling in code units, well over it in bytes.
    const chars = MAX_LEGITIMATE_CACHED_BODY_BYTES - 1
    const row: MessageDetails = { uid: 1, text: 'д'.repeat(chars) }
    expect(row.text!.length).toBeLessThan(MAX_LEGITIMATE_CACHED_BODY_BYTES)
    expect(isServableCachedDetail(row)).toBe(false)
  })

  it('accepts a capped row by shape, without measuring it', () => {
    // A row from the capped pipeline is bounded by construction. Its body is
    // small here; the point is that the decision does not depend on that.
    const row: MessageDetails = {
      uid: 1,
      text: 'clipped',
      parseCap: { kind: 'soft', rawBytes: 2e6, limitBytes: 1e6, canShowFull: true },
    }
    expect(isServableCachedDetail(row)).toBe(true)
  })

  it('serves an ordinary small row and one with no body at all', () => {
    expect(isServableCachedDetail({ uid: 1, text: 'hello' })).toBe(true)
    expect(isServableCachedDetail({ uid: 1, envelope: { subject: 'headers only' } })).toBe(true)
  })
})

describe('§2.145 — the serialized gate admits every legitimate row', () => {
  /**
   * The worst-case construction the wave-1.1 bound (4x the EML soft cap) failed:
   * a row at the legitimate ceiling whose body is nothing but characters that
   * JSON escaping expands. Quotes and newlines cost two characters each, so
   * this row serializes to roughly twice its content — and it must pass,
   * because every byte of it is something the server-direct path can legally
   * hand us.
   */
  it('admits a maximum-size legitimate row whose body escapes heavily', () => {
    const body = '"\n'.repeat(MAX_LEGITIMATE_CACHED_BODY_BYTES / 2)
    const row: MessageDetails = { uid: 1, envelope: { subject: 'heavy escaping' }, html: body }
    const serialized = JSON.stringify(row)

    // The construction is doing what it claims: the serialized form really is
    // bigger than the body, or the test would prove nothing about escaping.
    expect(serialized.length).toBeGreaterThan(MAX_LEGITIMATE_CACHED_BODY_BYTES)
    expect(isServableCachedDetailJson(serialized)).toBe(true)
  })

  // The arithmetic worst case, stated as a claim rather than trusted: even if
  // EVERY character of both representations took the six-character `\u00XX`
  // form, a legitimate row still fits.
  it('admits the arithmetic worst case, not merely the plausible one', () => {
    const worstCaseContent = 2 * MAX_LEGITIMATE_CACHED_BODY_BYTES * 6
    expect(MAX_CACHED_DETAIL_JSON_CHARS).toBeGreaterThanOrEqual(worstCaseContent)
  })

  it('admits an ordinary row', () => {
    expect(isServableCachedDetailJson(JSON.stringify({ uid: 1, text: 'hello' }))).toBe(true)
  })

  /**
   * What this gate does and does not catch, pinned so the trade-off cannot be
   * misread later.
   *
   * A sound bound — one that never refuses a legitimate row — lands ABOVE the
   * legacy 50 MB pathology, because 10 MiB of legitimate content can escape to
   * 60 MiB. So the 50 MB monster is NOT stopped here; it is parsed once,
   * refused by the parsed-row gate, and then invalidated by the caller so it is
   * never parsed again. Any tighter bound would refuse a legitimate
   * heavy-escaping row FOREVER, which is the strictly worse failure.
   */
  it('does not stop the legacy 50 MB row — that is the parsed-row gate plus invalidation', () => {
    expect(isServableCachedDetailJson('x'.repeat(50 * 1024 * 1024))).toBe(true)
    // ...and the parsed-row gate is what refuses it.
    expect(isServableCachedDetail(serverDirectRow(50 * 1024 * 1024))).toBe(false)
  })

  // What the gate DOES still buy: the one-time parse can never be unbounded.
  it('refuses a row large enough to make even a single parse unbounded', () => {
    expect(isServableCachedDetailJson('x'.repeat(MAX_CACHED_DETAIL_JSON_CHARS + 1))).toBe(false)
    expect(isServableCachedDetailJson('x'.repeat(200 * 1024 * 1024))).toBe(false)
  })
})

describe('§2.145 — the thresholds track their sources', () => {
  /**
   * These are not tautologies: they are the written form of a cross-package
   * dependency the compiler cannot express. `MAX_LEGITIMATE_CACHED_BODY_BYTES`
   * mirrors `MAX_BODY_BYTES` inside `fetchMessageDetails`
   * (packages/net/message.ts). If that constant moves and this one does not,
   * the guard silently starts refusing legitimate rows again — the exact
   * regression of wave 1.1, in a new place.
   */
  // Wave 2.1, part one: equality with the SHARED constant rather than with a
  // hand-written literal. The old assertion (`toBe(5 * 1024 * 1024)`) compared
  // the mirror against its own copied value and so could never fail — including
  // in the one case it existed for, where the fetch bound moves and this does
  // not. This version fails the moment the two diverge in value.
  it('equals the server-direct fetch bound', () => {
    expect(MAX_LEGITIMATE_CACHED_BODY_BYTES).toBe(SERVER_DIRECT_MAX_BODY_BYTES)
  })

  // Wave 2.1, part two — and this one exists because part one is not enough.
  // Numbers have no reference identity in JS, so `toBe` cannot tell an imported
  // constant from a re-inlined literal that happens to match today. Verified by
  // mutation: replacing the import with `5 * 1024 * 1024` left the assertion
  // above green. The dependency is therefore also asserted structurally, which
  // is the form that actually catches somebody "simplifying" the import away.
  it('takes the bound by import, not by re-inlined literal', () => {
    const source = readFileSync(path.join(__dirname, 'cachedDetailGuard.ts'), 'utf8')
    expect(source).toContain("import { SERVER_DIRECT_MAX_BODY_BYTES } from '../packages/net/limits'")
    expect(source).toContain('export const MAX_LEGITIMATE_CACHED_BODY_BYTES = SERVER_DIRECT_MAX_BODY_BYTES')
    // No megabyte-shaped literal may define this ceiling here again.
    expect(source).not.toMatch(/MAX_LEGITIMATE_CACHED_BODY_BYTES\s*=\s*\d/)
  })

  it('is derived from the body bound, not chosen independently', () => {
    const metadataAllowance = MAX_CACHED_DETAIL_JSON_CHARS - 2 * MAX_LEGITIMATE_CACHED_BODY_BYTES * 6
    expect(metadataAllowance).toBe(1024 * 1024)
  })
})
