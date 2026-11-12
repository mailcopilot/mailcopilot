#!/usr/bin/env node
/**
 * Publishes a stable tag's installers as a GitHub Release.
 *
 * Runs inside `.github/workflows/release.yml` (job `publish-github`), on the
 * public mirror, after the three platform builds of the same run have uploaded
 * their artifacts into `dist/`. The GitLab `publish` job later copies the very
 * same artifacts into the GitLab Package Registry and refuses unless every file
 * is byte-identical to an asset of the release published here
 * (scripts/fetch-github-release.mjs), so this release is the reference copy.
 *
 * Environment: GITHUB_TOKEN (the run's token, `contents: write`; only ever in an
 * Authorization header), GITHUB_REPOSITORY (owner/repo), RELEASE_TAG (vX.Y.Z).
 *
 * Safety properties:
 *   - The release is created as a DRAFT and published only after every asset is
 *     uploaded, so nobody downloads half a release.
 *   - A PUBLISHED release is never modified. A retry either finds every asset
 *     already there with the same size and sha256 (nothing to do) or refuses
 *     with the list of differences. Nothing is deleted from a published release.
 *   - The tag must already exist on GitHub: creating a release for a missing tag
 *     would make GitHub tag the default branch's HEAD, i.e. the wrong commit.
 *
 * Releases stay unsigned for now; signing (BACKLOG §2.284, §2.285) is not part
 * of this script and nothing here refuses an unsigned build.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** The installers and update feeds a platform build produces — nothing else is published. */
export const ASSET_RE = /\.(AppImage|deb|rpm|exe|dmg)$|^latest(-linux|-mac)?\.yml$/
export const RELEASE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const API = 'https://api.github.com'
const MAX_RELEASE_PAGES = 50

/** Names of the files to publish, sorted; throws when there is nothing. */
export async function collectAssets(dir) {
  const names = (await readdir(dir)).filter((name) => ASSET_RE.test(name)).sort()
  if (names.length === 0) throw new Error(`no release artifacts found in ${dir}`)
  return names
}

/** Same size, and the same sha256 when GitHub reports one. */
function assetMatches(asset, bytes) {
  if (asset.size !== bytes.length) return false
  return !asset.digest || asset.digest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export async function publishRelease({ dir, repo, tag, token, fetchImpl = fetch }) {
  const names = await collectAssets(dir)
  // One installer at a time: the release is several hundred MB in total.
  const load = (name) => readFile(path.join(dir, name))

  const call = async (method, url, { body, headers = {}, ok = [200, 201, 204] } = {}) => {
    const res = await fetchImpl(url, {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...headers },
      signal: AbortSignal.timeout(15 * 60_000),
    })
    if (!ok.includes(res.status)) throw new Error(`${method} ${new URL(url).pathname} -> HTTP ${res.status}`)
    return res
  }
  const json = (obj) => ({ body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } })

  // GitHub would create a missing tag at the default branch's HEAD, i.e. on the
  // wrong commit. The tag is pushed by GitLab's `mirror-release` job before this
  // workflow can even start, so a 404 here means something else is wrong.
  await call('GET', `${API}/repos/${repo}/git/ref/tags/${tag}`)

  // GET /releases/tags/{tag} returns PUBLISHED releases only. A published release is
  // never modified: a retry after a lost PATCH response must not delete and
  // re-upload assets users can already download. It either matches what we hold
  // (nothing to do) or we refuse.
  const published = await call('GET', `${API}/repos/${repo}/releases/tags/${tag}`, { ok: [200, 404] })
  if (published.status === 200) {
    const release = await published.json()
    if (!release.draft) {
      const problems = []
      for (const name of names) {
        const asset = (release.assets ?? []).find((a) => a.name === name)
        if (!asset) problems.push(`${name} (missing)`)
        else if (!assetMatches(asset, await load(name))) problems.push(`${name} (differs)`)
      }
      if (problems.length > 0) {
        throw new Error(`release ${tag} is already published and does not match the build: ${problems.join(', ')}; refusing to modify a published release`)
      }
      return names
    }
  }

  // Drafts are not returned by the endpoint above, so look for one a failed run left
  // behind, page by page (a page is at most 100 releases, newest first).
  let release = null
  let exhausted = false
  for (let page = 1; release === null && !exhausted; page++) {
    if (page > MAX_RELEASE_PAGES) {
      // Not finding a draft in the pages we looked at does not mean there is none.
      throw new Error(`searched ${MAX_RELEASE_PAGES} pages of releases without reaching the end; refusing to create a release that may already exist`)
    }
    const list = await (await call('GET', `${API}/repos/${repo}/releases?per_page=100&page=${page}`)).json()
    release = list.find((r) => r.tag_name === tag && r.draft) ?? null
    exhausted = list.length < 100
  }
  if (!release) {
    // Draft until every asset is up, so nobody downloads half a release.
    const created = await call('POST', `${API}/repos/${repo}/releases`, json({ tag_name: tag, name: tag, draft: true, generate_release_notes: true }))
    release = await created.json()
  }

  // Only what this build produced may be published: a reused draft can hold files
  // someone attached by hand. The GitLab copy also refuses a release whose asset
  // set differs from the run's artifacts, so a stray file would block the registry.
  for (const asset of (release.assets ?? []).filter((a) => !names.includes(a.name))) {
    await call('DELETE', `${API}/repos/${repo}/releases/assets/${asset.id}`)
  }
  const uploadBase = release.upload_url.replace(/\{.*$/, '')
  for (const name of names) {
    const bytes = await load(name)
    const stale = (release.assets ?? []).find((asset) => asset.name === name)
    if (stale) await call('DELETE', `${API}/repos/${repo}/releases/assets/${stale.id}`)
    await call('POST', `${uploadBase}?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    })
  }
  await call('PATCH', `${API}/repos/${repo}/releases/${release.id}`, json({ draft: false, prerelease: false }))
  return names
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, RELEASE_TAG: tag } = process.env
  if (!token || !repo || !RELEASE_TAG_RE.test(tag ?? '')) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and a vX.Y.Z RELEASE_TAG are required')
  }
  const names = await publishRelease({ dir: 'dist', repo, tag, token })
  process.stdout.write(`Published ${names.length} asset(s) to GitHub release ${tag}: ${names.join(', ')}\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  })
}
