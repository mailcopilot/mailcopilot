// Base `no-restricted-syntax` selectors that ban every static path to the
// `ipcMain` symbol. Declared as a module-level const so the `electron/ipc.ts`
// override can EXTEND (not replace) the list — ESLint's override semantics
// replace the rule options entirely, so we spread these into both places.
const ELECTRON_IMPORT_BANS = [
  {
    selector: "ImportDeclaration[source.value='electron'] > ImportNamespaceSpecifier",
    message:
      "Do not namespace-import 'electron' (e.g. `import * as electron from 'electron'`). Use named imports only; namespace access would bypass the module-boundary ban on ipcMain. See CLAUDE.md §7 and BACKLOG.md §2.13.",
  },
  {
    selector: "ImportDeclaration[source.value='electron'] > ImportDefaultSpecifier",
    message:
      "Do not default-import 'electron' (e.g. `import electron from 'electron'`). Use named imports only; default-import would expose ipcMain via `electron.ipcMain` and bypass the module-boundary ban. See CLAUDE.md §7 and BACKLOG.md §2.13.",
  },
  {
    selector: "ImportDeclaration[source.value='electron'] > ImportSpecifier[imported.name='default']",
    message:
      "Do not import the default export of 'electron' via named-import alias (e.g. `import { default as electron } from 'electron'`). Equivalent to `import electron from 'electron'` and has the same ipcMain exposure problem. Use explicit named imports only. See CLAUDE.md §7 and BACKLOG.md §2.13.",
  },
  {
    // Default re-export from an intermediate facade file:
    //   facade.ts: `export { default as electron } from 'electron'`
    //   consumer.ts: `import { electron } from './facade'; electron.ipcMain.handle(...)`
    // The consumer's import is from a local module so the 'electron'-specific
    // rules never fire there. Block at the re-export site instead.
    selector: "ExportNamedDeclaration[source.value='electron'] > ExportSpecifier[local.name='default']",
    message:
      "Do not re-export the default of 'electron' (e.g. `export { default as electron } from 'electron'`). This lets a downstream file access `electron.ipcMain.handle(...)` through a local module that the boundary rules do not cover. See CLAUDE.md §7 and BACKLOG.md §2.13.",
  },
]

module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // IPC boundary enforcement — BACKLOG.md §2.13.
    //
    // The architectural fix: `ipcMain` is imported in exactly one file,
    // `electron/ipc.ts`, which defines `handleIpc()` (plus the metrics-record
    // bridge and freeze watchdogs that need to read the module-internal
    // inflight map). Every other file in the project calls `handleIpc(...)`
    // instead of touching `ipcMain` directly.
    //
    // Because `ipcMain` is not in scope outside `electron/ipc.ts`, every
    // previously-documented bypass (destructuring, aliasing, bracket access,
    // `Reflect.get`, namespace- or default-imports of 'electron', etc.)
    // becomes structurally impossible. Reintroducing any of them requires
    // adding `import { ipcMain } from 'electron'` to another file — which
    // `no-restricted-imports` below blocks project-wide and which any
    // reviewer would catch as a single-line red flag.
    //
    // That module-boundary ban is the real moat. Defense-in-depth:
    //   (a) a namespace-import ban on 'electron' so nobody can smuggle
    //       ipcMain as `electron.ipcMain.handle(...)` in a future file that
    //       (for whatever reason) is whitelisted to import from 'electron';
    //   (b) inside `electron/ipc.ts` itself, a `no-restricted-syntax` rule
    //       against raw `ipcMain.handle(...)` — so the wrapper's author
    //       cannot accidentally add a second call site alongside the one
    //       annotated line inside `handleIpc()`.
    'no-restricted-syntax': ['error', ...ELECTRON_IMPORT_BANS],
    // Module-boundary ban on the `ipcMain` named import. Removing the symbol
    // from every file except electron/ipc.ts is what makes every AST-level
    // bypass (destructuring, aliasing, bracket access, Reflect.get)
    // structurally impossible. See the override block below for the single
    // whitelisted file.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'electron',
            importNames: ['ipcMain'],
            message:
              "ipcMain may only be imported in electron/ipc.ts, which owns the handleIpc() wrapper. Outside that module, use handleIpc() instead. Direct ipcMain access bypasses centralized error logging, slow-IPC tracking, inflight tracking, and IPC metrics. See CLAUDE.md §7 and BACKLOG.md §2.13.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // electron/ipc.ts is the sole file where `ipcMain` is legitimately
      // imported. Relax the module-boundary import ban here, and add a
      // defense-in-depth rule against raw `ipcMain.handle(...)` inside this
      // module (the wrapper's own call site is annotated with an inline
      // eslint-disable). No other file in the project needs either rule
      // inverted.
      files: ['electron/ipc.ts'],
      rules: {
        'no-restricted-imports': 'off',
        // Override REPLACES the base `no-restricted-syntax` list — spread the
        // ELECTRON_IMPORT_BANS back in so namespace/default/alias imports
        // stay banned even inside electron/ipc.ts itself (only the named
        // `{ ipcMain }` import is whitelisted here via `no-restricted-imports`
        // override above). Plus add the defense-in-depth `ipcMain.handle`
        // member-access rule scoped to this file only.
        'no-restricted-syntax': [
          'error',
          ...ELECTRON_IMPORT_BANS,
          {
            selector: "MemberExpression[object.name='ipcMain'][property.name='handle'][computed=false]",
            message:
              "Use handleIpc() wrapper instead of ipcMain.handle() directly, even inside electron/ipc.ts. The single legitimate call site is inside handleIpc() itself and is annotated with an inline eslint-disable. See CLAUDE.md §7 and BACKLOG.md §2.13.",
          },
        ],
      },
    },
  ],
}
