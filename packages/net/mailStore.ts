/**
 * Storage of original EML files on disk.
 *
 * Structure: ~/.mailcopilot/mail/{accountId}/{folder}/{uid}.eml
 *
 * Email bodies are stored in separate files (not in SQLite) so that:
 * - antivirus can isolate a single message without blocking the entire DB;
 * - SQLite remains lightweight (only metadata and indexes).
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../db'
// §2.145 — one source for every size ceiling; see packages/net/limits.ts. This
// module deliberately imports the leaf and not `./eml`: reading a file must not
// drag mailparser into the store's import graph.
import { EML_HEADER_SCAN_BYTES, MAX_EML_PARSE_BYTES } from './limits'
const mailDir = path.join(dataDir, 'mail')

function legacySanitizeFolder(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Lossless folder storage key: avoids collisions between distinct IMAP paths. */
function encodeFolder(folder: string): string {
  return encodeURIComponent(folder)
}

function emlFilePath(accountId: number, folder: string, uid: number): string {
  return path.join(mailDir, String(accountId), encodeFolder(folder), `${uid}.eml`)
}

function legacyEmlFilePath(accountId: number, folder: string, uid: number): string {
  return path.join(mailDir, String(accountId), legacySanitizeFolder(folder), `${uid}.eml`)
}

function candidatePaths(accountId: number, folder: string, uid: number): string[] {
  const primary = emlFilePath(accountId, folder, uid)
  const legacy = legacyEmlFilePath(accountId, folder, uid)
  return primary === legacy ? [primary] : [primary, legacy]
}

/** Saves the original message (RFC822) to disk */
export function saveEml(accountId: number, folder: string, uid: number, raw: Buffer): void {
  const p = emlFilePath(accountId, folder, uid)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, raw)
  for (const legacyPath of candidatePaths(accountId, folder, uid).slice(1)) {
    try { fs.unlinkSync(legacyPath) } catch { /* ignore */ }
  }
}

/**
 * §2.145 wave 2.1 — the outcome of a bounded read.
 *
 * `over_limit` carries the true `bytes` (a stat, not a guess — unlike the
 * streaming refusal, the file system knows exactly how big the file is) and a
 * bounded `prefix`: the header window and nothing more, which is all
 * `parseEmlHeaderFacts` needs to build the placeholder.
 */
export type ReadEmlResult =
  | { kind: 'ok'; raw: Buffer }
  | { kind: 'missing' }
  | { kind: 'over_limit'; bytes: number; prefix: Buffer }

/**
 * Read an EML from disk, refusing to load one past the hard ceiling.
 *
 * THIS IS AN ALLOCATION BOUNDARY, and it was open: `readFileSync` materialised
 * the whole file before `parseEmlBuffer` could measure it, so the parse-entry
 * check was being handed bytes that were already resident. An oversized file
 * can exist here two ways — written by a pre-§2.145 install, or written by the
 * offline sync path back when a folder's "unlimited" per-file setting meant
 * exactly that — so this is not hypothetical for anyone upgrading.
 *
 * The stat happens FIRST and the oversized branch reads only
 * `EML_HEADER_SCAN_BYTES`, using a file descriptor rather than
 * `readFileSync(...).subarray(...)`, which would defeat the entire point by
 * reading the file whole on the way to slicing it.
 */
export function readEmlBounded(accountId: number, folder: string, uid: number): ReadEmlResult {
  for (const p of candidatePaths(accountId, folder, uid)) {
    let size: number
    try {
      size = fs.statSync(p).size
    } catch { continue }
    if (size > MAX_EML_PARSE_BYTES) {
      return { kind: 'over_limit', bytes: size, prefix: readPrefix(p) }
    }
    try {
      return { kind: 'ok', raw: fs.readFileSync(p) }
    } catch { /* raced with deletion — try the next candidate */ }
  }
  return { kind: 'missing' }
}

/** Read at most the header window off a file we are refusing to load. A read
 *  failure yields an empty buffer rather than throwing: the placeholder is
 *  still correct without header facts, and this path exists precisely because
 *  the file is already anomalous. */
function readPrefix(filePath: string): Buffer {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(EML_HEADER_SCAN_BYTES)
    const read = fs.readSync(fd, buf, 0, EML_HEADER_SCAN_BYTES, 0)
    return buf.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/**
 * Reads an EML file from disk. Returns null if the file is not found — OR if it
 * is past the hard ceiling.
 *
 * §2.145 wave 2.1: an oversized file reads as "not here" for every caller of
 * this function, and that is the right answer for all of them. They are the
 * calendar scan, the attachment extractor and the AI attachment list, and each
 * one already refuses a buffer past the ceiling further down (`eml.ts`); the
 * only thing loading it would achieve is the allocation. Callers that want to
 * SAY something about the oversized message — the message-open path, which owes
 * the user a placeholder — use `readEmlBounded` instead.
 */
export function readEml(accountId: number, folder: string, uid: number): Buffer | null {
  const result = readEmlBounded(accountId, folder, uid)
  return result.kind === 'ok' ? result.raw : null
}

/** Checks if an EML file exists on disk */
export function emlExists(accountId: number, folder: string, uid: number): boolean {
  return candidatePaths(accountId, folder, uid).some(p => fs.existsSync(p))
}

/** Deletes an EML file */
export function deleteEml(accountId: number, folder: string, uid: number): void {
  for (const p of candidatePaths(accountId, folder, uid)) {
    try { fs.unlinkSync(p) } catch { /* file may not exist */ }
  }
}

/** Deletes EML files for the specified UIDs */
export function deleteEmls(accountId: number, folder: string, uids: number[]): void {
  for (const uid of uids) deleteEml(accountId, folder, uid)
}

/** Deletes all EML files for an account */
export function deleteAccountEmls(accountId: number): void {
  const dir = path.join(mailDir, String(accountId))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Recursively calculates total size of all files in a directory (bytes) */
function dirSizeRecursive(dir: string): number {
  let total = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += dirSizeRecursive(full)
      } else {
        try { total += fs.statSync(full).size } catch { /* file may have been removed */ }
      }
    }
  } catch { /* directory may not exist */ }
  return total
}

/** TTL cache for EML directory size (avoids expensive recursive stat on every call) */
let _emlCacheSizeValue = 0
let _emlCacheSizeTs = 0
const EML_CACHE_SIZE_TTL_MS = 60_000

/** Returns total size of the EML cache directory in bytes (cached for 60 s) */
export function emlCacheSizeBytes(): number {
  const now = Date.now()
  if (now - _emlCacheSizeTs < EML_CACHE_SIZE_TTL_MS) return _emlCacheSizeValue
  _emlCacheSizeValue = dirSizeRecursive(mailDir)
  _emlCacheSizeTs = now
  return _emlCacheSizeValue
}
