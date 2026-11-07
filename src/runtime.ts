import { createDiscordPresence, type DiscordPresence } from './discord.ts'
import { createPresenceController, type PresenceState } from './presence-controller.ts'
import { createOrcaGatedStateReader, type OrcaGatedReader } from './orca-gated-reader.ts'
import { isOrcaRunning } from './orca-process.ts'
import { readPresenceState } from './orca-reader.ts'
import { findAgentModel } from './agent-model.ts'
import { builtinRegistry, type AgentRegistry } from './agent-registry.ts'
import { buildActivity, type PresenceActivity, type PresenceInput } from './presence.ts'

export type PresenceRuntimeStatus = {
  discordConnected: boolean
  orcaRunning: boolean
  paused: boolean
  lastActivity: PresenceActivity | null
  lastPushAt: number | null
  lastError: string | null
}

export type PresenceRuntimeDeps = {
  isOrcaRunning: () => Promise<boolean>
  readState: () => Promise<PresenceState | null>
  apply: (activity: PresenceActivity) => Promise<boolean>
  clear: () => Promise<boolean>
  /** Bumps on every socket drop, so a restarted Discord gets the current state re-pushed. */
  connectionGeneration?: () => number
  /** Returns a cancel function. Injected so tests need no real timer. */
  schedule: (tick: () => Promise<void>, ms: number) => () => void
}

export type PresenceRuntimeOptions = {
  clientId: string
  pollMs: number
  useUploadedArt: boolean
  buildActivity?: (input: PresenceInput) => PresenceActivity
  /** Names, artwork and model lookup for agent ids; the built-in entries when absent. */
  registry?: AgentRegistry
  log?: (line: string) => void
  deps?: PresenceRuntimeDeps
}

export type PresenceRuntime = {
  /** Starts publishing; preserveSession retains the clock during a privacy refresh. */
  start: (preserveSession?: boolean) => Promise<void>
  /** Stops polling; returns whether Discord acknowledged clearing the activity. */
  pause: () => Promise<boolean>
  /** Real teardown: destroys the transport as well. */
  stop: () => Promise<void>
  getStatus: () => PresenceRuntimeStatus
  subscribe: (listener: (status: PresenceRuntimeStatus) => void) => () => void
}

export function createPresenceRuntime(options: PresenceRuntimeOptions): PresenceRuntime {
  const log = options.log ?? (() => {})
  const registry = options.registry ?? builtinRegistry
  const discord: DiscordPresence | null = options.deps
    ? null
    : createDiscordPresence(options.clientId)

  const deps: PresenceRuntimeDeps = options.deps ?? {
    isOrcaRunning,
    readState: () => readPresenceState(undefined, undefined,
      (agentType, path) => findAgentModel(agentType, path, undefined, registry)),
    apply: (activity) => discord!.apply(activity),
    clear: () => discord!.clear(),
    connectionGeneration: () => discord!.connectionGeneration(),
    schedule: (tick, ms) => {
      const timer = setInterval(() => void tick(), ms)
      return () => clearInterval(timer)
    }
  }

  let reader: OrcaGatedReader | null = null
  let controller: ReturnType<typeof createPresenceController> | null = null
  let cancel: (() => void) | null = null
  let started = false
  let paused = false
  let lastActivity: PresenceActivity | null = null
  let lastPushAt: number | null = null
  let lastError: string | null = null
  const listeners = new Set<(status: PresenceRuntimeStatus) => void>()

  const getStatus = (): PresenceRuntimeStatus => ({
    // Why derived: with injected deps there is no socket, and a successful push is the
    // only connection signal those tests can offer.
    discordConnected: discord?.isConnected() ?? lastActivity !== null,
    orcaRunning: reader?.isOrcaRunning() ?? false,
    paused,
    lastActivity,
    lastPushAt,
    lastError
  })

  const notify = (): void => {
    const status = getStatus()
    for (const listener of listeners) {
      listener(status)
    }
  }

  const tick = async (): Promise<void> => {
    if (!started || paused || !controller) {
      return
    }
    try {
      await controller.poll()
    } catch (error) {
      // Why only on throw: a failed push is recorded by the apply wrapper, and clearing
      // here would erase it before anyone could read the status.
      lastError = error instanceof Error ? error.message : String(error)
    }
    notify()
  }

  const ensureWired = (): void => {
    if (reader && controller) {
      return
    }
    reader = createOrcaGatedStateReader({
      isOrcaRunning: deps.isOrcaRunning,
      readState: deps.readState,
      onTransition: (running) =>
        log(running ? 'Orca detected; reporting presence' : 'Orca closed; clearing presence')
    })
    controller = createPresenceController({
      readState: () => reader!.read(),
      apply: async (activity) => {
        const ok = await deps.apply(activity)
        if (ok) {
          lastActivity = activity
          lastPushAt = Date.now()
          lastError = null
          // Keep actual artwork references for diagnosing rejected images.
          const art = activity.largeImageUrl ?? activity.largeImageKey
          log(`pushed: ${activity.details} | ${activity.state}${art ? ` | art=${art}` : ''}`)
        } else {
          lastError = 'Discord rejected or could not receive the activity'
          log(`push failed: ${activity.details}`)
        }
        return ok
      },
      clear: () => deps.clear(),
      connectionEpoch: deps.connectionGeneration,
      useUploadedArt: options.useUploadedArt,
      buildActivity: options.buildActivity ?? (input => buildActivity({ ...input, registry }))
    })
  }

  return {
    async start(preserveSession = false): Promise<void> {
      ensureWired()
      if (started && !paused) {
        await tick()
        return
      }
      // Clear invalidates deduplication; privacy refreshes retain the session clock.
      controller?.reset(preserveSession)
      started = true
      paused = false
      cancel?.()
      cancel = deps.schedule(tick, options.pollMs)
      await tick()
    },
    async pause(): Promise<boolean> {
      paused = true
      cancel?.()
      cancel = null
      const cleared = await deps.clear()
      notify()
      return cleared
    },
    async stop(): Promise<void> {
      started = false
      paused = false
      cancel?.()
      cancel = null
      await discord?.destroy()
      notify()
    },
    getStatus,
    subscribe(listener: (status: PresenceRuntimeStatus) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
