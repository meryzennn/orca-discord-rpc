import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeTrayStatus } from './tray-status.ts'
import type { PresenceRuntimeStatus } from './runtime.ts'

function status(overrides: Partial<PresenceRuntimeStatus> = {}): PresenceRuntimeStatus {
  return {
    discordConnected: true,
    orcaRunning: true,
    paused: false,
    lastActivity: {
      details: 'Claude',
      state: 'orca',
      startTimestamp: new Date(),
      largeImageKey: 'claude',
      largeImageText: 'Agent'
    },
    lastPushAt: 1_760_000_000_000,
    lastError: null,
    ...overrides
  }
}

describe('describeTrayStatus', () => {
  it('reports a healthy activity', () => {
    const described = describeTrayStatus(status())
    assert.equal(described.tone, 'ok')
    assert.equal(described.headline, 'Claude')
    assert.equal(described.detail, 'orca')
  })

  it('reports Discord missing while Orca is open', () => {
    const described = describeTrayStatus(status({ discordConnected: false }))
    assert.equal(described.tone, 'waiting')
    assert.match(described.headline, /Discord/)
  })

  it('reports Orca closed', () => {
    const described = describeTrayStatus(status({ orcaRunning: false, lastActivity: null }))
    assert.equal(described.tone, 'idle')
    assert.match(described.headline, /Orca/)
  })

  it('reports an error above the other states', () => {
    const described = describeTrayStatus(status({ lastError: 'boom' }))
    assert.equal(described.tone, 'error')
    assert.match(described.headline, /problem/i)
  })

  it('prefers showing a push failure over Discord-not-connected wording', () => {
    const described = describeTrayStatus(status({ discordConnected: false, lastError: 'boom' }))
    assert.equal(described.tone, 'error')
    assert.equal(described.detail, 'boom')
  })

  it('reports a paused presence above the healthy state', () => {
    const described = describeTrayStatus(status({ paused: true }))
    assert.equal(described.tone, 'idle')
    assert.match(described.headline, /paused/i)
  })

  it('lets an error outrank a pause', () => {
    const described = describeTrayStatus(status({ paused: true, lastError: 'boom' }))
    assert.equal(described.tone, 'error')
  })

  it('builds a tooltip naming the app and the state', () => {
    const described = describeTrayStatus(status())
    assert.match(described.tooltip, /Orca Discord Presence/)
    assert.match(described.tooltip, /Claude/)
  })

  it('never returns a headline shorter than Discord-safe text', () => {
    // Why 2: a one-character string is rejected anywhere it is reused as an activity field.
    for (const variant of [
      status(),
      status({ discordConnected: false }),
      status({ orcaRunning: false }),
      status({ lastError: 'x' }),
      status({ paused: true })
    ]) {
      assert.ok(describeTrayStatus(variant).headline.length >= 2)
    }
  })
})
