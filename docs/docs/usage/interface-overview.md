---
sidebar_position: 1
title: Interface Overview
---

# Interface Overview

MailCopilot has a clean three-column layout designed for efficient email management.

## Sidebar

The sidebar is on the left side of the window. It contains:

- **Account selector** -- switch between connected email accounts by clicking the account avatar at the top.
- **Folder list** -- your email folders (Inbox, Sent, Drafts, Trash, Spam, Archive, and any custom folders). Each folder shows its unread message count as a badge.
- **Compose button** -- opens a new message window.
- **Sync button** -- manually triggers a synchronization with the mail server.
- **Settings button** -- opens the application settings.
- **Unified Inbox** -- if you have multiple accounts, this shows messages from all accounts combined in one view.
- **Work Offline** -- toggles offline mode on and off. When enabled, MailCopilot stops all network activity and works entirely from cached data. You can read emails that have been previously synced, mark them as read or starred, and browse folders. Changes you make offline will be synced when you go back online. The button icon switches between a Wi-Fi symbol (online) and a crossed-out Wi-Fi symbol (offline).
- **Inbox Zero** -- when you process emails (archive, delete, snooze, move to spam, or move to a folder) and your Inbox becomes empty, an "Inbox Zero!" congratulatory message appears in the message list area along with the count of emails you processed today. The counter resets automatically at midnight and on app restart.

The sidebar can be collapsed to a narrow icon-only mode by clicking the collapse button, giving more space to the message list and reading pane. Collapsed sidebar icons show tooltips.

## Message List

The middle column shows the list of messages in the currently selected folder. Each message displays:

- Sender name and avatar
- Subject line
- Date or time
- Unread indicator (bold text for unread messages)
- Star/flag indicator
- Attachment indicator (paperclip icon)
- Thread count (if conversation grouping is enabled)

In **Unified Inbox** mode, each message also shows the account email address next to the sender name, so you can tell which account received it.

### Filtering

Above the message list, you can:

- **Search** -- type in the search bar to find messages by sender, subject, or content.
- **Filter** -- use the filter chip buttons to show Unread, With Attachments, or Starred messages. Click a chip to activate the filter; click it again to deactivate. Selecting another chip replaces the previous filter.

To change the sort order (by date, sender, or subject), go to **Settings > Productivity > Sort emails by**.

### Message Context Menu

Right-click any message in the list to open the context menu. From here you can quickly:

- **Snooze** the message
- **Archive** it
- **Delete** it
- **Mark as read / unread**
- **Read Later**, **Pin**, **Move to folder**, **Mark as spam**, **Reply**, **Reply All**, **Forward**

For multiple selected messages, the context menu can mark read/unread, move, mark as spam, archive, or delete all of them at once. Read Later and Pin always apply to the single message you opened the menu on. Snooze applies to the whole thread when conversation grouping is enabled, otherwise to the single message. Reply, Reply All, and Forward are hidden in multi-select mode.

### Selecting Messages and Action Toolbar

- Click a message to select and read it.
- Hold **Shift** and click to select a range.
- Use the **x** key to toggle selection on individual messages.
- An action toolbar is always visible above the message list. When you select one or more messages, the toolbar buttons become active, allowing you to mark read/unread, mark as spam, archive, delete, and move messages. Move is disabled in Unified Inbox. The toolbar works in all other views.

## Reading Pane

The right column displays the content of the selected message:

- **Message headers** -- from, to, cc, date.
- **Message body** -- rendered as HTML in a secure sandboxed frame.
- **Attachments** -- listed below the message body with download buttons.
- **Action buttons** -- reply, reply all, forward, delete, archive, star, snooze, and more. In thread mode the toolbar becomes thread-aware: Reply/Forward target the newest message, Archive and Delete act on the whole thread. See [Reading Emails](./reading-emails#thread-actions) for details.

## Resizable Columns

You can resize the message list and reading pane by dragging the border between them. Your preferred width is remembered between sessions.

## Status Bar

A persistent status bar runs along the bottom of the window, similar to the one in VS Code. It surfaces background activity that previously was only visible inside the search panel:

- **Sync indicator** -- shows when a folder is currently being synchronized with the IMAP server, including the account, folder name, current message count, and a percentage where applicable.
- **Header coverage** -- how many folders have completed their initial header sync (for example, "Headers: 5/8 folders").
- **Body indexing progress** -- the percentage of cached messages whose body text has been indexed for full-text search.
- **Remote result badge** -- when a search returns extra hits from the server beyond the local cache, a "+N from server" badge appears here.

The status bar is always visible while sync or indexing work is in progress, not only during search. When there is nothing to report it collapses out of view automatically. The contents refresh roughly every 30 seconds in the background. The bar is hidden when printing.

## Notification Center

A bell icon in the mail list header opens the notification center. It collects two kinds of notifications:

- **Follow-up reminders** -- when a follow-up you set on a sent message becomes due (see [Composing Emails](./composing-emails) for details).
- **Send failures** -- when a message in the send queue gives up after permanent delivery errors (SMTP or, for Outlook accounts, Microsoft Graph).

The bell shows a small unread badge with the number of new notifications. Click the bell to open the dropdown panel, where you can read each notification, mark it as read, mark them all as read at once, or delete individual entries. Notifications are stored locally in the SQLite cache so they survive app restarts; entries older than 30 days are purged automatically.

When operating system notifications are allowed, the same events also raise a native desktop notification.

## Single Window

MailCopilot enforces a single running instance per user. If you launch the application a second time -- for example by clicking a `mailto:` link or another desktop shortcut -- the existing window is brought to the front and focused instead of opening a duplicate window. This avoids two parallel copies fighting over the same IMAP connections and local cache.

## mailto: Links and Default Email Client

You can register MailCopilot as the system handler for `mailto:` links so that clicking a "Send email" link in your browser, terminal, or another application opens the MailCopilot compose window with the recipient and any other parameters pre-filled.

The toggle to register MailCopilot as the default email application lives in **Settings > General**. Supported `mailto:` parameters include `to`, `cc`, `bcc`, `subject`, and `body`.

## Work Offline

The Work Offline button in the sidebar (Wi-Fi icon, crossed out when offline) toggles offline mode. When offline:

- All network activity stops -- no IMAP or SMTP connections are opened.
- You can still read previously synced messages, browse folders, mark messages as read or starred, and so on.
- Outgoing messages are queued in the Outbox and sent automatically when you go back online.
- Move and delete operations create local placeholders so the message appears to leave the source folder immediately, instead of staying visible until reconnect. The actual server-side move replays when the connection is restored, and the local placeholder is reconciled against the server result.
- Per-folder offline behaviour (whether bodies are downloaded for offline reading, and for what time window) is configured in **Settings > Folders**; see [Folder Settings](../settings/folders-settings).

## Light and Dark Themes

MailCopilot supports both light and dark themes. You can switch between them in **Settings > General > Theme**. The interface adapts automatically based on your choice.
