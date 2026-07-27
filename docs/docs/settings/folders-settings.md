---
sidebar_position: 4
title: Folder Settings
---

# Folder Settings

Open **Settings > Folders** to configure how MailCopilot handles your email folders.

## Folder Role Mapping

MailCopilot needs to know which server folder corresponds to each special role (Archive, Trash, Sent, Drafts, Spam). It automatically detects these based on standard IMAP attributes, but you can override the mapping manually.

For each role, you can:
- Leave it as **Auto** to use the automatically detected folder.
- Select a specific folder from the dropdown.
- Click **Create** to create the standard folder on the server if it does not exist.

## Folder Sync Policy

Below the role mapping, you will find a detailed policy configuration for each folder on your account:

### Visibility

- **Show in sidebar** -- whether the folder appears in the sidebar. Uncheck to hide folders you rarely use.

### Unread Badges

- **Include in unread badges** -- whether this folder's unread count is included in the total unread badge shown on the application.

### Search Indexing

- **Include in search** -- whether message bodies from this folder are indexed for full-text search. When disabled, the folder is still visible in the message list and its headers are searchable, but `body:` queries will not return results from it.

Junk, Spam, and Trash folders have search indexing turned off by default to avoid cluttering search results and reduce disk usage. You can enable it for any folder if needed.

### Header Sync Mode

Controls how message headers are synchronized for the folder:

- **All messages** -- sync all message headers (recommended for Inbox).
- **On open** -- sync headers only when you navigate to the folder.
- **By period** -- sync headers for the last N days only.

To stop synchronizing a folder entirely, hide it using the **Hide from sidebar** option in the folder context menu. Hidden folders are fully excluded from header sync, offline storage, and badges.

### Offline Mode

Controls whether message bodies are downloaded for offline reading:

- **Disabled** -- do not download bodies.
- **By period** -- download bodies for the last N days.
- **All messages** -- download all message bodies.

## Account Selection

If you have multiple accounts, use the account selector at the top to switch between accounts and configure folders for each one separately.
