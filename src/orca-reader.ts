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
import { findAgentModel } from './agent-model.ts'

const ORCA_TIMEOUT_MS = 10_000

/**
 * Windows ships both `orca.exe` and an `orca.cmd` shim; spawn the .exe directly so no
 * shell is involved (a shell would concatenate the arguments and warn on deprecation).
 */
const ORCA_COMMAND = process.platform === 'win32' ? 'orca.exe' : 'orca'

export function runOrcaWorktreePs(command: string = ORCA_COMMAND, nodeEntry?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...(nodeEntry ? [nodeEntry] : []), 'worktree', 'ps', '--json'],
      {
        timeout: ORCA_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: nodeEntry ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
      },
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

export async function readPresenceState(
  runWorktreePs: () => Promise<string> = runOrcaWorktreePs
): Promise<PresenceState | null> {
  const worktrees = parseWorktreePs(await runWorktreePs())
  const active = selectActiveWorktree(worktrees)
  if (!active) {
    return null
  }
  const featured = featuredAgent(active)
  const agentType = typeof featured?.agentType === 'string' ? featured.agentType : null
  return {
    projectName: projectNameFor(active),
    // Why the agent type and not a label: the builder owns naming and art for it.
    agentType,
    model: findAgentModel(agentType, typeof active.path === 'string' ? active.path : null),
    runningAgentCount: runningAgentCount(active),
    agentActive: hasActiveAgent(active),
    branchName: branchNameFor(active)
  }
}
