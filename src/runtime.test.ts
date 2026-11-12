import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceRuntime } from './runtime.ts'
import type { PresenceState } from './presence-controller.ts'
import type { PresenceActivity } from './presence.ts'
import { readPresenceState } from './orca-reader.ts'

it('publishes an empty Orca session while open and clears only when the process closes', async () => {
  const now = Date.UTC(2026, 10, 8)
  mock.timers.enable({ apis: ['Date'], now })
  let running = true
  let reads = 0
  let clears = 0
  const sent: PresenceActivity[] = []
  const logs: string[] = []
  const instance = createPresenceRuntime({
    clientId: '1', pollMs: 15000, useUploadedArt: false,
    log: line => logs.push(line),
    deps: {
      isOrcaRunning: async () => running,
      readState: async () => {
        reads += 1
        return readPresenceState(async () => '{"ok":true,"result":{"worktrees":[]}}')
      },
      apply: async activity => { sent.push(activity); return true },
      clear: async () => { clears += 1; return true },
      schedule: () => () => {}
    }
  })
  try {
    await instance.start()
    await instance.start()
    assert.deepEqual(sent, [{ details: '', state: '', startTimestamp: new Date(now) }])
    assert.equal(logs.find(line => line.startsWith('pushed:')), 'pushed:  | ')
    assert.equal(clears, 0)
    assert.equal(instance.getStatus().orcaRunning, true)
    const beforeClosing = reads
    mock.timers.tick(60000)
    running = false
    await instance.start()
    assert.equal(clears, 1)
    assert.equal(reads, beforeClosing)
    assert.equal(instance.getStatus().orcaRunning, false)
    running = true
    await instance.start()
    assert.deepEqual(sent, [
      { details: '', state: '', startTimestamp: new Date(now) },
      { details: '', state: '', startTimestamp: new Date(now + 60000) }
    ])
  } finally {
    await instance.stop()
    mock.timers.reset()
  }
})

const STATE: PresenceState = {
  projectName: 'orca',
  agentType: 'claude',
  runningAgentCount: 1, activeWorkspaceCount: 1,
  branchName: 'main',
}

function runtime(initial = { orca: true, fail: false }) {
  let orca = initial.orca
  let fail = initial.fail
  const applied: string[] = []
  let cleared = 0
  let tick: (() => Promise<void>) | null = null
  const logs: string[] = []

  const instance = createPresenceRuntime({
    clientId: '1556649058657902712',
    pollMs: 15_000,
    useUploadedArt: false,
    log: (line) => logs.push(line),
    deps: {
      isOrcaRunning: async () => orca,
      readState: async () => STATE,
      apply: async (activity) => {
        if (fail) {
          return false
        }
        applied.push(`${activity.details}|${activity.state}`)
        return true
      },
      clear: async () => {
        cleared += 1
        return true
      },
      // Why injected: the real timer would make every test wait a poll interval.
      schedule: (fn) => {
        tick = fn
        return () => {
          tick = null
        }
      }
    }
  })

  return {
    instance,
    logs,
    applied,
    cleared: () => cleared,
    ticks: async () => {
      await tick?.()
    },
    setOrca: (next: boolean) => {
      orca = next
    },
    failApply: (next: boolean) => {
      fail = next
    }
  }
}

describe('createPresenceRuntime', () => {
  it('pushes an activity for the active worktree once started', async () => {
    const h = runtime()
    await h.instance.start()
    assert.deepEqual(h.applied, ['Claude · 1 agent working|📁 orca · 1 active workspace'])
  })

  it('reports the state it is in', async () => {
    const h = runtime()
    await h.instance.start()
    const status = h.instance.getStatus()
    assert.equal(status.discordConnected, true)
    assert.equal(status.orcaRunning, true)
    assert.equal(status.lastActivity?.details, 'Claude · 1 agent working')
  })

  it('clears the activity when Orca closes', async () => {
    const h = runtime()
    await h.instance.start()
    h.setOrca(false)
    await h.ticks()
    assert.equal(h.cleared(), 1)
    assert.equal(h.instance.getStatus().orcaRunning, false)
  })

  it('stops pushing after stop', async () => {
    const h = runtime()
    await h.instance.start()
    await h.instance.stop()
    await h.ticks()
    assert.equal(h.applied.length, 1)
  })

  it('records a failed push as an error without throwing', async () => {
    const h = runtime({ orca: true, fail: true })
    await h.instance.start()
    assert.ok(h.instance.getStatus().lastError !== null)
    assert.equal(h.applied.length, 0)
  })

  it('clears the error once a push succeeds', async () => {
    const h = runtime({ orca: true, fail: true })
    await h.instance.start()
    assert.ok(h.instance.getStatus().lastError !== null)
    h.failApply(false)
    await h.ticks()
    assert.equal(h.instance.getStatus().lastError, null)
  })

  it('notifies subscribers with the new status', async () => {
    const h = runtime()
    const seen: boolean[] = []
    h.instance.subscribe((status) => seen.push(status.discordConnected))
    await h.instance.start()
    assert.ok(seen.includes(true))
  })

  it('keeps polling through a state read that throws', async () => {
    let throws = true
    const applied: string[] = []
    const instance = createPresenceRuntime({
      clientId: '1',
      pollMs: 15_000,
      useUploadedArt: false,
      deps: {
        isOrcaRunning: async () => true,
        readState: async () => {
          if (throws) {
            throw new Error('orca CLI missing')
          }
          return STATE
        },
        apply: async (activity) => {
          applied.push(activity.details)
          return true
        },
        clear: async () => true,
        schedule: () => () => {}
      }
    })
    await instance.start()
    throws = false
    await instance.start()
    assert.ok(applied.length >= 1)
  })

  it('logs what it pushed, so a wrong payload is diagnosable', async () => {
    const h = runtime()
    await h.instance.start()
    assert.ok(
      h.logs.some((line) => line.includes('pushed') && line.includes('Claude')),
      `expected a pushed line, got: ${JSON.stringify(h.logs)}`
    )
    assert.ok(h.logs.some(line => line.includes(' | art=https://')))
  })

  it('pauses without tearing the transport down', async () => {
    const h = runtime()
    await h.instance.start()
    await h.instance.pause()
    await h.ticks()
    assert.equal(h.applied.length, 1)
    assert.equal(h.instance.getStatus().paused, true)
  })

  it('re-pushes after a pause and resume, so the profile is not left blank', async () => {
    // Why this is the important case: pause() clears the activity, so resuming must send it
    // again even though the state is unchanged. Without this the menu reads "Claude" while
    // Discord shows nothing.
    const h = runtime()
    await h.instance.start()
    assert.deepEqual(h.applied, ['Claude · 1 agent working|📁 orca · 1 active workspace'])
    await h.instance.pause()
    assert.equal(h.cleared(), 1)
    await h.instance.start()
    assert.deepEqual(h.applied, ['Claude · 1 agent working|📁 orca · 1 active workspace', 'Claude · 1 agent working|📁 orca · 1 active workspace'])
  })

  it('re-pushes after a stop and start', async () => {
    const h = runtime()
    await h.instance.start()
    await h.instance.stop()
    await h.instance.start()
    assert.equal(h.applied.length, 2)
  })

  it('re-pushes when the Discord connection generation advances', async () => {
    // Why: Discord restarting drops the activity it was showing; the same state must be
    // sent again rather than deduped away.
    let generation = 0
    const applied: string[] = []
    // Why a no-op default: the real tick is assigned by the injected scheduler below, which
    // the type checker cannot track across the callback boundary.
    let tick: () => Promise<void> = async () => {}
    const instance = createPresenceRuntime({
      clientId: '1',
      pollMs: 15_000,
      useUploadedArt: false,
      deps: {
        isOrcaRunning: async () => true,
        readState: async () => STATE,
        apply: async (activity) => {
          applied.push(activity.details)
          return true
        },
        clear: async () => true,
        connectionGeneration: () => generation,
        schedule: (fn) => {
          tick = fn
          return () => {
            tick = async () => {}
          }
        }
      }
    })
    await instance.start()
    assert.equal(applied.length, 1)
    generation = 1
    await tick?.()
    assert.equal(applied.length, 2)
  })

  it('resumes after a pause', async () => {
    const h = runtime()
    await h.instance.start()
    await h.instance.pause()
    h.setOrca(false)
    await h.instance.start()
    assert.equal(h.instance.getStatus().paused, false)
  })

  it('publishes global background changes through the headless runtime', async () => {
    let background = 1
    const sent: PresenceActivity[] = []
    const instance = createPresenceRuntime({
      clientId: '1', pollMs: 15000, useUploadedArt: false,
      deps: {
        isOrcaRunning: async () => true,
        readState: () => readPresenceState(
          async () => JSON.stringify({ ok: true, result: { worktrees: [
            { isActive: true, path: '/selected', agents: [{ agentType: 'codex', state: 'done' }] },
            { isActive: false, agents: Array.from({ length: background },
              () => ({ agentType: 'omp', state: 'working' })) }
          ] } }),
          undefined,
          () => 'selected-model'
        ),
        apply: async activity => { sent.push(activity); return true },
        clear: async () => true,
        schedule: () => () => {}
      }
    })
    try {
      await instance.start()
      background = 2
      await instance.start()
      assert.deepEqual(sent.map(activity => activity.details), [
        'Codex · 1 agent working', 'Codex · 2 agents working'
      ])
      assert.equal(sent[1]?.state, '📁 selected · 1 active workspace')
      assert.equal(sent[1]?.largeImageText, 'selected-model')
      assert.equal(sent[1]?.startTimestamp, sent[0]?.startTimestamp)
    } finally {
      await instance.stop()
    }
  })
})
