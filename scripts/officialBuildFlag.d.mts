export function parseOfficialBuildFlag(raw: string | undefined): 'official' | 'self' | 'invalid'
export function resolveNewGoogleMailboxes(
  env: Record<string, string | undefined>,
  options?: { enforceRelease?: boolean },
): boolean
