import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Client } from '@xhayper/discord-rpc'
import { loadConfig, type ConfigFile } from './config.ts'
import { configPath } from './paths.ts'
import { createDiscordPresence } from './discord.ts'
import { readPresenceState, runOrcaWorktreePs } from './orca-reader.ts'
import { readRepoUrl } from './git-remote.ts'
import { createPluginSession, type PluginSession } from './plugin-session.ts'
import type { PresenceRuntimeStatus } from './runtime.ts'
import { resolveBundledCliEntry, pluginDiscordPaths } from './plugin-platform.ts'

type Disposable = { dispose(): void }
export type LegacyConfig = ConfigFile & { incognito?: unknown }
export type PluginApi = {
  log(message: string): void
  settings: {
    get(key: string): Promise<unknown>
    set(key: string, value: boolean): Promise<unknown>
    onDidChange(handler: (event: { key: string }) => void): Disposable
  }
  commands: { register(id: string, handler: () => Promise<unknown>): Disposable }
  events: { on(event: 'workspace.changed' | 'agent.status.changed', handler: () => void): Disposable }
  host: { call(method: 'statusBar.update', params: Record<string, string>): Promise<unknown> }
}

export function readLegacyConfig(path: string): LegacyConfig | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as LegacyConfig : null
  } catch { return null }
}

export function createPluginLifecycle(
  orca: PluginApi,
  legacy: LegacyConfig | null,
  startSession: (enabled: boolean, incognito: boolean, signal: AbortSignal,
    onStatus: (status: PresenceRuntimeStatus) => void) => PluginSession
): { activate(): Promise<void>; deactivate(): Promise<void> } {
  const readerAbort = new AbortController()
  const report = (error: unknown): void => orca.log(error instanceof Error ? error.message : String(error))
  let session: PluginSession | null = null
  const subscriptions: Disposable[] = []
  let stopping = false
  let starting: Promise<void> | null = null
  let shutdown: Promise<void> | null = null
  let settingsWork = Promise.resolve<unknown>(undefined)
  const queueSetting = (operation: () => Promise<unknown>): Promise<unknown> => {
    const job = settingsWork.then(async () => { if (!stopping) return operation() })
    settingsWork = job.catch(report)
    return job
  }
  const toggleSetting = (key: 'enabled' | 'incognito'): Promise<unknown> => queueSetting(async () => {
    const value = await orca.settings.get(key)
    if (stopping) return
    if (typeof value !== 'boolean' && (key === 'incognito' || value != null)) {
      throw new Error(`${key} setting must be boolean`)
    }
    return orca.settings.set(key, value === false)
  })
  const updateIncognito = (value: boolean): void => {
    if (stopping) return
    void orca.host.call('statusBar.update', {
      id: 'incognito', text: value ? 'Incognito On' : 'Incognito Off',
      tooltip: value ? 'Incognito on: project and repository hidden. Click to turn off.'
        : 'Incognito off: click to hide project and repository.'
    }).catch(report)
  }
  const deactivate = (): Promise<void> => {
    if (shutdown) return shutdown
    stopping = true
    readerAbort.abort()
    const current = session
    session = null
    for (const subscription of subscriptions.splice(0)) {
      try { subscription.dispose() } catch (error) { report(error) }
    }
    shutdown = current?.stop() ?? Promise.resolve()
    return shutdown
  }
  return {
    activate: () => {
      if (starting) return starting
      if (stopping) return Promise.resolve()
      starting = (async () => {
        let incognito = await orca.settings.get('incognito')
        if (stopping) return
        if (incognito == null) {
          const migrated = legacy?.incognito === true
          incognito = migrated
          await orca.settings.set('incognito', migrated)
          if (stopping) return
        }
        if (typeof incognito !== 'boolean') throw new Error('Incognito setting must be boolean')
        const enabled = await orca.settings.get('enabled')
        if (stopping) return
        if (enabled != null && typeof enabled !== 'boolean') throw new Error('Enabled setting must be boolean')
        const current = startSession(enabled !== false, incognito, readerAbort.signal, status => {
          if (stopping) return
          const text = status.paused ? 'RPC paused' : status.discordConnected ? 'RPC' : 'RPC waiting'
          const tooltip = status.paused ? 'Discord Rich Presence paused: click to resume'
            : status.lastError ?? 'Discord Rich Presence: click to pause or resume'
          void orca.host.call('statusBar.update', {
            id: 'presence', text, tooltip
          }).catch(report)
        })
        session = current
        updateIncognito(incognito)
        const refresh = (): void => { if (!stopping) void current.refresh().catch(report) }
        subscriptions.push(orca.commands.register('presence.toggle', () => toggleSetting('enabled')))
        subscriptions.push(orca.commands.register('presence.incognito.toggle', () => toggleSetting('incognito')))
        subscriptions.push(orca.events.on('workspace.changed', refresh))
        subscriptions.push(orca.events.on('agent.status.changed', refresh))
        subscriptions.push(orca.settings.onDidChange(({ key }) => {
          if (key !== 'enabled' && key !== 'incognito') return
          void queueSetting(async () => {
            const value = await orca.settings.get(key)
            if (stopping) return
            if (typeof value !== 'boolean') throw new Error(`${key} setting must be boolean`)
            // Forward privacy intent before a resumed poll finishes; the session orders its own work.
            void (key === 'enabled' ? current.setEnabled(value) : current.setIncognito(value)).catch(report)
            if (key === 'incognito') updateIncognito(value)
          })
        }))
        refresh()
      })().catch(async error => {
        await deactivate().catch(report)
        throw error
      })
      return starting
    },
    deactivate
  }
}

let lifecycle: ReturnType<typeof createPluginLifecycle> | null = null

export default async function activate(orca: PluginApi): Promise<void> {
  const legacy = readLegacyConfig(configPath())
  const config = loadConfig({ env: {}, readConfigFile: () => legacy })
  const cliEntry = resolveBundledCliEntry(process.execPath, process.platform)
  const uid = process.getuid?.()
  const runtimeDirectory = process.platform === 'linux'
    ? process.env.XDG_RUNTIME_DIR || (uid === undefined ? undefined : `/run/user/${uid}`)
    : undefined
  const paths = pluginDiscordPaths(process.platform, tmpdir(), runtimeDirectory)
  const current = createPluginLifecycle(orca, legacy, (enabled, incognito, signal, onStatus) => createPluginSession({
    config, enabled, incognito, onStatus, log: message => orca.log(message),
    readState: () => readPresenceState(
      () => runOrcaWorktreePs(process.execPath, cliEntry, signal), path => readRepoUrl(path, signal)
    ),
    transport: createDiscordPresence(config.clientId, clientId => new Client({
      clientId, transport: { type: 'ipc', pathList: paths }
    }))
  }))
  lifecycle = current
  await current.activate()
}

export async function deactivate(): Promise<void> {
  const current = lifecycle
  lifecycle = null
  await current?.deactivate()
}
