import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { createDiscordIpcClient } from './discord-ipc.ts'
import { createDiscordPresence } from './discord.ts'
import { createPresenceController, type PresenceState } from './presence-controller.ts'
import { buildActivity } from './presence.ts'
import { buildPluginActivity } from './plugin-presence.ts'

type Message = { v?: number; client_id?: string; cmd?: string; evt?: string; nonce?: string;
  args?: { pid: number; activity?: { details?: string; state?: string; timestamps?: { start: number };
    assets?: Record<string, string>; buttons?: unknown } | null } }
function frame(opcode: number, body: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(body))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(opcode, 0)
  header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data])
}
const ready = () => frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { id: '1' } } })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function peer(handle: (opcode: number, message: Message, socket: Socket) => void) {
  const name = 'orca-rpc-test-' + randomUUID().slice(0, 8)
  const path = process.platform === 'win32' ? String.raw`\\?\pipe\${name}` : join(tmpdir(), name + '.sock')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4)
        if (buffer.length < 8 + length) return
        const body = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8')) as Message
        buffer = buffer.subarray(8 + length)
        handle(opcode, body, socket)
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return { path, close: async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
const paths = (path: string) => [{ platform: [process.platform], format: () => path }]
const activity = { details: 'Codex · Working', state: '📁 sample',
  startTimestamp: new Date('2026-11-07T00:00:00Z'), largeImageKey: 'orca', largeImageText: 'Orca',
  smallImageUrl: 'https://example.com/codex.png', smallImageText: 'GPT-6.1 Sol',
  buttons: [{ label: 'View Repository', url: 'https://github.com/owner/repo' }] }

it('handshakes and preserves activity assets, model, buttons, millisecond timer and clear acknowledgement', async () => {
  const received: Message[] = []
  const server = await peer((opcode, message, socket) => {
    received.push(message)
    socket.write(opcode === 0 ? ready() : frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} }))
  })
  const client = createDiscordIpcClient('123', paths(server.path))
  const presence = createDiscordPresence('123', () => client)
  try {
    assert.equal(await presence.apply(activity), true)
    assert.deepEqual(received[0], { v: 1, client_id: '123' })
    const payload = received[1]?.args
    assert.equal(payload?.pid, process.pid)
    assert.equal(payload?.activity?.details, activity.details)
    assert.equal(payload?.activity?.timestamps?.start, 1794009600000)
    assert.deepEqual(payload?.activity?.assets, { large_image: 'orca', large_text: 'Orca',
      small_image: 'https://example.com/codex.png', small_text: 'GPT-6.1 Sol' })
    assert.deepEqual(payload?.activity?.buttons, activity.buttons)
    assert.equal(await presence.clear(), true)
    assert.equal(received.at(-1)?.args?.activity, null)
    assert.equal(presence.isConnected(), false)
    assert.equal(await presence.apply({ ...activity, state: '📁 Private Project', buttons: undefined }), true)
    assert.equal(received.filter(message => message.client_id).length, 1)
  } finally { await presence.destroy(); await server.close() }
})

it('omits missing or invalid optional timestamps and only clears on explicit clear', async () => {
  const now = Date.UTC(2026, 10, 8)
  mock.timers.enable({ apis: ['Date'], now })
  const received: Message[] = []
  const server = await peer((opcode, message, socket) => {
    received.push(message)
    socket.write(opcode === 0 ? ready()
      : frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} }))
  })
  const presence = createDiscordPresence('123',
    () => createDiscordIpcClient('123', paths(server.path)))
  try {
    assert.equal(await presence.apply(activity), true)
    assert.equal(await presence.apply({ details: '', state: '' }), true)
    assert.equal(presence.isConnected(), true)
    assert.deepEqual(received.at(-1)?.args?.activity, {
      type: 0, created_at: now, instance: false
    })
    assert.equal(await presence.apply({
      details: '', state: '', startTimestamp: new Date(Number.NaN)
    }), true)
    assert.deepEqual(received.at(-1)?.args?.activity, {
      type: 0, created_at: now, instance: false
    })
    assert.equal(received.filter(message => message.client_id).length, 1)
    assert.equal(await presence.clear(), true)
    assert.equal(received.at(-1)?.args?.activity, null)
    assert.equal(presence.isConnected(), false)
  } finally {
    await presence.destroy()
    await server.close()
    mock.timers.reset()
  }
})

it('sends the original elapsed timestamp through empty workspace and agent transitions in both layouts', async () => {
  for (const build of [buildActivity, buildPluginActivity]) {
    const start = Date.UTC(2026, 10, 8)
    let time = start
    const rich: PresenceState = {
      projectName: 'sample', agentType: 'codex', model: 'test-model',
      runningAgentCount: 1, agentActive: true, branchName: 'main'
    }
    let state = rich
    const received: Message[] = []
    const server = await peer((opcode, message, socket) => {
      received.push(message)
      socket.write(opcode === 0 ? ready()
        : frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} }))
    })
    const presence = createDiscordPresence('123',
      () => createDiscordIpcClient('123', paths(server.path)))
    const controller = createPresenceController({
      readState: async () => state, buildActivity: build, now: () => new Date(time),
      apply: activity => presence.apply(activity), clear: () => presence.clear()
    })
    try {
      for (const next of [
        rich,
        { projectName: null, agentType: null, runningAgentCount: 0, agentActive: false, branchName: null },
        { ...rich, agentType: null, model: null, runningAgentCount: 0, agentActive: false },
        rich
      ]) {
        state = next
        await controller.poll()
        time += 300000
      }
      const sent = received.filter(message => message.cmd === 'SET_ACTIVITY').map(message => message.args?.activity)
      assert.deepEqual(sent.map(activity => activity?.timestamps?.start), [start, start, start, start])
      for (const activity of sent.slice(1, 3)) {
        assert.ok(activity)
        assert.equal(activity.details, undefined)
        assert.equal(activity.state, undefined)
        assert.equal(activity.assets, undefined)
        assert.equal(activity.buttons, undefined)
      }
    } finally {
      await presence.destroy()
      await server.close()
    }
  }
})

it('counts UTF-8 bytes in the frame header so emoji and CJK text arrive intact', async () => {
  const received: Message[] = []
  const server = await peer((opcode, message, socket) => {
    received.push(message)
    socket.write(opcode === 0 ? ready() : frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} }))
  })
  const client = createDiscordIpcClient('123', paths(server.path))
  const presence = createDiscordPresence('123', () => client)
  const state = '📁 日本語-👨‍👩‍👧-🇯🇵'
  try {
    assert.equal(await presence.apply({ ...activity, state }), true)
    assert.equal(received[1]?.args?.activity?.state, state)
    assert.ok(Buffer.byteLength(state, 'utf8') > state.length)
  } finally { await presence.destroy(); await server.close() }
})

it('waits for complete fragmented READY and reply frames', async () => {
  const first = deferred(), release = deferred()
  const server = await peer((opcode, message, socket) => {
    const bytes = opcode === 0 ? ready() : frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} })
    socket.write(bytes.subarray(0, 3))
    if (opcode === 0) {
      first.resolve()
      void release.promise.then(() => socket.write(bytes.subarray(3)))
    } else { void delay(10).then(() => socket.write(bytes.subarray(3))) }
  })
  const client = createDiscordIpcClient('1', paths(server.path))
  let loggedIn = false
  try {
    const login = client.login().then(() => { loggedIn = true })
    await first.promise
    await setImmediate()
    assert.equal(loggedIn, false)
    release.resolve()
    await login
    await client.user!.setActivity(activity)
  } finally { release.resolve(); await client.destroy(); await server.close() }
})

it('does not acknowledge a wrong nonce or an unrelated event', async () => {
  const requested = deferred(), acknowledge = deferred()
  const server = await peer((opcode, message, socket) => {
    if (opcode === 0) { socket.write(ready()); return }
    socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: 'unrelated', data: {} }))
    socket.write(frame(1, { cmd: 'DISPATCH', evt: 'OTHER', data: {} }))
    requested.resolve()
    void acknowledge.promise.then(() => socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} })))
  })
  const client = createDiscordIpcClient('1', paths(server.path))
  let cleared = false
  try {
    await client.login()
    const clearing = client.user!.clearActivity().then(() => { cleared = true })
    await requested.promise
    await setImmediate()
    assert.equal(cleared, false)
    acknowledge.resolve()
    await clearing
    assert.equal(cleared, true)
  } finally { acknowledge.resolve(); await client.destroy(); await server.close() }
})

it('preserves rejection codes without exposing the peer error message', async () => {
  const server = await peer((opcode, message, socket) => socket.write(opcode === 0 ? ready() :
    frame(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, evt: 'ERROR', data: { code: 4000, message: 'secret-project' } })))
  const presence = createDiscordPresence('1', () => createDiscordIpcClient('1', paths(server.path)))
  try {
    assert.equal(await presence.apply(activity), false)
    assert.equal(presence.lastError?.(), 'Discord RPC apply failed (code: 4000)')
    assert.equal(await presence.clear(), false)
    assert.ok(!presence.lastError?.()?.includes('secret-project'))
  } finally { await presence.destroy(); await server.close() }
})

it('tries missing paths before a usable socket and reports handshake CLOSE safely', async () => {
  const server = await peer((_opcode, _message, socket) => socket.write(frame(2, { code: 4000, message: 'private-client' })))
  const client = createDiscordIpcClient('1', [{ platform: [process.platform],
    format: id => id === 0 ? server.path + '-missing' : server.path }])
  try { await assert.rejects(client.login(), { code: 4000 }) }
  finally { await client.destroy(); await server.close() }
})

it('rejects oversized or malformed frames and a READY with missing user metadata', async () => {
  const oversized = Buffer.alloc(8)
  oversized.writeUInt32LE(1, 0); oversized.writeUInt32LE(1024 * 1024 + 1, 4)
  const malformed = Buffer.alloc(9)
  malformed.writeUInt32LE(1, 0); malformed.writeUInt32LE(1, 4); malformed[8] = 123
  for (const bytes of [oversized, malformed, frame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })]) {
    const server = await peer((_opcode, _message, socket) => socket.write(bytes))
    const client = createDiscordIpcClient('1', paths(server.path))
    try { await assert.rejects(client.login()); assert.equal(client.user, undefined) }
    finally { await client.destroy(); await server.close() }
  }
})

it('destroy cancels deferred login and requests, with one disconnect notification', async () => {
  for (const pendingRequest of [false, true]) {
    const waiting = deferred()
    const server = await peer((opcode, _message, socket) => {
      if (opcode === 0 && pendingRequest) socket.write(ready())
      else waiting.resolve()
    })
    const client = createDiscordIpcClient('1', paths(server.path))
    let disconnected = 0
    client.on('disconnected', () => { disconnected += 1 })
    try {
      const job = pendingRequest ? client.login().then(() => client.user!.clearActivity()) : client.login()
      const rejected = assert.rejects(job, { code: 0 })
      await waiting.promise
      await client.destroy()
      await rejected
      await client.destroy()
      assert.equal(client.user, undefined)
      assert.equal(disconnected, 1)
    } finally { await client.destroy(); await server.close() }
  }
})

it('times out login and unanswered requests and replies to peer pings', async () => {
  for (const pendingRequest of [false, true]) {
    if (!pendingRequest) mock.timers.enable({ apis: ['setTimeout'] })
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
    let expireRequest: () => void = () => { throw new Error('No request deadline was scheduled') }
    const timerMock = pendingRequest ? mock.method(globalThis, 'setTimeout', (callback: () => void, ms?: number) => {
      const timer = originalSet(callback, ms)
      if (ms === 60000) expireRequest = () => { originalClear(timer); callback() }
      return timer
    }) : null
    const waiting = deferred()
    const server = await peer((opcode, message, socket) => {
      if (opcode === 0 && pendingRequest) socket.write(ready())
      else if (opcode === 3) socket.write(frame(4, message))
      else waiting.resolve()
    })
    const client = createDiscordIpcClient('1', paths(server.path))
    try {
      if (pendingRequest) await client.login()
      const job = pendingRequest ? client.user!.clearActivity() : client.login()
      const rejected = assert.rejects(job, { code: pendingRequest ? 5 : 1 })
      await waiting.promise
      if (pendingRequest) expireRequest()
      else mock.timers.tick(10000)
      await rejected
    } finally { await client.destroy(); await server.close(); timerMock?.mock.restore(); mock.timers.reset() }
  }
  const gotPong = deferred()
  const server = await peer((opcode, _message, socket) => {
    if (opcode === 0) { socket.write(ready()); socket.write(frame(3, 'ping-token')) }
    else if (opcode === 4) gotPong.resolve()
  })
  const client = createDiscordIpcClient('1', paths(server.path))
  try { await client.login(); await gotPong.promise }
  finally { await client.destroy(); await server.close() }
})

it('correlates simultaneous out-of-order responses and releases its heartbeat on teardown', async () => {
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval
  const set = mock.method(globalThis, 'setInterval', (callback: () => void, ms?: number) => {
    const timer = originalSet(callback, ms); intervals.add(timer); return timer
  })
  const clear = mock.method(globalThis, 'clearInterval', (timer: Parameters<typeof clearInterval>[0]) => {
    if (timer && typeof timer === 'object') intervals.delete(timer)
    originalClear(timer)
  })
  const requests: Message[] = []
  const server = await peer((opcode, message, socket) => {
    if (opcode === 0) { socket.write(ready()); return }
    requests.push(message)
    if (requests.length === 2) {
      socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: requests[1]!.nonce, data: 'second' }))
      socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: requests[0]!.nonce, data: 'first' }))
    }
  })
  const client = createDiscordIpcClient('1', paths(server.path))
  try {
    await client.login()
    assert.equal(intervals.size, 1)
    const results = await Promise.all([client.user!.setActivity(activity), client.user!.setActivity(activity)])
    assert.deepEqual(results, ['first', 'second'])
    await client.destroy()
    assert.equal(intervals.size, 0)
  } finally {
    await client.destroy(); await server.close()
    for (const timer of intervals) originalClear(timer)
    set.mock.restore(); clear.mock.restore()
  }
})

it('disconnects an unresponsive heartbeat and leaves publication unavailable', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const server = await peer((opcode, _message, socket) => { if (opcode === 0) socket.write(ready()) })
  const client = createDiscordIpcClient('1', paths(server.path))
  let disconnected = 0
  client.on('disconnected', () => { disconnected += 1 })
  try {
    await client.login()
    mock.timers.tick(30000)
    await client.destroy()
    assert.equal(disconnected, 1)
    assert.equal(client.user, undefined)
  } finally { await client.destroy(); await server.close(); mock.timers.reset() }
})
