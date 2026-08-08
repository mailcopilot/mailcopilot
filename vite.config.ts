// Load `.env` from the repository root into process.env before anything below
// reads it. Existing environment variables always win (dotenv never
// overrides), so shell and CI values take precedence over the local file.
// This is what makes `MAILCOPILOT_GOOGLE_CLIENT_ID` / `_SECRET` (and
// SENTRY_DSN) available both to the `define` blocks and to the Electron
// process spawned by `onstart` in dev.
import 'dotenv/config'
import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Source maps: upload to Sentry when SENTRY_AUTH_TOKEN is present.
// We generate 'hidden' source maps (no sourceMappingURL in code) and delete .map files after upload,
// so they don't end up in the final application build.
const sentryRelease = `mailcopilot@${process.env.npm_package_version || '0.0.0-dev'}`
const sentryUploadEnabled = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_DSN)

function makeSentryPlugin(deleteGlob: string) {
  if (!sentryUploadEnabled) return []
  return [sentryVitePlugin({
    org: 'sentry',
    project: 'mailcopilot',
    url: process.env.SENTRY_URL,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: sentryRelease },
    sourcemaps: { filesToDeleteAfterUpload: [deleteGlob] },
    telemetry: false,
    silent: true,
  })]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Root package.json contains "type": "module", which causes Node/Electron
// to treat .js files as ESM. dist-electron/main.js is built in CJS format,
// so a local package.json with "type": "commonjs" is needed.
function electronCjsPackageJson(): Plugin {
  return {
    name: 'electron-cjs-package-json',
    apply: 'build',
    closeBundle() {
      const dir = path.resolve(__dirname, 'dist-electron')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n')
    },
  }
}

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@mailcopilot/types': path.resolve(__dirname, 'packages/types'),
      '@mailcopilot/core': path.resolve(__dirname, 'packages/core'),
    },
  },
  build: {
    sourcemap: sentryUploadEnabled ? 'hidden' : false,
  },
  define: {
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN || ''),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0-dev'),
  },
  plugins: [
    react(),
    ...makeSentryPlugin('dist/**/*.map'),
    electron({
      main: {
        // VS Code (and Claude Code) set ELECTRON_RUN_AS_NODE=1, which breaks
        // require("electron") in the main process. Clear it before launch.
        onstart(args) {
          const env = { ...process.env }
          delete env.ELECTRON_RUN_AS_NODE
          args.startup(['.', '--no-sandbox'], { env })
        },
        vite: {
          plugins: [electronCjsPackageJson(), ...makeSentryPlugin('dist-electron/**/*.map')],
          resolve: {
            alias: {
              '@mailcopilot/types': path.resolve(__dirname, 'packages/types'),
              '@mailcopilot/core': path.resolve(__dirname, 'packages/core'),
            },
          },
          define: {
            __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN || ''),
            __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0-dev'),
            // Google OAuth Desktop client, baked in at build time. Injected
            // into the MAIN bundle only — deliberately not into the renderer
            // `define` above: the OAuth flow runs entirely in the main process
            // (electron/googleOAuth.ts), so putting the credentials into the
            // renderer bundle would widen their exposure surface (web context,
            // DevTools, any future content-injection bug) for zero benefit.
            // Empty when the build has no credentials — Gmail sign-in then
            // fails with an actionable message, everything else still works.
            __GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(process.env.MAILCOPILOT_GOOGLE_CLIENT_ID || ''),
            __GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(process.env.MAILCOPILOT_GOOGLE_CLIENT_SECRET || ''),
          },
          build: {
            sourcemap: sentryUploadEnabled ? 'hidden' : false,
            // Important: Electron v30+ in ESM mode may incorrectly import the `electron` API.
            // Therefore, we force the main process to CommonJS (see also `dist-electron/package.json`).
            // NOTE: `vite-plugin-electron` adds a default `build.lib` when `main.entry` is present.
            // Since this repo has `"type": "module"`, the default formats include `"es"`, and Vite ends up
            // building BOTH ESM and CJS into the same `main.js` (non-deterministic overwrite).
            // To make the output stable, we provide `build.lib` ourselves and omit `main.entry`.
            lib: {
              entry: {
                main: 'electron/main.ts',
                'search-worker': 'electron/search-worker.ts',
                // §2.124 — off-main-thread MIME parsing. Emitted next to
                // main*.cjs so packages/net/emlWorkerClient.ts can resolve it
                // as `path.join(__dirname, 'eml-parse-worker.js')`, the same
                // arrangement search-worker.js already uses.
                'eml-parse-worker': 'packages/net/emlParseWorker.ts',
              },
              formats: ['cjs'],
              fileName: (_format, entryName) => `${entryName}.js`,
            },
            rollupOptions: {
              external: ['electron', 'keytar', 'better-sqlite3', 'imapflow', 'nodemailer', '@napi-rs/canvas', /^pdfjs-dist/],
            }
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              external: ['electron'],
            }
          },
        },
      },
      renderer: mode === 'test' ? undefined : {},
    }),
  ],
  test: {
    // `scripts/**` holds `node:test` suites (run by `npm run test:scripts`), not vitest ones.
    // Vitest still imports them while collecting, reports "(0 test)" and tears the worker down
    // without awaiting their bodies — so their side effects (real child processes, temp dirs)
    // keep running unmanaged and leak. Keep them out of vitest entirely.
    exclude: ['tests/e2e/**', 'tests/integration/**', 'node_modules/**', 'docs/**', 'scripts/**'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/**/*.ts',
        'electron/**/*.ts',
        'src/utils/**/*.ts',
        'src/hooks/**/*.{ts,tsx}',
        'src/windows/**/*.{ts,tsx}',
        'src/components/ResizeEdges.tsx',
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/*.d.ts', 'packages/net/types.ts', 'packages/types/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
  server: {
    headers: {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'", // Vite in dev injects inline scripts; in prod it's better to remove 'unsafe-inline'
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' ws: http: https:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  },
}))
