---
sidebar_position: 3
title: Signatures
---

# Signatures

## Setting Up a Signature

Open **Settings > Signature** to create or edit your email signature. The Signatures tab edits the signature of the selected account's **default identity**. If you have multiple accounts, pick the account from the dropdown at the top; if the account has additional identities (alternate From addresses), each identity has its own signature -- those are edited under **Settings > Identities**.

## Writing Your Signature

Enter your signature text in the text area. A common format includes:

```
--
John Smith
Software Engineer
ACME Corp.
john.smith@example.com
```

The separator `--` is a standard email signature delimiter recognized by most email clients.

## How Signatures Work

- Your signature is **automatically appended** to new messages when you open the compose window.
- Signatures are **not** added to replies and forwards to avoid duplication.
- If you edit a draft that already has a signature, the existing signature is preserved.
- Each account's default identity can have its own unique signature; additional identities each have their own signature, edited under **Settings > Identities**.

## Removing a Signature

To remove a signature, simply clear the text area in **Settings > Signature** and save.

## Signatures and Identities

Signatures now live per **identity**, not per account. The **Signatures** tab on this page edits the signature for the account's default identity. If you have additional identities (other From addresses on the same account, for example a personal alias or a team alias), each identity has its own signature -- edit them under **Settings > Identities**. See [Identities](./identities) for how identities work and how Compose chooses one when you reply or write a new message.
