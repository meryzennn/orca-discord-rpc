# orca-discord-rpc

Discord Rich Presence for [Orca](https://github.com/stablyai/orca) — shows the workspace you
are active in and the agent running there, on your Discord profile.

```
Claude +1
orca-discord-rpc · Working
0:42 elapsed
```

Two ways to run it, sharing the same presence rules:

- **C# tray app (Windows)** — a single small exe, no runtime to install, ~2–8 MB of RAM (with working-set auto-trimming).
- **Headless Node daemon** — `node src/cli.ts start`, for a checkout, a scripted setup, or a
  non-Windows host.

## Requirements

- **Orca installed**, with the `orca` CLI resolvable on `PATH`
- **Discord desktop client running and logged in** — browser Discord does not expose the local
  IPC socket this depends on
- The C# app needs nothing else: it targets the .NET Framework that ships with Windows.
  The headless path needs **Node.js 24+**.

## Install & Usage (Windows, C# app)

`OrcaPresence` is a standalone, portable application:

1. Download or build `OrcaPresence.exe` and place it in any folder you like.
2. Double-click `OrcaPresence.exe` to run it. It appears directly in your system tray.
3. Right-click the tray icon and check **Start with Windows** if you want it to run automatically on boot.

To disable auto-start, simply uncheck **Start with Windows** in the tray menu (or delete the application folder).

### Optional CLI commands

You can also manage auto-start from the terminal:

```sh
OrcaPresence.exe autostart enable    # turns on start-at-login pointing to this exe
OrcaPresence.exe autostart disable   # turns off start-at-login
OrcaPresence.exe autostart status    # checks whether autostart is on and points to this exe
```

No installer and no administrator prompt required: settings are kept in the user's `HKEY_CURRENT_USER` registry hive.

> Only one copy may run. A second launch exits immediately, so two presences can never fight over
> the profile.

## Build the C# app

```sh
npm run build:csharp                    # generates icons and publishes to dist-csharp
dotnet test csharp/OrcaPresence.Tests   # 89 tests
```


## What Discord shows

| Field | Content |
| --- | --- |
| Line 1 | The featured agent, plus `+N` when other agents are open — `Claude +1` |
| Line 2 | The workspace folder, then `Working` or `Idle` |
| Timer | Elapsed since you switched workspace |
| Small image | A branch icon; its tooltip is the branch name |

There is no per-agent logo. Discord renders only artwork registered on the application and
accepts no external image, so a logo would need an upload step on every agent — the agent's name
already says which one is running.

The **featured agent** is the one that most recently entered its state — so opening Codex shows
`Codex`, and its name stays there while it waits between turns. A live agent outranks a newer
idle one. `+N` counts every agent whose pane is open, whether or not it is mid-turn.

Line 2 names the **folder**, taken from the workspace path. Orca's own display name defaults to
the branch on a git worktree, which is why an earlier version read as a branch; a workspace you
renamed in Orca keeps your label.

## Tray menu

The tray icon is the control surface. Right-click it for the current state:

| Row | Meaning |
| --- | --- |
| `Claude` | Healthy — that agent is what the profile shows |
| `Discord not detected` | Orca is open, Discord is not; a **Reconnect** row appears |
| `Orca is not running` | Waiting for Orca to open |
| `Presence paused` | You turned it off; **Enable presence** turns it back on |
| `Problem` | The last push failed, with the reason |

Below the state: **Disable/Enable presence**, **Reconnect to Discord** (only while Discord is
missing), the application id in use, a checkable **Start with Windows** row, and **Quit**.

The tray app never opens a window and never takes focus, and only one copy can run at a time.

## Artwork

Only the branch icon is left, and it needs no setup: without registered artwork the C# app falls
back to a public favicon for that slot. To use your own image instead, register it on the Discord
application (Rich Presence → Art Assets) under the key `git-branch`, then set:

```sh
setx ORCA_DISCORD_UPLOADED_ART "1"
```

Discord renders only artwork registered on the application. An external image URL is accepted on
the wire but never displayed, and a loopback URL (`127.0.0.1`) is never even fetched — both were
verified against a live client. That is a Discord rule, not a setting this tool can work around.

## Configuration

A Discord **Application ID** is baked in — it is a public identifier, not a secret — so no
Developer Portal account is needed to start. Override it to use your own application name and
art. Precedence: environment variable → `config.json` → baked-in default.

```sh
setx ORCA_DISCORD_CLIENT_ID "123456789012345678"
```

```json
// %LOCALAPPDATA%\orca-discord-rpc\config.json   (macOS/Linux: see src/paths.ts)
{
  "clientId": "123456789012345678",
  "pollMs": 15000,
  "useUploadedArt": true
}
```

`pollMs` is clamped to at least 5 seconds. The default 15 s stays inside Discord's rate limit of
roughly 5 updates per 20 seconds.

## Run the headless daemon

For a scripted setup, a checkout, or macOS and Linux:

```sh
npm install
npm start          # starts the daemon, logging to daemon.log
npm test           # node --test, no test framework
npm run typecheck
```

### Building the C# app

```sh
node config/scripts/build-ico.mjs   # regenerates build/app.ico from orca-rpc.png
dotnet publish csharp/OrcaPresence -c Release -o dist-csharp
dotnet test csharp/OrcaPresence.Tests
```

### Headless CLI

```sh
orca-discord-rpc start      # start the background daemon
orca-discord-rpc status     # is it running?
orca-discord-rpc stop       # stop it
```

Start on login (Windows; writes an `HKCU\...\Run` entry that launches a hidden shim):

```sh
orca-discord-rpc autostart enable
orca-discord-rpc autostart disable
```

> **Do not use this together with the tray app.** Two presences would fight over your profile and
> the activity would flicker between two states. This registry entry is only for the headless
> CLI path. Check for it with
> `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v OrcaDiscordRpc` and remove
> it with `orca-discord-rpc autostart disable` before running the tray app at login.

## How it works

```
orca worktree ps --json ──► parse ──► select the active worktree
                                            │
                      folder + open agents ──► dedup by payload
                                            │
                hand-rolled Discord IPC ──► the local named pipe
```

The C# app speaks Discord's local protocol directly, so it carries no Discord library; the
headless daemon uses `@xhayper/discord-rpc` for the same job.

- **Input** is `orca worktree ps --json`, read on a timer. The tool takes the worktree Orca marks
  `isActive`, its folder from `path`, and its agent rows.
- **Output** is a presence update, sent only when the composed payload changes, so polling never
  becomes a burst of writes.
- **A failed push is not remembered as sent.** Discord often starts after Orca, so the next tick
  retries. The same applies after a reconnect: Discord restarting drops the activity it showed,
  so the current state is sent again.
- **Presence shows only while Orca is running.** Each tick probes for the Orca process and clears
  the activity when the app is closed, so nothing stale is left on the profile.
- **Failures are quiet.** Discord not running, Orca mid-update, a rejected client id — the
  process stays up and retries. Diagnostics go to `tray.log` (C# app) or `daemon.log` (CLI), next
  to the config.

Nothing else is read: no session databases, no token counts, no usage statistics.

## Size

The C# app is small because it borrows the framework Windows already has instead of shipping a
browser:

| | C# app | Electron app (retired) |
| --- | --- | --- |
| Published size | **1.7 MB** (exe 578 KB) | 106 MB installer |
| Memory | **~40 MB** | 224 MB |
| Processes | 1 | 3 |

The memory figure is the smaller win. A native app would sit near 5 MB, but the CLR and WinForms
have their own floor, so ~40 MB is this approach's baseline rather than a tuning target.

## Development

Both implementations are covered by unit tests that need no live Discord client:

- **C# app** — 79 tests via `dotnet test`. The state rules, the activity builder and the
  controller are pure; the transport, the tray and the process probe take their effects through
  injected dependencies, so they are covered too. It also carries development probes
  (`--probe-orca`, `--probe-discord`, `--probe-parity`) that write to `probe.log`, because a
  windowed app has no console to read.
- **Headless daemon** — 125 tests via `npm test`. The display logic lives in pure modules
  (`presence.ts`, `orca-state.ts`, `presence-controller.ts`).

Every rule the README states — the `+N` line, the folder choice, `Working`/`Idle`, the dedup and
the retry after a failure — is a test in both, because each one was a real bug first.

## License

MIT — see [LICENSE](LICENSE).
