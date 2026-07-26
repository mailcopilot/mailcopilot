// Re-export from @mailcopilot/core — source of truth is packages/core/gravatar.ts
export {
  sha256hex,
  getGravatarUrl,
  precomputeGravatarHash,
  markGravatarNotFound,
  clearGravatarCache,
} from '@mailcopilot/core'
