/**
 * §2.172 — e2e fixtures must be seeded the way production parses mail.
 *
 * Every seeding site in `electron/main.ts` now splits the raw `From:` header
 * through `senderPartsFromHeader` (electron/e2eSenderParts.ts), which delegates
 * the "what may become an address" verdict to the production parser
 * (`senderFromEnvelope`, packages/net/imap.ts). Before that, the header-sync
 * branch of `net:syncFolderHeaders` wrote `fromAddr: m.from` — the whole raw
 * display string — and `upsertMessages` overwrites both sender columns
 * unconditionally, so a header sync running after a summaries fetch REPLACED a
 * correct split with data the production parser cannot produce. Which value the
 * `from_address` static-rule condition saw therefore depended on call order.
 *
 * This spec pins the ordering: seed → header sync → `rules:test`.
 *
 * MUTATION KILLER: the `expect(matchedUids).toContain(realUid)` assertion. On
 * pre-fix code `from_addr` for that row is `"Totally Legit Sender"
 * <attacker@evil.example>` (the raw header), so `from_address equals
 * attacker@evil.example` finds nothing and the assertion fails. The two
 * "not.toContain" assertions hold on pre-fix code too — they are the guarantee
 * being protected, not the regression detector.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

const SPOOF_UID = 9811
const REAL_UID = 9812
const REAL_ADDRESS = 'attacker@evil.example'
const SPOOFED_DISPLAY_NAME = 'victim@example.test'

type RuleMatch = { uid: number; subject: string; from: string; folder: string }

test('rules: from_address survives a header sync that used to overwrite it with the raw From string', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-from-address-seed-'))
    const page = ctx.page!

    // A: display name spoofs a victim address, envelope address is the sender's.
    await page.evaluate(async (args) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid: args.uid,
        from: `"${args.displayName}" <${args.realAddress}>`,
        to: 'e2e1@example.test',
        subject: `E2E from_address seed spoof ${args.uid}`,
        date: new Date().toISOString(),
        unread: true,
        flagged: false,
        text: 'Fixture for the seeding-path sender split.',
      })
    }, { uid: SPOOF_UID, displayName: SPOOFED_DISPLAY_NAME, realAddress: 'someone@example.test' })

    // B: the envelope address IS the address the rule targets.
    await page.evaluate(async (args) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid: args.uid,
        from: `"Totally Legit Sender" <${args.realAddress}>`,
        to: 'e2e1@example.test',
        subject: `E2E from_address seed real ${args.uid}`,
        date: new Date().toISOString(),
        unread: true,
        flagged: false,
        text: 'Fixture for the seeding-path sender split.',
      })
    }, { uid: REAL_UID, realAddress: REAL_ADDRESS })

    // Both rows are in the DB-backed store `rules:test` reads (each injection
    // broadcasts `mail:exists`, the renderer refreshes through
    // `net:inboxSummaries`, which upserts).
    await expect(page.getByTestId('mail-item').filter({ hasText: `E2E from_address seed spoof ${SPOOF_UID}` }).first())
      .toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-item').filter({ hasText: `E2E from_address seed real ${REAL_UID}` }).first())
      .toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Header sync and the rule dry-runs go in one evaluate so no background
    // refresh can slip between them and re-seed the columns under test.
    const { onRealAddress, onSpoofedName } = await page.evaluate(async (args) => {
      await window.api.invoke('net:syncFolderHeaders', 1, 'INBOX', { mode: 'full' })
      const test1 = await window.api.invoke('rules:test', {
        conditions: JSON.stringify([{ field: 'from_address', op: 'equals', value: args.realAddress }]),
        accountId: '1',
      })
      const test2 = await window.api.invoke('rules:test', {
        conditions: JSON.stringify([{ field: 'from_address', op: 'equals', value: args.displayName }]),
        accountId: '1',
      })
      return { onRealAddress: test1, onSpoofedName: test2 }
    }, { realAddress: REAL_ADDRESS, displayName: SPOOFED_DISPLAY_NAME }) as {
      onRealAddress: RuleMatch[]
      onSpoofedName: RuleMatch[]
    }

    const matchedUids = onRealAddress.map(m => m.uid)
    // Mutation killer — fails on pre-fix code (raw header string in from_addr).
    expect(matchedUids).toContain(REAL_UID)
    // The forged label is not an address, so the address rule must not fire.
    expect(matchedUids).not.toContain(SPOOF_UID)
    // ...and no row anywhere stores the forged label as its address.
    expect(onSpoofedName.map(m => m.uid)).not.toContain(SPOOF_UID)
    expect(onSpoofedName.map(m => m.uid)).not.toContain(REAL_UID)

    // The address the match reports is the parsed address, not the raw header.
    const realMatch = onRealAddress.find(m => m.uid === REAL_UID)
    expect(realMatch?.from).toBe(REAL_ADDRESS)
  } finally {
    await cleanupApp(ctx)
  }
})
