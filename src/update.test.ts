import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { updateInstalledPlugin, updateHeadlessCheckout } from './update.ts'

function fakeCli(stdout: string, fail = false) {
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    assert.equal(args[0], 'Orca & literal.exe')
    assert.deepEqual(args[1], ['cli entry.js', 'plugin', 'update', 'meryzennn.discord-presence', '--json'])
    const options = args[2] as childProcess.ExecFileOptions
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 120000)
    assert.equal(options.maxBuffer, 1024 * 1024)
    assert.equal(options.shell, undefined)
    assert.equal(options.env?.ELECTRON_RUN_AS_NODE, '1')
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(fail ? Object.assign(new Error('private child diagnostic'), { code: 1 }) : null, stdout, '')
  })
  syncBuiltinESMExports()
  return () => { stub.mock.restore(); syncBuiltinESMExports() }
}

it('updates the published plugin through literal CLI arguments and validates each native outcome', async () => {
  for (const status of ['updated', 'up-to-date', 'pinned']) {
    const restore = fakeCli(JSON.stringify({ ok: true, result: {
      pluginKey: 'meryzennn.discord-presence', status, version: '0.3.0'
    } }))
    try {
      assert.deepEqual(await updateInstalledPlugin('Orca & literal.exe', 'cli entry.js'), { status, version: '0.3.0' })
    } finally { restore() }
  }
})

it('explains unsupported Orca, approval and missing-install cases without approving or echoing private diagnostics', async () => {
  for (const [code, message, expected] of [
    ['invalid_argument', 'Unknown command: plugin update meryzennn.discord-presence', /Orca 1\.4\.253/],
    ['approval_required', 'private grant fingerprint', /review.*Settings/i],
    ['approval_stale', 'private grant fingerprint', /review.*Settings/i],
    ['plugin_not_found', 'private path', /Git installation/i],
    ['git_auth_failed', 'private token', /Git authentication/i],
    ['unexpected', 'private diagnostic', /could not confirm/i]
  ] as const) {
    const restore = fakeCli(JSON.stringify({ ok: false, error: { code, message } }), true)
    try {
      await assert.rejects(updateInstalledPlugin('Orca & literal.exe', 'cli entry.js'), error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, expected)
        assert.ok(!error.message.includes('private'))
        return true
      })
    } finally { restore() }
  }
})

it('does not claim success for malformed, mismatched or failed updater responses', async () => {
  for (const [stdout, failed] of [
    ['not json', false], ['null', false],
    [JSON.stringify({ ok: true, result: { pluginKey: 'other.plugin', status: 'updated', version: '1.0.0' } }), false],
    [JSON.stringify({ ok: true, result: { pluginKey: 'meryzennn.discord-presence', status: 'unknown', version: '1.0.0' } }), false],
    [JSON.stringify({ ok: true, result: { pluginKey: 'meryzennn.discord-presence', status: 'updated', version: 'bad\nversion' } }), false],
    [JSON.stringify({ ok: true, result: { pluginKey: 'meryzennn.discord-presence', status: 'updated', version: '1.0.0' } }), true]
  ] as const) {
    const restore = fakeCli(stdout, failed)
    try { await assert.rejects(updateInstalledPlugin('Orca & literal.exe', 'cli entry.js')) }
    finally { restore() }
  }
})

async function checkout() {
  const root = await mkdtemp(join(tmpdir(), 'orca-update-'))
  const remote = join(root, 'upstream'), local = join(root, 'checkout')
  const git = (...args: string[]) => childProcess.execFileSync('git', [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Updater Test', '-c', 'user.email=updater@example.test', ...args
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  await mkdir(remote)
  git('init', '-b', 'main', remote)
  git('-C', remote, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  await writeFile(join(remote, 'value.txt'), 'one')
  git('-C', remote, 'add', 'value.txt')
  git('-C', remote, 'commit', '-m', 'initial')
  git('clone', remote, local)
  git('-C', local, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  return {
    root, remote, local, git,
    advance: async (value = 'two') => {
      await writeFile(join(remote, 'value.txt'), value)
      git('-C', remote, 'commit', '-am', 'next')
    },
    close: () => rm(root, { recursive: true, force: true })
  }
}

it('fast-forwards a clean headless checkout, preserves untracked files and detects a no-op', async () => {
  const h = await checkout()
  try {
    await writeFile(join(h.local, 'personal.txt'), 'keep')
    assert.equal(await updateHeadlessCheckout(h.local), false)
    await h.advance()
    assert.equal(await updateHeadlessCheckout(h.local), true)
    assert.equal(await readFile(join(h.local, 'value.txt'), 'utf8'), 'two')
    assert.equal(await readFile(join(h.local, 'personal.txt'), 'utf8'), 'keep')
    assert.equal(await updateHeadlessCheckout(h.local), false)
  } finally { await h.close() }
})

it('refuses tracked edits and nested source folders before pulling', async () => {
  const h = await checkout()
  try {
    await h.advance()
    await writeFile(join(h.local, 'value.txt'), 'personal edit')
    const head = h.git('-C', h.local, 'rev-parse', 'HEAD')
    await assert.rejects(updateHeadlessCheckout(h.local), /commit or stash/i)
    assert.equal(await readFile(join(h.local, 'value.txt'), 'utf8'), 'personal edit')
    assert.equal(h.git('-C', h.local, 'rev-parse', 'HEAD'), head)
    const nested = join(h.local, 'nested')
    await mkdir(nested)
    await assert.rejects(updateHeadlessCheckout(nested), /repository root/i)
  } finally { await h.close() }
})

it('refuses divergent history without replacing local commits or files', async () => {
  const h = await checkout()
  try {
    await h.advance()
    await writeFile(join(h.local, 'value.txt'), 'local commit')
    h.git('-C', h.local, 'commit', '-am', 'local')
    const head = h.git('-C', h.local, 'rev-parse', 'HEAD')
    await assert.rejects(updateHeadlessCheckout(h.local), /pull --ff-only/i)
    assert.equal(h.git('-C', h.local, 'rev-parse', 'HEAD'), head)
    assert.equal(await readFile(join(h.local, 'value.txt'), 'utf8'), 'local commit')
  } finally { await h.close() }
})

it('restarts only a running headless daemon after a changed update and preserves it on no-op or refusal', async () => {
  const h = await checkout()
  const pidFile = join(h.root, 'test.pid'), versionFile = join(h.root, 'started-version')
  const cli = (...args: string[]) => childProcess.execFileSync(process.execPath, [join(h.local, 'src', 'cli.ts'), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  const waitForVersion = async (expected: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(versionFile, 'utf8').catch(() => '') === expected) return
      await delay(10)
    }
    assert.fail('Test daemon did not start the expected version')
  }
  try {
    const source = fileURLToPath(new URL('.', import.meta.url))
    await cp(source, join(h.remote, 'src'), { recursive: true, filter: path => !path.endsWith('.test.ts') })
    await cp(fileURLToPath(new URL('../config', import.meta.url)), join(h.remote, 'config'), { recursive: true })
    await writeFile(join(h.remote, 'package.json'), '{"type":"module"}')
    await writeFile(join(h.remote, 'src', 'paths.ts'),
      'export const appDirPath = () => ' + JSON.stringify(h.root) + ';\n' +
      'export const pidPath = () => ' + JSON.stringify(pidFile) + ';\n' +
      'export const autostartShimPath = () => "unused";\n')
    await writeFile(join(h.remote, 'src', 'daemon.ts'),
      'import { readFileSync, writeFileSync } from "node:fs";\n' +
      'import { pidPath } from "./paths.ts";\n' +
      'writeFileSync(pidPath(), String(process.pid));\n' +
      'writeFileSync(' + JSON.stringify(versionFile) + ', readFileSync(new URL("../value.txt", import.meta.url)));\n' +
      'setInterval(() => {}, 1000);\n')
    h.git('-C', h.remote, 'add', '.')
    h.git('-C', h.remote, 'commit', '-m', 'test CLI')
    h.git('-C', h.local, 'pull', '--ff-only')
    cli('start')
    await waitForVersion('one')
    const before = await readFile(pidFile, 'utf8')
    await h.advance()
    assert.match(cli('update'), /Updated and restarted/)
    await waitForVersion('two')
    const after = await readFile(pidFile, 'utf8')
    assert.notEqual(after, before)
    assert.equal(cli('update'), 'Already up to date.')
    assert.equal(await readFile(pidFile, 'utf8'), after)
    await writeFile(join(h.local, 'value.txt'), 'personal edit')
    assert.throws(() => cli('update'), /Commit or stash/)
    assert.equal(await readFile(pidFile, 'utf8'), after)
    assert.equal(await readFile(versionFile, 'utf8'), 'two')
  } finally {
    try { cli('stop') } finally { await h.close() }
  }
})
