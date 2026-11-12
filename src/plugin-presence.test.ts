import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPluginActivity } from './plugin-presence.ts'
import { createAgentRegistry } from './agent-registry.ts'

const base = {
  projectName: 'sample', agentType: 'claude', runningAgentCount: 2, activeWorkspaceCount: 1,
  branchName: 'feature/work', startedAt: new Date('2026-11-06T00:00:00Z'), useUploadedArt: true
}
const CLAUDE_FAVICON = 'https://www.google.com/s2/favicons?domain=claude.ai&sz=256'
/** With the u flag this matches only an unpaired surrogate, i.e. a character cut in half. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const ORCA_FAVICON = 'https://www.google.com/s2/favicons?domain=onorca.dev&sz=256'

describe('card layout', () => {
  it('puts agent, other panes and status on line 1 and the folder on line 2', () => {
    assert.deepEqual(buildPluginActivity({ ...base, repoUrl: 'https://user:secret@github.com:443/owner/repo?token=secret#anchor' }), {
      details: 'Claude · 2 agents · Working', state: '📁 sample · 1 workspace', startTimestamp: base.startedAt,
      largeImageKey: 'orca', largeImageText: 'Orca', smallImageKey: 'claude', smallImageText: 'Claude',
      buttons: [{ label: 'View Repository', url: 'https://github.com/owner/repo' }]
    })
  })

  it('renders zero, singular and plural global totals', () => {
    for (const [runningAgentCount, activeWorkspaceCount, details, state] of [
      [0, 0, 'Claude · 0 agents · Working', '📁 sample · 0 workspaces'],
      [1, 1, 'Claude · 1 agent · Working', '📁 sample · 1 workspace'],
      [3, 2, 'Claude · 3 agents · Working', '📁 sample · 2 workspaces']
    ] as const) {
      const activity = buildPluginActivity({ ...base, runningAgentCount, activeWorkspaceCount })
      assert.equal(activity.details, details)
      assert.equal(activity.state, state)
    }
  })

  it('keeps status on line 1 while line 2 is the folder', () => {
    const activity = buildPluginActivity({ ...base, runningAgentCount: 0, activeWorkspaceCount: 0 })
    assert.equal(activity.details, 'Claude · 0 agents · Working')
    assert.equal(activity.state, '📁 sample · 0 workspaces')
  })

  it('shows the status on line 2 only when there is no folder', () => {
    assert.equal(buildPluginActivity({ ...base, projectName: null }).state, '1 workspace')
    assert.equal(buildPluginActivity({ ...base, projectName: 'x' }).state, '1 workspace')
  })

  it('keeps the application presence and session timer when no agent is open', () => {
    for (const projectName of [null, 'private-project']) {
      for (const incognito of [false, true]) {
        for (const useUploadedArt of [false, true]) {
          assert.deepEqual(buildPluginActivity({
            ...base, projectName, agentType: null, model: 'private-model',
            branchName: 'private-branch', repoUrl: 'https://github.com/private/repo',
            incognito, useUploadedArt
          }), { details: '', state: '', startTimestamp: base.startedAt })
        }
      }
    }
  })

  it('normalizes whitespace in a folder name', () => {
    assert.equal(buildPluginActivity({ ...base, projectName: ' sample\n  name ' }).state, '📁 sample name · 1 workspace')
  })

  it('does not strip a folder name that looks like a label', () => {
    assert.equal(buildPluginActivity({ ...base, projectName: 'Folder: sample' }).state, '📁 Folder: sample · 1 workspace')
  })
})

describe('Incognito', () => {
  it('shows the private folder, hides branch and repository, and keeps agent and model', () => {
    const activity = buildPluginActivity({ ...base, repoUrl: 'https://github.com/secret-owner/secret-repo',
      model: ' Claude\n Opus 5.5 ', incognito: true })
    assert.equal(activity.details, 'Claude · 2 agents · Working')
    assert.equal(activity.state, '📁 Private Project · 1 workspace')
    assert.equal(activity.smallImageKey, 'claude')
    assert.equal(activity.smallImageText, 'Claude Opus 5.5')
    assert.equal(activity.buttons, undefined)
    assert.ok(!JSON.stringify(activity).includes('feature/work'))
    assert.ok(!JSON.stringify(activity).includes('secret-'))
  })

  it('uses the model tooltip and either artwork source in both modes', () => {
    for (const incognito of [false, true]) {
      for (const useUploadedArt of [false, true]) {
        const activity = buildPluginActivity({ ...base, incognito, useUploadedArt,
          model: ' Claude\n Opus 5.5 ', repoUrl: 'https://github.com/owner/repo' })
        assert.equal(activity.smallImageKey, useUploadedArt ? 'claude' : undefined)
        assert.equal(activity.smallImageUrl, useUploadedArt ? undefined : CLAUDE_FAVICON)
        assert.equal(activity.smallImageText, 'Claude Opus 5.5')
        assert.equal(activity.state, incognito ? '📁 Private Project · 1 workspace' : '📁 sample · 1 workspace')
        assert.equal(activity.buttons?.[0]?.label, incognito ? undefined : 'View Repository')
      }
    }
  })
})

describe('agent icon and tooltip', () => {
  it('names the agent in the tooltip when no model is known', () => {
    assert.equal(buildPluginActivity({ ...base, agentType: 'omp' }).smallImageText, 'Oh My Pi')
    assert.equal(buildPluginActivity({ ...base, agentType: 'codex', model: 'GPT-6.1 Sol' }).smallImageText, 'GPT-6.1 Sol')
  })

  it('uses a public image for an agent without an uploaded asset', () => {
    const activity = buildPluginActivity({ ...base, agentType: 'cursor' })
    assert.equal(activity.smallImageKey, undefined)
    assert.equal(activity.smallImageUrl, 'https://www.google.com/s2/favicons?domain=cursor.com&sz=256')
    assert.equal(activity.smallImageText, 'Cursor')
  })

  it('gives an unknown agent a generated name, the Orca icon and the name as tooltip', () => {
    const uploaded = buildPluginActivity({ ...base, agentType: 'new-agent' })
    assert.equal(uploaded.details, 'New Agent · 2 agents · Working')
    assert.equal(uploaded.smallImageKey, 'orca')
    assert.equal(uploaded.smallImageUrl, undefined)
    assert.equal(uploaded.smallImageText, 'New Agent')
    const plain = buildPluginActivity({ ...base, agentType: 'new-agent', useUploadedArt: false })
    assert.equal(plain.smallImageKey, undefined)
    assert.equal(plain.smallImageUrl, ORCA_FAVICON)
  })

  it('has no small icon when no agent is open', () => {
    for (const incognito of [false, true]) {
      const activity = buildPluginActivity({ ...base, agentType: null, incognito })
      assert.equal(activity.smallImageKey, undefined)
      assert.equal(activity.smallImageUrl, undefined)
      assert.equal(activity.smallImageText, undefined)
    }
  })

  it('applies a user override from the registry', () => {
    const registry = createAgentRegistry({ overrides: {
      'new-agent': { name: 'Brand New', asset: 'brandnew', imageUrl: 'https://example.com/new.png' },
      claude: { name: 'Claude Code' }
    } })
    const custom = buildPluginActivity({ ...base, agentType: 'new-agent', registry })
    assert.equal(custom.details, 'Brand New · 2 agents · Working')
    assert.equal(custom.smallImageKey, 'brandnew')
    assert.equal(buildPluginActivity({ ...base, agentType: 'new-agent', registry, useUploadedArt: false }).smallImageUrl,
      'https://example.com/new.png')
    const renamed = buildPluginActivity({ ...base, registry })
    assert.equal(renamed.details, 'Claude Code · 2 agents · Working')
    assert.equal(renamed.smallImageKey, 'claude')
  })
})

describe('limits and unicode', () => {
  it('drops a ZWJ sequence whole at the folder boundary instead of splitting it', () => {
    const family = '👨‍👩‍👧'
    const activity = buildPluginActivity({ ...base, projectName: `${'a'.repeat(94)}${family}` })
    assert.equal(activity.state, `📁 ${'a'.repeat(94)} · 1 workspace`)
  })

  it('drops a flag whole at the folder boundary', () => {
    const family = '👨‍👩‍👧'
    const activity = buildPluginActivity({ ...base, projectName: `${'a'.repeat(95)}🇯🇵` })
    assert.equal(activity.state, `📁 ${'a'.repeat(95)} · 1 workspace`)
  })

  it('keeps a whole emoji that fits exactly', () => {
    const activity = buildPluginActivity({ ...base, projectName: `${'a'.repeat(95)}😀` })
    assert.equal(activity.state, `📁 ${'a'.repeat(95)}😀 · 1 workspace`)
  })

  it('limits very long and non-ASCII folder names without breaking characters', () => {
    for (const name of ['😀'.repeat(300), '日本語'.repeat(80), 'é'.repeat(500)]) {
      const activity = buildPluginActivity({ ...base, projectName: name })
      assert.ok(activity.state.length <= 128, `${activity.state.length}`)
      assert.ok(activity.state.startsWith('📁 '))
      assert.doesNotMatch(activity.state, LONE_SURROGATE)
    }
  })

  it('keeps the count and status when the agent name is too long', () => {
    const registry = createAgentRegistry({ overrides: { claude: { name: '😀'.repeat(200) } } })
    const activity = buildPluginActivity({ ...base, runningAgentCount: 3, activeWorkspaceCount: 1, registry })
    assert.ok(activity.details.endsWith(' · 3 agents · Working'))
    assert.ok(activity.details.length <= 128)
    assert.doesNotMatch(activity.details, LONE_SURROGATE)
  })

  it('limits an overlong model tooltip without splitting a character', () => {
    const model = buildPluginActivity({ ...base, model: `a${'😀'.repeat(100)}` }).smallImageText!
    assert.ok(model.length <= 128)
    assert.doesNotMatch(model, LONE_SURROGATE)
  })

  it('never emits a one-character field', () => {
    const registry = createAgentRegistry({ overrides: { claude: { name: 'Q' } } })
    const activity = buildPluginActivity({ ...base, projectName: 'x', registry })
    assert.equal(activity.details, '')
    assert.equal(activity.state, '1 workspace')
  })
})

describe('repository button', () => {
  it('rejects invalid or local origins at the final button boundary', () => {
    for (const repoUrl of ['javascript:alert(1)', 'file:///secret/repo', 'https://', '/local/repo', 'https://github.com',
      'https://github.com/owner\\repo', 'https://github.com/o/%zz', 'https://github.com/o/%00repo',
      'ssh://git@github.com/owner/repo', 'git@github.com:owner/repo.git']) {
      assert.equal(buildPluginActivity({ ...base, repoUrl }).buttons, undefined, repoUrl)
    }
  })

  it('redacts a web repository URL without mutating its legitimate Git suffix', () => {
    assert.deepEqual(buildPluginActivity({ ...base,
      repoUrl: 'https://user:secret@example.com:8443/owner/repo.git?token=secret#anchor'
    }).buttons, [{ label: 'View Repository', url: 'https://example.com/owner/repo.git' }])
  })
})
