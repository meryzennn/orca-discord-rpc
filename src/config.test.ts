import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, DEFAULT_CLIENT_ID, DEFAULT_POLL_MS } from './config.ts'

describe('loadConfig', () => {
  it('uses the env client id first', () => {
    const config = loadConfig({
      env: { ORCA_DISCORD_CLIENT_ID: '111111111111111111' },
      readConfigFile: () => ({ clientId: '222222222222222222' })
    })
    assert.equal(config.clientId, '111111111111111111')
  })

  it('falls back to the config file', () => {
    const config = loadConfig({
      env: {},
      readConfigFile: () => ({ clientId: '222222222222222222' })
    })
    assert.equal(config.clientId, '222222222222222222')
  })

  it('falls back to the baked-in default', () => {
    const config = loadConfig({ env: {}, readConfigFile: () => null })
    assert.equal(config.clientId, DEFAULT_CLIENT_ID)
  })

  it('lets the config file set the poll interval', () => {
    const config = loadConfig({ env: {}, readConfigFile: () => ({ pollMs: 30_000 }) })
    assert.equal(config.pollMs, 30_000)
  })

  it('clamps a too-fast poll interval', () => {
    const config = loadConfig({ env: {}, readConfigFile: () => ({ pollMs: 100 }) })
    assert.equal(config.pollMs, DEFAULT_POLL_MS)
  })

  it('survives a corrupt config file', () => {
    const config = loadConfig({
      env: {},
      readConfigFile: () => {
        throw new Error('bad json')
      }
    })
    assert.equal(config.clientId, DEFAULT_CLIENT_ID)
  })
})
