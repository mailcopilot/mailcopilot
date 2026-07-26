import type { FolderRoles } from './folder'

/**
 * Per-account sending identity (display name + email + signature + default Bcc).
 *
 * Phase 2.3-A — multi-identity v1:
 *   - Every account has at least one identity; exactly one must be `isDefault`.
 *   - `id` is stable per identity (UUID), used as React key and for reply-identity
 *     matching against the original To/Cc addresses.
 *   - `email` may equal the account's primary SMTP address (the common case)
 *     or an alias/plus-addressed variant. It is the address emitted in the
 *     From header when the user picks this identity in Compose.
 *   - `defaultBcc` is applied as the initial Bcc value when the identity is
 *     selected in Compose (user can still edit/clear).
 *
 * Records persisted before 2.3-A have no `identities[]` and are migrated on
 * read by `accountMetaSchema` in `packages/net/config.ts` — a single default
 * identity is synthesized from the legacy top-level `name`/`email`/`signature`
 * fields without touching the on-disk record (migration-on-first-use).
 */
export type Identity = {
  /** Stable UUID, used as React key and for reply-identity matching. */
  id: string
  /** Display name shown in the From header (e.g. "Alice Doe"). */
  displayName: string
  /**
   * Email address emitted in the From header when this identity is active.
   * May equal the account's primary SMTP address or an alias.
   */
  email: string
  /** Optional signature appended to outgoing emails sent from this identity. */
  signature?: string
  /**
   * Optional default Bcc applied when this identity is selected in Compose.
   *
   * Tri-state: `undefined` means "not set" (no default Bcc); a non-empty
   * string is the configured address (applied as the initial Bcc when the
   * identity is selected); an empty string is the explicit "cleared by the
   * user" sentinel that round-trips through save → load — the Identities
   * tab forwards an empty field verbatim so a clear is distinguishable from
   * "field not submitted" on the write path.
   */
  defaultBcc?: string
  /** Exactly one identity per account must have `isDefault: true`. */
  isDefault: boolean
}

export type ImapConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  pass?: string
  /**
   * OAuth2 access token (XOAUTH2) for passwordless authentication (e.g. Gmail).
   * Secret; must not be stored in AccountMeta and must not be logged.
   */
  accessToken?: string
  /**
   * Trusted TLS pins (SHA-256 fingerprint) for a specific host:port.
   * If specified, the connection is accepted only when the fingerprint matches.
   */
  tlsPinsSha256?: string[]
  /**
   * PEM bodies of the pinned certificates, when they were captured at pin time.
   *
   * Supplied as explicit trust anchors so a pinned self-signed / private-CA
   * server can verify its chain under `rejectUnauthorized: true`. A fingerprint
   * alone cannot anchor a chain, and Node only calls `checkServerIdentity`
   * after chain verification succeeded — so without this the pinned path is
   * fail-closed for such servers.
   */
  tlsPinnedCertsPem?: string[]
}

export type SmtpConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  pass?: string
  /**
   * OAuth2 access token (XOAUTH2) for passwordless authentication (e.g. Gmail).
   * Secret; must not be stored in AccountMeta and must not be logged.
   */
  accessToken?: string
  /**
   * Trusted TLS pins (SHA-256 fingerprint) for a specific host:port.
   * If specified, the connection is accepted only when the fingerprint matches.
   */
  tlsPinsSha256?: string[]
  /**
   * PEM bodies of the pinned certificates, when they were captured at pin time.
   * See `ImapConfig.tlsPinnedCertsPem` — same contract on the SMTP transport.
   */
  tlsPinnedCertsPem?: string[]
}

export type AccountConfig = {
  imap: ImapConfig
  smtp: SmtpConfig
}

export type AutoconfigResult = {
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  displayName?: string
  source: 'preset' | 'ispdb' | 'domain-autoconfig' | 'mx-lookup' | 'guess'
}

/** Account without secrets (passwords/tokens are stored in keytar) */
export type AccountMeta = {
  id: number
  /** Display name (optional). If not set, UI may show email/host. */
  name?: string
  /** Email address for the From field (optional). If not set, smtp.user / imap.user is used. */
  email?: string
  /** Account color index (0..7) for indicators in Unified Inbox and other UI elements. */
  colorIndex?: number
  /** Custom initials (1-2 characters). If not set, computed from name/email. */
  avatarInitials?: string
  /** Preset icon name (lucide) for icon mode. */
  avatarIcon?: string
  /** Avatar display mode: initials (color + letters), icon (color + icon), or gravatar. */
  avatarMode?: 'initials' | 'icon' | 'gravatar'
  /**
   * Authentication type. Default: password.
   *
   * - 'password' — IMAP/SMTP with a keytar-stored password.
   * - 'oauth2'   — provider-agnostic OAuth2 (token obtained via refresh token at runtime).
   *
   * Legacy records that were stored with `'google_oauth2'` are normalized to `'oauth2'`
   * on read by accountMetaSchema in packages/net/config.ts; the canonical in-memory
   * representation is always the two-member union.
   */
  authType?: 'password' | 'oauth2'
  /**
   * Provider identifier for routing to provider-specific transport/auth logic.
   * Populated by accountMetaSchema on read (legacy records without an explicit
   * providerId default to 'generic-imap' or 'gmail' depending on authType).
   */
  providerId: 'gmail' | 'outlook' | 'generic-imap'
  /**
   * Transport family. Currently only 'imap-smtp' is supported; reserved for future
   * provider transports (Gmail API, Graph, JMAP).
   */
  transportType: 'imap-smtp'
  imap: Omit<ImapConfig, 'pass' | 'accessToken'>
  smtp: Omit<SmtpConfig, 'pass' | 'accessToken'>
  /** Custom bindings of standard roles to folders (account-scoped) */
  folderRoles?: FolderRoles
  /**
   * Per-account sending identities (2.3-A). Always non-empty after read/save:
   * `accountMetaSchema` synthesizes a default identity for legacy records that
   * were saved before 2.3-A landed, so consumers can rely on `identities[0]`
   * (or the one with `isDefault: true`) without a null check.
   */
  identities: Identity[]
  /**
   * @deprecated 2.3-A — superseded by `identities`. Kept as a read-only
   * fallback for one release cycle so legacy callers keep working while
   * Compose/Settings migrate to the identity selector (wave 2).
   *
   * Write path no longer populates this from the save payload; it is only
   * retained on AccountMeta records that existed on disk pre-migration and
   * have not been re-saved yet. New saves emit `identities[]` only.
   */
  signature?: string
}
