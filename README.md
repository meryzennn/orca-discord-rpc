<div align="center">

# orca-discord-rpc

<img src="discord.png" width="56" alt="Discord Logo" />

### Discord Rich Presence for [Orca](https://github.com/stablyai/orca)
Shows your active Orca workspace and the agent you are working with on your Discord profile.

[![Release](https://img.shields.io/github/v/release/meryzennn/orca-discord-rpc?color=5865F2&logo=github)](https://github.com/meryzennn/orca-discord-rpc/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## Discord profile preview

<p align="center">
  <img src="discordprofile.png" width="450" alt="Orca activity on a Discord profile" />
</p>

This screenshot shows the standalone Windows layout from before v0.1.7. The first line now reads `Agent: Antigravity · Working` and the second `Folder: orca-discord-rpc`. The current layouts are in [What Discord shows](#what-discord-shows).

---

## Standalone Windows features

- Shows the featured agent, how many other agents are open, the workspace folder, whether the agent is working or idle, and a session timer.
- Adds a View Repository button that opens the workspace's `origin` remote in the browser.
- Incognito Mode replaces the folder with `Private Project`, hides the branch and the repository button, and shows the agent's icon instead. Hovering the icon shows the model, such as `Claude Opus 5.5`.
- Runs from any folder with no installer. The exe is never copied anywhere; only `config.json` and `tray.log` are written, to `%LOCALAPPDATA%\orca-discord-rpc`.
- Checks GitHub for a new release 5 seconds after start, then every 30 minutes. When one exists, the tray icon gets a red dot, and one click downloads it, replaces the files and restarts the app.
- Only one copy runs at a time. A second launch shows a message and exits, so two copies never fight over your profile.

---

## Install as an Orca plugin (Windows, macOS and Linux, upcoming v0.2.0)

The plugin is implemented locally for v0.2.0. GitHub `main` and the latest v0.1.9 release do not contain it yet. Use the [local development route](#plugin-development) to test the completed local snapshot; the Git installation below becomes available after that snapshot is published.

Requires Orca 1.4.250 or newer and the Discord desktop app. Once the plugin version is published:

1. In Orca, open Settings → Plugins → Add Plugin, choose a Git source, and enter `https://github.com/meryzennn/orca-discord-rpc`.
2. Select a version containing the root `orca-plugin.json` and committed `plugin/runtime.mjs`.
3. Review Orca's one-time full-access worker approval and the requested `workspace:read`, `agent:read` and `settings:own` permissions, then approve and enable the plugin.

RPC starts with Orca and runs in Orca's managed background worker, without opening a panel or making agent tool calls. It uses Orca's bundled Node runtime and CLI: there is no separate EXE, tray app, Node installation or npm setup for plugin users. The status bar shows `RPC`, `RPC waiting` or `RPC paused`; click it to pause or resume presence. Incognito Mode is in the plugin's settings. Closing Orca or disabling/uninstalling the plugin stops its presence.

Before migrating, stop the old presence provider yourself. On Windows, untick Start with Windows and quit the old tray app; on macOS/Linux, stop the existing headless daemon if you use it. Do not run two presence providers together. The plugin does not change OS autostart settings.

On first startup, the plugin copies Incognito from the existing `config.json` only when no plugin value is saved. Later changes stay in Orca's plugin settings. Incognito replaces the folder with `Private Project` and removes the actual branch; the old activity is cleared before the privacy update is published. The public Discord application id, poll interval and uploaded-art flag still come from that file or built-in defaults. See [Configuration](#configuration) for file locations and worker environment limits.

The first plugin version uses the existing headless presence layout and large agent-icon slot. The View Repository button and the standalone C# app's different normal/Incognito layouts remain features of the separate Windows app. Plugin memory use has not been measured.

Real Orca/Discord lifecycle acceptance and remote Windows/macOS/Linux CI runs are still pending. The [manual acceptance checklist](#manual-plugin-acceptance) records those checks separately from automated payload and bundle checks.

---

## Install the standalone app (Windows)

1. Download `OrcaPresence-windows.zip` from the [latest release](https://github.com/meryzennn/orca-discord-rpc/releases/latest).
2. Extract it anywhere, for example `C:\Tools\OrcaPresence`, and double-click `OrcaPresence.exe`.
3. The app runs in the system tray. To launch it at login, right-click the tray icon and tick Start with Windows.

To uninstall, untick Start with Windows and delete the folder. Settings and logs stay in `%LOCALAPPDATA%\orca-discord-rpc` until you delete that folder as well.

### Command line

Autostart can also be set from PowerShell or Command Prompt:

```sh
OrcaPresence.exe autostart enable    # start at login, pointing at this exe
OrcaPresence.exe autostart disable   # stop starting at login
OrcaPresence.exe autostart status    # show the current entry
```

The entry lives under `HKEY_CURRENT_USER`, so no administrator rights are needed.

---

## Requirements

- Orca 1.4.250 or newer for the plugin. Standalone modes require the Orca CLI on `PATH`.
- The Discord desktop app, running and logged in. Discord in a browser has no local IPC socket, so it cannot show Rich Presence.
- Windows, macOS or Linux for the plugin, using the same bundled JavaScript worker on all three OSes.
- Windows 10 or 11 for the standalone tray app. It runs on .NET Framework 4.8, which ships with Windows 10 (May 2019 Update and later) and Windows 11, so there is nothing else to install.
- Node.js 24+ for standalone headless use or plugin development; plugin users use Orca's bundled runtime.

---

## What Discord shows

### Plugin and headless daemon

With an agent open, line 1 reads `Claude +1` and line 2 reads `orca-discord-rpc · Working` or `orca-discord-rpc · Idle`. The large icon uses agent artwork or an Orca fallback, with the model in its tooltip when available; the small branch icon shows the branch in its tooltip. With no agent open, line 1 reads `Using Orca` and line 2 shows the folder. Both retain the session timer. The plugin's Incognito setting changes the folder to `Private Project` and leaves no actual branch in the tooltip. This layout has no View Repository button.

### Standalone Windows app

| Field | Normal | Incognito |
| --- | --- | --- |
| Line 1 | `Agent: Claude +1 · Working` | Same |
| Line 2 | `Folder: orca-discord-rpc` | `Folder: Private Project` |
| Timer | Time since the session started | Same |
| Small icon | Branch icon; hovering shows the branch name | Agent icon; hovering shows the model, such as `Claude Opus 5.5` |
| Button | View Repository, when the workspace has an `origin` remote | None |

With no agent open, line 1 reads `Using Orca` and line 2 shows the folder.

How each value is chosen:

- The featured agent is the one that most recently changed state. A working agent wins over an idle one, so the busier session is the one people see. `+1` counts the other open agent panes.
- The folder comes from the workspace path. A workspace you renamed in Orca keeps its name.
- Orca does not report which model an agent runs, so the app reads it from the agent's own session log: Claude Code from `%USERPROFILE%\.claude\projects` (or `CLAUDE_CONFIG_DIR`), Codex from `%USERPROFILE%\.codex\sessions` (or `CODEX_HOME`). When two sessions share one workspace, the one that wrote most recently wins. Other agents, or a missing log, fall back to `Agent: <name>`.
- The timer keeps running when you switch workspace or agent, and resets when Orca closes or no workspace is active.

---

## Tray menu

In the standalone Windows app, right-click the tray icon. The second row shows the current status:

| Status row | Meaning |
| --- | --- |
| `Agent: Claude · Working` | Everything works; this is what your profile shows |
| `Using Orca` | Orca is open but no agent is running |
| `Discord not detected` | Orca is open but Discord is not; a Reconnect to Discord row appears |
| `Orca is not running` | Waiting for Orca to open |
| `Presence paused` | You turned presence off; choose Enable presence to turn it back on |
| `Problem` | The last update failed; the tray tooltip names the reason |

The other rows, top to bottom:

- Update to vX.Y.Z (Click to auto-update), only when a new release is waiting
- Disable presence, or Enable presence while paused
- Application id, for reference
- Incognito Mode
- Start with Windows
- Check for updates..., when no update is waiting
- Star on GitHub, which opens this repository
- Quit

---

## Size and memory

| | Tray app (C#) | Headless daemon (Node) | Electron app (retired) |
| --- | --- | --- | --- |
| Download | 1.7 MB folder, 611 KB exe | 36 MB `node_modules`, dev tools included | 106 MB installer |
| Memory | 13.8 MB working set, 34 MB private | Not measured | 224 MB |
| Processes | 1 | 1 | 3 |

The tray app's memory was measured with `Get-Process` on one machine on 2026-10-11. Every 5 minutes the app calls `SetProcessWorkingSetSize`, which lowers the working set Task Manager shows; the private memory it holds stays the same.

---

## Configuration

A Discord application id is built in, so all modes work without creating an application. Standalone Windows users can set environment variables to use their own application, uploaded art, or Incognito by default:

```sh
setx ORCA_DISCORD_CLIENT_ID "123456789012345678"
setx ORCA_DISCORD_UPLOADED_ART "1"
setx ORCA_DISCORD_INCOGNITO "1"
```

or edit `config.json`:

| OS | Configuration file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\orca-discord-rpc\config.json` |
| macOS | `~/Library/Application Support/orca-discord-rpc/config.json` |
| Linux | `~/.config/orca-discord-rpc/config.json` |

```json
{
  "clientId": "123456789012345678",
  "pollMs": 15000,
  "useUploadedArt": true,
  "incognito": false
}
```

For standalone modes, environment variables win over the file; the Linux daemon also honors `XDG_CONFIG_HOME` for its configuration directory. The Incognito Mode row in the Windows tray menu writes `incognito` to this file. A `pollMs` under 5000 is ignored and the 15 second default is used instead, which stays inside Discord's limit of about 5 updates per 20 seconds.

For the plugin, set `clientId`, `pollMs` and `useUploadedArt` in the file and reload the plugin after editing them. Manage Incognito in Orca's plugin settings after its first-run migration. Orca scrubs shell environment overrides from workers, so `ORCA_DISCORD_*`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` overrides are not supported configuration routes in plugin mode.

Oh My Pi is recognized as `omp` and displayed as `Oh My Pi`. In the Windows tray app, its logo occupies the small agent-icon slot during Incognito Mode; normal mode keeps the branch icon. The public-image fallback uses the [official upstream PNG](https://raw.githubusercontent.com/can1357/oh-my-pi/75e7801e247d4e3263439d4cc08ccad60dc64bdd/packages/collab-web/public/favicon-512x512.png). If Discord does not render that URL, upload the PNG to your Discord application's Rich Presence art assets with the key `omp`, then enable `useUploadedArt` for that application. This setting also makes the existing icons use their uploaded keys, so the application needs the other assets you use, including `orca` and `git-branch`. The plugin and headless daemon display the same Oh My Pi logo in their existing large agent-icon slot.

---

## Build and development

### Plugin development

In the local v0.2.0 implementation checkout, use Node.js 24+:

```sh
npm ci
npm run build:plugin
npm test
npm run typecheck
orca plugin validate . --json
orca plugin inspect . --json
```

`build:plugin` generates `plugin/runtime.mjs` and `plugin/THIRD-PARTY-NOTICES.txt`. Git installation uses committed files, so rebuild and commit both whenever plugin source or dependencies change. These are developer commands; installation from a published Git snapshot needs none of them.

`inspect` includes local ignored files, so dependencies and build outputs can push a development checkout over Orca's 50 MiB folder limit. Do not remove user files to bypass that limit. Validate and inspect a separate clean snapshot of committed files instead. Orca's Git installer reads exact commit blobs, including their original line endings, without local checkout filters. To produce matching bytes for a local check, create a ZIP from the committed implementation:

```sh
git -c core.autocrlf=false archive --format=zip --output=../orca-rpc-plugin-check.zip HEAD
```

Extract it to a separate folder, then replace `<clean-plugin-folder>` below with that folder's absolute path. Run the Orca CLI on the machine hosting Orca. On Linux outside an Orca-managed terminal, use `orca-ide` instead of `orca`; bare `orca` can be the GNOME screen reader.

```sh
orca plugin validate "<clean-plugin-folder>" --json
orca plugin inspect "<clean-plugin-folder>" --json
```

To test locally before publication, first stop the old provider, then run this yourself:

```sh
orca plugin dev load "<clean-plugin-folder>" --json
```

This adds a Development folder in Settings → Plugins. The worker requires full-access approval: review the requested access and rerun the exact command Orca returns with `--approve <fingerprint>` to approve this snapshot. Do not use a bare `--approve` or a fingerprint from another build. Orca reloads approved development plugins when their files change. When finished, run `orca plugin dev unload "<clean-plugin-folder>" --json` yourself.

### Manual plugin acceptance

Run these checks yourself on Windows, macOS and Linux and record each result per OS as passed, failed or unavailable. Static validation and isolated bundle imports do not prove real host activation or rendered Discord artwork.

1. Stop the old presence provider. Load and approve the clean local snapshot, or install the published snapshot through Add Plugin when available, then enable it.
2. With no panel open and no agent tool calls, confirm presence starts and the native RPC status item updates.
3. Click RPC to pause, then resume; confirm the same activity returns. Change Incognito and check that the actual folder and branch do not remain visible after the privacy update.
4. Change the active workspace and agent, including Oh My Pi and an idle open agent. Check the selected folder, agent count, status, model and artwork.
5. Close/reopen Discord and confirm a later poll retries. Close/reopen Orca and confirm automatic restart without manually starting RPC.
6. Disable/uninstall the plugin and confirm presence disappears with no detached worker or CLI child. Re-enable it and check startup without opening a panel; for a development folder, unload and load it again.
7. Check macOS main/Helper app paths and Linux AppImage paths. On Linux, record normal Discord and each supported Snap/Flatpak variant actually tested. Denied socket access should show a retryable waiting state; do not change permissions to make a check pass.
8. If an external icon is accepted but not displayed, use `useUploadedArt` with matching uploaded asset keys. A correct payload does not prove Discord rendered the image.

The repository includes a Windows/macOS/Linux Node CI matrix, but its remote jobs have not run for this local implementation. Record unavailable hosts honestly; they remain release targets and still need real lifecycle acceptance.

### Windows tray app

```sh
npm run build:csharp                    # build the icon and publish to dist-csharp
npm run pack:csharp                     # zip dist-csharp into OrcaPresence-windows.zip
dotnet test csharp/OrcaPresence.Tests   # run the tests
```

### Headless daemon (macOS, Linux, or scripted use)

```sh
npm install
npm start          # start the daemon, logging to daemon.log
npm test           # run the tests
npm run typecheck
```

---

## How it works

```
orca worktree ps --json ──► parse ──► select the active worktree
                                            │
                       folder + open agents ──► dedup by payload
                                            │
                 hand-rolled Discord IPC ──► the local named pipe
```

- The tray app talks to Discord over its local named pipe, `\\.\pipe\discord-ipc-0`, without a Discord SDK.
- The plugin and headless daemon use the RPC library with named pipes on Windows and Unix sockets on macOS/Linux. The plugin bundles that library and resolves Orca's packaged CLI per platform instead of launching a standalone provider.
- It runs `orca worktree ps --json` every 15 seconds by default, and sends Discord an update only when what it would show has changed.
- When Discord or Orca restarts, the next poll reconnects and sends the current state again.
- Errors go to `tray.log` (tray app), `daemon.log` (daemon) or Orca's plugin logs instead of popping up.

---

## License

MIT. See [LICENSE](LICENSE).
