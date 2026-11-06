import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
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

export function pluginCliEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, userHome: string): NodeJS.ProcessEnv {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    // Orca's Windows CLI needs this known folder to find its runtime metadata.
    ...(platform === 'win32' && env.APPDATA === undefined
      ? { APPDATA: win32.join(userHome, 'AppData', 'Roaming') }
      : {})
  }
}

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
        env: nodeEntry ? pluginCliEnv(process.env, process.platform, homedir()) : process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          let cliMessage = ''
          try {
            const response = JSON.parse(stdout)
            if (response?.ok === false && typeof response.error?.message === 'string') {
              cliMessage = response.error.message.trim()
            }
          } catch {}
          const diagnostics = [cliMessage, stderr.trim()].filter(message => message && !error.message.includes(message))
          if (diagnostics.length) error.message += `\n${diagnostics.join('\n')}`
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

export async function readPresenceState(
  runWorktreePs: () => Promise<string> = runOrcaWorktreePs,
  resolveRepoUrl?: (path: string) => Promise<string | null>,
  findModel: (agentType: string | null, worktreePath: string | null) => string | null = findAgentModel
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
    model: findModel(agentType, typeof active.path === 'string' ? active.path : null),
    runningAgentCount: runningAgentCount(active),
    agentActive: hasActiveAgent(active),
    branchName: branchNameFor(active),
    ...(resolveRepoUrl ? { repoUrl: typeof active.path === 'string' && active.path.length > 0
      ? await resolveRepoUrl(active.path) : null } : {})
  }
}
