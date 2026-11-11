/** RFC 5322 limits a line to 998 characters; a Message-ID longer than that is not one. */
export const SOURCE_MESSAGE_ID_MAX = 998

/**
 * The one definition of a usable Message-ID for a chat source: trimmed, 1..998 characters. Confirmation, storage
 * and reading back all go through it, so a source that is confirmed live is also one that survives a reload.
 */
export function normalizeSourceMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return id && id.length <= SOURCE_MESSAGE_ID_MAX ? id : null
}
