import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { createPluginLifecycle, type PluginApi } from './orca-plugin.ts'
import { createPluginSession } from './plugin-session.ts'
import { DEFAULT_CLIENT_ID, DEFAULT_POLL_MS, readConfigFile, type ConfigFile } from './config.ts'
import type { PresenceActivity } from './presence.ts'
import type { PresenceState } from './presence-controller.ts'
import type { PresenceRuntimeStatus } from './runtime.ts'
import type { PluginUpdateResult } from './update.ts'

it('declares a resident worker with a real status command and both refresh events', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.main, 'plugin/runtime.mjs')
  assert.equal(manifest.engines.orca, '>=1.4.250')
  const command = manifest.contributes.statusBarItems[0].command
  assert.ok(manifest.contributes.commands.some((entry: { id: string }) => entry.id === command))
  assert.deepEqual(manifest.contributes.events, [{ on: 'workspace.changed' }, { on: 'agent.status.changed' }])
  assert.equal(manifest.contributes.settings.find((setting: { key: string }) => setting.key === 'incognito').default, undefined)
})

it('reads valid legacy Incognito through a BOM, stays quiet when absent and logs malformed config', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-plugin-bootstrap-'))
  try {
    const config = join(root, 'config.json')
    const logs: string[] = []
    assert.equal(readConfigFile(config, message => logs.push(message)), null)
    assert.equal(logs.length, 0)
    for (const contents of ['{"incognito":true}', '\uFEFF{"incognito":true}']) {
      writeFileSync(config, contents)
      assert.equal(readConfigFile(config, message => logs.push(message))?.incognito, true)
    }
    assert.equal(logs.length, 0)
    for (const contents of ['[', '[]', 'null', 'true']) {
      writeFileSync(config, contents)
      assert.equal(readConfigFile(config, message => logs.push(message)), null)
    }
    assert.equal(logs.length, 4)
    assert.ok(logs.every(message => message.startsWith('config.json ')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function harness(values: Record<string, unknown> = {}, legacy: ConfigFile | null = null,
  readState?: (signal: AbortSignal) => Promise<PresenceState | null>,
  updatePlugin: () => Promise<PluginUpdateResult> = async () => ({ status: 'up-to-date', version: '0.2.4' })) {
  const settings = new Map(Object.entries(values))
  const commands = new Map<string, () => Promise<unknown>>()
  const events = new Map<string, () => void>()
  const changes = new Set<(event: { key: string }) => void>()
  const reads: string[] = []
  const writes: [string, boolean][] = []
  const logs: string[] = []
  const statuses: Record<string, string>[] = []
  const privacyStatuses: Record<string, string>[] = []
  const statusBarCalls: Record<string, string>[] = []
  const activities: PresenceActivity[] = []
  const order: string[] = []
  let signal: AbortSignal | null = null
  let get = async (key: string): Promise<unknown> => settings.get(key)
  let stateReads = 0
  let connected = false
  let publishStatus: ((status: PresenceRuntimeStatus) => void) | null = null
  const orca: PluginApi = {
    log: message => { logs.push(message) },
    settings: {
      get: key => { reads.push(key); return get(key) },
      set: async (key, value) => {
        writes.push([key, value]); settings.set(key, value)
        changes.forEach(handler => handler({ key }))
      },
      onDidChange: handler => { changes.add(handler); return { dispose: () => { changes.delete(handler) } } }
    },
    commands: { register: (id, handler) => {
      commands.set(id, handler); return { dispose: () => { commands.delete(id) } }
    } },
    events: { on: (event, handler) => {
      events.set(event, handler); return { dispose: () => { events.delete(event) } }
    } },
    host: { call: async (method, params) => {
      assert.equal(method, 'statusBar.update')
      statusBarCalls.push(params)
      assert.ok(params.id === 'presence' || params.id === 'incognito')
      const updates = params.id === 'presence' ? statuses : privacyStatuses
      updates.push(params)
    } }
  }
  const lifecycle = createPluginLifecycle(orca, legacy, (enabled, incognito, abort, onStatus) => {
    publishStatus = onStatus
    signal = abort
    return createPluginSession({
      config: { clientId: DEFAULT_CLIENT_ID, pollMs: DEFAULT_POLL_MS, useUploadedArt: false },
      enabled, incognito, onStatus, log: orca.log, scheduleInterval: () => () => {},
      readState: async () => {
        stateReads += 1
        if (readState) return readState(abort)
        return { projectName: 'secret-project', branchName: 'secret-branch', agentType: 'omp', runningAgentCount: 1, agentActive: true }
      },
      transport: {
        apply: async (activity, canPublish) => {
          if (canPublish?.() === false) return false
          activities.push(activity); order.push('apply'); connected = true; return true
        },
        clear: async () => { order.push('clear'); connected = false; return true },
        destroy: async () => { order.push('destroy'); connected = false },
        isConnected: () => connected, connectionGeneration: () => 0
      }
    })
  }, updatePlugin)
  return {
    lifecycle, commands, events, changes, reads, writes, logs, statuses, privacyStatuses, statusBarCalls, activities, order,
    stateReads: () => stateReads, signal: () => signal,
    setGet: (handler: typeof get) => { get = handler },
    publishStatus: (status: PresenceRuntimeStatus) => publishStatus?.(status),
    change: (key: string, value: unknown) => { settings.set(key, value); changes.forEach(handler => handler({ key })) }
  }
}

it('exposes update as a plugin-page command while keeping only presence and privacy in the status bar', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.contributes.statusBarItems.map((entry: { id: string }) => entry.id), ['presence', 'incognito'])
  assert.ok(manifest.contributes.commands.some((entry: { id: string }) => entry.id === 'presence.update'))
  const h = harness()
  try {
    await h.lifecycle.activate()
    assert.ok(h.commands.has('presence.update'))
  } finally { await h.lifecycle.deactivate() }
})

it('starts updates only on click and coalesces clicks without blocking the command or RPC', async () => {
  const gate = deferred<{ status: 'up-to-date'; version: string }>()
  let calls = 0
  const h = harness({ enabled: false, incognito: true }, null, undefined, () => { calls += 1; return gate.promise })
  try {
    await h.lifecycle.activate()
    assert.equal(calls, 0)
    const command = h.commands.get('presence.update')
    assert.ok(command)
    let returned = false
    let result: unknown
    void command().then(value => { result = value; returned = true })
    await setImmediate()
    assert.equal(returned, true)
    assert.equal(result, 'Checking for RPC updates. See Logs below.')
    assert.equal(await command(), 'An RPC update is already running. See Logs below.')
    assert.equal(calls, 1)
    assert.ok(h.logs.includes('Checking for RPC updates.'))
    assert.equal(h.activities.length, 0)
    assert.deepEqual(h.writes, [])
    gate.resolve({ status: 'up-to-date', version: '0.2.4' })
    await setImmediate()
    assert.ok(h.logs.includes('RPC is up to date (version 0.2.4).'))
    assert.ok(h.statusBarCalls.every(call => call.id !== 'update'))
  } finally {
    gate.resolve({ status: 'up-to-date', version: '0.2.4' })
    await h.lifecycle.deactivate()
  }
})

it('shows update errors without stopping presence and permits another attempt', async () => {
  let fail = true
  const h = harness({ incognito: false }, null, undefined, async () => {
    if (fail) throw new Error('Updating requires Orca 1.4.253 or newer.')
    return { status: 'up-to-date', version: '0.2.4' }
  })
  try {
    await h.lifecycle.activate()
    await setImmediate()
    await h.commands.get('presence.update')!()
    await setImmediate()
    assert.ok(h.logs.some(line => line.includes('1.4.253')))
    assert.equal(h.order.includes('clear'), false)
    assert.ok(h.activities.length > 0)
    fail = false
    await h.commands.get('presence.update')!()
    await setImmediate()
    assert.ok(h.logs.includes('RPC is up to date (version 0.2.4).'))
    assert.ok(h.statusBarCalls.every(call => call.id !== 'update'))
  } finally { await h.lifecycle.deactivate() }
})

it('does not wait for a self-update during shutdown or log late results', async () => {
  for (const fail of [false, true]) {
    const gate = deferred<{ status: 'up-to-date'; version: string }>()
    const h = harness({}, null, undefined, async () => {
      const result = await gate.promise
      if (fail) throw new Error('late update error')
      return result
    })
    try {
      await h.lifecycle.activate()
      const command = h.commands.get('presence.update')!
      await command()
      let stopped = false
      const shutdown = h.lifecycle.deactivate().then(() => { stopped = true })
      await setImmediate()
      assert.equal(stopped, true)
      await shutdown
      const count = h.logs.length
      gate.resolve({ status: 'up-to-date', version: '0.2.4' })
      await setImmediate()
      assert.equal(h.logs.length, count)
      await command()
      assert.equal(h.logs.length, count)
      assert.equal(h.commands.size, 0)
    } finally {
      gate.resolve({ status: 'up-to-date', version: '0.2.4' })
      await h.lifecycle.deactivate()
    }
  }
})

it('logs updated and pinned outcomes without creating status bar controls', async () => {
  for (const [status, text] of [
    ['updated', 'Updated RPC to version 0.3.0.'],
    ['pinned', 'RPC version 0.3.0 is pinned. Install a version tag or branch to follow updates.']
  ] as const) {
    const h = harness({}, null, undefined, async () => ({ status, version: '0.3.0' }))
    try {
      await h.lifecycle.activate()
      await h.commands.get('presence.update')!()
      await setImmediate()
      assert.ok(h.logs.includes(text))
      assert.ok(h.statusBarCalls.every(call => call.id !== 'update'))
    } finally { await h.lifecycle.deactivate() }
  }
})

it('migrates only a legacy boolean before the first push and preserves saved Incognito', async () => {
  for (const [saved, legacy, expected, migrated] of [
    [undefined, true, true, true], [undefined, 'true', false, true], [false, true, false, false]
  ] as const) {
    const h = harness({ incognito: saved }, { incognito: legacy })
    try {
      await h.lifecycle.activate()
      await setImmediate()
      assert.deepEqual(h.writes, migrated ? [['incognito', expected]] : [])
      assert.equal(h.activities[0]?.state, expected ? '📁 Private Project' : '📁 secret-project')
      if (expected) assert.ok(!JSON.stringify(h.activities).includes('secret-branch'))
    } finally { await h.lifecycle.deactivate() }
  }
})

it('rejects invalid saved booleans without creating a session or subscriptions', async () => {
  for (const values of [{ incognito: 'true' }, { incognito: true, enabled: 'true' }]) {
    const h = harness(values)
    await assert.rejects(h.lifecycle.activate(), /setting must be boolean/)
    assert.equal(h.signal(), null)
    assert.equal(h.commands.size + h.events.size + h.changes.size, 0)
    await h.lifecycle.deactivate()
  }
})

it('returns from activation during the first read and aborts it before final cleanup', async () => {
  const started = deferred<void>()
  const h = harness({ incognito: true }, null, async signal => {
    started.resolve()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { h.order.push('abort'); reject(new Error('reader aborted')) }, { once: true })
    })
    return null
  })
  await h.lifecycle.activate()
  await started.promise
  assert.equal(h.stateReads(), 1)
  assert.equal(h.statuses[0]?.text, 'RPC waiting')
  await h.lifecycle.deactivate()
  await h.lifecycle.deactivate()
  assert.equal(h.signal()?.aborted, true)
  assert.deepEqual(h.order, ['abort', 'clear', 'destroy'])
  assert.equal(h.commands.size + h.events.size + h.changes.size, 0)
})

it('cancels bootstrap while an awaited host setting is pending', async () => {
  const gate = deferred<unknown>()
  const h = harness()
  h.setGet(() => gate.promise)
  const activation = h.lifecycle.activate()
  await h.lifecycle.deactivate()
  gate.resolve(undefined)
  await activation
  assert.equal(h.signal(), null)
  assert.deepEqual(h.writes, [])
  assert.equal(h.commands.size + h.events.size + h.changes.size, 0)
})

it('wires native pause/resume, both event refreshes, and live privacy changes', async () => {
  const h = harness({ incognito: false })
  try {
    await h.lifecycle.activate()
    await setImmediate()
    assert.equal(h.statuses.at(-1)?.text, 'RPC')
    assert.deepEqual([...h.events.keys()], ['workspace.changed', 'agent.status.changed'])
    h.events.get('workspace.changed')!()
    await setImmediate()
    h.events.get('agent.status.changed')!()
    await setImmediate()
    assert.equal(h.stateReads(), 3)
    const toggle = h.commands.get('presence.toggle')!
    await toggle()
    await setImmediate()
    assert.equal(h.statuses.at(-1)?.text, 'RPC paused')
    h.events.get('workspace.changed')!()
    await setImmediate()
    assert.equal(h.stateReads(), 3)
    await toggle()
    await setImmediate()
    assert.equal(h.activities.length, 2)
    h.change('incognito', true)
    await setImmediate()
    assert.deepEqual(h.order, ['apply', 'clear', 'apply', 'clear', 'apply'])
    assert.equal(h.activities.at(-1)?.state, '📁 Private Project')
    assert.ok(!JSON.stringify(h.activities.at(-1)).includes('secret-branch'))
  } finally { await h.lifecycle.deactivate() }
})

it('orders setting reads and skips queued changes after deactivation', async () => {
  const h = harness({ incognito: true, enabled: false })
  const gate = deferred<unknown>()
  await h.lifecycle.activate()
  h.reads.length = 0
  h.setGet(key => key === 'enabled' ? gate.promise : Promise.resolve(false))
  h.change('enabled', true)
  h.change('incognito', false)
  await setImmediate()
  assert.deepEqual(h.reads, ['enabled'])
  await h.lifecycle.deactivate()
  gate.resolve(true)
  await setImmediate()
  assert.deepEqual(h.reads, ['enabled'])
  assert.equal(h.stateReads(), 0)
})

it('forwards Incognito intent during a pending resume before publishing any public activity', async () => {
  const started = deferred<void>()
  const gate = deferred<void>()
  const h = harness({ incognito: false, enabled: false }, null, async () => {
    started.resolve()
    await gate.promise
    return { projectName: 'secret-project', branchName: 'secret-branch', agentType: 'omp', runningAgentCount: 1, agentActive: true }
  })
  try {
    await h.lifecycle.activate()
    h.change('enabled', true)
    await started.promise
    h.change('incognito', true)
    await setImmediate()
    gate.resolve()
    await setImmediate()
    assert.equal(h.activities.length, 1)
    assert.equal(h.activities[0]?.state, '📁 Private Project')
    assert.ok(!JSON.stringify(h.activities).includes('secret-project'))
    assert.ok(!JSON.stringify(h.activities).includes('secret-branch'))
    assert.deepEqual(h.order, ['clear', 'apply'])
  } finally {
    gate.resolve()
    await h.lifecycle.deactivate()
  }
})

it('logs an invalid live setting and continues processing the next valid change', async () => {
  const h = harness({ incognito: true, enabled: false })
  try {
    await h.lifecycle.activate()
    h.change('enabled', 'true')
    await setImmediate()
    assert.ok(h.logs.some(message => /enabled setting must be boolean/.test(message)))
    assert.equal(h.stateReads(), 0)
    await assert.rejects(h.commands.get('presence.toggle')!(), /enabled setting must be boolean/)
    h.change('enabled', true)
    await setImmediate()
    assert.equal(h.activities[0]?.state, '📁 Private Project')
  } finally { await h.lifecycle.deactivate() }
})

it('shows safe failures while waiting and paused help after a previous failure', async () => {
  const h = harness({ incognito: true })
  await h.lifecycle.activate()
  await setImmediate()
  try {
    const status: PresenceRuntimeStatus = {
      discordConnected: false, orcaRunning: true, paused: false,
      lastActivity: null, lastPushAt: null, lastError: 'Discord RPC login failed (code: 1)'
    }
    h.publishStatus(status)
    assert.equal(h.statuses.at(-1)?.text, 'RPC waiting')
    assert.equal(h.statuses.at(-1)?.tooltip, status.lastError)
    h.publishStatus({ ...status, paused: true })
    assert.equal(h.statuses.at(-1)?.text, 'RPC paused')
    assert.equal(h.statuses.at(-1)?.tooltip, 'Discord Rich Presence paused: click to resume')
    h.publishStatus({ ...status, discordConnected: true, lastError: null })
    assert.equal(h.statuses.at(-1)?.text, 'RPC')
    assert.equal(h.statuses.at(-1)?.tooltip, 'Discord Rich Presence: click to pause or resume')
  } finally { await h.lifecycle.deactivate() }
})

it('declares a direct Incognito control next to RPC using a contributed command', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const item = manifest.contributes.statusBarItems.find((entry: { id: string }) => entry.id === 'incognito')
  assert.ok(item)
  assert.equal(item.command, 'presence.incognito.toggle')
  assert.ok(manifest.contributes.commands.some((entry: { id: string }) => entry.id === item.command))
})

it('toggles Incognito from the status bar and synchronizes external settings changes', async () => {
  const h = harness({ incognito: false })
  try {
    await h.lifecycle.activate()
    await setImmediate()
    assert.equal(h.privacyStatuses.at(-1)?.text, 'Incognito Off')
    const toggle = h.commands.get('presence.incognito.toggle')
    assert.ok(toggle)
    await toggle()
    await setImmediate()
    assert.deepEqual(h.writes.at(-1), ['incognito', true])
    assert.equal(h.privacyStatuses.at(-1)?.text, 'Incognito On')
    assert.equal(h.activities.at(-1)?.state, '📁 Private Project')
    h.change('incognito', false)
    await setImmediate()
    assert.equal(h.privacyStatuses.at(-1)?.text, 'Incognito Off')
    assert.equal(h.activities.at(-1)?.state, '📁 secret-project')
  } finally { await h.lifecycle.deactivate() }
})

it('keeps RPC paused when the status-bar Incognito control changes privacy', async () => {
  const h = harness({ incognito: false, enabled: false })
  try {
    await h.lifecycle.activate()
    await setImmediate()
    const toggle = h.commands.get('presence.incognito.toggle')
    assert.ok(toggle)
    await toggle()
    await setImmediate()
    assert.equal(h.privacyStatuses.at(-1)?.text, 'Incognito On')
    assert.equal(h.statuses.at(-1)?.text, 'RPC paused')
    assert.equal(h.activities.length, 0)
    assert.ok(h.writes.every(([key]) => key === 'incognito'))
  } finally { await h.lifecycle.deactivate() }
})

it('rejects invalid Incognito values and skips a pending status-bar toggle on shutdown', async () => {
  const h = harness({ incognito: false })
  await h.lifecycle.activate()
  await setImmediate()
  const toggle = h.commands.get('presence.incognito.toggle')
  assert.ok(toggle)
  h.change('incognito', 'true')
  await setImmediate()
  await assert.rejects(toggle(), /incognito setting must be boolean/)
  assert.deepEqual(h.writes, [])
  const gate = deferred<unknown>()
  h.setGet(() => gate.promise)
  const pending = toggle()
  await setImmediate()
  const count = h.privacyStatuses.length
  await h.lifecycle.deactivate()
  gate.resolve(true)
  await pending
  assert.deepEqual(h.writes, [])
  assert.equal(h.privacyStatuses.length, count)
  assert.equal(h.commands.size, 0)
})

it('applies status-bar privacy intent before a pending resume can publish a public activity', async () => {
  const started = deferred<void>()
  const gate = deferred<void>()
  const h = harness({ incognito: false, enabled: false }, null, async () => {
    started.resolve()
    await gate.promise
    return { projectName: 'secret-project', branchName: 'secret-branch', agentType: 'omp', runningAgentCount: 1, agentActive: true }
  })
  try {
    await h.lifecycle.activate()
    h.change('enabled', true)
    await started.promise
    await h.commands.get('presence.incognito.toggle')!()
    await setImmediate()
    gate.resolve()
    await setImmediate()
    assert.equal(h.activities.length, 1)
    assert.equal(h.activities[0]?.state, '📁 Private Project')
    assert.ok(!JSON.stringify(h.activities).includes('secret-'))
    assert.equal(h.privacyStatuses.at(-1)?.text, 'Incognito On')
  } finally { gate.resolve(); await h.lifecycle.deactivate() }
})
