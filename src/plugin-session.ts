import type { AppConfig } from './config.ts'
import type { DiscordPresence } from './discord.ts'
import type { PresenceState } from './presence-controller.ts'
import { createPresenceRuntime, type PresenceRuntimeStatus } from './runtime.ts'
import { buildPluginActivity } from './plugin-presence.ts'
import { FORMAT } from './presence-format.ts'
import type { AgentRegistry } from './agent-registry.ts'

export type PluginSession = {
  refresh(): Promise<void>
  setEnabled(value: boolean): Promise<void>
  setIncognito(value: boolean): Promise<void>
  stop(): Promise<void>
}

export type PluginSessionOptions = {
  config: AppConfig
  /** Names, artwork and model lookup for agent ids; the built-in entries when absent. */
  registry?: AgentRegistry
  enabled: boolean
  incognito: boolean
  readState(): Promise<PresenceState | null>
  transport: DiscordPresence
  onStatus(status: PresenceRuntimeStatus): void
  log(message: string): void
  scheduleInterval?: (tick: () => void, ms: number) => () => void
}

export function createPluginSession(options: PluginSessionOptions): PluginSession {
  let enabled = options.enabled
  let incognito = options.incognito
  let privacyPending = false
  let readError: string | null = null
  let closed = false
  let tail = Promise.resolve()
  let refreshJob: Promise<void> | null = null
  let shutdown: Promise<void> | null = null
  const report = (error: unknown): void => options.log(error instanceof Error ? error.message : String(error))
  const destroyTransport = async (): Promise<void> => {
    try { await options.transport.destroy() }
    catch {
      const message = options.transport.lastError?.() ?? 'Discord RPC destroy failed (code: unknown)'
      if (!closed) publish({ ...runtime.getStatus(), lastError: message })
      throw new Error(message)
    }
  }
  const serial = (operation: () => Promise<void>): Promise<void> => {
    const job = tail.then(operation)
    tail = job.catch(report)
    return job
  }
  const interval = options.scheduleInterval ?? ((tick, ms) => {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  })
  const refresh = (): Promise<void> => {
    if (closed || !enabled) return Promise.resolve()
    if (refreshJob) return refreshJob
    refreshJob = serial(async () => {
      if (!closed && enabled) await runtime.start()
    }).finally(() => { refreshJob = null })
    return refreshJob
  }
  const runtime = createPresenceRuntime({
    ...options.config,
    log: options.log,
    buildActivity: input => buildPluginActivity({ ...input, incognito, ...(options.registry ? { registry: options.registry } : {}) }),
    deps: {
      isOrcaRunning: async () => true,
      readState: async () => {
        try {
          const state = await options.readState()
          readError = null
          return state && incognito ? { ...state, projectName: FORMAT.privateProject, branchName: null, repoUrl: null } : state
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error)
          report(error)
          throw error
        }
      },
      // Publication waits until the old activity is cleared or its socket is closed.
      apply: async activity => {
        if (closed || privacyPending) return false
        const ok = await options.transport.apply(activity, () => !closed && !privacyPending)
        const error = options.transport.lastError?.()
        if (!ok && error) options.log(error)
        return ok
      },
      clear: async () => {
        const ok = await options.transport.clear()
        const error = options.transport.lastError?.()
        if (!ok && error) options.log(error)
        return ok
      },
      connectionGeneration: options.transport.connectionGeneration,
      schedule: (_tick, ms) => interval(() => { void refresh().catch(report) }, ms)
    }
  })
  const publish = (status: PresenceRuntimeStatus): void => options.onStatus({
    ...status, paused: !enabled, discordConnected: options.transport.isConnected(),
    lastError: readError ?? options.transport.lastError?.() ?? status.lastError
  })
  const unsubscribe = runtime.subscribe(publish)
  publish(runtime.getStatus())
  return {
    refresh,
    setEnabled: value => serial(async () => {
      if (closed || value === enabled) return
      enabled = value
      if (enabled) await runtime.start()
      else await runtime.pause()
    }),
    setIncognito: value => {
      if (closed || value === incognito) return Promise.resolve()
      // A pending read must use the user's latest privacy choice.
      incognito = value
      privacyPending = true
      return serial(async () => {
        if (!closed) {
          const cleared = await runtime.pause().catch(error => { report(error); return false })
          if (!cleared) await destroyTransport()
        }
        privacyPending = false
        if (!closed && enabled) await runtime.start(true)
      })
    },
    stop: () => {
      if (shutdown) return shutdown
      closed = true
      shutdown = serial(async () => {
        unsubscribe()
        try { await runtime.stop() }
        finally {
          try { await options.transport.clear() }
          finally { await destroyTransport() }
        }
      })
      return shutdown
    }
  }
}
