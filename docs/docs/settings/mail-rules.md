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
- **From** -- matches the sender's display name when the message has one, and only falls back to the sender's address if it doesn't. A rule aimed at an address can stop matching once that sender starts including a display name, so test the rule after setting it up and watch for it going quiet.
- **To** -- recipient address.
- **CC** -- present in the rule editor, but MailCopilot doesn't store the CC field for cached mail, so every message looks like it has an empty CC to a rule. That makes the condition behave unpredictably rather than simply not working: matching a specific address in CC never succeeds, but an exclusion-style operator like **does not contain**, or a regular expression that matches an empty string, matches *every* message instead. Don't use a CC condition in a rule that moves mail to Trash, marks it as spam, or moves it to another folder -- with the wrong operator it can act on your whole inbox.
- **Subject** -- the email subject line.
- **Has attachment** -- whether the email has attachments.

Available operators:
- **contains** / **does not contain** -- partial match.
- **equals** -- exact match.
- **starts with** / **ends with** -- prefix or suffix match.
- **matches regex** -- advanced pattern matching using regular expressions.

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

## Testing Rules

Before saving a rule, click **Test on existing emails** to preview which of your recent inbox mail would match its conditions. The preview checks up to 500 Inbox messages already downloaded to this device and lists up to 20 matches -- it's a quick sanity check, not an exhaustive search of your whole mailbox. For a rule scoped to a single account, that's your most recent mail; for a rule scoped to all accounts, the 500 checked are pulled from across your accounts but aren't necessarily the most recent overall. Older mail and mail not yet downloaded to this device aren't included.

## Applying to Existing Emails

Check **"Apply to existing emails in inbox"** when saving a rule to run it immediately against mail you already have. This reaches up to 1,000 Inbox messages already downloaded to this device -- for a single-account rule, your most recent such mail; for a rule scoped to all accounts, up to 1,000 pulled from across your accounts, not necessarily the most recent overall. It doesn't go further back into your mail history on the server, and it only covers the Inbox, not other folders. If one action fails, only that action is skipped -- any other actions in the same rule still run against that message, and the rest of the run still completes.

## New Mail Only

Rules act on new mail once it reaches your device, no matter which path brought it in -- a push notification, a periodic sync, or a page of mail newer than what you'd already seen. Which of those paths delivered a message used to matter and could make a rule miss it entirely; that gap is now closed. Scrolling back to load older pages doesn't feed those older messages into rules, though -- that's intentional, the same "no history scan" behavior described below, not a leftover gap.

That guarantee for new mail isn't absolute in every situation, though: a message whose action fails three attempts in a row (for example, because of a dropped connection) is given up on for good -- MailCopilot skips it and moves on in that folder, so a later restart won't bring it back. What a restart does reset is a count that hasn't reached three yet: if the app restarts before a message has failed three times in a row, the count starts over from zero, so an action that keeps failing for a reason that doesn't go away can stall a folder's processing indefinitely without ever actually reaching that three-attempt limit.

Rules also don't retroactively scan a folder's full history on their own. Every folder MailCopilot already knows about when it starts up gets a starting point right away, before any syncing happens -- an empty folder gets a starting point of zero, so its very first message is evaluated normally; a folder that already has cached mail gets a starting point past that mail, so the existing mail isn't swept in but anything arriving afterward is. A folder that only comes into existence after that startup moment -- newly created or newly subscribed -- is set up differently: nothing in it is evaluated until MailCopilot has synced it once, and only mail arriving after that first sync counts. The same fresh start happens if the server ever resets a folder's message numbering (rare, but it can happen after certain server-side migrations). Use **Apply to existing emails in inbox** (see above) if you want a rule to also evaluate mail you already have.

## Rule Priority

Rules run in priority order (lower number = higher priority). Priority is assigned automatically when you create a rule -- there's no control in the rule editor to change it at the moment. When two rules end up with the same priority, which one runs first is not defined.

## AI Rules

If you have an AI provider configured (see [AI Assistant](../ai-assistant)), you can also create AI-powered rules. AI rules process emails that don't match any static rule.

### How AI Rules Work

1. You write a prompt describing how to sort emails (e.g., "Archive newsletters, move recruiter emails to Jobs folder").
2. You choose which actions the AI is allowed to perform.
3. You set a daily budget limit to control costs.
4. The AI evaluates unmatched emails in batches. It automatically applies only reversible actions (archive, move, mark as read, star); trash and spam actions are recorded as pending previews you must apply yourself.

AI rule actions are logged so you can review which action was applied or proposed for each email.

### New AI Rules Start Disabled

A newly created AI rule is **off by default**. Toggle **Enabled** on the rule once you've reviewed its prompt and allowed actions to start applying it to incoming mail. This keeps a rule from acting on your inbox before you've confirmed it behaves the way you expect.

### Limit on Enabled Rules per Account

You can have at most **20 enabled AI rules per account** (global rules that apply to every account count toward each account's limit). If you try to enable a rule beyond this limit, the app shows a message and the rule stays off — disable another rule first. This bound keeps background triage fast and predictable: every enabled rule for an account is evaluated together in a single pass.

### Destructive Actions Require Review

Reversible actions -- archive, move to folder, mark as read, star -- are applied automatically when an AI rule matches. **Move to trash** and **Mark as spam** are never applied automatically: instead, the AI records the proposed action as a pending entry in the rule's action log. To carry out a proposed trash or spam action, you must open the entry and explicitly apply it -- nothing is deleted or marked as spam until you do. This prevents the AI from permanently removing mail from your inbox without your confirmation.

### Rules Only See Their Own Account

An AI rule scoped to a specific account only ever evaluates and acts on that account's mail. It never sees or affects messages in your other accounts.
