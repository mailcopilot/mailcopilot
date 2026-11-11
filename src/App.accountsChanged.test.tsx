import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Source guard over `src/App.tsx` for two wirings whose DECISIONS are unit-tested
 * elsewhere (`utils/accountsChangedAction.test.ts`, `electron/services/replyThreading.test.ts`)
 * and which no unit test can see from the outside, because `App` is too large to
 * mount here (hotspot policy: App.tsx only calls, the logic lives in pure helpers).
 */
const APP_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')

function blockAfter(marker: string, length = 1800): string {
  const start = APP_SOURCE.indexOf(marker)
  expect(start, `${marker} not found in src/App.tsx`).toBeGreaterThan(-1)
  return APP_SOURCE.slice(start, start + length)
}

describe('App.tsx wiring — accounts:changed', () => {
  it('hands the decision the LIVE account list, not only the chosen id', () => {
    // After the last mailbox is removed the window keeps a stale current id and
    // an empty list; without the list the next "saved" event reads as an edit.
    const call = blockAfter('const onAccountsChanged')
    expect(call).toContain('decideAccountsChangedAction(')
    expect(call).toMatch(/knownAccountIds:\s*accountsRef\.current\.map\(/)
    expect(call).toMatch(/currentAccountId:\s*currentAccountIdRef\.current/)
  })

  it('keeps accountsRef in step with the accounts state', () => {
    expect(APP_SOURCE).toMatch(/accountsRef\.current\s*=\s*accounts\b/)
  })
})

describe('App.tsx wiring — reopening a saved draft', () => {
  it('editDraft names the saved draft so main can restore its reply pointer', () => {
    const body = blockAfter('const editDraft = useCallback', 2600)
    expect(body).toMatch(/draftRef:\s*\{\s*accountId:\s*m\.accountId,\s*folder:\s*m\.folder,\s*uid:\s*m\.uid\s*\}/)
  })
})
