# Development and testing

## Build the Orca plugin

Use Node.js 24 or newer:

```sh
npm ci
npm test
npm run typecheck
npm run build:plugin
```

The build writes `plugin/runtime.mjs` and `plugin/THIRD-PARTY-NOTICES.txt`. Commit these files whenever plugin source or dependencies change. Orca installs committed files from Git; plugin users do not run npm or build the worker themselves.

The tests include an isolated bundle import that refuses unbundled dependencies. They use fake transports and hosts for lifecycle tests, without changing live Orca or Discord state.

## Validate a clean snapshot

Orca's folder inspection includes ignored files. A checkout containing `node_modules` or local outputs can exceed its 50 MiB folder limit. Use a separate snapshot of committed files:

```sh
git -c core.autocrlf=false archive --format=zip --output=../orca-plugin-check.zip HEAD
```

Extract the ZIP into a new folder. This preserves the committed bytes that Orca's Git installer reads. Run these commands on the machine hosting Orca, using the extracted folder's path:

```sh
orca plugin validate "../orca-plugin-check" --json
orca plugin inspect "../orca-plugin-check" --json
```

On Linux outside an Orca-managed terminal, use `orca-ide` instead of bare `orca`, which may be the GNOME screen reader.

## Load a development snapshot

You can choose the clean folder through Settings > Plugins > Add Plugin. The CLI route is:

```sh
orca plugin dev load "../orca-plugin-check" --json
```

Review Orca's access request. If it returns `approval_required`, use the exact `--approve <fingerprint>` command it supplies for this snapshot. A fingerprint from another build is not valid.

Orca reloads approved development folders when their files change. Keep a user's test snapshot separate from a working checkout to avoid interrupting their test. To remove your development source:

```sh
orca plugin dev unload "../orca-plugin-check" --json
```

## Manual acceptance

Record results separately for Windows, macOS, and Linux. Automated checks do not prove host activation, rendered artwork, or cleanup after a real app exits.

1. Stop older presence providers. Load and approve the snapshot, then enable the plugin.
2. Confirm presence starts with an active workspace without opening a panel or making agent tool calls.
3. Click RPC to pause and resume. Check its label, tooltip, and the returned Discord activity.
4. Toggle the adjacent Incognito control in both directions. Check `Private Project`, the hidden repository button, and the agent/model icon in both modes.
5. Change Incognito while paused. Confirm it stays paused and applies the new privacy choice on resume. Change it in Settings and check that the status-bar label stays synchronized.
6. Switch workspaces and agents. Include an idle agent, multiple open panes, and Oh My Pi. Change OMP's model before another reply and check the tooltip on the next poll.
7. Close and reopen Discord. Check automatic recovery on a later poll. Close and reopen Orca, then check automatic plugin startup.
8. Disable or uninstall the plugin. Check that its activity, worker, and CLI child exit. Re-enable it and check startup again.
9. On macOS, check main and Helper app paths. On Linux, check AppImage paths and each Discord packaging variant you actually use, including Snap or Flatpak where applicable.
10. Check public image rendering separately from payload acceptance. If needed, upload artwork with the matching keys and enable `useUploadedArt` for that Discord application.

When waiting persists, record the safe RPC operation/code from the plugin logs. Do not publish raw agent transcripts, credentials, or private repository paths in reports.

## Standalone builds

Build and test the Windows tray app on Windows:

```sh
npm run build:csharp
npm run pack:csharp
dotnet test csharp/OrcaPresence.Tests
```

For the headless Node daemon:

```sh
npm ci
npm start
npm run status
npm stop
```

Standalone mode honours `ORCA_DISCORD_CLIENT_ID`, `ORCA_DISCORD_UPLOADED_ART`, and agent session-directory overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`. Orca's plugin worker scrubs these shell overrides; see the [README settings section](../README.md#settings).
