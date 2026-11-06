import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBundledCliEntry, pluginDiscordPaths } from './plugin-platform.ts'

it('resolves the bundled Node CLI from all desktop layouts', () => {
  const cases: [NodeJS.Platform, string, string][] = [
    ['win32', 'C:/Tools/Orca/Orca.exe', 'C:\\Tools\\Orca\\resources\\app.asar.unpacked\\out\\cli\\index.js'],
    ['darwin', '/Applications/Orca.app/Contents/MacOS/Orca', '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js'],
    ['darwin', '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper', '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js'],
    ['linux', '/opt/Orca/orca-ide', '/opt/Orca/resources/app.asar.unpacked/out/cli/index.js'],
    ['linux', '/tmp/.mount_OrcaABC/orca', '/tmp/.mount_OrcaABC/resources/app.asar.unpacked/out/cli/index.js']
  ]
  for (const [platform, executable, expected] of cases) {
    assert.equal(resolveBundledCliEntry(executable, platform, path => path === expected), expected)
  }
  assert.throws(() => resolveBundledCliEntry('/opt/Orca/orca', 'linux', () => false), /bundled Orca CLI entry/)
  assert.throws(() => resolveBundledCliEntry('/usr/bin/node', 'darwin', () => true), /app bundle/)
  assert.throws(() => resolveBundledCliEntry('/opt/Orca/orca', 'freebsd', () => true), /Unsupported/)
})

it('uses Windows pipes and macOS Unix sockets', () => {
  assert.deepEqual(pluginDiscordPaths('win32', 'C:/Temp').map(path => path.format(0)), [String.raw`\\?\pipe\discord-ipc-0`])
  const mac = pluginDiscordPaths('darwin', '/var/folders/user/T').map(path => path.format(0))
  assert.ok(mac.includes('/var/folders/user/T/discord-ipc-0'))
  assert.ok(mac.includes('/tmp/discord-ipc-0'))
})

it('retains Linux runtime, temporary, Snap and Flatpak socket candidates without duplicates', () => {
  const paths = pluginDiscordPaths('linux', '/tmp', '/run/user/1000').map(path => path.format(3))
  assert.ok(paths.includes('/run/user/1000/discord-ipc-3'))
  assert.ok(paths.includes('/tmp/discord-ipc-3'))
  assert.ok(paths.includes('/run/user/1000/snap.discord/discord-ipc-3'))
  for (const app of ['com.discordapp.Discord', 'com.discordapp.DiscordCanary', 'com.discordapp.DiscordPTB', 'dev.vencord.Vesktop']) {
    assert.ok(paths.includes(`/run/user/1000/app/${app}/discord-ipc-3`))
  }
  assert.equal(paths.length, new Set(paths).size)
  assert.ok(pluginDiscordPaths('linux', '/tmp').some(path => path.format(0) === '/tmp/discord-ipc-0'))
  assert.throws(() => pluginDiscordPaths('freebsd', '/tmp'), /Unsupported/)
})
