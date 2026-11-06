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
function fakeClient(options: { failLogin?: boolean; failSet?: boolean; failClear?: boolean; login?: () => Promise<void> } = {}) {
  let destroyed = 0
  let disconnected: (() => void) | undefined
  const sent: PresenceActivity[] = []
  const client = {
    on: (_event: string, listener: () => void): void => { disconnected = listener },
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
      clearActivity: async (): Promise<void> => {
        if (options.failClear) throw new Error('EPIPE')
      }
    }
  }
  return {
    client,
    sent,
    disconnect: () => disconnected?.(),
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

it('ignores a retired disconnect and still detects the current disconnect', async () => {
  const old = fakeClient()
  const next = fakeClient()
  let created = 0
  const presence = createDiscordPresence('1', () => [old, next][created++]!.client)
  await presence.apply(activity)
  await presence.destroy()
  await presence.apply(activity)
  const generation = presence.connectionGeneration()
  old.disconnect()
  assert.equal(presence.isConnected(), true)
  assert.equal(presence.connectionGeneration(), generation)
  next.disconnect()
  assert.equal(presence.isConnected(), false)
  assert.ok(presence.connectionGeneration() > generation)
  await presence.destroy()
})

it('destroys a failed login candidate before a fresh successful attempt', async () => {
  const failed = fakeClient({ failLogin: true })
  const recovered = fakeClient()
  let created = 0
  const presence = createDiscordPresence('1', () => [failed, recovered][created++]!.client)
  assert.equal(await presence.apply(activity), false)
  assert.equal(failed.destroyed(), 1)
  assert.equal(await presence.apply(activity), true)
  assert.equal(presence.isConnected(), true)
  await presence.destroy()
  assert.equal(recovered.destroyed(), 1)
})

it('cannot publish or regain ownership after destroy during deferred login', async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const fake = fakeClient({ login: async () => { enter(); await gate } })
  const presence = createDiscordPresence('1', () => fake.client)
  const pending = presence.apply(activity)
  await entered
  await presence.destroy()
  assert.equal(fake.destroyed(), 1)
  release()
  assert.equal(await pending, false)
  assert.equal(presence.isConnected(), false)
  assert.deepEqual(fake.sent, [])
})

it('does not republish through a client whose explicit destruction failed', async () => {
  const fake = fakeClient()
  let fail = true
  const destroy = fake.client.destroy
  fake.client.destroy = async () => {
    if (fail) throw new Error('close failed')
    await destroy()
  }
  const presence = createDiscordPresence('1', () => fake.client)
  await presence.apply(activity)
  await assert.rejects(presence.destroy(), /close failed/)
  assert.equal(presence.isConnected(), false)
  assert.equal(await presence.apply(activity), false)
  assert.equal(fake.sent.length, 1)
  fail = false
  await presence.destroy()
  assert.equal(fake.destroyed(), 1)
})

it('reports only the operation and safe error code, then clears it after recovery', async () => {
  const fake = fakeClient()
  let fail = true
  fake.client.user.setActivity = async () => {
    if (fail) throw Object.assign(new Error('secret-project secret-branch https://private/repo'), { code: 'EPIPE' })
    return {}
  }
  const presence = createDiscordPresence('1', () => fake.client)
  assert.equal(await presence.apply(activity), false)
  assert.equal(presence.lastError?.(), 'Discord RPC apply failed (code: EPIPE)')
  assert.ok(!presence.lastError?.()?.includes('secret-'))
  fail = false
  assert.equal(await presence.apply(activity), true)
  assert.equal(presence.lastError?.(), null)
  await presence.destroy()
})

it('reports login, clear and destroy codes without exposing exception messages', async () => {
  for (const [operation, code] of [['login', 1], ['clear', 5], ['destroy', 'EPIPE']] as const) {
    const fake = fakeClient()
    const presence = createDiscordPresence('1', () => fake.client)
    const fail = async (): Promise<void> => {
      throw Object.assign(new Error('secret-project secret-branch'), { code })
    }
    if (operation === 'login') {
      fake.client.login = fail
      assert.equal(await presence.apply(activity), false)
    } else {
      await presence.apply(activity)
      if (operation === 'clear') {
        fake.client.user.clearActivity = fail
        assert.equal(await presence.clear(), false)
      } else {
        fake.client.destroy = fail
        await assert.rejects(presence.destroy())
      }
    }
    assert.equal(presence.lastError?.(), `Discord RPC ${operation} failed (code: ${code})`)
    fake.client.destroy = async () => {}
    await presence.destroy()
  }
})

it('does not echo an invalid error code into diagnostics', async () => {
  const fake = fakeClient()
  fake.client.user.setActivity = async () => {
    throw Object.assign(new Error('secret-project'), { code: 'secret-project/branch' })
  }
  const presence = createDiscordPresence('1', () => fake.client)
  assert.equal(await presence.apply(activity), false)
  assert.equal(presence.lastError?.(), 'Discord RPC apply failed (code: unknown)')
  await presence.destroy()
})
