import { join } from 'node:path'
import { homedir, platform } from 'node:os'

function appDir(): string {
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'orca-discord-rpc')
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'orca-discord-rpc')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca-discord-rpc')
}

export const appDirPath = appDir
export const configPath = (): string => join(appDir(), 'config.json')
export const pidPath = (): string => join(appDir(), 'daemon.pid')
export const logPath = (): string => join(appDir(), 'daemon.log')
export const autostartShimPath = (): string => join(appDir(), 'autostart.vbs')
