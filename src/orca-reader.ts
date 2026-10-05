import { execFile } from 'node:child_process'
import {
  parseWorktreePs,
  selectActiveWorktree,
  featuredAgent,
  hasActiveAgent,
  projectNameFor,
  branchNameFor,
  runningAgentCount
} from './orca-state.ts'
import type { PresenceState } from './presence-controller.ts'

const ORCA_TIMEOUT_MS = 10_000

/**
 * Windows ships both `orca.exe` and an `orca.cmd` shim; spawn the .exe directly so no
 * shell is involved (a shell would concatenate the arguments and warn on deprecation).
 */
const ORCA_COMMAND = process.platform === 'win32' ? 'orca.exe' : 'orca'

export function runOrcaWorktreePs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ORCA_COMMAND,
      ['worktree', 'ps', '--json'],
      { timeout: ORCA_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

export async function readPresenceState(): Promise<PresenceState | null> {
  const worktrees = parseWorktreePs(await runOrcaWorktreePs())
  const active = selectActiveWorktree(worktrees)
  if (!active) {
    return null
  }
  const featured = featuredAgent(active)
  return {
    projectName: projectNameFor(active),
    // Why the agent type and not a label: the builder owns naming and art for it.
    agentType: typeof featured?.agentType === 'string' ? featured.agentType : null,
    runningAgentCount: runningAgentCount(active),
    agentActive: hasActiveAgent(active),
    branchName: branchNameFor(active)
  }
}
