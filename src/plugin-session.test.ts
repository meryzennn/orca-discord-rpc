import { it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CLIENT_ID, DEFAULT_POLL_MS } from './config.ts'
import type { PresenceState } from './presence-controller.ts'
import type { PresenceActivity } from './presence.ts'
import type { PresenceRuntimeStatus } from './runtime.ts'
import { createPluginSession } from './plugin-session.ts'
import { createDiscordPresence } from './discord.ts'

const state: PresenceState = {
  projectName: 'secret-project', agentType: 'omp', runningAgentCount: 1,
  agentActive: true, branchName: 'secret-branch', repoUrl: 'https://github.com/secret-owner/secret-repo'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function harness(options: {
  readState?: () => Promise<PresenceState | null>
  enabled?: boolean
  incognito?: boolean
  failClear?: boolean
  failDestroy?: boolean
  failCancel?: boolean
} = {}) {
  const order: string[] = []
  const pushed: PresenceActivity[] = []
  const statuses: PresenceRuntimeStatus[] = []
  const logs: string[] = []
  let connected = false
  let cancelled = 0
  let reads = 0
  let tick: (() => void) | null = null
  let generation = 0
  const session = createPluginSession({
    config: { clientId: DEFAULT_CLIENT_ID, pollMs: DEFAULT_POLL_MS, useUploadedArt: false },
    enabled: options.enabled ?? true,
    incognito: options.incognito ?? true,
    readState: async () => { reads += 1; return options.readState ? options.readState() : state },
    onStatus: status => { statuses.push(status) },
    log: message => { logs.push(message) },
    scheduleInterval: (fn, ms) => {
      assert.equal(ms, DEFAULT_POLL_MS)
      tick = fn
      return () => {
        cancelled += 1
        tick = null
        if (options.failCancel) throw new Error('cancel failed')
      }
    },
    transport: {
      apply: async (activity, canPublish) => {
        if (canPublish && !canPublish()) return false
        order.push('apply'); pushed.push(activity); connected = true; return true
      },
      clear: async () => {
        order.push('clear')
        if (options.failClear) throw new Error('clear failed')
        connected = false
        return true
      },
      destroy: async () => {
        order.push('destroy')
        connected = false
        if (options.failDestroy) throw new Error('destroy failed')
      },
      connectionGeneration: () => generation,
      isConnected: () => connected
    }
  })
  return {
    session, order, pushed, statuses, logs,
    cancelled: () => cancelled,
    reads: () => reads,
    tick: () => { tick?.() },
    disconnect: () => { connected = false; generation += 1 }
  }
}

it('redacts private state before the reused builder and clears before changing privacy', async () => {
  const h = harness()
  await h.session.refresh()
  const json = JSON.stringify(h.pushed[0])
  assert.ok(!json.includes('secret-project'))
  assert.ok(!json.includes('secret-branch'))
  assert.ok(!json.includes('secret-repo'))
  assert.equal(h.pushed[0]?.state, 'Folder: Private Project')
  assert.equal(h.pushed[0]?.details, 'Agent: Oh My Pi · Working')
  assert.equal(h.pushed[0]?.smallImageText, 'Agent: Oh My Pi')
  assert.equal(h.pushed[0]?.buttons, undefined)
  await h.session.setIncognito(false)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy', 'apply'])
  assert.equal(h.pushed[1]?.state, 'Folder: secret-project')
  assert.equal(h.pushed[1]?.smallImageText, 'Agent: Oh My Pi')
  assert.deepEqual(h.pushed[1]?.buttons, [{ label: 'View Repository', url: 'https://github.com/secret-owner/secret-repo' }])
  await h.session.stop()
})

it('applies new Incognito intent before a pending read can publish its result', async () => {
  const entered = deferred()
  const gate = deferred()
  const h = harness({ readState: async () => { entered.resolve(); await gate.promise; return state }, incognito: false })
  const first = h.session.refresh()
  await entered.promise
  const privateMode = h.session.setIncognito(true)
  gate.resolve()
  await Promise.all([first, privateMode])
  assert.ok(h.pushed.length > 0)
  assert.ok(h.pushed.every(activity => !JSON.stringify(activity).includes('secret-project')))
  await h.session.stop()
})

it('clears and closes the previous socket before a pending poll republishes changed privacy', async () => {
  const entered = deferred()
  const gate = deferred()
  let reads = 0
  const h = harness({ incognito: false, readState: async () => {
    reads += 1
    if (reads === 2) { entered.resolve(); await gate.promise }
    return state
  } })
  await h.session.refresh()
  const pending = h.session.refresh()
  await entered.promise
  const privateMode = h.session.setIncognito(true)
  gate.resolve()
  await Promise.all([pending, privateMode])
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy', 'apply'])
  assert.equal(h.pushed[1]?.state, 'Folder: Private Project')
  assert.ok(!JSON.stringify(h.pushed[1]).includes('secret-branch'))
  await h.session.stop()
})

it('coalesces event and interval refreshes while serializing pause behind a read', async () => {
  const entered = deferred()
  const gate = deferred()
  const h = harness({ readState: async () => { entered.resolve(); await gate.promise; return state } })
  const first = h.session.refresh()
  const second = h.session.refresh()
  assert.equal(first, second)
  await entered.promise
  h.tick()
  const paused = h.session.setEnabled(false)
  assert.deepEqual(h.order, [])
  gate.resolve()
  await Promise.all([first, second, paused])
  assert.equal(h.reads(), 1)
  assert.deepEqual(h.order, ['apply', 'clear'])
  assert.equal(h.cancelled(), 1)
  assert.equal(h.statuses.at(-1)?.paused, true)
  assert.equal(h.statuses.at(-1)?.discordConnected, false)
  await h.session.refresh()
  h.tick()
  assert.equal(h.reads(), 1)
  await h.session.setEnabled(true)
  assert.equal(h.reads(), 2)
  assert.equal(h.pushed.length, 2)
  assert.equal(h.statuses.at(-1)?.paused, false)
  assert.equal(h.statuses.at(-1)?.discordConnected, true)
  await h.session.stop()
})

it('starts paused and uses the latest privacy setting on resume', async () => {
  const h = harness({ enabled: false, incognito: false })
  assert.equal(h.statuses[0]?.paused, true)
  await h.session.refresh()
  await h.session.setIncognito(true)
  assert.equal(h.reads(), 0)
  assert.deepEqual(h.order, ['destroy'])
  await h.session.setEnabled(true)
  assert.equal(h.pushed[0]?.state, 'Folder: Private Project')
  await h.session.setEnabled(true)
  await h.session.setIncognito(true)
  assert.equal(h.reads(), 1)
  await h.session.stop()
})

it('drains an outstanding read before idempotent shutdown', async () => {
  const entered = deferred()
  const gate = deferred()
  const h = harness({ readState: async () => { entered.resolve(); await gate.promise; return state } })
  const first = h.session.refresh()
  await entered.promise
  const stopped = h.session.stop()
  assert.equal(h.session.stop(), stopped)
  assert.deepEqual(h.order, [])
  gate.resolve()
  await Promise.all([first, stopped])
  assert.equal(h.reads(), 1)
  assert.deepEqual(h.order, ['clear', 'destroy'])
  assert.equal(h.cancelled(), 1)
  const statusCount = h.statuses.length
  await h.session.refresh()
  await h.session.setEnabled(true)
  await h.session.setIncognito(false)
  await h.session.stop()
  h.tick()
  assert.equal(h.reads(), 1)
  assert.equal(h.statuses.length, statusCount)
  assert.equal(h.order.filter(value => value === 'destroy').length, 1)
})

function loginHarness() {
  const entered = deferred()
  const gate = deferred()
  const order: string[] = []
  const sent: PresenceActivity[] = []
  const transport = createDiscordPresence(DEFAULT_CLIENT_ID, () => ({
    on: () => {},
    login: async () => { order.push('login'); entered.resolve(); await gate.promise },
    destroy: async () => { order.push('destroy') },
    user: {
      setActivity: activity => {
        order.push(`send:${activity.state}`)
        sent.push(activity)
        return Promise.resolve({})
      },
      clearActivity: async () => { order.push('clear') }
    }
  }))
  const session = createPluginSession({
    config: { clientId: DEFAULT_CLIENT_ID, pollMs: DEFAULT_POLL_MS, useUploadedArt: false },
    enabled: true, incognito: false, readState: async () => state,
    transport, onStatus: () => {}, log: () => {}, scheduleInterval: () => () => {}
  })
  return { session, entered, gate, order, sent }
}

it('prevents a public request after Incognito intent during real transport login', async () => {
  const h = loginHarness()
  const pending = h.session.refresh()
  await h.entered.promise
  const privateMode = h.session.setIncognito(true)
  h.gate.resolve()
  await Promise.all([pending, privateMode])
  assert.deepEqual(h.order, ['login', 'clear', 'destroy', 'login', 'send:Folder: Private Project'])
  assert.equal(h.sent.length, 1)
  assert.ok(!JSON.stringify(h.sent).includes('secret-project'))
  assert.ok(!JSON.stringify(h.sent).includes('secret-branch'))
  await h.session.stop()
})

it('drains real transport login without publishing after shutdown intent', async () => {
  const h = loginHarness()
  const pending = h.session.refresh()
  await h.entered.promise
  const stopped = h.session.stop()
  assert.deepEqual(h.order, ['login'])
  h.gate.resolve()
  await Promise.all([pending, stopped])
  assert.deepEqual(h.order, ['login', 'clear', 'destroy'])
  assert.deepEqual(h.sent, [])
})

it('clears and destroys even if cancelling the interval throws on shutdown', async () => {
  const h = harness({ failCancel: true })
  await h.session.refresh()
  await assert.rejects(h.session.stop(), /cancel failed/)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy'])
})

it('destroys the transport even if final clear rejects and keeps shutdown idempotent', async () => {
  const h = harness({ failClear: true })
  await h.session.refresh()
  const stopped = h.session.stop()
  await assert.rejects(stopped, /clear failed/)
  assert.equal(h.session.stop(), stopped)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy'])
  assert.ok(h.logs.includes('clear failed'))
})

it('closes the old socket after a failed privacy clear before republishing', async () => {
  const h = harness({ incognito: false, failClear: true })
  await h.session.refresh()
  await h.session.setIncognito(true)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy', 'apply'])
  assert.equal(h.pushed[1]?.state, 'Folder: Private Project')
  assert.ok(h.logs.includes('clear failed'))
  await assert.rejects(h.session.stop(), /clear failed/)
})

it('closes the old public socket when privacy changes while paused after a failed clear', async () => {
  const h = harness({ incognito: false, failClear: true })
  await h.session.refresh()
  await assert.rejects(h.session.setEnabled(false), /clear failed/)
  await h.session.setIncognito(true)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy'])
  assert.equal(h.reads(), 1)
  await h.session.setEnabled(true)
  assert.equal(h.pushed[1]?.state, 'Folder: Private Project')
  await assert.rejects(h.session.stop(), /clear failed/)
})

it('does not republish if privacy socket destruction fails and permits later queued cleanup', async () => {
  const h = harness({ incognito: false, failDestroy: true })
  await h.session.refresh()
  await assert.rejects(h.session.setIncognito(true), /destroy failed/)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy'])
  await assert.rejects(h.session.stop(), /destroy failed/)
  assert.deepEqual(h.order, ['apply', 'clear', 'destroy', 'clear', 'destroy'])
})

it('reuses deduplication and reconnect retry without overlapping polls', async () => {
  const h = harness()
  await h.session.refresh()
  await h.session.refresh()
  assert.equal(h.pushed.length, 1)
  h.disconnect()
  h.tick()
  await h.session.refresh()
  assert.equal(h.pushed.length, 2)
  await h.session.stop()
})

it('clears absent workspaces and retries a failed read on the next refresh', async () => {
  let reads = 0
  const h = harness({ readState: async () => {
    reads += 1
    if (reads === 1) throw new Error('CLI unavailable')
    return reads === 2 ? state : null
  } })
  await h.session.refresh()
  assert.equal(h.pushed.length, 0)
  assert.equal(h.statuses.at(-1)?.lastError, 'CLI unavailable')
  assert.ok(h.logs.includes('CLI unavailable'))
  await h.session.refresh()
  assert.equal(h.pushed.length, 1)
  assert.equal(h.statuses.at(-1)?.lastError, null)
  await h.session.refresh()
  assert.deepEqual(h.order, ['apply', 'clear'])
  await h.session.stop()
})
