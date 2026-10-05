import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, isProcessAlive, formatStatus } from './cli-support.ts'

describe('parseCommand', () => {
  it('defaults to help with no arguments', () => {
    assert.equal(parseCommand([]), 'help')
  })

  it('reads each command', () => {
    assert.equal(parseCommand(['start']), 'start')
    assert.equal(parseCommand(['stop']), 'stop')
    assert.equal(parseCommand(['status']), 'status')
  })

  it('reads the autostart subcommand', () => {
    assert.equal(parseCommand(['autostart', 'enable']), 'autostart-enable')
    assert.equal(parseCommand(['autostart', 'disable']), 'autostart-disable')
  })

  it('treats an unknown word as help', () => {
    assert.equal(parseCommand(['frobnicate']), 'help')
    assert.equal(parseCommand(['autostart']), 'help')
  })
})

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    assert.equal(isProcessAlive(process.pid), true)
  })

  it('is false for a pid that cannot exist', () => {
    assert.equal(isProcessAlive(0), false)
    assert.equal(isProcessAlive(-1), false)
    assert.equal(isProcessAlive(2_147_483_646), false)
  })
})

describe('formatStatus', () => {
  it('reports a running daemon with its pid', () => {
    assert.equal(formatStatus(4242), 'running (pid 4242)')
  })

  it('reports a stopped daemon', () => {
    assert.equal(formatStatus(null), 'stopped')
  })
})
