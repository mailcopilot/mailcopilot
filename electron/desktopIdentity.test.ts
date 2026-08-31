import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * §2.228.f2 — the Linux window ↔ launcher association, pinned on both sides.
 *
 * The measured defect: on Ubuntu GNOME 46 / X11 our main window carried
 * `WM_CLASS = ("mailcopilot", "mailcopilot")` while the generated desktop entry
 * asked for `StartupWMClass=MailCopilot`, so the shell could not match the
 * running window to the launcher and drew the generic placeholder icon instead
 * of ours.
 *
 * Neither side was wrong on its own — they simply had different defaults, and
 * nothing in the tree said they had to agree:
 *   - Electron: `app.setDesktopName(packageJson.desktopName || slug(app.name))`,
 *     and every window's WM_CLASS / Wayland app_id follows the desktop name;
 *   - electron-builder: `StartupWMClass` = `desktopName` minus `.desktop` when
 *     package.json declares it, and `productName` when it does not.
 * Declaring `desktopName` makes both read THE SAME key. These tests are what
 * keeps them reading it: they mirror the two derivations, so a change on either
 * side that re-opens the gap fails here rather than in a user's dash.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/**
 * Enough JSON5 for a config file: line comments outside strings, and trailing
 * commas. Hand-rolled rather than pulled from `json5`, which this project only
 * has transitively through electron-builder — a phantom import here would make
 * a guard about build configuration depend on somebody else's dependency tree.
 * String state is tracked because the file contains `https://` URLs, which a
 * naive comment strip would truncate.
 */
function parseConfigWithComments(source: string): Record<string, string | Record<string, unknown>> {
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

const builder = parseConfigWithComments(readFileSync(path.join(ROOT, 'electron-builder.json5'), 'utf8')) as {
  productName: string
  linux: { syncDesktopName?: boolean; desktop?: { entry?: Record<string, string> } }
}

/**
 * Electron's own `defaultDesktopName` (lib/browser/init.ts), transcribed: NFKD,
 * strip combining marks, lower-case, non-alphanumerics to '-', trim '-'.
 */
function electronDefaultDesktopName(appName: string): string {
  const slug = appName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug}.desktop`
}

/** What Electron uses as the app name: productName if present, else name. */
const appName: string = pkg.productName ?? pkg.name
const desktopName: string = pkg.desktopName
const wmClass = desktopName?.replace(/\.desktop$/, '')

describe('the Linux desktop identity has one source of truth', () => {
  it('declares desktopName in package.json — the key BOTH sides read', () => {
    expect(typeof desktopName).toBe('string')
    expect(desktopName.endsWith('.desktop')).toBe(true)
    // electron-builder refuses a name that would escape the applications dir.
    expect(/[/\\]/.test(wmClass)).toBe(false)
    expect(wmClass.length).toBeGreaterThan(0)
  })

  /**
   * Mutation killed: renaming BOTH keys together. Every other assertion in this
   * file is RELATIONAL — it asks whether the two derivations agree — so a
   * coordinated `name: 'mailclient'` + `desktopName: 'mailclient.desktop'`
   * satisfied all of them while doing the two things that must never happen
   * quietly: `app.getName()` moves, and with it `app.getPath('userData')`
   * (~/.config/mailcopilot — mail cache, settings, the encrypted secret
   * fallback), stranding every existing profile; and the installed desktop
   * entry is renamed, breaking every pinned launcher.
   *
   * So the identity is pinned to its LITERAL value here, once. A deliberate
   * rename is then a deliberate edit of this test, with the migration that such
   * a rename requires — not a side effect of a tidy-up in package.json.
   */
  it('pins the identity itself, so a coordinated rename cannot slip through', () => {
    expect(pkg.name).toBe('mailcopilot')
    expect(desktopName).toBe('mailcopilot.desktop')
    expect(wmClass).toBe('mailcopilot')
  })

  /**
   * Mutation killed: changing the declared name without meaning to change the
   * running window's WM_CLASS. Keeping it equal to what Electron would have
   * derived anyway is what makes this fix a no-op at runtime — the entry was the
   * side that was wrong, and pinned launchers keep working.
   */
  it('names the desktop entry exactly what Electron derives from the app name', () => {
    expect(desktopName).toBe(electronDefaultDesktopName(appName))
  })

  /**
   * Mutation killed: "let us just capitalise the app name so WM_CLASS looks
   * pretty". `app.getName()` owns `app.getPath('userData')`; renaming it strands
   * every existing profile (~/.config/mailcopilot) — mail cache, settings and
   * the encrypted secret fallback with it. The pretty name belongs in
   * `productName` in electron-builder.json5, which is what the user SEES, and
   * nowhere near the identity the data directory hangs off.
   */
  it('does not declare productName in package.json, which would move the user data directory', () => {
    expect(pkg.productName).toBeUndefined()
    expect(appName).toBe(pkg.name)
  })

  /**
   * Mirror of app-builder-lib: `StartupWMClass` is the desktop name minus the
   * suffix, and the entry's FILENAME is that same base once `syncDesktopName` is
   * on — which also has to equal the default filename (`executableName`, itself
   * `sanitizedName.toLowerCase()`), or the fix would rename the installed entry
   * and break every pinned launcher.
   */
  it('makes electron-builder write that same name into the entry, and into its filename', () => {
    expect(builder.linux.syncDesktopName).toBe(true)
    expect(wmClass).toBe(String(builder.productName).toLowerCase())
    expect(builder.linux.desktop?.entry?.StartupWMClass).toBeUndefined()
  })
})
