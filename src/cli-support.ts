export type Command = 'start' | 'stop' | 'status' | 'autostart-enable' | 'autostart-disable' | 'help'

export function parseCommand(argv: readonly string[]): Command {
  const [first, second] = argv
  if (first === 'start' || first === 'stop' || first === 'status') {
    return first
  }
  if (first === 'autostart' && second === 'enable') {
    return 'autostart-enable'
  }
  if (first === 'autostart' && second === 'disable') {
    return 'autostart-disable'
  }
  return 'help'
}

/** Signal 0 probes existence without sending anything; EPERM still means the process exists. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function formatStatus(pid: number | null): string {
  return pid === null ? 'stopped' : `running (pid ${pid})`
}

export const HELP_TEXT = `orca-discord-rpc — Discord Rich Presence for Orca

Usage:
  orca-discord-rpc start     Start the background daemon
  orca-discord-rpc stop      Stop the daemon
  orca-discord-rpc status    Show whether the daemon is running
  orca-discord-rpc autostart enable   Start on login (Windows)
  orca-discord-rpc autostart disable  Do not start on login

Configuration (precedence: env > config.json > built-in):
  ORCA_DISCORD_CLIENT_ID     Discord application id
`
