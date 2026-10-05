import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig, type ConfigFile } from './config.ts'
import { createPresenceRuntime } from './runtime.ts'
import { configPath, logPath, pidPath } from './paths.ts'

/** Kept short so a long-running daemon cannot fill the disk. */
const MAX_LOG_BYTES = 256 * 1024

function log(line: string): void {
  const target = logPath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    if (existingLogSize(target) > MAX_LOG_BYTES) {
      writeFileSync(target, '', 'utf8')
    }
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Why tolerated: logging must never be the reason the daemon dies.
  }
}

function existingLogSize(target: string): number {
  try {
    return readFileSync(target).length
  } catch {
    return 0
  }
}

function readConfigFile(): ConfigFile | null {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as ConfigFile
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const config = loadConfig({ readConfigFile })
  if (config.clientId.length === 0) {
    log('no Discord client id configured; set ORCA_DISCORD_CLIENT_ID or config.json. Exiting.')
    process.exitCode = 1
    return
  }

  mkdirSync(dirname(pidPath()), { recursive: true })
  writeFileSync(pidPath(), String(process.pid), 'utf8')
  log(`started pid=${process.pid} pollMs=${config.pollMs} clientId=${config.clientId}`)

  const runtime = createPresenceRuntime({
    clientId: config.clientId,
    pollMs: config.pollMs,
    useUploadedArt: config.useUploadedArt,
    log
  })

  // Why a subscription and not a poll: the connection flips once, long after start resolves.
  let announcedConnection = false
  runtime.subscribe((status) => {
    if (status.discordConnected && !announcedConnection) {
      announcedConnection = true
      log('connected to Discord')
    }
  })

  await runtime.start()

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    log('stopping')
    void runtime.stop().finally(() => {
      try {
        rmSync(pidPath(), { force: true })
      } catch {
        // ignore
      }
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (error) => {
    log(`uncaught: ${error.stack ?? error.message}`)
  })
}

void main()
