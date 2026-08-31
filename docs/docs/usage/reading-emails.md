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

### Unread Status of a Thread Row

A thread row in the message list is shown as unread (bold) whenever **any** message inside the thread that is currently shown in the list is unread — not only the newest one. This way, an unread message buried in the middle of a conversation is never invisible in the list, even though the newest message in that same thread has already been read.

Clicking an unread thread opens the **oldest unread message** in the thread as the active expanded card. If every message in the thread has already been read, clicking it opens the thread's lead message instead — with the default sort by date, that is the newest message.

Opening a message this way does not mark the rest of the thread as read. Marking every message in a thread as read remains a separate, explicit action -- see **Mark thread read** in [Thread Actions](#thread-actions) below.

### Thread View — Stack of Cards

Threads with two or more messages are displayed as a vertical stack of cards. Cards are ordered **newest to oldest** by default. The active expanded card is whichever message you opened — the oldest unread message for a thread with unread messages, or the thread's lead message for a fully read thread; the rest remain collapsed.

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
- **Delete thread** -- decided per folder: any message that can still be moved to Trash is moved there immediately. Any message that is already in Trash, or belongs to an account with no Trash folder, is covered by a confirmation dialog before permanent deletion instead. A thread confined to one folder takes exactly one of those two paths, as before; a thread whose messages span more than one folder (for example, one reply already filed in Trash alongside the rest of the conversation) can take both at once -- the movable messages are moved, and the confirmation dialog covers only what's left.
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

If the daily AI budget has been reached, no AI provider is configured, or the provider returns a transient error, the strip shows an inline message explaining why instead of a summary. A **Retry** button appears when the failure was a transient provider error.

### Instant Reply

When Instant Reply is enabled for the account, an **Instant Reply** button appears on the actively open message card. Click it to have the AI draft two or three short reply options based on the message content.

Click a draft option to open it in a **new compose window**, pre-filled with that text -- nothing is sent automatically, you still review and send it yourself.

Instant Reply is **off by default** and must be turned on **per account** in **Settings > AI > Instant Reply**. See [AI Assistant](../ai-assistant#instant-reply) for how to enable it and what it sends to your AI provider.

## Message Translation

MailCopilot can translate the message you are reading into a language of your choice.

Message Translation is **off by default** and must be turned on **per account** in **Settings > AI > AI Translate** (check **"Allow translating received messages and your own drafts with AI"**). The same setting also turns on [Draft Translation](../ai-assistant#draft-translation) for drafts you write in the compose window -- see [AI Assistant](../ai-assistant#message-translation) for how to enable it and what it sends to your AI provider.

### Using It

Click **Translate** above the message body, then pick a target language from the **Translate into** list. MailCopilot calls your configured AI provider only at that moment -- there is no automatic translation when you open a message, so opening a foreign-language email never spends your AI budget on its own.

Once a translation is shown, a **Show original** / **Show translation** toggle above the body lets you switch back and forth at any time. The stored message itself is never changed -- the translation is only ever a view on top of it.

**HTML messages are translated from their plain-text version.** The translation is always shown as plain text, even for an HTML message -- formatting, layout, and inline images are not part of it. A caption above the translated text says so explicitly: "Translated from the plain-text version of the message, so its formatting and images are not part of the translation."

### Detected Source Language

Before translating, MailCopilot tries to identify the message's original language on your device and, when it succeeds, names it in a caption above the translation (for example, "Machine translation from Russian into English. The original is one click away."). Detection is local and is used only as a label -- it never decides whether the message can be translated.

The caption is correctable either way, not only when detection fails. If the language cannot be identified with enough confidence, MailCopilot translates anyway and simply shows no source caption, offering a **Language of this message** picker (placeholder: **Choose a language**) so you can name it yourself. If a caption IS shown but names the wrong language -- local detection can confidently mislabel closely related languages -- a **Not the right language?** link next to it opens the same picker. Either way, naming the language is optional and only relabels the translation already on screen from the cache; it never calls the provider again.

### Translation Cache

A message's translation into a given language is cached locally on your device, keyed to the message's own content, the target language, and the version of the translation contract (provider, model, and prompt shape) that produced it -- reopening the same message and choosing the same language again reuses the cached translation instead of calling the provider a second time, and a later change to how MailCopilot produces translations is addressed under a new key rather than an older contract's output being served as if it were current. The cache still has no separate expiry; the per-account cap below ages entries out instead. Each account keeps its 500 most recent translations; once that limit is reached, the oldest translations for that account are dropped to make room for new ones. Removing an account deletes that account's cached translations along with it.

### If Translation Is Not Available

MailCopilot names the specific reason translation could not be produced, rather than showing a generic error:

- Translation is turned off for this account.
- No AI provider is set up yet.
- The AI provider did not return a translation.
- There is no downloaded text for the message yet.
- The message is too long to translate in one go, and there is no way to translate only part of it -- the whole message counts toward the limit, including any earlier correspondence quoted inside it.
- The AI budget for this period is used up.

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
- **Move to folder** -- move the message to a specific folder (shortcut: **v**). Dragging a message onto a folder in the sidebar moves it out of its own source folder, so dragging from an **All folders** search result, or from a conversation whose messages live in different folders, moves each message from where it actually is rather than from whichever folder happens to be open.
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

## Very Large Messages

MailCopilot protects itself against pathologically large mail, but exactly which protection applies depends on how the message is opened.

**The 100 MB hard cap protects every full read of a message.** Whenever MailCopilot needs to read a message's raw content in full -- whether you are opening a copy already stored on your device, or MailCopilot is downloading one in full to keep it available offline -- a message larger than 100 MB (raw, as stored on the server) is not parsed at all. This covers the message body, its attachments, and any embedded calendar invite. Opening such a message shows a placeholder card built from whatever header facts are available -- sender, subject, and date when known -- and a note that the message is larger than the 100 MB limit, not an exact size; if the download itself was refused partway through, those header facts come from your already-synced message list rather than the message, and may be incomplete. There is deliberately no "open anyway" option: this is protection against out-of-memory crashes and pathological or malicious mail, not a size you are expected to hit in normal use. Most consumer mail providers reject messages around 20-50 MB before they ever reach your inbox, so hitting this limit should be extremely rare -- though not impossible, since some business mail systems (for example, Microsoft 365 with a raised organizational limit) can allow larger messages through. The message itself is untouched on the server -- you can open it in another mail client.

**The 1 MB "beginning shown" limit applies whenever MailCopilot reads a message through the full-message path used for offline access.** That includes messages opened from a copy already stored on your device, and also the very first time you open a message in an offline-enabled folder, when MailCopilot downloads the full message to show it -- even if your cache size limits then keep that copy from being saved to disk. This is the normal case for your Inbox, which keeps recent messages available offline by default, and for any other folder where you have turned on offline access (**Settings > Folders**, see [Offline Mode](../settings/folders-settings#offline-mode)). For these, if the decoded body is over 1 MB, only the beginning is shown: a banner below the text reads "Only the beginning of this message is shown." A **Show full message** button appears next to it. Attachments are still listed in full even on the truncated view. Click the button to re-read the message at a higher, but still finite, limit (8 MB) -- MailCopilot only does this when you explicitly ask for it. If even the raised limit is not enough to show the whole message, the banner stays but the button is replaced with a note that this is as much as MailCopilot will display.

**Messages opened straight from the server are not affected by the 1 MB / 8 MB limit above.** Folders where offline access is off -- the default for folders other than Inbox -- fetch a message's text straight from the server each time you open it, without first downloading and storing the whole thing. That fetch has its own, separate size limits on each piece it retrieves, well below the 100 MB hard cap. Opening a very large message this way does not show the placeholder or the "beginning shown" banner -- it simply may show less of a very large message without saying so.

## When a Message Cannot Load

If MailCopilot cannot fetch the message body, it shows a placeholder instead of a blank screen. There are three different reasons for this, and MailCopilot tells them apart rather than showing the same message for all of them. The rule it follows is that the placeholder states only what MailCopilot actually knows -- it will not name a cause it is guessing at:

**You asked to work offline.** You have Work offline turned on, so the server was never contacted, and the message body was never downloaded -- only its headers are in the local cache:

> "Message body is not available offline. Only headers are cached."

**The request ran out of time.** MailCopilot gives a body fetch 10 seconds before giving up. That budget is a stopwatch, not a diagnosis: it expires without learning why the fetch was slow. Background work -- syncing other folders, indexing message bodies for search -- using the connection to your mail server is the most common reason, but a slow server, a poor connection or an unusually large message produce exactly the same result. The message almost certainly exists on the server; MailCopilot just could not get to it in time:

> "The message did not load within the time allowed. That can happen when background work is using the connection, when the server is slow, or when the message is very large. You can try again."

**The load failed.** MailCopilot tried to load the message body and did not end up with it. This covers everything from a dropped network to a password the server no longer accepts, an unexpected certificate, or a mailbox that no longer exists -- and it also covers what happens *after* the message arrives, such as running out of disk space while saving it to the local cache. MailCopilot deliberately does not guess which of those it was, because the placeholder would be wrong more often than right; for the same reason it does not blame the mail server, which in the disk-space case did nothing wrong. Where the cause *is* known, you will see it named on a surface that can be sure of it: the **Sign in again** notice above the message list when your credentials stopped working, or the connection-security dialog when the server's certificate could not be trusted.

> "MailCopilot could not load the body of this message — only its headers are shown. You can try again."

A **Retry** button appears below the placeholder in all three cases, in the main window and in a standalone message window alike. Click it to attempt fetching the body again -- for a timeout, this is usually enough on the second try once the background work has cleared. If Work offline is on, or your credentials have expired, retrying will keep producing the same placeholder until you turn Work offline off or sign in again.

## Meeting Invitations

When a message contains a calendar invite (an `.ics` attachment using the iTIP protocol), MailCopilot displays an inline **Meeting invitation** card above the message body. No external calendar app or cloud service is required.

The card shows:

- **Event title** — the summary of the meeting.
- **When** — the start date and time. In most cases this is converted to and shown in your own device's timezone, regardless of which timezone the organizer used to send the invite; if the invite's timezone is different from yours, a caption underneath names the organizer's original timezone, so you can see at a glance that a conversion happened. Conversion isn't possible in two cases, and both fall back to showing the organizer's original time exactly as sent: when the invite specifies a timezone MailCopilot cannot resolve (some Outlook/Exchange invites use a Windows-style timezone name instead of a standard one) — here the caption still appears, naming which timezone the time is in; and when the invite carries no timezone information at all and no explicit UTC offset — here there is nothing for a caption to name, so none is shown, and the displayed time is simply the organizer's own numbers with no indication of which timezone they're in.
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

In account-folder views, archiving, marking as spam, or moving to Trash shows an undo bar at the bottom of the screen with a countdown timer. Click **Undo** to reverse the action before the timer expires. What decides eligibility is which messages the action actually moves, not which folders your original selection spanned: messages already in the target folder, or belonging to an account with no folder for that role, are set aside and handled separately rather than moved. The undo bar only ever covers a single source folder, so it appears only when the messages that are actually being moved all come from the folder you currently have open. A deletion can be mixed: messages that go to Trash get an undo bar if they meet that condition, while messages already in Trash, or belonging to an account with no Trash folder, are deleted permanently instead -- MailCopilot asks you to confirm before doing so, and waits for your answer rather than acting immediately. Cross-account actions, and any action where the movable messages still span more than one source folder -- for example a bulk action taken on an **All folders** search selection -- do not show an undo bar; that part of the action still happens immediately, folder by folder, it just cannot be undone as one step.
