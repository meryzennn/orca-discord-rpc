# orca-discord-rpc

Discord Rich Presence for [Orca](https://github.com/stablyai/orca) — shows the workspace you
are active in and the agent running there, on your Discord profile.

```
Claude +1
orca-discord-rpc · Working
0:42 elapsed
```

Two ways to run it, sharing the same presence logic:

- **Tray app (Windows)** — install once, lives in the notification area, no Node needed.
- **Headless daemon** — `node src/cli.ts start`, for a checkout or a non-Windows host.

## Requirements

- **Orca installed**, with the `orca` CLI resolvable on `PATH`
- **Discord desktop client running and logged in** — browser Discord does not expose the local
  IPC socket this depends on
- The tray installer bundles everything else. Only the headless path needs **Node.js 24+**

## Install (Windows)

Download `Orca Discord Presence Setup <version>.exe` from
[`dist-installer/`](dist-installer) and run it. It installs per user — no admin prompt — adds a
Start Menu shortcut, and puts an icon in the notification area.

> Unsigned builds trip Windows SmartScreen on first run: **More info** → **Run anyway**.
> Signing needs a purchased certificate; this build is not signed.

## What Discord shows

| Field | Content |
| --- | --- |
| Line 1 | The featured agent, plus `+N` when other agents are open — `Claude +1` |
| Line 2 | The workspace folder, then `Working` or `Idle` |
| Timer | Elapsed since you switched workspace |
| Large image | The agent's artwork, when it is registered (see below) |
| Small image | A branch icon; its tooltip is the branch name |

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
missing), the application id in use, and **Quit**.

The tray app never opens a window and never takes focus, and only one copy can run at a time.

## Artwork

Agent art must be **registered on the Discord application** to be rendered. An external image
URL is accepted on the wire but Discord never displays it, and a loopback URL (`127.0.0.1`) is
never even fetched — both were verified against a live client.

To use your own artwork:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), pick the
   application whose id you use, and go to **Rich Presence → Art Assets**.
2. Upload a PNG for each agent with a key matching its type: `claude`, `codex`, `opencode`,
   `commandcode`, `deepsek-harnnes`, `grock`, `hermes`, `agy` — and `git-branch` for the branch
   icon.
3. Enable it:

   ```sh
   setx ORCA_DISCORD_UPLOADED_ART "1"
   ```

Without registered art the image slot stays empty and only the text shows. That is a Discord
rule, not a setting this tool can work around.

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

## Run from source

For development, or on macOS and Linux where no installer is published:

```sh
npm install
node node_modules/electron/install.js   # see the note below
npm start          # headless daemon, logs to daemon.log
npm run dev:app    # Electron tray app, built from source
npm test           # 140+ tests, node --test with no test framework
npm run typecheck
```

> **If the tray app fails to launch**, Electron's binary may not have downloaded: `npm install`
> can report success while leaving `node_modules/electron/dist/` missing. Run
> `node node_modules/electron/install.js` to fetch it, then retry.

### Building the installer

```sh
npm run icons      # regenerate assets/tray.png and build/icon.png from orca-rpc.png
npm run build:win  # writes dist-installer/Orca Discord Presence Setup <version>.exe
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
                              @xhayper/discord-rpc ──► Discord IPC socket
```

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
  process stays up and retries. Diagnostics go to `daemon.log` next to the config.

Nothing else is read: no session databases, no token counts, no usage statistics.

## Size

The Windows installer is about **106 MB**, and almost none of it is this tool: Electron's own
runtime accounts for 235 MB of the 373 MB unpacked, with `locales/` adding 49 MB. The application
code is roughly 5 MB inside that.

That is the cost of shipping an installer that needs no runtime on the user's machine. A
headless-only install (Node 24 already present) avoids it entirely.

## Development

The display logic (`presence.ts`, `orca-state.ts`, `presence-controller.ts`) is pure, and every
rule above — the `+N` line, the folder choice, `Working`/`Idle`, the dedup and retry behaviour —
is covered by unit tests that need no live Discord client. The transport and tray layers take
their side effects through injected dependencies, so they are covered too.

## License

MIT — see [LICENSE](LICENSE).
