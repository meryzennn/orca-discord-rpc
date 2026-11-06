# Orca Discord Presence

Show your active [Orca](https://github.com/stablyai/orca) workspace and coding agent on your Discord profile.

The Orca plugin runs on Windows, macOS, and Linux. It starts with Orca and uses Orca's bundled runtime, so plugin users do not need a separate tray app, Node.js installation, or terminal command.

## Install

You need **Orca 1.4.250 or newer** and the Discord desktop app, running and logged in. Discord in a browser cannot connect to this plugin.

1. Open Orca's **Settings > Plugins** and turn on plugins if needed.
2. Click **Add Plugin** and choose a Git source.
3. Enter `https://github.com/meryzennn/orca-discord-rpc.git#main`.
4. Check that Orca resolves the **main** branch before installing.
5. Review Orca's worker access prompt, approve the plugin, and enable it.

The worker requests `workspace:read`, `agent:read`, and `settings:own`. It reads workspace information and local agent session files, then sends presence updates to Discord.

Keep `#main` in the URL. Without a reference, Orca chooses the latest version tag, currently `v0.1.9`, which does not contain the plugin manifest. The plugin is available from `main`; the [v0.1.9 release ZIP](https://github.com/meryzennn/orca-discord-rpc/releases/tag/v0.1.9) contains the standalone Windows app.

If you are switching from an older provider, stop it first. Disable the old development plugin, quit the Windows tray app, or stop the headless daemon. For the tray app, also untick **Start with Windows**. Keep one presence provider running at a time.

## Use

Open a workspace in Orca and start your agent. Presence updates automatically as you switch workspaces, agents, or models. The default polling interval is 15 seconds.

Use the controls in Orca's status bar:

| Control | What it does |
| --- | --- |
| `RPC` | Presence is connected. Click to pause. |
| `RPC paused` | Click to resume. |
| `RPC waiting` | Discord is unavailable or the last update failed. Hover for the reason. |
| `Incognito On` / `Incognito Off` | Click to change privacy without opening Settings. |

Incognito replaces your folder with `Private Project` and hides the repository button. Your agent and model stay visible. Changing Incognito while paused keeps presence paused; the new privacy choice takes effect when you resume.

Privacy changes update presence without reloading the plugin. Closing Orca or disabling the plugin stops its worker and presence.

## What Discord shows

With one active agent, the two lines look like this:

```text
Agent: Oh My Pi · Working
Folder: your-project
```

An idle agent shows `Idle`. A suffix such as `+1` counts the other open agent panes.

| Field | Normal mode | Incognito |
| --- | --- | --- |
| Folder | Active workspace name | `Private Project` |
| Small icon | Featured agent | Same |
| Icon tooltip | Current model, when detected | Same |
| Repository button | Workspace's Git `origin`, when valid | Hidden |
| Timer | Current session duration | Same |

Model lookup supports **Codex, Claude Code, and Oh My Pi**. The plugin reads their saved session metadata for the workspace. OMP records model changes separately from replies; the plugin picks them up on the next poll. Auxiliary usage, such as a judge model, does not replace the conversation model. If the plugin cannot read the model, it uses the agent name in the tooltip.

Agent icons use public image URLs by default. Uploaded Discord artwork is optional; see [Settings](#settings).

## Settings

Orca saves pause/resume and Incognito in the plugin's settings. The status-bar controls and Settings stay synchronized. On first startup, the plugin copies the old `config.json` Incognito value only when Orca has no saved plugin value.

For a custom Discord application, polling interval, or uploaded artwork, edit `config.json`:

| OS | File |
| --- | --- |
| Windows | `%LOCALAPPDATA%\orca-discord-rpc\config.json` |
| macOS | `~/Library/Application Support/orca-discord-rpc/config.json` |
| Linux | `~/.config/orca-discord-rpc/config.json` |

For example:

```json
{
  "pollMs": 15000,
  "useUploadedArt": false
}
```

- Add `clientId` as a string to use your own Discord application. Otherwise, the built-in application is used.
- `pollMs` must be at least 5000. Invalid values fall back to 15000.
- Set `useUploadedArt` to `true` only after uploading the matching `orca` and agent assets to your Discord application. The [asset keys](src/agent-art.ts) list the names to use.

Reload the plugin after changing this file. Incognito changes through the status bar do not need a reload.

Orca scrubs shell environment overrides from workers. Set plugin configuration in the file rather than through `ORCA_DISCORD_*`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `PI_CODING_AGENT_DIR`.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No readable `orca-plugin.json` | For Git installs, use the URL ending in `.git#main`. For local installs, select the folder containing `orca-plugin.json`, not its `plugin` subfolder. |
| `RPC waiting` | Open Discord desktop and wait for the next poll. If it persists, open the plugin's logs in Settings and check the RPC operation and error code. |
| `RPC paused` | Click RPC to resume. Switching Incognito does not enable paused presence. |
| No activity | Open an active Orca workspace and check Discord's activity visibility settings. |
| Agent name instead of a model | Check that the agent has a saved session for this workspace. Other agent types use the name fallback. |
| Missing icon | Discord may not render the public image. Use uploaded artwork with the matching asset keys. |
| Missing repository button | The workspace needs a valid web-compatible Git `origin`. Incognito hides the button. |
| Presence changes unexpectedly | Stop any older tray app, headless daemon, or duplicate development plugin. |

OMP lookup uses the standard `~/.omp/agent/sessions` layout. Custom profiles, custom `--session-dir` paths, and XDG-relocated OMP state are not automatically discovered by the plugin.

## RAM and CPU

One 30-second sample of the running plugin worker on Windows, measured on 2026-11-06 with a Ryzen 5 5500 and 12 logical CPUs:

| Metric | Measured value |
| --- | --- |
| RAM working set | 135.6 to 137.0 MiB |
| Private bytes | 41.3 to 43.0 MiB |
| Average CPU | 0.056% of total CPU capacity |
| Highest one-second CPU sample | 0.369% |

These measurements cover the permanent plugin worker. They exclude Orca, Discord, and the short-lived CLI processes used for polling. Usage varies with workload and machine.

Working set includes shared runtime pages. Private bytes measure memory committed to the process. The older Windows tray app periodically trims its working set, so its low Task Manager reading is a different comparison. This plugin still runs in Orca's Node worker.

## Standalone versions

### Windows tray app

1. Download `OrcaPresence-windows.zip` from the [v0.1.9 release](https://github.com/meryzennn/orca-discord-rpc/releases/tag/v0.1.9).
2. Extract it and open `OrcaPresence.exe`.
3. Right-click the tray icon to pause presence, change Incognito, or enable **Start with Windows**.

Requires Windows 10 or 11 with .NET Framework 4.8. The tray app uses a branch icon in normal mode and an agent/model icon in Incognito. Its update menu checks for newer standalone releases.

To uninstall, untick **Start with Windows**, quit the app, and delete its folder. Configuration and logs remain in `%LOCALAPPDATA%\orca-discord-rpc`.

### Node headless daemon

For scripted use, install Node.js 24 or newer and make Orca's CLI available on `PATH`:

On Linux, run these commands from an Orca-managed terminal so `orca` resolves to Orca's CLI rather than the GNOME screen reader.

```sh
git clone https://github.com/meryzennn/orca-discord-rpc.git
cd orca-discord-rpc
npm ci
npm start
```

Run `npm run status` to check it and `npm stop` to stop it. Its layout uses the large agent/model icon and a small branch icon. It reads the same configuration file and honours supported environment overrides.

## Development

See [Development and testing](docs/DEVELOPMENT.md) for build commands, clean plugin snapshots, and the manual acceptance checklist.

Automated payload, lifecycle, typecheck, and bundle checks are separate from real Orca/Discord rendering. The repository includes a Windows, macOS, and Linux CI matrix; live behaviour on each OS needs its own validation.

## License

[MIT](LICENSE).
