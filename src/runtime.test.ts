import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceRuntime } from './runtime.ts'
import type { PresenceState } from './presence-controller.ts'

const STATE: PresenceState = {
  projectName: 'orca',
  agentType: 'claude',
  runningAgentCount: 1,
  agentActive: true,
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
    assert.deepEqual(h.applied, ['Claude|orca · Working'])
  })

  it('reports the state it is in', async () => {
    const h = runtime()
    await h.instance.start()
    const status = h.instance.getStatus()
    assert.equal(status.discordConnected, true)
    assert.equal(status.orcaRunning, true)
    assert.equal(status.lastActivity?.details, 'Claude')
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
    assert.deepEqual(h.applied, ['Claude|orca · Working'])
    await h.instance.pause()
    assert.equal(h.cleared(), 1)
    await h.instance.start()
    assert.deepEqual(h.applied, ['Claude|orca · Working', 'Claude|orca · Working'])
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
})
