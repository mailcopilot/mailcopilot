/**
 * Misdirection prevention — warn when sending to potentially wrong recipients.
 *
 * Pure functions, no side effects.
 */

export type Recipient = { email: string; name?: string };

export type MisdirectionWarning = {
  type: 'external_domain' | 'new_recipients_in_reply';
  /** Domains outside the majority group (for 'external_domain') */
  externalDomains?: string[];
  /** Recipients not present in the original message (for 'new_recipients_in_reply') */
  newRecipients?: Recipient[];
};

/** Extract the domain part of an email address (lowercased). */
export function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return email.slice(at + 1).toLowerCase();
}

/**
 * Check recipients for potential misdirection issues.
 *
 * @param recipients      - All recipients of the message being composed.
 * @param accountDomain   - Domain of the sender's account (e.g. "company.com").
 * @param trustedDomains  - Additional domains considered safe (case-insensitive).
 * @param originalRecipients - Recipients of the original message (reply scenario).
 * @returns A warning object, or null if everything looks fine.
 */
export function checkMisdirection(
  recipients: Recipient[],
  accountDomain: string,
  trustedDomains: string[],
  originalRecipients?: Recipient[],
): MisdirectionWarning | null {
  const normalizedAccountDomain = accountDomain.toLowerCase();
  const trustedSet = new Set(trustedDomains.map((d) => d.toLowerCase()));

  // --- external_domain check ---
  const externalWarning = checkExternalDomain(
    recipients,
    normalizedAccountDomain,
    trustedSet,
  );
  if (externalWarning) return externalWarning;

  // --- new_recipients_in_reply check ---
  if (originalRecipients) {
    const replyWarning = checkNewRecipientsInReply(
      recipients,
      originalRecipients,
    );
    if (replyWarning) return replyWarning;
  }

  return null;
}

/**
 * If the majority of recipients share the same domain (>= 2) and at least one
 * recipient belongs to a different domain that is neither the account domain
 * nor a trusted domain, return an 'external_domain' warning.
 */
function checkExternalDomain(
  recipients: Recipient[],
  accountDomain: string,
  trustedSet: Set<string>,
): MisdirectionWarning | null {
  if (recipients.length < 2) return null;

  // Count recipients per domain
  const domainCounts = new Map<string, number>();
  for (const r of recipients) {
    const d = extractDomain(r.email);
    if (d) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
  }

  // Find the majority domain (the one with the highest count, must be >= 2)
  let majorityDomain = '';
  let majorityCount = 0;
  for (const [domain, count] of domainCounts) {
    if (count > majorityCount) {
      majorityCount = count;
      majorityDomain = domain;
    }
  }

  if (majorityCount < 2) return null;

  // Collect external domains that are outside the majority group
  const externalDomains: string[] = [];
  for (const [domain] of domainCounts) {
    if (domain === majorityDomain) continue;
    if (domain === accountDomain) continue;
    if (trustedSet.has(domain)) continue;
    externalDomains.push(domain);
  }

  if (externalDomains.length === 0) return null;

  return {
    type: 'external_domain',
    externalDomains: [...new Set(externalDomains)].sort(),
  };
}

/**
 * When replying, detect recipients that were not part of the original message.
 */
function checkNewRecipientsInReply(
  recipients: Recipient[],
  originalRecipients: Recipient[],
): MisdirectionWarning | null {
  const originalEmails = new Set(
    originalRecipients.map((r) => r.email.toLowerCase()),
  );

  const newRecipients = recipients.filter(
    (r) => !originalEmails.has(r.email.toLowerCase()),
  );

  if (newRecipients.length === 0) return null;

  return {
    type: 'new_recipients_in_reply',
    newRecipients,
  };
}
