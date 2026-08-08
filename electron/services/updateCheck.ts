import fs from 'node:fs'
import path from 'node:path'
import { isTransientNetworkError, isLinuxInstallerError } from '@mailcopilot/core'

/**
 * Best-effort probe: does the current user *appear* able to create/replace
 * entries inside `dir`?
 *
 * Directory write permission (not file permission) is what matters for every
 * in-place updater path we support: electron-updater's AppImage install does
 * `unlink(old) + mv(new)` inside the containing directory, and NSIS/Squirrel
 * likewise rewrite files next to the executable.
 *
 * Both bits are required. POSIX needs the search/execute bit (`X_OK`) on a
 * directory to resolve names inside it, so `unlink`/`rename` need `W_OK|X_OK`
 * together — a `0o222` directory passes a `W_OK`-only probe and then fails the
 * actual install.
 *
 * NOT AUTHORITATIVE (CLAUDE.md §5 "Кто владеет правдой"). The kernel owns this
 * answer, not us, and this probe cannot see: the sticky bit (`/tmp`-style
 * directories where write access does not imply the right to replace someone
 * else's entry), immutable/append-only attributes (`chattr +i`), MAC policies
 * (SELinux/AppArmor), read-only or full filesystems, and any permission change
 * between this probe and the install. A `true` here means "no known reason to
 * refuse", not "the write will succeed"; a `false` is the only side we act on,
 * and even then the final verdict belongs to the updater and the OS.
 */
export function isDirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * How the running build would be replaced by electron-updater.
 *
 *   - 'appimage'      — Linux AppImage. electron-updater's `AppImageUpdater`
 *                       swaps the *AppImage file* (`process.env.APPIMAGE`),
 *                       NOT `process.execPath` (which points inside the
 *                       read-only `/tmp/.mount_*` FUSE mount).
 *   - 'linux-package' — .deb / .rpm / pacman. `DebUpdater`/`RpmUpdater` shell
 *                       out to dpkg/apt via pkexec/sudo, i.e. they elevate;
 *                       the current user's permissions on the install
 *                       directory say nothing about whether the update can
 *                       be applied.
 *   - 'windows'       — NSIS installer next to the executable.
 *   - 'macos'         — Squirrel.Mac replaces the .app bundle.
 */
export type SelfUpdateTargetKind = 'appimage' | 'linux-package' | 'windows' | 'macos'

/**
 * Why in-place self-update is known to be impossible. Enum (not free text) —
 * it crosses the IPC boundary into the renderer and may end up in log lines,
 * so it must be PII-clean by construction.
 *
 *   - 'not-packaged'        — dev / e2e run, there is no updater at all.
 *   - 'no-in-place-target'  — Linux build that is neither a distro package nor
 *                             a running AppImage (extracted AppImage, `SNAP`,
 *                             a raw `linux-unpacked` tree). electron-updater's
 *                             `AppImageUpdater.isUpdaterActive()` returns false
 *                             for exactly this case, so refusing here mirrors
 *                             the updater rather than second-guessing it.
 *   - 'target-dir-readonly' — we know the directory the updater must write to
 *                             and our permission probe on it failed. The probe
 *                             is advisory (see `isDirWritable`); this reason
 *                             means "we have a concrete reason to expect
 *                             failure", not a kernel-level guarantee.
 */
export type SelfUpdateBlockedReason = 'not-packaged' | 'no-in-place-target' | 'target-dir-readonly'

export type SelfUpdateSupport = {
  kind: SelfUpdateTargetKind
  /**
   * Directory electron-updater would write into, or `null` when writability
   * is not the deciding factor ('linux-package' — the updater elevates) or
   * when the target is unknown.
   *
   * PRIVACY: this is a user-path (`~/Applications/...`). It must never be
   * logged, put into telemetry, or sent to Sentry. Only `kind` and
   * `blockedReason` are safe outside this module.
   */
  targetDir: string | null
  canSelfUpdate: boolean
  blockedReason: SelfUpdateBlockedReason | null
}

export type ResolveSelfUpdateOptions = {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string
  /** `process.resourcesPath` — used to read electron-builder's package-type marker. */
  resourcesPath?: string
  /**
   * `process.env` (injected for tests). Typed as a plain string dictionary
   * rather than `NodeJS.ProcessEnv` — the app augments that interface with
   * required keys (APP_ROOT, VITE_PUBLIC), which would force every caller to
   * supply them just to hand this function one variable.
   */
  env?: Readonly<Record<string, string | undefined>>
  /** Injected for tests. */
  isDirWritableImpl?: (dir: string) => boolean
  /** Injected for tests. */
  readPackageTypeImpl?: (resourcesPath: string) => string | null
}

/**
 * Read electron-builder's `package-type` marker from the resources directory.
 *
 * This is the same discriminator `electron-updater/out/main.js` uses to pick
 * `DebUpdater` / `RpmUpdater` / `PacmanUpdater` over the default
 * `AppImageUpdater`. Reading the same marker keeps our capability model and
 * the updater's actual behaviour from drifting apart.
 */
export function readLinuxPackageType(resourcesPath: string): string | null {
  try {
    return fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim() || null
  } catch {
    // Missing marker is the normal AppImage case — not an error.
    return null
  }
}

/**
 * Validate `process.env.APPIMAGE` before trusting it as a filesystem target.
 *
 * SECURITY NOTE — this env var is set by the AppImage runtime, but env vars
 * are inherited and forgeable by whoever spawned us. That is acceptable here
 * for two reasons:
 *
 *  1. It is not a trust anchor. We only use it to decide whether to *offer*
 *     self-update; the actual write is performed by electron-updater using
 *     the very same variable (`AppImageUpdater.doInstall`) and is enforced by
 *     the kernel. A forged value cannot grant permissions the user lacks — at
 *     worst it makes an update attempt fail and surface as the existing
 *     `permission`/`unknown` error bucket.
 *  2. Anyone able to set our environment already controls the process launch
 *     (NODE_OPTIONS, ELECTRON_RUN_AS_NODE, LD_PRELOAD…), so the env var adds
 *     no new capability to that attacker.
 *
 * We still apply the same shape checks electron-updater does (absolute path,
 * no NUL) so a malformed value degrades to "no in-place target" instead of
 * producing a bogus directory probe.
 */
function normalizeAppImagePath(raw: string | undefined): string | null {
  if (!raw) return null
  if (raw.includes('\0')) return null
  if (!path.isAbsolute(raw)) return null
  return raw
}

/**
 * Decide whether this build can replace itself in place.
 *
 * Replaces the previous `canWriteAppDir(process.execPath)` heuristic, which
 * was wrong in both directions on Linux:
 *
 *   - AppImage: `execPath` lives inside the read-only `/tmp/.mount_*` FUSE
 *     mount, so the probe always failed and auto-update was structurally
 *     dead on our primary Linux artifact.
 *   - .deb/.rpm: an admin-owned `/opt` install probed as "not writable", but
 *     `DebUpdater` elevates via pkexec/sudo, so the refusal was ours, not the
 *     system's.
 *
 * Policy (CLAUDE.md §5 "Кто владеет правдой"): we only claim "cannot
 * self-update" where the answer is ours to give — no updater exists
 * (unpackaged), the updater itself refuses (no AppImage target), or the
 * filesystem target is known and our permission probe on it failed. That last
 * case is advisory, not authoritative: `isDirWritable` cannot see sticky bits,
 * immutable attributes or later permission changes, so a passing probe never
 * promises the install will succeed. Everything else is passed through to
 * electron-updater, whose failure is classified by `classifyUpdateError()` and
 * surfaced to the user.
 */
export function resolveSelfUpdateSupport(opts: ResolveSelfUpdateOptions): SelfUpdateSupport {
  const {
    platform,
    isPackaged,
    execPath,
    resourcesPath,
    env = {},
    isDirWritableImpl = isDirWritable,
    readPackageTypeImpl = readLinuxPackageType,
  } = opts

  const kind: SelfUpdateTargetKind =
    platform === 'win32' ? 'windows'
      : platform === 'darwin' ? 'macos'
        : (() => {
          const packageType = resourcesPath ? readPackageTypeImpl(resourcesPath) : null
          return packageType === 'deb' || packageType === 'rpm' || packageType === 'pacman'
            ? 'linux-package'
            : 'appimage'
        })()

  if (!isPackaged) {
    return { kind, targetDir: null, canSelfUpdate: false, blockedReason: 'not-packaged' }
  }

  if (kind === 'linux-package') {
    // Deliberately no writability probe: dpkg/rpm run under pkexec/sudo.
    // A real refusal (no polkit agent, user cancels, dpkg failure) arrives as
    // an updater error and is bucketed as 'permission' by classifyUpdateError.
    return { kind, targetDir: null, canSelfUpdate: true, blockedReason: null }
  }

  const targetDir = kind === 'appimage'
    ? (() => {
      const appImage = normalizeAppImagePath(env.APPIMAGE)
      return appImage ? path.dirname(appImage) : null
    })()
    // Windows/macOS keep the historical execPath-based probe.
    : path.dirname(execPath)

  if (targetDir === null) {
    return { kind, targetDir: null, canSelfUpdate: false, blockedReason: 'no-in-place-target' }
  }

  return isDirWritableImpl(targetDir)
    ? { kind, targetDir, canSelfUpdate: true, blockedReason: null }
    : { kind, targetDir, canSelfUpdate: false, blockedReason: 'target-dir-readonly' }
}

/**
 * §2.19 — bucketed error classification for update.* telemetry.
 *
 * Privacy invariant: telemetry tags must be enums, not raw error messages
 * (which can leak path components, version strings, server hostnames, etc.).
 * This taxonomy is intentionally tiny — three buckets cover the full failure
 * surface of electron-updater + Linux installers without cardinality blowup:
 *
 *   - 'network'    — transient connectivity (proxy drop, VPN, sleep, DNS).
 *                    Mirrors the suppression rule in `autoUpdater.on('error')`
 *                    so a single dashboard signal lines up with what we DON'T
 *                    forward to Sentry.
 *   - 'permission' — write/exec permission denied (read-only install dir,
 *                    pkexec/dpkg refusal, EACCES). User needs admin help.
 *   - 'unknown'    — anything else. Forward-compat: a future failure mode
 *                    surfaces here and we get a Sentry breadcrumb to triage,
 *                    no schema bump required.
 *
 * Returned values match the `error_class` tag domain in metricsSchema.ts.
 */
export type UpdateErrorClass = 'network' | 'permission' | 'unknown'

export function classifyUpdateError(err: unknown): UpdateErrorClass {
  if (isTransientNetworkError(err)) return 'network'
  if (isLinuxInstallerError(err)) return 'permission'
  // Heuristic for write-permission failures (root-owned install path on
  // Linux/macOS, NSIS write failures on Windows, sandbox quirks on macOS).
  // Plain text codes are PII-clean — they're error-system constants, not
  // user data.
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code.toUpperCase()
      : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission'
  // electron-updater raises plain Error('access denied') in some signature
  // paths — match conservatively on the message text.
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  if (msg.includes('permission denied') || msg.includes('access denied')) return 'permission'
  return 'unknown'
}

/**
 * Shape returned by `update:download` / `update:install` when the gate refuses.
 *
 * IPC CONTRACT — the renderer is wired to these exact fields (App.tsx reads
 * `ok`, SystemInfo.tsx reads `{ ok, reason }`), and `error_class` is the same
 * `update_error_class` enum domain the rest of the update state machine and
 * the telemetry schema already speak. Changing any field here is a renderer-
 * visible breaking change, not a refactor.
 */
export type UpdateIpcRejection = {
  ok: false
  reason: 'permission_denied'
  error_class: 'permission'
}

export type UpdateIpcGateDecision =
  | { allowed: true }
  | { allowed: false; reject: UpdateIpcRejection }

export type UpdateIpcGateInput = {
  /** `app.isPackaged`. */
  isPackaged: boolean
  /** `resolveSelfUpdateSupport(...).canSelfUpdate`, resolved once at startup. */
  canSelfUpdate: boolean
}

/**
 * §2.19 iter4 — the shared gate behind `update:download` and `update:install`.
 *
 * Real risk (codex): both handlers used to check only `app.isPackaged`.
 * SystemInfo.tsx hides the download/restart affordance where in-place update
 * is impossible, but a compromised renderer can call `window.api.invoke`
 * directly and bypass the UI. The handler MUST short-circuit before touching
 * autoUpdater. The `permission` bucket is the same enum the renderer's state
 * machine already understands.
 *
 * §2.58 — the predicate narrowed: it now fires only where self-update is
 * *known* impossible (unpackaged, no AppImage target, target dir that failed
 * the permission probe). On .deb/.rpm it is effectively "always allow", because the
 * installer elevates and only the OS can answer. What still bounds a
 * compromised renderer there is not this gate:
 *   - downloadUpdate() only fetches from the configured, TLS-verified feed
 *     into the app cache — no user-chosen URL or path is reachable from IPC;
 *   - installing needs quitAndInstall(), which requires an already downloaded
 *     artifact and then a polkit/sudo prompt the *user* answers;
 *   - electron-updater verifies the artifact against the feed metadata.
 * The gate's remaining job is to stop pointless work and dialog spam where the
 * outcome is a certainty, not to be the authorization boundary.
 *
 * `isPackaged === false` returns `allowed: true` because dev/e2e builds have
 * no updater at all: both handlers own an earlier `{ ok: true }` short-circuit
 * for that case, and `canSelfUpdate` is only enforced for packaged builds.
 * Keeping the flag in the truth table (instead of assuming the caller already
 * filtered) makes the policy readable in one place.
 *
 * Pure by design — the decision must be unit-testable without importing
 * `electron/main.ts` (which pulls in the whole app), so that deleting the
 * refusal is caught by the test suite rather than by a user on a read-only
 * install.
 */
export function decideUpdateIpcGate(input: UpdateIpcGateInput): UpdateIpcGateDecision {
  const { isPackaged, canSelfUpdate } = input
  if (!isPackaged) return { allowed: true }
  if (!canSelfUpdate) {
    return {
      allowed: false,
      reject: { ok: false, reason: 'permission_denied', error_class: 'permission' },
    }
  }
  return { allowed: true }
}

/**
 * §2.19 — system info exposed in Settings → About → System Info panel.
 *
 * All fields are static at runtime (process.versions, app.getVersion(),
 * process.platform, etc.) so the renderer can fetch this once on Settings
 * open.
 *
 * PRIVACY — this payload is deliberately NOT "PII-free". `installPath` is
 * `process.execPath`, a machine-local path. On a user-local install it
 * contains the home directory and therefore the account name — a per-user
 * Windows setup, an `.app` under `~/Applications`, a build run from source, an
 * unpacked tree in $HOME (`/home/<user>/…`, `C:\Users\<user>\…`). On an
 * AppImage it does NOT: `execPath` resolves inside the read-only
 * `/tmp/.mount_*` FUSE mount (see `SelfUpdateTargetKind`), and the user-owned
 * path is `process.env.APPIMAGE`, which this payload does not expose. Showing
 * the running binary is the point: the About panel exists so the user can see
 * which one it is and whether it is updatable (§2.19). The constraint is
 * directional, not compositional:
 *
 *   - it goes to the renderer of the user's own Settings window and nowhere
 *     else — never to Sentry, telemetry or the local file log. §2.58 iter2:
 *     the `update:systemInfo` handler enforces that direction by sender
 *     identity (fail-closed, `null` to anyone else) instead of trusting that
 *     no other renderer will ask. Update logging emits the bucketed
 *     `error_class` (see `classifyUpdateError`), plus `err.code` on an install
 *     failure — a short updater/OS code that reaches the local file log and
 *     the native dialog only, never Sentry, telemetry or the IPC reply;
 *   - no *additional* path is exposed alongside it: `SelfUpdateSupport.targetDir`
 *     stays inside main, and only its boolean verdict (`installPathWritable`)
 *     and the `blockedReason` enum cross the IPC boundary.
 *
 * Anyone adding a field here must re-check both bullets: "the user may see it"
 * does not imply "it may be logged".
 *
 * `channel`:
 *   - 'dev'     — running from source (vite/electron-forge), `app.isPackaged === false`.
 *   - 'nightly' — packaged build whose version contains `-nightly`/`-beta`/`-rc`.
 *   - 'stable'  — anything else (semantic-release stable tag).
 *
 * Channel is a UI badge only — autoUpdater feed routing is configured by
 * electron-builder.json5 / publish target, not by this enum.
 */
export type UpdateChannel = 'dev' | 'nightly' | 'stable'

export function detectUpdateChannel(version: string, isPackaged: boolean): UpdateChannel {
  if (!isPackaged) return 'dev'
  const lower = version.toLowerCase()
  if (lower.includes('-nightly') || lower.includes('-beta') || lower.includes('-rc') || lower.includes('-alpha')) {
    return 'nightly'
  }
  return 'stable'
}

export type SystemInfo = {
  appVersion: string
  channel: UpdateChannel
  electron: string
  chromium: string
  node: string
  platform: NodeJS.Platform
  arch: string
  installPath: string
  /**
   * Whether the directory electron-updater would write into is writable.
   * For AppImage that is the directory holding the .AppImage file, not the
   * `/tmp/.mount_*` directory `installPath` points at. For distro packages
   * this is always true — the updater elevates, so the current user's
   * permissions are not the deciding factor. Drives the "read-only" marker
   * next to the install path.
   */
  installPathWritable: boolean
  /**
   * False only when in-place self-update is *known* to be impossible:
   * unpackaged build, no AppImage target, or a target directory that failed
   * the (advisory) permission probe. Everything else defers to
   * electron-updater (see `resolveSelfUpdateSupport`). Drives the warning
   * shown next to the auto-download checkbox — it no longer disables the
   * control.
   */
  canSelfUpdate: boolean
  /**
   * Enum reason behind `canSelfUpdate === false`; null when it is true. This
   * is what the renderer phrases the warning from — `SelfUpdateTargetKind` is
   * deliberately NOT exported over IPC: it was shipped for that purpose and
   * never read, i.e. dead contract surface (removed 2026-08-03).
   */
  selfUpdateBlockedReason: SelfUpdateBlockedReason | null
  isPackaged: boolean
}
