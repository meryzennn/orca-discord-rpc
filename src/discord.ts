import { Client } from '@xhayper/discord-rpc'
import type { PresenceActivity } from './presence.ts'

export type DiscordPresence = {
  apply: (activity: PresenceActivity) => Promise<boolean>
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

  const ensureClient = async (): Promise<DiscordRpcClientLike> => {
    if (client && connected) {
      return client
    }
    if (client) {
      await client.destroy().catch(() => {})
      client = null
    }
    const next = createClient(clientId)
    // Why: Discord can restart under us; without this the daemon would keep believing
    // the old activity is still displayed and never re-send it.
    next.on('disconnected', () => {
      connected = false
      generation += 1
    })
    await next.login()
    client = next
    connected = true
    return next
  }

  return {
    async apply(activity: PresenceActivity): Promise<boolean> {
      try {
        const active = await ensureClient()
        const user = active.user
        if (!user) {
          return false
        }
        await user.setActivity(activity)
        return true
      } catch {
        // Why reset: a dropped connection must force a fresh login on the next attempt.
        connected = false
        generation += 1
        return false
      }
    },
    async clear(): Promise<boolean> {
      try {
        await client?.user?.clearActivity()
        // Why released: nothing is displayed after a clear, so reporting "connected" would tell
        // the menu the profile is fine while it shows no activity at all.
        connected = false
        return true
      } catch {
        connected = false
        generation += 1
        return false
      }
    },
    async destroy(): Promise<void> {
      const current = client
      client = null
      connected = false
      await current?.destroy().catch(() => {})
    },
    connectionGeneration: () => generation,
    isConnected: () => connected
  }
}
