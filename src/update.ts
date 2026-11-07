import { execFile, type ExecFileException } from 'node:child_process'
import { homedir } from 'node:os'
import { pluginCliEnv } from './orca-reader.ts'
import { isRecord } from './type-guards.ts'

export type PluginUpdateResult = { status: 'updated' | 'up-to-date' | 'pinned'; version: string }

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<{
  error: ExecFileException | null; stdout: string
}> {
  return new Promise(resolve => {
    execFile(command, args, {
      ...options, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true
    }, (error, stdout) => resolve({ error, stdout }))
  })
}

/** Updates the published Git installation; development folders keep their own source. */
export async function updateInstalledPlugin(command: string, nodeEntry: string): Promise<PluginUpdateResult> {
  const pluginKey = 'meryzennn.discord-presence'
  const { error, stdout } = await run(command, [nodeEntry, 'plugin', 'update', pluginKey, '--json'], {
    env: pluginCliEnv(process.env, process.platform, homedir())
  })
  const unconfirmed = 'Could not confirm the RPC update. Check Orca Settings > Plugins.'
  let response: unknown
  try { response = JSON.parse(stdout) } catch { throw new Error(unconfirmed) }
  if (!isRecord(response)) throw new Error(unconfirmed)
  if (response.ok !== true) {
    const failure = isRecord(response.error) ? response.error : {}
    if (failure.code === 'invalid_argument' && typeof failure.message === 'string' &&
      failure.message.startsWith('Unknown command: plugin update')) {
      throw new Error('Updating requires Orca 1.4.253 or newer. Upgrade the Orca application first.')
    }
    if (failure.code === 'approval_required' || failure.code === 'approval_stale') {
      throw new Error('This update needs review in Orca Settings > Plugins. The current version stays installed.')
    }
    if (failure.code === 'plugin_not_found') {
      throw new Error('No Git installation of Discord RPC was found. Install it through Orca Settings > Plugins first.')
    }
    if (failure.code === 'git_auth_failed') {
      throw new Error('Git authentication failed. Check the Orca host\'s Git sign-in and retry.')
    }
    throw new Error(unconfirmed)
  }
  const result = response.result
  if (error || !isRecord(result) || result.pluginKey !== pluginKey ||
    (result.status !== 'updated' && result.status !== 'up-to-date' && result.status !== 'pinned') ||
    typeof result.version !== 'string' || result.version.length > 80 ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(result.version)) {
    throw new Error(unconfirmed)
  }
  return { status: result.status, version: result.version }
}

/** Git refuses non-fast-forward updates and untracked files that would be overwritten. */
export async function updateHeadlessCheckout(root: string): Promise<boolean> {
  const git = async (args: string[]): Promise<string> => {
    const result = await run('git', ['-C', root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (result.error) {
      throw new Error('Git ' + args.join(' ') + ' failed. Run it in the headless checkout to inspect the problem.')
    }
    return result.stdout.trim()
  }
  if (await git(['rev-parse', '--show-prefix'])) {
    throw new Error('Headless update must run from the repository root.')
  }
  if (await git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Commit or stash tracked changes before updating the headless daemon.')
  }
  const before = await git(['rev-parse', 'HEAD'])
  await git(['pull', '--ff-only'])
  return before !== await git(['rev-parse', 'HEAD'])
}
