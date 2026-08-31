---
sidebar_position: 5
title: Mail Rules
---

# Mail Rules

Mail rules let you automatically sort and organize incoming emails based on conditions you define. Rules run whenever MailCopilot fetches mail from the server, not necessarily the instant a message arrives there.

## Creating a Rule

1. Open **Settings > Rules**.
2. Click **Add Rule**.
3. Give your rule a name.
4. Choose which account the rule applies to (or select "All accounts").

### Conditions

Each rule has one or more conditions. All conditions must match for the rule to trigger (AND logic). If you need OR logic, create separate rules.

Available condition fields:
- **From — address** -- matches only against the sender's email address. If a rule that moves, archives, deletes, or marks mail as spam filters on the sender at all, this is the only sender field MailCopilot allows it to use -- see below.
- **From — display name** -- matches only against the sender's display name, the free-text name that appears next to the address (e.g. "Jane Doe" in `Jane Doe <jane@example.com>`). Known limitation: if a sender's saved display name is textually identical to their own address, MailCopilot treats that sender as having no display name at all, so this condition won't match them -- match on **From — address** instead for that sender. MailCopilot won't let this field drive a rule that moves, archives, deletes, or marks mail as spam -- see below.
- **From — name or address (legacy)** -- the original combined field: it matches if *either* the display name or the address matches (**does not contain** is the exception -- see below). Its matching behavior changed when the field above was split into **From — address** and **From — display name**: it used to compare a single value -- the display name, falling back to the address only when the sender had no display name set -- so a rule on this field never matched a signed sender by address alone. It now always compares both the display name and the address together, so a rule already configured on this field may start matching messages it didn't before (and, for **does not contain**, may stop excluding messages it used to exclude). If you have existing rules on this field, review what they now match, especially any that move, trash, or mark mail as spam. It's no longer offered for new conditions -- see "Legacy field" below. **Does not contain** on this field is the exception: since it means "neither should match," it requires the text to be absent from *both* the display name and the address -- a rule like "does not contain example.com" will not match a message whose display name happens to include that text, even though the address doesn't.
- **To** -- recipient address.
- **CC** -- no longer offered when you add a new condition. MailCopilot doesn't store the CC field for cached mail, so a condition on it could never actually be checked, and depending on the operator it used to behave unpredictably rather than simply not working: matching a specific address in CC never succeeded, but an exclusion-style operator like **does not contain**, or a regular expression that matches an empty string, matched *every* message instead -- a rule meant to catch a handful of messages could empty an inbox. If a rule you configured before this change still has a CC condition, it keeps showing up in the rule editor with a warning that the condition can never be met, so the rule no longer matches anything and no longer runs -- and the rule list itself marks it with a **Not applied** badge, so you don't have to open the rule to notice (see "Rules Marked Not Applied" below). Opening it in the rule editor and saving is refused, and so is turning on **Apply to existing emails in inbox** for it, until you remove the CC condition or switch it to a supported field. You're not locked out of the rule while it's in this state, though: the checkbox next to it in the rule list still turns it off (or on) regardless, and deleting the rule from the list also always works.
- **Subject** -- the email subject line.
- **Has attachment** -- whether the email has attachments.

Available operators:
- **contains** / **does not contain** -- partial match.
- **equals** -- exact match.
- **starts with** / **ends with** -- prefix or suffix match.
- **matches regex** -- advanced pattern matching using regular expressions.

### Display Name Can Be Forged

A sender fully controls their own display name -- it's free text they set, not something a mail server verifies. That means a sender can set their display name to read exactly like an address, for example `user@example.com`, whatever address the message's `From:` header actually names. A rule such as "From — display name equals user@example.com" matches on that display name alone, independent of the address -- and so does the same condition on **From — name or address (legacy)**, since that field checks the display name too.

The address and the display name are stored and compared separately, so text a sender writes into the display name is never read as an address -- but that doesn't make the address trustworthy on its own: the sender writes the whole `From:` header, address included, so it's just as forgeable (see below). What the separation buys you is narrower: if a rule that moves, archives, deletes, or marks mail as spam filters on the sender, and that filter is on **From — display name** or the legacy field, MailCopilot refuses it -- a rule combining one of those fields with **Move to trash**, **Mark as spam**, **Archive**, or **Move to folder** cannot be saved. This is only about which field a *sender* condition uses; a rule that performs one of these actions without filtering on the sender at all -- by subject, recipient, or attachment, for instance -- is unaffected. If an existing rule already combines a sender-name field with one of these actions -- from before this restriction existed -- opening it in the rule editor and saving is refused, and so is running **Apply to existing emails in inbox** against it; the message names the field and the action that caused the refusal and points you to **From — address** instead. Until you fix it, that rule also stops matching new mail -- but not silently: the rule list marks it with a **Not applied** badge, so you don't have to open the rule to notice (see "Rules Marked Not Applied" below). **You're not locked out of the rule while it's in this state, though: the checkbox next to it in the rule list still turns it off (or on), and that keeps working regardless of the refusal -- it's the quickest way to stop a rule you can't otherwise save.** Deleting the rule from the list also always works. **Mark as read** and **Star** aren't affected by the restriction itself: neither can be used to destroy or hide mail, so a forged sender triggering one of those costs you nothing you can't undo, and both fields are still allowed to drive them.

Worth being precise about what **From — address** does and doesn't prove, since it's the field this restriction points you to: it isn't a guarantee that the message is genuinely from that address. It's read straight from the message's `From:` header, and MailCopilot doesn't cryptographically verify that header -- checking it against DKIM or DMARC signatures is separate work MailCopilot doesn't do yet -- so a message can still claim any address there, exactly as freely as it can claim any display name. What matching on it does give you is narrower but real: because the address and the display name are separate fields, a display name a sender typed to look like an address is never compared as one, so a forged display name can satisfy a **From — display name** condition but cannot, by itself, satisfy a **From — address** condition. Treat a match on **From — address** as "this address was claimed in the message," not as a verified identity.

### Legacy Field

**From — name or address (legacy)** is the original, undivided "From" field kept for rules that were configured on it before the split above. You can still open and edit a rule that uses it, but its matching behavior has changed since then -- see the note under "Conditions" above -- so it's worth reviewing what an existing rule on this field now matches, especially any that move, trash, archive, or mark mail as spam (see "Display Name Can Be Forged" above for why that combination is refused).

The important part is a one-way door in the rule editor: the legacy field only appears in the condition-field dropdown while a condition is still set to it. As soon as you switch that condition to any other field (including switching it and switching back), the legacy option disappears from the dropdown and there's no way to select it again through the interface -- you'd need to recreate the condition on **From — address** or **From — display name** instead. Decide before you switch, not after.

### Actions

When a rule matches, one or more actions are performed:

- **Archive** -- move to the Archive folder.
- **Move to trash** -- move to the Trash folder.
- **Move to folder** -- move to a specific folder you choose.
- **Mark as read** -- automatically mark the email as read.
- **Star** -- flag the email.
- **Mark as spam** -- move to the Spam folder.

### Stop Processing

If you enable **"Stop processing further rules"**, no additional rules will be evaluated after this one matches. This is useful when you have a catch-all rule and want to prevent it from overriding more specific rules.

## Rules Marked "Not Applied"

If a rule's conditions or actions can't be trusted to justify what the rule does, MailCopilot refuses to run it -- and marks it in the rule list instead of leaving it silently inert. The badge appears in place of the usual "N conditions, M actions" summary for that rule, whether the rule is enabled or disabled, so you don't have to open a rule to find out it isn't actually running.

- **Cannot be applied** -- the rule itself can't be read: some of its conditions or actions are missing pieces MailCopilot needs in order to run it, most often because whatever created it (for example an AI assistant asked to set up a rule) didn't finish writing it correctly. Opening the rule shows the same message, and its condition and action lists come up empty in the editor -- there's nothing to patch, only to rebuild from scratch.
- **Not applied** -- the rule is readable, but MailCopilot can't justify running it as written. This covers the two situations described above: a condition that matches a field MailCopilot doesn't store for cached mail (such as **CC**), which can never actually be checked; or a destructive action -- **Move to trash**, **Mark as spam**, **Archive**, or **Move to folder** -- gated on the sender's display name (**From — display name** or the legacy **From — name or address** field), which the sender can set to anything, so it can't justify the action (see "Display Name Can Be Forged" above).

If a rule qualifies for both verdicts, **Cannot be applied** takes precedence -- the badges never appear together, and only the unreadable-rule label is shown.

Hovering the pointer over either badge shows the one-line reason for the refusal as a tooltip; reaching the badge with the keyboard doesn't pop that tooltip up. For **Not applied**, the reason is also part of what a screen reader announces for the badge, and the badge itself is a button -- clicking it opens the rule in the editor so you can fix the condition or action causing it. **Cannot be applied** is only a label, not a button: there's nothing in the editor to point you at, so open such a rule with the edit (pencil) button on its row. A rule in either state stays in your list unchanged until you fix it -- the checkbox next to it still turns it on or off, and deleting it from the list still works, but the rule itself does nothing while it's marked this way.

## Testing Rules

Before saving a rule, click **Test on existing emails** to preview which of your recent inbox mail would match its conditions. The preview checks up to 500 Inbox messages already downloaded to this device and lists up to 20 matches -- it's a quick sanity check, not an exhaustive search of your whole mailbox. For a rule scoped to a single account, that's your most recent mail; for a rule scoped to all accounts, the 500 checked are pulled from across your accounts but aren't necessarily the most recent overall. Older mail and mail not yet downloaded to this device aren't included.

## Applying to Existing Emails

Check **"Apply to existing emails in inbox"** when saving a rule to run it immediately against mail you already have. This reaches up to 1,000 Inbox messages already downloaded to this device -- for a single-account rule, your most recent such mail; for a rule scoped to all accounts, up to 1,000 pulled from across your accounts, not necessarily the most recent overall. It doesn't go further back into your mail history on the server, and it only covers the Inbox, not other folders. If one action fails, only that action is skipped -- any other actions in the same rule still run against that message, and the rest of the run still completes. A rule with a condition MailCopilot can't check, or with the display name (or the legacy field) driving a moving or destructive action, is refused here too -- see "Conditions" above.

## New Mail Only

Rules act on new mail once it reaches your device, no matter which path brought it in -- a push notification, a periodic sync, or a page of mail newer than what you'd already seen. Which of those paths delivered a message used to matter and could make a rule miss it entirely; that gap is now closed. Scrolling back to load older pages doesn't feed those older messages into rules, though -- that's intentional, the same "no history scan" behavior described below, not a leftover gap.

That guarantee for new mail isn't absolute in every situation, though: a message whose action fails three attempts in a row (for example, because of a dropped connection) is given up on for good -- MailCopilot skips it and moves on in that folder, so a later restart won't bring it back. What a restart does reset is a count that hasn't reached three yet: if the app restarts before a message has failed three times in a row, the count starts over from zero, so an action that keeps failing for a reason that doesn't go away can stall a folder's processing indefinitely without ever actually reaching that three-attempt limit.

Rules also don't retroactively scan a folder's full history on their own. Every folder MailCopilot already knows about when it starts up gets a starting point right away, before any syncing happens -- an empty folder gets a starting point of zero, so its very first message is evaluated normally; a folder that already has cached mail gets a starting point past that mail, so the existing mail isn't swept in but anything arriving afterward is. A folder that only comes into existence after that startup moment -- newly created or newly subscribed -- is set up differently: nothing in it is evaluated until MailCopilot has synced it once, and only mail arriving after that first sync counts. The same fresh start happens if the server ever resets a folder's message numbering (rare, but it can happen after certain server-side migrations). Use **Apply to existing emails in inbox** (see above) if you want a rule to also evaluate mail you already have.

## Rule Priority

Rules run in priority order (lower number = higher priority). Priority is assigned automatically when you create a rule -- there's no control in the rule editor to change it at the moment. When two rules end up with the same priority, which one runs first is not defined.

## AI Rules

If you have an AI provider configured (see [AI Assistant](../ai-assistant)), you can also create AI-powered rules. AI rules process emails that don't match any static rule.

This is a different thing from asking the assistant, in chat, to create or edit a rule for you. When you do that, the assistant creates or edits a **static** rule -- the kind described above, with its own conditions and actions -- and every restriction described above applies in full: it can't create a condition on CC, since MailCopilot doesn't store it; it can't gate a rule that moves, trashes, archives, or marks mail as spam on the sender's display name, only on **From — address**; and if it hands back a rule MailCopilot can't apply for some other reason, the rule isn't saved -- ask it to try again, or build the rule yourself in the editor. An **AI rule**, covered in the rest of this section, is a different kind of rule entirely: instead of conditions, it's a prompt describing what you want in your own words, plus a list of actions you allow the AI to take.

### How AI Rules Work

1. You write a prompt describing how to sort emails (e.g., "Archive newsletters, move recruiter emails to Jobs folder").
2. You choose which actions the AI is allowed to perform.
3. You set a daily budget limit to control costs.
4. The AI evaluates unmatched emails in batches. It automatically applies reversible actions (archive, move, mark as read, star); for **Move to trash** or **Mark as spam**, it doesn't touch the email at all -- it records the proposed action as a log entry instead.

AI rule actions are logged so you can review which action was applied or proposed for each email.

An AI rule has no conditions to restrict, so the CC and sender-address rules described above for static rules don't apply to it -- there's nothing shaped like a condition for them to apply to. Its safeguard is different: you choose which actions it's allowed to take at all (see below); among those, every one applies automatically except **Move to trash** and **Mark as spam** -- see "Destructive Actions Require Review" below for what happens with those two instead.

### New AI Rules Start Disabled

A newly created AI rule is **off by default**. Toggle **Enabled** on the rule once you've reviewed its prompt and allowed actions to start applying it to incoming mail. This keeps a rule from acting on your inbox before you've confirmed it behaves the way you expect.

### Limit on Enabled Rules per Account

You can have at most **20 enabled AI rules per account** (global rules that apply to every account count toward each account's limit). If you try to enable a rule beyond this limit, the app shows a message and the rule stays off — disable another rule first. This bound keeps background triage fast and predictable: every enabled rule for an account is evaluated together in a single pass.

### Destructive Actions Require Review

Reversible actions -- archive, move to folder, mark as read, star -- are applied automatically when an AI rule matches. **Move to trash** and **Mark as spam** are never applied automatically: the email isn't touched, and the AI records the proposed action as an entry in the rule's action log instead, so nothing is deleted or marked as spam on the strength of an AI rule alone. There's no button to carry out a logged proposal from there -- if you agree with it, act on that email yourself the normal way (through the message list or its own context menu).

### Rules Only See Their Own Account

An AI rule scoped to a specific account only ever evaluates and acts on that account's mail. It never sees or affects messages in your other accounts.
