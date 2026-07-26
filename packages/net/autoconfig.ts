import dns from 'node:dns/promises'
import net from 'node:net'
import { XMLParser } from 'fast-xml-parser'
import type { AutoconfigResult } from './types'

type ServerConfig = { host: string; port: number; secure: boolean }

type ThunderbirdConfig = {
  imap?: ServerConfig
  smtp?: ServerConfig
  displayName?: string
}

type AutoconfigDeps = {
  fetch: typeof globalThis.fetch
  resolveMx: typeof dns.resolveMx
  probePort: (host: string, port: number, timeoutMs?: number) => Promise<boolean>
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  trimValues: true,
})

const PRESETS: Record<string, Omit<AutoconfigResult, 'source'>> = {
  'gmail.com': {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    displayName: 'Gmail',
  },
  'outlook.com': {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    displayName: 'Outlook',
  },
  'hotmail.com': {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    displayName: 'Outlook',
  },
  'yahoo.com': {
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    displayName: 'Yahoo',
  },
  'mail.ru': {
    imap: { host: 'imap.mail.ru', port: 993, secure: true },
    smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
    displayName: 'Mail.ru',
  },
  'yandex.ru': {
    imap: { host: 'imap.yandex.ru', port: 993, secure: true },
    smtp: { host: 'smtp.yandex.ru', port: 465, secure: true },
    displayName: 'Yandex',
  },
  'yandex.com': {
    imap: { host: 'imap.yandex.com', port: 993, secure: true },
    smtp: { host: 'smtp.yandex.com', port: 465, secure: true },
    displayName: 'Yandex',
  },
  'icloud.com': {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    displayName: 'iCloud',
  },
}

function ensureArray<T>(x: T | T[] | undefined): T[] {
  if (!x) return []
  return Array.isArray(x) ? x : [x]
}

function parseEmail(email: string): { local: string; domain: string } | null {
  const e = (email || '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at <= 0 || at >= e.length - 1) return null
  return { local: e.slice(0, at), domain: e.slice(at + 1) }
}

function expandTemplate(value: string, email: string, local: string, domain: string): string {
  return value
    .replace(/%EMAILADDRESS%/g, email)
    .replace(/%EMAILLOCALPART%/g, local)
    .replace(/%EMAILDOMAIN%/g, domain)
}

function mapSocketToSecure(socketTypeRaw: string | undefined, port: number): boolean {
  const socketType = (socketTypeRaw || '').trim().toUpperCase()
  if (socketType.includes('SSL')) return true
  if (socketType.includes('STARTTLS')) return false
  if (port === 993 || port === 465) return true
  return false
}

function parseThunderbirdXml(xml: string, email: string): ThunderbirdConfig | null {
  try {
    const parsed = parser.parse(xml) as {
      clientConfig?: { emailProvider?: unknown }
    }
    const info = parseEmail(email)
    if (!info) return null

    const providers = ensureArray(parsed.clientConfig?.emailProvider as unknown)
    for (const provider of providers) {
      const p = provider as {
        displayName?: unknown
        incomingServer?: unknown
        outgoingServer?: unknown
      }
      const incomingServers = ensureArray(p.incomingServer as unknown)
      const outgoingServers = ensureArray(p.outgoingServer as unknown)

      const incoming = incomingServers.find(s => {
        const type = String((s as { type?: unknown }).type || '').toLowerCase()
        return type === 'imap'
      }) as { hostname?: unknown; port?: unknown; socketType?: unknown } | undefined

      const outgoing = outgoingServers.find(s => {
        const type = String((s as { type?: unknown }).type || '').toLowerCase()
        return type === 'smtp'
      }) as { hostname?: unknown; port?: unknown; socketType?: unknown } | undefined

      if (!incoming || !outgoing) continue

      const imapHostRaw = String(incoming.hostname || '').trim()
      const smtpHostRaw = String(outgoing.hostname || '').trim()
      const imapPort = Number(incoming.port || 0)
      const smtpPort = Number(outgoing.port || 0)
      if (!imapHostRaw || !smtpHostRaw || !Number.isFinite(imapPort) || !Number.isFinite(smtpPort)) continue

      const imap: ServerConfig = {
        host: expandTemplate(imapHostRaw, email, info.local, info.domain),
        port: imapPort,
        secure: mapSocketToSecure(typeof incoming.socketType === 'string' ? incoming.socketType : undefined, imapPort),
      }

      const smtp: ServerConfig = {
        host: expandTemplate(smtpHostRaw, email, info.local, info.domain),
        port: smtpPort,
        secure: mapSocketToSecure(typeof outgoing.socketType === 'string' ? outgoing.socketType : undefined, smtpPort),
      }

      const displayName = String(p.displayName || '').trim() || undefined
      return { imap, smtp, displayName }
    }
  } catch {
    // ignore parse errors
  }
  return null
}

async function fetchXml(url: string, deps: AutoconfigDeps, timeoutMs = 4000): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await deps.fetch(url, { signal: ac.signal })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function withSource(cfg: ThunderbirdConfig, source: AutoconfigResult['source']): AutoconfigResult | null {
  if (!cfg.imap || !cfg.smtp) return null
  return {
    imap: cfg.imap,
    smtp: cfg.smtp,
    displayName: cfg.displayName,
    source,
  }
}

async function tryIspdb(domain: string, email: string, deps: AutoconfigDeps): Promise<AutoconfigResult | null> {
  const xml = await fetchXml(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, deps)
  if (!xml) return null
  const parsed = parseThunderbirdXml(xml, email)
  return parsed ? withSource(parsed, 'ispdb') : null
}

async function tryDomainAutoconfig(domain: string, email: string, deps: AutoconfigDeps): Promise<AutoconfigResult | null> {
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ]
  for (const url of urls) {
    const xml = await fetchXml(url, deps)
    if (!xml) continue
    const parsed = parseThunderbirdXml(xml, email)
    if (parsed?.imap && parsed?.smtp) return withSource(parsed, 'domain-autoconfig')
  }
  return null
}

async function tryGuess(domain: string, deps: AutoconfigDeps): Promise<AutoconfigResult | null> {
  const imapCandidates: ServerConfig[] = [
    { host: `imap.${domain}`, port: 993, secure: true },
    { host: `mail.${domain}`, port: 993, secure: true },
    { host: `imap.${domain}`, port: 143, secure: false },
    { host: `mail.${domain}`, port: 143, secure: false },
  ]
  const smtpCandidates: ServerConfig[] = [
    { host: `smtp.${domain}`, port: 465, secure: true },
    { host: `smtp.${domain}`, port: 587, secure: false },
    { host: `mail.${domain}`, port: 465, secure: true },
    { host: `mail.${domain}`, port: 587, secure: false },
  ]

  const probeInOrder = async (items: ServerConfig[]): Promise<ServerConfig | null> => {
    for (const item of items) {
      if (await deps.probePort(item.host, item.port)) return item
    }
    return null
  }

  const [imap, smtp] = await Promise.all([probeInOrder(imapCandidates), probeInOrder(smtpCandidates)])
  if (!imap || !smtp) return null
  return { imap, smtp, source: 'guess' }
}

async function probePort(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

function presetForDomain(domain: string): AutoconfigResult | null {
  const cfg = PRESETS[domain]
  if (!cfg) return null
  return { ...cfg, source: 'preset' }
}

export async function autoconfig(email: string): Promise<AutoconfigResult | null> {
  return autoconfigWithDeps(email, {
    fetch: globalThis.fetch.bind(globalThis),
    resolveMx: dns.resolveMx.bind(dns),
    probePort,
  })
}

export async function autoconfigWithDeps(email: string, deps: AutoconfigDeps): Promise<AutoconfigResult | null> {
  const info = parseEmail(email)
  if (!info) return null

  const directPreset = presetForDomain(info.domain)
  if (directPreset) return directPreset

  const byIspdb = await tryIspdb(info.domain, email, deps)
  if (byIspdb) return byIspdb

  const byDomainAutoconfig = await tryDomainAutoconfig(info.domain, email, deps)
  if (byDomainAutoconfig) return byDomainAutoconfig

  try {
    const mx = await deps.resolveMx(info.domain)
    const topMx = mx
      .slice()
      .sort((a, b) => a.priority - b.priority)[0]
    const mxDomain = (topMx?.exchange || '').replace(/\.$/, '').toLowerCase()
    if (mxDomain && mxDomain !== info.domain) {
      const byMx = await tryIspdb(mxDomain, email, deps)
      if (byMx) return { ...byMx, source: 'mx-lookup' }
      const mxPreset = presetForDomain(mxDomain)
      if (mxPreset) return { ...mxPreset, source: 'mx-lookup' }
    }
  } catch {
    // ignore DNS errors
  }

  const guessed = await tryGuess(info.domain, deps)
  if (guessed) return guessed

  return null
}

export const __private__ = {
  parseThunderbirdXml,
}
