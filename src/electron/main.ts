import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { createPresenceRuntime, type PresenceRuntimeStatus } from '../runtime.ts'
import { buildTrayMenuItems } from '../tray-menu.ts'
import { APP_DISPLAY_NAME, describeTrayStatus } from '../tray-status.ts'
import { loadConfig } from '../config.ts'

// Why read once: the menu shows it and the runtime needs it, and a config file cannot
// change under a running process without a restart anyway.
const CONFIG = loadConfig()

let tray: Tray | null = null
let runtime: ReturnType<typeof createPresenceRuntime> | null = null

function iconPath(): string {
  // Why resourcesPath: inside a packaged app the sources are gone, so the icon ships as an
  // extra resource and this resolves next to the executable.
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(app.getAppPath(), 'assets', 'tray.png')
}

function createTray(): Tray {
  try {
    const image = nativeImage.createFromPath(iconPath())
    // Why the fallback: a missing or unreadable icon must not stop the app.
    const usable = image.isEmpty() ? nativeImage.createEmpty() : image
    // Why only on macOS: the icon is a coloured ring, so it must not be treated as a template
    // image; a template would be recoloured to a solid block in the menu bar.
    if (process.platform === 'darwin') {
      usable.setTemplateImage(false)
    }
    return new Tray(usable)
  } catch (error) {
    console.error(`[tray] could not load the icon: ${String(error)}`)
    return new Tray(nativeImage.createEmpty())
  }
}

function applyTray(status: PresenceRuntimeStatus): void {
  if (!tray) {
    return
  }
  const described = describeTrayStatus(status)
  tray.setToolTip(described.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuItems({ status: described, runtime: status, clientId: CONFIG.clientId }).map(
        (item) =>
          item.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: item.label,
                enabled: item.enabled !== false,
                click: () => void onMenuClick(item.id)
              }
      )
    )
  )
}

async function onMenuClick(id: string): Promise<void> {
  if (runtime === null) {
    return
  }
  switch (id) {
    case 'quit':
      await runtime.stop()
      app.quit()
      return
    case 'toggle':
      if (runtime.getStatus().paused) {
        await runtime.start()
      } else {
        await runtime.pause()
      }
      return
    case 'reconnect':
      await runtime.stop()
      await runtime.start()
      return
    default:
      return
  }
}

// Why: a second copy would run a second presence fighting the first, which was observed as
// the profile flapping between two states. The lock makes the newest launch exit instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Why: tray-only on macOS; without this the app takes a Dock tile and a menu bar it never uses.
  if (process.platform === 'darwin') {
    app.dock?.hide()
  }

  void app.whenReady().then(async () => {
    tray = createTray()
    tray.setToolTip(APP_DISPLAY_NAME)

    runtime = createPresenceRuntime({
      clientId: CONFIG.clientId,
      pollMs: CONFIG.pollMs,
      useUploadedArt: CONFIG.useUploadedArt,
      log: (line) => console.log(`[presence] ${line}`)
    })
    runtime.subscribe(applyTray)
    await runtime.start()
    applyTray(runtime.getStatus())
  })
}
