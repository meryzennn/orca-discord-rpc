import { buildActivity, type PresenceActivity } from './presence.ts'

export type PresenceState = {
  projectName: string | null
  /** The agent shown on the first line: the one that most recently entered its state. */
  agentType: string | null
  runningAgentCount: number
  /** False when the featured agent is between turns. */
  agentActive: boolean
  /** Shown as the branch icon's tooltip. */
  branchName: string | null
}

export type PresenceControllerDeps = {
  readState: () => Promise<PresenceState | null>
  /** Resolves false when the update did not reach Discord (not running yet), so the next tick retries. */
  apply: (activity: PresenceActivity) => Promise<boolean>
  clear: () => Promise<boolean>
  /** Bumps on every socket drop, so a restarted Discord gets the current state re-pushed. */
  connectionEpoch?: () => number
  /** Whether the bundled art is uploaded to the Discord application. */
  useUploadedArt?: boolean
  now?: () => Date
}

export type PresenceController = {
  poll: () => Promise<void>
  /**
   * Forgets what was last sent, so the next poll pushes again.
   * Why: an activity that was cleared — by a pause, a stop, or Discord restarting — is
   * no longer displayed, so the unchanged state must be sent a second time.
   */
  reset: () => void
}

/**
 * Dedups polling into Discord updates: an unchanged reading costs nothing, and the
 * elapsed timer resets only when the project changes, never on an agent churn.
 *
 * A failed apply is deliberately not remembered: Discord is often started after Orca,
 * and a remembered failure would leave the profile blank until the state changed.
 */
export function createPresenceController(deps: PresenceControllerDeps): PresenceController {
  const now = deps.now ?? (() => new Date())
  let lastKey: string | null = null
  let sessionStartedAt: Date | null = null
  let lastEpoch = deps.connectionEpoch?.() ?? 0

  return {
    async poll(): Promise<void> {
      // Why: after a reconnect the activity Discord holds is gone, so the same state must count as new.
      const epoch = deps.connectionEpoch?.() ?? lastEpoch
      if (epoch !== lastEpoch) {
        lastEpoch = epoch
        lastKey = null
      }

      let state: PresenceState | null
      try {
        state = await deps.readState()
      } catch {
        // Why swallowed: the Orca CLI may be missing or mid-update; the next tick retries.
        return
      }

      if (!state) {
        if (lastKey === '__none__') {
          return
        }
        if (await deps.clear().catch(() => false)) {
          lastKey = '__none__'
          sessionStartedAt = null
        }
        return
      }

      const key = JSON.stringify({
        project: state.projectName,
        agent: state.agentType,
        count: state.runningAgentCount,
        active: state.agentActive,
        branch: state.branchName
      })
      if (key === lastKey) {
        return
      }

      const startedAt = sessionStartedAt ?? now()
      const activity = buildActivity({
        projectName: state.projectName,
        agentType: state.agentType,
        runningAgentCount: state.runningAgentCount,
        agentActive: state.agentActive,
        branchName: state.branchName,
        startedAt,
        ...(deps.useUploadedArt !== undefined ? { useUploadedArt: deps.useUploadedArt } : {})
      })
      if (await deps.apply(activity).catch(() => false)) {
        lastKey = key
        sessionStartedAt = startedAt
      }
    },
    reset(): void {
      lastKey = null
      sessionStartedAt = null
    }
  }
}
