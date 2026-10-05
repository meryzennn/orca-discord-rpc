import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDiscordPresence } from './discord.ts'
import type { PresenceActivity } from './presence.ts'

const activity: PresenceActivity = {
  details: 'Claude',
  state: 'orca',
  startTimestamp: new Date('2026-10-05T00:00:00.000Z')
}

/** A stand-in for the RPC client, so no Discord is needed and failures can be forced. */
function fakeClient(options: { failLogin?: boolean; failSet?: boolean } = {}) {
  let destroyed = 0
  const client = {
    // Why present: the transport subscribes to 'disconnected' to learn about a Discord restart.
    on: (): void => {},
    login: async (): Promise<void> => {
      if (options.failLogin) {
        throw new Error('EPIPE')
      }
    },
    destroy: async (): Promise<void> => {
      destroyed += 1
    },
    user: {
      setActivity: async (): Promise<unknown> => {
        if (options.failSet) {
          throw new Error('EPIPE')
        }
        return {}
      },
      clearActivity: async (): Promise<void> => {}
    }
  }
  return {
    client,
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
