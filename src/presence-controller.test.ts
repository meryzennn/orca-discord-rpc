import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceController, type PresenceState } from './presence-controller.ts'
import { buildPluginActivity } from './plugin-presence.ts'
import type { PresenceActivity } from './presence.ts'

const T0 = new Date('2026-10-05T00:00:00.000Z')
const T1 = new Date('2026-10-05T00:01:00.000Z')

function harness(initialState: PresenceState | null) {
  const applied: PresenceActivity[] = []
  let cleared = 0
  let state = initialState
  let now = T0
  let epoch = 0
  const controller = createPresenceController({
    readState: async () => state,
    apply: async (activity) => {
      applied.push(activity)
      return true
    },
    clear: async () => {
      cleared += 1
      return true
    },
    connectionEpoch: () => epoch,
    now: () => now
  })
  return {
    controller,
    applied,
    cleared: () => cleared,
    setState: (next: PresenceState | null) => {
      state = next
    },
    setNow: (next: Date) => {
      now = next
    },
    bumpEpoch: () => {
      epoch += 1
    }
  }
}

const RUNNING: PresenceState = {
  projectName: 'orca',
  agentType: 'claude',
  runningAgentCount: 1,
  agentActive: true,
  branchName: 'main',
}

it('uses the injected tray builder and republishes origin edits without resetting the timer', async () => {
  const applied: PresenceActivity[] = []
  let state = { ...RUNNING, repoUrl: 'https://github.com/owner/first' }
  let now = T0
  const controller = createPresenceController({
    readState: async () => state, buildActivity: buildPluginActivity,
    apply: async activity => { applied.push(activity); return true },
    clear: async () => true, now: () => now
  })
  await controller.poll()
  await controller.poll()
  now = T1
  state = { ...state, repoUrl: 'https://github.com/owner/second' }
  await controller.poll()
  assert.equal(applied.length, 2)
  assert.equal(applied[0]?.details, 'Claude · Working')
  assert.equal(applied[1]?.state, '📁 orca')
  assert.deepEqual(applied[1]?.buttons, [{ label: 'View Repository', url: 'https://github.com/owner/second' }])
  assert.equal(applied[1]?.startTimestamp, T0)
})

describe('createPresenceController', () => {
  it('can republish an unchanged activity with its original clock while ordinary reset starts a new session', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setNow(T1)
    h.controller.reset(true)
    await h.controller.poll()
    assert.equal(h.applied.length, 2)
    assert.equal(h.applied[1]?.startTimestamp, T0)
    h.controller.reset()
    await h.controller.poll()
    assert.equal(h.applied[2]?.startTimestamp, T1)
  })
  it('applies the first reading', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    assert.equal(h.applied.length, 1)
    assert.equal(h.applied[0]?.details, 'Claude · Working')
  })

  it('does not re-apply an unchanged reading', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    await h.controller.poll()
    await h.controller.poll()
    assert.equal(h.applied.length, 1)
  })

  it('applies when a second agent starts', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setState({ ...RUNNING, runningAgentCount: 2 })
    await h.controller.poll()
    assert.equal(h.applied.length, 2)
    assert.equal(h.applied[1]?.details, 'Claude +1 · Working')
  })

  it('applies when a different agent takes over', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setState({ ...RUNNING, agentType: 'codex' })
    await h.controller.poll()
    assert.equal(h.applied[1]?.details, 'Codex · Working')
  })

  it('applies when the model changes', async () => {
    // Why: switching models with /model changes what the profile names.
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setState({ ...RUNNING, model: 'Claude Opus 5.5' })
    await h.controller.poll()
    assert.equal(h.applied.length, 2)
  })

  it('keeps the timer when the project changes', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setNow(T1)
    h.setState({ ...RUNNING, projectName: 'other-repo' })
    await h.controller.poll()
    assert.equal(h.applied[0]?.startTimestamp, T0)
    assert.equal(h.applied[1]?.startTimestamp, T0)
  })

  it('resets the timer after session clears and resumes', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    assert.equal(h.applied[0]?.startTimestamp, T0)

    h.setState(null)
    await h.controller.poll()
    assert.equal(h.cleared(), 1)

    h.setNow(T1)
    h.setState(RUNNING)
    await h.controller.poll()
    assert.equal(h.applied.length, 2)
    assert.equal(h.applied[1]?.startTimestamp, T1)
  })

  it('keeps the timer when only the agent changes', async () => {
    const h = harness(RUNNING)
    await h.controller.poll()
    h.setNow(T1)
    h.setState({ ...RUNNING, agentType: 'codex' })
    await h.controller.poll()
    assert.equal(h.applied[1]?.startTimestamp, T0)
  })

  it('clears when no worktree is active', async () => {
    const h = harness(null)
    await h.controller.poll()
    assert.equal(h.cleared(), 1)
    assert.equal(h.applied.length, 0)
  })

  it('does not clear repeatedly while nothing is active', async () => {
    const h = harness(null)
    await h.controller.poll()
    await h.controller.poll()
    assert.equal(h.cleared(), 1)
  })

  it('survives a reader that throws', async () => {
    let throws = true
    const applied: unknown[] = []
    const controller = createPresenceController({
      readState: async () => {
        if (throws) {
          throw new Error('orca CLI missing')
        }
        return RUNNING
      },
      apply: async (activity) => {
        applied.push(activity)
        return true
      },
      clear: async () => true,
      now: () => T0
    })
    await controller.poll()
    throws = false
    await controller.poll()
    assert.equal(applied.length, 1)
  })

  it('retries while apply keeps failing, so a late Discord still gets it', async () => {
    const applied: unknown[] = []
    let fails = 2
    const controller = createPresenceController({
      readState: async () => RUNNING,
      apply: async (activity) => {
        if (fails > 0) {
          fails -= 1
          return false
        }
        applied.push(activity)
        return true
      },
      clear: async () => true,
      now: () => T0
    })
    await controller.poll()
    await controller.poll()
    await controller.poll()
    assert.equal(applied.length, 1)
  })

  it('re-pushes an unchanged state after the Discord connection is re-established', async () => {
    let calls = 0
    let epoch = 0
    const controller = createPresenceController({
      readState: async () => RUNNING,
      apply: async () => {
        calls += 1
        return true
      },
      clear: async () => true,
      connectionEpoch: () => epoch,
      now: () => T0
    })
    await controller.poll()
    await controller.poll()
    assert.equal(calls, 1)

    // Discord restarted: the same state must be sent again, or the profile stays blank.
    epoch = 1
    await controller.poll()
    await controller.poll()
    assert.equal(calls, 2)
  })
})
