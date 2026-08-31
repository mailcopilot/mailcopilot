import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.82 iter2 finding 1 — no unclamped settings record may leave main.
 *
 * The renderer starts its OWN Sentry client from `sentryEnabled` alone
 * (src/App.tsx applies `s.sentryEnabled !== false` to both the `settings:get`
 * reply and every `settings:changed` broadcast). On a clean profile there is
 * no consent record while the settings schema still defaults that field to
 * `true` — so publishing the persisted value verbatim starts renderer
 * envelopes for a user who has never been asked. The fix is a clamp to the
 * effective permission (`clampTelemetryForRenderer`) on BOTH boundaries.
 *
 * electron/main.ts cannot be imported in a unit test (module-level side
 * effects: window creation, IPC registration, DB open), so this guard reads
 * the source instead — the same trade-off as the mirror-pattern suites in
 * main.auditLogClear.test.ts and friends. What it protects is not the clamp
 * logic (that is unit-tested in telemetryConsent.test.ts) but the far more
 * likely regression: a NEW publish site added later that forgets it.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
// Comment lines mention the channel by name (that is the point of the header
// on broadcastSettingsChanged) — count code only.
const MAIN_TS_CODE = MAIN_TS.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

describe('main.ts settings publication boundaries', () => {
  it('answers settings:get with a clamped record', () => {
    const line = MAIN_TS.split('\n').find(l => l.includes("handleIpc('settings:get'"))
    expect(line).toBeDefined()
    expect(line).toContain('clampTelemetryForRenderer')
  })

  it('has exactly one place that puts a settings record on the settings:changed channel', () => {
    // Every publish site must funnel through `broadcastSettingsChanged`, which
    // applies the clamp. Direct `webContents.send('settings:changed', …)` calls
    // are what leaked the raw record from three separate sites before the fix.
    const directSends = MAIN_TS_CODE.match(/send\(\s*'settings:changed'/g) ?? []
    expect(directSends).toHaveLength(0)

    const broadcasts = MAIN_TS_CODE.match(/broadcast\(\s*'settings:changed'/g) ?? []
    expect(broadcasts).toHaveLength(1)
  })

  // §2.82 iter3 finding 5 — a failed RAW read must not erase a refusal.
  //
  // `applyAboutToggle` reads anything other than `false` as "no expressed
  // opt-out on disk" and writes `true`. So when `getRawPersistedSettings()`
  // threw, the old `catch { return undefined }` turned a stored `false` into
  // `true` on the next unrelated `settings:save` — telemetry stayed off (there
  // is still no consent record), but the evidence of the earlier refusal was
  // gone and `migrateTelemetryConsent` would ask the user again.
  //
  // The fallback is the PARSED current value: identical to the raw one except
  // when the key is absent, and absent is not a refusal either.
  it('falls back to the parsed value when the raw settings read throws', () => {
    const marker = 'const persistedSentryEnabled = (() => {'
    const start = MAIN_TS.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const block = MAIN_TS.slice(start, MAIN_TS.indexOf('})()', start))
    expect(block).toContain('getRawPersistedSettings()?.sentryEnabled')
    expect(block).toMatch(/catch\s*\{\s*return\s+current\.sentryEnabled\s*\}/)
    expect(block).not.toMatch(/catch\s*\{\s*return\s+undefined\s*\}/)
  })

  it('the single publish site applies the clamp', () => {
    const fnStart = MAIN_TS.indexOf('function broadcastSettingsChanged')
    expect(fnStart).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(fnStart, MAIN_TS.indexOf('\n}', fnStart))
    expect(body).toContain('clampTelemetryForRenderer')
    expect(body).toContain("broadcast('settings:changed'")
  })
})

// §2.167 — `settings:save` refuses the offending FIELD instead of accepting an
// out-of-domain value, and the §3.10 P0 whole-payload gate keeps its place in
// front of that. The decision is unit-tested in settingsSaveRefusal.test.ts;
// what cannot be imported is the handler, so the two things a refactor could
// silently invert — the ORDER of the two verdicts, and which payload the merge
// reads — are asserted against the source.
describe('main.ts settings:save per-field refusal', () => {
  const start = MAIN_TS.indexOf("handleIpc('settings:save'")
  const handler = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
  const forbiddenReturn = handler.indexOf("reason: 'forbidden_field' as const")
  // The notes inside the handler name the calls they are about — including
  // `getSettings()`, in the very comment explaining why it is no longer the
  // first line — so ORDER assertions read a code-only view of the same slice.
  const codeStart = MAIN_TS_CODE.indexOf("handleIpc('settings:save'")
  const handlerCode = MAIN_TS_CODE.slice(codeStart, MAIN_TS_CODE.indexOf('\n})', codeStart))
  const forbiddenReturnCode = handlerCode.indexOf("reason: 'forbidden_field' as const")

  it('runs the §3.10 P0 gate before anything is stripped or merged', () => {
    expect(start).toBeGreaterThan(-1)
    const partition = handler.indexOf('partitionRendererSettingsIssues(')
    const strip = handler.indexOf('stripRefusedFields(')
    expect(partition).toBeGreaterThan(-1)
    expect(strip).toBeGreaterThan(-1)
    expect(forbiddenReturn).toBeGreaterThan(partition)
    // Per-field refusal is a continuation of the path the gate did NOT take.
    // A `stripRefusedFields` hoisted above the gate would turn the gate into a
    // branch inside the new logic instead of a prefix in front of it.
    expect(strip).toBeGreaterThan(forbiddenReturn)
  })

  // §2.167 branch C (codex, medium) — the gate is a STRICT PREFIX: it decides
  // from the payload alone, so nothing that touches persisted state may run in
  // front of it. `getSettings()` is not the pure lookup its name suggests — it
  // runs the single-account migration, and on a legacy record it sanitizes
  // forbidden `mcpConnections[].env` keys, writes the store back and raises an
  // audit notification, while an unrescuable record makes it THROW (which would
  // cost the refusal its own audit row). It used to be the handler's first line.
  it('decides the forbidden-field verdict before it reads persisted settings', () => {
    const parse = handlerCode.indexOf('rendererWritableSettingsSchema.safeParse(')
    const partition = handlerCode.indexOf('partitionRendererSettingsIssues(')
    const read = handlerCode.indexOf('getSettings()')
    expect(parse).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(-1)
    expect(parse).toBeLessThan(partition)
    expect(partition).toBeLessThan(forbiddenReturnCode)
    // The FIRST read of the store — `indexOf` — is downstream of the refusal,
    // so neither the §2.119 snapshot nor its post-dialog re-read can creep back
    // in front of the gate.
    expect(read).toBeGreaterThan(forbiddenReturnCode)
  })

  it('keeps the whole ordered chain from parse to emission', () => {
    // One assertion for the pipeline the two findings above are about, so a
    // future reshuffle has to face the order as a whole rather than one pair.
    const steps = [
      'rendererWritableSettingsSchema.safeParse(',
      "reason: 'forbidden_field' as const",
      'dropErasingUndefined(stripRefusedFields(',
      'getSettings()',
      'applyAiDestinationOverrides(',
      'saveSettings(next)',
      "recordEvent('settings.field_refused'",
    ]
    const positions = steps.map(step => handlerCode.indexOf(step))
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  // §2.167 branch C (codex, high) — a key PRESENT with `undefined` is not an
  // absent key to `{ ...current, ...accepted }`: it overwrites the persisted
  // value, `saveSettings` drops it from disk, and a `mcpExportWhitelist` that
  // narrowed the exported tool surface silently reverts to the default set.
  // The decision is unit-tested in settingsSaveRefusal.test.ts; what is pinned
  // here is that the handler actually applies it, and applies it to the object
  // the merge reads.
  it('normalises the accepted payload before it is merged', () => {
    const drop = handlerCode.indexOf('dropErasingUndefined(')
    const merge = handlerCode.indexOf('applyAiDestinationOverrides(')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(merge)
    // Composed onto the same `accepted` the merge and the §2.119 resolution
    // read — a second variable would leave the raw payload reachable.
    expect(handlerCode).toContain(
      'const accepted = dropErasingUndefined(stripRefusedFields(s, refusedFields))',
    )
  })

  it('writes nothing on the forbidden-field path', () => {
    // What makes the P0 gate a gate is that the handler ends there — before
    // the merge, the save, the broadcast and the runtime reactions.
    const beforeRefusal = handler.slice(0, forbiddenReturn)
    expect(forbiddenReturn).toBeGreaterThan(-1)
    for (const writer of [
      'saveSettings(',
      'settingsSchema.parse(',
      'broadcastSettingsChanged(',
      'onSettingsChangedMain(',
      'setSentryUserEnabled(',
    ]) {
      // Non-vacuous: each writer must exist in the handler, just not above.
      expect(handler).toContain(writer)
      expect(beforeRefusal).not.toContain(writer)
    }
    // …and it says so with the whole-payload verdict, not a per-field one.
    expect(handler.slice(forbiddenReturn - 200, forbiddenReturn)).toContain('ok: false as const')
  })

  it('merges the stripped payload, never the raw one', () => {
    const merge = handler.indexOf('applyAiDestinationOverrides(')
    expect(merge).toBeGreaterThan(-1)
    // The raw `s` must not reach the merge or the §2.119 destination
    // resolution: that is the one path on which a refused field could come
    // back after being dropped.
    expect(handler).toContain('...(accepted as Record<string, unknown>)')
    expect(handler).not.toContain('...(s as Record<string, unknown>)')
    expect(handler).toContain('resolveRequestedAiDestination(accepted, current)')
  })

  it('reports the refusal alongside a successful save', () => {
    // `ok: true` — the save happened; the renderer is told which field did not.
    expect(handler).toContain('refused: refusedFields')
    // The PREFIX is what is pinned, not the whole statement: the reply carries
    // one member per independent gate over the same payload (§2.103 added the
    // declined-dictionary notice), and pinning the closing brace would make
    // every future gate look like a regression of this one.
    expect(handler).toMatch(/return \{ ok: true as const, \.\.\.refusal[,\s}]/)
  })

  it('spreads the refusal into the ai-destination-rejected reply too, not only the plain success', () => {
    // §2.119 and §2.167 are independent gates over the same payload — a save
    // can lose the address move AND a field in the same round trip. If the
    // per-field refusal were only spread into the LAST `return` statement, that
    // composition would silently drop `refused` whenever `aiDestinationRejected`
    // fires — the renderer would never see it, the whitelist would never be
    // repaired, and the stale name would be resubmitted forever.
    const rejectedIdx = handler.indexOf('aiDestinationRejected: {')
    expect(rejectedIdx).toBeGreaterThan(-1)
    const finalReturnIdx = handler.indexOf('return { ok: true as const, ...refusal')
    expect(finalReturnIdx).toBeGreaterThan(rejectedIdx)
    const rejectedBlock = handler.slice(rejectedIdx, finalReturnIdx)
    expect(rejectedBlock).toContain('...refusal,')
  })

  it('hands the submitted payload to the classifier so the refusal can name values', () => {
    // Zod does not carry the offending entry on the issue (`invalid_value`
    // reports the ALLOWED options), so without the payload `values` is empty
    // and the settings window is back to guessing the export ceiling — the
    // renderer-side mirror this half exists to delete.
    const idx = handler.indexOf('partitionRendererSettingsIssues(')
    expect(idx).toBeGreaterThan(-1)
    const call = handler.slice(idx, handler.indexOf(')\n', idx))
    expect(call).toContain('rendererParsed.error.issues')
    expect(call).toMatch(/,\s*s,/)
  })

  // §2.167 branch C (codex, medium) — the refusal line claims "rest of the
  // payload applied". That sentence is only true once the write has happened,
  // and between the strip and the write the handler can still throw:
  // `settingsSchema.parse` rejects any OTHER invalid field, and a compromised
  // renderer controls both halves of such a payload. Emitting at strip time
  // therefore let it drive a log line and a Sentry counter describing a save
  // that never landed. The emission site is the invariant, so it is pinned
  // against the source in both directions.
  it('announces the refusal only after the save has happened', () => {
    const saveIdx = handler.indexOf('saveSettings(next)')
    const logIdx = handler.indexOf("logMain.warn('settings:save: field refused")
    const recordIdx = handler.indexOf("recordEvent('settings.field_refused'")
    expect(saveIdx).toBeGreaterThan(-1)
    expect(logIdx).toBeGreaterThan(saveIdx)
    expect(recordIdx).toBeGreaterThan(saveIdx)
  })

  it('has no refusal emission before the save at all', () => {
    // The assertion above would still pass if a SECOND emission stayed behind
    // at the strip site, which is exactly the shape a partial revert takes.
    const saveIdx = handler.indexOf('saveSettings(next)')
    const beforeSave = handler.slice(0, saveIdx)
    expect(beforeSave).not.toContain("logMain.warn('settings:save: field refused")
    expect(beforeSave).not.toContain("recordEvent('settings.field_refused'")
    // …and the emission is not duplicated after it either: exactly one of each,
    // so a save cannot be counted twice for the same request.
    expect(handler.match(/logMain\.warn\('settings:save: field refused/g)).toHaveLength(1)
    expect(handler.match(/recordEvent\('settings\.field_refused'/g)).toHaveLength(1)
  })

  it('keeps both success replies downstream of the single emission', () => {
    // One emission per request only holds while every path that returns a
    // successful save passes through it — the §2.119 rejected-destination reply
    // is a second such path.
    const logIdx = handler.indexOf("logMain.warn('settings:save: field refused")
    expect(logIdx).toBeGreaterThan(-1)
    expect(handler.indexOf('aiDestinationRejected: {')).toBeGreaterThan(logIdx)
    expect(handler.indexOf('return { ok: true as const, ...refusal')).toBeGreaterThan(logIdx)
  })

  it('logs the refusal without echoing renderer input', () => {
    const logIdx = handler.indexOf("logMain.warn('settings:save: field refused")
    expect(logIdx).toBeGreaterThan(-1)
    const logCall = handler.slice(logIdx, handler.indexOf('})', logIdx))
    // CLAUDE.md §8: only our own closed vocabulary (field names and codes from
    // settingsSaveRefusal.ts) — never the submitted values or zod's message,
    // which quotes them.
    expect(logCall).toContain('refused.field')
    expect(logCall).toContain('refused.code')
    expect(logCall).not.toContain('${')
    expect(logCall).not.toContain('issues')
    // §2.167 branch C — `values` is renderer-facing ONLY. The reply may echo
    // the sender its own input; a log file is read by someone else, on disk,
    // later.
    expect(logCall).not.toContain('values')
    // …and not by handing the whole refusal object over either.
    expect(logCall).not.toMatch(/,\s*refused\s*\)/)
  })

  it('counts the refusal without letting telemetry decide the save', () => {
    const recordIdx = handler.indexOf("recordEvent('settings.field_refused'")
    expect(recordIdx).toBeGreaterThan(-1)
    const call = handler.slice(recordIdx, handler.indexOf('\n', recordIdx))
    // Same two closed enums as the log line, and nothing else.
    expect(call).toContain('field: refused.field')
    expect(call).toContain('code: refused.code')
    expect(call).not.toContain('${')
    // The event carries tag domains, not free text: `values` here would ship
    // renderer-chosen strings to Sentry.
    expect(call).not.toContain('values')
    // CLAUDE.md §8: fire-and-forget. A throwing telemetry sink must not turn a
    // partially-applied save into a failed IPC call.
    expect(handler.slice(recordIdx - 120, recordIdx)).toContain('try {')
    expect(handler.slice(recordIdx, recordIdx + 260)).toContain('catch { /* telemetry must not block */ }')
  })
})

// §2.82 iter3 finding 2 (WHO) — the service defaults `isMainWindowSender` to
// `() => false`, so a wiring that forgets the predicate rejects every consent
// write. The behaviour of the gate is unit-tested in the service suite; what
// this guards is the wiring itself, which cannot be imported.
// §2.82 iter4 (security finding 1) — `settings:save` may only accept an
// About-switch value that turns telemetry ON when it comes from the settings
// window. The decision itself is unit-tested in telemetryConsent.test.ts
// (applyAboutToggleFromOrigin); what cannot be imported is the wiring, so the
// two things that could silently undo it are asserted against the source:
// the handler passing an origin at all, and the predicate resolving the
// SETTINGS window rather than the main one.
describe('main.ts About-switch sender gate', () => {
  it('routes settings:save through the origin-aware helper, not the ungated one', () => {
    expect(MAIN_TS_CODE).toContain('applyAboutToggleFromOrigin(')
    // The ungated helper must not be reachable from main.ts any more.
    expect(MAIN_TS_CODE).not.toMatch(/[^a-zA-Z]applyAboutToggle\(/)
  })

  it('derives the origin from the settings-window sender identity', () => {
    const start = MAIN_TS.indexOf("handleIpc('settings:save'")
    expect(start).toBeGreaterThan(-1)
    const handler = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(handler).toContain('isSettingsWindowSender(event?.sender)')
    expect(handler).toContain("'settings-window'")
    expect(handler).toContain("'other-window'")
  })

  it('the predicate checks identity against the live settings window', () => {
    const start = MAIN_TS.indexOf('function isSettingsWindowSender')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))
    expect(body).toContain('settingsWin.webContents')
    expect(body).toContain('settingsWin.isDestroyed()')
    // The main-window predicate would reject the ONE window that carries the
    // switch, leaving the user unable to consent after a refusal.
    expect(body).not.toMatch(/(?<![A-Za-z])win\.webContents/)
  })
})

describe('main.ts telemetry consent wiring', () => {
  it('hands the consent service a main-window sender predicate', () => {
    const start = MAIN_TS.indexOf('initTelemetryConsent({')
    expect(start).toBeGreaterThan(-1)
    const call = MAIN_TS.slice(start, MAIN_TS.indexOf('})', start))
    expect(call).toContain('isMainWindowSender')
    // Identity against the live main window, evaluated per call — not a
    // captured `webContents` (the window does not exist at wiring time) and
    // not a truthiness check.
    expect(call).toContain('win.webContents')
    expect(call).toContain('win.isDestroyed()')
  })
})

// §2.58 iter2 (security review finding 1) — `update:systemInfo` answers with
// `process.execPath`. On a user-local install that path carries the home
// directory and therefore the account name, so the payload is only meant for
// the About panel, which renders exclusively inside the settings window
// (src/Root.tsx routes `#/settings`). Without a sender check any renderer on
// the preload whitelist could harvest it. The handler cannot be imported (the
// module opens windows, the DB and registers every IPC on load), so — like the
// About-switch gate above — the wiring is asserted against the source.
describe('main.ts update:systemInfo sender gate', () => {
  const start = MAIN_TS.indexOf("handleIpc('update:systemInfo'")
  const handler = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))

  it('refuses every sender that is not the settings window', () => {
    expect(start).toBeGreaterThan(-1)
    // Fail-closed: the NEGATIVE branch is the refusal, so an unknown or
    // destroyed window falls into it (see isSettingsWindowSender).
    expect(handler).toMatch(/if\s*\(!isSettingsWindowSender\(event\?\.sender\)\)/)
    expect(handler).toMatch(/return null/)
  })

  it('decides before it reads process.execPath', () => {
    const gateIdx = handler.indexOf('isSettingsWindowSender')
    const execPathIdx = handler.indexOf('process.execPath')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(execPathIdx).toBeGreaterThan(-1)
    // A gate evaluated after the payload is built is a gate that a later
    // refactor can drop without changing the answer for the allowed caller.
    expect(execPathIdx).toBeGreaterThan(gateIdx)
  })

  it('logs the refusal without echoing the sender or the payload', () => {
    const logLine = handler.split('\n').find(l => l.includes('logUpdate.warn'))
    expect(logLine).toBeDefined()
    // CLAUDE.md §8: no interpolation at all in the refusal line — sender
    // identity and payload fields are renderer-derived.
    expect(logLine).not.toContain('${')
  })
})

// §1.26.f2 — an AI consent may only name a mailbox that exists.
//
// `forgetAccountAiConsents` purges the deleted id from the stored maps, but the
// settings window is a SECOND writer: it loads all four maps once (a
// `[]`-dependency effect) and re-submits them whole on every save, so a window
// that was open across the deletion merges the purged `true` straight back in.
// Ids are reused (`max + 1`), so the entry can then be read as consent from a
// mailbox whose owner was never asked.
//
// The decision is unit-tested in accountKeyedConsents.test.ts. What cannot be
// imported is the handler, so what is pinned here is that main applies the rule
// at all, applies it to the object it is about to persist, and reads the
// account registry at a point where a deletion that raced the save is visible.
describe('main.ts settings:save account-keyed consent scope', () => {
  const codeStart = MAIN_TS_CODE.indexOf("handleIpc('settings:save'")
  const handlerCode = MAIN_TS_CODE.slice(codeStart, MAIN_TS_CODE.indexOf('\n})', codeStart))

  it('scopes the consent maps to existing mailboxes before persisting them', () => {
    expect(codeStart).toBeGreaterThan(-1)
    const prune = handlerCode.indexOf('pruneUnknownAccountConsents(')
    const parse = handlerCode.indexOf('settingsSchema.parse(')
    const save = handlerCode.indexOf('saveSettings(next)')
    expect(prune).toBeGreaterThan(-1)
    expect(prune).toBeLessThan(parse)
    expect(prune).toBeLessThan(save)
    // The canonical field list, not a second copy spelled out at the call site.
    expect(handlerCode).toContain('ACCOUNT_KEYED_CONSENT_FIELDS')
  })

  it('prunes the merged object, so a stale entry already in the store is cleared too', () => {
    // Pruning the PAYLOAD would leave an entry an older build persisted
    // untouched: the window that would re-submit it is exactly the window that
    // may not be the one saving.
    expect(handlerCode).toMatch(/pruneUnknownAccountConsents\(\s*merged\s*,/)
    // …and what is persisted is the pruned object, not the unpruned `merged`.
    expect(handlerCode).toContain('settingsSchema.parse(consentScope.settings)')
    expect(handlerCode).not.toContain('settingsSchema.parse(merged)')
  })

  it('reads the account registry after the post-dialog settings re-read', () => {
    // The §2.119 / §2.103 gates can block on a native dialog for a minute, and
    // an account can be deleted meanwhile. A registry snapshot taken before the
    // wait would still list the deleted mailbox and let the entry through.
    const reread = handlerCode.lastIndexOf('current = getSettings()')
    const registry = handlerCode.indexOf('listAccounts()')
    expect(reread).toBeGreaterThan(-1)
    expect(registry).toBeGreaterThan(reread)
  })

  it('consults the roster accounts:list serves, not the config store directly', () => {
    // Under `MAILCOPILOT_E2E=1` in an unpackaged build that roster is the
    // in-memory `E2E_ACCOUNTS` fixture (same branch as `mail:openInWindow` and
    // `pendingMoveAccountExists`). Reading `listAccounts()` unconditionally
    // reports NO accounts there, so every consent the renderer can legitimately
    // hold would be pruned as belonging to nobody.
    expect(handlerCode).toMatch(/const roster = IS_E2E \? E2E_ACCOUNTS : listAccounts\(\)/)
  })

  it('keeps the stored maps when the account roster cannot be read', () => {
    // Not "prune against an empty set" (a silent mass withdrawal on a transient
    // failure) and not "let it through" (the hole itself).
    expect(handlerCode).toContain('keepStoredConsents(merged, current, ACCOUNT_KEYED_CONSENT_FIELDS)')
    expect(handlerCode).toMatch(/catch\s*\{\s*return null\s*\}/)
  })

  it('logs the scoping without naming an account id', () => {
    const logIdx = handlerCode.indexOf("logMain.warn('settings:save: account-keyed consent scoped")
    expect(logIdx).toBeGreaterThan(-1)
    const line = handlerCode.slice(logIdx, handlerCode.indexOf('})', logIdx))
    // CLAUDE.md §8: closed vocabulary (our own field names) plus counts.
    expect(line).toContain('consentScope.changedFields.join')
    expect(line).toContain('consentScope.droppedEntries')
    expect(line).not.toContain('${')
  })
})
