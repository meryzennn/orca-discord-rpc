import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDiscordPresence } from './discord.ts'
import type { PresenceActivity } from './presence.ts'
import { ClientUser } from '@xhayper/discord-rpc'

const activity: PresenceActivity = {
  details: 'Claude',
  state: 'orca',
  startTimestamp: new Date('2026-10-05T00:00:00.000Z')
}

it('serializes project fallback image sources as SDK image assets, with keys taking precedence', async () => {
  const requests: { activity: { assets: Record<string, string>; buttons?: unknown } }[] = []
  const client = {
    request: async (_command: string, args: typeof requests[number]) => {
      requests.push(args)
      return { data: {} }
    }
  }
  const user = new ClientUser(client as never, { id: '1' } as never)
  const presence = createDiscordPresence('1', () => ({
    on: () => {}, login: async () => {}, destroy: async () => {}, user
  }))
  const buttons = [{ label: 'View Repository', url: 'https://github.com/owner/repo' }]
  const fallback = {
    ...activity, largeImageUrl: 'https://example.com/large.png',
    smallImageUrl: 'https://example.com/small.png', buttons
  }
  assert.equal(await presence.apply(fallback), true)
  assert.deepEqual(requests[0]?.activity.assets, {
    large_image: 'https://example.com/large.png', small_image: 'https://example.com/small.png'
  })
  assert.deepEqual(requests[0]?.activity.buttons, buttons)
  assert.equal(await presence.apply({ ...fallback, largeImageKey: 'orca', smallImageKey: 'git-branch' }), true)
  assert.deepEqual(requests[1]?.activity.assets, { large_image: 'orca', small_image: 'git-branch' })
  assert.equal(fallback.largeImageUrl, 'https://example.com/large.png')
  await presence.destroy()
})

/** A stand-in for the RPC client, so no Discord is needed and failures can be forced. */
function fakeClient(options: { failLogin?: boolean; failSet?: boolean; login?: () => Promise<void> } = {}) {
  let destroyed = 0
  const sent: PresenceActivity[] = []
  const client = {
    // Why present: the transport subscribes to 'disconnected' to learn about a Discord restart.
    on: (): void => {},
    login: async (): Promise<void> => {
      if (options.failLogin) {
        throw new Error('EPIPE')
      }
      await options.login?.()
    },
    destroy: async (): Promise<void> => {
      destroyed += 1
    },
    user: {
      setActivity: async (activity: PresenceActivity): Promise<unknown> => {
        if (options.failSet) {
          throw new Error('EPIPE')
        }
        sent.push(activity)
        return {}
      },
      clearActivity: async (): Promise<void> => {}
    }
  }
  return {
    client,
    sent,
    destroyed: () => destroyed
  }
}

describe('createDiscordPresence isConnected', () => {
  it('is false before anything has been sent', () => {
    const presence = createDiscordPresence('1556649058657902712', () => fakeClient().client)
    assert.equal(presence.isConnected(), false)
  })

  it('is true after a successful push', async () => {
    const presence = createDiscordPresence('1556649058657902712', () => fakeClient().client)
    assert.equal(await presence.apply(activity), true)
    assert.equal(presence.isConnected(), true)
  })

  it('is false when the client cannot be reached', async () => {
    const presence = createDiscordPresence('1556649058657902712', () =>
      fakeClient({ failLogin: true }).client
    )
    assert.equal(await presence.apply(activity), false)
    assert.equal(presence.isConnected(), false)
  })

  it('is false once the activity is cleared, because nothing is displayed', async () => {
    // Why: the menu must say "Discord not detected" rather than a stale connected state
    // after a pause or an Orca-closed clear.
    const presence = createDiscordPresence('1556649058657902712', () => fakeClient().client)
    await presence.apply(activity)
    assert.equal(await presence.clear(), true)
    assert.equal(presence.isConnected(), false)
  })

  it('is false after destroy', async () => {
    const presence = createDiscordPresence('1556649058657902712', () => fakeClient().client)
    await presence.apply(activity)
    await presence.destroy()
    assert.equal(presence.isConnected(), false)
  })

  it('reports a dropped connection after a failed push', async () => {
    const fake = fakeClient({ failSet: true })
    const presence = createDiscordPresence('1556649058657902712', () => fake.client)
    assert.equal(await presence.apply(activity), false)
    assert.equal(presence.isConnected(), false)
  })
})

it('checks publication intent after deferred login and permits a later retry', async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const fake = fakeClient({ login: async () => { enter(); await gate } })
  const presence = createDiscordPresence('1556649058657902712', () => fake.client)
  let allowed = true
  const pending = presence.apply(activity, () => allowed)
  await entered
  allowed = false
  release()
  assert.equal(await pending, false)
  assert.deepEqual(fake.sent, [])
  allowed = true
  assert.equal(await presence.apply(activity, () => allowed), true)
  assert.deepEqual(fake.sent, [activity])
  await presence.destroy()
})
