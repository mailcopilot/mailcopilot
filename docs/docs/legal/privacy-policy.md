---
sidebar_position: 1
title: Privacy Policy
---

# Privacy Policy

**Effective date:** February 13, 2026
**Last updated:** November 4, 2026

## 1. Introduction

MailCopilot ("the Application", "we", "our") is a desktop email client for Windows, macOS, and Linux. This Privacy Policy describes how we collect, use, store, and protect your personal data when you use the Application.

By using MailCopilot, you agree to the practices described in this Privacy Policy. If you do not agree, please do not use the Application.

## 2. Data We Collect

### 2.1 Email Account Credentials

- **Email address** — required to connect to your mail server.
- **Password** (IMAP/SMTP) — if you use password-based authentication.
- **OAuth tokens** (access token, refresh token) — if you use Google OAuth 2.0 or another OAuth provider.

### 2.2 Email Data

When you connect your account, the Application downloads and caches:

- Email headers (subject, sender, recipients, date).
- Email body (text and HTML).
- Attachment metadata (file names and types; attachments themselves are not cached by default).
- Email flags (read/unread, flagged).
- Message identifiers (Message-ID, In-Reply-To, References) for conversation threading.

### 2.3 Contact Information

- Email addresses and names of people you correspond with.
- Usage frequency and last interaction date for autocomplete suggestions.

### 2.4 Folder Structure

- List of mailbox folders, their names, and special-use attributes (Inbox, Sent, Drafts, Trash, Junk, Archive).
- Per-folder preferences (visibility, badge settings, sync mode).

### 2.5 Application Settings

- Language, theme, AI preferences, and other configuration options.
- Custom email address for the "From" header (if configured).
- Email signatures.

### 2.6 Error Reports

- If you have agreed to diagnostics, Sentry receives **error reports** (stack traces, application version, operating environment) and usage and performance diagnostics (counts, durations, a session summary). They carry a hashed random install identifier, so reports from one installation can be linked to each other; this is pseudonymous data. They contain no email content, addresses, passwords, tokens or AI prompts (`sendDefaultPii: false`). Details are in [Telemetry](../privacy/telemetry.md).

## 3. How We Store Your Data

**All user data is stored locally on your computer.** MailCopilot does not operate any cloud servers to store your emails, contacts, or settings.

| Data | Storage Method |
|---|---|
| Passwords and API keys | OS-level secure storage (keytar): Windows DPAPI, macOS Keychain, Linux Secret Service |
| Email cache and contacts | Local SQLite database (`~/.mailcopilot/cache.db`) |
| Settings and account config | Local JSON file (electron-store) |
| OAuth tokens | Local encrypted storage via electron-store |

You can delete all local data at any time by removing the `~/.mailcopilot/` directory (or the data directory configured via `MAILCOPILOT_DATA_DIR`).

## 4. How We Use Your Data

We use your data **solely** to provide the core functionality of the Application:

- **Connect to your mail server** via IMAP/SMTP to send, receive, and manage email.
- **Cache emails locally** for faster access and offline reading.
- **Provide autocomplete** for recipient addresses based on your contact history.
- **Display folder structure** and unread counts.
- **AI Assistant features** (optional) — see Section 5.

We do **not** use your data for:

- Advertising, marketing, or ad targeting.
- Selling or sharing with data brokers.
- Building user profiles for third parties.
- Credit scoring or financial assessments.
- Surveillance or tracking.
- Training general-purpose AI/ML models.

## 5. AI Assistant and Third-Party AI Providers

MailCopilot offers an optional AI assistant that can help you draft replies, summarize emails, and perform mail actions.

### 5.1 Explicit Consent Required

The AI assistant is **disabled by default**. Before any email data is sent to an AI provider, you must:

1. Enable the AI assistant in Settings.
2. Explicitly consent to sharing email data with the selected AI provider (`aiPrivacyConsent` setting).

### 5.2 What Data Is Sent to AI Providers

When you use the AI assistant, the following data may be sent to the selected provider:

- Content of the email(s) you are working with (subject, body, sender, recipients).
- Your instructions or questions to the AI.

Data is sent **only on your explicit request** — never automatically or in the background.

### 5.3 Supported AI Providers

| Provider | Service |
|---|---|
| Anthropic | Claude API (api.anthropic.com) |
| OpenAI-compatible | The standard OpenAI API (api.openai.com) by default, or a user-configured compatible endpoint instead (for example OpenRouter, LiteLLM, Azure OpenAI, or a self-hosted server) if you set a custom Base URL |
| Google | Gemini API |

Each provider has its own privacy policy. We encourage you to review the privacy policy of your chosen provider:

- [Anthropic Privacy Policy](https://www.anthropic.com/privacy)
- [OpenAI Privacy Policy](https://openai.com/privacy) — applies when using the default OpenAI API; if you set a custom Base URL, review the privacy policy of that endpoint's operator instead.
- [Google Privacy Policy](https://policies.google.com/privacy)

### 5.4 AI Budget Controls

You can set daily and monthly spending limits for AI usage in Settings.

## 6. Google API Services — Limited Use Disclosure {#google-limited-use}

MailCopilot's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

Specifically:

1. **We only use Google user data to provide and improve user-facing features** that are visible and apparent in the Application's interface (reading, sending, organizing email).
2. **We do not transfer Google user data to third parties** except:
   - As necessary to provide or improve user-facing features (e.g., sending email content to an AI provider **only with your explicit consent**).
   - As necessary to comply with applicable law.
   - As part of a merger, acquisition, or sale of assets, with user notice.
3. **We do not use Google user data for advertising**, including retargeting, personalized advertising, or interest-based advertising.
4. **We do not allow humans to read Google user data** unless:
   - We have your explicit consent (e.g., technical support at your request).
   - It is necessary for security purposes (e.g., investigating abuse).
   - It is necessary to comply with applicable law.
   - The data is aggregated and anonymized for internal operations.
5. **We do not use Google user data to train general-purpose AI/ML models.** When you choose to use the AI assistant, your email content is sent to the selected AI provider solely to generate a response for you — not for model training.

## 7. Google OAuth 2.0

When you connect a Gmail account with Google sign-in, MailCopilot uses Google OAuth 2.0 with PKCE (RFC 7636) to obtain access. In the official MailCopilot build, Google sign-in is no longer offered for new Gmail mailboxes (they connect with an app password over IMAP/SMTP); it remains available for mailboxes that already use it and for builds made from source with their own Google client. When Google sign-in is used, we request the following scopes:

| Scope | Purpose |
|---|---|
| `https://mail.google.com/` | IMAP/SMTP access to read, send, and manage your email |
| `openid` | Verify your identity |
| `email` | Retrieve your email address |
| `profile` | Retrieve your display name |

OAuth tokens are stored locally on your device (see Section 3). We never transmit your tokens to any server we operate.

## 8. Data Sharing

We do **not** share your personal data with any third parties, except in the following limited circumstances:

- **AI providers** — only with your explicit consent, as described in Section 5.
- **Sentry**: error reports and usage and performance diagnostics, sent only with your consent. They carry a hashed random install identifier and contain no message content, addresses or prompts (see Section 2.6 and [Telemetry](../privacy/telemetry.md)).
- **Your email provider** — through standard IMAP/SMTP protocols to deliver email functionality.
- **Gravatar**: while sender photos are turned on, MailCopilot sends Gravatar the SHA-256 hash of each sender address and your IP address, as described in [Sender Photos (Gravatar)](../privacy/sender-photos.md). For an account whose avatar is set to Gravatar, it sends the hash of that account's address and your IP address. The option is off on new installs. An installation updated from a version before 1.27.2 keeps the setting it had saved, which for most installs is on. Turn it off in Settings > Productivity.

We do not sell, rent, or trade your personal data.

## 9. Data Retention and Deletion

- **Email cache**: Stored locally for as long as you use the Application. You can clear the cache at any time from Settings or by deleting the data directory.
- **Credentials**: Stored in OS-level secure storage until you remove the account from MailCopilot.
- **Settings**: Stored locally until you uninstall the Application or delete the configuration files.

Since all data is stored locally, uninstalling the Application and deleting the `~/.mailcopilot/` directory permanently removes all data.

## 10. Your Rights

You have full control over your data:

- **Access**: All your data is stored locally on your device — you can access it at any time.
- **Deletion**: Remove any account from MailCopilot to delete its cached data, or delete the entire data directory.
- **Revoke OAuth access**: You can revoke MailCopilot's access to your Google account at any time via [Google Account Permissions](https://myaccount.google.com/permissions).
- **Disable AI**: You can disable the AI assistant at any time in Settings.
- **Export**: Your emails remain on your mail server and are accessible through any email client.

## 11. Security

We implement the following security measures:

- **Encrypted storage**: Passwords and API keys are stored in OS-level secure storage (keytar).
- **TLS 1.2+**: All connections to mail servers are encrypted.
- **TLS certificate verification**: Certificates are checked against the built-in Mozilla certificate bundle and your operating system's certificate store (falling back to the built-in bundle alone if the OS store is unavailable); connections to servers with untrustworthy certificates are blocked until you explicitly choose to trust them.
- **TLS certificate pinning**: Optional SHA-256 certificate pin verification to prevent MITM attacks; strictly enforced on every connection to a pinned server.
- **Sandbox isolation**: The renderer process runs in a sandboxed environment with no direct access to the operating system.
- **IPC validation**: All inter-process communication is validated using Zod schemas.
- **PKCE**: OAuth 2.0 flow uses Proof Key for Code Exchange (RFC 7636).

## 12. Automatic Updates

MailCopilot checks for updates in the background: when it starts, and then about once an hour. An update check is an ordinary HTTPS request to our update server for a small metadata file (version number and file hash). As with any web request, the server sees your IP address and, from the name of the file requested, the type of your operating system and processor architecture. The check itself does not send the version of MailCopilot you are running (the application compares versions locally), and no mail, account details or usage data are included. The request carries only ordinary HTTP headers, such as a generic user agent. A compatibility header that the update library uses for staged rollouts is sent with a fixed all-zero value, identical for every installation, so it identifies nothing. Downloading an update is different: it does reveal versions, because the names of the files requested contain version numbers, and when a differential download is used, the request for the block-map file of the version you currently have installed (named like `mailcopilot-<current-version>-setup.exe.blockmap` on Windows) tells the server which version is running.

You decide whether this happens. **Check for updates in the background** is on by default and can be switched off in Settings → About → Updates, or on the first-run screen. No restart is needed: switching it off stops new automatic checks as soon as you save. A check or an automatic download that the update library has already started may still complete (a download that has begun is not cancelled; a check can be partway through reading its configuration, and it retries a refused connection a few times). Apart from that, when it is off, MailCopilot never contacts the update server on its own — no check at start and none every hour. The **Check for updates** button still works, because clicking it is your explicit request. A new automatic download cannot start without a check, so the "Automatically download updates in the background" option has no effect while background checks are off. On a brand-new installation — a profile with no earlier answer to the first-run screen and no mail account — MailCopilot sends no automatic update request until you have answered the first-run screen; closing that screen without answering records nothing, so the wait continues. Every existing profile keeps checking, including one that is shown the first-run screen again after a change to the disclosure.

On Windows, the installer shows a privacy notice page (a short summary with a link to this policy) before the installation steps, in the installer's language (English, Russian, French, German, Spanish or Italian; other installer languages show English). You must accept it to continue. This page is not shown for silent installs or for automatic updates. The Linux and macOS packages have no installer page; for them, the first-run screen and Settings are where this information and the choice are presented.

## 13. Children's Privacy

MailCopilot is not directed at children under the age of 16. We do not knowingly collect personal data from children.

## 14. Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last updated" date. We encourage you to review this policy periodically.

## 15. Contact Us

If you have questions about this Privacy Policy, please contact us:

- **Email**: privacy@mailcopilot.io
- **Website**: [mailcopilot.io](https://mailcopilot.io)
