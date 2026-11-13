---
sidebar_position: 3
title: Sender Photos (Gravatar)
---

# Sender Photos (Gravatar)

The option **Show sender photos (Gravatar)** is off on new installs. While it is off, MailCopilot makes no request to gravatar.com.

An installation updated from a version before 1.27.2 keeps the setting it had saved. Older versions turned the option on by default and wrote that value into the settings, so for most existing installs it is on. If you do not want it, turn it off as described below.

## What is sent when the option is on

For every sender address shown in the message list, the app requests a photo from `www.gravatar.com`. The request goes straight from your computer to Gravatar. No server operated by MailCopilot takes part in it, and it does not go through the proxy used for remote images in messages.

Gravatar receives:

- the SHA-256 hash of the sender's address (trimmed, lowercase). Anyone who knows an address can compute its hash and match it against the request;
- your IP address and the time of the request;
- the usual headers of a browser request, including a User-Agent that contains the application name and version.

The request carries no Referer header. Gravatar does not receive message text or subjects. Addresses of your own accounts and identities are skipped in the message list, so their hashes are not sent from there.

The app remembers in memory which senders have no photo. Photos Gravatar returns are also stored in the Chromium HTTP cache in the application data folder on your disk, like any image the application loads. That cache is not cleared by turning the option off.

## Where to change it

Settings > Productivity > **Show sender photos (Gravatar)**.

## Your own account avatar

The avatar mode **Gravatar** for an account (Settings > Accounts) is a separate choice. When you select it, the same kind of request is made for the address of that account. Other modes make no request.
