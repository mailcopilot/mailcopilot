---
sidebar_position: 4
title: Folders
---

# Folders

## Navigating Folders

Your email folders are displayed in the sidebar. Click on any folder to view its messages. The folder list is organized with special folders at the top, followed by custom folders in alphabetical order.

You can quickly jump to common folders using keyboard shortcuts:
- **g** then **i** -- go to Inbox
- **g** then **s** -- go to Sent
- **g** then **d** -- go to Drafts
- **g** then __*__ -- go to Starred messages
- **g** then **r** -- go to Read Later

## Special Folders

MailCopilot recognizes the following special folders:

| Folder | Description |
|--------|-------------|
| **Inbox** | Your incoming messages. |
| **Sent** | Messages you have sent. |
| **Drafts** | Unsent message drafts. |
| **Trash** | Deleted messages. Messages can be permanently deleted from here. |
| **Spam** | Messages marked as spam. |
| **Archive** | Archived messages that you want to keep but remove from Inbox. |
| **Outbox** | Messages scheduled for delayed or timed sending. |
| **Snoozed** | Messages you have snoozed. They will reappear when the snooze time expires. |
| **Follow-up** | Emails with follow-up reminders set. Shows pending reminders for emails awaiting a reply. |
| **Read Later** | Emails bookmarked for later reading. Unlike snoozed messages, they remain in their original folder. |

MailCopilot automatically detects which server folder corresponds to each special role. You can override this mapping in **Settings > Folders** if needed.

## Moving Messages Between Folders

You can move messages between folders in several ways:

- **Drag and drop** -- drag a message from the list and drop it on a folder in the sidebar.
- **Right-click context menu** -- right-click a message and choose **Move to folder**.
- **Keyboard shortcut** -- press **v** to open the folder selection dialog, then choose the target folder.
- **Action buttons** -- use the Delete, Archive, and Spam buttons to move messages to the corresponding special folders.

## Folder Context Menu

Right-click on a folder in the sidebar to access folder options:

- **Sync all headers** / **Sync on open** -- control how the folder's headers are synchronized.
- **Include in search** / **Exclude from search** -- toggle whether message bodies in this folder are indexed for full-text (`body:`) search. Junk, Spam, and Trash folders have this turned off by default.
- **Show/Hide in unread badges** -- toggle whether this folder's unread count is included in the total badge.
- **Show/Hide in sidebar** -- control folder visibility.
- **Change icon** -- set a custom emoji or icon for the folder.
- **Rename folder** -- rename the folder on the server.
- **Delete folder** -- remove the folder from the server (requires confirmation).

## Unread Badges

Each folder displays a badge with its unread message count. Snoozed messages are automatically excluded from these counts -- they will not inflate your unread badges while they are snoozed.

You can customize which folders show unread badges:

- Right-click a folder and select **Show in unread badges** or **Hide from unread badges**.
- Or configure this in **Settings > Folders** under folder sync policy.

## Permanent Deletion

When you delete a message from the Trash folder, it is permanently deleted. A confirmation dialog will ask you to confirm before permanent deletion, as this action cannot be undone.
