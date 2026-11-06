import { Client } from '@xhayper/discord-rpc'
import type { PresenceActivity } from './presence.ts'

export type DiscordPresence = {
  apply: (activity: PresenceActivity, canPublish?: () => boolean) => Promise<boolean>
  clear: () => Promise<boolean>
  destroy: () => Promise<void>
  /** Increments whenever the socket drops; a caller compares it to know a re-push is due. */
  connectionGeneration: () => number
  /** True while the client believes it holds a live session. */
  isConnected: () => boolean
}

/** The slice of the RPC client this transport uses, so a fake can stand in for it. */
export type DiscordRpcClientLike = {
  on(event: string, listener: () => void): unknown
  login(): Promise<void>
  destroy(): Promise<void>
  user?: {
    setActivity(activity: PresenceActivity): Promise<unknown>
    clearActivity(): Promise<void>
  }
}

/**
 * Wraps the RPC client with a connect-on-demand and a quiet failure mode:
 * Discord is frequently not running, and that must never take the daemon down.
 * A failed call reports false so the caller can retry on a later tick.
 */
export function createDiscordPresence(
  clientId: string,
  createClient: (clientId: string) => DiscordRpcClientLike = (id) =>
    new Client({ clientId: id })
): DiscordPresence {
  let client: DiscordRpcClientLike | null = null
  let connected = false
  let generation = 0
  let lifecycle = 0

  const retire = async (current: DiscordRpcClientLike): Promise<void> => {
    if (client !== current) return
    client = null
    connected = false
    try {
      await current.destroy()
    } catch (error) {
      // Failed cleanup must finish before a later attempt opens another socket.
      if (client === null) client = current
      throw error
    }
  }

  const ensureClient = async (): Promise<DiscordRpcClientLike | null> => {
    if (client && connected) return client
    const epoch = lifecycle
    if (client) {
      try { await retire(client) }
      catch { generation += 1; return null }
    }
    if (epoch !== lifecycle) return null
    const next = createClient(clientId)
    client = next
    next.on('disconnected', () => {
      if (client !== next) return
      connected = false
      lifecycle += 1
      generation += 1
    })
    try {
      await next.login()
    } catch {
      if (client === next) {
        connected = false
        generation += 1
        await retire(next).catch(() => {})
      }
      return null
    }
    if (client !== next || epoch !== lifecycle) {
      if (client === next) await retire(next).catch(() => {})
      return null
    }
    connected = true
    return next
  }

  return {
    async apply(activity: PresenceActivity, canPublish?: () => boolean): Promise<boolean> {
      let active: DiscordRpcClientLike | null = null
      try {
        active = await ensureClient()
        const user = active?.user
        // Privacy or shutdown intent can change while login is pending.
        if (!active || client !== active || !connected || !user || canPublish?.() === false) {
          return false
        }
        // Our URL fields are fallback image sources; the SDK's URL fields are click links.
        const { largeImageUrl, smallImageUrl, ...sdkActivity } = activity
        if (!sdkActivity.largeImageKey && largeImageUrl) sdkActivity.largeImageKey = largeImageUrl
        if (!sdkActivity.smallImageKey && smallImageUrl) sdkActivity.smallImageKey = smallImageUrl
        await user.setActivity(sdkActivity)
        return client === active && connected
      } catch {
        if (active === null || client === active) {
          connected = false
          generation += 1
        }
        return false
      }
    },
    async clear(): Promise<boolean> {
      const current = client
      try {
        await current?.user?.clearActivity()
        if (client === current) connected = false
        return true
      } catch {
        if (client === current) {
          connected = false
          generation += 1
        }
        return false
      }
    },
    async destroy(): Promise<void> {
      lifecycle += 1
      connected = false
      const current = client
      if (current) await retire(current)
    },
    connectionGeneration: () => generation,
    isConnected: () => connected
  }
}
