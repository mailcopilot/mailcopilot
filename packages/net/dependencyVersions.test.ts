/**
 * Dependency version contract — GHSA-2x7j-588g-ccc2.
 *
 * nodemailer's addressparser took O(n^2) time on a crafted address list,
 * fixed in nodemailer 9.1.0 ("addressparser: handle address lists in linear
 * time"). addressparser runs on UNTRUSTED input at two doorways in this
 * codebase:
 *   - electron/services/inviteBridge.ts — ORGANIZER value of an inbound
 *     calendar invite (`import addressparser from
 *     'nodemailer/lib/addressparser/index.js'`);
 *   - mailparser's own header parsing, which every inbound message goes
 *     through (packages/net/eml.ts, packages/net/message.ts) —
 *     `node_modules/mailparser/dist/cjs/mail-parser.js` does
 *     `require('nodemailer/lib/addressparser')` directly, it does not
 *     reimplement address parsing.
 *
 * The behavioural regression pins (electron/services/inviteBridge.test.ts,
 * packages/net/eml.test.ts) only catch a reintroduced vulnerability if their
 * crafted input is still slow enough to trip a generous timing bound on
 * whatever machine runs them. They do NOT catch a lockfile churn that quietly
 * re-pins nodemailer below 9.1.0, or that lets a nested dependency (e.g. a
 * future mailparser release with its own version range) resolve to a SECOND,
 * older copy of nodemailer living in mailparser's own node_modules instead of
 * the single hoisted copy the rest of the app uses. This test pins the
 * *contract* — the installed version and the module-resolution identity —
 * rather than only the observed timing.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

describe('nodemailer / mailparser dependency version contract (GHSA-2x7j-588g-ccc2)', () => {
  it('resolved nodemailer is >= 10.0.6 (GHSA-prgh-xp8r-p3m5 / GHSA-v53p-9fqp-m79j addressparser fixes)', () => {
    const nodemailerPkg = require('nodemailer/package.json') as { version: string }
    const [major, minor, patch] = nodemailerPkg.version.split('.').map(Number)
    const meetsMinimum = major > 10 || (major === 10 && (minor > 0 || patch >= 6))
    expect(meetsMinimum, `nodemailer ${nodemailerPkg.version} predates the 10.0.6 addressparser fixes`).toBe(true)
  })

  it('mailparser resolves addressparser to the SAME nodemailer copy the app imports directly — not a nested, second copy', () => {
    // electron/services/inviteBridge.ts imports this exact file directly.
    const direct = require.resolve('nodemailer/lib/addressparser/index.js')
    // mailparser's own require('nodemailer/lib/addressparser') resolves
    // relative to mailparser's install location. If npm ever nested a
    // second nodemailer under mailparser (e.g. a future mailparser dependency
    // range that no longer matches the hoisted version), these two would
    // point at two different files, and a version bump applied to only one
    // of them would leave the other silently vulnerable.
    const mailparserDir = path.dirname(require.resolve('mailparser'))
    const viaMailparser = require.resolve('nodemailer/lib/addressparser', { paths: [mailparserDir] })
    expect(viaMailparser).toBe(direct)
  })
})
