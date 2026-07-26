---
sidebar_position: 4
title: Identities
---

# Identities

A single mail account can have several **identities** -- alternate "From" addresses you send from. This is useful for Gmail or Microsoft 365 accounts where you have a primary address plus aliases (a personal alias, a team alias, an old vanity address) and want each one to have its own display name, signature, and Bcc rules without registering each as a separate IMAP account.

## What an Identity Contains

Each identity carries:

- A **display name** -- how the recipient sees you in the From header.
- An **email address** -- the actual address used as the From address. It must be an address the underlying account is authorized to send from.
- An optional **signature** -- replaces the per-account signature when this identity is selected. See [Signatures](./signatures) for how signatures interact with replies and forwards.
- An optional **default Bcc** -- automatically added to the Bcc field every time this identity is selected in Compose.
- A **default flag** -- exactly one identity per account is the default. The default identity is used when nothing more specific applies.

Every account always has at least one identity. When you sign in for the first time, MailCopilot creates a single default identity from the account name, email, and existing signature.

## Managing Identities

Open **Settings > Identities** and pick the account from the dropdown at the top. The tab shows the list of identities for that account with controls to:

- **Add** a new identity. Fill in display name, email, signature, and default Bcc; mark it as default if you want.
- **Edit** an existing identity to change any field.
- **Set as default** -- promote any identity to the default. Only one identity can be the default at a time.
- **Delete** an identity. The default identity cannot be deleted; promote a different identity to default first.

## Choosing an Identity in Compose

The compose window has an identity selector dropdown right below the account From dropdown. By default, MailCopilot picks an identity for you in the following order:

1. **Replies and forwards** -- match against the original message's From, To, and Cc addresses. The first identity whose email appears anywhere in that list wins, so the reply goes out from the same address you originally received the message at. Matching is case-insensitive on the full email; alias chains and plus-addressed variants are not matched and fall back to the default.
2. **New messages** -- the account's default identity is selected.

You can override the choice at any time by opening the dropdown and picking a different identity. Switching identity updates the From header. The signature is replaced only when the body is empty or contains nothing but a signature block after the standard `\n\n--\n` separator -- text you have typed above the separator is never overwritten. The Bcc field is replaced only when it is empty or still equals the default Bcc of the previously-selected identity, so a Bcc you typed by hand is preserved across identity switches.

## Relationship to Signatures

Signatures now live **per identity**, not per account. The **Settings > Signatures** tab edits the signature of the currently-selected account's default identity; non-default identities are edited under **Settings > Identities**. Accounts created before the multi-identity rollout keep their old per-account signature: MailCopilot reads the legacy signature through a synthesized default identity, so nothing breaks. The new identity list is written to disk the next time the account is saved (e.g., when you edit any account field).

## Sending and Audit

Whichever identity is active in Compose at send time is what shows up in the actual outgoing message:

- The SMTP / Microsoft Graph From header carries the identity's email and display name.
- Scheduled sends remember the identity selected at the time of scheduling, so a message scheduled from your alias still goes out as that alias when the timer fires.
