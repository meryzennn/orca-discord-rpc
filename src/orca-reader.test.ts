import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pluginCliEnv, readPresenceState, runOrcaWorktreePs } from './orca-reader.ts'

it('fills only the missing Windows plugin APPDATA known folder without mutating input', () => {
  const env = Object.freeze({ PATH: 'worker-path', ELECTRON_RUN_AS_NODE: '0' })
  assert.deepEqual(pluginCliEnv(env, 'win32', 'C:\\Users\\worker'), {
    PATH: 'worker-path', ELECTRON_RUN_AS_NODE: '1', APPDATA: 'C:\\Users\\worker\\AppData\\Roaming'
  })
  assert.deepEqual(env, { PATH: 'worker-path', ELECTRON_RUN_AS_NODE: '0' })
})

it('preserves supplied APPDATA and POSIX plugin environments', () => {
  const supplied = Object.freeze({ APPDATA: 'D:/custom/roaming', OTHER: 'preserved' })
  assert.deepEqual(pluginCliEnv(supplied, 'win32', 'C:\\Users\\worker'), {
    APPDATA: 'D:/custom/roaming', OTHER: 'preserved', ELECTRON_RUN_AS_NODE: '1'
  })
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(pluginCliEnv({ HOME: '/users/worker' }, platform, '/users/worker'), {
      HOME: '/users/worker', ELECTRON_RUN_AS_NODE: '1'
    })
    assert.deepEqual(pluginCliEnv(supplied, platform, '/users/worker'), {
      APPDATA: 'D:/custom/roaming', OTHER: 'preserved', ELECTRON_RUN_AS_NODE: '1'
    })
  }
})

it('uses the injected snapshot through the existing workspace rules', async () => {
  // Prevent the pre-fix reader from invoking a live Orca installation.
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    callback(null, JSON.stringify({ ok: true, result: { worktrees: [] } }), '')
  })
  syncBuiltinESMExports()
  try {
    let calls = 0
    const state = await readPresenceState(async () => {
      calls += 1
      return JSON.stringify({
        ok: true,
        result: { worktrees: [{
          isActive: true,
          displayName: 'main',
          path: 'C:/example/sample',
          branch: 'refs/heads/main',
          agents: [{ agentType: 'omp', state: 'working', stateStartedAt: 1760000000000 }]
        }] }
      })
    })
    assert.equal(calls, 1)
    assert.equal(state?.projectName, 'sample')
    assert.equal(state?.agentType, 'omp')
    assert.equal(state?.branchName, 'main')
    assert.equal(stub.mock.callCount(), 0)
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

it('keeps standalone executable argv and forwards child failures', async () => {
  const calls: unknown[][] = []
  const failure = new Error('child failed')
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    calls.push(args)
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    callback(calls.length === 3 ? failure : null, 'snapshot', '')
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await runOrcaWorktreePs(), 'snapshot')
    assert.equal(await runOrcaWorktreePs('custom cli'), 'snapshot')
    await assert.rejects(runOrcaWorktreePs('broken cli'), error => error === failure)
    assert.equal(calls[0]?.[0], process.platform === 'win32' ? 'orca.exe' : 'orca')
    assert.equal(calls[1]?.[0], 'custom cli')
    assert.deepEqual(calls[1]?.[1], ['worktree', 'ps', '--json'])
    assert.deepEqual(calls[1]?.[2], {
      timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      signal: undefined, env: process.env
    })
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

it('adds structured CLI failure and stderr diagnostics without replacing the child error', async () => {
  const failure = Object.assign(new Error('Command failed'), { code: 1, signal: 'SIGTERM' })
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    callback(failure, JSON.stringify({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.' }
    }), 'runtime discovery failed\n')
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(runOrcaWorktreePs('missing runtime'), error => {
      assert.equal(error, failure)
      assert.equal(failure.code, 1)
      assert.equal(failure.signal, 'SIGTERM')
      assert.equal(failure.message, 'Command failed\nAPPDATA is not set, so the Orca runtime metadata path cannot be resolved.\nruntime discovery failed')
      return true
    })
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

it('does not include worktree payloads or malformed stdout in child failure diagnostics', async () => {
  const outputs = [
    JSON.stringify({ ok: true, result: { worktrees: [{ path: 'secret-project' }] } }),
    'not JSON: secret-project',
    JSON.stringify({ ok: false, error: { message: { path: 'secret-project' } } })
  ]
  const failures: Error[] = []
  const stub = mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const failure = new Error('Command failed\nexisting stderr')
    failures.push(failure)
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    callback(failure, outputs.shift()!, 'existing stderr\n')
  })
  syncBuiltinESMExports()
  try {
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(runOrcaWorktreePs('failing CLI'), error => {
        assert.equal(error, failures[index])
        assert.equal(failures[index]?.message, 'Command failed\nexisting stderr')
        return true
      })
    }
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

it('runs a Node entry with literal argv and Electron Node mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-reader-'))
  try {
    const entry = join(directory, 'cli & literal entry.cjs')
    await writeFile(entry, 'console.log(JSON.stringify({ argv: process.argv.slice(2), nodeMode: process.env.ELECTRON_RUN_AS_NODE }))')
    assert.deepEqual(JSON.parse(await runOrcaWorktreePs(process.execPath, entry)), {
      argv: ['worktree', 'ps', '--json'], nodeMode: '1'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('aborts an outstanding CLI child and rejects with AbortError', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-reader-'))
  const controller = new AbortController()
  try {
    const entry = join(directory, 'waiting.cjs')
    const ready = join(directory, 'pid')
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const running = runOrcaWorktreePs(process.execPath, entry, controller.signal)
    const rejected = assert.rejects(running, { name: 'AbortError', code: 'ABORT_ERR' })
    let pid = 0
    for (let attempt = 0; attempt < 500 && !pid; attempt += 1) {
      pid = Number(await readFile(ready, 'utf8').catch(() => ''))
      if (!pid) await setTimeout(10)
    }
    assert.ok(pid > 0, 'child must start before cancellation')
    controller.abort()
    await rejected
    let alive = true
    for (let attempt = 0; attempt < 500 && alive; attempt += 1) {
      try { process.kill(pid, 0) } catch { alive = false }
      if (alive) await setTimeout(10)
    }
    assert.equal(alive, false, 'aborted CLI child must exit')
  } finally {
    controller.abort()
    await rm(directory, { recursive: true, force: true })
  }
})
