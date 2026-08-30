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
- [Windows x86_64 executable](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-windows-x86_64.exe)
- [Linux x86_64 binary](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64)
- [Linux x86_64 AppImage](https://github.com/simon141/pabloagent/releases/download/continuous/pabloagent-linux-x86_64.AppImage)

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
- Rewind and delete file-based sessions when no turn is writing them. Rewind
  changes the conversation record only, not files changed by the agent.
- Show context usage and estimated cost when the session contains enough data.
- Notify on Android when a followed turn finishes in the background. Android
  Doze and vendor battery controls can delay or prevent that notification; the
  completed turn remains on the server.

opencode sessions cannot be deleted or rewound because Pablo treats its database
as read-only. Session names are Pablo-side labels stored in a sidecar file;
native CLI session names are neither read nor written.

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

### GitHub builds

Each push to `main` publishes Android, Linux, and Windows release builds to the
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
