import { z } from 'zod'
import type { ComposeInit } from '@mailcopilot/types'
import type { ArchiveRef } from '../packages/db'

/**
 * Schema used for send queue payload rehydration on the cancel→edit path.
 *
 * Identical in shape to the main-process `sendMailOptionsSchema` (declared
 * alongside the IPC handler) but intentionally lives here so that the pure
 * queue→ComposeInit transform is testable without pulling in the Electron
 * module graph.
 *
 * If new optional fields are added to `SendMailOptions`, mirror them here
 * and extend `queueItemToComposeInit` to preserve them.
 */
export const queuedSendPayloadSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentBase64: z.string().min(1),
        contentType: z.string().min(1).optional(),
      }).strict(),
    )
    .optional(),
  // 2.3-B: identity the user picked when authoring the send. Preserved
  // through cancel→edit so the re-opened Compose starts on the same alias.
  identityId: z.string().min(1).optional(),
})

/**
 * Rehydrate a ComposeInit from a queued send's stored messageData. Keeps
 * every field the UI needs to re-edit the message, including the identity id
 * (codex HIGH-1 fix — without this, editing a cancelled scheduled send
 * silently falls back to the default identity).
 */
export function queueItemToComposeInit(raw: unknown, archiveRef?: ArchiveRef | null): ComposeInit {
  const parsed = queuedSendPayloadSchema.parse(raw)
  return {
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments,
    replyRef: archiveRef
      ? { accountId: archiveRef.accountId, folder: archiveRef.folder, uid: archiveRef.uid }
      : undefined,
    identityId: parsed.identityId,
  }
}
