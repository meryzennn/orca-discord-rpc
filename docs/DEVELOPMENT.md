# Development and testing

## Build the Orca plugin

Use Node.js 24 or newer:

```sh
npm ci
npm test
npm run typecheck
npm run build:plugin
```

The build writes `plugin/runtime.mjs`. Commit it whenever plugin source changes. The runtime uses project source and Node built-ins only; the build rejects npm runtime imports. Orca installs committed files from Git, so plugin users do not run npm or build the worker themselves.

The tests include an isolated bundle import that refuses unbundled dependencies. They use fake transports and hosts for lifecycle tests, without changing live Orca or Discord state.

## Text format and agent registry

Everything Discord shows is composed in `src/presence-format.ts` from the words in `config/presence-format.json`. Agent names, artwork, and model resolver ids are in `config/agents.json`, resolved by `src/agent-registry.ts` after the user's `agents` map in `config.json`. Both JSON files are bundled into `plugin/runtime.mjs` at build time; nothing is read from disk at runtime for the built-in entries. The plugin and the headless daemon share all of this, so a text or registry change applies to both. `src/format-literals.test.ts` fails if such words appear as literals elsewhere in source.

Model lookup is one small module per agent in `src/model-resolvers/`, selected by the registry's `modelResolver` id. To support a new session layout, add a resolver module, register it in `src/model-resolvers/index.ts`, and reference it from `config/agents.json`.

## Plugin page images

Orca has no upload step for plugin images. The files live in the repository and the manifest points at them by relative path, so they are read from the commit a user installs. Put them in `docs/images/`; the README links the same files.

- `cover` in `orca-plugin.json`: the wide image at the very top of the plugin page. One object with `path` and `alt` (at most 160 characters). PNG, JPEG or WEBP, static, at least 800x500, at most **1024 KB**, 16:10 recommended (1600x1000). Without it Orca shows a grey placeholder there. Do not repeat it in `screenshots`.
- `screenshots` in `orca-plugin.json`: the strip below the cover. At most 6, shown in the order listed. Each needs a `path` and an `alt` (at most 160 characters); `caption` (at most 120) and `theme` (`light` or `dark`) are optional. PNG, JPEG or WEBP, static, between 1280x800 and 2560x1600 (16:10 recommended), at most 1536 KB each and 8 MB together.
- `icon`: a separate field. Square PNG or WEBP, at least 128x128, at most 256 KB. A JPEG or a wide image cannot be the icon.

An image outside these limits makes the manifest invalid and the plugin cannot be installed, so `src/manifest-assets.test.ts` checks them. Only a commit that contains the images shows them: a tag created earlier keeps the manifest it was created with.

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
4. Toggle the adjacent Incognito control in both directions. Check `📁 Private Project`, the hidden repository button, and the agent/model icon in both modes.
5. Change Incognito while paused. Confirm it stays paused and applies the new privacy choice on resume. Change it in Settings and check that the status-bar label stays synchronized.
6. Switch workspaces and agents. Include an idle agent, multiple open panes, and Oh My Pi. Change OMP's model before another reply and check the tooltip on the next poll.
7. Close and reopen Discord. Check automatic recovery on a later poll. Close and reopen Orca, then check automatic plugin startup.
8. Disable or uninstall the plugin. Check that its activity, worker, and CLI child exit. Re-enable it and check startup again.
9. On macOS, check main and Helper app paths. On Linux, check AppImage paths and each Discord packaging variant you actually use, including Snap or Flatpak where applicable.
10. Check public image rendering separately from payload acceptance, including the Orca fallback icon for an agent with no entry. If needed, upload artwork with the matching keys and enable `useUploadedArt` for that Discord application.
11. Check the card in Discord desktop and mobile: the `📁` line, status on line 1 in a narrow popout, truncation of a long or non-ASCII folder name, and the icon tooltip (hover is not available on mobile, so nothing essential may depend on it).
12. Run an agent id the plugin has no entry for. Check the generated name, the fallback icon, a single log line, and that an `agents` entry in `config.json` takes effect after a plugin reload.

Empty-presence acceptance:

1. Use only one provider. Open Orca with no active workspace, enable RPC, and inspect a Discord profile. Expect Playing Orca with an elapsed timer and no project or agent details.
2. Open a workspace without agents, including one containing only a plain terminal. Expect the same bare activity in normal and Incognito modes.
3. Start an agent, let it become idle, then close its pane. Expect the existing rich card, then 0 agents working, then bare Playing Orca. Old project, model, branch, custom artwork and repository data must disappear.
4. Note the elapsed time, leave the workspace, then return to an agent. Expect the timer to continue from the same start in every view, including the empty interval.
5. Restart Discord while Orca remains empty. Expect automatic republishing after reconnect.
6. Pause RPC while empty. Expect no activity until resumed. Disable the plugin and close Orca in separate checks; each must remove the activity.
7. Disable the plugin before checking the headless daemon. Start the daemon with Orca open and empty; expect the same bare activity. Close Orca; expect clear. Stop the daemon before re-enabling the plugin.

Global activity-count acceptance:

1. Open two workspaces. In A, run one agent and keep an idle agent open; in B, run two agents. Select A. Expect the featured A agent, A folder/model/repository, 3 agents working and 2 active workspaces.
2. Select B without changing workers. Expect B identity, model artwork/tooltip and repository, with the same totals and timer. No +N suffix appears.
3. Leave A selected and finish one B agent. Expect the worker total to change on the event refresh or next poll. Finish B's remaining worker; the workspace count drops too.
4. Make A's agents idle while B works. Keep A's identity and show B's contribution only in the totals. Check blocked and waiting agents are excluded.
5. Finish all workers. With a selected agent pane still open, expect 0 agents working and 0 active workspaces. Close the selected workspace's last agent; expect the existing bare Playing Orca with its continuing timer.
6. Toggle Incognito, pause/resume, and restart Discord. Check counts, selected identity and clock behavior; private folder/branch/repository data must stay hidden.
7. Repeat the count and selection checks with the headless daemon as the only provider. Its text matches the plugin; its agent/model remains on the large icon and branch on the small icon.
8. Check long project/custom agent names and Unicode in desktop/mobile Discord. Totals must survive text clipping, with no split emoji or rejected activity.

Record client/platform versions and observed outcomes. A mock IPC acknowledgement is not a substitute for the visible Discord check.

When waiting persists, record the safe RPC operation/code from the plugin logs. Do not publish raw agent transcripts, credentials, or private repository paths in reports.

## Headless daemon

The `presence.update` command is exposed through the native Run button on the plugin details page. It invokes the host's bundled CLI with `plugin update meryzennn.discord-presence --json`. It requires Orca 1.4.253+ but leaves presence usable on the older supported host. The command handler returns an immediate acknowledgement so a slow update does not exceed Orca's worker-command deadline; results are written to the plugin's Logs. It never creates or updates a status bar item. Shutdown does not wait for the update request, because the update can replace that worker. No `--approve` flag is ever passed.

For update-button acceptance, open Settings > Plugins > Discord Rich Presence and run Discord RPC: Update installed plugin. Use a Git installation on Orca 1.4.253+: check up-to-date, available update, pinned commit, network failure and access-review outcomes in Logs. Confirm an up-to-date or rejected request preserves RPC state and timer, repeated clicks do not duplicate requests, and a completed installation starts the new worker. Confirm the bottom status bar contains only RPC and Incognito before, during and after an update request. On Orca 1.4.250, confirm Logs explain the application upgrade requirement without disrupting RPC. Development folders are not self-updated by this command.

Run the standalone headless Node daemon:

```sh
npm ci
npm start
npm run status
node src/cli.ts update
npm stop
```

Standalone mode honours `ORCA_DISCORD_CLIENT_ID`, `ORCA_DISCORD_UPLOADED_ART`, and agent session-directory overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`. Orca's plugin worker scrubs these shell overrides; see the [README settings section](../README.md#settings).

The daemon builds its text with the same format definition and agent registry as the plugin, and reads the `agents` map from the same `config.json`. Unknown agent ids are logged once to `daemon.log`.

The headless update command refuses tracked changes and nested source folders, pulls only a fast-forward from the configured upstream, and restarts the daemon only after a changed checkout. The integration test uses a separate repository and a test-only PID path to verify restart, no-op and refusal behavior without touching a user's daemon.

## Releases

1. Land the change with `npm ci`, `npm test`, `npm run typecheck`, and `npm run build:plugin` passing, and commit the rebuilt `plugin/runtime.mjs`.
2. Set the same semver `version` in `package.json`, `package-lock.json`, and `orca-plugin.json`.
3. Tag the commit `vX.Y.Z` and push the tag. Direct Git installs resolve `#vX.Y.Z`, so the tag must contain `orca-plugin.json` and the built `plugin/runtime.mjs`.
4. Publish a GitHub release. The notes must say how to update: run the update command on the plugin details page with Orca 1.4.253+, or use Settings > Plugins > Add Plugin with `https://github.com/meryzennn/orca-discord-rpc.git#vX.Y.Z`. The notes for the latest tag are in [release notes](release-notes/v0.3.1.md).
5. Land breaking changes on a branch and merge them when you release: `#main` installs track every commit on it.

Legacy Windows exe: its updater reads the repository's latest release, offers any newer tag, and downloads the first `.zip` asset (or `OrcaPresence-windows.zip` for that tag). A release published as latest without that asset makes the old exe's download fail silently. The exe's source is no longer on `main`; it is in the history before commit `2664b2e`. Before publishing a plugin release as latest, either attach a migration build of `OrcaPresence-windows.zip` to it (zip root holds `OrcaPresence.exe` with no wrapper folder) or leave "Set as the latest release" unchecked.
