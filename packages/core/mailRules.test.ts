import { describe, it, expect } from 'vitest';
import {
  RULE_OPS,
  RULE_ACTION_TYPES,
  matchCondition,
  matchRule,
  evaluateRules,
  findMailRuleRefusal,
  findEncodedMailRuleRefusal,
  parseMailRuleParts,
  formatMailRuleRefusal,
  parseMailRuleRefusal,
  mailRuleRefusalError,
  MAIL_RULE_REFUSED_ERROR,
  type MailContext,
  type MailRule,
  type MailRuleRefusal,
  type RuleActionType,
  type RuleCondition,
  type RuleOp,
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

  it('from field matches fromAddr when from is empty', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'alice@' };
    expect(matchCondition(cond, makeMail({ from: '' }))).toBe(true);
  });

  it('from field matches the address even when a display name is present', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: 'alice@' };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('cc field never matches, even when a caller supplies a value', () => {
    const cond: RuleCondition = { field: 'cc', op: 'contains', value: 'carol' };
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('cc field never matches when cc is absent', () => {
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

  it('from with both display name and address — contains empty value still matches', () => {
    const cond: RuleCondition = { field: 'from', op: 'contains', value: '' };
    expect(matchCondition(cond, makeMail({ from: '', fromAddr: '' }))).toBe(true);
  });

  it('equals with empty value does not match a sender that has an address', () => {
    const cond: RuleCondition = { field: 'from', op: 'equals', value: '' };
    const mail = makeMail({ from: '', fromAddr: 'alice@example.com' });
    expect(matchCondition(cond, mail)).toBe(false);
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

// ---------------------------------------------------------------------------
// `from` matching — display name AND address (§2.90)
//
// Storage collapses the sender into a single `from` value
// (COALESCE(NULLIF(TRIM(from_name),''), from_addr)), so a sender who starts
// signing with a display name would silently drop out of an address rule if
// only that one value were compared.
// ---------------------------------------------------------------------------

describe('from field — display name and address are both compared', () => {
  // ── Sender WITH a display name ────────────────────────────────────────

  describe('sender with a display name', () => {
    const named = () =>
      makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });

    it('equals against the full address matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'alice@example.com',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('equals against the display name still matches (no regression)', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'ALICE SMITH',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('contains against the display name still matches (no regression)', () => {
      const cond: RuleCondition = { field: 'from', op: 'contains', value: 'smith' };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('ends_with against the domain matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'ends_with',
        value: '@example.com',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('starts_with against the local part matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'starts_with',
        value: 'alice@',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('starts_with against the display name matches', () => {
      const cond: RuleCondition = { field: 'from', op: 'starts_with', value: 'Alice' };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('matches_regex anchored on the address matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'matches_regex',
        value: '^alice@example\\.com$',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('matches_regex anchored on the display name matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'matches_regex',
        value: '^Alice\\s+Smith$',
      };
      expect(matchCondition(cond, named())).toBe(true);
    });

    it('does not match an unrelated address', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'bob@example.com',
      };
      expect(matchCondition(cond, named())).toBe(false);
    });
  });

  // ── Sender WITHOUT a display name ─────────────────────────────────────

  describe('sender without a display name', () => {
    // Storage duplicates the address into `from` when from_name is empty.
    const bare = () =>
      makeMail({ from: 'alice@example.com', fromAddr: 'alice@example.com' });

    it('equals against the address matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'alice@example.com',
      };
      expect(matchCondition(cond, bare())).toBe(true);
    });

    it('contains against the local part matches', () => {
      const cond: RuleCondition = { field: 'from', op: 'contains', value: 'alice' };
      expect(matchCondition(cond, bare())).toBe(true);
    });

    it('matches_regex against the address matches', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'matches_regex',
        value: '^alice@',
      };
      expect(matchCondition(cond, bare())).toBe(true);
    });

    it('the same rule matches the sender before and after they add a name', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'alice@example.com',
      };
      expect(matchCondition(cond, bare())).toBe(true);
      expect(
        matchCondition(
          cond,
          makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' }),
        ),
      ).toBe(true);
    });
  });

  // ── Display name shaped like `Name <addr>` ────────────────────────────
  //
  // Storage never renders the sender that way (see MailContext.from), so a
  // `from` carrying angle brackets means the *sender* put them there. Such a
  // value is compared whole; nothing is cut out of it.

  describe('display name shaped like "Name <addr>"', () => {
    it('an address rule matches through fromAddr, not through the bracket text', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'user@example.com',
      };
      const mail = makeMail({
        from: 'Имя Отправителя <user@example.com>',
        fromAddr: 'user@example.com',
      });
      // True because the address read out of the `From:` header is that value
       // — as the next test shows, the identical bracket text alone would not
      // have done it.
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('the name part is not a candidate — only the whole value is', () => {
      const mail = makeMail({
        from: 'Имя Отправителя <user@example.com>',
        fromAddr: 'user@example.com',
      });
      expect(
        matchCondition(
          { field: 'from', op: 'equals', value: 'Имя Отправителя' },
          mail,
        ),
      ).toBe(false);
      expect(
        matchCondition(
          {
            field: 'from',
            op: 'equals',
            value: 'Имя Отправителя <user@example.com>',
          },
          mail,
        ),
      ).toBe(true);
      // `contains` still reaches the name, because it looks inside one value
      // instead of treating a fragment as a value of its own.
      expect(
        matchCondition(
          { field: 'from', op: 'contains', value: 'Имя Отправителя' },
          mail,
        ),
      ).toBe(true);
    });

    it('a quoted display name is not unwrapped', () => {
      const mail = makeMail({
        from: '"Doe, John" <john@example.com>',
        fromAddr: 'john@example.com',
      });
      expect(
        matchCondition(
          { field: 'from', op: 'equals', value: 'Doe, John' },
          mail,
        ),
      ).toBe(false);
      expect(
        matchCondition(
          { field: 'from', op: 'contains', value: 'Doe, John' },
          mail,
        ),
      ).toBe(true);
    });

    it('a human display name of another sender does not satisfy an address rule', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'user@example.com',
      };
      const impostor = makeMail({
        from: 'Имя Отправителя <attacker@evil.example>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('IMPOSTOR: victim address quoted inside the display name matches nothing', () => {
      const value = 'user@example.com';
      // The sender controls this string entirely and dressed the victim's
      // address up as a quoted display name. `fromAddr` is the only value they
      // could not forge.
      const impostor = makeMail({
        from: `"${value}" <attacker@evil.example>`,
        fromAddr: 'attacker@evil.example',
      });

      // Legacy `from` compares the display name whole, and whole it is not the
      // victim address. (A display name set to the address *verbatim* is a
      // different story — see the legacy-`from` suite at the end of this file.)
      expect(
        matchCondition({ field: 'from', op: 'equals', value }, impostor),
      ).toBe(false);

      // `from_address` — the field destructive rules must use — rejects it too.
      expect(
        matchCondition({ field: 'from_address', op: 'equals', value }, impostor),
      ).toBe(false);
    });

    it('IMPOSTOR without angle brackets — address rule must NOT match', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'support@company.com',
      };
      const impostor = makeMail({
        from: 'Support Team',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    // Note: rejected because the display name, taken whole, is not the victim
    // address. When a display name *is* the address verbatim, legacy `from`
    // does match — see the legacy-`from` suite at the end of this file, and use
    // `from_address` instead.
    it('IMPOSTOR: address embedded in the display name does not satisfy equals', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'user@example.com',
      };
      const impostor = makeMail({
        from: 'user@example.com (via Mailer) <attacker@evil.example>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });
  });

  // ── Name and address are compared separately, never concatenated ──────

  describe('candidates are compared separately, not concatenated', () => {
    const named = () =>
      makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });

    it('equals does not match a name+address concatenation', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'equals',
        value: 'Alice Smith alice@example.com',
      };
      expect(matchCondition(cond, named())).toBe(false);
    });

    it('contains does not match a needle spanning name and address', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'contains',
        value: 'smith alice@',
      };
      expect(matchCondition(cond, named())).toBe(false);
    });

    it('ends_with the display name is not defeated by the address candidate', () => {
      const cond: RuleCondition = { field: 'from', op: 'ends_with', value: 'Smith' };
      expect(matchCondition(cond, named())).toBe(true);
    });
  });

  // ── not_contains must hold for every candidate ────────────────────────

  describe('not_contains holds across both name and address', () => {
    it('does not fire for an internal colleague who has a display name', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'not_contains',
        value: '@mycompany.com',
      };
      const mail = makeMail({
        from: 'Colleague Name',
        fromAddr: 'colleague@mycompany.com',
      });
      expect(matchCondition(cond, mail)).toBe(false);
    });

    it('fires for a genuinely external sender', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'not_contains',
        value: '@mycompany.com',
      };
      const mail = makeMail({ from: 'Vendor Inc', fromAddr: 'vendor@external.com' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('does not fire when the display name carries the excluded token', () => {
      const cond: RuleCondition = {
        field: 'from',
        op: 'not_contains',
        value: 'newsletter',
      };
      const mail = makeMail({
        from: 'Weekly Newsletter',
        fromAddr: 'hello@company.com',
      });
      expect(matchCondition(cond, mail)).toBe(false);
    });
  });

  // ── End-to-end through evaluateRules ──────────────────────────────────

  describe('rules keep firing after a sender adds a display name', () => {
    const amazonRule = makeRule({
      id: 'amazon',
      priority: 1,
      conditions: [{ field: 'from', op: 'ends_with', value: '@amazon.com' }],
      actions: [{ type: 'move', folder: 'Shopping' }],
    });

    it('matches while the sender has no display name', () => {
      const mail = makeMail({
        from: 'orders@amazon.com',
        fromAddr: 'orders@amazon.com',
      });
      expect(evaluateRules([amazonRule], mail)).toEqual([
        { type: 'move', folder: 'Shopping' },
      ]);
    });

    it('still matches once the sender adds a display name (§2.90 regression)', () => {
      const mail = makeMail({
        from: 'Amazon.com Orders',
        fromAddr: 'orders@amazon.com',
      });
      expect(evaluateRules([amazonRule], mail)).toEqual([
        { type: 'move', folder: 'Shopping' },
      ]);
    });

    it('does not leak onto a look-alike sender on another domain', () => {
      const mail = makeMail({
        from: 'Amazon.com Orders',
        fromAddr: 'orders@amazon.com.evil.example',
      });
      expect(evaluateRules([amazonRule], mail)).toEqual([]);
    });
  });

  // §2.90 — legacySenderCandidates() also contributes a TRIMMED candidate
  // whenever the raw from/fromAddr value carries surrounding whitespace.
  // applyStringOp does not trim (it only lowercases), so without this
  // candidate an `equals` rule against the clean value would stop matching
  // the moment a header parser hands back a padded string. A trimmed value is
  // still the value whole, not a fragment cut out of it.
  describe('surrounding whitespace on from/fromAddr is tolerated (trimmed candidate)', () => {
    it('equals matches a padded display name and a padded address', () => {
      const cond: RuleCondition = { field: 'from', op: 'equals', value: 'alice@example.com' };
      const mail = makeMail({ from: '  Alice Smith  ', fromAddr: '  alice@example.com  ' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('equals against the padded display name itself also matches', () => {
      const cond: RuleCondition = { field: 'from', op: 'equals', value: 'Alice Smith' };
      const mail = makeMail({ from: '  Alice Smith  ', fromAddr: 'alice@example.com' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('not_contains still holds across the trimmed candidate, not just the padded raw one', () => {
      const cond: RuleCondition = { field: 'from', op: 'not_contains', value: 'bob' };
      const mail = makeMail({ from: '  Alice Smith  ', fromAddr: '  alice@example.com  ' });
      expect(matchCondition(cond, mail)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// from_address / from_name — the sender fields with separated meanings
//
// The sender writes their own display name and can set it to the exact address
// of somebody the user trusts. `from_address` therefore compares against
// addresses only, `from_name` against the display name only.
// ---------------------------------------------------------------------------

describe('from_address — addresses only, display names never count', () => {
  describe('impersonation', () => {
    it('a display name equal to the victim address does NOT match', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'user@example.com',
      };
      const impostor = makeMail({
        // Storage collapses a sender who has a display name down to that name,
        // so this is exactly what the rules engine sees for such a message.
        from: 'user@example.com',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('the same impersonation in `Name <addr>` form does NOT match', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'user@example.com',
      };
      const impostor = makeMail({
        from: '"user@example.com" <attacker@evil.example>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('an unquoted display name equal to the victim address does NOT match', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'user@example.com',
      };
      const impostor = makeMail({
        from: 'user@example.com <attacker@evil.example>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('PRODUCTION FORM: a display name carrying `Name <victim>` does NOT match', () => {
      // The header `From: "Alice <victim@example.com>" <attacker@evil.example>`
      // parses into display name `Alice <victim@example.com>` and address
      // `attacker@evil.example`. Storage keeps the display name in `from`
      // verbatim (COALESCE(NULLIF(TRIM(from_name),''), from_addr)), so this
      // pair is exactly what the rules engine receives in production.
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'victim@example.com',
      };
      const impostor = makeMail({
        from: 'Alice <victim@example.com>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('PRODUCTION FORM: the quoted variant of the same display name does NOT match', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'victim@example.com',
      };
      const impostor = makeMail({
        from: '"Alice" <victim@example.com>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('PRODUCTION FORM: several angle groups in the display name do NOT match', () => {
      // A greedy `Name <addr>` reading picks the LAST group; a lazy one picks
      // the first. Neither may produce an address candidate.
      const impostor = makeMail({
        from: 'A <first@example.com> B <victim@example.com>',
        fromAddr: 'attacker@evil.example',
      });
      for (const value of ['first@example.com', 'victim@example.com']) {
        expect(
          matchCondition({ field: 'from_address', op: 'equals', value }, impostor),
        ).toBe(false);
      }
    });

    it('PRODUCTION FORM: a `Name <victim>` display name does not satisfy `contains`', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'contains',
        value: '@mycompany.com',
      };
      const impostor = makeMail({
        from: 'Billing <billing@mycompany.com>',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('PRODUCTION FORM: a destructive rule does not fire for the angle impostor', () => {
      const rule = makeRule({
        conditions: [
          { field: 'from_address', op: 'equals', value: 'victim@example.com' },
        ],
        actions: [{ type: 'trash' }],
      });
      const impostor = makeMail({
        from: 'Alice <victim@example.com>',
        fromAddr: 'attacker@evil.example',
      });
      expect(evaluateRules([rule], impostor)).toEqual([]);
    });

    it('a trusted domain in the display name does not satisfy `contains`', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'contains',
        value: '@mycompany.com',
      };
      const impostor = makeMail({
        from: 'billing@mycompany.com',
        fromAddr: 'attacker@evil.example',
      });
      expect(matchCondition(cond, impostor)).toBe(false);
    });

    it('a hostile domain in the display name does not defeat not_contains', () => {
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'not_contains',
        value: '@evil.example',
      };
      const mail = makeMail({
        from: 'Promo @evil.example',
        fromAddr: 'alice@example.com',
      });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('a destructive rule keyed on from_address does not fire for the impostor', () => {
      const rule = makeRule({
        conditions: [
          { field: 'from_address', op: 'equals', value: 'user@example.com' },
        ],
        actions: [{ type: 'trash' }],
      });
      const impostor = makeMail({
        from: 'user@example.com',
        fromAddr: 'attacker@evil.example',
      });
      const genuine = makeMail({
        from: 'Real User',
        fromAddr: 'user@example.com',
      });
      expect(evaluateRules([rule], impostor)).toEqual([]);
      expect(evaluateRules([rule], genuine)).toEqual([{ type: 'trash' }]);
    });
  });

  describe('matches the header address regardless of the display name', () => {
    const cond: RuleCondition = {
      field: 'from_address',
      op: 'equals',
      value: 'alice@example.com',
    };

    it('with a display name', () => {
      const mail = makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('with no display name (storage collapsed `from` to the address)', () => {
      const mail = makeMail({
        from: 'alice@example.com',
        fromAddr: 'alice@example.com',
      });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('in `Name <addr>` form', () => {
      const mail = makeMail({
        from: 'Alice Smith <alice@example.com>',
        fromAddr: 'alice@example.com',
      });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('with an empty display name', () => {
      const mail = makeMail({ from: '', fromAddr: 'alice@example.com' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('with a display name that is another mailbox address', () => {
      const mail = makeMail({
        from: 'boss@example.com',
        fromAddr: 'alice@example.com',
      });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('case-insensitively', () => {
      const mail = makeMail({ from: 'Alice', fromAddr: 'Alice@Example.COM' });
      expect(matchCondition(cond, mail)).toBe(true);
    });

    it('with surrounding whitespace on fromAddr', () => {
      const mail = makeMail({ from: 'Alice', fromAddr: '  alice@example.com  ' });
      expect(matchCondition(cond, mail)).toBe(true);
    });
  });

  describe('candidate sources', () => {
    it('fail-closed: an angle-bracket `from` is not a candidate without fromAddr', () => {
      // This used to extract `alice@example.com` and call it an address. It is
      // a display name, and a display name is forgeable, so with no address
      // read out of the `From:` header there is simply no address candidate.
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'alice@example.com',
      };
      const mail = makeMail({
        from: 'Alice Smith <alice@example.com>',
        fromAddr: '',
      });
      expect(matchCondition(cond, mail)).toBe(false);
    });

    it('fail-closed: a bare `from` address is not a candidate without fromAddr', () => {
      // Nothing attributes this string to the `From:` header's address field,
      // and a bare string is the one thing a sender can forge. Callers in this
      // repo always pass fromAddr, so this branch only guards against a future
      // one that does not.
      const cond: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'alice@example.com',
      };
      const mail = makeMail({ from: 'alice@example.com', fromAddr: '' });
      expect(matchCondition(cond, mail)).toBe(false);
    });

    it('the header address is the ONLY candidate; an angle address in `from` is not', () => {
      // Previously both were candidates, which is precisely the impersonation
      // hole: the second value comes from the sender-controlled display name.
      const mail = makeMail({
        from: 'Alice <list@lists.example.com>',
        fromAddr: 'alice@example.com',
      });
      const headerAddress: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'alice@example.com',
      };
      const rendered: RuleCondition = {
        field: 'from_address',
        op: 'equals',
        value: 'list@lists.example.com',
      };
      expect(matchCondition(headerAddress, mail)).toBe(true);
      expect(matchCondition(rendered, mail)).toBe(false);
    });

    it('a `Name <addr>` value in fromAddr is not split either', () => {
      // Reaching the address field in this shape means the parser found no
      // address and fell back to the name — the same forgery, longer route.
      const mail = makeMail({
        from: 'Alice <victim@example.com>',
        fromAddr: 'Alice <victim@example.com>',
      });
      expect(
        matchCondition(
          { field: 'from_address', op: 'equals', value: 'victim@example.com' },
          mail,
        ),
      ).toBe(false);
    });

    it('a sender with no address at all compares as the empty string', () => {
      const mail = makeMail({ from: '', fromAddr: '' });
      expect(
        matchCondition({ field: 'from_address', op: 'equals', value: '' }, mail),
      ).toBe(true);
      expect(
        matchCondition(
          { field: 'from_address', op: 'contains', value: 'alice' },
          mail,
        ),
      ).toBe(false);
      expect(
        matchCondition(
          { field: 'from_address', op: 'not_contains', value: 'alice' },
          mail,
        ),
      ).toBe(true);
    });
  });

  describe('operators', () => {
    const mail = () =>
      makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });

    it('contains matches the domain', () => {
      expect(
        matchCondition(
          { field: 'from_address', op: 'contains', value: '@example.com' },
          mail(),
        ),
      ).toBe(true);
    });

    it('ends_with matches the domain', () => {
      expect(
        matchCondition(
          { field: 'from_address', op: 'ends_with', value: 'example.com' },
          mail(),
        ),
      ).toBe(true);
    });

    it('starts_with matches the local part', () => {
      expect(
        matchCondition(
          { field: 'from_address', op: 'starts_with', value: 'alice@' },
          mail(),
        ),
      ).toBe(true);
    });

    it('matches_regex is applied to address candidates', () => {
      expect(
        matchCondition(
          { field: 'from_address', op: 'matches_regex', value: '^alice@' },
          mail(),
        ),
      ).toBe(true);
      expect(
        matchCondition(
          { field: 'from_address', op: 'matches_regex', value: '^alice smith$' },
          mail(),
        ),
      ).toBe(false);
    });

    it('not_contains is judged on the header address alone', () => {
      const mail = makeMail({
        from: 'Alice <alice@example.com>',
        fromAddr: 'alice@corp.example',
      });
      // Present only in the display name → the address does not contain it, so
      // the negation holds. The display name has no say in an address rule.
      expect(
        matchCondition(
          { field: 'from_address', op: 'not_contains', value: '@example.com' },
          mail,
        ),
      ).toBe(true);
      // Present in the header address → the negation must fail.
      expect(
        matchCondition(
          { field: 'from_address', op: 'not_contains', value: '@corp.example' },
          mail,
        ),
      ).toBe(false);
    });
  });
});

describe('from_name — display name only, addresses never count', () => {
  it('matches the display name', () => {
    const cond: RuleCondition = {
      field: 'from_name',
      op: 'equals',
      value: 'Alice Smith',
    };
    expect(matchCondition(cond, makeMail())).toBe(true);
  });

  it('matches a non-ASCII display name (storage hands over the name alone)', () => {
    const mail = makeMail({
      from: 'Имя Отправителя',
      fromAddr: 'user@example.com',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'Имя Отправителя' },
        mail,
      ),
    ).toBe(true);
  });

  it('matches a display name containing a comma (already unquoted by the parser)', () => {
    const mail = makeMail({
      from: 'Doe, John',
      fromAddr: 'john@example.com',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'Doe, John' },
        mail,
      ),
    ).toBe(true);
  });

  it('takes an angle-bracket display name whole, without truncating at the bracket', () => {
    // `From: "Alice <victim@example.com>" <attacker@evil.example>` really does
    // have that whole string as its display name. Reporting it as `Alice`
    // would hide the impersonation from a name rule written to catch it.
    const mail = makeMail({
      from: 'Alice <victim@example.com>',
      fromAddr: 'attacker@evil.example',
    });
    expect(
      matchCondition(
        {
          field: 'from_name',
          op: 'equals',
          value: 'Alice <victim@example.com>',
        },
        mail,
      ),
    ).toBe(true);
    expect(
      matchCondition({ field: 'from_name', op: 'equals', value: 'Alice' }, mail),
    ).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const mail = makeMail({ from: '  Alice Smith  ', fromAddr: 'alice@example.com' });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'Alice Smith' },
        mail,
      ),
    ).toBe(true);
  });

  it('does NOT match the sender address', () => {
    const mail = makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'alice@example.com' },
        mail,
      ),
    ).toBe(false);
    expect(
      matchCondition(
        { field: 'from_name', op: 'contains', value: '@example.com' },
        mail,
      ),
    ).toBe(false);
  });

  it('does NOT match the header address of a named sender', () => {
    const mail = makeMail({
      from: 'Имя Отправителя',
      fromAddr: 'user@example.com',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'contains', value: 'user@example.com' },
        mail,
      ),
    ).toBe(false);
  });

  it('a sender with no display name has no name candidate', () => {
    // Storage renders such a sender as the bare address, which must not be
    // mistaken for a display name.
    const mail = makeMail({
      from: 'alice@example.com',
      fromAddr: 'alice@example.com',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'alice@example.com' },
        mail,
      ),
    ).toBe(false);
    expect(
      matchCondition({ field: 'from_name', op: 'contains', value: 'alice' }, mail),
    ).toBe(false);
    expect(
      matchCondition(
        { field: 'from_name', op: 'not_contains', value: 'alice' },
        mail,
      ),
    ).toBe(true);
  });

  it('the collapsed-address case is detected case-insensitively', () => {
    const mail = makeMail({
      from: 'Alice@Example.com',
      fromAddr: 'alice@example.com',
    });
    expect(
      matchCondition({ field: 'from_name', op: 'contains', value: 'alice' }, mail),
    ).toBe(false);
  });

  it('a blank display name yields no name candidate', () => {
    const mail = makeMail({ from: '   ', fromAddr: 'alice@example.com' });
    expect(
      matchCondition(
        { field: 'from_name', op: 'contains', value: 'alice' },
        mail,
      ),
    ).toBe(false);
    expect(
      matchCondition({ field: 'from_name', op: 'equals', value: '' }, mail),
    ).toBe(true);
  });

  it('reports an impersonating display name honestly', () => {
    // from_name says what the display name is — that is its whole job. The
    // address check belongs to from_address.
    const impostor = makeMail({
      from: 'user@example.com',
      fromAddr: 'attacker@evil.example',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'equals', value: 'user@example.com' },
        impostor,
      ),
    ).toBe(true);
    expect(
      matchCondition(
        { field: 'from_name', op: 'contains', value: 'attacker' },
        impostor,
      ),
    ).toBe(false);
  });

  it('not_contains holds when the needle appears only in the address', () => {
    const mail = makeMail({
      from: 'Newsletter',
      fromAddr: 'news@marketing.example',
    });
    expect(
      matchCondition(
        { field: 'from_name', op: 'not_contains', value: 'marketing' },
        mail,
      ),
    ).toBe(true);
    expect(
      matchCondition(
        { field: 'from_name', op: 'not_contains', value: 'newsletter' },
        mail,
      ),
    ).toBe(false);
  });

  it('regex is applied to the name candidate only', () => {
    const mail = makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });
    expect(
      matchCondition(
        { field: 'from_name', op: 'matches_regex', value: '^alice\\s' },
        mail,
      ),
    ).toBe(true);
    expect(
      matchCondition(
        { field: 'from_name', op: 'matches_regex', value: '@example\\.com$' },
        mail,
      ),
    ).toBe(false);
  });
});

describe('legacy `from` compares two whole values — display name and address', () => {
  it('matches either whole value: the display name or the address', () => {
    const mail = makeMail({ from: 'Alice Smith', fromAddr: 'alice@example.com' });
    expect(
      matchCondition({ field: 'from', op: 'equals', value: 'Alice Smith' }, mail),
    ).toBe(true);
    expect(
      matchCondition(
        { field: 'from', op: 'equals', value: 'alice@example.com' },
        mail,
      ),
    ).toBe(true);
  });

  it('an address rule keeps matching once the sender adds a display name', () => {
    // The useful half of §2.90: before it, `mail.from || mail.fromAddr` meant a
    // display name hid the address entirely and address rules silently stopped
    // firing. Both values are candidates now — as whole values.
    const mail = makeMail({
      from: 'Обычное Имя',
      fromAddr: 'user@example.com',
    });
    expect(
      matchCondition(
        { field: 'from', op: 'equals', value: 'user@example.com' },
        mail,
      ),
    ).toBe(true);
  });

  it('matches a display name by substring', () => {
    const mail = makeMail({ from: 'Пётр Иванов', fromAddr: 'petr@example.com' });
    expect(
      matchCondition({ field: 'from', op: 'contains', value: 'Иванов' }, mail),
    ).toBe(true);
  });

  it('an address embedded in the display name is NOT a candidate of its own', () => {
    // The sender writes their own display name, so `Alice <victim@example.com>`
    // costs them nothing. Splitting it at the angle brackets would hand them a
    // `from equals victim@example.com` match on their own mail — the whole
    // value is compared instead, and it is not the victim address.
    const impostor = makeMail({
      from: 'Alice <victim@example.com>',
      fromAddr: 'attacker@evil.example',
    });
    expect(
      matchCondition(
        { field: 'from', op: 'equals', value: 'victim@example.com' },
        impostor,
      ),
    ).toBe(false);
    expect(
      matchCondition(
        { field: 'from_address', op: 'equals', value: 'victim@example.com' },
        impostor,
      ),
    ).toBe(false);
  });

  it('a quoted address embedded in the display name is not a candidate either', () => {
    const impostor = makeMail({
      from: '"Alice" <victim@example.com>',
      fromAddr: 'attacker@evil.example',
    });
    expect(
      matchCondition(
        { field: 'from', op: 'equals', value: 'victim@example.com' },
        impostor,
      ),
    ).toBe(false);
  });

  it('is still satisfied by an impersonating display name (the reason from_address exists)', () => {
    const impostor = makeMail({
      from: 'user@example.com',
      fromAddr: 'attacker@evil.example',
    });
    expect(
      matchCondition(
        { field: 'from', op: 'equals', value: 'user@example.com' },
        impostor,
      ),
    ).toBe(true);
  });

  it('splitting the field did not change how nameless senders compare', () => {
    const mail = makeMail({
      from: 'alice@example.com',
      fromAddr: 'alice@example.com',
    });
    expect(
      matchCondition(
        { field: 'from', op: 'contains', value: 'alice' },
        mail,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2.162 — rules whose firing cannot be justified
// ---------------------------------------------------------------------------

/** Every operator the engine knows, read off the RuleOp union. */
const ALL_OPS: RuleOp[] = [
  'contains',
  'not_contains',
  'equals',
  'starts_with',
  'ends_with',
  'matches_regex',
];

describe('cc conditions are disarmed at match time (AC3)', () => {
  it('matches under no operator, whatever the value', () => {
    for (const op of ALL_OPS) {
      for (const value of ['', 'carol', '.*', '^$', 'nobody@example.com']) {
        expect(
          matchCondition({ field: 'cc', op, value }, makeMail()),
          `cc/${op}/"${value}"`,
        ).toBe(false);
      }
    }
  });

  it('not_contains on cc does not fire on every message (the mailbox-emptying case)', () => {
    // The defect: cc compared against '' , so "cc not_contains boss@x" was true
    // for EVERY message and the rule trashed the whole mailbox.
    const rule = makeRule({
      conditions: [{ field: 'cc', op: 'not_contains', value: 'boss@example.com' }],
      actions: [{ type: 'trash' }],
    });
    expect(evaluateRules([rule], makeMail())).toEqual([]);
    expect(evaluateRules([rule], makeMail({ cc: undefined }))).toEqual([]);
  });

  it('an empty-string-accepting regex on cc does not fire either', () => {
    const rule = makeRule({
      conditions: [{ field: 'cc', op: 'matches_regex', value: '.*' }],
      actions: [{ type: 'trash' }],
    });
    expect(evaluateRules([rule], makeMail())).toEqual([]);
  });

  it('disarms the whole rule — conditions are AND-combined', () => {
    const rule = makeRule({
      conditions: [
        { field: 'subject', op: 'contains', value: 'report' },
        { field: 'cc', op: 'contains', value: 'carol' },
      ],
      actions: [{ type: 'archive' }],
    });
    expect(evaluateRules([rule], makeMail())).toEqual([]);
  });

  it('a field name that is not a field at all never matches', () => {
    const cond = { field: 'bcc', op: 'not_contains', value: 'x' } as unknown as RuleCondition;
    expect(matchCondition(cond, makeMail())).toBe(false);
    // And it does not throw on the way — the runner catches per message and
    // would have turned a crash into a stalled folder.
    expect(() => matchCondition(cond, makeMail())).not.toThrow();
  });

  it('supported fields keep matching', () => {
    expect(
      matchCondition({ field: 'to', op: 'contains', value: 'bob' }, makeMail()),
    ).toBe(true);
    expect(
      matchCondition({ field: 'subject', op: 'contains', value: 'report' }, makeMail()),
    ).toBe(true);
    expect(
      matchCondition(
        { field: 'from_address', op: 'equals', value: 'alice@example.com' },
        makeMail(),
      ),
    ).toBe(true);
  });
});

describe('findMailRuleRefusal', () => {
  const DESTRUCTIVE: RuleActionType[] = ['move', 'trash', 'archive', 'mark_spam'];
  const HARMLESS: RuleActionType[] = ['mark_read', 'mark_starred'];

  it('refuses the legacy from field on every destructive action (AC5)', () => {
    for (const type of DESTRUCTIVE) {
      const refusal = findMailRuleRefusal(
        [{ field: 'from', op: 'contains', value: 'boss' }],
        [{ type, folder: 'Archive' }],
      );
      expect(refusal, type).toEqual({
        reason: 'unverifiable_sender',
        field: 'from',
        action: type,
      });
    }
  });

  it('allows the legacy from field on mark_read and mark_starred (AC7)', () => {
    for (const type of HARMLESS) {
      expect(
        findMailRuleRefusal([{ field: 'from', op: 'contains', value: 'boss' }], [{ type }]),
        type,
      ).toBeNull();
    }
  });

  it('refuses when a destructive action sits next to a harmless one', () => {
    const refusal = findMailRuleRefusal(
      [{ field: 'from', op: 'contains', value: 'boss' }],
      [{ type: 'mark_read' }, { type: 'trash' }],
    );
    expect(refusal?.reason).toBe('unverifiable_sender');
  });

  it('refuses the display-name field on every destructive action', () => {
    // The tool descriptions promised this ("a destructive action MUST use
    // from_address, never from_name") while nothing enforced it. A policy that
    // lives only in a prompt is not a control.
    for (const type of DESTRUCTIVE) {
      expect(
        findMailRuleRefusal([{ field: 'from_name', op: 'equals', value: 'Acme' }], [{ type }]),
        type,
      ).toEqual({ reason: 'unverifiable_sender', field: 'from_name', action: type });
    }
  });

  it('allows the display-name field on reversible actions', () => {
    for (const type of HARMLESS) {
      expect(
        findMailRuleRefusal([{ field: 'from_name', op: 'equals', value: 'Acme' }], [{ type }]),
        type,
      ).toBeNull();
    }
  });

  it('allows from_address on destructive actions — the one sender field left', () => {
    for (const type of DESTRUCTIVE) {
      expect(
        findMailRuleRefusal(
          [{ field: 'from_address', op: 'equals', value: 'x@y.example' }],
          [{ type }],
        ),
        type,
      ).toBeNull();
    }
  });

  // §2.162 iteration 3 (review round 3) — the requirement is about SENDER
  // conditions, not about destructive actions in general. A rule with a
  // destructive action and NO condition on any sender field at all — "subject
  // contains invoice → trash" — was always legal and was always created and
  // run; only the tool-description prose claimed otherwise. This pins the
  // DECISION itself (`findMailRuleRefusal`, the single function every
  // enforcement point reaches), not just the MCP tool wording that quotes it —
  // a future re-broadening of the policy to "every destructive rule needs
  // from_address" would fail here even if nobody touched ai.ts.
  it.each(['subject', 'to', 'has_attachment'] as const)(
    'allows a destructive action with no sender condition at all (%s)',
    (field) => {
      for (const type of DESTRUCTIVE) {
        expect(
          findMailRuleRefusal([{ field, op: 'contains', value: 'invoice' }], [{ type }]),
          `${field}/${type}`,
        ).toBeNull();
      }
    },
  );

  it('refuses a cc condition regardless of the action', () => {
    for (const type of [...DESTRUCTIVE, ...HARMLESS]) {
      expect(findMailRuleRefusal([{ field: 'cc', op: 'contains', value: 'x' }], [{ type }]), type)
        .toEqual({ reason: 'unsupported_field', field: 'cc' });
    }
  });

  it('reports the unsupported field before the sender one', () => {
    const refusal = findMailRuleRefusal(
      [
        { field: 'cc', op: 'contains', value: 'x' },
        { field: 'from', op: 'contains', value: 'boss' },
      ],
      [{ type: 'trash' }],
    );
    // Both are wrong; the user is told about the condition that can never be
    // evaluated at all, which is the one that must be removed either way.
    expect(refusal).toEqual({ reason: 'unsupported_field', field: 'cc' });
  });

  it('refuses an unknown field name and never echoes untrusted text', () => {
    expect(findMailRuleRefusal([{ field: 'body' }], [{ type: 'mark_read' }])).toEqual({
      reason: 'unsupported_field',
      field: 'body',
    });
    expect(
      findMailRuleRefusal(
        [{ field: 'x: <script>alert(1)</script>' }],
        [{ type: 'mark_read' }],
      ),
    ).toEqual({ reason: 'unsupported_field', field: 'unknown' });
  });

  it('allows a well-formed rule', () => {
    expect(
      findMailRuleRefusal(
        [
          { field: 'from_address', op: 'ends_with', value: '@acme.com' },
          { field: 'subject', op: 'contains', value: 'invoice' },
          { field: 'has_attachment', op: 'equals', value: '' },
        ],
        [{ type: 'move', folder: 'Invoices' }],
      ),
    ).toBeNull();
  });

  it('refuses a payload that is not shaped like a rule at all', () => {
    // These used to be waved through as "inert". They are not inert: the engine
    // subscripts and iterates both halves, and a structurally broken one threw
    // inside matchRule, once per message, until the message was abandoned.
    const malformed = { reason: 'malformed_rule', field: 'unknown' };
    expect(findMailRuleRefusal(null, null)).toEqual(malformed);
    expect(findMailRuleRefusal({}, [{ type: 'trash' }])).toEqual(malformed);
    expect(findMailRuleRefusal('[]', '[]')).toEqual(malformed);
    expect(findMailRuleRefusal([null, 42, 'from'], [{ type: 'trash' }])).toEqual(malformed);
    expect(findMailRuleRefusal([{ field: 'from' }], [null, 7])).toEqual(malformed);
    expect(findMailRuleRefusal([{ op: 'contains' }], [{ type: 'trash' }])).toEqual(malformed);
  });

  it('still answers the editor, which probes it with a field and nothing else', () => {
    // src/components/ruleFields.ts calls `findMailRuleRefusal([{ field }], actions)`
    // to decide what to warn about. Demanding `op`/`value` here would silence
    // every warning in the editor, so full shape validation lives in
    // parseMailRuleParts instead.
    expect(findMailRuleRefusal([{ field: 'from_address' }], [{ type: 'trash' }])).toBeNull();
    expect(findMailRuleRefusal([{ field: 'cc' }], [])).toEqual({
      reason: 'unsupported_field',
      field: 'cc',
    });
    expect(findMailRuleRefusal([{ field: 'from_name' }], [{ type: 'trash' }])).toEqual({
      reason: 'unverifiable_sender',
      field: 'from_name',
      action: 'trash',
    });
  });

  it('an action row with no type yet is a draft, not a malformed rule', () => {
    // The editor also probes with half-built action rows; treating those as
    // malformed would drop the warning the user needs while typing.
    expect(findMailRuleRefusal([{ field: 'from_address' }], [{}])).toBeNull();
  });

  it('reads only field and type — op and value are never consulted', () => {
    // Same fields and actions, wildly different text: the verdict is identical.
    const a = findMailRuleRefusal([{ field: 'from', op: 'equals', value: 'a' }], [{ type: 'trash' }]);
    const b = findMailRuleRefusal(
      [{ field: 'from', op: 'matches_regex', value: '^(?:.*)$' }],
      [{ type: 'trash', folder: 'Trash' }],
    );
    expect(a).toEqual(b);
  });
});

describe('findEncodedMailRuleRefusal', () => {
  it('decides on the JSON halves a save path receives', () => {
    expect(
      findEncodedMailRuleRefusal(
        JSON.stringify([{ field: 'from', op: 'contains', value: 'boss' }]),
        JSON.stringify([{ type: 'trash' }]),
      ),
    ).toEqual({ reason: 'unverifiable_sender', field: 'from', action: 'trash' });
  });

  it('allows a well-formed encoded rule', () => {
    expect(
      findEncodedMailRuleRefusal(
        JSON.stringify([{ field: 'from_address', op: 'contains', value: 'boss@acme.com' }]),
        JSON.stringify([{ type: 'trash' }]),
      ),
    ).toBeNull();
  });

  it('refuses undecodable JSON as malformed', () => {
    expect(findEncodedMailRuleRefusal('{oops', 'also broken')).toEqual({
      reason: 'malformed_rule',
      field: 'unknown',
    });
  });

  it('refuses JSON that decodes into the wrong shape', () => {
    const malformed = { reason: 'malformed_rule', field: 'unknown' };
    // Syntactically valid, structurally wrong — the form an MCP tool can be
    // talked into producing, since the model authors the JSON.
    expect(findEncodedMailRuleRefusal('{}', '[{"type":"trash"}]')).toEqual(malformed);
    expect(findEncodedMailRuleRefusal('[42]', '[{"type":"trash"}]')).toEqual(malformed);
    expect(findEncodedMailRuleRefusal('[{"field":"subject"}]', '[{"type":"trash"}]'))
      .toEqual(malformed);
    expect(findEncodedMailRuleRefusal('[{"field":"subject","op":"contains"}]', '[]'))
      .toEqual(malformed);
    expect(findEncodedMailRuleRefusal('[]', '{"type":"trash"}')).toEqual(malformed);
    expect(findEncodedMailRuleRefusal('[]', '[{"type":"move","folder":7}]')).toEqual(malformed);
  });

  it('accepts a fully-formed encoded rule', () => {
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contains","value":"invoice"}]',
        '[{"type":"move","folder":"Invoices"}]',
      ),
    ).toBeNull();
  });
});

describe('parseMailRuleParts', () => {
  it('returns typed halves for a well-formed rule', () => {
    expect(
      parseMailRuleParts(
        '[{"field":"subject","op":"contains","value":"invoice"}]',
        '[{"type":"move","folder":"Invoices"}]',
      ),
    ).toEqual({
      conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
      actions: [{ type: 'move', folder: 'Invoices' }],
    });
  });

  it('rejects every shape the engine would trip over', () => {
    // Each of these reached `matchRule` before and threw there.
    expect(parseMailRuleParts('{oops', '[]')).toBeNull();
    expect(parseMailRuleParts('{}', '[]')).toBeNull();
    expect(parseMailRuleParts('[42]', '[]')).toBeNull();
    expect(parseMailRuleParts('[null]', '[]')).toBeNull();
    expect(parseMailRuleParts('[{"op":"contains","value":"x"}]', '[]')).toBeNull();
    expect(parseMailRuleParts('[{"field":"subject","value":"x"}]', '[]')).toBeNull();
    expect(parseMailRuleParts('[{"field":"subject","op":"contains"}]', '[]')).toBeNull();
    expect(parseMailRuleParts('[]', '"trash"')).toBeNull();
    expect(parseMailRuleParts('[]', '[{"folder":"X"}]')).toBeNull();
    expect(parseMailRuleParts('[]', '[{"type":"move","folder":{}}]')).toBeNull();
  });

  it('lets an unknown field or action name through — that is the policy layer\'s call', () => {
    // Shape and policy are different questions; this one only answers shape.
    expect(parseMailRuleParts('[{"field":"cc","op":"contains","value":"x"}]', '[]'))
      .not.toBeNull();
  });
});

describe('the closed vocabularies (RULE_OPS / RULE_ACTION_TYPES)', () => {
  // Spelled out literally rather than derived from the exported tuples: a test
  // that iterates the same list it validates against would pass a typo in the
  // list itself, which is the one mistake nothing else here would catch.
  const EXPECTED_OPS = [
    'contains',
    'not_contains',
    'equals',
    'starts_with',
    'ends_with',
    'matches_regex',
  ];
  const EXPECTED_ACTIONS = [
    'move',
    'archive',
    'trash',
    'mark_read',
    'mark_starred',
    'mark_spam',
  ];

  it('contains exactly the operators the engine implements', () => {
    expect([...RULE_OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it('contains exactly the action types the executor implements', () => {
    expect([...RULE_ACTION_TYPES].sort()).toEqual([...EXPECTED_ACTIONS].sort());
  });

  it('every operator is really implemented — none silently matches nothing', () => {
    // An operator with no branch in `applyStringOp` returns undefined, so the
    // condition is false for every message: a filter the user believes is
    // configured, catching nothing. Each case below is chosen to match.
    const mail = makeMail({ subject: 'Weekly report Q1 2026' });
    const cases: Record<string, string> = {
      contains: 'report',
      not_contains: 'invoice',
      equals: 'Weekly report Q1 2026',
      starts_with: 'Weekly',
      ends_with: '2026',
      matches_regex: '^weekly .*2026$',
    };
    for (const op of RULE_OPS) {
      expect(
        matchCondition({ field: 'subject', op, value: cases[op] }, mail),
        op,
      ).toBe(true);
    }
  });

  it('accepts every operator in the dictionary when parsing a stored rule', () => {
    for (const op of RULE_OPS) {
      expect(
        parseMailRuleParts(
          JSON.stringify([{ field: 'subject', op, value: 'x' }]),
          '[]',
        ),
        op,
      ).not.toBeNull();
    }
  });

  it('accepts every action type in the dictionary when parsing a stored rule', () => {
    for (const type of RULE_ACTION_TYPES) {
      // `move` is the one type that carries an operand of its own.
      const action = type === 'move' ? { type, folder: 'Filed' } : { type };
      expect(parseMailRuleParts('[]', JSON.stringify([action])), type).not.toBeNull();
    }
  });

  it('rejects an operator the engine has no branch for', () => {
    // The realistic case is a typo from a model or a hand-edited rule: it
    // parses, saves, and then matches nothing at all.
    for (const op of ['contain', 'CONTAINS', 'regex', 'gt', '']) {
      expect(
        parseMailRuleParts(
          JSON.stringify([{ field: 'subject', op, value: 'x' }]),
          '[]',
        ),
        op,
      ).toBeNull();
    }
  });

  it('rejects an action type the executor has no branch for', () => {
    // This one is worse than a dead rule: the executor did nothing, and the
    // caller logged a rule_log row saying the action was applied.
    for (const type of ['delete', 'MOVE', 'forward', 'mark-read', '']) {
      expect(parseMailRuleParts('[]', JSON.stringify([{ type }])), type).toBeNull();
    }
  });

  it('reports an unknown operator or action type as malformed on the save paths', () => {
    const malformed = { reason: 'malformed_rule', field: 'unknown' };
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contain","value":"x"}]',
        '[{"type":"trash"}]',
      ),
    ).toEqual(malformed);
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contains","value":"x"}]',
        '[{"type":"delete"}]',
      ),
    ).toEqual(malformed);
  });
});

describe('a move action must name where it moves mail', () => {
  it('rejects a move with no folder at all', () => {
    expect(parseMailRuleParts('[]', '[{"type":"move"}]')).toBeNull();
  });

  it('rejects a move whose folder is blank', () => {
    // Whitespace addresses no mailbox, so it is the same defect as an absent
    // one — and both used to move nothing while being logged as applied.
    expect(parseMailRuleParts('[]', '[{"type":"move","folder":""}]')).toBeNull();
    expect(parseMailRuleParts('[]', '[{"type":"move","folder":"   "}]')).toBeNull();
    expect(parseMailRuleParts('[]', '[{"type":"move","folder":"\\t\\n"}]')).toBeNull();
  });

  it('accepts a move that names a folder', () => {
    expect(parseMailRuleParts('[]', '[{"type":"move","folder":"Invoices"}]')).not.toBeNull();
  });

  // The blank check reads `folder.trim()` to decide whether there is a target
  // at all, but must never feed the TRIMMED value back into the stored action:
  // IMAP mailbox names are whitespace-significant (RFC 3501 allows a space
  // inside a hierarchy component), so silently trimming a folder like
  // `" Invoices"` would address a DIFFERENT mailbox than the one configured —
  // the same class of bug as the refusal this whole feature exists to prevent,
  // just introduced by the fix instead of by the original defect.
  it('keeps significant surrounding whitespace in a non-blank folder name untouched', () => {
    const parsed = parseMailRuleParts('[]', '[{"type":"move","folder":" Invoices "}]');
    expect(parsed).not.toBeNull();
    expect(parsed?.actions).toEqual([{ type: 'move', folder: ' Invoices ' }]);
  });

  it('does not demand a folder from the action types that have no target', () => {
    for (const type of RULE_ACTION_TYPES.filter((t) => t !== 'move')) {
      expect(parseMailRuleParts('[]', JSON.stringify([{ type }])), type).not.toBeNull();
    }
  });

  it('refuses a folderless move on the save paths, as malformed', () => {
    // Same reason as every other shape defect: renderer and locales already
    // answer `malformed_rule`, and this IS a defect of form.
    const malformed = { reason: 'malformed_rule', field: 'unknown' };
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contains","value":"x"}]',
        '[{"type":"move"}]',
      ),
    ).toEqual(malformed);
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contains","value":"x"}]',
        '[{"type":"move","folder":" "}]',
      ),
    ).toEqual(malformed);
  });

  it('refuses a folderless move sitting next to a well-formed action', () => {
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"subject","op":"contains","value":"x"}]',
        '[{"type":"mark_read"},{"type":"move"}]',
      ),
    ).toEqual({ reason: 'malformed_rule', field: 'unknown' });
  });

  it('still allows a well-formed move rule end to end', () => {
    expect(
      findEncodedMailRuleRefusal(
        '[{"field":"from_address","op":"ends_with","value":"@acme.test"}]',
        '[{"type":"move","folder":"Acme"}]',
      ),
    ).toBeNull();
  });
});

describe('the engine survives a rule that was stored before the shape check', () => {
  it('matchRule treats a non-array conditions half as matching nothing', () => {
    const rule = { ...makeRule(), conditions: {} as unknown as RuleCondition[] };
    expect(() => matchRule(rule, makeMail())).not.toThrow();
    expect(matchRule(rule, makeMail())).toBe(false);
  });

  it('matchCondition survives a primitive where a condition should be', () => {
    const cond = 42 as unknown as RuleCondition;
    expect(() => matchCondition(cond, makeMail())).not.toThrow();
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('matchCondition survives a condition with no value', () => {
    const cond = { field: 'subject', op: 'contains' } as unknown as RuleCondition;
    expect(() => matchCondition(cond, makeMail())).not.toThrow();
    expect(matchCondition(cond, makeMail())).toBe(false);
  });

  it('evaluateRules survives a non-array actions half', () => {
    const rule = {
      ...makeRule(),
      conditions: [
        { field: 'subject', op: 'contains', value: 'report' } as RuleCondition,
      ],
      actions: 'trash' as unknown as MailRule['actions'],
    };
    expect(() => evaluateRules([rule], makeMail())).not.toThrow();
    expect(evaluateRules([rule], makeMail())).toEqual([]);
  });
});

describe('refusal wire format', () => {
  it('round-trips through the error message', () => {
    const refusal: MailRuleRefusal = {
      reason: 'unverifiable_sender',
      field: 'from',
      action: 'trash',
    };
    const message = formatMailRuleRefusal(refusal);
    expect(message).toContain(MAIL_RULE_REFUSED_ERROR);
    expect(parseMailRuleRefusal(message)).toEqual(refusal);
  });

  it('is recoverable after the IPC funnel and Electron prefix the message', () => {
    const encoded = formatMailRuleRefusal({ reason: 'unsupported_field', field: 'cc' });
    const wrapped = new Error(
      `Error invoking remote method 'rules:create': [mcerr:unknown] ${encoded}: mail rule refused`,
    );
    expect(parseMailRuleRefusal(wrapped)).toEqual({
      reason: 'unsupported_field',
      field: 'cc',
    });
  });

  it('the shared error factory is what both refusing layers throw', () => {
    // main.ts refuses first, packages/db refuses as a last line. Both build the
    // Error here, so the renderer decodes one code whichever layer caught it.
    const refusal: MailRuleRefusal = { reason: 'unsupported_field', field: 'cc' };
    const err = mailRuleRefusalError(refusal);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`${formatMailRuleRefusal(refusal)}: mail rule refused`);
    expect(parseMailRuleRefusal(err)).toEqual(refusal);
  });

  it('ignores unrelated errors', () => {
    expect(parseMailRuleRefusal(new Error('ECONNRESET'))).toBeNull();
    expect(parseMailRuleRefusal(undefined)).toBeNull();
    expect(parseMailRuleRefusal('MAIL_RULE_REFUSED:not_a_reason:from')).toBeNull();
  });
});
