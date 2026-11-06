import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRegistry } from './agent-registry.ts'
import { findAgentModel } from './agent-model.ts'
import { readPresenceState } from './orca-reader.ts'
import { createPresenceController } from './presence-controller.ts'
import { buildPluginActivity } from './plugin-presence.ts'
import type { PresenceActivity } from './presence.ts'

const worktrees = (agentType: string) => async () => JSON.stringify({ ok: true, result: { worktrees: [{
  isActive: true, path: '/home/me/app', agents: [{ agentType, state: 'working', stateStartedAt: 1760000000000 }]
}] } })

it('logs an unknown agent once across many polls and still publishes a named card with an icon', async () => {
  const logs: string[] = []
  const registry = createAgentRegistry({ log: message => logs.push(message) })
  const applied: PresenceActivity[] = []
  let count = 1
  const controller = createPresenceController({
    // A changing count defeats dedup, so every poll builds and applies a card.
    readState: async () => {
      const state = await readPresenceState(worktrees('new-agent'), undefined,
        (agentType, path) => findAgentModel(agentType, path, undefined, registry))
      return state && { ...state, runningAgentCount: count++ }
    },
    buildActivity: input => buildPluginActivity({ ...input, registry }),
    apply: async activity => { applied.push(activity); return true },
    clear: async () => true
  })
  for (let poll = 0; poll < 4; poll++) await controller.poll()
  assert.equal(applied.length, 4)
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /new-agent/)
  for (const activity of applied) {
    assert.match(activity.details, /^New Agent/)
    assert.equal(activity.smallImageUrl, 'https://www.google.com/s2/favicons?domain=onorca.dev&sz=256')
    assert.equal(activity.smallImageText, 'New Agent')
  }
})

it('logs each distinct unknown agent id once', async () => {
  const logs: string[] = []
  const registry = createAgentRegistry({ log: message => logs.push(message) })
  for (const agentType of ['alpha', 'beta', 'alpha', 'beta', 'gamma']) {
    await readPresenceState(worktrees(agentType), undefined, (type, path) => findAgentModel(type, path, undefined, registry))
  }
  assert.equal(logs.length, 3)
})
