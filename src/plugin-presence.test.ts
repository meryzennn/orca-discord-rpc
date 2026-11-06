import { it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPluginActivity } from './plugin-presence.ts'

const base = {
  projectName: 'sample', agentType: 'claude', runningAgentCount: 2,
  branchName: 'feature/work', startedAt: new Date('2026-11-06T00:00:00Z'), useUploadedArt: true
}

it('uses tray agent/status/folder labels and normal agent art with a sanitized repository button', () => {
  assert.deepEqual(buildPluginActivity({ ...base, repoUrl: 'https://user:secret@github.com:443/owner/repo?token=secret#anchor' }), {
    details: 'Agent: Claude +1 · Working', state: 'Folder: sample', startTimestamp: base.startedAt,
    largeImageKey: 'orca', largeImageText: 'Orca', smallImageKey: 'claude', smallImageText: 'Agent: Claude',
    buttons: [{ label: 'View Repository', url: 'https://github.com/owner/repo' }]
  })
  assert.equal(buildPluginActivity({ ...base, agentActive: false }).details, 'Agent: Claude +1 · Idle')
})

it('uses the tray Orca/count/status fallbacks without duplicate folder labels', () => {
  assert.equal(buildPluginActivity({ ...base, projectName: ' Folder:  sample\n name ' }).state, 'Folder: sample name')
  assert.equal(buildPluginActivity({ ...base, agentType: null }).details, 'Using Orca')
  assert.equal(buildPluginActivity({ ...base, agentType: null }).state, 'Folder: sample · 2 agents')
  assert.equal(buildPluginActivity({ ...base, agentType: null, projectName: null }).state, '2 agents')
  assert.equal(buildPluginActivity({ ...base, agentType: null, projectName: null, runningAgentCount: 0 }).state, 'Orca')
  assert.equal(buildPluginActivity({ ...base, projectName: 'x', agentActive: false }).state, 'Idle')
})

it('uses the featured agent and model in either mode with either artwork source', () => {
  for (const incognito of [false, true]) {
    for (const useUploadedArt of [false, true]) {
      const activity = buildPluginActivity({ ...base, incognito, useUploadedArt,
        model: ' Claude\n Opus 5.5 ', repoUrl: 'https://github.com/owner/repo' })
      assert.equal(activity.smallImageKey, useUploadedArt ? 'claude' : undefined)
      assert.equal(activity.smallImageUrl, useUploadedArt ? undefined :
        'https://www.google.com/s2/favicons?domain=claude.ai&sz=256')
      assert.equal(activity.smallImageText, 'Claude Opus 5.5')
      assert.equal(activity.state, incognito ? 'Folder: Private Project' : 'Folder: sample')
      assert.equal(activity.buttons?.[0]?.label, incognito ? undefined : 'View Repository')
      assert.ok(!JSON.stringify(activity).includes('feature/work'))
    }
  }
})

it('has no branch fallback when the featured agent has no artwork', () => {
  for (const incognito of [false, true]) {
    for (const agentType of [null, 'unknown']) {
      const activity = buildPluginActivity({ ...base, incognito, agentType })
      assert.equal(activity.smallImageKey, undefined)
      assert.equal(activity.smallImageUrl, undefined)
      assert.equal(activity.smallImageText, undefined)
    }
  }
})

it('uses the Codex model tooltip in normal and Incognito while retaining Codex branding', () => {
  for (const incognito of [false, true]) {
    const activity = buildPluginActivity({ ...base, agentType: 'codex', model: 'GPT-6.1 Sol', incognito })
    assert.equal(activity.smallImageKey, 'codex')
    assert.equal(activity.smallImageText, 'GPT-6.1 Sol')
    assert.equal(activity.details, 'Agent: Codex +1 · Working')
  }
})

it('redacts folder, branch and repository in Incognito and uses the small agent/model slot', () => {
  const activity = buildPluginActivity({ ...base, repoUrl: 'https://github.com/secret-owner/secret-repo', model: ' Claude\n Opus 5.5 ', incognito: true })
  assert.equal(activity.details, 'Agent: Claude +1 · Working')
  assert.equal(activity.state, 'Folder: Private Project')
  assert.equal(activity.largeImageKey, 'orca')
  assert.equal(activity.smallImageKey, 'claude')
  assert.equal(activity.smallImageText, 'Claude Opus 5.5')
  assert.equal(activity.buttons, undefined)
  assert.ok(!JSON.stringify(activity).includes('feature/work'))
  assert.ok(!JSON.stringify(activity).includes('secret-'))
})

it('uses public agent fallbacks when upload mappings are absent and no icon for an unknown agent', () => {
  for (const incognito of [false, true]) {
    const activity = buildPluginActivity({ ...base, agentType: 'cursor', incognito })
    assert.equal(activity.smallImageKey, undefined)
    assert.equal(activity.smallImageUrl, 'https://www.google.com/s2/favicons?domain=cursor.com&sz=256')
    assert.equal(activity.smallImageText, 'Agent: Cursor')
    assert.equal(buildPluginActivity({ ...base, agentType: 'unknown', incognito }).smallImageText, undefined)
    assert.equal(buildPluginActivity({ ...base, agentType: null, incognito }).smallImageKey, undefined)
    assert.equal(buildPluginActivity({ ...base, incognito, useUploadedArt: false }).smallImageUrl,
      'https://www.google.com/s2/favicons?domain=claude.ai&sz=256')
    assert.equal(buildPluginActivity({ ...base, agentType: 'omp', incognito, useUploadedArt: false }).smallImageUrl,
      'https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png')
  }
})

it('keeps brand spellings, limits and unicode boundaries while preserving the agent count/status', () => {
  for (const [agentType, name] of [['opencode2', 'OpenCode'], ['omp', 'Oh My Pi'], ['qwen-code', 'Qwen Code'], ['claude-agent-teams', 'Claude']]) {
    assert.equal(buildPluginActivity({ ...base, agentType: agentType! }).details, `Agent: ${name} +1 · Working`)
  }
  const long = '😀'.repeat(100)
  const activity = buildPluginActivity({ ...base, projectName: long, agentType: long, branchName: long, model: long })
  assert.ok(activity.state.length <= 100)
  assert.ok(activity.details.endsWith(' +1 · Working'))
  assert.equal(activity.smallImageText, undefined)
  for (const value of [activity.state, activity.details]) {
    assert.ok(value && value.length >= 2 && value.length <= 128)
    assert.doesNotMatch(value, /[\uD800-\uDFFF]/u)
  }
  const model = buildPluginActivity({ ...base, model: 'a' + long, incognito: true }).smallImageText!
  assert.ok(model.length <= 128)
  assert.doesNotMatch(model, /[\uD800-\uDFFF]/u)
})

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
