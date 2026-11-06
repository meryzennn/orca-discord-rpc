import type { AppConfig } from './config.ts'
import type { DiscordPresence } from './discord.ts'
import type { PresenceState } from './presence-controller.ts'
import { createPresenceRuntime, type PresenceRuntimeStatus } from './runtime.ts'
import { buildTrayActivity } from './tray-presence.ts'

export type PluginSession = {
  refresh(): Promise<void>
  setEnabled(value: boolean): Promise<void>
  setIncognito(value: boolean): Promise<void>
  stop(): Promise<void>
}

export type PluginSessionOptions = {
  config: AppConfig
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
    buildActivity: input => buildTrayActivity({ ...input, incognito }),
    deps: {
      isOrcaRunning: async () => true,
      readState: async () => {
        try {
          const state = await options.readState()
          readError = null
          return state && incognito ? { ...state, projectName: 'Private Project', branchName: null, repoUrl: null } : state
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error)
          report(error)
          throw error
        }
      },
      // The queued privacy change must close the old socket before any new push.
      apply: activity => closed || privacyPending
        ? Promise.resolve(false)
        : options.transport.apply(activity, () => !closed && !privacyPending),
      clear: options.transport.clear,
      connectionGeneration: options.transport.connectionGeneration,
      schedule: (_tick, ms) => interval(() => { void refresh().catch(report) }, ms)
    }
  })
  const publish = (status: PresenceRuntimeStatus): void => options.onStatus({
    ...status, paused: !enabled, discordConnected: options.transport.isConnected(),
    lastError: readError ?? status.lastError
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
          if (enabled) await runtime.pause().catch(report)
          await options.transport.destroy()
        }
        privacyPending = false
        if (!closed && enabled) await runtime.start()
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
          finally { await options.transport.destroy() }
        }
      })
      return shutdown
    }
  }
}
