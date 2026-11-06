import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRepoUrl, readRepoUrl } from './git-remote.ts'
import { readPresenceState } from './orca-reader.ts'
import { buildTrayActivity } from './tray-presence.ts'

it('normalizes Git origins to web URLs and strips credentials, port and suffixes', () => {
  for (const [raw, expected] of [
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    ['ssh://git@gitlab.com:2222/group/sub/repo.git/', 'https://gitlab.com/group/sub/repo'],
    ['https://user:secret@github.com:8443/owner/repo.git/?token=secret#secret', 'https://github.com/owner/repo'],
    ['http://example.com/owner/repo/', 'http://example.com/owner/repo']
  ]) assert.equal(normalizeRepoUrl(raw!), expected)
})

it('rejects local, unsafe and malformed origins without exposing their content', () => {
  for (const raw of ['', 'C:\\local\\repo', '/tmp/repo', '../repo', 'file:///tmp/repo', 'git://github.com/o/r',
    'javascript:alert(1)', 'https:github.com/o/r', 'https://github.com', 'https://github.com/o\\r',
    'https://github.com/o/\nr', 'git@github.com:', 'ssh://git@/owner/repo',
    'https://github.com/o/%zz', 'https://github.com/o/%00repo', 'https://github.com/o/%5Crepo']) {
    assert.equal(normalizeRepoUrl(raw), null, raw)
  }
})

it('reads a local repository with literal paths and observes origin edits without contacting remotes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca git & literal-'))
  try {
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true })
    assert.equal(await readRepoUrl(directory), null)
    execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', 'git@github.com:owner/first.git'], { windowsHide: true })
    assert.equal(await readRepoUrl(directory), 'https://github.com/owner/first')
    execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', 'https://user:secret@gitlab.com/owner/second.git'], { windowsHide: true })
    assert.equal(await readRepoUrl(directory), 'https://gitlab.com/owner/second')
    assert.equal(await readRepoUrl(join(directory, 'missing')), null)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(readRepoUrl(directory, controller.signal), { name: 'AbortError' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('returns null for non-Git directories even when global Git config defines an origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-not-git-'))
  const previous = process.env.GIT_CONFIG_GLOBAL
  try {
    const global = join(directory, 'global-config')
    await writeFile(global, '[remote "origin"]\nurl = https://github.com/unrelated/global.git\n')
    process.env.GIT_CONFIG_GLOBAL = global
    assert.equal(await readRepoUrl(directory), null)
    assert.equal(await readRepoUrl('invalid\0path'), null)
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true })
    execFileSync('git', ['-C', directory, 'config', '--local', 'remote.origin.url', 'git@github.com:owner/local.git'], { windowsHide: true })
    assert.equal(await readRepoUrl(directory), 'https://github.com/owner/local')
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves a normalized repository suffix through the reader and tray builder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-git-suffix-'))
  try {
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true })
    execFileSync('git', ['-C', directory, 'config', '--local', 'remote.origin.url',
      'https://user:secret@example.com:8443/owner/repo.git.git?token=secret#anchor'], { windowsHide: true })
    const state = await readPresenceState(async () => JSON.stringify({ ok: true, result: {
      worktrees: [{ isActive: true, path: directory, agents: [] }]
    } }), readRepoUrl)
    assert.equal(state?.repoUrl, 'https://example.com/owner/repo.git')
    assert.ok(state)
    const activity = buildTrayActivity({ ...state, startedAt: new Date('2026-11-06T00:00:00Z') })
    assert.deepEqual(activity.buttons, [{ label: 'View Repository', url: 'https://example.com/owner/repo.git' }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('bounds the shell-free child and preserves in-flight cancellation while hiding Git errors', async () => {
  let callback!: (error: Error | null, stdout: string) => void
  const signal = new AbortController().signal
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    assert.equal(args[0], 'git')
    assert.deepEqual(args[1], ['-C', 'literal & path', 'config', '--local', '--get', 'remote.origin.url'])
    assert.deepEqual(args[2], { windowsHide: true, timeout: 1500, signal })
    callback = args.at(-1) as typeof callback
  })
  syncBuiltinESMExports()
  try {
    const aborted = readRepoUrl('literal & path', signal)
    assert.equal(typeof callback, 'function')
    callback(Object.assign(new Error('private stderr'), { name: 'AbortError' }), '')
    await assert.rejects(aborted, { name: 'AbortError' })
    const missing = readRepoUrl('literal & path', signal)
    callback(new Error('credential-bearing stderr'), '')
    assert.equal(await missing, null)
  } finally { stub.mock.restore(); syncBuiltinESMExports() }
})
