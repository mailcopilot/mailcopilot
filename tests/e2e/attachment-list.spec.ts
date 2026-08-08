/**
 * §2.128 / §2.125 — attachment block in the mail viewer.
 *
 * The final shape of §2.128: **no part is ever removed from the list.** Parts
 * the body inlined are demoted below the real attachments and wait behind the
 * same toggle as any attachment past the collapse ceiling; expanding reaches
 * every one of them. Deciding "the browser already drew this" cannot be done
 * from outside the browser (`display:none` alone defeats every check), so the
 * guarantee is reachability plus a bounded list, not a correct guess.
 *
 * The e2e fixture message (uid 100) carries exactly the shape the bug report
 * showed in miniature: one `cid:img1` layout image plus one genuine
 * `report.pdf` attachment. The layout image meets all four conditions in
 * `packages/core/cidRefs.ts` — `Content-Disposition: inline`, written in an
 * `<img src="cid:img1">` position, bytes really substituted into the body — so
 * it is the demoted one. Asserted here:
 *
 *  - the genuine attachment leads the row and the inline part is behind the
 *    toggle, but still reachable by expanding;
 *  - the "Preview available" badge is gone from a PDF chip — the one file type
 *    that used to display it (§2.125);
 *  - the block leaves the reading area to the message.
 *
 * Both fixture messages (uid 100, two parts; uid 105, six real attachments)
 * carry `.mail-attachment-icon`, so picking "the first item with an
 * attachment icon" does not disambiguate them — it depends on inbox sort
 * order, which is a property of the list, not of either fixture. Both are
 * located explicitly by their (RU, fixture content is RU by default —
 * `E2E_LANGUAGE` in electron/main.ts) subject text instead, and the opened
 * subject is asserted so a mismatch fails loudly instead of silently testing
 * the wrong message.
 *
 * The mail *content* (subjects, bodies) is RU by default. The *interface*
 * (button labels, i18n strings) defaults to English (`DEFAULT_LANGUAGE` in
 * src/i18n/index.ts) — nothing in these specs changes it — so the toggle
 * label and the unnamed-attachment placeholder are asserted in English.
 *
 * A second fixture message (uid 105, "many attachments") carries SIX real
 * attachments — none inline — so it crosses ATTACHMENT_COLLAPSED_LIMIT (4,
 * src/utils/attachmentList.ts). This proves the collapse ceiling end-to-end —
 * through the real IPC round trip, not just attachmentList.test.ts's
 * in-memory model — which the two-part message cannot: two chips never
 * reaches the ceiling.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, type AppContext } from './helpers'

/** RU subject of the two-part fixture (uid 100, inline image + report.pdf) —
 *  see electron/main.ts buildE2EBoxes / E2E_TEXTS.htmlSubject. */
const HTML_SUBJECT_RU = 'E2E1: html письмо'

/** RU subject of the six-attachment fixture (uid 105) — see electron/main.ts
 *  buildE2EBoxes / E2E_TEXTS.manyAttachmentsSubject. */
const MANY_ATTACHMENTS_SUBJECT_RU = 'E2E1: письмо с множеством вложений'

/** English label of the unnamed inline part (mail.attachments.unnamed, en.json —
 *  the interface defaults to English regardless of fixture content language). */
const UNNAMED_ATTACHMENT_LABEL = 'Attachment'

test('attachments: inline layout image is demoted behind the toggle but stays reachable', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const twoPartMail = page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU })
    await expect(twoPartMail).toHaveCount(1)

    await clickMailItem(twoPartMail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await expect(page.getByTestId('mail-subject')).toHaveText(HTML_SUBJECT_RU)

    const chips = page.locator('.attachment-chip')
    const toggle = page.getByTestId('attachments-toggle')

    // Collapsed: the genuine file leads, the inline part is the one behind the
    // toggle, and the count says exactly how many chips are out of sight.
    await expect(chips).toHaveCount(1)
    await expect(chips.first().locator('.attachment-name')).toHaveText('report.pdf')
    await expect(toggle).toHaveText('Show more (1)')

    // §2.125: no preview badge anywhere — PDF is precisely the type that used
    // to show it.
    await expect(page.locator('.attachment-preview-badge')).toHaveCount(0)

    // Expanding reaches the demoted part: a message can never make an
    // attachment unreachable, whatever its html does.
    await toggle.click()
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(1).locator('.attachment-name')).toHaveText(UNNAMED_ATTACHMENT_LABEL)
    await expect(toggle).toHaveText('Show less')

    await toggle.click()
    await expect(chips).toHaveCount(1)
  } finally {
    await cleanupApp(ctx)
  }
})

test('attachments: block leaves room for the message body', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const twoPartMail = page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU })
    await clickMailItem(twoPartMail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await expect(page.getByTestId('mail-subject')).toHaveText(HTML_SUBJECT_RU)

    const block = page.locator('.mail-attachments')
    const body = page.locator('.mail-viewer-body')
    await expect(block).toBeVisible()
    await expect(body).toBeVisible()

    const blockBox = await block.boundingBox()
    const bodyBox = await body.boundingBox()
    expect(blockBox).not.toBeNull()
    expect(bodyBox).not.toBeNull()
    // The reading area must stay substantially larger than the file list.
    expect(bodyBox!.height).toBeGreaterThan(blockBox!.height)
  } finally {
    await cleanupApp(ctx)
  }
})

// §2.128 — the collapse ceiling proven end-to-end. attachmentList.test.ts
// already pins capAttachmentList's behaviour against an in-memory array; this
// is the sibling proof that the SAME ceiling holds once the attachments cross
// the real net:messageDetails IPC round trip and land in MailBodyContent, not
// just the pure model.
test('attachments: six real attachments stay capped, body stays readable, expand reveals all six', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const manyAttachmentsItem = page
      .getByTestId('mail-item')
      .filter({ hasText: MANY_ATTACHMENTS_SUBJECT_RU })
    await expect(manyAttachmentsItem).toHaveCount(1)

    await clickMailItem(manyAttachmentsItem)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await expect(page.getByTestId('mail-subject')).toHaveText(MANY_ATTACHMENTS_SUBJECT_RU)

    const chips = page.locator('.attachment-chip')
    const toggle = page.getByTestId('attachments-toggle')
    const body = page.locator('.mail-viewer-body')

    // Collapsed: only ATTACHMENT_COLLAPSED_LIMIT (4) of the 6 chips render,
    // the toggle announces how many are out of sight (2), and the message text
    // is still on screen — the whole point of the cap is that a large
    // attachment set never crowds out the reading area.
    await expect(chips).toHaveCount(4)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveText('Show more (2)')
    await expect(body).toBeVisible()
    await expect(body).toContainText('шест')

    // Expand: all six become visible, in the order the server sent them, and
    // the toggle relabels to "show less".
    await toggle.click()
    await expect(chips).toHaveCount(6)
    await expect(chips.nth(0).locator('.attachment-name')).toHaveText('invoice-01.pdf')
    await expect(chips.nth(5).locator('.attachment-name')).toHaveText('notes.txt')
    await expect(toggle).toHaveText('Show less')

    // Collapse again: back to 4, nothing left behind.
    await toggle.click()
    await expect(chips).toHaveCount(4)
  } finally {
    await cleanupApp(ctx)
  }
})
