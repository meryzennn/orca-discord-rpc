import { it } from 'node:test'
import assert from 'node:assert/strict'
import { composeText } from './presence-format.ts'

const input = {
  projectName: 'sample', agentName: 'Codex', model: 'selected-model',
  runningAgentCount: 3, activeWorkspaceCount: 2
}

it('renders exact global counts, including zero and singular forms', () => {
  for (const [runningAgentCount, activeWorkspaceCount, details, state] of [
    [0, 0, 'Codex · 0 agents working', '📁 sample · 0 active workspaces'],
    [1, 1, 'Codex · 1 agent working', '📁 sample · 1 active workspace'],
    [3, 2, 'Codex · 3 agents working', '📁 sample · 2 active workspaces']
  ] as const) {
    assert.deepEqual(composeText({ ...input, runningAgentCount, activeWorkspaceCount }), {
      details, state, iconText: 'selected-model'
    })
  }
})

it('normalizes invalid numbers without inventing a working agent', () => {
  for (const count of [NaN, Infinity, -Infinity, -1]) {
    const text = composeText({ ...input, runningAgentCount: count, activeWorkspaceCount: count })
    assert.equal(text.details, 'Codex · 0 agents working')
    assert.equal(text.state, '📁 sample · 0 active workspaces')
  }
  const fractional = composeText({ ...input, runningAgentCount: 1.9, activeWorkspaceCount: 1.9 })
  assert.equal(fractional.details, 'Codex · 1 agent working')
  assert.equal(fractional.state, '📁 sample · 1 active workspace')
})

it('retains aggregates in privacy mode and does not invent a folder', () => {
  assert.equal(composeText({ ...input, incognito: true }).state,
    '📁 Private Project · 2 active workspaces')
  for (const projectName of [null, '', 'x']) {
    assert.equal(composeText({ ...input, projectName }).state, '2 active workspaces')
  }
  assert.deepEqual(composeText({ ...input, agentName: null }), {
    details: '', state: '', iconText: ''
  })
})

it('preserves complete suffixes and graphemes inside both field limits', () => {
  const text = composeText({
    ...input, agentName: '😀'.repeat(100),
    projectName: 'a'.repeat(91) + '👨‍👩‍👧',
    runningAgentCount: 12, activeWorkspaceCount: 12
  })
  assert.equal(text.state, '📁 ' + 'a'.repeat(91) + ' · 12 active workspaces')
  assert.ok(text.details.endsWith(' · 12 agents working'))
  assert.equal(text.iconText, 'selected-model')
  for (const value of [text.details, text.state]) {
    assert.ok(value.length <= 128)
    assert.doesNotMatch(value, /[\uD800-\uDFFF]/u)
  }
})
