import type { PresenceState } from './presence-controller.ts'

export type OrcaGatedReaderDeps = {
  isOrcaRunning: () => Promise<boolean>
  readState: () => Promise<PresenceState | null>
  /** Called once per open/closed transition, for logging. */
  onTransition?: (running: boolean) => void
}

export type OrcaGatedReader = {
  read: () => Promise<PresenceState | null>
  /** The last observed answer, or null before the first read. */
  isOrcaRunning: () => boolean | null
}

/**
 * Wraps the state reader so it only reads while the Orca app is running, and reports
 * "no state" when it is not.
 *
 * Without the gate the daemon kept reporting the last worktree it had read, so closing Orca
 * left "Using Orca" frozen on the profile. Reporting null makes the controller clear the
 * activity instead.
 */
export function createOrcaGatedStateReader(deps: OrcaGatedReaderDeps): OrcaGatedReader {
  let lastKnown: boolean | null = null

  return {
    async read(): Promise<PresenceState | null> {
      const running = await deps.isOrcaRunning()
      if (running !== lastKnown) {
        lastKnown = running
        deps.onTransition?.(running)
      }
      if (!running) {
        return null
      }
      return deps.readState()
    },
    isOrcaRunning: () => lastKnown
  }
}
