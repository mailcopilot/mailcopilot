---
sidebar_position: 5
title: Mail Rules
---

# Mail Rules

Mail rules let you automatically sort and organize incoming emails based on conditions you define. Rules are evaluated each time new messages arrive.

## Creating a Rule

1. Open **Settings > Rules**.
2. Click **Add Rule**.
3. Give your rule a name.
4. Choose which account the rule applies to (or select "All accounts").

### Conditions

Each rule has one or more conditions. All conditions must match for the rule to trigger (AND logic). If you need OR logic, create separate rules.

Available condition fields:
- **From** -- sender name or address.
- **To** -- recipient address.
- **CC** -- CC address.
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

Before saving a rule, click **Test on existing emails** to see which of your existing emails would match the conditions. This helps you verify that the rule works as expected before applying it to new mail.

## Applying to Existing Emails

Check **"Apply to existing emails in inbox"** when saving a rule to immediately apply it to emails already in your inbox.

## Rule Priority

Rules are evaluated in priority order (lower number = higher priority). You can adjust the priority when editing a rule. If two rules have the same priority, they are evaluated in creation order.

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
