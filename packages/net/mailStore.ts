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

/** Reads an EML file from disk. Returns null if file not found. */
export function readEml(accountId: number, folder: string, uid: number): Buffer | null {
  for (const p of candidatePaths(accountId, folder, uid)) {
    try {
      return fs.readFileSync(p)
    } catch { /* ignore */ }
  }
  return null
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
