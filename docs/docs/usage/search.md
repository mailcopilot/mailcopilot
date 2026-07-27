---
sidebar_position: 5
---

# Search

MailCopilot provides powerful search capabilities to help you find any email across all your accounts and folders.

## Basic Search

Type in the search bar at the top of the mail list to search across your messages. Results appear instantly as you type.

## Search Scope

When searching, you can choose the scope using the chips below the search bar:

- **Current folder** -- search only in the folder you're viewing.
- **All folders** -- search across all folders of the current account.
- **All accounts** -- search across all connected accounts and folders.

## Search Operators

Use operators for precise searches:

| Operator | Description | Example |
|----------|-------------|---------|
| `from:` | By sender | `from:alice@example.com` |
| `to:` | By recipient | `to:bob@example.com` |
| `subject:` | By subject | `subject:meeting` |
| `body:` | By message body | `body:invoice` |
| `filename:` | By attachment name | `filename:report.pdf` |
| `is:unread` | Unread messages | `is:unread` |
| `is:starred` | Starred messages | `is:starred` |
| `has:attachment` | With attachments | `has:attachment` |
| `before:` | Before a date | `before:2026-01-01` |
| `after:` | After a date | `after:2025-12-01` |

Combine operators with free text: `from:alice subject:report is:unread`.

Use `-` to negate: `-from:spam@example.com` excludes messages from that sender.

## Search Completeness

MailCopilot searches your local email cache. The completeness indicator below the search bar shows:

- **Headers coverage** -- how many folders have been synced (e.g., "Headers: 5/8 folders synced").
- **Full-text indexing** -- percentage of messages with body text indexed for `body:` searches.

Standard folders (Inbox, Sent, Archive, Drafts) are fully indexed by default. Junk, Spam, and Trash folders are excluded from full-text indexing by default to keep search results clean and reduce disk usage. You can change the indexing setting for any folder via right-click in the sidebar or in **Settings > Folders**.

## Server-Assisted Search

When searching in a specific folder, MailCopilot may also query the IMAP server to find messages not yet in the local cache. Server results are marked with a "+N from server" badge.

Server search supports basic operators (`from:`, `to:`, `subject:`, `before:`, `after:`) but not advanced operators like `body:`, `filename:`, `is:`, or `has:`.

## Relevance Ranking

Search results are ranked by relevance. Matches in the subject line rank higher than matches in the message body.
