import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { pluginDiscordPaths } from './plugin-platform.ts'
import type { DiscordRpcClientLike } from './discord.ts'
import type { PresenceActivity } from './presence.ts'

const MAX_FRAME_BYTES = 1024 * 1024
type SocketPath = { platform: readonly NodeJS.Platform[]; format(id: number): string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const error = (code: string | number): Error => Object.assign(new Error('Discord IPC request failed'), { code })
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function peerError(value: unknown): Error {
  return error(record(value) && typeof value.code === 'number' && Number.isSafeInteger(value.code) ? value.code : 0)
}
function activityPayload(input: PresenceActivity): Record<string, unknown> {
  const assets: Record<string, string> = {}
  for (const [key, value] of [
    ['large_image', input.largeImageKey || input.largeImageUrl], ['large_text', input.largeImageText],
    ['small_image', input.smallImageKey || input.smallImageUrl], ['small_text', input.smallImageText]
  ]) if (key && value) assets[key] = value
  const start = input.startTimestamp.getTime()
  return { type: 0, created_at: Date.now(), instance: false,
    ...(input.details ? { details: input.details } : {}), ...(input.state ? { state: input.state } : {}),
    ...(Number.isFinite(start) ? { timestamps: { start } } : {}),
    ...(Object.keys(assets).length ? { assets } : {}), ...(input.buttons?.length ? { buttons: input.buttons } : {}) }
}
function defaultPaths(): SocketPath[] {
  const uid = process.getuid?.()
  const runtime = process.env.XDG_RUNTIME_DIR ||
    (process.platform === 'linux' && uid !== undefined ? `/run/user/${uid}` : undefined)
  return pluginDiscordPaths(process.platform, tmpdir(), runtime)
}

export function createDiscordIpcClient(clientId: string, paths: readonly SocketPath[] = defaultPaths()): DiscordRpcClientLike {
  const events = new EventEmitter()
  const pending = new Map<string, Pending>()
  const candidates = [...new Set(paths.filter(path => path.platform.includes(process.platform))
    .flatMap(path => Array.from({ length: 10 }, (_, id) => path.format(id))))]
  let socket: Socket | null = null
  let buffer: Buffer = Buffer.alloc(0)
  let connected = false
  let ended = false
  let closing = Promise.resolve()
  let loginJob: Promise<void> | null = null
  let resolveLogin: (() => void) | null = null
  let rejectLogin: ((reason: Error) => void) | null = null
  let loginTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stale: ReturnType<typeof setTimeout> | undefined
  let ping: string | null = null

  const stop = (reason: Error): void => {
    if (ended) return
    ended = true
    connected = false
    clearTimeout(loginTimer); clearTimeout(stale); clearInterval(heartbeat)
    rejectLogin?.(reason)
    resolveLogin = rejectLogin = null
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(reason) }
    pending.clear()
    buffer = Buffer.alloc(0)
    const current = socket
    socket = null
    if (current && !current.closed) {
      closing = new Promise<void>(resolve => current.once('close', resolve))
      current.destroy()
    }
    events.emit('disconnected')
  }
  const send = (opcode: number, payload: unknown): void => {
    if (ended || !socket) return
    try {
      // Why UTF-8 spelled out: the frame header counts bytes, and an emoji takes up to 4 per character.
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      if (body.length > MAX_FRAME_BYTES) { stop(error('FRAME_TOO_LARGE')); return }
      const header = Buffer.alloc(8)
      header.writeUInt32LE(opcode, 0); header.writeUInt32LE(body.length, 4)
      socket.write(Buffer.concat([header, body]), reason => { if (reason) stop(reason) })
    } catch { stop(error('INVALID_PAYLOAD')) }
  }
  const keepAlive = (): void => {
    clearTimeout(stale)
    stale = setTimeout(() => stop(error('HEARTBEAT_TIMEOUT')), 30000)
    stale.unref()
  }
  const receive = (chunk: Buffer): void => {
    if (ended) return
    buffer = Buffer.concat([buffer, chunk])
    while (!ended && buffer.length >= 8) {
      const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4)
      if (length > MAX_FRAME_BYTES) { stop(error('FRAME_TOO_LARGE')); return }
      if (buffer.length < 8 + length) return
      const bytes = buffer.subarray(8, 8 + length)
      buffer = buffer.subarray(8 + length)
      let payload: unknown
      try { payload = length ? JSON.parse(bytes.toString('utf8')) : null }
      catch { stop(error('INVALID_FRAME')); return }
      if (opcode === 2) { stop(peerError(payload)); return }
      if (opcode === 3) { send(4, payload); continue }
      if (opcode === 4) { if (payload === ping) keepAlive(); continue }
      if (opcode !== 1 || !record(payload)) { stop(error('INVALID_FRAME')); return }
      if (!connected && payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
        if (!record(payload.data) || !record(payload.data.user)) { stop(error('INVALID_FRAME')); return }
        connected = true
        clearTimeout(loginTimer)
        resolveLogin?.()
        resolveLogin = rejectLogin = null
        keepAlive()
        heartbeat = setInterval(() => { ping = randomUUID(); send(3, ping) }, 5000)
        heartbeat.unref()
        continue
      }
      if (payload.cmd !== 'SET_ACTIVITY' || typeof payload.nonce !== 'string') continue
      const job = pending.get(payload.nonce)
      if (!job) continue
      pending.delete(payload.nonce)
      clearTimeout(job.timer)
      if (payload.evt === 'ERROR') job.reject(peerError(payload.data))
      else job.resolve(payload.data)
    }
  }
  const connectPath = (path: string): Promise<Socket> => new Promise((resolve, reject) => {
    const candidate = createConnection(path)
    socket = candidate
    const cleanup = (): void => {
      candidate.removeListener('connect', accept); candidate.removeListener('error', refuse); candidate.removeListener('close', closed)
    }
    const refuse = (reason: Error): void => {
      cleanup()
      if (socket === candidate) socket = null
      candidate.destroy()
      reject(reason)
    }
    const closed = (): void => refuse(error(0))
    const accept = (): void => { cleanup(); resolve(candidate) }
    candidate.once('connect', accept); candidate.once('error', refuse); candidate.once('close', closed)
  })
  const open = async (): Promise<void> => {
    for (const path of candidates) {
      if (ended) return
      let candidate: Socket
      try { candidate = await connectPath(path) }
      catch { if (ended) return; continue }
      if (ended || socket !== candidate) { candidate.destroy(); return }
      candidate.on('data', receive)
      candidate.on('error', stop)
      candidate.on('close', () => stop(error(0)))
      send(0, { v: 1, client_id: clientId })
      return
    }
    stop(error(2))
  }
  const request = (activity: Record<string, unknown> | null): Promise<unknown> => {
    if (!connected || ended) return Promise.reject(error(4))
    return new Promise((resolve, reject) => {
      const nonce = randomUUID()
      const timer = setTimeout(() => { pending.delete(nonce); reject(error(5)) }, 60000)
      pending.set(nonce, { resolve, reject, timer })
      send(1, { cmd: 'SET_ACTIVITY', nonce, args: { pid: process.pid, activity } })
    })
  }
  const user = { setActivity: (activity: PresenceActivity) => request(activityPayload(activity)),
    clearActivity: async (): Promise<void> => { await request(null) } }
  return {
    on: (event, listener) => events.on(event, listener),
    login: () => {
      if (ended) return Promise.reject(error(0))
      if (loginJob) return loginJob
      loginJob = new Promise<void>((resolve, reject) => {
        resolveLogin = resolve; rejectLogin = reject
        loginTimer = setTimeout(() => stop(error(1)), 10000)
        void open().catch(() => stop(error(2)))
      })
      return loginJob
    },
    destroy: async () => { stop(error(0)); await closing },
    get user() { return connected && !ended ? user : undefined }
  }
}
