# Pablo repository guide

Pablo is a Tauri v2 client for running Codex, Claude Code, opencode, and pi on a
remote Linux host over SSH. Rust owns transport, persistence, downloads, and
remote commands. TypeScript reads each CLI's session format and renders one
transcript model. There is no server process: conversation history stays in the
native CLI records.

Comment only what the code cannot state, and delete stale comments as you pass
them. Keep this file short: put behavior in tests and commands in
configuration.

## Invariants

- Send prompts through stdin. Codex also takes `-` as its prompt argument; the
  other harnesses must not be given it.
- Keep transcript IDs stable as files grow. Codex keys on source position
  because later entries reclassify a prompt; opencode keys on part IDs to merge
  history with live events.
- Show unknown session entries as generic cards. Drop only proven duplicates.
- Keep local prompt echoes until a new user-message ID arrives. Repeated prompt
  text is not an identity.
- Guard delete and rewind in the same remote command as the mutation.
- Labels are Pablo sidecar records. pi is the only CLI with a name of its own:
  `pi --name` writes it and the picker reads back a bounded tail, so keep the
  sidecar copy the rename leaves for names that scroll out of it. Never spawn
  `codex app-server`: it is too expensive for the session-list poll.
- Treat opencode's database as read-only. opencode sessions cannot be deleted or
  rewound.
- Rewind only the session record. Keep one `.rewind-bak` tail and leave
  workspace files alone.
- Store shared session metadata in one sidecar file per key. Native session
  records contain no Pablo state.
- Favorites are host records, one file per favorite under
  `pabloagent/favorites`, read by the full session listing only. Never keep
  them on the device or write them as one list.
- Keep filter IDs stable because device settings persist them. Errors and
  unknown entry types are never filterable.
- Verify host keys before sending a password. Keep credentials out of file
  links, and preserve remote path validation and shell quoting.
- Codex workspace trust is the only persistent remote config change. Preserve
  unsupported `config.toml` shapes and all unrelated bytes. pi receives `-a`
  per turn, and a rename runs `-p` with stdin closed, or pi takes whatever
  stdin offers as a prompt and runs a turn.

When CLI behavior is uncertain, run the CLI and add a scrubbed fixture or
regression test.

## Verification

Run `npm run lint` before every commit, then the checks for what changed.
`npm test` runs the session parser, draft format, and Rust checks together:

- frontend: `npm run typecheck` and `npm run build`
- Rust, from `src-tauri`: `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test --all-targets`
- session parsers: `npm run check:rollout`
- draft prompt format: `npm run check:drafts`
- SSH, remote shell, session mutation, download, or trust: add a Rust
  integration test
- layout, focus, sizing, visibility, or touch: test the built frontend in
  Chromium at a phone viewport with overflowing transcript content, because
  jsdom tests neither layout nor focus
- Android background watching, foreground services, Doze, or finish
  notifications: follow `docs/doze-testing.md`

## Release builds

Android releases are arm64 only. If the Android scaffolding is regenerated,
confirm that `RustPlugin.kt` still limits builds to arm64.

Local APK builds get the application id `app.pabloagent.local` by default so
they install beside the released app. Only the GitHub release workflow builds
the bare `app.pabloagent`, by setting `ORG_GRADLE_PROJECT_githubApk=true`.
Verify every APK with `scripts/verify-apk.sh`, which checks the id.

Linux ships a loose binary, an AppImage, a `.deb` and an `.rpm` from one
`tauri build --bundles appimage,deb,rpm`, for x86_64 and arm64. Only the
AppImage bundles `WebKitGPUProcess`; the packages depend on the distribution's
WebKitGTK 4.1. The arm64 job passes `--config src-tauri/appimage-aarch64.conf.json`,
whose `null` entry removes the x86_64 `WebKitGPUProcess` path before adding the
aarch64 one. Verify every package pair with `scripts/verify-linux-packages.sh`,
which checks the `pablo-agent` package name, the version, the WebKitGTK
dependency and the installed files.

macOS ships one universal `.dmg` from
`tauri build --target universal-apple-darwin --bundles dmg`. Without the
`APPLE_*` secrets the workflow signs ad hoc (`APPLE_SIGNING_IDENTITY=-`), so the
app only runs after Open Anyway in Privacy & Security. Adding the secrets makes
the same job sign and notarize.

Build the portable Windows executable and the NSIS installer with `makensis`
on `PATH`:

```bash
npm run tauri -- build --runner cargo-xwin \
  --target x86_64-pc-windows-msvc --bundles nsis
```

The executable is
`src-tauri/target/x86_64-pc-windows-msvc/release/pabloagent.exe` and the
installer is the `*-setup.exe` under
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. Pass
`--no-bundle` instead of `--bundles nsis` to skip the installer.

The bundler stamps the executable inside the installer with its bundle type
and leaves the loose executable unstamped. The store reads that stamp: the
installed build keeps `pabloagent.json` in app data and the portable build keeps
it beside the executable. Never ship the executable extracted from the installer
as the portable build.
