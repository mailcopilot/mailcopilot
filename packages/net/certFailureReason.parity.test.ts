import { describe, expect, it, vi } from 'vitest'
vi.mock('../db', () => ({}))
import { CERT_FAILURE_REASON_BY_CODE } from '@mailcopilot/core/certFailureReason'
import { __testOnly } from './tls'

// The display-only reason table must name every code the trust classifier
// recognises, so a code added to `TLS_TRUST_ERROR_CODES` cannot silently read
// as "unknown" on the dialog.
describe('cert failure reason table covers the trust classifier codes', () => {
  it('has a reason for every TLS_TRUST_ERROR_CODES member', () => {
    for (const code of __testOnly.trustErrorCodes) {
      expect(CERT_FAILURE_REASON_BY_CODE[code], code).toBeDefined()
    }
  })
})
