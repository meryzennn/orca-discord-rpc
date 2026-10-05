// Why baked in: a Discord application id is a public identifier, not a secret, so the
// daemon works with no setup. Override with ORCA_DISCORD_CLIENT_ID or config.json.
export const DEFAULT_CLIENT_ID = '1556649058657902712'

/** Discord allows ~5 activity updates per 20 seconds; 15s stays inside that. */
export const DEFAULT_POLL_MS = 15_000
const MIN_POLL_MS = 5_000

export type AppConfig = {
  clientId: string
  pollMs: number
  /** True once the bundled PNGs are uploaded to the Discord application under matching keys. */
  useUploadedArt: boolean
}

export type ConfigFile = {
  clientId?: unknown
  pollMs?: unknown
  useUploadedArt?: unknown
}

export type LoadConfigOptions = {
  env?: Record<string, string | undefined>
  readConfigFile?: () => ConfigFile | null
}

function readPollMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_POLL_MS) {
    return DEFAULT_POLL_MS
  }
  return Math.trunc(value)
}

// Precedence: env var > config.json > baked-in default.
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env
  let file: ConfigFile | null = null
  try {
    file = options.readConfigFile?.() ?? null
  } catch {
    // Why tolerated: a corrupt config must not stop the daemon from starting.
    file = null
  }

  const envClientId = env.ORCA_DISCORD_CLIENT_ID
  const fileClientId = typeof file?.clientId === 'string' ? file.clientId : undefined
  const clientId =
    envClientId && envClientId.length > 0
      ? envClientId
      : fileClientId && fileClientId.length > 0
        ? fileClientId
        : DEFAULT_CLIENT_ID

  // An env override is handy for a one-off run without editing the config file.
  const useUploadedArt =
    env.ORCA_DISCORD_UPLOADED_ART === '1' || file?.useUploadedArt === true

  return { clientId, pollMs: readPollMs(file?.pollMs), useUploadedArt }
}
