/**
 * Is the Orca desktop app running?
 *
 * This is what keeps the presence honest: with Orca closed, the daemon must clear the
 * activity and stop pushing, rather than reporting the last worktree it happened to read.
 */
export type OrcaProcessPlatform = 'win32' | 'darwin' | 'linux'

export type ProcessProbeResult = {
  stdout: string
  /** True when the probe command itself failed (missing tool, timeout). */
  failed: boolean
}

export type ProcessProbe = (command: string, args: readonly string[]) => Promise<ProcessProbeResult>

export type OrcaProcessOptions = {
  platform?: NodeJS.Platform
  exec?: ProcessProbe
}

export function orcaProcessName(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'Orca.exe'
  }
  // Why capitalized: the macOS app bundle ships an `Orca` executable.
  return platform === 'darwin' ? 'Orca' : 'orca'
}

/**
 * `tasklist` prints an INFO line and exits 0 when nothing matched, so the text is the signal.
 * The default output is space-padded and unquoted, while `/FO CSV` quotes the name and follows
 * it with a comma, so the name is matched at a line start and allowed to be a whole field.
 * Anchoring to the line start keeps a name like `NotOrca.exe` from matching.
 */
export function parseTasklist(output: string): boolean {
  return /^\s*"?Orca\.exe"?\s*[, ]/im.test(output)
}

export function parsePgrep(output: string): boolean {
  // Why numeric: pgrep can print a diagnostic to stdout on some builds.
  return /^\s*\d+\s*$/m.test(output)
}

async function defaultExec(
  command: string,
  args: readonly string[]
): Promise<ProcessProbeResult> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ stdout: stdout ?? '', failed: error !== null })
    )
  })
}

export async function isOrcaRunning(options: OrcaProcessOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? defaultExec
  const name = orcaProcessName(platform)

  const result =
    platform === 'win32'
      ? await exec('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'])
      : await exec('pgrep', ['-x', name])

  // Why false on failure: an unverifiable probe must not be read as "Orca is open",
  // or a missing tasklist would leave a stale presence on the profile forever.
  if (result.failed) {
    return false
  }
  return platform === 'win32' ? parseTasklist(result.stdout) : parsePgrep(result.stdout)
}
