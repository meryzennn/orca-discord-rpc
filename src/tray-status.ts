import type { PresenceRuntimeStatus } from './runtime.ts'

export type TrayStatusTone = 'ok' | 'idle' | 'waiting' | 'error'

export type TrayStatus = {
  tone: TrayStatusTone
  headline: string
  detail: string
  tooltip: string
}

export const APP_DISPLAY_NAME = 'Orca Discord Presence'

/** Maps runtime state to the one line a menu shows, most actionable problem first. */
export function describeTrayStatus(status: PresenceRuntimeStatus): TrayStatus {
  const detail = status.lastActivity?.state ?? ''

  if (status.lastError !== null) {
    return finish('error', 'Problem', status.lastError)
  }
  if (status.paused) {
    return finish('idle', 'Presence paused', 'Enable it from this menu')
  }
  if (!status.orcaRunning) {
    return finish('idle', 'Orca is not running', 'Waiting for Orca to open')
  }
  if (!status.discordConnected) {
    return finish('waiting', 'Discord not detected', 'Is the Discord desktop client running?')
  }
  if (status.lastActivity !== null) {
    return finish('ok', status.lastActivity.details, detail)
  }
  return finish('idle', 'No agent detected', detail)
}

function finish(tone: TrayStatusTone, headline: string, detail: string): TrayStatus {
  const tooltip =
    detail.length > 0
      ? `${APP_DISPLAY_NAME} — ${headline} (${detail})`
      : `${APP_DISPLAY_NAME} — ${headline}`
  return { tone, headline, detail, tooltip }
}
