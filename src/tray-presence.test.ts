import { it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayActivity } from './tray-presence.ts'

const base = {
  projectName: 'sample', agentType: 'claude', runningAgentCount: 2,
  branchName: 'feature/work', startedAt: new Date('2026-11-06T00:00:00Z'), useUploadedArt: true
}

it('uses tray agent/status/folder labels and normal branch art with a sanitized repository button', () => {
  assert.deepEqual(buildTrayActivity({ ...base, repoUrl: 'https://user:secret@github.com:443/owner/repo.git?token=secret#anchor' }), {
    details: 'Agent: Claude +1 · Working', state: 'Folder: sample', startTimestamp: base.startedAt,
    largeImageKey: 'orca', largeImageText: 'Orca', smallImageKey: 'git-branch', smallImageText: 'feature/work',
    buttons: [{ label: 'View Repository', url: 'https://github.com/owner/repo' }]
  })
  assert.equal(buildTrayActivity({ ...base, agentActive: false }).details, 'Agent: Claude +1 · Idle')
})

it('uses the tray Orca/count/status fallbacks without duplicate folder labels', () => {
  assert.equal(buildTrayActivity({ ...base, projectName: ' Folder:  sample\n name ' }).state, 'Folder: sample name')
  assert.equal(buildTrayActivity({ ...base, agentType: null }).details, 'Using Orca')
  assert.equal(buildTrayActivity({ ...base, agentType: null }).state, 'Folder: sample · 2 agents')
  assert.equal(buildTrayActivity({ ...base, agentType: null, projectName: null }).state, '2 agents')
  assert.equal(buildTrayActivity({ ...base, agentType: null, projectName: null, runningAgentCount: 0 }).state, 'Orca')
  assert.equal(buildTrayActivity({ ...base, projectName: 'x', agentActive: false }).state, 'Idle')
})

it('uses only the branch favicon in normal mode without uploaded artwork', () => {
  const activity = buildTrayActivity({ ...base, useUploadedArt: false, branchName: ' feature/  normalized\n branch ' })
  assert.equal(activity.largeImageKey, undefined)
  assert.equal(activity.largeImageUrl, undefined)
  assert.equal(activity.smallImageUrl, 'https://www.google.com/s2/favicons?domain=git-scm.com&sz=128')
  assert.equal(activity.smallImageText, 'feature/ normalized branch')
  assert.equal(buildTrayActivity({ ...base, branchName: 'x' }).smallImageText, 'Branch')
})

it('redacts folder, branch and repository in Incognito and uses the small agent/model slot', () => {
  const activity = buildTrayActivity({ ...base, repoUrl: 'https://github.com/secret-owner/secret-repo', model: ' Claude\n Opus 5.5 ', incognito: true })
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
  const activity = buildTrayActivity({ ...base, agentType: 'cursor', incognito: true })
  assert.equal(activity.smallImageKey, undefined)
  assert.equal(activity.smallImageUrl, 'https://www.google.com/s2/favicons?domain=cursor.com&sz=256')
  assert.equal(activity.smallImageText, 'Agent: Cursor')
  assert.equal(buildTrayActivity({ ...base, agentType: 'unknown', incognito: true }).smallImageText, undefined)
  assert.equal(buildTrayActivity({ ...base, agentType: null, incognito: true }).smallImageKey, undefined)
  assert.equal(buildTrayActivity({ ...base, incognito: true, useUploadedArt: false }).smallImageUrl,
    'https://www.google.com/s2/favicons?domain=claude.ai&sz=256')
  assert.equal(buildTrayActivity({ ...base, agentType: 'omp', incognito: true, useUploadedArt: false }).smallImageUrl,
    'https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png')
})

it('keeps brand spellings, limits and unicode boundaries while preserving the agent count/status', () => {
  for (const [agentType, name] of [['opencode2', 'OpenCode'], ['omp', 'Oh My Pi'], ['qwen-code', 'Qwen Code'], ['claude-agent-teams', 'Claude']]) {
    assert.equal(buildTrayActivity({ ...base, agentType: agentType! }).details, `Agent: ${name} +1 · Working`)
  }
  const long = '😀'.repeat(100)
  const activity = buildTrayActivity({ ...base, projectName: long, agentType: long, branchName: long, model: long })
  assert.ok(activity.state.length <= 100)
  assert.ok(activity.details.endsWith(' +1 · Working'))
  for (const value of [activity.state, activity.details, activity.smallImageText]) {
    assert.ok(value && value.length >= 2 && value.length <= 128)
    assert.doesNotMatch(value, /[\uD800-\uDFFF]/u)
  }
  const model = buildTrayActivity({ ...base, model: 'a' + long, incognito: true }).smallImageText!
  assert.ok(model.length <= 128)
  assert.doesNotMatch(model, /[\uD800-\uDFFF]/u)
})

it('rejects invalid or local origins at the final button boundary', () => {
  for (const repoUrl of ['javascript:alert(1)', 'file:///secret/repo', 'https://', '/local/repo', 'https://github.com',
    'https://github.com/owner\\repo', 'https://github.com/o/%zz', 'https://github.com/o/%00repo']) {
    assert.equal(buildTrayActivity({ ...base, repoUrl }).buttons, undefined, repoUrl)
  }
})
