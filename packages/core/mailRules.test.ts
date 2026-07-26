import { describe, it, expect } from 'vitest';
import {
  matchCondition,
  matchRule,
  evaluateRules,
  type MailContext,
  type MailRule,
  type RuleCondition,
} from './mailRules';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMail(overrides: Partial<MailContext> = {}): MailContext {
  return {
    from: 'Alice Smith',
    fromAddr: 'alice@example.com',
    to: 'bob@example.com',
    cc: 'carol@example.com',
    subject: 'Weekly report Q1 2026',
    hasAttachments: false,
    accountId: 1,
    ...overrides,
  };
}

function makeRule(overrides: Partial<MailRule> = {}): MailRule {
  return {
    id: 'rule-1',
    accountId: null,
    name: 'Test rule',
    enabled: true,
    priority: 10,
    conditions: [],
    actions: [{ type: 'archive' }],
    stopProcessing: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchCondition
// ---------------------------------------------------------------------------

describe('matchCondition', () => {
  it('contains — case-insensitive', () => {
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: 'REPORT' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('not_contains — true when absent', () => {
    const cond: RuleCondition = { field: 'subject', op: 'not_contains', value: 'invoice' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('not_contains — false when present', () => {
    const cond: RuleCondition = { field: 'subject', op: 'not_contains', value: 'report' };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('equals — case-insensitive full match', () => {
    const cond: RuleCondition = { field: 'to', op: 'equals', value: 'BOB@EXAMPLE.COM' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('equals — rejects partial match', () => {
    const cond: RuleCondition = { field: 'to', op: 'equals', value: 'bob@' };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('starts_with', () => {
    const cond: RuleCondition = { field: 'subject', op: 'starts_with', value: 'weekly' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('ends_with', () => {
    const cond: RuleCondition = { field: 'subject', op: 'ends_with', value: '2026' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('matches_regex', () => {
    const cond: RuleCondition = { field: 'subject', op: 'matches_regex', value: 'Q\\d+' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('matches_regex — invalid regex returns false', () => {
    const cond: RuleCondition = { field: 'subject', op: 'matches_regex', value: '[invalid' };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('from field uses display name', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'alice' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('from field falls back to fromAddr when from is empty', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'alice@' };
    expect(matchCondition(cond, makeMail({ from: '' }))).toBe(true);
  });

  it('cc field', () => {
    const cond: RuleCondition = { field: 'cc', op: 'contains', value: 'carol' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('cc field — undefined cc treated as empty string', () => {
    const cond: RuleCondition = { field: 'cc', op: 'contains', value: 'anyone' };
    expect(matchCondition(cond, makeMail({ cc: undefined }))).toBe(false);
  });

  it('has_attachment — true', () => {
    const cond: RuleCondition = { field: 'has_attachment', op: 'contains', value: '' };
    expect(matchCondition(cond, makeMail({ hasAttachments: true }))).toBe(true);
  });

  it('has_attachment — false', () => {
    const cond: RuleCondition = { field: 'has_attachment', op: 'equals', value: 'ignored' };
    expect(matchCondition(cond, makeMail({ hasAttachments: false }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchRule
// ---------------------------------------------------------------------------

describe('matchRule', () => {
  it('returns false for empty conditions', () => {
    const rule = makeRule({ conditions: [] });
    expect(matchRule(rule, makeMail())).toBe(false);
  });

  it('returns true when all conditions match (AND)', () => {
    const rule = makeRule({
      conditions: [
        { field: 'from', op: 'contains', value: 'alice' },
        { field: 'subject', op: 'contains', value: 'report' },
      ],
    });
    expect(matchRule(rule, makeMail())).toBe(true);
  });

  it('returns false when any condition fails', () => {
    const rule = makeRule({
      conditions: [
        { field: 'from', op: 'contains', value: 'alice' },
        { field: 'subject', op: 'contains', value: 'invoice' },
      ],
    });
    expect(matchRule(rule, makeMail())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateRules
// ---------------------------------------------------------------------------

describe('evaluateRules', () => {
  it('returns empty array when no rules match', () => {
    const rules: MailRule[] = [
      makeRule({
        conditions: [{ field: 'subject', op: 'contains', value: 'nonexistent' }],
      }),
    ];
    expect(evaluateRules(rules, makeMail())).toEqual([]);
  });

  it('skips disabled rules', () => {
    const rules: MailRule[] = [
      makeRule({
        enabled: false,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'trash' }],
      }),
    ];
    expect(evaluateRules(rules, makeMail())).toEqual([]);
  });

  it('collects actions from multiple matching rules', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r1',
        priority: 1,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'mark_read' }],
      }),
      makeRule({
        id: 'r2',
        priority: 2,
        conditions: [{ field: 'subject', op: 'contains', value: 'report' }],
        actions: [{ type: 'mark_starred' }],
      }),
    ];
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([{ type: 'mark_read' }, { type: 'mark_starred' }]);
  });

  it('stops processing when stopProcessing is true', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r1',
        priority: 1,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'archive' }],
        stopProcessing: true,
      }),
      makeRule({
        id: 'r2',
        priority: 2,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'mark_starred' }],
      }),
    ];
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([{ type: 'archive' }]);
  });

  it('evaluates rules in priority order (lower number first)', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-low',
        priority: 99,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'trash' }],
        stopProcessing: true,
      }),
      makeRule({
        id: 'r-high',
        priority: 1,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'archive' }],
        stopProcessing: true,
      }),
    ];
    // r-high (priority 1) should match first and stop
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([{ type: 'archive' }]);
  });

  it('filters by accountId when set on rule', () => {
    const rules: MailRule[] = [
      makeRule({
        accountId: '2',
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'mark_read' }],
      }),
    ];
    // Mail has accountId 1, rule scoped to account 2
    expect(evaluateRules(rules, makeMail({ accountId: 1 }))).toEqual([]);
    expect(evaluateRules(rules, makeMail({ accountId: 2 }))).toEqual([
      { type: 'mark_read' },
    ]);
  });

  it('null accountId matches any account', () => {
    const rules: MailRule[] = [
      makeRule({
        accountId: null,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'archive' }],
      }),
    ];
    expect(evaluateRules(rules, makeMail({ accountId: 5 }))).toEqual([
      { type: 'archive' },
    ]);
  });

  it('move action includes folder', () => {
    const rules: MailRule[] = [
      makeRule({
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'move', folder: 'Projects/Reports' }],
      }),
    ];
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([{ type: 'move', folder: 'Projects/Reports' }]);
  });
});

// ---------------------------------------------------------------------------
// Real-world rule scenarios
// ---------------------------------------------------------------------------

describe('real-world rule scenarios', () => {
  // ── 1. Newsletter rules ──────────────────────────────────────────────

  describe('newsletter rules', () => {
    const newsletterRule = makeRule({
      id: 'newsletter',
      priority: 1,
      conditions: [{ field: 'from', op: 'contains', value: 'newsletter' }],
      actions: [{ type: 'archive' }],
    });
    const noreplyRule = makeRule({
      id: 'noreply',
      priority: 2,
      conditions: [{ field: 'from', op: 'contains', value: 'noreply' }],
      actions: [{ type: 'archive' }],
    });
    const rules = [newsletterRule, noreplyRule];

    it('matches newsletter@company.com', () => {
      const mail = makeMail({ from: '', fromAddr: 'newsletter@company.com' });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'archive' }]);
    });

    it('matches noreply@service.com', () => {
      const mail = makeMail({ from: '', fromAddr: 'noreply@service.com' });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'archive' }]);
    });

    it('does not match regular sender john@company.com', () => {
      const mail = makeMail({ from: 'John', fromAddr: 'john@company.com' });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });
  });

  // ── 2. Shopping / receipts ────────────────────────────────────────────

  describe('shopping and receipt rules', () => {
    const orderConfirmRule = makeRule({
      id: 'order-confirm',
      priority: 1,
      conditions: [
        { field: 'subject', op: 'contains', value: 'order confirmation' },
      ],
      actions: [{ type: 'move', folder: 'Receipts' }],
    });
    const amazonRule = makeRule({
      id: 'amazon',
      priority: 2,
      conditions: [
        { field: 'from', op: 'ends_with', value: '@amazon.com' },
      ],
      actions: [{ type: 'move', folder: 'Shopping' }],
    });
    const rules = [orderConfirmRule, amazonRule];

    it('matches order confirmation from amazon (both rules)', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'orders@amazon.com',
        subject: 'Your Order Confirmation #12345',
      });
      const actions = evaluateRules(rules, mail);
      expect(actions).toEqual([
        { type: 'move', folder: 'Receipts' },
        { type: 'move', folder: 'Shopping' },
      ]);
    });

    it('matches amazon sender without order confirmation', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'deals@amazon.com',
        subject: 'Daily deals for you',
      });
      expect(evaluateRules(rules, mail)).toEqual([
        { type: 'move', folder: 'Shopping' },
      ]);
    });

    it('does not match non-amazon shipping tracker', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'track@fedex.com',
        subject: 'Shipment update',
      });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });
  });

  // ── 3. Social media ──────────────────────────────────────────────────

  describe('social media rules', () => {
    const socialKeywords = ['facebook', 'twitter', 'linkedin'];
    const rules = socialKeywords.map((kw, i) =>
      makeRule({
        id: `social-${kw}`,
        priority: i,
        conditions: [{ field: 'from', op: 'contains', value: kw }],
        actions: [{ type: 'move', folder: 'Social' }],
      }),
    );

    it('matches notification@facebookmail.com', () => {
      const mail = makeMail({ from: '', fromAddr: 'notification@facebookmail.com' });
      expect(evaluateRules(rules, mail)).toEqual([
        { type: 'move', folder: 'Social' },
      ]);
    });

    it('matches info@twitter.com', () => {
      const mail = makeMail({ from: '', fromAddr: 'info@twitter.com' });
      expect(evaluateRules(rules, mail)).toEqual([
        { type: 'move', folder: 'Social' },
      ]);
    });

    it('matches messages-noreply@linkedin.com', () => {
      const mail = makeMail({ from: '', fromAddr: 'messages-noreply@linkedin.com' });
      expect(evaluateRules(rules, mail)).toEqual([
        { type: 'move', folder: 'Social' },
      ]);
    });

    it('does not match random sender', () => {
      const mail = makeMail({ from: '', fromAddr: 'hello@randomsite.com' });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });
  });

  // ── 4. Work / internal ────────────────────────────────────────────────

  describe('work/internal rules', () => {
    const urgentInternalRule = makeRule({
      id: 'urgent-internal',
      priority: 1,
      conditions: [
        { field: 'from', op: 'ends_with', value: '@mycompany.com' },
        { field: 'subject', op: 'contains', value: 'urgent' },
      ],
      actions: [{ type: 'mark_starred' }],
    });
    const rules = [urgentInternalRule];

    it('matches internal sender with urgent subject', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'boss@mycompany.com',
        subject: 'Urgent: deadline moved',
      });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_starred' }]);
    });

    it('does not match internal sender without urgent subject', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'boss@mycompany.com',
        subject: 'Lunch plans',
      });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });

    it('does not match external sender with urgent subject', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'scammer@evil.com',
        subject: 'Urgent wire transfer needed',
      });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });
  });

  // ── 5. Spam-like patterns ─────────────────────────────────────────────

  describe('spam-like regex patterns', () => {
    const spamRule = makeRule({
      id: 'spam-regex',
      priority: 1,
      conditions: [
        {
          field: 'subject',
          op: 'matches_regex',
          value: '(viagra|lottery|winner|prince)',
        },
      ],
      actions: [{ type: 'mark_spam' }],
    });
    const rules = [spamRule];

    it('matches "You are a LOTTERY WINNER"', () => {
      const mail = makeMail({ subject: 'You are a LOTTERY WINNER' });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_spam' }]);
    });

    it('matches "prince" even in legitimate context (false positive)', () => {
      const mail = makeMail({ subject: 'Meeting with Prince Edward Hotel' });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_spam' }]);
    });

    it('does not match benign subject', () => {
      const mail = makeMail({ subject: 'Quarterly report' });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });

    it('matches viagra in mixed case', () => {
      const mail = makeMail({ subject: 'Buy ViAgRa now!' });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_spam' }]);
    });
  });

  // ── 6. Attachment filtering ───────────────────────────────────────────

  describe('attachment filtering', () => {
    const externalAttachmentRule = makeRule({
      id: 'ext-attach',
      priority: 1,
      conditions: [
        { field: 'has_attachment', op: 'contains', value: '' },
        { field: 'from', op: 'not_contains', value: '@mycompany.com' },
      ],
      actions: [{ type: 'mark_read' }],
    });
    const rules = [externalAttachmentRule];

    it('matches external sender with attachment', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'vendor@external.com',
        hasAttachments: true,
      });
      expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_read' }]);
    });

    it('does not match internal sender with attachment', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'colleague@mycompany.com',
        hasAttachments: true,
      });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });

    it('does not match external sender without attachment', () => {
      const mail = makeMail({
        from: '',
        fromAddr: 'vendor@external.com',
        hasAttachments: false,
      });
      expect(evaluateRules(rules, mail)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Rule sequence and priority
// ---------------------------------------------------------------------------

describe('rule sequence and priority', () => {
  it('collects actions from multiple matching rules in priority order', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-archive',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'newsletter' }],
        actions: [{ type: 'archive' }],
      }),
      makeRule({
        id: 'r-star',
        priority: 1,
        conditions: [
          { field: 'from', op: 'contains', value: 'newsletter' },
          { field: 'subject', op: 'contains', value: 'important' },
        ],
        actions: [{ type: 'mark_starred' }],
      }),
    ];
    const mail = makeMail({
      from: '',
      fromAddr: 'newsletter@co.com',
      subject: 'Important newsletter update',
    });
    const actions = evaluateRules(rules, mail);
    expect(actions).toEqual([{ type: 'archive' }, { type: 'mark_starred' }]);
  });

  it('stopProcessing prevents subsequent rules from firing', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-stop',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'newsletter' }],
        actions: [{ type: 'archive' }],
        stopProcessing: true,
      }),
      makeRule({
        id: 'r-catchall',
        priority: 1,
        conditions: [{ field: 'subject', op: 'contains', value: '' }],
        actions: [{ type: 'mark_read' }],
      }),
    ];

    // newsletter sender → only archive (stopped)
    const mail1 = makeMail({ from: '', fromAddr: 'newsletter@co.com', subject: 'News' });
    expect(evaluateRules(rules, mail1)).toEqual([{ type: 'archive' }]);

    // non-newsletter sender → only mark_read (rule 1 didn't match)
    const mail2 = makeMail({ from: 'John', fromAddr: 'john@co.com', subject: 'Hello' });
    expect(evaluateRules(rules, mail2)).toEqual([{ type: 'mark_read' }]);
  });

  it('priority ordering: lower number runs first regardless of array order', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-move',
        priority: 5,
        conditions: [{ field: 'subject', op: 'contains', value: 'report' }],
        actions: [{ type: 'move', folder: 'Reports' }],
      }),
      makeRule({
        id: 'r-star',
        priority: 1,
        conditions: [{ field: 'from', op: 'contains', value: 'boss' }],
        actions: [{ type: 'mark_starred' }],
      }),
    ];
    const mail = makeMail({
      from: 'Boss Man',
      fromAddr: 'boss@co.com',
      subject: 'Quarterly report',
    });
    const actions = evaluateRules(rules, mail);
    // r-star (priority 1) runs first, then r-move (priority 5)
    expect(actions).toEqual([
      { type: 'mark_starred' },
      { type: 'move', folder: 'Reports' },
    ]);
  });

  it('disabled rules are skipped entirely', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-disabled',
        enabled: false,
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'spam' }],
        actions: [{ type: 'trash' }],
      }),
      makeRule({
        id: 'r-active',
        enabled: true,
        priority: 1,
        conditions: [{ field: 'subject', op: 'contains', value: 'hello' }],
        actions: [{ type: 'mark_read' }],
      }),
    ];
    const mail = makeMail({
      from: '',
      fromAddr: 'spam@bad.com',
      subject: 'hello world',
    });
    // Rule 1 disabled → skipped; Rule 2 matches → mark_read only
    expect(evaluateRules(rules, mail)).toEqual([{ type: 'mark_read' }]);
  });

  it('accountId filtering: scoped rule only matches its account', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-scoped',
        accountId: '1',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'support' }],
        actions: [{ type: 'archive' }],
      }),
      makeRule({
        id: 'r-global',
        accountId: null,
        priority: 1,
        conditions: [{ field: 'from', op: 'contains', value: 'support' }],
        actions: [{ type: 'mark_read' }],
      }),
    ];

    const mailAccount1 = makeMail({
      from: '',
      fromAddr: 'support@vendor.com',
      accountId: 1,
    });
    // Both rules match for account 1
    expect(evaluateRules(rules, mailAccount1)).toEqual([
      { type: 'archive' },
      { type: 'mark_read' },
    ]);

    const mailAccount2 = makeMail({
      from: '',
      fromAddr: 'support@vendor.com',
      accountId: 2,
    });
    // Only global rule matches for account 2
    expect(evaluateRules(rules, mailAccount2)).toEqual([{ type: 'mark_read' }]);
  });

  it('stopProcessing on non-matching rule does not affect subsequent rules', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-no-match',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'nonexistent' }],
        actions: [{ type: 'trash' }],
        stopProcessing: true,
      }),
      makeRule({
        id: 'r-match',
        priority: 1,
        conditions: [{ field: 'subject', op: 'contains', value: 'report' }],
        actions: [{ type: 'archive' }],
      }),
    ];
    const mail = makeMail({ subject: 'Weekly report' });
    // Rule 1 doesn't match (no stop), Rule 2 matches
    expect(evaluateRules(rules, mail)).toEqual([{ type: 'archive' }]);
  });

  it('multiple actions from a single rule are all collected', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'r-multi-action',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [
          { type: 'mark_read' },
          { type: 'mark_starred' },
          { type: 'move', folder: 'VIP' },
        ],
      }),
    ];
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([
      { type: 'mark_read' },
      { type: 'mark_starred' },
      { type: 'move', folder: 'VIP' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty from field — fromAddr is used as fallback', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'test' };
    const mail = makeMail({ from: '', fromAddr: 'test@example.com' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('both from and fromAddr are empty', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'anything' };
    const mail = makeMail({ from: '', fromAddr: '' });
    expect(matchCondition(cond, mail)).toBe(false);
  });

  it('unicode in subject — Russian', () => {
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: 'отчёт' };
    const mail = makeMail({ subject: 'Еженедельный отчёт за март' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('unicode in subject — Chinese', () => {
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: '报告' };
    const mail = makeMail({ subject: '每周报告 2026' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('unicode in subject — emoji', () => {
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: '🎉' };
    const mail = makeMail({ subject: 'Party 🎉 this weekend!' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('very long subject (1000+ chars)', () => {
    const longSubject = 'A'.repeat(500) + 'NEEDLE' + 'B'.repeat(500);
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: 'needle' };
    expect(matchCondition(cond, makeMail({ subject: longSubject }))).toBe(true);
  });

  it('rule with empty actions array returns no actions', () => {
    const rules: MailRule[] = [
      makeRule({
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [],
      }),
    ];
    expect(evaluateRules(rules, makeMail())).toEqual([]);
  });

  it('invalid regex in matches_regex does not crash, returns false', () => {
    const cond: RuleCondition = {
      field: 'subject',
      op: 'matches_regex',
      value: '(?P<invalid)',
    };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('another invalid regex — unmatched parenthesis', () => {
    const cond: RuleCondition = {
      field: 'subject',
      op: 'matches_regex',
      value: '(unclosed',
    };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('contains with empty value matches everything', () => {
    const cond: RuleCondition = { field: 'subject', op: 'contains', value: '' };
    expect(matchCondition(cond, makeMail())).toBe(true);
    expect(matchCondition(cond, makeMail({ subject: '' }))).toBe(true);
  });

  it('not_contains with empty value matches nothing', () => {
    const cond: RuleCondition = { field: 'subject', op: 'not_contains', value: '' };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('equals with empty value matches only empty subject', () => {
    const cond: RuleCondition = { field: 'subject', op: 'equals', value: '' };
    expect(matchCondition(cond, makeMail({ subject: '' }))).toBe(true);
    expect(matchCondition(cond, makeMail({ subject: 'notempty' }))).toBe(false);
  });

  it('starts_with empty value always matches', () => {
    const cond: RuleCondition = { field: 'subject', op: 'starts_with', value: '' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('ends_with empty value always matches', () => {
    const cond: RuleCondition = { field: 'subject', op: 'ends_with', value: '' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('to field with multiple recipients (comma-separated)', () => {
    const cond: RuleCondition = { field: 'to', op: 'contains', value: 'carol' };
    const mail = makeMail({ to: 'bob@example.com, carol@example.com' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('no rules at all returns empty actions', () => {
    expect(evaluateRules([], makeMail())).toEqual([]);
  });

  it('all rules disabled returns empty actions', () => {
    const rules: MailRule[] = [
      makeRule({
        enabled: false,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'archive' }],
      }),
      makeRule({
        id: 'r2',
        enabled: false,
        conditions: [{ field: 'subject', op: 'contains', value: 'report' }],
        actions: [{ type: 'mark_read' }],
      }),
    ];
    expect(evaluateRules(rules, makeMail())).toEqual([]);
  });

  it('regex with special characters in subject', () => {
    const cond: RuleCondition = {
      field: 'subject',
      op: 'matches_regex',
      value: 'price:\\s*\\$\\d+',
    };
    const mail = makeMail({ subject: 'New price: $499 for premium plan' });
    expect(matchCondition(cond, mail)).toBe(true);
  });

  it('same priority rules maintain stable evaluation order', () => {
    const rules: MailRule[] = [
      makeRule({
        id: 'first',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'archive' }],
        stopProcessing: true,
      }),
      makeRule({
        id: 'second',
        priority: 0,
        conditions: [{ field: 'from', op: 'contains', value: 'alice' }],
        actions: [{ type: 'trash' }],
      }),
    ];
    // Both have priority 0; first in array should win with stopProcessing
    const actions = evaluateRules(rules, makeMail());
    expect(actions).toEqual([{ type: 'archive' }]);
  });
});
