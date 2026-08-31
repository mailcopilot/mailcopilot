import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── §2.94 oauth:progress channel pins ───────────────────────────────────────
//
// The account wizard subscribes to `oauth:progress` to show what a connection
// is waiting on. Three properties are worth pinning, because losing any of
// them silently regresses either the feature or the IPC boundary:
//
//  1. Listed in ALLOWED_LISTEN_CHANNELS — otherwise preload rejects the
//     subscription and the waiting step freezes on its seeded first stage.
//  2. NOT in ALLOWED_INVOKE_CHANNELS — it is a one-way push from main; the
//     renderer must have no way to call into main through it.
//  3. Declared in the renderer-facing channel union, which is hand-maintained
//     alongside the preload whitelist and drifts easily.

function readSource(file: string): string {
  return readFileSync(resolve(__dirname, file), 'utf8')
}

describe('oauth:progress channel whitelist §2.94', () => {
  it('is listed inside ALLOWED_LISTEN_CHANNELS', () => {
    const src = readSource('preload.ts')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(listenIdx).toBeGreaterThan(-1)
    const listenRegion = src.slice(listenIdx, listenIdx + 4000)
    expect(listenRegion).toContain("'oauth:progress'")
  })

  it('is NOT listed inside ALLOWED_INVOKE_CHANNELS', () => {
    const src = readSource('preload.ts')
    const invokeIdx = src.indexOf('const ALLOWED_INVOKE_CHANNELS')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(invokeIdx).toBeGreaterThan(-1)
    expect(listenIdx).toBeGreaterThan(invokeIdx)
    const invokeRegion = src.slice(invokeIdx, listenIdx)
    expect(invokeRegion).not.toContain("'oauth:progress'")
  })

  it('is declared on every renderer-facing listener signature', () => {
    const src = readSource('electron-env.d.ts')
    // on / off / removeAll each carry their own literal union.
    const occurrences = src.split("'oauth:progress'").length - 1
    expect(occurrences).toBe(3)
  })
})
