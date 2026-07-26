import { describe, it, expect } from 'vitest'
import {
  bucketQueryLen,
  bucketResultCount,
  bucketDuration,
  bucketBodySize,
  bucketFolderCount,
  bucketFollowupDays,
  bucketTimeSinceSync,
  bucketSessionLength,
  bucketIdleDuration,
  bucketFetchedHeaders,
  bucketBatchSize,
  bucketOpsCount,
  bucketCount,
  bucketFreedBytes,
  providerFromHost,
  folderRoleFromPath,
} from './metricsBuckets'

describe('metricsBuckets', () => {
  describe('bucketQueryLen', () => {
    it('returns 1-2 for lengths 1 and 2', () => {
      expect(bucketQueryLen(1)).toBe('1-2')
      expect(bucketQueryLen(2)).toBe('1-2')
    })

    it('returns 3-5 for lengths 3 to 5', () => {
      expect(bucketQueryLen(3)).toBe('3-5')
      expect(bucketQueryLen(5)).toBe('3-5')
    })

    it('returns 6-10 for lengths 6 to 10', () => {
      expect(bucketQueryLen(6)).toBe('6-10')
      expect(bucketQueryLen(10)).toBe('6-10')
    })

    it('returns 11-20 for lengths 11 to 20', () => {
      expect(bucketQueryLen(11)).toBe('11-20')
      expect(bucketQueryLen(20)).toBe('11-20')
    })

    it('returns 21-50 for lengths 21 to 50', () => {
      expect(bucketQueryLen(21)).toBe('21-50')
      expect(bucketQueryLen(50)).toBe('21-50')
    })

    it('returns 50+ for lengths above 50', () => {
      expect(bucketQueryLen(51)).toBe('50+')
      expect(bucketQueryLen(999)).toBe('50+')
    })
  })

  describe('bucketResultCount', () => {
    it('returns 0 for zero', () => {
      expect(bucketResultCount(0)).toBe('0')
    })

    it('returns 1-5 for 1 to 5', () => {
      expect(bucketResultCount(1)).toBe('1-5')
      expect(bucketResultCount(5)).toBe('1-5')
    })

    it('returns 6-20 for 6 to 20', () => {
      expect(bucketResultCount(6)).toBe('6-20')
      expect(bucketResultCount(20)).toBe('6-20')
    })

    it('returns 21-50 for 21 to 50', () => {
      expect(bucketResultCount(21)).toBe('21-50')
      expect(bucketResultCount(50)).toBe('21-50')
    })

    it('returns 51-100 for 51 to 100', () => {
      expect(bucketResultCount(51)).toBe('51-100')
      expect(bucketResultCount(100)).toBe('51-100')
    })

    it('returns 100+ for values above 100', () => {
      expect(bucketResultCount(101)).toBe('100+')
    })
  })

  describe('bucketDuration', () => {
    it('returns <50 for sub-50ms', () => {
      expect(bucketDuration(0)).toBe('<50')
      expect(bucketDuration(49)).toBe('<50')
    })

    it('returns 50-100 for 50-99ms', () => {
      expect(bucketDuration(50)).toBe('50-100')
      expect(bucketDuration(99)).toBe('50-100')
    })

    it('returns 100-250 for 100-249ms', () => {
      expect(bucketDuration(100)).toBe('100-250')
      expect(bucketDuration(249)).toBe('100-250')
    })

    it('returns 250-500 for 250-499ms', () => {
      expect(bucketDuration(250)).toBe('250-500')
      expect(bucketDuration(499)).toBe('250-500')
    })

    it('returns 500-1000 for 500-999ms', () => {
      expect(bucketDuration(500)).toBe('500-1000')
      expect(bucketDuration(999)).toBe('500-1000')
    })

    it('returns 1000-2500 for 1000-2499ms', () => {
      expect(bucketDuration(1000)).toBe('1000-2500')
      expect(bucketDuration(2499)).toBe('1000-2500')
    })

    it('returns 2500-5000 for 2500-4999ms', () => {
      expect(bucketDuration(2500)).toBe('2500-5000')
      expect(bucketDuration(4999)).toBe('2500-5000')
    })

    it('returns 5000+ for 5000ms and above', () => {
      expect(bucketDuration(5000)).toBe('5000+')
      expect(bucketDuration(99999)).toBe('5000+')
    })
  })

  describe('bucketBodySize', () => {
    it('returns <1KB for sub-1024 bytes', () => {
      expect(bucketBodySize(0)).toBe('<1KB')
      expect(bucketBodySize(1023)).toBe('<1KB')
    })

    it('returns 1-10KB for 1KB to 10KB', () => {
      expect(bucketBodySize(1024)).toBe('1-10KB')
      expect(bucketBodySize(10 * 1024 - 1)).toBe('1-10KB')
    })

    it('returns 10-100KB for 10KB to 100KB', () => {
      expect(bucketBodySize(10 * 1024)).toBe('10-100KB')
      expect(bucketBodySize(100 * 1024 - 1)).toBe('10-100KB')
    })

    it('returns 100KB-1MB for 100KB to 1MB', () => {
      expect(bucketBodySize(100 * 1024)).toBe('100KB-1MB')
      expect(bucketBodySize(1024 * 1024 - 1)).toBe('100KB-1MB')
    })

    it('returns 1MB+ for 1MB and above', () => {
      expect(bucketBodySize(1024 * 1024)).toBe('1MB+')
    })
  })

  describe('bucketFolderCount', () => {
    it('returns 1-5 for 1 to 5', () => {
      expect(bucketFolderCount(1)).toBe('1-5')
      expect(bucketFolderCount(5)).toBe('1-5')
    })

    it('returns 6-15 for 6 to 15', () => {
      expect(bucketFolderCount(6)).toBe('6-15')
      expect(bucketFolderCount(15)).toBe('6-15')
    })

    it('returns 16-40 for 16 to 40', () => {
      expect(bucketFolderCount(16)).toBe('16-40')
      expect(bucketFolderCount(40)).toBe('16-40')
    })

    it('returns 40+ for above 40', () => {
      expect(bucketFolderCount(41)).toBe('40+')
    })
  })

  describe('bucketFollowupDays', () => {
    it('returns 1 for day 1 or less', () => {
      expect(bucketFollowupDays(0)).toBe('1')
      expect(bucketFollowupDays(1)).toBe('1')
    })

    it('returns 2-3 for days 2 to 3', () => {
      expect(bucketFollowupDays(2)).toBe('2-3')
      expect(bucketFollowupDays(3)).toBe('2-3')
    })

    it('returns 4-7 for days 4 to 7', () => {
      expect(bucketFollowupDays(4)).toBe('4-7')
      expect(bucketFollowupDays(7)).toBe('4-7')
    })

    it('returns 8-30 for days 8 to 30', () => {
      expect(bucketFollowupDays(8)).toBe('8-30')
      expect(bucketFollowupDays(30)).toBe('8-30')
    })

    it('returns 30+ for above 30 days', () => {
      expect(bucketFollowupDays(31)).toBe('30+')
    })
  })

  describe('bucketTimeSinceSync', () => {
    it('returns <5s for sub-5000ms', () => {
      expect(bucketTimeSinceSync(0)).toBe('<5s')
      expect(bucketTimeSinceSync(4999)).toBe('<5s')
    })

    it('returns 5-30s for 5000-29999ms', () => {
      expect(bucketTimeSinceSync(5000)).toBe('5-30s')
      expect(bucketTimeSinceSync(29999)).toBe('5-30s')
    })

    it('returns 30s-2min for 30s to 2min', () => {
      expect(bucketTimeSinceSync(30_000)).toBe('30s-2min')
      expect(bucketTimeSinceSync(2 * 60_000 - 1)).toBe('30s-2min')
    })

    it('returns 2-10min for 2min to 10min', () => {
      expect(bucketTimeSinceSync(2 * 60_000)).toBe('2-10min')
      expect(bucketTimeSinceSync(10 * 60_000 - 1)).toBe('2-10min')
    })

    it('returns 10-60min for 10min to 60min', () => {
      expect(bucketTimeSinceSync(10 * 60_000)).toBe('10-60min')
      expect(bucketTimeSinceSync(60 * 60_000 - 1)).toBe('10-60min')
    })

    it('returns 60min+ for 60min and above', () => {
      expect(bucketTimeSinceSync(60 * 60_000)).toBe('60min+')
    })
  })

  describe('bucketSessionLength', () => {
    it('returns <1min for sub-minute', () => {
      expect(bucketSessionLength(0)).toBe('<1min')
      expect(bucketSessionLength(59_999)).toBe('<1min')
    })

    it('returns 1-5min for 1 to 5 minutes', () => {
      expect(bucketSessionLength(60_000)).toBe('1-5min')
      expect(bucketSessionLength(4 * 60_000)).toBe('1-5min')
    })

    it('returns 5-30min for 5 to 30 minutes', () => {
      expect(bucketSessionLength(5 * 60_000)).toBe('5-30min')
      expect(bucketSessionLength(29 * 60_000)).toBe('5-30min')
    })

    it('returns 30min-2h for 30min to 2h', () => {
      expect(bucketSessionLength(30 * 60_000)).toBe('30min-2h')
      expect(bucketSessionLength(119 * 60_000)).toBe('30min-2h')
    })

    it('returns 2h+ for 2h and above', () => {
      expect(bucketSessionLength(120 * 60_000)).toBe('2h+')
    })
  })

  describe('bucketIdleDuration', () => {
    it('returns <1s for sub-second', () => {
      expect(bucketIdleDuration(0)).toBe('<1s')
      expect(bucketIdleDuration(999)).toBe('<1s')
    })

    it('returns 1-30s for 1 to 30 seconds', () => {
      expect(bucketIdleDuration(1000)).toBe('1-30s')
      expect(bucketIdleDuration(29_999)).toBe('1-30s')
    })

    it('returns 30s-5min for 30s to 5min', () => {
      expect(bucketIdleDuration(30_000)).toBe('30s-5min')
      expect(bucketIdleDuration(5 * 60_000 - 1)).toBe('30s-5min')
    })

    it('returns 5-20min for 5 to 20 minutes', () => {
      expect(bucketIdleDuration(5 * 60_000)).toBe('5-20min')
      expect(bucketIdleDuration(20 * 60_000 - 1)).toBe('5-20min')
    })

    it('returns 20-30min for 20 to 30 minutes', () => {
      expect(bucketIdleDuration(20 * 60_000)).toBe('20-30min')
      expect(bucketIdleDuration(30 * 60_000 - 1)).toBe('20-30min')
    })

    it('returns 30min+ for 30min and above', () => {
      expect(bucketIdleDuration(30 * 60_000)).toBe('30min+')
    })
  })

  describe('bucketFetchedHeaders', () => {
    it('returns 0 for zero or negative', () => {
      expect(bucketFetchedHeaders(0)).toBe('0')
      expect(bucketFetchedHeaders(-1)).toBe('0')
    })

    it('returns 1-10 for 1 to 10', () => {
      expect(bucketFetchedHeaders(1)).toBe('1-10')
      expect(bucketFetchedHeaders(10)).toBe('1-10')
    })

    it('returns 11-100 for 11 to 100', () => {
      expect(bucketFetchedHeaders(11)).toBe('11-100')
      expect(bucketFetchedHeaders(100)).toBe('11-100')
    })

    it('returns 101-1000 for 101 to 1000', () => {
      expect(bucketFetchedHeaders(101)).toBe('101-1000')
      expect(bucketFetchedHeaders(1000)).toBe('101-1000')
    })

    it('returns 1001-10000 for 1001 to 10000', () => {
      expect(bucketFetchedHeaders(1001)).toBe('1001-10000')
      expect(bucketFetchedHeaders(10_000)).toBe('1001-10000')
    })

    it('returns 10000+ for above 10000', () => {
      expect(bucketFetchedHeaders(10_001)).toBe('10000+')
    })
  })

  describe('bucketBatchSize', () => {
    it('returns 0 for zero or negative', () => {
      expect(bucketBatchSize(0)).toBe('0')
      expect(bucketBatchSize(-5)).toBe('0')
    })

    it('returns 1-10 for 1 to 10', () => {
      expect(bucketBatchSize(1)).toBe('1-10')
      expect(bucketBatchSize(10)).toBe('1-10')
    })

    it('returns 11-50 for 11 to 50', () => {
      expect(bucketBatchSize(11)).toBe('11-50')
      expect(bucketBatchSize(50)).toBe('11-50')
    })

    it('returns 51-100 for 51 to 100', () => {
      expect(bucketBatchSize(51)).toBe('51-100')
      expect(bucketBatchSize(100)).toBe('51-100')
    })

    it('returns 101-200 for 101 to 200', () => {
      expect(bucketBatchSize(101)).toBe('101-200')
      expect(bucketBatchSize(200)).toBe('101-200')
    })

    it('returns 200+ for above 200', () => {
      expect(bucketBatchSize(201)).toBe('200+')
    })
  })

  describe('bucketOpsCount', () => {
    it('returns 0 for zero or negative', () => {
      expect(bucketOpsCount(0)).toBe('0')
      expect(bucketOpsCount(-1)).toBe('0')
    })

    it('returns 1-5 for 1 to 5', () => {
      expect(bucketOpsCount(1)).toBe('1-5')
      expect(bucketOpsCount(5)).toBe('1-5')
    })

    it('returns 6-20 for 6 to 20', () => {
      expect(bucketOpsCount(6)).toBe('6-20')
      expect(bucketOpsCount(20)).toBe('6-20')
    })

    it('returns 21-50 for 21 to 50', () => {
      expect(bucketOpsCount(21)).toBe('21-50')
      expect(bucketOpsCount(50)).toBe('21-50')
    })

    it('returns 51-100 for 51 to 100', () => {
      expect(bucketOpsCount(51)).toBe('51-100')
      expect(bucketOpsCount(100)).toBe('51-100')
    })

    it('returns 100+ for above 100', () => {
      expect(bucketOpsCount(101)).toBe('100+')
    })
  })

  describe('bucketCount', () => {
    it('returns 0 for zero or negative', () => {
      expect(bucketCount(0)).toBe('0')
      expect(bucketCount(-1)).toBe('0')
    })

    it('returns exact values for 1 and 2', () => {
      expect(bucketCount(1)).toBe('1')
      expect(bucketCount(2)).toBe('2')
    })

    it('returns 3-5 for 3 to 5', () => {
      expect(bucketCount(3)).toBe('3-5')
      expect(bucketCount(5)).toBe('3-5')
    })

    it('returns 6-10 for 6 to 10', () => {
      expect(bucketCount(6)).toBe('6-10')
      expect(bucketCount(10)).toBe('6-10')
    })

    it('returns 11-20 for 11 to 20', () => {
      expect(bucketCount(11)).toBe('11-20')
      expect(bucketCount(20)).toBe('11-20')
    })

    it('returns 21-50 for 21 to 50', () => {
      expect(bucketCount(21)).toBe('21-50')
      expect(bucketCount(50)).toBe('21-50')
    })

    it('returns 51+ for above 50', () => {
      expect(bucketCount(51)).toBe('51+')
      expect(bucketCount(999)).toBe('51+')
    })
  })

  describe('providerFromHost', () => {
    it('detects gmail', () => {
      expect(providerFromHost('imap.gmail.com')).toBe('gmail')
      expect(providerFromHost('smtp.googlemail.com')).toBe('gmail')
    })

    it('detects icloud', () => {
      expect(providerFromHost('imap.mail.me.com')).toBe('icloud')
      expect(providerFromHost('imap.icloud.com')).toBe('icloud')
    })

    it('detects yandex', () => {
      expect(providerFromHost('imap.yandex.ru')).toBe('yandex')
      expect(providerFromHost('smtp.yandex.com')).toBe('yandex')
    })

    it('detects mail.ru family', () => {
      expect(providerFromHost('imap.mail.ru')).toBe('mailru')
      expect(providerFromHost('smtp.list.ru')).toBe('mailru')
      expect(providerFromHost('imap.bk.ru')).toBe('mailru')
      expect(providerFromHost('smtp.inbox.ru')).toBe('mailru')
    })

    it('detects outlook/hotmail/office365', () => {
      expect(providerFromHost('outlook.office365.com')).toBe('outlook')
      expect(providerFromHost('imap-mail.outlook.com')).toBe('outlook')
      expect(providerFromHost('smtp.hotmail.com')).toBe('outlook')
      expect(providerFromHost('smtp.live.com')).toBe('outlook')
    })

    it('returns other for unknown hosts', () => {
      expect(providerFromHost('imap.example.com')).toBe('other')
      expect(providerFromHost('mail.protonmail.ch')).toBe('other')
    })

    it('is case-insensitive', () => {
      expect(providerFromHost('IMAP.GMAIL.COM')).toBe('gmail')
      expect(providerFromHost('Imap.Yandex.Ru')).toBe('yandex')
    })

    it('handles empty and null-ish input', () => {
      expect(providerFromHost('')).toBe('other')
    })
  })

  // --- §2.15-ter ----------------------------------------------------------
  describe('bucketFreedBytes', () => {
    it('returns 0 for zero bytes', () => {
      expect(bucketFreedBytes(0)).toBe('0')
    })

    it('returns 0 for negative bytes', () => {
      expect(bucketFreedBytes(-1)).toBe('0')
      expect(bucketFreedBytes(-1024)).toBe('0')
    })

    it('returns <1MB for any positive value below 1 MB', () => {
      expect(bucketFreedBytes(1)).toBe('<1MB')
      expect(bucketFreedBytes(1024)).toBe('<1MB')
      expect(bucketFreedBytes(1024 * 1024 - 1)).toBe('<1MB')
    })

    it('returns 1-10MB for 1 MB to just under 10 MB', () => {
      expect(bucketFreedBytes(1024 * 1024)).toBe('1-10MB')
      expect(bucketFreedBytes(10 * 1024 * 1024 - 1)).toBe('1-10MB')
    })

    it('returns 10-100MB for 10 MB to just under 100 MB', () => {
      expect(bucketFreedBytes(10 * 1024 * 1024)).toBe('10-100MB')
      expect(bucketFreedBytes(100 * 1024 * 1024 - 1)).toBe('10-100MB')
    })

    it('returns 100MB-1GB for 100 MB to just under 1 GB', () => {
      expect(bucketFreedBytes(100 * 1024 * 1024)).toBe('100MB-1GB')
      expect(bucketFreedBytes(1024 * 1024 * 1024 - 1)).toBe('100MB-1GB')
    })

    it('returns 1-10GB for 1 GB to just under 10 GB', () => {
      expect(bucketFreedBytes(1024 * 1024 * 1024)).toBe('1-10GB')
      expect(bucketFreedBytes(10 * 1024 * 1024 * 1024 - 1)).toBe('1-10GB')
    })

    it('returns 10GB+ for 10 GB and above', () => {
      expect(bucketFreedBytes(10 * 1024 * 1024 * 1024)).toBe('10GB+')
      expect(bucketFreedBytes(100 * 1024 * 1024 * 1024)).toBe('10GB+')
    })
  })
  // -------------------------------------------------------------------------

  describe('folderRoleFromPath', () => {
    it('detects inbox', () => {
      expect(folderRoleFromPath('INBOX')).toBe('inbox')
      expect(folderRoleFromPath('inbox')).toBe('inbox')
      expect(folderRoleFromPath('Account/INBOX')).toBe('inbox')
    })

    it('detects sent', () => {
      expect(folderRoleFromPath('Sent')).toBe('sent')
      expect(folderRoleFromPath('Sent Messages')).toBe('sent')
    })

    it('detects drafts', () => {
      expect(folderRoleFromPath('Drafts')).toBe('drafts')
      expect(folderRoleFromPath('Draft')).toBe('drafts')
    })

    it('detects trash/deleted', () => {
      expect(folderRoleFromPath('Trash')).toBe('trash')
      expect(folderRoleFromPath('Deleted Items')).toBe('trash')
    })

    it('detects spam/junk', () => {
      expect(folderRoleFromPath('Spam')).toBe('spam')
      expect(folderRoleFromPath('Junk')).toBe('spam')
      expect(folderRoleFromPath('Junk E-mail')).toBe('spam')
    })

    it('detects archive and all mail', () => {
      expect(folderRoleFromPath('Archive')).toBe('archive')
      expect(folderRoleFromPath('[Gmail]/All Mail')).toBe('archive')
    })

    it('returns other for custom folders', () => {
      expect(folderRoleFromPath('Work')).toBe('other')
      expect(folderRoleFromPath('Projects/2024')).toBe('other')
    })
  })
})
