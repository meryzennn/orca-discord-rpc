import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOrcaGatedStateReader } from './orca-gated-reader.ts'
import type { PresenceState } from './presence-controller.ts'

const STATE: PresenceState = {
  projectName: 'orca',
  agentType: 'claude',
  runningAgentCount: 1,
  agentActive: true,
  branchName: 'main',
}

function harness(orcaRunning: boolean) {
  const transitions: boolean[] = []
  let running = orcaRunning
  let reads = 0
  const reader = createOrcaGatedStateReader({
    isOrcaRunning: async () => running,
    readState: async () => {
      reads += 1
      return STATE
    },
    onTransition: (next) => transitions.push(next)
  })
  return {
    reader,
    transitions,
    reads: () => reads,
    setRunning: (next: boolean) => {
      running = next
    }
  }
}

describe('createOrcaGatedStateReader', () => {
  it('reads the state while Orca is running', async () => {
    const h = harness(true)
    assert.deepEqual(await h.reader.read(), STATE)
    assert.equal(h.reads(), 1)
  })

  it('reports no state while Orca is closed', async () => {
    // Why null and not the last state: a closed Orca must clear the presence, not freeze it.
    const h = harness(false)
    assert.equal(await h.reader.read(), null)
    assert.equal(h.reads(), 0)
  })

  it('announces each transition exactly once', async () => {
    const h = harness(true)
    await h.reader.read()
    await h.reader.read()
    h.setRunning(false)
    await h.reader.read()
    await h.reader.read()
    h.setRunning(true)
    await h.reader.read()
    assert.deepEqual(h.transitions, [true, false, true])
  })

  it('resumes reading once Orca comes back', async () => {
    const h = harness(false)
    assert.equal(await h.reader.read(), null)
    h.setRunning(true)
    assert.deepEqual(await h.reader.read(), STATE)
    assert.equal(h.reads(), 1)
  })

  it('does not read the worktree while Orca is closed', async () => {
    const h = harness(false)
    await h.reader.read()
    await h.reader.read()
    assert.equal(h.reads(), 0)
  })

  it('reports null before the first read', () => {
    const h = harness(true)
    assert.equal(h.reader.isOrcaRunning(), null)
  })

  it('reports the last observed answer', async () => {
    const h = harness(true)
    await h.reader.read()
    assert.equal(h.reader.isOrcaRunning(), true)
    h.setRunning(false)
    await h.reader.read()
    assert.equal(h.reader.isOrcaRunning(), false)
  })
})
