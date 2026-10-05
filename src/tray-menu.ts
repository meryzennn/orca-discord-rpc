import type { PresenceRuntimeStatus } from './runtime.ts'
import { APP_DISPLAY_NAME, type TrayStatus } from './tray-status.ts'

export type TrayMenuItem = {
  id: string
  label: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

/** Pure: the Electron layer only maps these rows onto a Menu. */
export function buildTrayMenuItems(input: {
  status: TrayStatus
  runtime: PresenceRuntimeStatus
  clientId: string
}): TrayMenuItem[] {
  const reconnect: TrayMenuItem[] = input.runtime.discordConnected
    ? []
    : [{ id: 'reconnect', label: 'Reconnect to Discord' }]

  return [
    { id: 'header', label: APP_DISPLAY_NAME, enabled: false },
    { id: 'status', label: input.status.headline, enabled: false },
    { id: 'separator-1', label: '', type: 'separator' },
    { id: 'toggle', label: input.runtime.paused ? 'Enable presence' : 'Disable presence' },
    ...reconnect,
    { id: 'app-id', label: `Application id: ${input.clientId}`, enabled: false },
    { id: 'separator-2', label: '', type: 'separator' },
    { id: 'quit', label: 'Quit' }
  ]
}
