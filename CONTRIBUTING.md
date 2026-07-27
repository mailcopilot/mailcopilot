# Contributing to MailCopilot

Thanks for taking the time to look at the code. Before you invest effort,
please read how this repository actually works — it is not a standard
"fork, PR, merge" project, and pretending otherwise would waste your time.

## How this repository is maintained

Day-to-day development happens in a private upstream repository. This GitHub
repository is a **published source mirror**: on every release the full source
tree — minus internal-only material — is committed here on top of the existing
history. One commit per release, in order, never rewritten.

Consequences worth knowing:

- The commit history here is a sequence of release snapshots, not the upstream
  commit-by-commit history. `git log` will not show you individual feature
  commits.
- A pull request merged into `main` here would be **overwritten by the next
  release snapshot**, because that snapshot replaces the whole tree. So we do
  not merge pull requests directly.
- A few files are not mirrored: CI configuration, release and mirroring
  scripts, internal planning and architecture documents, and AI-agent
  instructions. Everything the application is built from is here; the license
  (AGPL-3.0-only) applies to all of it. As a side effect, one or two `npm run
  check:mirror-*` scripts refer to tooling that is not published — they are
  maintainer-side guards, not part of the build, and nothing in the table below
  depends on them.

## Proposing a change

**Bugs and feature ideas** — open an
[issue](https://github.com/mailcopilot/mailcopilot/issues). Include your
platform, the app version (Help → About), what you expected and what happened.
For mail sync problems, the IMAP provider matters — say which one.

**Security problems** — do not open an issue. See [SECURITY.md](SECURITY.md).

**Code** — open a pull request anyway. It is the clearest way to communicate a
change: the diff is unambiguous, and it can be discussed inline. What happens
next:

1. We review it on GitHub, in the open.
2. If it is accepted, the change is applied upstream with your authorship
   preserved (`Co-authored-by:` trailer at minimum, or your original commit
   author when the patch applies cleanly).
3. It ships in the next release snapshot, and the pull request is closed with a
   pointer to the release that contains it.

So the pull request itself is closed rather than merged. The code lands. If
that model is a dealbreaker for you, say so in the issue — we would rather know
than have you find out afterwards.

Keep pull requests focused. One behavioural change per PR is much easier to
review — and much easier to replay upstream — than a large mixed diff.

## Development environment

Requirements:

- **Node.js >= 22.14.0** (see `engines` in `package.json`) and npm.
- Linux, Windows or macOS. Native modules (`better-sqlite3`, `keytar`) are
  rebuilt for Electron by the `postinstall` step, so a working C++ toolchain is
  needed — build-essential / Xcode command line tools / Visual Studio Build
  Tools with the C++ workload.
- On Linux, `libsecret` (for keychain access) and, for headless test runs,
  `xvfb`.

```bash
npm install       # installs deps and rebuilds native modules for Electron
npm run dev       # Vite dev server + Electron with hot reload
```

## Commands

These all work in this repository as published:

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint, zero warnings tolerated |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm test` | Vitest unit suite |
| `npm test -- --coverage` | Unit suite with a coverage report |
| `npm run test:db` | SQLite tests — rebuilds `better-sqlite3` for Node, runs them, restores the Electron build |
| `npm run test:scripts` | Node-native tests for the tooling in `scripts/` |
| `npm run e2e` | Playwright end-to-end suite against a real Electron build |
| `npm run e2e:bg` | Same, wrapped in `xvfb-run` — use this on a headless Linux machine |
| `npm run build` | Production build for the current platform |
| `npm run build:linux` | AppImage + deb |
| `npm run audit` | Dependency audit |

Two notes that will save you time:

- Do **not** run `npm rebuild better-sqlite3` by hand. It leaves the module
  built for the wrong ABI and Electron then refuses to load it. `npm run
  test:db` handles the rebuild-and-restore cycle for you.
- `npm test` runs the SQLite tests too, but they skip themselves when the
  native module is built for Electron rather than for Node. If you touched
  `packages/db/`, run `npm run test:db` — otherwise you have not tested it.

## Code style and conventions

- **TypeScript strict mode.** Avoid `any`; IPC payloads, database rows and API
  responses get explicit types.
- **English only in code** — identifiers, comments, log messages, test
  descriptions, commit messages. The user interface is translated separately.
- **No `console.log` in `electron/`.** Use the scoped logger from
  `electron/logger.ts`.
- **No hardcoded user-facing strings.** Everything goes through `t('...')` and
  the locale files in `src/i18n/locales/`. The project ships six languages; a
  new key needs all six before a change is considered complete.
- **The renderer never touches Node or Electron APIs directly.** New
  capabilities go through the preload whitelist and an IPC handler in the main
  process.
- **URLs that came from email content** are fetched through the SSRF-safe
  client, never with a bare `fetch()`.
- Tests are part of a change, not a follow-up. New behaviour needs unit tests;
  a bug fix needs a test that fails before the fix.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) are enforced by
commitlint through a git hook:

```
feat(mail): add per-folder offline mode
fix(imap): reconnect after IDLE timeout
docs: clarify TLS pinning setup
```

The subject line starts lowercase after the type prefix.

**Heads-up about the pre-commit hook:** `.husky/pre-commit` runs the full
`npm test` suite on every commit. That is deliberate, but it means a commit can
take a couple of minutes. If you commit often while working, expect the wait —
and do not disable the hook in a pull request.

## License

MailCopilot is licensed under the
[GNU Affero General Public License v3.0](LICENSE). By contributing you agree
that your contribution is licensed under the same terms. There is no separate
contributor license agreement.
