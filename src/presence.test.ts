import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildActivity } from './presence.ts'

const startedAt = new Date('2026-10-05T00:00:00.000Z')
const OMP_LOGO = 'https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png'
const CLAUDE_FAVICON = 'https://www.google.com/s2/favicons?domain=claude.ai&sz=256'
const BRANCH_FAVICON = 'https://www.google.com/s2/favicons?domain=git-scm.com&sz=128'

describe('buildActivity (daemon layout)', () => {
  it('keeps the application presence and session timer when no agent is open', () => {
    for (const projectName of [null, 'private-project']) {
      for (const incognito of [false, true]) {
        for (const useUploadedArt of [false, true]) {
          assert.deepEqual(buildActivity({
            projectName, agentType: null, model: 'private-model',
            runningAgentCount: 0, activeWorkspaceCount: 0,
            branchName: 'private-branch', repoUrl: 'https://github.com/private/repo',
            startedAt, incognito, useUploadedArt
          }), { details: '', state: '', startTimestamp: startedAt })
        }
      }
    }
  })

  it('names the agent and its status on line 1 and the folder on line 2', () => {
    const activity = buildActivity({ projectName: 'orca', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    assert.equal(activity.details, 'Claude · 1 agent working')
    assert.equal(activity.state, '📁 orca · 1 active workspace')
  })

  it('renders working totals without suffixing the selected agent name', () => {
    for (const [runningAgentCount, activeWorkspaceCount, details] of [
      [0, 0, 'Claude · 0 agents working'],
      [1, 1, 'Claude · 1 agent working'],
      [3, 2, 'Claude · 3 agents working']
    ] as const) {
      const activity = buildActivity({ projectName: 'orca', agentType: 'claude',
        runningAgentCount, activeWorkspaceCount, startedAt })
      assert.equal(activity.details, details)
    }
  })

  it('replaces the folder and hides the branch in Incognito', () => {
    const activity = buildActivity({ projectName: 'secret', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1,
      branchName: 'secret-branch', incognito: true, startedAt })
    assert.equal(activity.state, '📁 Private Project · 1 active workspace')
    assert.ok(!JSON.stringify(activity).includes('secret'))
  })

  it('names the model on the agent icon, else the agent', () => {
    const base = { projectName: 'orca', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt }
    assert.equal(buildActivity({ ...base, model: 'Claude Opus 5.5' }).largeImageText, 'Claude Opus 5.5')
    assert.equal(buildActivity(base).largeImageText, 'Claude')
  })

  it('uses uploaded asset keys when artwork was uploaded', () => {
    const activity = buildActivity({ projectName: 'orca', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt, useUploadedArt: true })
    assert.equal(activity.largeImageKey, 'claude')
    assert.equal(activity.largeImageUrl, undefined)
    assert.equal(activity.smallImageKey, 'git-branch')
    assert.equal(activity.smallImageUrl, undefined)
  })

  it('uses public urls when nothing is uploaded', () => {
    const activity = buildActivity({ projectName: 'orca', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    assert.equal(activity.largeImageUrl, CLAUDE_FAVICON)
    assert.equal(activity.smallImageUrl, BRANCH_FAVICON)
    assert.equal(activity.largeImageKey, undefined)
  })

  it('uses a public image for an agent with no uploaded asset even in uploaded mode', () => {
    const activity = buildActivity({ projectName: 'orca', agentType: 'cursor', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt, useUploadedArt: true })
    assert.equal(activity.largeImageKey, 'https://www.google.com/s2/favicons?domain=cursor.com&sz=256')
  })

  it('falls back to the Orca asset and a generated name for an unknown agent', () => {
    for (const useUploadedArt of [false, true]) {
      const activity = buildActivity({ projectName: 'orca', agentType: 'some-in-house-agent', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt, useUploadedArt })
      assert.equal(activity.details, 'Some In House Agent · 1 agent working')
      assert.equal(activity.largeImageKey, 'orca')
      assert.equal(activity.largeImageText, 'Some In House Agent')
    }
  })

  it('puts the branch name in the small icon tooltip, with a generic fallback', () => {
    const base = { projectName: 'orca', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt }
    assert.equal(buildActivity({ ...base, branchName: 'feat/mobile-fix' }).smallImageText, 'feat/mobile-fix')
    assert.equal(buildActivity(base).smallImageText, 'Branch')
  })

  it('collapses whitespace and control characters in a project name', () => {
    const activity = buildActivity({ projectName: 'my  project\n\ttwo', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    assert.equal(activity.state, '📁 my project two · 1 active workspace')
  })

  it('omits a one-character project name instead of failing the whole update', () => {
    const activity = buildActivity({ projectName: 'x', agentType: 'claude', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    assert.equal(activity.state, '1 active workspace')
  })

  it('omits a one-character agent name instead of failing the whole update', () => {
    const activity = buildActivity({ projectName: 'orca', agentType: 'q', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    assert.equal(activity.details, '')
    assert.equal(activity.state, '📁 orca · 1 active workspace')
  })

  it('never emits a single-character field', () => {
    const activity = buildActivity({ projectName: 'x', agentType: 'q', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt })
    for (const value of [activity.details, activity.state, activity.largeImageText, activity.smallImageText]) {
      if (value !== undefined) assert.ok(value.length === 0 || value.length >= 2, `too short: ${JSON.stringify(value)}`)
    }
  })

  for (const useUploadedArt of [false, true]) {
    it(`uses OMP artwork with useUploadedArt=${useUploadedArt}`, () => {
      const activity = buildActivity({ projectName: 'orca-discord-rpc', agentType: 'omp', runningAgentCount: 2, activeWorkspaceCount: 1,
        branchName: 'main', startedAt, useUploadedArt })
      assert.equal(activity.details, 'Oh My Pi · 2 agents working')
      assert.equal(activity.state, '📁 orca-discord-rpc · 1 active workspace')
      assert.equal(activity.largeImageKey, useUploadedArt ? 'omp' : undefined)
      assert.equal(activity.largeImageUrl, useUploadedArt ? undefined : OMP_LOGO)
      assert.equal(activity.smallImageText, 'main')
    })
  }
})
