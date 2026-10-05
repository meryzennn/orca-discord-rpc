import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildActivity, agentDisplayName, agentImageUrl, PRESENCE_ASSET_KEY } from './presence.ts'
import { BRANCH_ART_KEY, BRANCH_ICON_URL, agentFaviconUrl } from './agent-art.ts'

const startedAt = new Date('2026-10-05T00:00:00.000Z')

describe('agentDisplayName', () => {
  it('keeps known brand spellings', () => {
    assert.equal(agentDisplayName('claude'), 'Claude')
    assert.equal(agentDisplayName('opencode'), 'OpenCode')
  })

  it('title-cases an unknown agent slug', () => {
    assert.equal(agentDisplayName('some-in-house-agent'), 'Some In House Agent')
  })
})

describe('agentImageUrl', () => {
  it('uses the uploaded asset key when artwork was uploaded', () => {
    assert.equal(agentImageUrl('claude', true), 'claude')
    assert.equal(agentImageUrl('antigravity', true), 'agy')
  })

  it('falls back to a public favicon when nothing is uploaded', () => {
    assert.equal(agentImageUrl('claude', false), agentFaviconUrl('claude'))
    assert.ok(agentImageUrl('claude', false)?.startsWith('https://'))
  })

  it('uses a favicon for an agent with no uploaded asset even in uploaded mode', () => {
    assert.equal(agentImageUrl('cursor', true), agentFaviconUrl('cursor'))
  })

  it('returns null for an unknown agent', () => {
    assert.equal(agentImageUrl('some-in-house-agent', false), null)
  })
})

describe('buildActivity', () => {
  it('shows Orca alone when nothing is running', () => {
    const activity = buildActivity({
      projectName: null,
      agentType: null,
      runningAgentCount: 0,
      startedAt
    })
    assert.equal(activity.details, 'Using Orca')
    assert.equal(activity.state, 'Orca')
    assert.equal(activity.startTimestamp, startedAt)
    assert.equal(activity.largeImageKey, 'orca')
    assert.equal(activity.largeImageUrl, undefined)
  })

  it('names the agent on the first line when one is running', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.details, 'Claude')
    assert.equal(activity.state, 'orca · Working')
  })

  it('appends +N when other agents are open, like Codex +1', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'codex',
      runningAgentCount: 2,
      startedAt
    })
    assert.equal(activity.details, 'Codex +1')
  })

  it('does not append +N for a single agent', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'codex',
      runningAgentCount: 1,
      startedAt
    })
    assert.equal(activity.details, 'Codex')
  })

  it('counts each open agent, not each distinct type', () => {
    // Why: two panes running Claude are still two agents the user has open.
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 3,
      startedAt
    })
    assert.equal(activity.details, 'Claude +2')
  })

  it('shows the second line as the folder and the status, not a count', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 2,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.details, 'Claude +1')
    assert.equal(activity.state, 'orca · Working')
  })

  it('uses the uploaded asset keys when artwork was uploaded', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      startedAt,
      useUploadedArt: true
    })
    assert.equal(activity.largeImageKey, 'claude')
    assert.equal(activity.largeImageUrl, undefined)
    assert.equal(activity.smallImageKey, BRANCH_ART_KEY)
    assert.equal(activity.smallImageUrl, undefined)
  })

  it('uses public urls when nothing is uploaded', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      startedAt
    })
    assert.equal(activity.largeImageUrl, agentFaviconUrl('claude'))
    assert.equal(activity.smallImageUrl, BRANCH_ICON_URL)
    assert.equal(activity.largeImageKey, undefined)
  })

  it('falls back to the Orca asset for an agent with no artwork', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'some-in-house-agent',
      runningAgentCount: 1,
      startedAt,
      useUploadedArt: true
    })
    assert.equal(activity.details, 'Some In House Agent')
    assert.equal(activity.largeImageKey, PRESENCE_ASSET_KEY)
  })

  it('falls back to the Orca asset when no agent is running', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: null,
      runningAgentCount: 0,
      startedAt
    })
    assert.equal(activity.details, 'Using Orca')
    assert.equal(activity.largeImageKey, 'orca')
    assert.equal(activity.smallImageUrl, BRANCH_ICON_URL)
  })

  it('shows Idle on the second line when the agent is between turns', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 0,
      agentActive: false,
      startedAt
    })
    assert.equal(activity.details, 'Claude')
    assert.equal(activity.state, 'orca · Idle')
  })

  it('shows Working on the second line when the agent is mid-turn', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.state, 'orca · Working')
  })

  it('shows Working even while another agent is counted', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 2,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.state, 'orca · Working')
  })

  it('puts the branch name in the icon tooltip', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      agentActive: true,
      branchName: 'feat/mobile-fix',
      startedAt
    })
    assert.equal(activity.smallImageText, 'feat/mobile-fix')
  })

  it('falls back to a generic tooltip when no branch is known', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 1,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.smallImageText, 'Branch')
  })

  it('never shows Idle while the featured agent is running', () => {
    // A running agent means the featured agent is active, so Idle cannot be shown.
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'claude',
      runningAgentCount: 2,
      agentActive: true,
      startedAt
    })
    assert.equal(activity.state, 'orca · Working')
  })

  it('does not mark anything idle when no agent is known', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: null,
      runningAgentCount: 0,
      agentActive: false,
      startedAt
    })
    assert.equal(activity.details, 'Using Orca')
    assert.equal(activity.state, 'orca')
  })

  it('collapses whitespace and control characters in a project name', () => {
    const activity = buildActivity({
      projectName: 'my  project\n\ttwo',
      agentType: null,
      runningAgentCount: 0,
      startedAt
    })
    assert.equal(activity.state, 'my project two')
  })

  it('keeps the composed state line within 128 characters', () => {
    const activity = buildActivity({
      projectName: 'x'.repeat(200),
      agentType: 'claude',
      runningAgentCount: 12,
      startedAt
    })
    assert.ok(activity.state.length <= 128)
  })

  it('omits a one-character project name instead of failing the whole update', () => {
    // Discord rejects any field shorter than 2 characters, which fails the entire setActivity.
    const activity = buildActivity({
      projectName: 'x',
      agentType: 'claude',
      runningAgentCount: 1,
      startedAt
    })
    assert.equal(activity.details, 'Claude')
    // The project was dropped, so line 2 falls back to the status alone.
    assert.equal(activity.state, 'Working')
  })

  it('omits a one-character agent name instead of failing the whole update', () => {
    const activity = buildActivity({
      projectName: 'orca',
      agentType: 'q',
      runningAgentCount: 1,
      startedAt
    })
    assert.equal(activity.details, '')
    assert.equal(activity.state, 'orca · Working')
  })

  it('never emits a single-character field', () => {
    const activity = buildActivity({
      projectName: 'x',
      agentType: 'q',
      runningAgentCount: 1,
      startedAt
    })
    for (const value of [activity.details, activity.state, activity.largeImageText, activity.smallImageText]) {
      if (value !== undefined) {
        assert.ok(value.length === 0 || value.length >= 2, `too short: ${JSON.stringify(value)}`)
      }
    }
  })
})
