<p align="center">
  <img src="public/icon.png" alt="MailCopilot" width="128" />
</p>

<h1 align="center">MailCopilot</h1>

<p align="center">
  AI-native desktop email client. Fast, private, open source.
</p>

<p align="center">
  <a href="https://mailcopilot.io">Website</a> &middot;
  <a href="https://docs.mailcopilot.io">Documentation</a> &middot;
  <a href="https://mailcopilot.io">Downloads</a>
</p>

---

MailCopilot is a modern desktop email client built with Electron, React, and TypeScript. It connects to your existing accounts via standard IMAP/SMTP and keeps your data under your control.

## Features

- **Multiple accounts** — connect several accounts and switch instantly, or use the unified inbox
- **Conversation threading** — related messages are grouped into threads automatically
- **AI assistant** — built-in assistant powered by Claude: summarize, draft replies, manage inbox, read attachments (text, images, PDF)
- **Keyboard shortcuts** — Gmail-style and Outlook-style presets
- **Scheduled sending** — send later today, tomorrow, or at a custom time
- **Snooze** — snooze messages and get reminded when you're ready
- **Follow-up reminders** — get notified if you don't receive a reply
- **Templates** — quick reply templates with variable substitution
- **TLS certificate pinning** — pin server certificates for extra security
- **Desktop notifications** — new mail alerts in the background
- **Drag & drop** — move messages between folders
- **Dark & light themes**
- **6 languages** — English, Russian, French, German, Spanish, Italian
- **Privacy-first** — HTML emails rendered in a secure sandbox, external images blocked by default, passwords stored in system keychain

## Platforms

| Platform | Format |
|----------|--------|
| Linux | AppImage, deb, rpm |
| Windows | NSIS installer |
| macOS | DMG (universal) |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22.14.0
- npm (comes with Node.js)

### Development

```bash
# Install dependencies
npm install

# Optional: local environment (Google OAuth, Sentry, updater)
cp .env.example .env

# Start in dev mode (hot reload)
npm run dev
```

### Gmail sign-in in a self-built app

This repository ships **no Google OAuth credentials**, so an app you build
yourself cannot sign in with Gmail until you supply your own client. Everything
else — IMAP/SMTP accounts, including Gmail via app password — works without it.

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. *Create Credentials → OAuth client ID*, application type **Desktop app**.
3. On the OAuth consent screen grant the scopes
   `https://mail.google.com/`, `openid`, `email`, `profile`.
4. Put the client ID and secret into `.env` (or the build environment):

   ```bash
   MAILCOPILOT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   MAILCOPILOT_GOOGLE_CLIENT_SECRET=...
   ```

The values are read from the environment at runtime and, failing that, from
values baked into the main bundle at build time. Without either, the Gmail
button reports that the build has no credentials instead of failing obscurely.

### Build

```bash
# Build for current platform
npm run build

# Build Linux packages (AppImage + deb)
npm run build:linux
```

### Tests

```bash
# Unit tests
npm test

# Unit tests with coverage
npm test -- --coverage

# Lint + type check
npm run lint
npm run typecheck

# E2E tests (requires virtual display on CI)
npm run e2e:bg
```

## Architecture

```
├── electron/          # Main process (Electron)
│   ├── main.ts        # App entry point, IPC handlers
│   ├── preload.ts     # Secure bridge (contextIsolation)
│   └── services/      # AI, attachments, logging
├── src/               # Renderer (React)
│   ├── App.tsx        # Main UI
│   ├── components/    # React components
│   ├── hooks/         # Custom hooks
│   ├── i18n/          # Translations (6 languages)
│   └── utils/         # Utilities
├── packages/
│   ├── net/           # IMAP/SMTP adapters, TLS, EML parsing
│   └── db/            # SQLite cache (better-sqlite3)
├── tests/e2e/         # Playwright E2E tests
└── docs/              # User documentation (Docusaurus)
```

**Security model:** renderer runs in a sandbox with `contextIsolation` and no `nodeIntegration`. All system access goes through a whitelisted IPC layer in `preload.ts`.

## Contributing

Contributions are welcome — but read [CONTRIBUTING.md](CONTRIBUTING.md) first,
because this repository is not maintained the usual way.

Development happens in a private upstream repository; this one is a **published
source mirror** that receives the full source tree as one commit per release.
Pull requests are therefore reviewed and replayed upstream with your authorship
preserved, rather than merged here — a merge would be overwritten by the next
release snapshot. Issues and pull requests are still the right way to reach us.

Found a security problem? Do not open an issue — see [SECURITY.md](SECURITY.md).

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

### Code style

- TypeScript strict mode
- ESLint for linting (`npm run lint`)
- Commitlint for commit messages (enforced by git hooks)
- English in code, `t('...')` for anything a user reads

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

You are free to use, modify, and distribute this software under the terms of the AGPL-3.0. If you modify the source and provide the software as a network service, you must make your modified source available to users of that service.
