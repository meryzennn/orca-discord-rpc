import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeProjectSlug, findAgentModel, lastModelIn, prettyModelName } from './agent-model.ts'
import { buildPluginActivity } from './plugin-presence.ts'

describe('prettyModelName', () => {
  it('names the model the way people write it', () => {
    const cases: Array<[string, string]> = [
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
      ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
      ['claude-opus-4-6[1m]', 'Claude Opus 4.6'],
      ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5'],
      ['gpt-5.1-codex-max', 'GPT-5.1 Codex Max'],
      ['gpt-4o', 'GPT-4o'],
      ['cmdcode', 'Cmdcode']
    ]
    for (const [raw, expected] of cases) {
      assert.equal(prettyModelName(raw), expected, raw)
    }
  })
})

describe('claudeProjectSlug', () => {
  it('turns every non-alphanumeric character into a dash', () => {
    assert.equal(claudeProjectSlug('D:/coding/orca-discord-rpc'), 'D--coding-orca-discord-rpc')
    assert.equal(claudeProjectSlug('/home/me/.config/proj'), '-home-me--config-proj')
  })
})

describe('lastModelIn', () => {
  it('takes the last real model and skips synthetic and quoted ones', () => {
    const log = [
      '{"message":{"model":"claude-sonnet-4-5"}}',
      '{"message":{"model":"claude-opus-5-5"}}',
      '{"message":{"model":"<synthetic>"}}',
      // Why: a model name quoted inside a message is escaped and must not count.
      '{"content":"use \\"model\\":\\"gpt-4o\\""}'
    ].join('\n')
    assert.equal(lastModelIn(log), 'claude-opus-5-5')
    assert.equal(lastModelIn('{}'), null)
  })
})

describe('findAgentModel', () => {
  let home = ''
  const freshHome = (): string => (home = mkdtempSync(join(tmpdir(), 'orca-model-')))
  const noEnv = (): string | undefined => undefined
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('reads Claude from the newest session of the worktree', () => {
    freshHome()
    const dir = join(home, '.claude', 'projects', '-home-me-app')
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'old.jsonl')
    writeFileSync(older, '{"type":"assistant","message":{"model":"claude-sonnet-4-5"}}\n')
    const hourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(older, hourAgo, hourAgo)
    writeFileSync(join(dir, 'new.jsonl'), '{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n')

    assert.equal(findAgentModel('claude', '/home/me/app', { env: noEnv, home }), 'Claude Opus 5.5')
  })

  it('reads Codex from the session whose folder matches', () => {
    freshHome()
    const day = join(home, '.codex', 'sessions', '2026', '10', '08')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-a.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/home/me/app"}}\n{"type":"turn_context","payload":{"model":"gpt-5.1-codex"}}\n'
    )
    writeFileSync(
      join(day, 'rollout-b.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/home/me/other"}}\n{"type":"turn_context","payload":{"model":"gpt-4o"}}\n'
    )

    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), 'GPT-5.1 Codex')
  })

  it('finds the latest model before a long turn instead of losing it outside the tail', () => {
    freshHome()
    const day = join(home, '.codex', 'sessions', '2026', '11', '06')
    mkdirSync(day, { recursive: true })
    const file = join(day, 'rollout-long.jsonl')
    const meta = '{"type":"session_meta","payload":{"cwd":"/home/me/app"}}\n'
    const padding = JSON.stringify({ type: 'event_msg', payload: { message: 'x'.repeat(200_000) } }) + '\n'
    writeFileSync(file, meta + '{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}\n' + padding)
    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), 'GPT-6.1 Sol')
    writeFileSync(file, meta + '{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}\n' + padding +
      '{"type":"turn_context","payload":{"model":"gpt-6-astra"}}\n' + padding)
    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), 'GPT-6 Astra')
  })

  it('keeps a model identifier intact when it crosses a backward-read boundary', () => {
    freshHome()
    const day = join(home, '.codex', 'sessions', '2026', '11', '06')
    mkdirSync(day, { recursive: true })
    const record = '{"type":"turn_context","payload":{"model":"gpt-6-astra"}}\n'
    const padding = 65536 - (record.length - record.indexOf('"model"') - 4)
    writeFileSync(join(day, 'rollout-boundary.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/home/me/app"}}\n' + record + '\n'.repeat(padding))
    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), 'GPT-6 Astra')
  })

  it('honours the config folder override', () => {
    freshHome()
    const custom = join(home, 'custom-claude')
    const dir = join(custom, 'projects', '-home-me-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's.jsonl'), '{"message":{"model":"claude-haiku-4-5"}}\n')

    const env = (name: string): string | undefined => (name === 'CLAUDE_CONFIG_DIR' ? custom : undefined)
    assert.equal(findAgentModel('claude', '/home/me/app', { env, home }), 'Claude Haiku 4.5')
  })

  it('reads OMP model changes for the workspace and uses the model tooltip in both modes', () => {
    freshHome()
    const bucket = join(home, '.omp', 'agent', 'sessions', 'opaque-workspace-bucket')
    mkdirSync(bucket, { recursive: true })
    const file = join(bucket, 'main.jsonl')
    const records = [
      { type: 'session', version: 3, id: 'main', timestamp: '2026-11-06T00:00:00Z', cwd: '/home/me/app' },
      { type: 'model_change', id: 'model-a', parentId: null, model: 'anthropic/claude-opus-5-5' },
      { type: 'message', id: 'answer', parentId: 'model-a', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
      { type: 'model_change', id: 'model-b', parentId: 'answer', role: 'default', model: 'anthropic/claude-sonnet-5-5' }
    ]
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const sources = { env: noEnv, home }
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Claude Sonnet 5.5')
    for (const incognito of [false, true]) {
      const activity = buildPluginActivity({ projectName: 'app', agentType: 'omp', runningAgentCount: 1,
        startedAt: new Date('2026-11-06T00:00:00Z'), useUploadedArt: true,
        model: findAgentModel('omp', '/home/me/app', sources), incognito })
      assert.equal(activity.smallImageKey, 'omp')
      assert.equal(activity.smallImageText, 'Claude Sonnet 5.5')
    }
    appendFileSync(file, JSON.stringify({ type: 'model_change', id: 'model-c', parentId: 'model-b',
      role: 'default', model: 'google-antigravity/gemini-3.8-flash' }) + '\n' +
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(200_000) } }) + '\n')
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Gemini 3.8 Flash')
  })

  it('does not take an OMP model from another workspace or a newer child-session artifact', () => {
    freshHome()
    const root = join(home, '.omp', 'agent', 'sessions')
    const write = (bucket: string, cwd: string, model: string) => {
      const directory = join(root, bucket)
      mkdirSync(directory, { recursive: true })
      const file = join(directory, 'session.jsonl')
      writeFileSync(file, JSON.stringify({ type: 'session', version: 3, cwd }) + '\n' +
        JSON.stringify({ type: 'model_change', model }) + '\n')
      return file
    }
    const main = write('workspace', '/home/me/app', 'anthropic/claude-sonnet-5-5')
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(main, old, old)
    write('other', '/home/me/other', 'openai/gpt-4o')
    write('workspace/session/children', '/home/me/app', 'openai/gpt-4o')
    assert.equal(findAgentModel('omp', '/home/me/app', { env: noEnv, home }), 'Claude Sonnet 5.5')
    assert.equal(findAgentModel('omp', '/home/me/missing', { env: noEnv, home }), null)
  })

  it('honours an explicit OMP agent directory without guessing a model from config', () => {
    freshHome()
    const agentDir = join(home, 'custom-omp')
    const bucket = join(agentDir, 'sessions', 'workspace')
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(agentDir, 'config.yml'), 'model: openai/gpt-4o\n')
    const sources = { home, env: (name: string) => name === 'PI_CODING_AGENT_DIR' ? agentDir : undefined }
    assert.equal(findAgentModel('omp', '/home/me/app', sources), null)
    writeFileSync(join(bucket, 'session.jsonl'),
      '{"type":"session","version":3,"cwd":"/home/me/app"}\n' +
      '{"type":"model_change","model":"anthropic/claude-opus-5-5"}\n')
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Claude Opus 5.5')
  })

  it('ignores auxiliary OMP model usage and unrelated tool metadata', () => {
    freshHome()
    const bucket = join(home, '.omp', 'agent', 'sessions', 'workspace')
    mkdirSync(bucket, { recursive: true })
    const file = join(bucket, 'session.jsonl')
    const records = [
      { type: 'session', version: 3, cwd: '/home/me/app' },
      { type: 'model_change', model: 'anthropic/claude-sonnet-5-5' },
      { type: 'message', message: { role: 'assistant', model: 'claude-sonnet-5-5' } },
      { type: 'model_usage', purpose: 'title-drift', role: 'judge', model: 'openai/gpt-4o' }
    ]
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const sources = { env: noEnv, home }
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Claude Sonnet 5.5')
    appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'toolResult', model: 'openai/gpt-4o' } }) + '\n')
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Claude Sonnet 5.5')
    appendFileSync(file, JSON.stringify({ type: 'model_change', role: 'default', model: 'anthropic/claude-opus-5-5' }) + '\n')
    appendFileSync(file, JSON.stringify({ type: 'model_usage', purpose: 'auto-graph', model: 'openai/gpt-4o' }) + '\n')
    assert.equal(findAgentModel('omp', '/home/me/app', sources), 'Claude Opus 5.5')
  })

  it('reads Antigravity model changes from conversation transcript and uses model tooltip in both modes', () => {
    freshHome()
    const agyHome = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(agyHome, { recursive: true })
    const convId = 'conv-test-123'
    writeFileSync(join(agyHome, 'history.jsonl'), JSON.stringify({
      workspace: '/home/me/app',
      conversationId: convId,
      timestamp: Date.now()
    }) + '\n')
    const transcriptDir = join(agyHome, 'brain', convId, '.system_generated', 'logs')
    mkdirSync(transcriptDir, { recursive: true })
    const transcriptFile = join(transcriptDir, 'transcript.jsonl')
    writeFileSync(transcriptFile, JSON.stringify({
      step_index: 0,
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High).\n</USER_SETTINGS_CHANGE>'
    }) + '\n')
    const sources = { env: noEnv, home }
    assert.equal(findAgentModel('antigravity', '/home/me/app', sources), 'Gemini 3.8 Flash (High)')
    assert.equal(findAgentModel('agy', '/home/me/app', sources), 'Gemini 3.8 Flash (High)')

    for (const incognito of [false, true]) {
      const activity = buildPluginActivity({
        projectName: 'app',
        agentType: 'antigravity',
        runningAgentCount: 1,
        startedAt: new Date('2026-11-06T00:00:00Z'),
        useUploadedArt: true,
        model: findAgentModel('antigravity', '/home/me/app', sources),
        incognito
      })
      assert.equal(activity.smallImageKey, 'agy')
      assert.equal(activity.smallImageText, 'Gemini 3.8 Flash (High)')
    }

    appendFileSync(transcriptFile, JSON.stringify({
      step_index: 1,
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.8 Flash (High) to gemini-2.5-pro.\n</USER_SETTINGS_CHANGE>'
    }) + '\n')
    assert.equal(findAgentModel('antigravity', '/home/me/app', sources), 'Gemini 2.5 Pro')
  })

  it('falls back to Antigravity settings.json when no conversation transcript is recorded', () => {
    freshHome()
    const agyHome = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(agyHome, { recursive: true })
    writeFileSync(join(agyHome, 'settings.json'), JSON.stringify({ model: 'Gemini 3.8 Flash (High)' }))
    assert.equal(findAgentModel('antigravity', '/home/me/app', { env: noEnv, home }), 'Gemini 3.8 Flash (High)')
  })

  it('honours an explicit ANTIGRAVITY_HOME directory override', () => {
    freshHome()
    const custom = join(home, 'custom-agy')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'settings.json'), JSON.stringify({ model: 'gemini-2.0-flash' }))
    const sources = { home, env: (name: string) => name === 'ANTIGRAVITY_HOME' ? custom : undefined }
    assert.equal(findAgentModel('antigravity', '/home/me/app', sources), 'Gemini 2.0 Flash')
  })

  it('knows nothing for an unsupported agent or a missing log', () => {
    freshHome()
    assert.equal(findAgentModel('opencode', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('claude', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('omp', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('antigravity', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel(null, '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('claude', null, { env: noEnv, home }), null)
  })
})
