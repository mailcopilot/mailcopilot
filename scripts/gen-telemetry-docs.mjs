#!/usr/bin/env node
/**
 * Generate docs/docs/telemetry.md from electron/metricsSchema.ts.
 *
 * The schema is the source of truth. Running this script after any edit to
 * metricsSchema.ts keeps the public telemetry documentation in sync without
 * forcing us to update 6 markdown files by hand.
 *
 * NOTE: only the English version is generated for now. Translations live in
 * docs/i18n/{locale}/... — they should be updated via the usual translation
 * flow when event semantics change meaningfully.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_FILE = path.join(ROOT, 'electron/metricsSchema.ts')
const OUT_FILE = path.join(ROOT, 'docs/docs/privacy/telemetry.md')

async function parseSchema() {
  const src = await readFile(SCHEMA_FILE, 'utf8')
  const start = src.indexOf('export const METRIC_EVENTS')
  if (start < 0) throw new Error('METRIC_EVENTS not found')
  const tail = src.slice(start)
  const end = tail.indexOf('} as const satisfies')
  if (end < 0) throw new Error('could not find end of METRIC_EVENTS block')
  const body = tail.slice(0, end)

  // Walk through the body by locating each "'name': {" marker, then do a
  // brace-aware scan to find the matching closing brace. This is more robust
  // than a single regex for entries with nested `tags: { ... }` blocks.
  const entries = []
  const nameRe = /'([a-zA-Z0-9_.]+)'\s*:\s*\{/g
  let m
  while ((m = nameRe.exec(body)) !== null) {
    const name = m[1]
    let depth = 1
    let i = nameRe.lastIndex
    while (i < body.length && depth > 0) {
      const ch = body[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    const block = body.slice(m.index + m[0].length, i - 1)
    nameRe.lastIndex = i

    const kindMatch = /kind\s*:\s*'(event|histogram|gauge)'/.exec(block)
    const purposeMatch = /purpose\s*:\s*'([^']*)'/.exec(block)
    const aggMatch = /aggregate\s*:\s*true/.test(block)
    const tagsBlockMatch = /tags\s*:\s*\{([^}]*)\}/.exec(block)
    const tagKeys = []
    if (tagsBlockMatch) {
      const tagRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g
      let tm
      while ((tm = tagRe.exec(tagsBlockMatch[1])) !== null) tagKeys.push(tm[1])
    }
    entries.push({
      name,
      kind: kindMatch?.[1] ?? 'event',
      purpose: purposeMatch?.[1] ?? '',
      aggregate: aggMatch,
      tags: tagKeys,
    })
  }
  return entries
}

function groupByDomain(entries) {
  const groups = new Map()
  for (const e of entries) {
    const domain = e.name.split('.')[0]
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain).push(e)
  }
  return groups
}

function renderMarkdown(entries) {
  const groups = groupByDomain(entries)
  const lines = []
  lines.push('---')
  lines.push('title: Telemetry')
  lines.push('sidebar_position: 2')
  lines.push('---')
  lines.push('')
  lines.push('# Telemetry')
  lines.push('')
  // Wording note (§2.82): this data is NOT anonymous — every event carries the
  // stable install identifier, which is pseudonymisation, not anonymisation.
  // The strings below must keep saying so; the consent screen, Settings → About
  // and docs/docs/privacy/telemetry.md all state it, and a generator that
  // reverts to "anonymous" would silently overwrite that page with a claim the
  // product does not make.
  lines.push('MailCopilot can send a small amount of diagnostic and usage data — but only after you actively agree to it. It never contains the content of your mail, but it does include a random identifier for this installation, so the data is **not fully anonymous**: see [Install identifier](#install-identifier) below for exactly what that identifier does and does not let us learn. This page documents exactly what is collected, and — just as importantly — what is never collected.')
  lines.push('')
  lines.push('## What we never collect')
  lines.push('')
  lines.push('Under no circumstances does MailCopilot transmit any of the following:')
  lines.push('')
  lines.push('- The text of your messages (subject, body, attachments, drafts)')
  lines.push('- Your email addresses or those of your contacts')
  lines.push('- Folder names or paths on your IMAP server')
  lines.push('- File names of attachments')
  lines.push('- The text of your search queries')
  lines.push('- The content of AI chat conversations or AI memory')
  lines.push('- Server hostnames, ports, or credentials')
  lines.push('')
  lines.push('## How data is routed')
  lines.push('')
  lines.push('All telemetry is sent to [Sentry](https://sentry.io), our error monitoring and performance platform. When you disable the toggle in Settings, the pipeline is bypassed entirely — nothing is sent. When you enable debug logging, the same events also appear in your local `main.log` so you can inspect exactly what would be transmitted.')
  lines.push('')
  lines.push('### Install identifier')
  lines.push('')
  lines.push('On first run, MailCopilot generates a random UUID and stores it in the local config file. This UUID never leaves your device. What is transmitted instead is a SHA-256 hash of it — truncated to 16 hex characters — which we call `install_id_hash`. It is attached to every telemetry event as the Sentry user id so we can answer questions like "how many unique installs are running version X" or "is crash Y affecting 1 user or 100". The hash is:')
  lines.push('')
  lines.push('- **Not anonymous, but not identifying either** — it is not derived from, or correlated with, any account email, device fingerprint, IP address, or hardware identifier, so it cannot be traced back to you personally. It is, however, a stable per-installation identifier: everything a given install sends is linked together by it, across every session. That linkage is precisely why the consent screen does not call this data anonymous.')
  lines.push('- **Stable across releases** — the same install keeps the same hash when the app auto-updates, so retention metrics survive version bumps.')
  lines.push('- **Not reversible** — there is no mapping on our side from the hash back to the UUID or to your device.')
  lines.push('- **Dropped when you disable telemetry** — flipping the Settings toggle off immediately clears the identifier from the Sentry client and stops all further transmissions.')
  lines.push('')
  lines.push('We use this identifier in the same way a web analytics tool would use a visitor id: it lets us count *distinct* installs rather than *total events*. That difference is the entire reason telemetry is useful — without it, one noisy install would look the same as a hundred calm installs.')
  lines.push('')
  lines.push('## Events')
  lines.push('')

  const groupOrder = [
    ['app', 'App lifecycle'],
    ['usage', 'Usage summary'],
    ['onboarding', 'Onboarding'],
    ['compose', 'Compose'],
    ['send_queue', 'Send queue'],
    ['misdirection', 'Misdirection warnings'],
    ['template', 'Templates'],
    ['followup', 'Follow-up reminders'],
    ['search', 'Search'],
    ['body_indexer', 'Body indexer'],
    ['fts', 'Full-text index maintenance'],
    ['sync', 'Header sync'],
    ['ipc', 'IPC performance'],
    ['ui', 'UI responsiveness'],
  ]

  for (const [key, title] of groupOrder) {
    const group = groups.get(key)
    if (!group || group.length === 0) continue
    lines.push(`### ${title}`)
    lines.push('')
    lines.push('| Event | Kind | Aggregated | Tags | Purpose |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const e of group) {
      const tags = e.tags.length > 0 ? e.tags.map(t => `\`${t}\``).join(', ') : '—'
      const agg = e.aggregate ? 'yes (10s window)' : 'no'
      lines.push(`| \`${e.name}\` | ${e.kind} | ${agg} | ${tags} | ${e.purpose} |`)
    }
    lines.push('')
  }

  lines.push('## Contact')
  lines.push('')
  lines.push('Questions or concerns about what we collect? Open an issue at [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) or contact the team directly through the feedback form in Settings → About.')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const entries = await parseSchema()
  const md = renderMarkdown(entries)
  await mkdir(path.dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, md, 'utf8')
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${entries.length} metrics).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
