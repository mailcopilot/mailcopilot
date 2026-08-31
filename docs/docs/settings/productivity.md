---
sidebar_position: 2
title: Productivity Settings
---

# Productivity Settings

The Productivity tab in Settings contains options to help you manage your inbox more efficiently.

## Desktop Notifications

Enable or disable desktop notifications for new incoming mail. When enabled, MailCopilot notifies you about new mail that arrives in a folder counted toward the [unread badge](general#unread-badge) -- by default your Inbox, plus any folder you have explicitly included in badges -- and only if that folder is set to full or periodic header synchronization. On top of that, MailCopilot skips a fixed set of folders by default -- Trash, Junk, Archive, and Drafts -- even if you have explicitly included one of them in the badge; this narrows notifications further and never widens them beyond the badge policy. Folders excluded from the badge, or synced on demand only, never produce a notification even when new mail arrives there.

While the MailCopilot window is focused, no notification is shown for new mail: the badge and message list update as usual, but the arrival is not interrupted with a toast, since you are already looking at the app. If several messages arrive in a short window while the app is in the background, MailCopilot shows a single notification per account (for example, **5 new messages**) instead of one toast per message -- two accounts receiving mail at the same time still produce two separate notifications; clicking a notification opens that message. On unsigned macOS builds, the operating system may not allow notifications to be shown at all.

## IMAP IDLE (Push Updates)

When enabled, MailCopilot maintains a persistent connection to your mail server and receives instant notifications about new messages (IMAP IDLE protocol). This means new mail appears almost immediately without waiting for the next sync cycle.

Disable this option if you prefer to sync manually or if your server does not support IMAP IDLE.

## Sync Interval

Choose how often MailCopilot automatically checks for new messages (1, 2, 5, 10, 15, or 30 minutes). If IMAP IDLE is enabled, the sync interval serves only as a fallback — new messages arrive instantly via push. Set a longer interval to reduce server load.

## Draft Synchronization

When enabled, drafts you write in the compose window are automatically saved to your IMAP Drafts folder on the server. This allows you to access your drafts from other email clients as well.

## Always Load External Images

By default, external images in emails are blocked for privacy. Enable this option to always load external images without the privacy banner.

## Sender Photos (Gravatar)

When enabled (the default), MailCopilot shows profile photos next to sender names in the message list. Photos are loaded from [Gravatar](https://gravatar.com) — a free service that links an avatar to an email address. If a sender does not have a Gravatar profile, a colored circle with their initials is displayed instead.

Disable this option if you prefer initials-only avatars or want to avoid external network requests when browsing your inbox.

## Dark Mode for Email Content

When using the dark theme, email HTML content can be hard to read because many emails are designed for a white background. Enable this option (on by default) to automatically invert the colors of email content in dark mode, making it comfortable to read.

Images, videos and other media are kept in their original colors -- only the text and background are inverted.

## Sort Order

Choose how the message list is sorted:

- **By date** (default) -- newest messages first.
- **By sender** -- alphabetically by sender name.
- **By subject** -- alphabetically by subject line.

## Auto-advance

Choose what happens after you archive, delete, or snooze a message:

- **Open older email** (default) -- automatically opens the next older message in your list, just like Gmail.
- **Open newer email** -- opens the next newer message instead.
- **Return to list** -- closes the message detail and goes back to the message list.
- **Stay (do nothing)** -- keeps the current view with no active message.

This setting works especially well with [Send & Archive](../usage/composing-emails#send--archive) for an inbox-zero workflow.

## Conversation Grouping

When enabled, related messages (replies and forwards) are grouped into conversation threads. This makes it easier to follow email discussions. Disable this option if you prefer a flat message list.

## Keyboard Shortcuts Preset

Choose between two shortcut presets:

- **Gmail** -- shortcuts follow Gmail conventions (e.g., **e** for archive, **#** for delete).
- **Outlook** -- shortcuts follow Outlook conventions.

See the [Keyboard Shortcuts](../keyboard-shortcuts) page for a complete list.

## Send Delay

Add a delay before messages are actually sent after you click Send:

- **Off** -- messages are sent immediately.
- **5 seconds** / **10 seconds** / **30 seconds** -- the message is held in the Outbox for the specified time. During this time, you can undo the send.

This acts as a safety net, giving you a chance to catch mistakes right after hitting Send.

## Offline Mode

Download messages for reading without an internet connection. Offline mode is configured **per folder** in the [Folders](folders-settings#offline-mode) tab — you can enable it for Inbox, Sent, or any other folder individually.

The Productivity tab contains only the global size limit:

- **Max message size** — skip messages larger than this size (0 = no limit, in KB).
- **Sync now** — manually trigger an offline sync across all enabled folders.

When you open a message while offline, MailCopilot shows the cached headers (subject, sender, date) and an indicator that the message body is not available. Once you reconnect, the full message loads normally.
