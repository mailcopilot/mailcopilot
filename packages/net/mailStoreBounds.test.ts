import { describe, expect, it, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// mailStore derives its directory from `dataDir` in ../db at module load, so
// the mock has to be in place before the import below. `vi.mock` is hoisted
// above every const in this file, so the directory is created INSIDE the
// factory and re-exposed through `vi.hoisted` rather than captured from a
// module-level binding that does not exist yet.
const { tmpRoot } = vi.hoisted(() => {
  // A hoisted factory runs before this file's own imports are initialised, so
  // it cannot use `fs`/`os`/`path` — and it does not need to. `mailStore` only
  // joins `dataDir` into a path string at module load; nothing has to exist on
  // disk until a test writes a file, and those writes create the tree with
  // `recursive: true`. So the factory produces a PATH and the filesystem work
  // stays in the test body, where the ordinary imports are available.
  const base = process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`
  return { tmpRoot: `${base}/mailcopilot-eml-${suffix}` }
})

vi.mock('../db', () => ({ dataDir: tmpRoot }))

import { readEml, readEmlBounded } from './mailStore'
import { MAX_EML_PARSE_BYTES, EML_HEADER_SCAN_BYTES } from './limits'
import { parseEmlHeaderFacts } from './eml'

/**
 * §2.145 wave 2.1 — reading an EML is an allocation boundary too.
 *
 * `readFileSync` materialised the whole file before `parseEmlBuffer` could
 * measure it, so the parse-entry cap was being handed bytes that were already
 * resident. An oversized file reaches disk two ways: written by a pre-§2.145
 * install, or written by the offline sync path back when a folder's
 * "unlimited" per-file setting meant exactly that.
 *
 * A real 100 MiB file would make this suite slow and flaky on CI, so the size
 * is faked at the `statSync` seam — the guard's input is a number, and that is
 * precisely the number under test. The prefix read is exercised against a real
 * file, because that part must actually work.
 */
const ACCOUNT = 1
const FOLDER = 'INBOX'
const UID = 4242

const HEADERS = [
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Enormous',
  'Date: Tue, 12 Aug 2026 10:00:00 +0000',
  '',
  '',
].join('\r\n')

function writeEmlFile(body: string): string {
  const dir = path.join(tmpRoot, 'mail', String(ACCOUNT), encodeURIComponent(FOLDER))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${UID}.eml`)
  fs.writeFileSync(file, HEADERS + body)
  return file
}

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(path.join(tmpRoot, 'mail'), { recursive: true, force: true })
})

describe('§2.145 — readEmlBounded stats before it reads', () => {
  it('returns the file when it is within the ceiling', () => {
    writeEmlFile('hello')
    const result = readEmlBounded(ACCOUNT, FOLDER, UID)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.raw.toString('utf8')).toContain('Subject: Enormous')
  })

  it('reports missing when there is no file', () => {
    expect(readEmlBounded(ACCOUNT, FOLDER, 999).kind).toBe('missing')
  })

  // THE FINDING. The oversized file must never be loaded whole.
  it('never calls readFileSync for a file past the ceiling', () => {
    const file = writeEmlFile('x'.repeat(4096))
    const realStat = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const stat = (realStat as unknown as (p: fs.PathLike, ...r: unknown[]) => fs.Stats)(p, ...rest)
      if (String(p) === file) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: MAX_EML_PARSE_BYTES + 1,
        }) as fs.Stats
      }
      return stat
    }) as typeof fs.statSync)
    const readFileSpy = vi.spyOn(fs, 'readFileSync')

    const result = readEmlBounded(ACCOUNT, FOLDER, UID)

    expect(result.kind).toBe('over_limit')
    // The whole point: the file was never slurped.
    expect(readFileSpy).not.toHaveBeenCalled()
    if (result.kind !== 'over_limit') throw new Error('unreachable')
    // The true size comes from the stat, not from a guess.
    expect(result.bytes).toBe(MAX_EML_PARSE_BYTES + 1)
    // Only the header window was read.
    expect(result.prefix.length).toBeLessThanOrEqual(EML_HEADER_SCAN_BYTES)
  })

  it('the bounded prefix is enough to build the hard-cap placeholder', async () => {
    const file = writeEmlFile('x'.repeat(4096))
    const realStat = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const stat = (realStat as unknown as (p: fs.PathLike, ...r: unknown[]) => fs.Stats)(p, ...rest)
      if (String(p) === file) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: MAX_EML_PARSE_BYTES + 1,
        }) as fs.Stats
      }
      return stat
    }) as typeof fs.statSync)

    const result = readEmlBounded(ACCOUNT, FOLDER, UID)
    if (result.kind !== 'over_limit') throw new Error('expected over_limit')

    const placeholder = await parseEmlHeaderFacts(UID, result.prefix, result.bytes)

    expect(placeholder.envelope?.subject).toBe('Enormous')
    expect(placeholder.envelope?.from?.[0]?.address).toBe('alice@example.com')
    // The placeholder reports the FILE's size, not the prefix's — that is what
    // the explicit rawBytes argument exists for.
    expect(placeholder.parseCap).toEqual({
      kind: 'hard',
      rawBytes: MAX_EML_PARSE_BYTES + 1,
      limitBytes: MAX_EML_PARSE_BYTES,
    })
    expect(placeholder.text).toBeUndefined()
    expect(placeholder.html).toBeUndefined()
  })
})

describe('§2.145 — readEml reads an oversized file as absent', () => {
  it('returns null rather than a giant buffer', () => {
    const file = writeEmlFile('x'.repeat(4096))
    const realStat = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const stat = (realStat as unknown as (p: fs.PathLike, ...r: unknown[]) => fs.Stats)(p, ...rest)
      if (String(p) === file) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: MAX_EML_PARSE_BYTES + 1,
        }) as fs.Stats
      }
      return stat
    }) as typeof fs.statSync)
    const readFileSpy = vi.spyOn(fs, 'readFileSync')

    // Every other caller (calendar scan, attachment extraction, AI attachment
    // list) already refuses a buffer past the ceiling downstream, so "absent"
    // is the right answer for all of them — and it costs no allocation.
    expect(readEml(ACCOUNT, FOLDER, UID)).toBeNull()
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('still returns an ordinary file', () => {
    writeEmlFile('hello')
    expect(readEml(ACCOUNT, FOLDER, UID)?.toString('utf8')).toContain('Subject: Enormous')
  })
})
