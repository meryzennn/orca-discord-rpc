#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCommand, isProcessAlive, formatStatus, HELP_TEXT } from './cli-support.ts'
import { appDirPath, pidPath, autostartShimPath } from './paths.ts'

const here = dirname(fileURLToPath(import.meta.url))

function readPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function runningPid(): number | null {
  const pid = readPid()
  return pid !== null && isProcessAlive(pid) ? pid : null
}

function startDaemon(): number {
  const child = spawn(process.execPath, [join(here, 'daemon.ts')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  return child.pid ?? 0
}

function stopDaemon(): boolean {
  const pid = runningPid()
  if (pid === null) {
    return false
  }
  try {
    process.kill(pid)
  } catch {
    return false
  }
  try {
    rmSync(pidPath(), { force: true })
  } catch {
    // ignore
  }
  return true
}

const AUTOSTART_SHIM = [
  'Set shell = CreateObject("WScript.Shell")',
  'shell.Run """{node}"" ""{daemon}""", 0, False',
  ''
].join('\r\n')

function enableAutostart(): void {
  mkdirSync(appDirPath(), { recursive: true })
  const shim = autostartShimPath()
  writeFileSync(
    shim,
    AUTOSTART_SHIM.replace('{node}', process.execPath).replace('{daemon}', join(here, 'daemon.ts')),
    'utf8'
  )
  // Why wscript: a .vbs shim launches the daemon without a console window flashing on login.
  spawn(
    'reg',
    [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'OrcaDiscordRpc',
      '/t',
      'REG_SZ',
      '/d',
      `wscript.exe "${shim}"`,
      '/f'
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
}

function disableAutostart(): void {
  spawn(
    'reg',
    [
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'OrcaDiscordRpc',
      '/f'
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
  try {
    rmSync(autostartShimPath(), { force: true })
  } catch {
    // ignore
  }
}

function main(): void {
  const command = parseCommand(process.argv.slice(2))
  switch (command) {
    case 'start': {
      if (runningPid() !== null) {
        console.log('already running')
        return
      }
      const pid = startDaemon()
      console.log(pid > 0 ? `started (pid ${pid})` : 'started')
      return
    }
    case 'stop':
      console.log(stopDaemon() ? 'stopped' : 'not running')
      return
    case 'status':
      console.log(formatStatus(runningPid()))
      return
    case 'autostart-enable':
      enableAutostart()
      console.log('autostart enabled')
      return
    case 'autostart-disable':
      disableAutostart()
      console.log('autostart disabled')
      return
    default:
      console.log(HELP_TEXT)
  }
}

main()
