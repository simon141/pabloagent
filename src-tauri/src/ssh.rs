use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::ssh_key::{self, HashAlg};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};

use crate::diag::Diagnostics;
use crate::remote::{self, HostCapabilities};
use crate::store::{KnownHost, SshSettings};

const SSH_STAGE_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

const COMMAND_STDOUT_BUDGET: usize = 8 * 1024 * 1024;

const COMMAND_STDERR_TAIL: usize = 64 * 1024;

fn keep_stderr_tail(stderr: &mut Vec<u8>, data: &[u8]) {
    stderr.extend_from_slice(data);
    if stderr.len() > COMMAND_STDERR_TAIL {
        let excess = stderr.len() - COMMAND_STDERR_TAIL;
        stderr.drain(..excess);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub openssh: String,
    pub mismatch: bool,
    pub previous_fingerprint: Option<String>,
}

#[derive(Clone, Default)]
struct HostKeyCapture {
    algorithm: Arc<Mutex<Option<String>>>,
    fingerprint: Arc<Mutex<Option<String>>>,
    openssh: Arc<Mutex<Option<String>>>,
    rejected: Arc<AtomicBool>,
}

pub struct ClientHandler {
    expected_fingerprint: Option<String>,
    capture: HostKeyCapture,
    diagnostics: Diagnostics,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = server_public_key.algorithm().to_string();
        let openssh = server_public_key
            .to_openssh()
            .unwrap_or_else(|e| format!("<unencodable public key: {e}>"));

        self.diagnostics.push(
            "ssh",
            format!("server offered host key {algorithm} {fingerprint}"),
        );

        if let Ok(mut slot) = self.capture.algorithm.lock() {
            *slot = Some(algorithm);
        }
        if let Ok(mut slot) = self.capture.fingerprint.lock() {
            *slot = Some(fingerprint.clone());
        }
        if let Ok(mut slot) = self.capture.openssh.lock() {
            *slot = Some(openssh);
        }

        // Never trust implicitly. A key is accepted only when it byte-for-byte
        // matches one the user previously pressed Accept on.
        let accepted = self.expected_fingerprint.as_deref() == Some(fingerprint.as_str());
        if !accepted {
            self.capture.rejected.store(true, Ordering::SeqCst);
            self.diagnostics.push(
                "ssh",
                match self.expected_fingerprint.as_deref() {
                    None => "no stored host key for this server; awaiting user acceptance".into(),
                    Some(prev) => format!(
                        "HOST KEY MISMATCH: stored {prev} but server presented {fingerprint}"
                    ),
                },
            );
        }
        Ok(accepted)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectOutcome {
    Connected { capabilities: HostCapabilities },
    HostKeyUnverified { prompt: HostKeyPrompt },
}

pub struct Connection {
    handle: Handle<ClientHandler>,
    settings: SshSettings,
    known: Option<KnownHost>,
    diagnostics: Diagnostics,
    capabilities: HostCapabilities,
}

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

pub trait ByteSink: Send {
    fn write(&mut self, chunk: &[u8]) -> Result<(), String>;
    fn reset(&mut self) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub struct StreamOutput {
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub bytes: u64,
}

impl Connection {
    pub fn settings(&self) -> &SshSettings {
        &self.settings
    }

    pub fn capabilities(&self) -> &HostCapabilities {
        &self.capabilities
    }

    pub fn is_live(&self) -> bool {
        !self.handle.is_closed()
    }

    pub async fn run(&mut self, label: &str, command: &str) -> Result<CommandOutput, String> {
        if !self.is_live() {
            self.diagnostics.push(
                "ssh",
                format!("the SSH session is gone; reconnecting before {label}"),
            );
            self.reconnect().await?;
        }

        let out = match run_command(&self.handle, command, &self.diagnostics).await {
            Ok(out) => out,
            Err(failure) if failure.unsent => {
                self.diagnostics.push(
                    "ssh",
                    format!(
                        "{label} never left the device ({}); reconnecting",
                        failure.why
                    ),
                );
                self.reconnect().await.map_err(|e| {
                    format!(
                        "{}\n\nReconnecting to run {label} then failed:\n{e}",
                        failure.message
                    )
                })?;
                run_command(&self.handle, command, &self.diagnostics)
                    .await
                    .map_err(|again| again.message)?
            }
            Err(failure) => return Err(failure.message),
        };

        self.diagnostics.push(
            "remote",
            format!(
                "{label}: exit {:?}, {} bytes out{}",
                out.exit_code,
                out.stdout.len(),
                if out.stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!(", stderr: {}", truncate(out.stderr.trim(), 300))
                }
            ),
        );
        Ok(out)
    }

    pub async fn run_streamed(
        &mut self,
        label: &str,
        command: &str,
        sink: &mut dyn ByteSink,
    ) -> Result<StreamOutput, String> {
        if !self.is_live() {
            self.diagnostics.push(
                "ssh",
                format!("the SSH session is gone; reconnecting before {label}"),
            );
            self.reconnect().await?;
        }

        let out = match stream_command(&self.handle, command, &self.diagnostics, sink).await {
            Ok(out) => out,
            Err(failure) if failure.unsent => {
                self.diagnostics.push(
                    "ssh",
                    format!(
                        "{label} never left the device ({}); reconnecting",
                        failure.why
                    ),
                );
                self.reconnect().await.map_err(|e| {
                    format!(
                        "{}\n\nReconnecting to run {label} then failed:\n{e}",
                        failure.message
                    )
                })?;
                sink.reset()?;
                stream_command(&self.handle, command, &self.diagnostics, sink)
                    .await
                    .map_err(|again| again.message)?
            }
            Err(failure) => return Err(failure.message),
        };

        self.diagnostics.push(
            "remote",
            format!(
                "{label}: exit {:?}, {} bytes streamed{}",
                out.exit_code,
                out.bytes,
                if out.stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!(", stderr: {}", truncate(out.stderr.trim(), 300))
                }
            ),
        );
        Ok(out)
    }

    async fn reconnect(&mut self) -> Result<(), String> {
        let opened = open_session(&self.settings, self.known.as_ref(), &self.diagnostics).await?;
        let mut handle = match opened {
            Ok(handle) => handle,
            Err(prompt) => return Err(host_key_changed_under_a_reconnect(&self.settings, &prompt)),
        };
        authenticate(&mut handle, &self.settings, &self.diagnostics).await?;
        self.diagnostics
            .push("ssh", "reconnected; refreshing host capabilities");
        let capabilities = probe_capabilities(&handle, &self.settings, &self.diagnostics).await?;
        self.diagnostics
            .push("ssh", "reconnected; the previous session is discarded");
        self.handle = handle;
        self.capabilities = capabilities;
        Ok(())
    }

    pub async fn run_ok(&mut self, label: &str, command: &str) -> Result<String, String> {
        let out = self.run(label, command).await?;
        match out.exit_code {
            Some(0) => Ok(out.stdout),
            Some(code) => Err(format!(
                "The remote command for {label} failed (exit {}).\n{}\n\nRecent activity:\n{}",
                code,
                out.stderr.trim(),
                self.diagnostics.tail(15)
            )),
            None => Err(format!(
                "The remote command for {label} ended without an exit status. SSH did not \
                 confirm whether it succeeded, so its output will not be used.\n{}\n\n\
                 Recent activity:\n{}",
                out.stderr.trim(),
                self.diagnostics.tail(15)
            )),
        }
    }
}

fn host_key_changed_under_a_reconnect(settings: &SshSettings, prompt: &HostKeyPrompt) -> String {
    format!(
        "Reconnecting to {}:{} was refused: the server now presents a {} host key \
         with fingerprint {}, and this device trusts {}.\n\n\
         Nothing was sent. If the server really was rebuilt, reconnect from \
         Settings and accept the new key there.",
        settings.host,
        settings.port,
        prompt.algorithm,
        prompt.fingerprint,
        prompt
            .previous_fingerprint
            .as_deref()
            .unwrap_or("no key yet"),
    )
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "…"
}

struct RunFailure {
    message: String,
    why: String,
    unsent: bool,
}

async fn open_exec_channel(
    handle: &Handle<ClientHandler>,
    command: &str,
    diagnostics: &Diagnostics,
) -> Result<Channel<client::Msg>, RunFailure> {
    let opened = tokio::time::timeout(SSH_STAGE_TIMEOUT, handle.channel_open_session())
        .await
        .map_err(|_| RunFailure {
            message: format!(
                "Timed out after {}s opening an SSH command channel. Nothing was sent.\n\n\
                 Recent SSH activity:\n{}",
                SSH_STAGE_TIMEOUT.as_secs(),
                diagnostics.tail(10)
            ),
            why: "opening a channel timed out".to_string(),
            unsent: true,
        })?;
    let channel = opened.map_err(|e| RunFailure {
        message: format!(
            "Opening an SSH channel failed: {e}\n\nRecent SSH activity:\n{}",
            diagnostics.tail(10)
        ),
        why: format!("opening a channel failed: {e}"),
        unsent: true,
    })?;

    tokio::time::timeout(SSH_STAGE_TIMEOUT, channel.exec(true, command))
        .await
        .map_err(|_| RunFailure {
            message: format!(
                "Timed out after {}s handing a remote command to SSH. Nothing was sent.\n\n\
                 Recent SSH activity:\n{}",
                SSH_STAGE_TIMEOUT.as_secs(),
                diagnostics.tail(10)
            ),
            why: "submitting the exec request timed out".to_string(),
            unsent: true,
        })?
        .map_err(|e| RunFailure {
            message: format!("Starting a remote command failed: {e}"),
            why: format!("exec failed: {e}"),
            unsent: true,
        })?;
    Ok(channel)
}

async fn run_command(
    handle: &Handle<ClientHandler>,
    command: &str,
    diagnostics: &Diagnostics,
) -> Result<CommandOutput, RunFailure> {
    let channel = open_exec_channel(handle, command, diagnostics).await?;

    let (mut read, _write) = channel.split();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    // Whether the server said the command was over; without it the link died
    // mid-command and whatever arrived is a fragment.
    let mut ended = false;
    loop {
        let next = tokio::time::timeout(COMMAND_IDLE_TIMEOUT, read.wait())
            .await
            .map_err(|_| RunFailure {
                message: format!(
                    "The remote command produced no SSH channel activity for {}s. It may still \
                     have run on the server, so it will not be retried.\n\n\
                     Recent SSH activity:\n{}",
                    COMMAND_IDLE_TIMEOUT.as_secs(),
                    diagnostics.tail(10)
                ),
                why: "the remote command became unresponsive".to_string(),
                unsent: false,
            })?;
        let Some(msg) = next else { break };
        match msg {
            ChannelMsg::Data { data } => {
                if stdout.len() + data.len() > COMMAND_STDOUT_BUDGET {
                    return Err(RunFailure {
                        message: format!(
                            "The remote command produced more than {} MB of output, which is \
                             more than this app will hold in memory. Its output was abandoned \
                             rather than truncated.\n\nRecent SSH activity:\n{}",
                            COMMAND_STDOUT_BUDGET / (1024 * 1024),
                            diagnostics.tail(10)
                        ),
                        why: "the remote command exceeded its output budget".to_string(),
                        unsent: false,
                    });
                }
                stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, .. } => keep_stderr_tail(&mut stderr, &data),
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status);
                if ended {
                    break;
                }
                ended = true;
            }
            // A command killed by a signal reports this instead of an exit
            // status, and it did finish.
            ChannelMsg::ExitSignal { .. } => ended = true,
            // Not a break on its own: OpenSSH sends `exit-status` *after* the
            // channel EOF, and stopping here would throw the exit status away.
            ChannelMsg::Eof => {
                if exit_code.is_some() {
                    break;
                }
                ended = true;
            }
            ChannelMsg::Close => break,
            ChannelMsg::Failure => {
                return Err(RunFailure {
                    message: format!(
                        "The SSH server rejected the remote command request. The command was not \
                         started and will not be retried.\n\nRecent SSH activity:\n{}",
                        diagnostics.tail(10)
                    ),
                    why: "the server rejected the exec request".to_string(),
                    unsent: false,
                });
            }
            ChannelMsg::Success => {}
            _ => {}
        }
    }

    if !ended {
        return Err(RunFailure {
            message: format!(
                "The SSH connection dropped part way through a remote command, after \
                 {} bytes of its output. Nothing it printed can be trusted to be \
                 complete, so it is being reported rather than used.\n\n\
                 Recent SSH activity:\n{}",
                stdout.len(),
                diagnostics.tail(10)
            ),
            why: "the channel ended without an exit status".to_string(),
            // The command reached the server; repeating it could start a
            // second turn.
            unsent: false,
        });
    }

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

async fn stream_command(
    handle: &Handle<ClientHandler>,
    command: &str,
    diagnostics: &Diagnostics,
    sink: &mut dyn ByteSink,
) -> Result<StreamOutput, RunFailure> {
    let channel = open_exec_channel(handle, command, diagnostics).await?;

    let (mut read, _write) = channel.split();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut bytes = 0u64;
    let mut ended = false;
    loop {
        let next = tokio::time::timeout(COMMAND_IDLE_TIMEOUT, read.wait())
            .await
            .map_err(|_| RunFailure {
                message: format!(
                    "The remote transfer produced no SSH channel activity for {}s, after {bytes} \
                     bytes. The partial file will not be used, and the command will not be \
                     retried because it may still be running on the server.\n\n\
                     Recent SSH activity:\n{}",
                    COMMAND_IDLE_TIMEOUT.as_secs(),
                    diagnostics.tail(10)
                ),
                why: "the remote transfer became unresponsive".to_string(),
                unsent: false,
            })?;
        let Some(msg) = next else { break };
        match msg {
            ChannelMsg::Data { data } => {
                // A sink that refuses is the cancel button, or a full disk;
                // dropping the channel on the way out stops the rest of the
                // file being sent.
                sink.write(&data).map_err(|e| RunFailure {
                    message: e.clone(),
                    why: e,
                    unsent: false,
                })?;
                bytes += data.len() as u64;
            }
            ChannelMsg::ExtendedData { data, .. } => keep_stderr_tail(&mut stderr, &data),
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status);
                if ended {
                    break;
                }
                ended = true;
            }
            ChannelMsg::ExitSignal { .. } => ended = true,
            ChannelMsg::Eof => {
                if exit_code.is_some() {
                    break;
                }
                ended = true;
            }
            ChannelMsg::Close => break,
            ChannelMsg::Failure => {
                return Err(RunFailure {
                    message: format!(
                        "The SSH server rejected the remote transfer request. The command was not \
                         started and will not be retried.\n\nRecent SSH activity:\n{}",
                        diagnostics.tail(10)
                    ),
                    why: "the server rejected the exec request".to_string(),
                    unsent: false,
                });
            }
            ChannelMsg::Success => {}
            _ => {}
        }
    }

    if !ended {
        return Err(RunFailure {
            message: format!(
                "The SSH connection dropped part way through the transfer, after \
                 {bytes} bytes. What arrived is a fragment of the file rather than \
                 the file, so it is being reported rather than used.\n\n\
                 Recent SSH activity:\n{}",
                diagnostics.tail(10)
            ),
            why: "the channel ended without an exit status".to_string(),
            unsent: false,
        });
    }

    Ok(StreamOutput {
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        bytes,
    })
}

fn russh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Mobile networks drop idle TCP aggressively; keepalives hold the
        // session open between polls. The two numbers multiply out to how long
        // a silent link is tolerated, kept generous because Android freezes a
        // backgrounded app, keepalives included.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 20,
        // The keepalive budget above is the only liveness check wanted here.
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    })
}

async fn open_session(
    settings: &SshSettings,
    known: Option<&KnownHost>,
    diagnostics: &Diagnostics,
) -> Result<Result<Handle<ClientHandler>, HostKeyPrompt>, String> {
    let capture = HostKeyCapture::default();
    let handler = ClientHandler {
        expected_fingerprint: known.map(|k| k.fingerprint.clone()),
        capture: capture.clone(),
        diagnostics: diagnostics.clone(),
    };

    let addr = (settings.host.as_str(), settings.port);
    diagnostics.push(
        "ssh",
        format!("connecting to {}:{}", settings.host, settings.port),
    );

    let connected = tokio::time::timeout(
        SSH_STAGE_TIMEOUT,
        client::connect(russh_config(), addr, handler),
    )
    .await
    .map_err(|_| {
        format!(
            "Timed out after {}s connecting to {}:{}.\n\
             Check the host/port are reachable from this device (mobile data vs Wi-Fi, VPN, firewall).",
            SSH_STAGE_TIMEOUT.as_secs(), settings.host, settings.port
        )
    })?;

    match connected {
        Ok(handle) => Ok(Ok(handle)),
        Err(err) => {
            // Distinguish "we deliberately refused the key" from a real failure.
            if capture.rejected.load(Ordering::SeqCst) {
                let fingerprint = capture
                    .fingerprint
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .unwrap_or_default();
                let algorithm = capture
                    .algorithm
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .unwrap_or_default();
                let openssh = capture
                    .openssh
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .unwrap_or_default();
                return Ok(Err(HostKeyPrompt {
                    host: settings.host.clone(),
                    port: settings.port,
                    algorithm,
                    fingerprint,
                    openssh,
                    mismatch: known.is_some(),
                    previous_fingerprint: known.map(|k| k.fingerprint.clone()),
                }));
            }
            Err(format!(
                "SSH connection to {}:{} failed: {err}\n\n\
                 Recent SSH activity:\n{}",
                settings.host,
                settings.port,
                diagnostics.tail(15)
            ))
        }
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    settings: &SshSettings,
    diagnostics: &Diagnostics,
) -> Result<(), String> {
    diagnostics.push("ssh", "host key verified; authenticating with password");

    let auth = tokio::time::timeout(
        SSH_STAGE_TIMEOUT,
        handle.authenticate_password(settings.username.clone(), settings.password.clone()),
    )
    .await
    .map_err(|_| {
        format!(
            "Timed out after {}s authenticating '{}'@{}:{}.\n\n\
                 Recent SSH activity:\n{}",
            SSH_STAGE_TIMEOUT.as_secs(),
            settings.username,
            settings.host,
            settings.port,
            diagnostics.tail(15)
        )
    })?
    .map_err(|e| {
        format!(
            "Password authentication for user '{}' errored: {e}\n\n\
                 Recent SSH activity:\n{}",
            settings.username,
            diagnostics.tail(15)
        )
    })?;

    if !auth.success() {
        let detail = match &auth {
            russh::client::AuthResult::Failure {
                remaining_methods,
                partial_success,
            } => format!(
                "server rejected the password (partial_success={partial_success}); \
                 methods the server still offers: {remaining_methods:?}"
            ),
            russh::client::AuthResult::Success => unreachable!(),
        };
        return Err(format!(
            "SSH password authentication failed for '{}'@{}:{}.\n{detail}\n\n\
             This app only supports password auth. If the server has \
             'PasswordAuthentication no' in sshd_config, password login is disabled there.\n\n\
             Recent SSH activity:\n{}",
            settings.username,
            settings.host,
            settings.port,
            diagnostics.tail(15)
        ));
    }
    Ok(())
}

async fn probe_capabilities(
    handle: &Handle<ClientHandler>,
    settings: &SshSettings,
    diagnostics: &Diagnostics,
) -> Result<HostCapabilities, String> {
    let probe = run_command(
        handle,
        &remote::probe_command(
            &settings.codex_bin,
            &settings.claude_bin,
            &settings.opencode_bin,
            &settings.pi_bin,
        ),
        diagnostics,
    )
    .await
    .map_err(|e| e.message)?;
    match probe.exit_code {
        Some(0) => {}
        Some(code) => {
            return Err(format!(
                "The remote capability check failed (exit {code}).\n{}\n\nRecent activity:\n{}",
                probe.stderr.trim(),
                diagnostics.tail(15)
            ));
        }
        None => {
            return Err(format!(
                "The remote capability check ended without an exit status. SSH did not confirm \
                 that its output was complete, so the connection will not use it.\n{}\n\n\
                 Recent activity:\n{}",
                probe.stderr.trim(),
                diagnostics.tail(15)
            ));
        }
    }
    let capabilities = remote::parse_probe(&probe.stdout);
    diagnostics.push("remote", format!("host capabilities: {capabilities:?}"));
    if !capabilities.any_harness() {
        return Err(format!(
            "Connected to {}@{}:{}, but none of `{}`, `{}`, `{}` or `{}` is runnable there.\n\n\
             The app runs `codex exec`, `claude -p`, `opencode run` or `pi -a --mode json` for \
             each turn and reads the sessions those CLIs record, so it needs at least one of \
             them on the remote PATH for a login shell. Check the binary names in Settings.\n\n\
             Remote said:\n{}\n\nRecent activity:\n{}",
            settings.username,
            settings.host,
            settings.port,
            settings.codex_bin,
            settings.claude_bin,
            settings.opencode_bin,
            settings.pi_bin,
            probe.stderr.trim(),
            diagnostics.tail(15)
        ));
    }
    Ok(capabilities)
}

pub async fn connect_full(
    settings: SshSettings,
    known: Option<KnownHost>,
    diagnostics: Diagnostics,
) -> Result<(Option<Connection>, ConnectOutcome), String> {
    let mut handle = match open_session(&settings, known.as_ref(), &diagnostics).await? {
        Ok(handle) => handle,
        Err(prompt) => return Ok((None, ConnectOutcome::HostKeyUnverified { prompt })),
    };

    authenticate(&mut handle, &settings, &diagnostics).await?;

    diagnostics.push("ssh", "authenticated; checking what the host can do");
    let capabilities = probe_capabilities(&handle, &settings, &diagnostics).await?;

    let connection = Connection {
        handle,
        settings,
        known,
        diagnostics,
        capabilities: capabilities.clone(),
    };
    Ok((Some(connection), ConnectOutcome::Connected { capabilities }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_keeps_its_tail_and_never_grows_past_the_cap() {
        let mut stderr = Vec::new();
        keep_stderr_tail(&mut stderr, b"start ");
        assert_eq!(stderr, b"start ");
        keep_stderr_tail(&mut stderr, &vec![b'x'; COMMAND_STDERR_TAIL]);
        assert_eq!(stderr.len(), COMMAND_STDERR_TAIL);
        assert!(
            stderr.iter().all(|b| *b == b'x'),
            "the oldest bytes go first: the failure explains itself at the end"
        );
    }
}
