---
sidebar_position: 2
title: Reading Emails
---

# Reading Emails

## Viewing a Message

Click on any message in the message list to open it in the reading pane. The message body is displayed in a secure sandbox that protects you from potentially harmful content.

You can navigate between messages using the keyboard:
- **j** -- next message
- **k** -- previous message
- **o** or **Enter** -- open message
- **u** -- back to list

## Recipient Headers

The reading pane shows the **To**, **Cc**, and (for sent messages) **Bcc** headers above the message body. When a header field contains more than three addresses, MailCopilot collapses the overflow: the first three names are shown inline, followed by a **+N more** button where N is the number of hidden addresses.

Click **+N more** to expand the full list of recipients on multiple lines. Click the button again to collapse back to the summary view. You can also press **Esc** while the list is expanded to collapse it.

Hover over any recipient name to see a tooltip with the full `Name <email@host>` string. Keyboard users can Tab to each recipient chip and the **+N more** button; pressing **Enter** or **Space** on the button toggles the expanded state.

**Bcc privacy:** the Bcc row is shown only for messages you sent yourself. It is never displayed for received mail, so Bcc recipients of incoming messages remain private.

## External Images

For privacy protection, MailCopilot blocks external images in emails by default. When a message contains blocked images, you will see a banner:

> "External images are blocked for privacy protection."

Click **Show images** to load them for that specific message. If you prefer to always load images, enable **"Always load external images"** in **Settings > Productivity**.

## Quoted Text

When you receive a reply or a forwarded message, MailCopilot automatically collapses the quoted history so you only see the fresh content. The quoted portion is hidden behind a **Show quoted text** disclosure widget at the bottom of the message body.

Click **Show quoted text** to expand the full history inline. The collapse widget applies to **HTML emails only**: top-level and nested `<blockquote>` blocks are each folded independently using a native `<details>`/`<summary>` element — no JavaScript is required. MailCopilot also detects Outlook-style attribution patterns (`-----Original Message-----`, `On … wrote:`) when they immediately precede a `<blockquote>`, and folds those attribution lines together with their quoted block.

Plain-text emails currently render the original quoted history as-is without any collapse. This is a known limitation and is tracked for a future release.

If a message contains no quoted text, the widget does not appear.

## Conversation Threading

When conversation grouping is enabled (the default), related messages are grouped into threads. In the message list, threads with more than one message show a `+N` badge next to the subject — that is how many additional messages are in the thread; the tooltip shows the total. Click the thread in the message list to open the thread view in the reading pane.

### Thread View — Stack of Cards

Threads with two or more messages are displayed as a vertical stack of cards. Cards are ordered **newest to oldest** by default. The newest message — the one most recently received — is the active expanded card; older messages are collapsed below it.

- **Collapsed cards** show the sender's avatar, sender name, a smart-formatted date, and a short text snippet. If the message has no previewable text, the card shows **"(no preview)"**.
- Click any collapsed card to expand it. Click an expanded card again to collapse it. With one expanded card per thread, opening a different message replaces the previously expanded one.

Single-message threads and accounts with conversation grouping disabled continue to use the simple single-message viewer — the stack view only appears when there are two or more messages.

You can enable or disable conversation grouping in **Settings > Productivity > Group messages into conversations**.

### Conversation Order

By default, the newest message appears at the top of the card stack so you see the latest reply first — consistent with how new messages arrive in your inbox. You can switch to chronological order in **Settings > Productivity > Conversation order**:

- **Newest first** (default) — the most recently received message is at the top; older messages are below it.
- **Oldest first** — messages are ordered chronologically from top to bottom, with the newest message at the bottom of the stack.

The setting applies to all threads in the reading pane and takes effect immediately when you change it.

### Thread Actions

When viewing a thread with two or more messages, the single toolbar at the top of the mail viewer becomes thread-aware. There is exactly one toolbar — the same toolbar used for single messages — but its buttons adapt to thread semantics:

- **Reply** -- compose a reply to the sender of the most recent message in the thread.
- **Reply all** -- reply to all participants of the most recent message, excluding your account's primary address.
- **Forward** -- forward the most recent message to someone else.
- **Archive thread** -- moves the entire thread to the Archive folder. Disabled when no Archive folder is configured.
- **Delete thread** -- moves the entire thread to Trash when the account has a Trash folder. If the thread is already in Trash, or the account has no Trash folder, MailCopilot asks for confirmation before permanent deletion.
- **Mark thread read** -- marks all messages in the thread as read. This button appears only when at least one message in the thread is unread; it is hidden when the entire thread is already read.
- **Snooze** -- temporarily hides the **whole thread** and brings every message back at a chosen time. The snooze dialog is anchored on the most recent message, but all messages in the thread are snoozed together. Uses the same snooze options as individual messages. Hidden in the Drafts folder.
- **Mark as spam** -- in thread mode this opens a confirmation dialog asking whether to mark every message in the thread as spam. Spam is harder to undo than archive, so the extra prompt is intentional.
- **Star, Pin, Print, Open in window, Open in account** -- these buttons act on the currently active (expanded) message in the thread, not on the whole thread.

Reply, Reply all, and Forward target the most recent message in the thread. Archive thread, Delete thread, Mark thread read, and Snooze apply to all messages at once.

### Thread AI Summary

When you open a thread with **three or more messages**, and Thread AI Summary is enabled for the account, a one-line AI-generated summary appears above the stack of cards. Click it to expand five bullet points capturing the key points of the conversation. Click the summary line again to collapse it.

Thread AI Summary is **off by default** and must be turned on **per account** in **Settings > AI > Thread AI Summary**. See [AI Assistant](../ai-assistant#thread-ai-summary) for how to enable it and what it sends to your AI provider.

Shorter threads (fewer than three messages) never show the summary strip -- the stack is small enough to read directly. Only the thread you have actively opened is summarized; MailCopilot never summarizes threads in the background or across your whole mailbox.

Once a thread has been summarized, reopening it shows the cached summary instantly -- MailCopilot does not regenerate it unless the thread's messages change.

If the daily AI budget has been reached, no AI provider is configured (this also covers a configured **Claude subscription**, which is not supported for thread summary), or the provider returns a transient error, the strip shows an inline message explaining why instead of a summary. A **Retry** button appears when the failure was a transient provider error.

### Instant Reply

When Instant Reply is enabled for the account, an **Instant Reply** button appears on the actively open message card. Click it to have the AI draft two or three short reply options based on the message content.

Click a draft option to open it in a **new compose window**, pre-filled with that text -- nothing is sent automatically, you still review and send it yourself.

Instant Reply is **off by default** and must be turned on **per account** in **Settings > AI > Instant Reply**. See [AI Assistant](../ai-assistant#instant-reply) for how to enable it and what it sends to your AI provider.

## Working with Attachments

When the active message has attachments, they appear above the message body. Each attachment shows:

- A **file-type icon** chosen from the MIME type, with a fallback to the filename extension when the MIME type is missing, generic (`application/octet-stream`), or unrecognized: PDF, image, archive, document, spreadsheet, presentation, plain text, embedded `.eml` message, or a generic file icon when nothing more specific applies.
- The **filename**.
- The **file size**.

Layout images the message body already renders inline -- such as a logo in an HTML signature -- are never removed from the list. MailCopilot cannot reliably tell, from outside the browser, whether a given part actually ended up visible on screen -- layout, CSS, and responsive-image selection decide that -- so instead of guessing, it keeps every part reachable: real attachments (the files the sender actually attached) are listed first, and inline images the body rendered are demoted to the end of the list, behind the same expand toggle described below.

An expand toggle appears whenever there is more to show than fits collapsed -- more than four real attachments, or any demoted inline images, even if there are four or fewer real attachments. Click **Show more (N)**, where N counts only the items not currently visible, to reveal everything, and **Show less** to collapse the list again.

Click the download button on an attachment row to save it to your computer. The download button has an explicit accessible label so screen readers announce the action together with the filename.

## Links in Emails

When you click a link in an email, MailCopilot checks it for safety:

- **Mismatched links** -- if the link text shows one domain but the actual link goes to a different domain, a warning is displayed.
- **HTTP links** -- links using unencrypted HTTP trigger a warning.
- **IDN/Punycode domains** -- domains using internationalized characters are flagged.

For suspicious links, a confirmation dialog appears where you can see the actual destination and choose whether to open it or cancel.

### Right-Click a Link

Right-click a link in a message body to open a small context menu with:

- **Open Link in Browser** -- opens the link the same way clicking it does, including the safety checks above (mismatched-domain and HTTP warnings, IDN/punycode flagging). This item only appears in the main window and the standalone message window (see [Open in Window](#open-in-window)) -- it is not offered in Settings, Compose, or Account windows, since none of them display email links.
- **Copy Link Address** -- copies the link's actual destination to the clipboard, not its visible text, and never the internal routing form MailCopilot uses to render the link. For a web address (`http:`/`https:`) with an internationalized domain name, the address is copied in its punycode (ASCII) form -- the form your browser will actually use -- rather than the Unicode form, so a copied address cannot hide a lookalike domain behind readable characters. For a `mailto:` address, an internationalized domain is percent-encoded instead, since mail clients do not resolve it as a punycode host. Credentials embedded in a link (`https://user:pass@host/…`) are copied as-is, not stripped -- if you paste such a link elsewhere, the credentials go with it.

Neither item appears for links that are not `http:`, `https:`, or `mailto:` (for example a `javascript:` or `data:` link embedded in a message), or for a link address longer than 8192 characters.

## Message Actions

While reading a message, you can:

- **Reply** -- compose a reply to the sender (shortcut: **r**).
- **Reply all** -- reply to all recipients (shortcut: **a**).
- **Forward** -- forward the message to someone else (shortcut: **f**).
- **Star / Unstar** -- mark the message as important (shortcut: **s**).
- **Delete** -- move the message to Trash (shortcut: **#** or **Delete**).
- **Archive** -- move the message to the Archive folder (shortcut: **e**).
- **Mark as spam** -- move the message to the Spam folder (shortcut: **!**).
- **Mark as read / unread** -- toggle the read status (shortcuts: **Shift+I** / **Shift+U**).
- **Move to folder** -- move the message to a specific folder (shortcut: **v**).
- **Snooze** -- temporarily hide the message and have it reappear at a later time. See below for details.
- **Pin / Unpin** -- pin a message to the top of the message list. Pinned messages always appear first, regardless of sort order (shortcut: **p**).
- **Open in window** -- open the message in a separate standalone window, so you can read it side-by-side with other content.
- **Print** -- print the current email (shortcut: **Ctrl+P**).

## Open in Window

The **Open in window** action opens the current message in a dedicated standalone window. This is useful when you want to read or act on a message while keeping the main window free for browsing other folders.

The standalone window is a fully functional workspace. It includes a complete action toolbar at the top with all the actions you need:

- **Reply** -- compose a reply to the sender.
- **Reply all** -- reply to all recipients.
- **Forward** -- forward the message to another recipient.
- **Archive** -- move the message to the Archive folder. The button is disabled if no Archive folder is configured for the account.
- **Delete** -- move the message to Trash when the account has a Trash folder. If the account has no Trash folder, or the message is already in Trash, MailCopilot asks for confirmation before permanently deleting the message.
- **Star / Unstar** -- toggle the starred (flagged) status of the message.
- **Mark as read / Mark as unread** -- toggle the read status.
- **Print** -- print the message body.

When you click **Archive**, or **Delete** for a message that can be moved to Trash, the standalone window shows an inline undo banner for 3 seconds before MailCopilot performs the move and closes the window. Click **Undo** to cancel — the message stays put and the window remains open. While the undo banner is visible, the **Archive** and **Delete** buttons are disabled; **Reply**, **Reply all**, **Forward**, **Star / Unstar**, **Mark as read / Mark as unread**, and **Print** remain available.

If the account has no Trash folder, or the message is already in Trash, **Delete** asks for confirmation before permanently deleting it — no undo banner appears, and the action is irreversible.

The standalone window uses the same core protections as the main reading pane: sanitized HTML in a no-script sandboxed iframe, blocked remote images, and phishing warnings for links.

## Snoozing Messages

Snooze lets you temporarily hide a message and have it reappear at a chosen time, so you can deal with it when you are ready.

### How to Snooze

Right-click a message in the list and choose **Snooze** from the context menu.

### Snooze Options

Choose from preset times or set a custom date and time:

- **Later today** -- the next half-hour mark.
- **Tomorrow morning (09:00)**.
- **Next week (Monday 09:00)**.
- **Custom** -- pick any future date and time.

### The Snoozed Folder

Snoozed messages appear in the **Snoozed** folder in the sidebar. When the snooze time arrives, the message becomes visible again in its original folder and you receive a notification.

Click any snoozed message to open and read it without cancelling the snooze. To unsnooze a message early, click the **Cancel** button next to it.

## Read Later

Read Later lets you bookmark emails for later reading -- perfect for long newsletters, reference material, or anything you want to come back to when you have time.

### How to Add to Read Later

- Right-click a message and choose **Read Later** from the context menu.
- Or ask the AI assistant to mark an email for reading later.

### The Read Later Folder

Bookmarked messages appear in the **Read Later** folder in the sidebar (the book icon). Unlike snoozed messages, Read Later emails remain visible in their original folder -- the Read Later folder is an additional view, not a filter.

Click any message in the Read Later folder to open and read it. To remove a message from the list, click the **Remove from list** button next to it.

You can open the Read Later folder from the sidebar.

## When a Message Cannot Load

If MailCopilot cannot fetch the message body — for example because the connection to the IMAP server timed out (after 10 seconds) — it shows an offline placeholder instead of a blank screen:

> "Message body is not available offline. Only headers are cached."

A **Retry** button appears below the message. Click it to attempt fetching the body again. If the connection has been restored, the message will load normally.

## Meeting Invitations

When a message contains a calendar invite (an `.ics` attachment using the iTIP protocol), MailCopilot displays an inline **Meeting invitation** card above the message body. No external calendar app or cloud service is required.

The card shows:

- **Event title** — the summary of the meeting.
- **When** — the start date and time.
- **Organizer** — the organizer listed in the calendar invite (which may differ from the email sender if the invite was sent on behalf of someone else).
- **Location** — the meeting room or conference link, if provided.

Below the event details, three response buttons are available: **Accept**, **Tentative**, and **Decline**. Clicking any of them sends a standard iTIP reply email to the organizer via SMTP using your account credentials. The card then updates to confirm your choice (for example, "You accepted this invitation"). If the response cannot be sent, an error message is shown instead.

The Accept / Tentative / Decline buttons appear only for actionable meeting requests (`METHOD:REQUEST` invites) where the organizer is not you. Cancellations, calendar-feed publications, replies, and self-organized events do not show RSVP buttons — instead you will see a "cancelled" badge or a "not actionable" notice.

### Limitations in this release

- **No system calendar integration.** MailCopilot does not add the event to your operating system calendar (macOS Calendar, GNOME Calendar, etc.). Adding this is planned for a future release.
- **Recurring events.** Repeating meetings are shown as a single instance; the recurrence pattern is not displayed.
- **Counter-proposals.** You cannot propose a different time — only Accept, Tentative, or Decline are available.
- **Cancelled events.** When the organizer cancels a meeting, the card shows "This event has been cancelled" and the response buttons are hidden.

## Undo Actions

In account-folder views, archiving, marking as spam, or moving to Trash shows an undo bar at the bottom of the screen with a countdown timer. Click **Undo** to reverse the action before the timer expires. Permanent deletes and some unified or cross-account actions do not show an undo bar.
