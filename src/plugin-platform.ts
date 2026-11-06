import { existsSync } from 'node:fs'
import { win32, posix } from 'node:path'

export function resolveBundledCliEntry(
  executable: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): string {
  const path = platform === 'win32' ? win32 : posix
  let resources: string
  if (platform === 'darwin') {
    const components = executable.split('/')
    const outerApp = components.findIndex((part, index) =>
      part.toLowerCase().endsWith('.app') && components[index + 1] === 'Contents')
    if (outerApp < 0) throw new Error('Could not locate the Orca app bundle')
    resources = path.join(components.slice(0, outerApp + 1).join('/'), 'Contents', 'Resources')
  } else if (platform === 'win32' || platform === 'linux') {
    resources = path.join(path.dirname(executable), 'resources')
  } else {
    throw new Error(`Unsupported Orca desktop platform: ${platform}`)
  }
  const entry = path.join(resources, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  if (!exists(entry)) throw new Error('Could not locate the bundled Orca CLI entry')
  return entry
}

export function pluginDiscordPaths(
  platform: NodeJS.Platform,
  temporaryDirectory: string,
  runtimeDirectory?: string
): { platform: NodeJS.Platform[]; format(id: number): string }[] {
  if (platform === 'win32') {
    return [{ platform: ['win32'], format: id => String.raw`\\?\pipe\discord-ipc-${id}` }]
  }
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`Unsupported IPC platform: ${platform}`)
  const roots = [...new Set([runtimeDirectory, temporaryDirectory, '/tmp'].filter(
    (root): root is string => typeof root === 'string' && root.length > 0))]
  const suffixes = platform === 'linux'
    ? ['', 'snap.discord', 'app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary',
      'app/com.discordapp.DiscordPTB', 'app/dev.vencord.Vesktop']
    : ['']
  return roots.flatMap(root => suffixes.map(suffix => ({
    platform: [platform], format: (id: number) => posix.join(root, suffix, `discord-ipc-${id}`)
  })))
}
