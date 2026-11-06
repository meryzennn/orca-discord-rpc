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

When waiting persists, record the safe RPC operation/code from the plugin logs. Do not publish raw agent transcripts, credentials, or private repository paths in reports.

## Headless daemon

Run the standalone headless Node daemon:

```sh
npm ci
npm start
npm run status
npm stop
```

Standalone mode honours `ORCA_DISCORD_CLIENT_ID`, `ORCA_DISCORD_UPLOADED_ART`, and agent session-directory overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`. Orca's plugin worker scrubs these shell overrides; see the [README settings section](../README.md#settings).

The daemon builds its text with the same format definition and agent registry as the plugin, and reads the `agents` map from the same `config.json`. Unknown agent ids are logged once to `daemon.log`.

## Releases

1. Land the change with `npm ci`, `npm test`, `npm run typecheck`, and `npm run build:plugin` passing, and commit the rebuilt `plugin/runtime.mjs`.
2. Set the same semver `version` in `package.json`, `package-lock.json`, and `orca-plugin.json`.
3. Tag the commit `vX.Y.Z` and push the tag. Direct Git installs resolve `#vX.Y.Z`, so the tag must contain `orca-plugin.json` and the built `plugin/runtime.mjs`.
4. Publish a GitHub release. The notes must say how to update: Settings > Plugins > Add Plugin with `https://github.com/meryzennn/orca-discord-rpc.git#vX.Y.Z`. A draft for the next release is in [release notes](release-notes/v0.2.0.md).
5. Land breaking changes on a branch and merge them when you release: `#main` installs track every commit on it.

Legacy Windows exe: its updater reads the repository's latest release, offers any newer tag, and downloads the first `.zip` asset (or `OrcaPresence-windows.zip` for that tag). A release published as latest without that asset makes the old exe's download fail silently. The exe's source is no longer on `main`; it is in the history before commit `2664b2e`. Before publishing a plugin release as latest, either attach a migration build of `OrcaPresence-windows.zip` to it (zip root holds `OrcaPresence.exe` with no wrapper folder) or leave "Set as the latest release" unchecked.
