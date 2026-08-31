---
sidebar_position: 7
title: FAQ
---

# Frequently Asked Questions

## General

### What is MailCopilot?

MailCopilot is a modern desktop email client that connects to your existing email accounts via IMAP and SMTP protocols. It is built for speed, privacy, and simplicity.

### Which platforms does MailCopilot support?

Currently, MailCopilot is available for **Linux** as an AppImage. Windows and macOS support is planned for future releases.

### Is MailCopilot free?

Visit [mailcopilot.io](https://mailcopilot.io) for the latest information about pricing and availability.

### Where are my passwords stored?

Passwords are stored securely in your system's keychain (via keytar). They are never saved in plain-text configuration files.

---

## Accounts

### Which email providers are supported?

MailCopilot works with any provider that supports IMAP and SMTP, including Gmail, Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (via Bridge), and self-hosted servers.

### How do I connect a Gmail account?

Click **Sign in with Google** in the account setup wizard. A browser window will open for authorization. No app password is needed.

### Can I use multiple accounts?

Yes. Add as many accounts as you need. You can switch between them in the sidebar or use the Unified Inbox to see all messages in one place.

### The connection test shows a TLS certificate error. What should I do?

MailCopilot always verifies TLS certificates, checking them against both the built-in Mozilla certificate bundle and your operating system's certificate store. If your mail server uses a self-signed or custom certificate, a trust prompt will appear. Review the certificate details and choose to trust it if you are confident the server is legitimate. If the fingerprint has not been read yet, the main button first reads **Read the certificate** -- click it, review what comes back, then click **Trust and continue** to confirm.

### My antivirus or corporate proxy inspects my mail connection. Will MailCopilot still work?

Yes. MailCopilot trusts your operating system's certificate store in addition to its built-in certificate bundle, so security software that inspects TLS traffic (for example antivirus products with HTTPS scanning) and corporate proxies no longer break mail sync. After your account's first successful sync in a session, MailCopilot checks once for this and, if found, shows a notice identifying the software or proxy responsible; this check runs at most once per server for the lifetime of your profile, so interception turned on for a server later, after this check already ran, will not be flagged. If the certificate later changes to one that can no longer be trusted at all (rather than being trusted only through the system store), MailCopilot shows a recovery dialog where you can review the new certificate's details and choose to trust it.

### My self-signed mail server stopped connecting after updating MailCopilot. Why?

Certificate pinning used to compare fingerprints only for certificates whose chain already verified normally; self-signed and private-CA certificates -- the exact case pinning exists for -- bypassed that fingerprint check entirely. That gap is now closed, which is a security improvement -- but if you pinned a self-signed or private-CA server before this change, the pin on file may not include the certificate needed to verify it, and that server will now fail to connect. Open the certificate recovery dialog that appears for it: if the button reads **Read the certificate**, click it first, then click **Trust and continue**; if **Trust and continue** is already showing, just click it. This saves the pin together with the certificate itself, and the account resyncs automatically. You only need to do this once per affected server. Adding or editing a pin manually in Settings does not fix this -- a manual pin can only narrow trust for a server that already has a normal, publicly-trusted certificate; for a certificate that is otherwise untrusted (self-signed, or from a private certificate authority not already in your OS trust store), only the recovery dialog can grant it trust.

If your server uses STARTTLS (typically IMAP port 143 or SMTP port 587), MailCopilot cannot capture its certificate this way -- only the fingerprint is stored, so a self-signed STARTTLS server will remain unable to connect. Use implicit TLS (typically port 993 for IMAP, 465 for SMTP) instead, if your server supports it.

---

## Messages

### How do I search for messages?

Click the search bar (or press **/***) and type your query. MailCopilot searches message subjects, senders, and content.

You can also use advanced search operators:

- `from:user@example.com` -- messages from a specific sender.
- `to:user@example.com` -- messages sent to a specific recipient.
- `subject:meeting` -- messages with a word in the subject.
- `has:attachment` -- messages with attachments.
- `is:unread` / `is:read` -- filter by read status.
- `is:starred` -- starred messages.
- `before:2026-01-01` / `after:2025-12-01` -- filter by date.
- `in:Sent` -- messages in a specific folder.
- Negate any operator with `-`: `-from:spam@example.com`.
- Combine conditions with `OR` or `AND` (case-insensitive): `from:alice OR from:bob`.

### Can I undo deleting a message?

In most cases, yes. After deleting, archiving, or marking a message as spam, an undo bar appears at the bottom of the screen. Click **Undo** before the countdown expires to reverse the action. Undo depends on which messages the action is actually moving, not on which folders your original selection came from: messages that are already in the target folder, or belong to an account with no folder for that role, are set aside and handled separately. The undo bar only ever covers a single source folder, so it appears only when the messages being moved all come from the folder you currently have open -- acting on a single message found via an **All folders** search, for example, does not show an undo bar if that message lives in a different folder. A deletion can be mixed: messages already in Trash, or belonging to an account with no Trash folder, cannot be moved and are deleted permanently instead, and MailCopilot waits for your confirmation before doing so -- but if the rest of the same deletion can still move to Trash, that part gets its own undo bar regardless. Cross-account actions, and any action where the movable messages still span more than one source folder, such as a bulk action on an **All folders** search selection, don't offer undo either -- see [Undo Actions](./usage/reading-emails#undo-actions) for details.

### How does conversation threading work?

When enabled (the default), related messages are grouped into conversation threads based on their subject and references. You can disable this in **Settings > Productivity > Group messages into conversations**.

### How do I move messages between folders?

You can drag and drop messages from the list to a folder in the sidebar, right-click and choose **Move to folder**, or press **v** to open the folder picker.

---

## Compose

### Where are my drafts saved?

Drafts are saved automatically in two places: locally in the application, and optionally to your IMAP Drafts folder on the server (if draft sync is enabled in settings).

### Can I schedule messages to be sent later?

Yes. Click the **Schedule** button in the compose window and choose when to send. Scheduled messages appear in the Outbox folder where you can edit or cancel them.

### What is the maximum attachment size?

The maximum size is 25 MB per file.

---

## AI Assistant

### Is the AI assistant required?

No. The AI assistant is entirely optional. If you do not configure it, no email data is sent to any AI service.

### What data does the AI assistant access?

When you use the assistant, the content of the currently selected email (and optionally the thread) is sent to the AI provider (Anthropic). A privacy notice is shown before first use.

### Which AI models are available?

You can choose between Claude Sonnet 4.5, Claude Opus 4.6, and Claude Haiku 4.5.

### Where can I see what the AI is doing with my data?

Open **Settings → AI** and expand the **Privacy & Audit** section. There you will find a full audit log of every AI action — timestamp, provider, model, goal, tool used, estimated cost, and the outcome. Token counts are recorded when the AI provider exposes them through the SDK; columns may show **n/a** when the provider does not surface per-request counts. You can also export the log as JSON or CSV.

For more details see [AI Data & Audit Log](./privacy/ai-data).

---

## Updates

### How do I update MailCopilot?

By default, MailCopilot does **not** download updates automatically. When a new version is detected, a **Download X.Y.Z** button appears in **Settings > About**. Click it to start the download, then click **Restart to install** when the download is complete.

To check for an update manually at any time, open **Settings > About** and click **Check for updates**.

To enable automatic background downloads, open **Settings > About** and check **Automatically download updates in the background**. When enabled, new versions download silently and you are prompted to restart when the update is ready.

MailCopilot can normally update itself in place on every platform it supports: an AppImage install replaces the `.AppImage` file itself, and a `.deb`/`.rpm`/pacman install lets the update mechanism attempt the write by requesting administrator privileges (`pkexec`/`sudo`), the same way `apt`/`dnf`/`pacman` would -- the actual outcome is decided by that privilege prompt and the package manager, not by MailCopilot.

Self-update can be unavailable in two different ways, and MailCopilot shows different controls for each:

- **The build isn't packaged** -- a development or CI build. There is no updater at all: the **Check for updates** button and the status area do not appear, and a note reads **"Updates are disabled in this build"** instead.
- **The build is packaged, but self-update is blocked** -- either because MailCopilot could not determine the directory it would need to update in place, or because that directory is not writable by your account. The first case happens on Linux when the app isn't running as a mounted AppImage (for example, an extracted AppImage or a raw `linux-unpacked` build) -- there is no directory to update. The second case means the folder holding a running AppImage isn't writable (a `.deb`/`.rpm`/pacman install is not affected, since those elevate privileges instead); on Windows and macOS it means the folder holding the installed executable isn't writable. In either case a warning explains why, the **Check for updates** button keeps working, and the auto-download checkbox stays available -- but the Download / Restart controls are hidden.

### Can I turn off automatic updates?

Automatic background downloads are off by default. If you have enabled the **Automatically download updates in the background** option and want to turn it off, open **Settings > About** and uncheck that option. MailCopilot will still notify you when a new version is available, but the download will not start until you click **Download**.

---

## Troubleshooting

### MailCopilot is not syncing new messages.

1. Check that **IMAP IDLE** is enabled in **Settings > Productivity**.
2. Try clicking the **Sync** button in the sidebar.
3. Verify your internet connection.
4. Check the account connection status in **Settings > Accounts**.

### The application is slow or unresponsive.

Try shortening the **Keep full message copy for** period in **Settings > General**. If you have very large folders, consider using the **By period** header sync mode in **Settings > Folders**.

### I cannot see some folders.

Some folders may be hidden. Right-click in the sidebar and look for hidden folder options, or go to **Settings > Folders** and check the **Show in sidebar** option for each folder.

### I closed the window and now I can't find MailCopilot.

With **Close window to tray** enabled, closing the window hides it behind the tray icon (provided MailCopilot managed to create it) -- click the icon to bring the window back. On some Linux desktops the icon may not be drawn at all, in which case there is nothing to click.

Either way, just start MailCopilot again. If it is still running with a hidden window, it brings that window back to the front instead of opening a second copy; if it had already quit, a fresh window opens.
