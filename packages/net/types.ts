// Re-export all types from @mailcopilot/types for backwards compatibility.
// New code should import directly from '@mailcopilot/types'.
export type {
  ImapConfig,
  SmtpConfig,
  AccountConfig,
  AutoconfigResult,
  AccountMeta,
  Identity,
  Mailbox,
  FolderHeaderSyncMode,
  FolderOfflineMode,
  FolderPreference,
  FolderRoles,
  TlsPin,
  MailSummary,
  MailAddress,
  MessageEnvelope,
  AttachmentMeta,
  MessageDetails,
  // §2.145 — two-tier parse caps.
  MessageParseCap,
  UnsubscribeAttemptResult,
  ComposeAttachment,
  ComposeInit,
  // §2.22 — CalendarInvite used in main.ts e2e fixture helpers.
  CalendarInvite,
  CalendarInvitePublic,
  RsvpMethod,
} from '@mailcopilot/types'
