/**
 * Tests for scripts/publish-github-release.mjs against an in-memory GitHub.
 * Run: node --test scripts/publish-github-release.test.mjs (or npm run test:scripts).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { collectAssets, publishRelease } from './publish-github-release.mjs'

async function distWith(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dist-'))
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content)
  return dir
}

/**
 * A small stateful GitHub: releases (drafts included), asset upload/delete, the
 * published-only tag endpoint, 100-per-page listing. `fail(method, path)` can
 * inject an HTTP status for one request.
 */
function fakeGitHub({ tagExists = true, releases = [], fail = () => null } = {}) {
  const calls = []
  let nextId = 100
  const byId = (id) => releases.find((r) => String(r.id) === String(id))
  const fetchImpl = async (url, init) => {
    const u = new URL(url)
    const route = `${init.method} ${u.pathname}`
    calls.push({ method: init.method, url, headers: init.headers, body: init.body, route })
    const injected = fail(init.method, u.pathname)
    if (injected) return { status: injected }
    const json = (status, body) => ({ status, json: async () => body })
    let m
    if (init.method === 'GET' && /\/git\/ref\/tags\//.test(route)) return json(tagExists ? 200 : 404, {})
    if (init.method === 'GET' && (m = /\/releases\/tags\/(.+)$/.exec(route))) {
      const hit = releases.find((r) => r.tag_name === m[1] && !r.draft)
      return hit ? json(200, hit) : json(404, {})
    }
    if (init.method === 'GET' && u.pathname.endsWith('/releases')) {
      const page = Number(u.searchParams.get('page') ?? 1)
      return json(200, releases.slice((page - 1) * 100, page * 100))
    }
    if (init.method === 'POST' && u.pathname.endsWith('/releases')) {
      const r = { id: nextId++, ...JSON.parse(init.body), assets: [], upload_url: `https://uploads.example/up/{?name}` }
      releases.unshift(r)
      return json(201, r)
    }
    if (init.method === 'POST' && u.hostname === 'uploads.example') {
      const rel = releases.find((r) => r.draft) ?? releases[0]
      rel.assets.push({ id: nextId++, name: u.searchParams.get('name'), size: init.body.length })
      return json(201, {})
    }
    if (init.method === 'DELETE') {
      const id = u.pathname.split('/').at(-1)
      for (const r of releases) r.assets = r.assets.filter((a) => String(a.id) !== id)
      return json(204, {})
    }
    if (init.method === 'PATCH' && (m = /\/releases\/(\d+)$/.exec(route))) {
      Object.assign(byId(m[1]), JSON.parse(init.body))
      return json(200, {})
    }
    throw new Error(`unexpected request ${route}`)
  }
  return { calls, releases, fetchImpl }
}

const base = { repo: 'o/r', tag: 'v1.27.0', token: 'SECRET-TOKEN' }
const draft = (over = {}) => ({ id: 3, tag_name: 'v1.27.0', draft: true, assets: [], upload_url: 'https://uploads.example/up/{?name}', ...over })
const others = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, tag_name: `v0.0.${i}`, draft: false, assets: [] }))

describe('publishRelease', () => {
  test('creates a draft, uploads every asset, then publishes — in that order', async () => {
    const dir = await distWith({ 'a.AppImage': 'x', 'a-setup.exe': 'x', 'a.dmg': 'x', 'latest.yml': 'x', 'notes.txt': 'x' })
    const gh = fakeGitHub()
    const names = await publishRelease({ ...base, dir, fetchImpl: gh.fetchImpl })
    assert.deepEqual(names, ['a-setup.exe', 'a.AppImage', 'a.dmg', 'latest.yml'])
    const routes = gh.calls.map((c) => c.route)
    assert.match(routes[0], /^GET .*\/git\/ref\/tags\/v1\.27\.0$/)
    assert.deepEqual(JSON.parse(gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases')).body).draft, true)
    assert.equal(routes.filter((r) => r.startsWith('POST /up')).length, 4)
    assert.match(routes.at(-1), /^PATCH .*\/releases\/\d+$/)
    assert.equal(JSON.parse(gh.calls.at(-1).body).draft, false)
  })

  test('an unsigned Windows installer is published like any other asset — no signing gate in this script', async () => {
    const gh = fakeGitHub()
    const names = await publishRelease({ ...base, dir: await distWith({ 'a-setup.exe': 'MZ-not-signed', 'latest.yml': 'x' }), fetchImpl: gh.fetchImpl })
    assert.deepEqual(names, ['a-setup.exe', 'latest.yml'])
    assert.equal(gh.releases[0].draft, false)
  })

  test('refuses when the tag was never mirrored, instead of letting GitHub tag the default branch', async () => {
    const gh = fakeGitHub({ tagExists: false })
    await assert.rejects(publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl }), /HTTP 404/)
    assert.ok(!gh.calls.some((c) => c.method === 'POST'))
  })

  test('replaces an asset a failed run left in a draft', async () => {
    const gh = fakeGitHub({ releases: [draft({ assets: [{ id: 55, name: 'a.deb', size: 1 }] })] })
    await publishRelease({ ...base, dir: await distWith({ 'a.deb': 'xyz' }), fetchImpl: gh.fetchImpl })
    const routes = gh.calls.map((c) => c.route)
    assert.ok(routes.indexOf('DELETE /repos/o/r/releases/assets/55') < routes.findIndex((r) => r.startsWith('POST /up')))
    assert.equal(gh.releases[0].draft, false)
  })

  test('an asset in a reused draft that this build did not produce is removed before publishing', async () => {
    const gh = fakeGitHub({ releases: [draft({ assets: [{ id: 77, name: 'hand-attached-unsigned.exe', size: 1 }] })] })
    await publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl })
    assert.ok(gh.calls.some((c) => c.route === 'DELETE /repos/o/r/releases/assets/77'))
    assert.deepEqual(gh.releases[0].assets.map((a) => a.name), ['a.deb'])
  })

  test('finds a leftover draft on the second page of releases and reuses it', async () => {
    const gh = fakeGitHub({ releases: [...others(100), draft()] })
    await publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl })
    assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.url.endsWith('/releases')))
    assert.ok(gh.calls.some((c) => c.url.includes('page=2')))
    assert.equal(gh.releases.find((r) => r.id === 3).draft, false)
  })

  test('refuses, without any write, when the release list is longer than the search limit', async () => {
    const gh = fakeGitHub({ releases: others(100 * 50) })
    await assert.rejects(publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl }), /refusing to create a release that may already exist/)
    assert.deepEqual(gh.calls.map((c) => c.method).filter((m) => m !== 'GET'), [])
    assert.equal(gh.calls.filter((c) => c.url.includes('per_page=100')).length, 50)
  })

  test('a published release that matches is left alone — a retry after a lost PATCH response changes nothing', async () => {
    const dir = await distWith({ 'a.deb': 'xyz' })
    const releases = [draft()]
    // First attempt: GitHub applies the PATCH, the response never arrives.
    const first = fakeGitHub({ releases })
    const lossy = async (url, init) => {
      const res = await first.fetchImpl(url, init)
      return init.method === 'PATCH' ? { status: 502 } : res
    }
    await assert.rejects(publishRelease({ ...base, dir, fetchImpl: lossy }), /HTTP 502/)
    assert.equal(releases[0].draft, false)
    const retry = fakeGitHub({ releases })
    await publishRelease({ ...base, dir, fetchImpl: retry.fetchImpl })
    assert.deepEqual(retry.calls.map((c) => c.method).filter((m) => m !== 'GET'), [])
  })

  test('a published release that differs is refused and never modified', async () => {
    const published = { id: 9, tag_name: 'v1.27.0', draft: false, assets: [{ id: 1, name: 'a.deb', size: 999 }] }
    const gh = fakeGitHub({ releases: [published] })
    await assert.rejects(publishRelease({ ...base, dir: await distWith({ 'a.deb': 'xyz', 'b.rpm': 'x' }), fetchImpl: gh.fetchImpl }), /already published.*a\.deb \(differs\), b\.rpm \(missing\).*refusing/)
    assert.deepEqual(gh.calls.map((c) => c.method).filter((m) => m !== 'GET'), [])
  })

  test('when GitHub reports a digest it must match too', async () => {
    const published = { id: 9, tag_name: 'v1.27.0', draft: false, assets: [{ id: 1, name: 'a.deb', size: 3, digest: 'sha256:' + '0'.repeat(64) }] }
    const gh = fakeGitHub({ releases: [published] })
    await assert.rejects(publishRelease({ ...base, dir: await distWith({ 'a.deb': 'xyz' }), fetchImpl: gh.fetchImpl }), /a\.deb \(differs\)/)
  })

  test('the token travels only in the Authorization header, never in a URL', async () => {
    const gh = fakeGitHub()
    await publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl })
    for (const call of gh.calls) {
      assert.ok(!call.url.includes('SECRET-TOKEN'))
      assert.equal(call.headers.Authorization, 'Bearer SECRET-TOKEN')
    }
  })

  test('a failing upload surfaces the status and path, not the token', async () => {
    const gh = fakeGitHub({ fail: (m, p) => (m === 'POST' && p.startsWith('/up') ? 500 : null) })
    await assert.rejects(publishRelease({ ...base, dir: await distWith({ 'a.deb': 'x' }), fetchImpl: gh.fetchImpl }), (err) => /HTTP 500/.test(err.message) && !err.message.includes('SECRET-TOKEN'))
  })
})

test('collectAssets keeps installers and feeds only, and fails on an empty dist', async () => {
  assert.deepEqual(await collectAssets(await distWith({ 'a.rpm': '', 'latest-linux.yml': '', 'builder-debug.yml': '', 'x.blockmap': '' })), ['a.rpm', 'latest-linux.yml'])
  await assert.rejects(collectAssets(await distWith({})), /no release artifacts/)
})

test('collectAssets does not publish a macOS zip (it arrives together with signing, BACKLOG §2.285)', async () => {
  assert.deepEqual(await collectAssets(await distWith({ 'a.dmg': '', 'a.zip': '', 'latest-mac.yml': '' })), ['a.dmg', 'latest-mac.yml'])
})

test('the CLI refuses without a token, a repository and a vX.Y.Z tag — before reading dist or calling GitHub', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish-github-release.mjs')
  for (const env of [
    { GITHUB_REPOSITORY: 'o/r', RELEASE_TAG: 'v1.0.0' },
    { GITHUB_TOKEN: 't', RELEASE_TAG: 'v1.0.0' },
    { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', RELEASE_TAG: 'v1.0.0-nightly.1' },
    { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
  ]) {
    const res = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
    assert.equal(res.status, 1, JSON.stringify(env))
    assert.match(res.stderr, /RELEASE_TAG are required/)
  }
})
