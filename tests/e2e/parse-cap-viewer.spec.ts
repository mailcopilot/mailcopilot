/**
 * §2.145 e2e — the two-tier parse-cap UI, driven through the REAL pipeline
 * this time: `net:messageDetails` → `readEml` → `parseEmlBuffer` → the caps →
 * `cacheMessageDetails`, exactly as production main.ts runs it.
 *
 * FIRST VERSION OF THIS SPEC WAS BROKEN. It tried to fake `net:messageDetails`
 * by reassigning `window.api.invoke` from a Playwright `page.evaluate()`.
 * That silently does nothing — `contextBridge.exposeInMainWorld` hands the
 * renderer's main world a read-only proxy back to the isolated world, so the
 * reassignment does not throw but every call still reaches the real bridge.
 * Production logs proved it: both the "faked" and the untouched click produced
 * a genuine `net.message_details.wall_ms { cache_hit_level: 'imap' }` line —
 * the E2E synthetic branch had served both, unmodified. That spec was deleted
 * (CLAUDE.md §7 rule 11 — a mock that does not reproduce the real contract is
 * not a test) and its intent moved to real-component wiring tests instead:
 * `src/components/MailBodyContent.test.tsx` and `src/windows/MailWindow.test.tsx`
 * (§2.145 describe blocks) drive the real `MailBodyContent`/`MailWindow`
 * components with real `MessageDetails.parseCap` fixtures. Read those first if
 * you are looking for leaf-component coverage — this spec is the IPC round
 * trip they cannot reach.
 *
 * WHAT MAKES THIS VERSION HONEST. `e2e:injectMail` now accepts `emlBase64` /
 * `emlPadToBytes` (electron/main.ts, `writeE2EFixtureEml`): either gives the
 * fixture real RFC822 bytes on disk via `saveEml` and marks it `emlFixture`.
 * `net:messageDetails` deliberately does NOT take its synthetic `IS_E2E`
 * branch for an `emlFixture`-marked message — it falls through to the SAME
 * `readEml` → `parseEmlBuffer` → `cacheMessageDetails` path a real account
 * uses (see the comment above `e2eFixture?.emlFixture` in main.ts). A fixture
 * injected WITHOUT bytes keeps the old synthetic branch — that is the
 * regression case below, and it is deliberately left untouched by this
 * feature, not specially exempted by this spec.
 *
 * `emlPadToBytes` is synthesised MAIN-SIDE (`buildE2EFixtureEml`): a 100+ MiB
 * fixture never crosses IPC as bytes, only as a number.
 *
 * A fixture whose `.eml` failed to write is a LOUD failure by design — it
 * falls through past the (now-skipped) synthetic branch to a real IMAP fetch
 * that does not exist for an E2E account, and the resulting rejection is not
 * something this spec catches or works around.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, type AppContext } from './helpers'
import { EML_BODY_SOFT_CAP_BYTES, MAX_EML_PARSE_BYTES } from '../../packages/net/eml'
import { formatBytes } from '../../packages/core/mail'

const NORMAL_UID = 78200
const HARD_UID = 78201
const SOFT_UID = 78202

const NORMAL_SUBJECT = `E2E parse-cap regression ${Date.now()}`
const HARD_SUBJECT = `E2E parse-cap hard ${Date.now()}`
const SOFT_SUBJECT = `E2E parse-cap soft ${Date.now()}`

// Comfortable margin above the hard cap — this spec is not re-proving the
// exact boundary byte (that's `packages/net/eml.test.ts` — "is a maximum, not
// a threshold"), it is proving the real IPC round trip lands on the hard-cap
// branch for a message a real user could plausibly send as an attack/anomaly.
const HARD_FIXTURE_BYTES = MAX_EML_PARSE_BYTES + 1024 * 1024
// Past the first-tier (soft) cap by 64 KiB, comfortably below the raised tier
// — the exact shape the §2.145 brief specifies for the soft-cap fixture.
const SOFT_FIXTURE_BYTES = EML_BODY_SOFT_CAP_BYTES + 64 * 1024

async function injectFixture(
  page: import('@playwright/test').Page,
  args: { uid: number; subject: string; emlPadToBytes?: number },
): Promise<void> {
  await page.evaluate(async (a) => {
    await window.api.invoke('e2e:injectMail', {
      accountId: 1,
      folder: 'INBOX',
      uid: a.uid,
      from: 'sender@example.test',
      to: 'e2e1@example.test',
      subject: a.subject,
      // RFC 5322 format — this string is written verbatim into the fixture's
      // `Date:` header by `buildE2EFixtureEml` (no reformatting on the main
      // side), and the real mailparser-based header scan reads it.
      date: 'Sat, 15 Aug 2026 10:00:00 +0000',
      unread: false,
      flagged: false,
      text: 'placeholder text — irrelevant for EML-backed fixtures, real for the synthetic one',
      ...(a.emlPadToBytes !== undefined ? { emlPadToBytes: a.emlPadToBytes } : {}),
    })
  }, args)
}

test('parse-cap viewer (real pipeline): hard-cap placeholder, soft-cap banner + show-full, unchanged normal message', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-parsecap-'))
    const page = ctx.page!

    // Byte-less — stays on the old synthetic IS_E2E branch, exactly like every
    // other e2e mail fixture in the suite.
    await injectFixture(page, { uid: NORMAL_UID, subject: NORMAL_SUBJECT })
    // Real bytes on disk, well past the hard cap.
    await injectFixture(page, { uid: HARD_UID, subject: HARD_SUBJECT, emlPadToBytes: HARD_FIXTURE_BYTES })
    // Real bytes on disk, past the first-tier soft cap only.
    await injectFixture(page, { uid: SOFT_UID, subject: SOFT_SUBJECT, emlPadToBytes: SOFT_FIXTURE_BYTES })

    await page.getByTestId('folder-INBOX').click()

    // --- Regression: a byte-less fixture keeps taking the synthetic branch,
    //     renders exactly as every other e2e mail flow expects, and shows no
    //     parse-cap UI. ---
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: NORMAL_SUBJECT }).first())
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
    await expect(page.getByTestId('mail-parse-cap-hard')).toHaveCount(0)
    await expect(page.getByTestId('mail-parse-cap-soft')).toHaveCount(0)

    // --- Hard cap: real bytes, real `exceedsHardParseCap`, real
    //     `parseEmlHeaderFacts` placeholder — no bypass. ---
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HARD_SUBJECT }).first())
    const hardCard = page.getByTestId('mail-parse-cap-hard')
    await expect(hardCard).toBeVisible()
    // The card deliberately does NOT show the message's own size: on the
    // streaming-refusal path (collectRawBounded) rawBytes is only a lower
    // bound, so the copy says "larger than <limit>" and nothing else. This
    // assertion pins that contract — a regression that reintroduces the raw
    // size must fail here.
    await expect(hardCard).not.toContainText(formatBytes(HARD_FIXTURE_BYTES))
    await expect(hardCard).toContainText(formatBytes(MAX_EML_PARSE_BYTES))
    await expect(page.getByTestId('mail-body-text')).toHaveCount(0)
    // No button anywhere in the hard-cap card — an "open anyway" affordance
    // would be a button that asks the app to run out of memory.
    await expect(hardCard.locator('button')).toHaveCount(0)

    // --- Soft cap: real bytes, real clip, real "show full" round trip through
    //     `useShowFullMessage` → `net:messageDetails` with `{ full: true }` →
    //     the raised tier → the banner resolving. ---
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: SOFT_SUBJECT }).first())
    const softBanner = page.getByTestId('mail-parse-cap-soft')
    await expect(softBanner).toBeVisible()
    const bodyLocator = page.getByTestId('mail-body-text')
    await expect(bodyLocator).toBeVisible()
    const clippedLength = (await bodyLocator.textContent())?.trim().length ?? 0
    // The clip is real: bounded at the first-tier cap, not the full fixture.
    expect(clippedLength).toBeLessThanOrEqual(EML_BODY_SOFT_CAP_BYTES)
    expect(clippedLength).toBeGreaterThan(0)

    await page.getByTestId('mail-parse-cap-show-full').click()
    // canShowFull was true (the fixture sits well under the raised 8 MiB
    // tier), so the re-parse comes back uncapped and MailBodyContent's
    // `details?.parseCap?.kind === 'soft'` branch stops matching — the banner
    // is gone, not merely relabelled.
    await expect(softBanner).toHaveCount(0)
    await expect
      .poll(async () => (await bodyLocator.textContent())?.trim().length ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(clippedLength)

    // codex-bg-review Part B, MEDIUM — a `{ full: true }` re-parse must not
    // replace the CLIPPED entry in either details cache (memory LRU or
    // `messages.cached_detail`): it exists for one click, and persisting it
    // would hand the raised-tier body to every later open of this message.
    // `cacheMessageDetails` (electron/main.ts) returns before either cache
    // write when `wantFull` is true — proven here by navigating away and back:
    // if the full result HAD been cached, this second open would still show
    // the full body and no banner. Real reopen, through the real cache-hit
    // branches (memory, then DB), not a claim about source text.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: NORMAL_SUBJECT }).first())
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: SOFT_SUBJECT }).first())
    await expect(softBanner).toBeVisible()
    await expect
      .poll(async () => (await bodyLocator.textContent())?.trim().length ?? 0, { timeout: 10_000 })
      .toBe(clippedLength)
  } finally {
    await cleanupApp(ctx)
  }
})
