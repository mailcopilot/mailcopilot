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
    exclude: ['tests/e2e/**', 'tests/integration/**', 'node_modules/**', 'docs/**'],
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
