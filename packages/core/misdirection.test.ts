import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  checkMisdirection,
  type Recipient,
} from './misdirection';

describe('extractDomain', () => {
  it('returns lowercased domain from email', () => {
    expect(extractDomain('alice@Example.COM')).toBe('example.com');
  });

  it('handles last @ for plus-addressing', () => {
    expect(extractDomain('user+tag@domain.org')).toBe('domain.org');
  });

  it('returns empty string for invalid email without @', () => {
    expect(extractDomain('nodomain')).toBe('');
  });
});

describe('checkMisdirection', () => {
  const acme = (name: string): Recipient => ({
    email: `${name}@acme.com`,
    name,
  });
  const ext = (name: string, domain: string): Recipient => ({
    email: `${name}@${domain}`,
    name,
  });

  describe('external_domain check', () => {
    it('returns null when all recipients share the same domain', () => {
      const result = checkMisdirection(
        [acme('alice'), acme('bob')],
        'acme.com',
        [],
      );
      expect(result).toBeNull();
    });

    it('returns null for a single recipient from external domain', () => {
      const result = checkMisdirection(
        [ext('charlie', 'other.com')],
        'acme.com',
        [],
      );
      expect(result).toBeNull();
    });

    it('warns when majority share a domain and one is external', () => {
      const result = checkMisdirection(
        [acme('alice'), acme('bob'), ext('charlie', 'rival.com')],
        'acme.com',
        [],
      );
      expect(result).toEqual({
        type: 'external_domain',
        externalDomains: ['rival.com'],
      });
    });

    it('does not warn when external domain is trusted', () => {
      const result = checkMisdirection(
        [acme('alice'), acme('bob'), ext('charlie', 'partner.com')],
        'acme.com',
        ['partner.com'],
      );
      expect(result).toBeNull();
    });

    it('does not warn when external domain matches account domain', () => {
      const result = checkMisdirection(
        [ext('a', 'team.com'), ext('b', 'team.com'), ext('c', 'acme.com')],
        'acme.com',
        [],
      );
      expect(result).toBeNull();
    });

    it('trusted domain comparison is case-insensitive', () => {
      const result = checkMisdirection(
        [acme('a'), acme('b'), ext('c', 'Partner.COM')],
        'acme.com',
        ['PARTNER.COM'],
      );
      expect(result).toBeNull();
    });

    it('returns sorted external domains when multiple are present', () => {
      const result = checkMisdirection(
        [
          acme('a'),
          acme('b'),
          ext('c', 'zeta.io'),
          ext('d', 'alpha.io'),
        ],
        'acme.com',
        [],
      );
      expect(result).toEqual({
        type: 'external_domain',
        externalDomains: ['alpha.io', 'zeta.io'],
      });
    });
  });

  describe('new_recipients_in_reply check', () => {
    it('returns null when all recipients are from the original', () => {
      const original = [acme('alice'), acme('bob')];
      const result = checkMisdirection(
        [acme('alice'), acme('bob')],
        'acme.com',
        [],
        original,
      );
      expect(result).toBeNull();
    });

    it('warns about new recipients added to a reply', () => {
      const original = [acme('alice')];
      const newR = ext('charlie', 'other.com');
      const result = checkMisdirection(
        [acme('alice'), newR],
        'acme.com',
        [],
        original,
      );
      expect(result).toEqual({
        type: 'new_recipients_in_reply',
        newRecipients: [newR],
      });
    });

    it('comparison is case-insensitive', () => {
      const original: Recipient[] = [{ email: 'Alice@ACME.COM' }];
      const result = checkMisdirection(
        [{ email: 'alice@acme.com' }],
        'acme.com',
        [],
        original,
      );
      expect(result).toBeNull();
    });
  });

  describe('priority', () => {
    it('prefers external_domain over new_recipients_in_reply', () => {
      const original = [acme('alice')];
      // Two acme recipients (majority) + one external who is also new
      const result = checkMisdirection(
        [acme('alice'), acme('bob'), ext('spy', 'evil.com')],
        'acme.com',
        [],
        original,
      );
      expect(result?.type).toBe('external_domain');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty recipients', () => {
      expect(checkMisdirection([], 'acme.com', [])).toBeNull();
    });

    it('returns null when no majority domain exists', () => {
      const result = checkMisdirection(
        [ext('a', 'one.com'), ext('b', 'two.com'), ext('c', 'three.com')],
        'acme.com',
        [],
      );
      // No domain has >= 2 recipients, so no majority
      expect(result).toBeNull();
    });
  });
});
