import type { Identity } from '@mailcopilot/types'

/**
 * Formats an identity for display as `DisplayName <email>`. Falls back to the
 * email when displayName equals the local-part (common for synthesized legacy
 * identities) or is otherwise empty, so we never render `email <email>`.
 */
export function formatIdentityOption(identity: Identity): string {
  const name = (identity.displayName || '').trim()
  const email = (identity.email || '').trim()
  if (!email) return name
  if (!name || name.toLowerCase() === email.toLowerCase()) return email
  return `${name} <${email}>`
}
