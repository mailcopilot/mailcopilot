import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `packages/net/config` transitively reaches `packages/db`, which opens SQLite
// at module load (fatal under the Electron-ABI build). Only `deleteAccountData`
// is used from there by config.ts; the schemas below stay REAL, because the
// point of this suite is what the handler's own schema accepts.
vi.mock('../packages/db', () => ({ deleteAccountData: vi.fn() }))

import { imapTestSchema, smtpTestSchema, parseNetTestConfig } from './netTestConfig'

/**
 * A certificate BODY (`tlsPinnedCertsPem`) is what mints a TLS trust anchor
 * (packages/net/tls.ts): anchored leaves skip the hostname check. Bodies come
 * only from `net:trustCert` after a native dialog, so the connection-test
 * channels must not be able to carry one. These tests pin both layers plus the
 * main.ts call sites — swapping the handlers back to the full account schemas
 * turns the source-mirror case red.
 */
describe('net:testImap / net:testSmtp config narrowing', () => {
  const base = { host: 'mail.example.com', port: 993, secure: true, user: 'u', pass: 'p' }
  const pins = ['AA:BB']

  it('refuses a payload that carries a certificate body', () => {
    for (const schema of [imapTestSchema, smtpTestSchema]) {
      expect(() => parseNetTestConfig(schema, {
        ...base, tlsPinsSha256: pins, tlsPinnedCertsPem: ['-----BEGIN CERTIFICATE-----'],
      })).toThrow('cert_body_not_accepted')
    }
  })

  it('cannot carry a certificate body even if the refusal guard is bypassed', () => {
    for (const schema of [imapTestSchema, smtpTestSchema]) {
      const parsed = schema.parse({
        ...base, tlsPinsSha256: pins, tlsPinnedCertsPem: ['-----BEGIN CERTIFICATE-----'],
      }) as Record<string, unknown>
      expect('tlsPinnedCertsPem' in parsed).toBe(false)
    }
  })

  it('passes fingerprint-only pins through untouched', () => {
    for (const schema of [imapTestSchema, smtpTestSchema]) {
      const parsed = parseNetTestConfig(schema, { ...base, tlsPinsSha256: pins })
      expect(parsed).toMatchObject({ host: base.host, port: base.port, tlsPinsSha256: pins })
    }
  })

  it('main.ts parses these channels through the narrowed schemas', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    expect(src).toContain('parseNetTestConfig(imapTestSchema, cfg)')
    expect(src).toContain('parseNetTestConfig(smtpTestSchema, cfg)')
    // The full account schemas must not be reachable from main.ts any more.
    expect(src).not.toMatch(/\b(imapSchema|smtpSchema)\b/)
  })
})
