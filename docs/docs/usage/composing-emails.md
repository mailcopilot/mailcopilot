---
sidebar_position: 3
title: Composing Emails
---

# Composing Emails

## Writing a New Message

Click the **Compose** button in the sidebar (or press **c**) to open the compose window. The compose window opens in a separate window so you can continue browsing your inbox while writing.

## Message Fields

- **From** -- if you have multiple accounts, select which account to send from using the dropdown at the top. If the chosen account has more than one **identity** (alternate From address, for example an alias on the same Gmail or Outlook account), an identity selector dropdown appears just below the account dropdown letting you pick which identity to send as. See [Identities](../settings/identities) for how identities and per-identity signatures work.
- **To** -- enter the recipient's email address. You can add multiple recipients by pressing **Enter**, **Tab**, or **comma** after each address.
- **Cc / Bcc** -- click the **Cc/Bcc** button next to the To field to reveal the Carbon Copy and Blind Carbon Copy fields.
- **Subject** -- the subject line of your message.
- **Message body** -- write your message in the text area.

## Contact Autocomplete

As you type a recipient's email address, MailCopilot suggests contacts based on your previous correspondence. Click a suggestion to add it, or continue typing to narrow the list.

## Attachments

- Click the **Attach** button or drag and drop files onto the compose window to add attachments.
- Each attachment shows its filename. Click the **X** button to remove it.
- The maximum attachment size is 25 MB per file.

## Replying and Forwarding

- **Reply** (shortcut: **r**) -- opens a compose window pre-filled with the original sender as recipient and the quoted original message.
- **Reply All** (shortcut: **a**) -- same as Reply, but includes all original recipients.
- **Forward** (shortcut: **f**) -- opens a compose window with the original message quoted and "Fwd:" added to the subject. Inline attachments from the original message are preserved.

## Drafts and Autosave

MailCopilot automatically saves your draft as you type. Drafts are saved both locally and to your IMAP Drafts folder (if draft sync is enabled in settings).

If you leave a compose window open without sending and later return to it (for example, you switch to another window and come back), the draft you were writing is still there. Pressing **Compose** to start a *new* message always opens a blank window — local draft restoration does not happen on a fresh **Compose** click. Drafts you saved explicitly remain in the **Drafts** folder and on the IMAP server (when draft sync is enabled) and can be reopened from there.

## Sending

Click the **Send** button to send your message. The compose window closes immediately while the message is sent in the background. If there is an error (for example, a connection problem), you will see a desktop notification.

If the message is delivered successfully but MailCopilot cannot save a copy to the Sent folder (for example, if the IMAP server is temporarily unavailable), a toast notification appears: **Message delivered, but saving a copy to the Sent folder failed**. Click **Dismiss** to close it. The message was delivered to the recipient — only the server-side copy in the Sent folder was not saved.

## Send & Archive

When replying to an email, the **Send** button dropdown includes a **Send & Archive** option. Click the small **▾** arrow next to the Send button, then choose **Send & Archive**. This sends your reply and automatically archives the original email in one step.

This is especially useful for an inbox-zero workflow -- reply and clear the email from your inbox without extra clicks.

## Scheduled Sending

You can schedule a message to be sent at a later time:

1. Click the small **▾** arrow next to the Send button to open the dropdown menu.
2. Choose a preset time:
   - **Later today** -- the next half-hour mark.
   - **Tomorrow morning (09:00)**.
   - **Monday morning (09:00)**.
   - **Pick date and time** -- choose a custom date and time.
3. The message will be queued and sent automatically at the scheduled time.

Scheduled messages appear in the **Outbox** folder, where you can edit, reschedule, send immediately, or cancel them.

## Send Delay (Undo Send)

If you enable a send delay in **Settings > Productivity > Send delay**, every sent message will be held for the configured number of seconds (5, 10, or 30) before actually being sent. During this time, you can undo the send.

## Using Templates

Templates let you quickly insert pre-written messages into the compose window, saving time for messages you send frequently.

### Applying a Template

1. Open the compose window.
2. Click the **Templates** button (grid icon) in the toolbar.
3. Select a template from the dropdown.
4. The template's subject and body are inserted into the compose window.

### Template Variables

Templates can include variables that are automatically replaced when applied:

- `{name}` -- the recipient's name (if available).
- `{email}` -- the recipient's email address.
- `{date}` -- today's date.

For example, a template body like "Dear `{name}`, ..." will have `{name}` replaced with the actual recipient's name.

To create and manage templates, go to **Settings > Templates**. See the [Templates Settings](../settings/templates) page for details.

## Compose Quick Actions

A small AI toolbar appears above the message body with four buttons: **Improve**, **Shorter**, **Formal**, and **Fix grammar**. Click one to have the AI rewrite the text you wrote yourself -- the quoted message you are replying to, any forwarded-message header, and your signature are left untouched, for replies, forwards, and signatures that MailCopilot itself produced, and for the widespread quoting conventions other clients follow. **A draft composed in a different mail client may quote in a style MailCopilot does not recognize -- on such a draft no boundary is found, the whole body counts as your own text, and the quoted part is rewritten right along with it.** See [Compose Quick Actions](../ai-assistant#compose-quick-actions) for exactly which quoting styles are and are not recognized.

MailCopilot shows a **Review AI rewrite** panel: your own text and the rewrite appear together as one merged, scrollable passage with the edits marked in place -- removed words struck through, added words highlighted -- plus a list of the individual edits below it; plain **Before** / **After** copies stay available by expanding **Plain text**. Choose **Replace** to swap your own text with the rewrite (the quoted message and signature underneath are carried through unchanged when a boundary was found, as described above), **Insert at cursor** to insert it at your current cursor position, or **Cancel** to discard the rewrite and keep your draft unchanged. The body is only modified if you choose **Replace** or **Insert at cursor** -- **Cancel** leaves your draft exactly as it was.

Quick Actions requires an AI provider to be configured (see [AI Assistant](../ai-assistant)) and needs some text of your own, written above any quoted message, to rewrite. See [Compose Quick Actions](../ai-assistant#compose-quick-actions) for the full behavior and privacy details.

## Draft Translation

If [Draft Translation](../ai-assistant#draft-translation) is enabled for this account, a **Translate the draft into** language picker and a **Translate** button appear next to the AI toolbar above. Pick a target language -- or keep the suggestion MailCopilot may have pre-filled when you are replying, the detected language of the message you are answering -- and click **Translate**. The result appears in the same **Review AI rewrite** panel used above, with **Replace**, **Insert at cursor**, and **Cancel**; nothing is inserted into your draft on its own. Only the text you wrote yourself is translated -- the quoted message, forwarded header, and signature are left untouched, when a boundary is found: this uses the same detection as Quick Actions above, so a draft composed in a different mail client with an unrecognized quoting style has no boundary found and gets translated whole, quoted text included. Draft Translation shares the same account setting as reading-side message translation; there is nothing extra to turn on. See [Draft Translation](../ai-assistant#draft-translation) for the full behavior and privacy details.

## Misdirection Warning

MailCopilot helps prevent accidentally sending emails to the wrong people. Before sending, it checks the recipient list and warns you in two situations:

- **External domain** -- if the majority of recipients share one domain (e.g., @company.com) and you added someone from a different, untrusted domain, a confirmation dialog appears.
- **New recipients in reply** -- when replying, if you added recipients who were not part of the original conversation, a warning is shown.

You can add trusted domains (that should not trigger warnings) in **Settings > Productivity > Trusted domains**.

## Signature

If the active identity (the default identity if you haven't picked another one) has a signature configured in **Settings > Signatures** or **Settings > Identities**, it is automatically appended to new messages. Signatures are not added to replies and forwards.

## Follow-up Reminders

Follow-up reminders help you track emails that need a reply. If you send an important message and don't receive a response, MailCopilot will remind you.

### Setting Up a Follow-up

1. In the compose window, check the **"Remind if no reply"** checkbox at the bottom.
2. Choose a reminder period: **2 days**, **3 days**, or **7 days**.
3. Send the message as usual.

If no reply is received within the chosen period, you will get a desktop notification reminding you to follow up.

### The Follow-ups Folder

Pending follow-ups appear in the **Follow-ups** folder in the sidebar (clock icon with a check mark). The folder badge shows the number of pending reminders.

Each follow-up shows:
- The recipient's address.
- The subject of the original message.
- How long ago the reminder was due.

### Dismissing a Follow-up

When you no longer need a reminder (for example, the person replied outside of email), click the **Dismiss** button next to the follow-up to remove it.
