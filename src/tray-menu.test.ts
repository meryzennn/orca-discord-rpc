import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayMenuItems } from './tray-menu.ts'
import type { PresenceRuntimeStatus } from './runtime.ts'
import { describeTrayStatus } from './tray-status.ts'

const runtime: PresenceRuntimeStatus = {
  discordConnected: true,
  orcaRunning: true,
  paused: false,
  lastActivity: null,
  lastPushAt: 1_760_000_000_000,
  lastError: null
}

function items(overrides: Partial<PresenceRuntimeStatus> = {}) {
  const state = { ...runtime, ...overrides }
  return buildTrayMenuItems({
    status: describeTrayStatus(state),
    runtime: state,
    clientId: '1556649058657902712'
  })
}

describe('buildTrayMenuItems', () => {
  it('starts with a disabled header naming the app', () => {
    const first = items()[0]
    assert.equal(first?.id, 'header')
    assert.equal(first?.enabled, false)
    assert.match(first?.label ?? '', /Orca Discord Presence/)
  })

  it('shows the current state as a disabled row', () => {
    const row = items().find((item) => item.id === 'status')
    assert.ok(row)
    assert.equal(row?.enabled, false)
  })

  it('offers quit', () => {
    const quit = items().find((item) => item.id === 'quit')
    assert.equal(quit?.label, 'Quit')
    assert.notEqual(quit?.enabled, false)
  })

  it('offers to pause while running', () => {
    const toggle = items().find((item) => item.id === 'toggle')
    assert.equal(toggle?.label, 'Disable presence')
  })

  it('offers to resume while paused', () => {
    const toggle = items({ paused: true }).find((item) => item.id === 'toggle')
    assert.equal(toggle?.label, 'Enable presence')
  })

  it('offers reconnect only while Discord is missing', () => {
    assert.equal(
      items().find((item) => item.id === 'reconnect'),
      undefined
    )
    assert.ok(items({ discordConnected: false }).find((item) => item.id === 'reconnect'))
  })

  it('shows the application id so a wrong one is visible', () => {
    const row = items().find((item) => item.id === 'app-id')
    assert.match(row?.label ?? '', /1556649058657902712/)
  })

  it('separates the rows into groups', () => {
    assert.ok(items().some((item) => item.type === 'separator'))
  })

  it('gives every item a unique id', () => {
    const ids = items().map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('gives every non-separator item a label', () => {
    for (const item of items()) {
      if (item.type !== 'separator') {
        assert.ok(item.label.length > 0, `empty label on ${item.id}`)
      }
    }
  })
})
