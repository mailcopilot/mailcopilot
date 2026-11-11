import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The Windows installer shows a privacy notice built from build/license_<lang>.txt.
// electron-builder finds those files BY NAME, and its DMG target looks for the very
// same names, so without an explicit switch the notice would also pop up when a
// macOS user mounts the DMG — where the docs and the policy say there is no such
// page. This pins the switch against the installed electron-builder code, not
// against the text of a config file.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = path.join(ROOT, 'build')
const LANGS = ['en', 'ru', 'fr', 'de', 'es', 'it'] as const

/** Line comments outside strings and trailing commas — same approach as desktopIdentity.test.ts. */
function parseConfigWithComments(source: string): Record<string, unknown> {
  let out = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (inString) {
      out += c
      if (c === '\\') { out += source[++i] ?? ''; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const config = parseConfigWithComments(readFileSync(path.join(ROOT, 'electron-builder.json5'), 'utf8')) as {
  dmg?: { license?: unknown }
  nsis?: { oneClick?: boolean }
}

// dmg-builder is electron-builder's own dependency, not ours: resolve it from there.
const requireFromBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'))
const { addLicenseToDmg } = requireFromBuilder('dmg-builder/out/dmgLicense') as {
  addLicenseToDmg: (packager: unknown, explicit: unknown) => Promise<unknown>
}

/** The only parts of the packager that the license lookup touches. */
const fakePackager = {
  resourceList: Promise.resolve(readdirSync(BUILD_DIR)),
  buildResourcesDir: BUILD_DIR,
  debugLogger: { add: () => undefined },
  getResource: async () => null,
}

describe('installer privacy notice stays on the NSIS installer', () => {
  it('ships one notice per supported language, and no file the non-localized lookups would pick up', () => {
    const files = readdirSync(BUILD_DIR).sort()
    expect(files).toEqual(LANGS.map(l => `license_${l}.txt`).sort())
    // NSIS / AppImage look for license.{rtf,txt,html} and eula.* (non-localized).
    expect(files.filter(f => /^(license|eula)\.(rtf|txt|html)$/i.test(f))).toEqual([])
  })

  it('the installer is the assisted one, so the notice page can appear', () => {
    expect(config.nsis?.oneClick).toBe(false)
  })

  it('without the explicit switch the DMG target WOULD pick the notice up (why the switch exists)', async () => {
    const picked = await addLicenseToDmg(fakePackager, undefined)
    expect(picked).not.toBeNull()
  })

  it('with the configured value the DMG target ships no license', async () => {
    expect(config.dmg).toBeDefined()
    expect(config.dmg?.license).toBeNull()
    await expect(addLicenseToDmg(fakePackager, config.dmg?.license)).resolves.toBeNull()
  })
})
