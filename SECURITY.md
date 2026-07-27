# Security Policy

MailCopilot is a desktop email client. It holds credentials for your mail
accounts, renders untrusted HTML, talks to third-party AI providers and runs an
optional local MCP server. Security reports are taken seriously and are welcome.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest stable release | Yes — security fixes land here |
| Older stable releases | No — please upgrade |
| Nightly / pre-release builds | Best effort, not a supported channel |

There is no long-term-support branch. Fixes ship in the next release of the
current line.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use one of these private channels:

1. **GitHub private vulnerability reporting** — the "Report a vulnerability"
   button under the [Security tab](https://github.com/mailcopilot/mailcopilot/security)
   of this repository. Preferred: it keeps the report, the discussion and the
   fix in one place.
2. **Email** — `team@mailcopilot.io`. Put `SECURITY` in the subject.

A useful report contains:

- affected version and platform (Linux / Windows / macOS);
- what an attacker can achieve, not only what looks wrong;
- reproduction steps or a proof of concept;
- whether the issue needs a specific account configuration (IMAP provider, AI
  provider, MCP enabled, TLS pinning on, and so on).

Please redact your own credentials, message bodies and email addresses from
logs and screenshots before sending them.

## What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement of your report | 5 business days |
| Initial assessment (in scope? severity?) | 10 business days |
| Fix or documented mitigation for a confirmed critical issue | next release of the current line |

If you do not hear back within the acknowledgement window, send a follow-up —
the message may have been lost, not ignored.

We ask for coordinated disclosure: give us a chance to ship a fix before making
the details public. We will credit you in the release notes unless you prefer
to stay anonymous.

**There is no bug bounty program.** No money is paid for reports. This is stated
up front so nobody invests time expecting a payout.

## Scope

In scope — issues in this repository's code:

- **Renderer / main process boundary.** Anything that lets renderer code reach
  Node or Electron APIs directly: `contextIsolation` or sandbox escapes, a way
  to invoke an IPC channel that is not on the `electron/preload.ts` whitelist,
  or an IPC handler that trusts renderer-supplied input it should validate.
- **Untrusted content handling.** Escapes from the HTML email sandbox, script
  execution from a message body or attachment, remote content that loads
  despite the block-external-images setting.
- **SSRF.** Any path where a URL taken from email content (unsubscribe links,
  inline images, calendar data) reaches the network without going through the
  SSRF-safe fetch layer, or a bypass of that layer's address filtering.
- **TLS.** Certificate verification or certificate-pinning logic that can be
  made to accept a certificate it should reject, and downgrade paths.
- **Credential handling.** Passwords, OAuth tokens or API keys leaking out of
  the system keychain into logs, crash reports, telemetry, the database or the
  renderer process.
- **AI and MCP surface.** Prompt injection from message content that causes a
  destructive action (send, move, delete, unsubscribe) without the two-step
  confirmation, bypasses of the tool whitelist, or authentication weaknesses in
  the local MCP export server.
- **Updater.** Anything that lets an attacker feed the app an update it should
  not accept.
- **Local privilege issues.** Insecure file permissions, world-readable secrets,
  unsafe temporary files created by the app.

Out of scope:

- Vulnerabilities in the mail server you connect to. MailCopilot speaks standard
  IMAP/SMTP; a weakness in your provider is your provider's to fix.
- Spam, phishing or malicious content that merely *arrives* in your mailbox and
  is displayed as designed (blocked images, no script execution, no auto-open).
- Weaknesses in third-party AI providers, or the fact that a message you
  explicitly send to an AI provider is processed by that provider.
- Missing hardening that has no demonstrated impact ("header X is absent",
  "dependency Y is one minor version behind") without an exploit path.
- Attacks that require an already-compromised machine, an attacker with your
  unlocked session, or an attacker who can already read your keychain.
- Denial of service caused by feeding the app absurd local input (a 10 GB
  attachment, a folder with millions of messages).
- Social engineering of the maintainers or users.
- Automated scanner output pasted without analysis.

## Security model in one paragraph

The renderer runs sandboxed with `contextIsolation` enabled and no Node
integration; every system call crosses a whitelisted IPC bridge in
`electron/preload.ts`. Credentials live in the OS keychain, never in the
database or in configuration files. Email content is treated as untrusted
input everywhere — in the HTML viewer, in the AI prompt (explicit boundary
markers) and in the network layer (SSRF-safe fetch for any URL that came from a
message). Destructive AI tools are two-step: preview, then explicit apply.
Mail is never sent automatically without a human confirming it.
