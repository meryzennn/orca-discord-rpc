import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWorktreePs,
  selectActiveWorktree,
  liveAgents,
  allAgents,
  openAgents,
  activityCounts,
  hasActiveAgent,
  featuredAgent,
  projectNameFor
} from './orca-state.ts'

function envelope(worktrees: unknown[]): string {
  return JSON.stringify({ ok: true, result: { worktrees } })
}

describe('activityCounts', () => {
  it('counts working rows and their workspaces globally without an agent allowlist', () => {
    const worktrees = parseWorktreePs(envelope([
      { isActive: true, agents: [
        { agentType: 'codex', state: 'working' },
        { agentType: 'codex', state: 'working' },
        { agentType: 'claude', state: 'done' },
        { agentType: 'omp', state: 'blocked' },
        { agentType: 'omp', state: 'waiting' }
      ] },
      { isActive: false, agents: [{ agentType: 'unregistered-agent', state: 'working' }] },
      { agents: [null, 7, { state: 'working' },
        { agentType: '', state: 'working' }, { agentType: 8, state: 'working' },
        { agentType: 'codex', state: 'done' }, { agentType: 'codex', state: 'WORKING' }] },
      { agents: null }, null
    ]))!
    assert.deepEqual(activityCounts(worktrees), { runningAgentCount: 3, activeWorkspaceCount: 2 })
    assert.deepEqual(activityCounts([]), { runningAgentCount: 0, activeWorkspaceCount: 0 })
  })

  it('does not confuse selected with working, or count idle open agents', () => {
    assert.deepEqual(activityCounts([
      { isActive: true, agents: [{ agentType: 'codex', state: 'done' }] },
      { isActive: false, agents: [{ agentType: 'omp', state: 'working' }] }
    ]), { runningAgentCount: 1, activeWorkspaceCount: 1 })
    assert.deepEqual(activityCounts([
      { isActive: true, agents: [{ agentType: 'codex', state: 'waiting' }] }
    ]), { runningAgentCount: 0, activeWorkspaceCount: 0 })
  })
})

describe('parseWorktreePs', () => {
  it('reads the worktree list out of the CLI envelope', () => {
    const parsed = parseWorktreePs(envelope([{ worktreeId: 'wt-a' }]))
    assert.ok(parsed)
    assert.equal(parsed.length, 1)
  })

  it('distinguishes a valid empty list from an invalid envelope', () => {
    assert.deepEqual(parseWorktreePs(envelope([])), [])
    for (const stdout of [
      'not json', 'null', '[]', '{}',
      JSON.stringify({ ok: false }),
      JSON.stringify({ ok: true, result: null }),
      JSON.stringify({ ok: true, result: { worktrees: {} } })
    ]) {
      assert.equal(parseWorktreePs(stdout), null)
    }
  })
})

describe('selectActiveWorktree', () => {
  it('picks the worktree Orca marks active', () => {
    const parsed = parseWorktreePs(
      envelope([
        { worktreeId: 'a', isActive: false },
        { worktreeId: 'b', isActive: true }
      ])
    )
    assert.ok(parsed)
    assert.equal(selectActiveWorktree(parsed)?.worktreeId, 'b')
  })

  it('returns null when none is active', () => {
    const parsed = parseWorktreePs(envelope([{ worktreeId: 'a' }]))
    assert.ok(parsed)
    assert.equal(selectActiveWorktree(parsed), null)
  })
})

describe('liveAgents', () => {
  const T = 1_760_000_000_000
  const worktree = {
    displayName: 'proj',
    agents: [
      { state: 'done', agentType: 'gemini', stateStartedAt: T + 50 },
      { state: 'working', agentType: 'codex', stateStartedAt: T + 10 },
      { state: 'blocked', agentType: 'claude', stateStartedAt: T + 30 },
      { state: 'waiting', agentType: 'claude', stateStartedAt: T + 40 }
    ]
  }

  it('drops done agents', () => {
    const names = liveAgents(worktree).map((agent) => agent.agentType)
    assert.deepEqual(names, ['codex', 'claude', 'claude'])
  })

  it('counts every live agent, including duplicates', () => {
    assert.equal(liveAgents(worktree).length, 3)
  })

  it('is empty for no worktree', () => {
    assert.deepEqual(liveAgents(null), [])
  })
})

describe('openAgents', () => {
  it('counts an agent that is between turns, because its pane is still open', () => {
    // Why pinned: a done agent was excluded, so a workspace with two open agents whose
    // other one was between turns reported only one agent.
    const worktree = {
      agents: [
        { state: 'done', agentType: 'codex' },
        { state: 'working', agentType: 'claude' }
      ]
    }
    assert.equal(openAgents(worktree).length, 2)
  })

  it('still ignores a row with no agent', () => {
    const worktree = { agents: [{ state: 'done' }, { state: 'working', agentType: 'claude' }] }
    assert.equal(openAgents(worktree).length, 1)
  })

  it('is empty for no worktree', () => {
    assert.deepEqual(openAgents(null), [])
  })
})

describe('featuredAgent', () => {
  const T = 1_760_000_000_000

  it('picks the agent that most recently entered its state', () => {
    const worktree = {
      agents: [
        { state: 'working', agentType: 'codex', stateStartedAt: T + 10 },
        { state: 'working', agentType: 'claude', stateStartedAt: T + 30 }
      ]
    }
    assert.equal(featuredAgent(worktree)?.agentType, 'claude')
  })

  it('prefers a live agent over a newer idle one', () => {
    const worktree = {
      agents: [
        { state: 'working', agentType: 'codex', stateStartedAt: T + 10 },
        { state: 'done', agentType: 'claude', stateStartedAt: T + 99 }
      ]
    }
    assert.equal(featuredAgent(worktree)?.agentType, 'codex')
  })

  it('still returns an idle agent when nothing is live', () => {
    // An agent between turns is still the agent the profile should name; dropping it
    // made the presence fall back to "Using Orca" for most of a session.
    const worktree = {
      agents: [
        { state: 'done', agentType: 'claude', stateStartedAt: T + 10 },
        { state: 'done', agentType: 'codex', stateStartedAt: T + 30 }
      ]
    }
    assert.equal(featuredAgent(worktree)?.agentType, 'codex')
  })

  it('ignores a hydrated row whose stamp is not a real wall clock', () => {
    const worktree = {
      agents: [
        { state: 'working', agentType: 'codex', stateStartedAt: T + 10 },
        { state: 'done', agentType: 'claude', stateStartedAt: 3 }
      ]
    }
    assert.equal(featuredAgent(worktree)?.agentType, 'codex')
  })

  it('returns null when there are no agents at all', () => {
    assert.equal(featuredAgent({ agents: [] }), null)
  })

  it('tolerates a missing stateStartedAt', () => {
    const worktree = { agents: [{ state: 'working', agentType: 'claude' }] }
    assert.equal(featuredAgent(worktree)?.agentType, 'claude')
  })

  it('returns null for no worktree', () => {
    assert.equal(featuredAgent(null), null)
  })
})

describe('projectNameFor', () => {
  it('reads the display name', () => {
    assert.equal(projectNameFor({ displayName: 'proj' }), 'proj')
  })

  it('returns null for a missing or empty display name', () => {
    assert.equal(projectNameFor({}), null)
    assert.equal(projectNameFor({ displayName: '' }), null)
    assert.equal(projectNameFor(null), null)
  })
})
