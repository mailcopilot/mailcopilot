import { describe, expect, it } from 'vitest'
import { isBlockedRemoteAddress, isBlockedRemoteHostname } from './safeRemoteFetch'

describe('packages/net/safeRemoteFetch', () => {
  describe('isBlockedRemoteHostname', () => {
    it('blocks localhost and internal suffixes', () => {
      expect(isBlockedRemoteHostname('localhost')).toBe(true)
      expect(isBlockedRemoteHostname('db.internal')).toBe(true)
      expect(isBlockedRemoteHostname('printer.local')).toBe(true)
      expect(isBlockedRemoteHostname('router.home.arpa')).toBe(true)
    })

    it('allows regular public hostnames', () => {
      expect(isBlockedRemoteHostname('example.com')).toBe(false)
      expect(isBlockedRemoteHostname('internal.example.com')).toBe(false)
    })

    it('blocks sub-domains of localhost', () => {
      expect(isBlockedRemoteHostname('app.localhost')).toBe(true)
    })

    it('handles trailing dots in hostnames', () => {
      expect(isBlockedRemoteHostname('localhost.')).toBe(true)
      expect(isBlockedRemoteHostname('example.com.')).toBe(false)
    })
  })

  describe('isBlockedRemoteAddress', () => {
    it('blocks local and private IPv4 ranges', () => {
      expect(isBlockedRemoteAddress('127.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('127.255.255.255')).toBe(true)
      expect(isBlockedRemoteAddress('10.0.0.5')).toBe(true)
      expect(isBlockedRemoteAddress('100.64.10.20')).toBe(true)
      expect(isBlockedRemoteAddress('169.254.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('172.20.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('192.168.1.10')).toBe(true)
      expect(isBlockedRemoteAddress('198.18.0.10')).toBe(true)
      expect(isBlockedRemoteAddress('0.0.0.0')).toBe(true)
    })

    it('blocks multicast and reserved IPv4 ranges', () => {
      expect(isBlockedRemoteAddress('224.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('255.255.255.255')).toBe(true)
    })

    it('blocks local and private IPv6 ranges', () => {
      expect(isBlockedRemoteAddress('::')).toBe(true)
      expect(isBlockedRemoteAddress('::1')).toBe(true)
      expect(isBlockedRemoteAddress('fe80::1')).toBe(true)
      expect(isBlockedRemoteAddress('fd00::1')).toBe(true)
      expect(isBlockedRemoteAddress('ff02::1')).toBe(true)
    })

    it('blocks IPv4-mapped IPv6 private addresses', () => {
      expect(isBlockedRemoteAddress('::ffff:127.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('::ffff:192.168.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('::ffff:10.0.0.1')).toBe(true)
    })

    it('allows IPv4-mapped IPv6 public addresses', () => {
      expect(isBlockedRemoteAddress('::ffff:8.8.8.8')).toBe(false)
    })

    it('allows public IPv4 and IPv6 addresses', () => {
      expect(isBlockedRemoteAddress('8.8.8.8')).toBe(false)
      expect(isBlockedRemoteAddress('1.1.1.1')).toBe(false)
      expect(isBlockedRemoteAddress('2001:4860:4860::8888')).toBe(false)
    })

    it('blocks invalid addresses', () => {
      expect(isBlockedRemoteAddress('not-an-ip')).toBe(true)
    })
  })

  // §3.10 P0 regression — the HTML email external-image proxy (main-process
  // `net:fetchExternalImage`) relies on requestSafeRemoteBytes -> resolveSafeAddress
  // to block SSRF-class targets that would otherwise be reachable from the
  // main process. These are the exact targets called out in the acceptance
  // criteria for the P0 HTML email hardening task. If any of these starts
  // returning `false`, the renderer iframe hardening is one short-circuit
  // away from letting a crafted email probe loopback/RFC1918 hosts.
  describe('§3.10 P0 HTML email SSRF block surface', () => {
    const SSRF_BLOCKED_ADDRESSES = [
      // IPv4 loopback / RFC1918 / link-local / multicast — the set named in
      // BACKLOG §3.10 P0 "HTML email external resource hardening".
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254', // cloud-metadata endpoint — classic SSRF pivot
      '224.0.0.1',       // multicast
      // IPv6 equivalents.
      '::1',             // loopback
      'fe80::1',         // link-local
      'ff02::1',         // multicast
    ]

    for (const addr of SSRF_BLOCKED_ADDRESSES) {
      it(`blocks SSRF target ${addr}`, () => {
        expect(isBlockedRemoteAddress(addr)).toBe(true)
      })
    }

    it('blocks localhost by hostname literal', () => {
      expect(isBlockedRemoteHostname('localhost')).toBe(true)
    })
  })
})
