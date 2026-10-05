import { createDiscordPresence, type DiscordPresence } from './discord.ts'
import { createPresenceController, type PresenceState } from './presence-controller.ts'
import { createOrcaGatedStateReader, type OrcaGatedReader } from './orca-gated-reader.ts'
import { isOrcaRunning } from './orca-process.ts'
import { readPresenceState } from './orca-reader.ts'
import type { PresenceActivity } from './presence.ts'

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
  log?: (line: string) => void
  deps?: PresenceRuntimeDeps
}

export type PresenceRuntime = {
  start: () => Promise<void>
  /** Stops polling and clears the activity, but keeps the transport for a later start. */
  pause: () => Promise<void>
  /** Real teardown: destroys the transport as well. */
  stop: () => Promise<void>
  getStatus: () => PresenceRuntimeStatus
  subscribe: (listener: (status: PresenceRuntimeStatus) => void) => () => void
}

export function createPresenceRuntime(options: PresenceRuntimeOptions): PresenceRuntime {
  const log = options.log ?? (() => {})
  const discord: DiscordPresence | null = options.deps
    ? null
    : createDiscordPresence(options.clientId)

  const deps: PresenceRuntimeDeps = options.deps ?? {
    isOrcaRunning,
    readState: readPresenceState,
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
          // Why the art: this line is the only record of what Discord was actually told, and
          // the art reference is what made a rejected-image bug findable.
          const art = activity.largeImageUrl ?? activity.largeImageKey ?? 'none'
          log(`pushed: ${activity.details} | ${activity.state} | art=${art}`)
        } else {
          lastError = 'Discord rejected or could not receive the activity'
          log(`push failed: ${activity.details}`)
        }
        return ok
      },
      clear: () => deps.clear(),
      connectionEpoch: deps.connectionGeneration,
      useUploadedArt: options.useUploadedArt
    })
  }

  return {
    async start(): Promise<void> {
      ensureWired()
      if (started && !paused) {
        await tick()
        return
      }
      // Why reset on a resume: whatever Discord was showing was cleared by pause/stop, so the
      // unchanged state has to be pushed again even though the dedupe key would match.
      controller?.reset()
      started = true
      paused = false
      cancel?.()
      cancel = deps.schedule(tick, options.pollMs)
      await tick()
    },
    async pause(): Promise<void> {
      paused = true
      cancel?.()
      cancel = null
      await deps.clear()
      notify()
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
