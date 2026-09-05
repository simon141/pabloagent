# Pablo Agent

Pablo Agent is an entirely vibe-coded Tauri client for using AI coding agents on a remote Linux host.
It connects over SSH and supports:

- [Codex CLI](https://github.com/openai/codex)
- [Claude Code](https://code.claude.com/docs)
- [opencode](https://opencode.ai)
- [pi](https://github.com/earendil-works/pi)

The remote CLIs keep the conversation history. Pablo reads their existing
session records, starts turns under tmux, and presents them in one chat UI. It
does not install a server daemon. All session state is kept on the SSH server
where the AI CLIs run, allowing multiple instances of Pablo Agent to work with
a single server at the same time.

It started as complete hands-off experiment built from Claude Code and Codex, then when Pablo Agent became capable enough, development moved completely into building Pablo with Pablo itself!

## Downloads

Latest build from `main`:

- [Android arm64 APK](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-android-arm64.apk)
- [Windows x86_64 portable executable](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-windows-portable.exe)
- [Windows x86_64 installer](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-windows-setup.exe)
- [macOS universal disk image](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-macos-universal.dmg)
- [Linux x86_64 binary](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64)
- [Linux x86_64 AppImage](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64.AppImage)
- [Linux x86_64 Debian package](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64.deb)
- [Linux x86_64 RPM package](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64.rpm)
- [Linux arm64 binary](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-aarch64)
- [Linux arm64 AppImage](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-aarch64.AppImage)
- [Linux arm64 Debian package](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-aarch64.deb)
- [Linux arm64 RPM package](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-aarch64.rpm)

The portable Windows executable keeps its `pabloagent.json` next to the
executable. The Windows installer keeps it in the user's app data directory.

The macOS build is not notarized. After the first launch is blocked, allow it
under System Settings > Privacy & Security > Open Anyway.

The Debian and RPM packages install as `pablo-agent` and need the
distribution's WebKitGTK 4.1, which Ubuntu 22.04, Debian 12, Fedora and
openSUSE provide:

```bash
sudo apt install ./pabloagent-linux-x86_64.deb
sudo dnf install ./pabloagent-linux-x86_64.rpm
```

Continuous builds keep the same version number, so reinstalling a newer
continuous package over an installed one needs `apt install --reinstall` or
`dnf reinstall`.

## Server requirements

Pablo needs a Linux host with:

- SSH password authentication enabled
- `tmux`
- at least one supported CLI installed, authenticated, and usable by the SSH
  user
- Node.js 22 or newer when using pi

On first launch, enter the host, port, username, password, CLI paths, and default
workspace. Pablo shows the server's SSH fingerprint before it sends the
password. Accepting the fingerprint pins that host key for later connections.

## How it works

```text
Pablo app
  -> one-shot SSH commands
  -> tmux starts the selected CLI
  -> the CLI writes its native session record
  -> Pablo polls new records and renders the transcript
```

Codex, Claude, and pi use append-only JSONL session files. opencode keeps
history in its SQLite database, so Pablo combines a database history query with
the JSON event stream from the current turn. Disconnecting the app does not stop
a turn. Reconnecting reads the missing records and continues from the last
cursor.

Sessions from all four CLIs appear in one picker. Each session keeps its own
model, workspace, turn status, and transcript reader. Several sessions can run
at once.

## Main features

- Start, resume, follow, and stop remote turns.
- Render chat, markdown, tool calls, diffs, reasoning, metadata, and inline
  images from native session records.
- Open remote file paths through an `ssh://` handler, or download files to the
  device.
- Filter noisy card types without changing the server-side transcript.
- Save reusable draft prompts as Markdown files on the remote host, and load
  plain `.txt` prompts without modifying them.
- Copy, resend, or send a prompt to another chat.
- Label any session for this app, and rename a pi session in pi's own record.
- Delete sessions, and rewind file-based ones, when no turn is writing them.
  Rewind changes the conversation record only, not files changed by the agent.
- Show context usage and estimated cost when the session contains enough data.
- Notify on Android when a followed turn finishes in the background. Android
  Doze and vendor battery controls can delay or prevent that notification; the
  completed turn remains on the server.

opencode sessions are deleted with `opencode session delete`, which removes the
session and its child sessions from opencode's database. They cannot be rewound
because Pablo does not write to that database itself. Labels and favorites are
Pablo-side and stored in sidecar files on the host, so every Pablo instance sees
the same ones. pi is the only CLI with a session name of its own: renaming a pi
session runs `pi --name`, so the name is in pi's session record and pi shows it
too.

## Security model

Pablo supports SSH password authentication only. It stores connection settings,
the password, and accepted host keys in the app's private data directory. The
password has no encryption beyond the operating system's app sandbox.

A turn runs as the SSH user and uses that user's CLI configuration and provider
credentials. Turns are non-interactive, so approval behavior comes from the
selected CLI:

- Codex uses the remote `config.toml` for approval and sandbox policy. Pablo
  adds the selected workspace to Codex's trusted projects before a turn.
- Claude uses its remote settings unless a permission mode is selected in the
  new-chat dialog.
- opencode uses its remote configuration unless auto-approve is selected.
- pi has no interactive approval prompt. Pablo passes `-a` so the workspace's
  pi configuration is loaded for that turn.

Choose workspaces and permission modes as carefully as you would when running
the same CLI directly on the server.

## Development

The frontend requires Node.js 20 or newer. Rust uses the stable toolchain from
`rust-toolchain.toml`.

```bash
npm ci
npm run build
npm run tauri -- dev
```

Run the full checks with:

```bash
npm run lint
npm run typecheck
npm run check:rollout
npm run check:drafts

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

### Android release build

Install JDK 17, Android SDK 36, an Android NDK supported by Tauri, and the Rust
`aarch64-linux-android` target. Create
`src-tauri/gen/android/keystore.properties`:

```properties
storeFile=/absolute/path/to/release.jks
keyAlias=release
storePassword=
keyPassword=
```

Then build and verify the signed arm64 APK:

```bash
npm run android:build
scripts/verify-apk.sh src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

The exact APK filename can vary with the Tauri Android tooling. If the path
above does not exist, use the release APK under
`src-tauri/gen/android/app/build/outputs/apk/`.

### Linux packages and macOS build

On Linux, one build produces the AppImage and the Debian and RPM packages:

```bash
npm run tauri build -- --bundles appimage,deb,rpm
scripts/verify-linux-packages.sh src-tauri/target/release/bundle/deb/*.deb \
  src-tauri/target/release/bundle/rpm/*.rpm
```

On macOS, with both Apple targets installed via `rustup target add
aarch64-apple-darwin x86_64-apple-darwin`:

```bash
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

### GitHub builds

Each push to `main` publishes Android, Linux (x86_64 and arm64), macOS, and
Windows release builds to the
[continuous prerelease](https://github.com/simon141/pabloagent/releases/tag/continuous).
Pull requests receive a comment with temporary artifact links.

To publish a versioned release, set the same version in `package.json` and
`src-tauri/tauri.conf.json`, commit it, then push a matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

## Project structure

- `src/` contains application state, session readers, and transcript rendering.
- `src-tauri/src/` contains the Tauri commands, SSH transport, remote shell, and
  Android background watcher.
- `src-tauri/tests/` contains remote integration tests and scrubbed native
  session fixtures.
- `scripts/` contains fixture checks and APK verification.
- `docs/doze-testing.md` documents Android background-notification testing.
