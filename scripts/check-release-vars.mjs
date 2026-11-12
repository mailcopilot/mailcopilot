#!/usr/bin/env node
/**
 * §2.255 — the release path must REFUSE, not substitute a default and continue.
 *
 * A build with a baked-in Google client ID and an EMPTY client secret went
 * through the pipeline end to end, was packaged and published as **1.25.0**,
 * and broke Gmail sign-in for every Linux install of it — found by a user, not
 * by us; 1.25.1 was the hotfix that followed. Nothing on the way out said a
 * word. The diagnosis in BACKLOG §2.255 is that there was no check that
 * refuses — only checks that substitute a default or stay silent.
 *
 * This is the one guard, shared by every **CI** build path — which is the
 * honest boundary of what it can promise. A developer running `electron-builder`
 * locally never reaches it, and that is correct: a self-build has no keys of
 * ours by design (see the `source` tier below). The guarantee is therefore
 * "nothing we PUBLISH ships an unset delivery variable", not "no artifact
 * electron-builder can produce". Before this guard, the only release-variable
 * check lived inside the old GitLab dispatch script, knew about two
 * variables out of the set, and ran on the Windows/macOS path only — the
 * GitLab Linux build had no check at all and actively manufactured a value:
 *
 *     export MAILCOPILOT_UPDATE_URL="${MAILCOPILOT_UPDATE_URL:-https://placeholder.local/updates}"
 *
 * which is the same shape of mistake as the empty secret, one level down.
 *
 * ## Three tiers, because one rule cannot serve all three callers
 *
 * The tier is read from a tag, not from a flag a caller invents for us. Every
 * installer is built by `.github/workflows/release.yml`, whose `prepare` job
 * sets `CI_COMMIT_TAG` to the pushed `vX.Y.Z` tag — after checking it is a
 * stable tag matching package.json — or to `dry-run` for a rehearsal. A dry
 * run therefore gets the softer tier; it uploads `dry-run-*` artifacts that
 * the GitLab copy never accepts and creates no release, so nothing it builds
 * reaches a user.
 *
 *   release  — `CI_COMMIT_TAG` matches `vX.Y.Z`. This artifact reaches users.
 *              Every delivery variable is REQUIRED; a missing one stops the
 *              build.
 *   nightly  — running in CI, no release tag (today: a release.yml dry run).
 *              Everything WARNS; nothing stops the build. Such an artifact
 *              reaches no user: the registry copy (`publish` in
 *              `.gitlab-ci.yml`) runs on `vX.Y.Z` tags ONLY, so there is no
 *              nightly feed to break.
 *
 *              An earlier revision of this file REQUIRED the update URL here,
 *              justified by "the nightly feed genuinely delivers updates" —
 *              which is simply false, and BACKLOG §2.255 had already said this
 *              tier should warn. Worse, the rule was actively harmful: only
 *              `main` is a protected branch, so a variable marked Protected
 *              (exactly the configuration behind the 1.25.0 incident) is
 *              ABSENT on `develop` by design. Requiring it there would have
 *              turned every nightly pipeline red over a value whose absence is
 *              expected — an alarm that fires always and therefore says
 *              nothing.
 *   source   — not in CI at all. Requires NOTHING. Building MailCopilot from
 *              source is a supported, documented scenario (AGPL-3.0-only), the
 *              builder legitimately has no keys of ours, and
 *              `GOOGLE_OAUTH_UNCONFIGURED_MESSAGE` exists precisely to explain
 *              that at runtime. Erring strict here would break that scenario;
 *              erring lax on the release tier reproduces the incident.
 *
 * ## What this does NOT do
 *
 * It does not touch `resolveGoogleOAuthCredentials`. An empty client secret is
 * a legitimate configuration there (a public client on PKCE alone), and
 * redefining that would break self-builds. The defect is not the resolver's
 * meaning — it is that the RELEASE PATH accepted a configuration only a
 * self-build is allowed to have. So the check lives here, on the release path.
 *
 * Usage:
 *   node scripts/check-release-vars.mjs            # classify from env, enforce
 *   node scripts/check-release-vars.mjs --explain  # print the tier and exit 0
 *   node scripts/check-release-vars.mjs --from-github-settings
 *     # release.yml build jobs: judge MAILCOPILOT_UPDATE_URL_RAW (trimmed), then
 *     # export the judged value to $GITHUB_ENV as MAILCOPILOT_UPDATE_URL
 */

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** A release tag looks exactly like the one `.gitlab-ci.yml` publishes on. */
const RELEASE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/

/**
 * SHA-256 of the one update feed a release may carry (the URL with no
 * surrounding whitespace). Only the hash is recorded: the mirror is public and
 * the address names an internal host.
 *
 * Why a release pins it at all: the feed now comes from a repository VARIABLE
 * of the public mirror, which nothing on the GitLab side reads any more. An
 * installer carrying an attacker-chosen feed would offer that party's
 * "updates" to every user, and a variable on the mirror is a much easier place
 * to change than a value baked by our own pipeline. Changing the feed on
 * purpose means changing this constant in the same review.
 *
 * Recompute from the value with surrounding whitespace trimmed (never commit the URL):
 *   printf %s "$MAILCOPILOT_UPDATE_URL" | sha256sum
 */
export const EXPECTED_UPDATE_URL_SHA256 = 'd7d5e0b44d30472b92ec4a3a4af8c8f1e18bf167a7cce5a9f1c42808ba407c16'

/** The update feed as a build receives it: surrounding whitespace dropped. */
export function normalizeUpdateUrl(raw) {
  return (raw || '').trim()
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Variables that must carry a real value in a shipped artifact, with the
 * consequence of each being empty stated in the user's terms — the message has
 * to say what breaks, not just which name is missing.
 *
 * There is deliberately NO per-variable strictness knob here. An earlier
 * revision carried a `requiredOnNightly` flag, but once the nightly reasoning
 * was corrected (see the tier block above) every entry set it to `false`, which
 * made the branch reading it dead. The rule that survived is simpler and is the
 * one the tiers already express: a release requires all of these, a nightly
 * warns about all of them. If a future variable genuinely needs to stop a
 * nightly, add the knob back together with the argument for it — do not leave
 * an always-false field standing as a place where an argument used to be.
 */
export const DELIVERY_VARS = [
  {
    name: 'MAILCOPILOT_UPDATE_URL',
    consequence: 'the shipped build cannot self-update — it polls an address that serves nothing',
  },
  {
    name: 'MAILCOPILOT_GOOGLE_CLIENT_ID',
    consequence: 'Gmail sign-in is unavailable in the shipped build',
  },
  {
    name: 'MAILCOPILOT_GOOGLE_CLIENT_SECRET',
    consequence:
      'Gmail sign-in fails at the token exchange with Google\'s own "client_secret is missing" — this is the exact defect that shipped in 1.25.0',
  },
  {
    name: 'SENTRY_DSN',
    consequence: 'the shipped build reports no errors at all, so failures stay invisible to us',
  },
]

/**
 * `release` | `nightly` | `source`, from the environment alone.
 *
 * Reading the tag rather than accepting a caller-supplied flag is deliberate:
 * a flag is one more thing that can disagree with what the pipeline is actually
 * doing, and the whole point of this guard is to not be lied to.
 */
export function classifyBuildTier(env) {
  const tag = (env.CI_COMMIT_TAG || '').trim()
  if (RELEASE_TAG_RE.test(tag)) return 'release'
  const inCi = ['CI', 'GITLAB_CI', 'GITHUB_ACTIONS'].some(name => isTruthyFlag(env[name]))
  return inCi ? 'nightly' : 'source'
}

/**
 * A CI flag counts only when it says YES — presence alone is not enough.
 *
 * `CI=false` is a real thing people type: it is the long-standing CRA/React
 * idiom for "do not treat warnings as errors", and it survives in plenty of
 * local build scripts. Treating any non-empty value as "we are in CI" pushed
 * such a build from the `source` tier into `nightly` — where, in the revision
 * that shipped this bug, a missing `MAILCOPILOT_UPDATE_URL` was a REFUSAL, so
 * someone building us from source with none of our keys got their build
 * stopped. Both halves of that pair are fixed now (nightly warns about
 * everything, and `CI=false` no longer reads as CI), and the tier a self-build
 * lands in is `source` regardless. The distinction is kept anyway: `source`
 * requires nothing at all and says so, while `nightly` prints warnings about
 * keys a stranger has no business having. Being wrong here in the strict
 * direction is the one direction that breaks a scenario we promise to support
 * (AGPL-3.0-only, build-from-source).
 *
 * Both CI platforms we run on set the literal string `true`, so nothing about
 * the real paths changes. Anything we do not recognise as affirmative is
 * treated as "not CI", which errs toward the lax tier on purpose: an
 * unrecognised value must not be able to stop a stranger's build.
 */
function isTruthyFlag(raw) {
  const value = (raw || '').trim().toLowerCase()
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * Values that are present but mean "nobody configured this", PER VARIABLE.
 *
 * Keyed by variable name rather than kept as one flat set, because a retired
 * sentinel belongs to the variable it was a sentinel FOR. The flat version
 * refused `https://placeholder.local/updates` in any of the four — including,
 * absurdly, as an OAuth client secret. Unlikely to ever happen, but it is a way
 * to wedge a legitimate configuration on a rule that has no business applying
 * there, and "unlikely" is not the standard for a check that stops releases.
 *
 * Scope is deliberately one literal, not a heuristic: this is the exact string
 * `.gitlab-ci.yml` substituted for `MAILCOPILOT_UPDATE_URL` until this task
 * removed it. The realistic regression is not someone inventing a new sentinel
 * — it is this line coming back, from a revert, a merge, or an agent reading an
 * older comment that still describes the fallback. A guard that refuses empties
 * but waves through the one placeholder we ourselves shipped would miss the
 * repeat of its own founding incident.
 *
 * What this is NOT: URL validation. Deciding whether an address is "real"
 * cannot be done from here — it belongs to whoever owns the update feed, and
 * guessing at it would be the same mistake as estimating state we do not own
 * (CLAUDE.md §5 «Кто владеет правдой»). Matching a known-retired literal needs
 * no such judgement, and neither does the release-tier pin below
 * (EXPECTED_UPDATE_URL_SHA256): the choice of feed is ours, recorded here.
 *
 * Compared case-insensitively after trimming, because a value re-typed by hand
 * into a CI settings form is not guaranteed to keep its case.
 */
const RETIRED_PLACEHOLDERS = {
  MAILCOPILOT_UPDATE_URL: new Set(['https://placeholder.local/updates']),
}

/**
 * Why a variable does not count as configured — `null` when it does.
 *
 * The two reasons are kept apart all the way to the message because they send
 * the operator to different places: `absent` means go create the value,
 * `placeholder` means the value is there and is the wrong one, which reads as a
 * lie if we call it "unset".
 */
function classifyValue(env, name, expectedFeedSha256) {
  const value = (env[name] || '').trim()
  if (!value) return 'absent'
  if (RETIRED_PLACEHOLDERS[name]?.has(value.toLowerCase())) return 'placeholder'
  if (name === 'MAILCOPILOT_UPDATE_URL') {
    // A tab or newline INSIDE the value is not something a URL parser can be
    // trusted to drop the same way everywhere; it is refused, never repaired.
    if (/\s/.test(value)) return 'whitespace'
    if (expectedFeedSha256 && sha256Hex(value) !== expectedFeedSha256) return 'unexpected-feed'
  }
  return null
}

/**
 * Split the delivery variables into what STOPS this build and what merely gets
 * reported. Pure — the CLI below does all the printing and exiting.
 *
 * Entries are `{ ...spec, problem }`, so a caller (and the tests) can tell an
 * absent value from a placeholder without re-deriving it from the environment.
 */
export function evaluateReleaseVars(tier, env, { expectedFeedSha256 = EXPECTED_UPDATE_URL_SHA256 } = {}) {
  if (tier === 'source') return { missing: [], warnings: [] }
  const missing = []
  const warnings = []
  for (const spec of DELIVERY_VARS) {
    // The feed pin applies to a release only: a dry run or nightly reaches no user.
    const problem = classifyValue(env, spec.name, tier === 'release' ? expectedFeedSha256 : null)
    if (!problem) continue
    ;(tier === 'release' ? missing : warnings).push({ ...spec, problem })
  }
  return { missing, warnings }
}

/** How a single offending variable is described in both message blocks. */
function describe(entry) {
  if (entry.problem === 'unexpected-feed') {
    return `  ${entry.name} is not the update feed recorded in scripts/check-release-vars.mjs ` +
      '(its sha256 differs): the installer would offer updates from an address nobody reviewed.'
  }
  if (entry.problem === 'whitespace') {
    return `  ${entry.name} contains whitespace inside the value; fix the setting rather than relying on a parser to drop it.`
  }
  const prefix =
    entry.problem === 'placeholder'
      ? `${entry.name} is set to a retired placeholder`
      : `${entry.name} is empty or unset`
  return `  ${prefix}: ${entry.consequence}.`
}

/**
 * Where the operator has to go to fix this, which is NOT the same store on
 * every runner: the GitHub jobs read `secrets.*` from the mirror, and telling
 * someone staring at a red Windows build to edit a GitLab variable sends them
 * to a settings page where the value they need does not live.
 *
 * Detected from the runner we are actually executing on, for the same reason
 * the tier is: a value we derive cannot disagree with reality, a value we are
 * handed can.
 */
function remediation(env) {
  if (isTruthyFlag(env.GITHUB_ACTIONS)) {
    return [
      'This job runs on GitHub Actions, so the fix is on the mirror, not in GitLab.',
      'Where each value comes from here:',
      '  MAILCOPILOT_GOOGLE_CLIENT_ID / _SECRET — repository SECRETS only. If they are',
      '    missing, create them on the mirror.',
      '  SENTRY_DSN — repository SECRET.',
      '  MAILCOPILOT_UPDATE_URL — repository VARIABLE (not a secret: it ships in every',
      '    installer). Settings → Secrets and variables → Actions → Variables. On a',
      '    release it must hash to EXPECTED_UPDATE_URL_SHA256 in this script.',
      'Secrets are created by hand: scripts/mirror-github.sh recreates the repository and',
      'never carries them, so a freshly re-mirrored repo has none. Check',
      'Settings → Secrets and variables → Actions, then re-run.',
      'Do not paste a literal into the workflow file — the mirror is public.',
    ]
  }
  return [
    'Fix the CI variable in GitLab and check that it is available to PROTECTED TAGS —',
    'a variable that exists for branches but not for tags looks set everywhere except',
    'the one pipeline that matters. Then re-run the job.',
  ]
}

function render(tier, { missing, warnings }, env = {}) {
  const lines = []
  if (warnings.length > 0) {
    lines.push(`Warning: this ${tier} build is missing ${warnings.map(v => v.name).join(', ')}.`)
    for (const v of warnings) lines.push(describe(v))
    lines.push('The build continues — a nightly is ours to look at, not something users install blind.')
    lines.push('')
  }
  if (missing.length === 0) return { text: lines.join('\n'), failed: false }

  lines.push(`Error: this is a ${tier.toUpperCase()} build, and these delivery variables are not configured:`)
  for (const v of missing) lines.push(describe(v))
  lines.push('')
  lines.push('None of these degrade loudly. Each one produces an artifact that looks fine,')
  lines.push('installs fine, and fails only once a user reaches the broken feature — which is')
  lines.push('how 1.25.0 shipped a build whose Gmail sign-in could never have worked.')
  lines.push('The build is stopped here instead.')
  lines.push('')
  lines.push(...remediation(env))
  lines.push('Do NOT work around this by substituting a placeholder value: that is the exact')
  lines.push('construction this guard was added to remove (BACKLOG §2.255, hole (в)), and the')
  lines.push('one placeholder we already shipped is refused by name.')
  return { text: lines.join('\n'), failed: true }
}

/**
 * `--from-github-settings` (release.yml build jobs): the job hands the raw
 * repository variable over as MAILCOPILOT_UPDATE_URL_RAW and does NOT define
 * MAILCOPILOT_UPDATE_URL itself. This mode judges the TRIMMED value and, only
 * when the check passes, writes exactly that value to $GITHUB_ENV, from where
 * the following steps (the build) read it. The build therefore bakes the value
 * that was judged, and no precedence rule between a job's `env:` and
 * $GITHUB_ENV is relied upon (GitHub documents none).
 *
 * A value with whitespace inside is never written, whatever the tier: one more
 * line in $GITHUB_ENV would set any environment variable for the build.
 */
export function githubSettingsEnv(env) {
  return { ...env, MAILCOPILOT_UPDATE_URL: env.MAILCOPILOT_UPDATE_URL_RAW ?? '' }
}

function exportUpdateUrl(env) {
  const value = normalizeUpdateUrl(env.MAILCOPILOT_UPDATE_URL)
  if (!value) return
  if (/\s/.test(value)) {
    process.stderr.write('Error: MAILCOPILOT_UPDATE_URL contains whitespace inside the value; refusing to pass it to the build.\n')
    process.exit(1)
  }
  if (!env.GITHUB_ENV) {
    process.stderr.write('Error: --from-github-settings needs $GITHUB_ENV (it only runs inside GitHub Actions).\n')
    process.exit(1)
  }
  appendFileSync(env.GITHUB_ENV, `MAILCOPILOT_UPDATE_URL=${value}\n`)
}

function main() {
  const fromGithub = process.argv.includes('--from-github-settings')
  const env = fromGithub ? githubSettingsEnv(process.env) : process.env
  const tier = classifyBuildTier(env)

  if (process.argv.includes('--explain')) {
    process.stdout.write(`release-vars tier: ${tier}\n`)
    process.exit(0)
  }

  if (tier === 'source') {
    process.stdout.write(
      'Release-vars check skipped: not a CI build. Building from source needs none of our keys.\n',
    )
    process.exit(0)
  }

  const result = evaluateReleaseVars(tier, env)
  const { text, failed } = render(tier, result, env)
  if (text) process[failed ? 'stderr' : 'stdout'].write(`${text}\n`)
  if (failed) process.exit(1)
  if (fromGithub) exportUpdateUrl(env)
  process.stdout.write(`Release-vars check OK (${tier}): every required delivery variable is set.\n`)
}

// Guard so importing this module for tests neither prints nor exits.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
