/**
 * §2.124 — the worker chunk actually ships.
 *
 * `packages/net/emlWorkerClient.ts` resolves the built worker as
 * `path.join(__dirname, 'eml-parse-worker.js')` and treats ANY resolution
 * failure as "no worker available" (see `resolveWorkerPath` — a missing file
 * is not an error, it is silently the inline path forever). That failure mode
 * is exactly the bug §2.124 fixed: a 9.6 MB message freezing the UI for
 * 17.5 s. A build that stops emitting the chunk — an accidental deletion of
 * the `lib.entry` line, a rename that does not update
 * `emlWorkerClient.ts`'s `eml-parse-worker.js` literal — would not fail the
 * build and nothing else in the suite would notice, because
 * `emlParseOffload.test.ts` deliberately drives fixture workers rather than
 * the real build output (see its own comment on why: no built worker exists
 * under vitest).
 *
 * This test does not run an actual Vite build (slow, and `build-linux` in CI
 * already proves the bundle compiles) — it proves the SOURCE OF THE BUILD
 * INSTRUCTION still says what emlWorkerClient.ts expects, by capturing the
 * options actually handed to the `vite-plugin-electron/simple` plugin.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ electronPlugin: vi.fn(() => ({ name: 'stub-electron-plugin' })) }))

vi.mock('vite-plugin-electron/simple', () => ({ default: mocks.electronPlugin }))

afterEach(() => {
  vi.resetModules()
  mocks.electronPlugin.mockClear()
})

async function resolvedElectronOptions(mode: string) {
  const configModule = await import('./vite.config')
  const configFactory = configModule.default as unknown as (env: { mode: string }) => unknown
  // `defineConfig` with a function argument returns that function unchanged
  // (it exists purely for type inference), so calling it here reproduces
  // exactly what Vite does when it loads this file.
  configFactory({ mode })
  expect(mocks.electronPlugin).toHaveBeenCalledTimes(1)
  return mocks.electronPlugin.mock.calls[0][0] as {
    main: { vite: { build: { lib: { entry: Record<string, string> } } } }
  }
}

describe('§2.124 vite build entry — eml-parse-worker', () => {
  it('emits the worker next to main.js, at the path emlWorkerClient.ts resolves', async () => {
    const options = await resolvedElectronOptions('production')
    const entry = options.main.vite.build.lib.entry
    expect(entry['eml-parse-worker']).toBe('packages/net/emlParseWorker.ts')
  })

  it('keeps the worker in cjs, alongside main and the search worker', async () => {
    // `emlWorkerClient.ts` requires the CJS `eml-parse-worker.js` filename
    // (`resolveWorkerPath` never adds an extension or format suffix); an ESM
    // build here would silently rename the file the client looks for.
    const options = await resolvedElectronOptions('production')
    const lib = options.main.vite.build.lib as unknown as {
      formats: string[]
      fileName: (format: string, entryName: string) => string
      entry: Record<string, string>
    }
    expect(lib.formats).toEqual(['cjs'])
    expect(lib.fileName('cjs', 'eml-parse-worker')).toBe('eml-parse-worker.js')
    // And the entry survives regardless of build mode — this is not a
    // test-only or dev-only chunk.
    expect(Object.keys(lib.entry)).toEqual(
      expect.arrayContaining(['main', 'search-worker', 'eml-parse-worker']),
    )
  })
})
