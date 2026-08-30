//! End-to-end test of the whole remote side, against an SSH server that
//! **really executes** what the client sends.
//!
//! Faking the remote program would leave the interesting half untested, because
//! almost everything happens in shell on the server: installing `turn.sh`,
//! writing a turn's inputs, launching it detached, discovering the session file
//! from the id the CLI reports, and tailing that file as it grows. So the server
//! here runs a real shell, and the CLIs are stubs that behave like the real ones
//! in the ways that matter.
//!
//! Skipped, loudly, without python3 (which the stubs are written in). The tmux
//! path is exercised when tmux is present and the `setsid` fallback when it is
//! not; the test asserts which one it got.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use pabloagent_lib::testing::{
    close_session_command, connect_full, delete_session_command, download_remote_file_command,
    list_sessions_command, mark_session_read_command, parse_pretty_session, parse_sessions,
    parse_turn_poll, poll_turn_command, pretty_session_command, read_rollout_command,
    refused_because_busy, rewind_session_command, start_turn_command, stop_turn_command,
    ConnectOutcome, Connection, Diagnostics, Download, Harness, Header, KnownHost, Progress,
    SessionSummary, SshSettings, TurnPoll, TurnRequest, TurnState,
};
use russh::keys::ssh_key::{HashAlg, PrivateKey};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PASSWORD: &str = "correct horse battery staple";
const USERNAME: &str = "tester";

const TEST_HOST_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDlYHPlobg3fs5mKHKEB3n1+gOuiA5M6b603yHcjAn0CQAAAJioEum7qBLp
uwAAAAtzc2gtZWQyNTUxOQAAACDlYHPlobg3fs5mKHKEB3n1+gOuiA5M6b603yHcjAn0CQ
AAAEATztbmilHkEJ0U04+mal9LsJ256BARkn06GUaTxQF4q+Vgc+WhuDd+zmYocoQHefX6
A66IDkzpvrTfIdyMCfQJAAAADmNvZGV4Y2hhdC10ZXN0AQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----
";

const OTHER_HOST_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBBr4odySzfcglPJBezrzYc6wRFKJs7EFh+nuupiQtpQAAAAKAA1maqANZm
qgAAAAtzc2gtZWQyNTUxOQAAACBBr4odySzfcglPJBezrzYc6wRFKJs7EFh+nuupiQtpQA
AAAEBSYDSs6HvQt5BkPtPu+cA21uo3djAdny3Jm3Akf5nHLEGvih3JLN9yCU8kF7OvNhzr
BEUomzsQWH6e66mJC2lAAAAAG3BpbmVhcHBsZXRhbGstdGVzdC1pbXBvc3RlcgEC
-----END OPENSSH PRIVATE KEY-----
";

const STUB_CODEX: &str = r#"
import json, os, sys, time, glob

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("codex-cli 0.145.0-stub")
    raise SystemExit(0)

if args[:1] != ["exec"]:
    sys.stderr.write(f"stub: unexpected argv {args}\n")
    raise SystemExit(2)
args = args[1:]

thread = ""
if args[:1] == ["resume"]:
    thread = args[1]
    args = args[2:]

model, effort = "", ""
while args:
    a = args.pop(0)
    if a == "-m":
        model = args.pop(0)
    elif a == "-c":
        kv = args.pop(0)
        if kv.startswith("model_reasoning_effort="):
            effort = kv.split("=", 1)[1].strip('"')
    elif a in ("--json", "--skip-git-repo-check"):
        pass
    elif a == "-":
        break
    else:
        sys.stderr.write(f"stub: unexpected option {a}\n")
        raise SystemExit(2)

# The real thing reads stdin to EOF even with a prompt argument. If the app
# forgot to redirect it this blocks exactly as codex does, and the test times
# out — which is the point of doing it here too.
prompt = sys.stdin.read()

home = os.environ["CODEX_HOME"]
sessions = os.path.join(home, "sessions")
os.makedirs(sessions, exist_ok=True)
fresh = not thread
if fresh:
    thread = "019fac00-0000-7000-8000-%012d" % os.getpid()
    path = os.path.join(sessions, "rollout-2026-07-29T10-00-00-%s.jsonl" % thread)
else:
    path = sorted(glob.glob(os.path.join(sessions, "*%s*.jsonl" % thread)))[-1]

print(json.dumps({"type": "thread.started", "thread_id": thread}), flush=True)

def append(obj):
    with open(path, "a") as fh:
        fh.write(json.dumps(obj) + "\n")
        fh.flush()

def response(payload):
    append({"type": "response_item", "payload": payload})

if fresh:
    append({"type": "session_meta", "timestamp": "2026-07-29T10:00:00.000Z",
            "payload": {"id": thread, "session_id": thread, "cwd": os.getcwd(),
                        "cli_version": "0.145.0-stub", "originator": "codex_exec"}})
append({"type": "event_msg", "payload": {"type": "task_started"}})
append({"type": "turn_context", "payload": {"turn_id": "turn-%d" % os.getpid(),
        "model": model or "default", "effort": effort or "medium",
        "cwd": os.getcwd(), "approval_policy": "never"}})
# Injected context, which must NOT become the session preview.
response({"type": "message", "role": "user",
          "content": [{"type": "input_text", "text": "<environment_context>injected</environment_context>"}]})
response({"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]})
append({"type": "event_msg", "payload": {"type": "user_message", "message": prompt}})

# Written a piece at a time, with the turn still going, so the test can prove
# the app sees a turn in progress rather than only its result.
time.sleep(0.4)
response({"type": "custom_tool_call", "name": "exec", "call_id": "call-1",
          "input": 'tools.exec_command({cmd:"echo hello"})', "status": "completed"})
time.sleep(0.4)
response({"type": "custom_tool_call_output", "call_id": "call-1", "output": "hello\n"})
if "sleep-forever" in prompt:
    time.sleep(600)
time.sleep(0.4)
response({"type": "message", "role": "assistant",
          "content": [{"type": "output_text", "text": "done with %s" % (model or "default")}]})
append({"type": "event_msg", "payload": {"type": "task_complete", "duration_ms": 1200}})
"#;

const STUB_CLAUDE: &str = r#"
import json, os, re, signal, sys, time

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("2.1.220 (Claude Code stub)")
    raise SystemExit(0)

if "-p" not in args:
    sys.stderr.write("stub: claude must be run with -p\n")
    raise SystemExit(2)

session, resume, model, effort, permission = "", "", "", "", ""
args = [a for a in args if a not in ("-p", "--verbose")]
while args:
    a = args.pop(0)
    if a == "--session-id":
        session = args.pop(0)
    elif a == "--resume":
        resume = args.pop(0)
    elif a == "--model":
        model = args.pop(0)
    elif a == "--effort":
        effort = args.pop(0)
    elif a == "--permission-mode":
        permission = args.pop(0)
    elif a == "--output-format":
        args.pop(0)
    else:
        # `-` lands here on purpose: codex takes its prompt that way and claude
        # does not, so passing it must fail loudly rather than quietly corrupt
        # the first line of the conversation.
        sys.stderr.write("stub: unexpected option %s\n" % a)
        raise SystemExit(2)

# The real one reads stdin to EOF for the prompt. If the app forgot to redirect
# it this blocks exactly as claude does, and the test times out — the point.
prompt = sys.stdin.read()

cwd = os.getcwd()
home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.environ["HOME"], ".claude")
project = re.sub(r"[^A-Za-z0-9-]", "-", cwd)
folder = os.path.join(home, "projects", project)
os.makedirs(folder, exist_ok=True)
sid = resume or session
path = os.path.join(folder, "%s.jsonl" % sid)
# A session's own subdirectory, which the app must not mistake for a session.
os.makedirs(os.path.join(folder, sid, "tool-results"), exist_ok=True)
open(os.path.join(folder, sid, "tool-results", "%s.jsonl" % sid), "a").close()

def interrupt(sig, frame):
    open(os.path.join(folder, sid, "interrupted"), "w").write(str(sig))
    raise KeyboardInterrupt
signal.signal(signal.SIGINT, interrupt)

# `system/init` is the first line of the stream, on a resumed turn as well.
print(json.dumps({"type": "system", "subtype": "init", "cwd": cwd,
                  "session_id": sid, "model": model or "default"}), flush=True)

def append(obj):
    obj.setdefault("sessionId", sid)
    obj.setdefault("cwd", cwd)
    obj.setdefault("version", "2.1.220-stub")
    obj.setdefault("timestamp", "2026-07-29T10:00:00.000Z")
    with open(path, "a") as fh:
        fh.write(json.dumps(obj) + "\n")
        fh.flush()

def assistant(part):
    append({"type": "assistant", "isSidechain": False,
            "message": {"role": "assistant", "model": model or "default",
                        "content": [part],
                        "usage": {"input_tokens": 12, "cache_read_input_tokens": 900,
                                  "output_tokens": 34}}})

# The prompt queue's bookkeeping repeats the prompt verbatim; the app drops it.
append({"type": "queue-operation", "operation": "enqueue", "content": prompt})
append({"type": "user", "promptSource": "sdk", "isSidechain": False,
        "message": {"role": "user", "content": prompt}})
# An attachment, which must NOT become the session preview.
append({"type": "attachment", "isSidechain": False,
        "attachment": {"type": "skill_listing", "content": "injected listing"}})

time.sleep(0.4)
assistant({"type": "thinking", "thinking": "thinking about %s" % (effort or "default"),
           "signature": "sig"})
time.sleep(0.4)
assistant({"type": "tool_use", "id": "toolu_1", "name": "Bash",
           "input": {"command": "echo hello", "description": "say hello"}})
time.sleep(0.4)
append({"type": "user", "isSidechain": False, "toolUseResult": {"stdout": "hello"},
        "message": {"role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_1",
                                 "content": "hello", "is_error": False}]}})
if "sleep-forever" in prompt:
    time.sleep(600)
time.sleep(0.4)
assistant({"type": "text", "text": "done with %s%s%s" % (
    model or "default",
    " effort=%s" % effort if effort else "",
    " permission=%s" % permission if permission else "")})
append({"type": "last-prompt", "lastPrompt": prompt[:40]})
"#;

const STUB_OPENCODE: &str = r#"
import json, os, sqlite3, sys, time

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("1.18.8-stub")
    raise SystemExit(0)

db_path = os.environ.get("OPENCODE_DB") or os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.join(os.environ["HOME"], ".local/share"),
    "opencode", "opencode.db")
os.makedirs(os.path.dirname(db_path), exist_ok=True)
db = sqlite3.connect(db_path, timeout=10)
db.executescript("""
CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, parent_id TEXT,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_archived INTEGER);
CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
  session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL);
""")
db.commit()

if args[:1] == ["db"]:
    # `opencode db <sql> --format tsv`: a header line, then one row per line.
    sql = args[1]
    print("header")
    for row in db.execute(sql):
        print("\t".join(str(v) for v in row))
    raise SystemExit(0)

if args[:1] != ["run"]:
    sys.stderr.write(f"stub: unexpected argv {args}\n")
    raise SystemExit(2)
args = args[1:]

session, model, variant, titled, auto, fmt, thinking = "", "", "", False, False, "", False
while args:
    a = args.pop(0)
    if a == "-s":
        session = args.pop(0)
    elif a == "-m":
        model = args.pop(0)
    elif a == "--variant":
        variant = args.pop(0)
    elif a == "--format":
        fmt = args.pop(0)
    elif a == "--title":
        titled = True
    elif a == "--auto":
        auto = True
    elif a == "--thinking":
        thinking = True
    else:
        sys.stderr.write(f"stub: unexpected option {a}\n")
        raise SystemExit(2)
if fmt != "json":
    sys.stderr.write("stub: the app must ask for --format json\n")
    raise SystemExit(2)

# The real one reads stdin to EOF for the prompt. If the app forgot to redirect
# it this blocks exactly as opencode does, and the test times out — the point.
prompt = sys.stdin.read()

now = lambda: int(time.time() * 1000)
seq = [0]
def ident(prefix):
    seq[0] += 1
    return "%s%013d%03dstub" % (prefix, now(), seq[0])

if not session:
    session = ident("ses_")
    db.execute("INSERT INTO session VALUES (?,NULL,?,?,?,?,?,NULL)",
               (session, os.getcwd(), prompt[:50] if titled else "New session",
                "1.18.8-stub", now(), now()))
    db.commit()
elif titled:
    # What guards turn.sh: `--title` on a resume renames the session being
    # joined, so sending it there would churn every row in the picker.
    db.execute("UPDATE session SET title=? WHERE id=?", (prompt[:50], session))
    db.commit()

def insert_message(role, extra):
    mid = ident("msg_")
    data = {"role": role, "time": {"created": now()},
            "model": {"providerID": "stub", "modelID": model or "default"}}
    data.update(extra)
    db.execute("INSERT INTO message VALUES (?,?,?,?,?)",
               (mid, session, now(), now(), json.dumps(data)))
    db.execute("UPDATE session SET time_updated=? WHERE id=?", (now(), session))
    db.commit()
    return mid

def insert_part(mid, data, emit):
    pid = ident("prt_")
    db.execute("INSERT INTO part VALUES (?,?,?,?,?,?)",
               (pid, mid, session, now(), now(), json.dumps(data)))
    db.commit()
    if emit:
        part = dict(data)
        part.update({"id": pid, "messageID": mid, "sessionID": session})
        print(json.dumps({"type": emit, "timestamp": now(),
                          "sessionID": session, "part": part}), flush=True)

user = insert_message("user", {})
insert_part(user, {"type": "text", "text": prompt}, None)

assistant = insert_message("assistant", {"path": {"cwd": os.getcwd(), "root": "/"}})
insert_part(assistant, {"type": "step-start"}, "step_start")
time.sleep(0.4)
if thinking:
    insert_part(assistant, {"type": "reasoning",
                            "text": "thinking about %s" % (variant or "default")},
                "reasoning")
time.sleep(0.4)
insert_part(assistant, {"type": "tool", "tool": "bash", "callID": "call-1",
                        "state": {"status": "completed",
                                  "input": {"command": "echo hello"},
                                  "output": "hello\n", "title": "echo hello"}},
            "tool_use")
if "sleep-forever" in prompt:
    time.sleep(600)
time.sleep(0.4)
insert_part(assistant, {"type": "text", "text": "done with %s%s%s" % (
    model or "default",
    " variant=%s" % variant if variant else "",
    " auto" if auto else "")}, "text")
insert_part(assistant, {"type": "step-finish", "reason": "stop",
                        "tokens": {"total": 1234}}, "step_finish")
"#;

const STUB_PI: &str = r#"
import glob, json, os, re, sys, time, uuid

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("0.82.1-stub")
    raise SystemExit(0)
if args[:1] == ["--list-models"]:
    print("provider      model          context  max-out  thinking  images")
    print("openai-codex  gpt-5.6-sol    272K     128K     yes       yes")
    print("openai-codex  gpt-5.6-terra  272K     128K     no        yes")
    raise SystemExit(0)

mode, session, model, thinking, approve = "", "", "", "", False
while args:
    a = args.pop(0)
    if a == "--mode":
        mode = args.pop(0)
    elif a == "--session-id":
        session = args.pop(0)
    elif a == "--model":
        model = args.pop(0)
    elif a == "--thinking":
        thinking = args.pop(0)
    elif a in ("-a", "--approve"):
        approve = True
    else:
        # pi takes no prompt argument — the prompt is stdin. A codex-style `-`
        # leaking in lands here and fails loudly rather than corrupting the
        # conversation.
        sys.stderr.write("stub: unexpected option %s\n" % a)
        raise SystemExit(2)
if mode != "json":
    sys.stderr.write("stub: the app must ask for --mode json\n")
    raise SystemExit(2)
if not approve:
    # The real pi answers its own trust question with "no" when nobody can
    # answer it, and then silently ignores the workspace's project-local files.
    # There is nothing to see in a session file afterwards, so the stub refuses
    # instead: a turn that forgot autotrust has to fail where it is visible.
    sys.stderr.write("stub: the app must autotrust the workspace with -a\n")
    raise SystemExit(2)

# The real one reads stdin to EOF for the prompt. If the app forgot to redirect
# it this blocks exactly as pi does, and the test times out — the point.
prompt = sys.stdin.read()

cwd = os.getcwd()
agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(os.environ["HOME"], ".pi/agent")
safe = "--" + re.sub(r"[/\\:]", "-", re.sub(r"^[/\\]", "", cwd)) + "--"
folder = os.path.join(agent_dir, "sessions", safe)
os.makedirs(folder, exist_ok=True)

existing = sorted(glob.glob(os.path.join(folder, "*_%s.jsonl" % session))) if session else []
fresh = not existing
if fresh:
    session = session or str(uuid.uuid4())
    path = os.path.join(folder, "2026-07-30T03-24-08-942Z_%s.jsonl" % session)
else:
    path = existing[-1]

# The session header is the first stdout line, on a resumed turn as well.
print(json.dumps({"type": "session", "version": 3, "id": session,
                  "timestamp": "2026-07-30T03:24:08.942Z", "cwd": cwd}), flush=True)

seq = [0]
def entry(obj):
    seq[0] += 1
    obj.update({"id": "%08x" % ((os.getpid() * 1000 + seq[0]) % 0xffffffff),
                "parentId": None, "timestamp": "2026-07-30T03:24:08.970Z"})
    return obj

def write(obj):
    with open(path, "a") as fh:
        fh.write(json.dumps(obj) + "\n")
        fh.flush()

def assistant(content, stop):
    return entry({"type": "message", "message": {
        "role": "assistant", "content": content, "provider": "stub",
        "model": model or "default",
        "usage": {"input": 12, "output": 34, "cacheRead": 0, "cacheWrite": 0,
                  "totalTokens": 46},
        "stopReason": stop, "timestamp": 1785381849001}})

pending = []
if fresh:
    pending.append({"type": "session", "version": 3, "id": session,
                    "timestamp": "2026-07-30T03:24:08.942Z", "cwd": cwd})
pending.append(entry({"type": "model_change", "provider": "stub",
                      "modelId": model or "default"}))
pending.append(entry({"type": "thinking_level_change",
                      "thinkingLevel": thinking or "default"}))
pending.append(entry({"type": "message", "message": {"role": "user",
    "content": [{"type": "text", "text": prompt}], "timestamp": 1785381848986}}))

# A brand new session's file does not exist until the first assistant message
# arrives (measured on 0.82.1) — everything before it is buffered. A resumed
# session's file already exists, and the real one appends to it just as
# eagerly, so the same dump-then-append works for both.
time.sleep(0.4)
for obj in pending:
    write(obj)
write(assistant([{"type": "toolCall", "id": "call-1", "name": "bash",
                  "arguments": {"command": "echo hello"}}], "toolUse"))
time.sleep(0.4)
write(entry({"type": "message", "message": {"role": "toolResult",
    "toolCallId": "call-1", "toolName": "bash",
    "content": [{"type": "text", "text": "hello\n"}],
    "isError": False, "timestamp": 1785381920221}}))
if "sleep-forever" in prompt:
    time.sleep(600)
time.sleep(0.4)
write(assistant([{"type": "text", "text": "done with %s thinking=%s" % (
    model or "default", thinking or "default")}], "stop"))
"#;

// ---------------------------------------------------------------------------
// An SSH server that really runs what it is asked to run
// ---------------------------------------------------------------------------

type Env = Arc<HashMap<String, String>>;

struct ExecServer {
    env: Env,
}

struct ExecHandler {
    env: Env,
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl Server for ExecServer {
    type Handler = ExecHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> ExecHandler {
        ExecHandler {
            env: self.env.clone(),
            stdin: Arc::new(Mutex::new(None)),
        }
    }
}

impl Handler for ExecHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USERNAME && password == PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).into_owned();
        if command == "pablo-test-reject-exec" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        if command == "pablo-test-stall-exec" {
            return Ok(());
        }
        if command == "pablo-test-no-exit-status" {
            let handle = session.handle();
            tokio::spawn(async move {
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
            });
            return Ok(());
        }

        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .env_clear()
            .envs(self.env.iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the test server must be able to run a shell");

        *self.stdin.lock().unwrap() = child.stdin.take();
        let handle = session.handle();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let out_handle = handle.clone();
        let pump_stdout = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut buf = vec![0u8; 16384];
                match tokio::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.truncate(n);
                        if out_handle.data(channel, buf).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let err_handle = handle.clone();
        let pump_stderr = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = err_handle
                    .extended_data(channel, 1, format!("{line}\n").into_bytes())
                    .await;
            }
        });

        tokio::spawn(async move {
            let status = child.wait().await;
            // Both pumps have to drain *before* the channel is closed: a real
            // sshd never reports exit-status ahead of the output that preceded
            // it, and closing early silently truncates a command's stdout.
            let _ = pump_stdout.await;
            let _ = pump_stderr.await;
            let code = status.ok().and_then(|s| s.code()).unwrap_or(0) as u32;
            let _ = handle.exit_status_request(channel, code).await;
            let _ = handle.eof(channel).await;
            let _ = handle.close(channel).await;
        });
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let taken = self.stdin.lock().unwrap().take();
        if let Some(mut pipe) = taken {
            let _ = pipe.write_all(data).await;
            let _ = pipe.flush().await;
            *self.stdin.lock().unwrap() = Some(pipe);
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.stdin.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Clone)]
struct Link {
    sockets: Arc<Mutex<Vec<std::net::TcpStream>>>,
    host_key: Arc<Mutex<&'static str>>,
}

impl Link {
    fn cut(&self) {
        for socket in self.sockets.lock().unwrap().drain(..) {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }

    fn change_host_key(&self) {
        *self.host_key.lock().unwrap() = OTHER_HOST_KEY;
    }
}

async fn start_server(env: Env) -> (u16, String, Link) {
    let key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("test host key must parse");
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = ExecServer { env };
    let link = Link {
        sockets: Arc::new(Mutex::new(Vec::new())),
        host_key: Arc::new(Mutex::new(TEST_HOST_KEY)),
    };
    let sockets = link.sockets.clone();
    let host_key = link.host_key.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, addr)) = listener.accept().await else {
                break;
            };
            let handler = server.new_client(Some(addr));
            // Built per connection rather than once, so a test can swap the key
            // the server presents while the port stays the same — which is what
            // a rebuilt host looks like to a client that reconnects.
            let key = PrivateKey::from_openssh(*host_key.lock().unwrap())
                .expect("test host key must parse");
            let config = Arc::new(russh::server::Config {
                keys: vec![key],
                auth_rejection_time: std::time::Duration::from_millis(1),
                ..Default::default()
            });
            // Keep a second descriptor for the socket before handing it over, so
            // the test can close it later. Both refer to one socket, so a
            // shutdown on this one is a shutdown of the connection.
            let raw = stream.into_std().expect("the socket must be reclaimable");
            let spare = raw.try_clone().expect("the socket must be cloneable");
            let stream = tokio::net::TcpStream::from_std(raw).expect("and handed back to tokio");
            sockets.lock().unwrap().push(spare);
            tokio::spawn(async move {
                let _ = russh::server::run_stream(config, stream, handler).await;
            });
        }
    });

    (port, fingerprint, link)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn have(program: &str) -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {program} >/dev/null 2>&1"))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct Remote {
    connection: Connection,
    link: Link,
    temp: std::path::PathBuf,
    tmux_tmpdir: std::path::PathBuf,
    turn_keys: Vec<String>,
}

impl Remote {
    async fn start(name: &str) -> Option<Self> {
        if !have("python3") {
            eprintln!("SKIPPED: this test needs python3 for the CLI stubs");
            return None;
        }
        let temp = std::env::temp_dir().join(format!("pt-rollout-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let codex_home = temp.join(".codex");
        let claude_home = temp.join(".claude");
        let data_home = temp.join(".local/share");
        let pi_agent_dir = temp.join(".pi/agent");
        let tmux_tmpdir = temp.join("tmux");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::create_dir_all(&claude_home).unwrap();
        std::fs::create_dir_all(&data_home).unwrap();
        std::fs::create_dir_all(&pi_agent_dir).unwrap();
        std::fs::create_dir_all(&tmux_tmpdir).unwrap();

        // An absolute interpreter path, resolved here rather than looked up on
        // the remote PATH. `turn.sh` runs things through `bash -lc`, and a login
        // shell rebuilds PATH from /etc/profile — which on a CI runner drops the
        // hosted-tool-cache entry that `python3` lives in.
        let python = String::from_utf8_lossy(
            &std::process::Command::new("sh")
                .arg("-c")
                .arg("command -v python3")
                .output()
                .expect("python3 must be locatable")
                .stdout,
        )
        .trim()
        .to_string();

        let install = |cli: &str, source: &str| -> std::path::PathBuf {
            let script = temp.join(format!("{cli}_stub.py"));
            let stub = temp.join(cli);
            std::fs::write(&script, source).unwrap();
            std::fs::write(
                &stub,
                format!("#!/bin/sh\nexec {python} {} \"$@\"\n", script.display()),
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            stub
        };
        let codex_stub = install("codex", STUB_CODEX);
        let claude_stub = install("claude", STUB_CLAUDE);
        let opencode_stub = install("opencode", STUB_OPENCODE);
        let pi_stub = install("pi", STUB_PI);

        let env: Env = Arc::new(HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("HOME".into(), temp.display().to_string()),
            ("CODEX_HOME".into(), codex_home.display().to_string()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                claude_home.display().to_string(),
            ),
            // Where the opencode stub keeps its database, exactly as the real
            // one resolves it.
            ("XDG_DATA_HOME".into(), data_home.display().to_string()),
            // Where the pi stub keeps its sessions, exactly as the real one
            // resolves it.
            (
                "PI_CODING_AGENT_DIR".into(),
                pi_agent_dir.display().to_string(),
            ),
            (
                "XDG_CACHE_HOME".into(),
                temp.join("cache").display().to_string(),
            ),
            ("TMUX_TMPDIR".into(), tmux_tmpdir.display().to_string()),
        ]));

        let (port, fingerprint, link) = start_server(env).await;
        let settings = SshSettings {
            host: "127.0.0.1".to_string(),
            port,
            username: USERNAME.to_string(),
            password: PASSWORD.to_string(),
            // Absolute paths, so nothing depends on what a login shell does
            // to PATH.
            codex_bin: codex_stub.display().to_string(),
            claude_bin: claude_stub.display().to_string(),
            opencode_bin: opencode_stub.display().to_string(),
            pi_bin: pi_stub.display().to_string(),
            default_cwd: temp.display().to_string(),
        };

        let (connection, outcome) = connect_full(
            settings,
            Some(KnownHost {
                algorithm: "ssh-ed25519".to_string(),
                fingerprint,
                openssh: String::new(),
            }),
            Diagnostics::new(),
        )
        .await
        .expect("connecting to the fake host must succeed");

        match outcome {
            ConnectOutcome::Connected { capabilities } => {
                assert_eq!(
                    capabilities.codex_version.as_deref(),
                    Some("codex-cli 0.145.0-stub"),
                    "the probe must find the codex binary and report its version"
                );
                assert_eq!(
                    capabilities.claude_version.as_deref(),
                    Some("2.1.220 (Claude Code stub)"),
                    "and the claude binary, in the same probe"
                );
                assert_eq!(
                    capabilities.opencode_version.as_deref(),
                    Some("1.18.8-stub"),
                    "and the opencode binary, in the same probe"
                );
                assert_eq!(
                    capabilities.sessions_dir,
                    codex_home.join("sessions").display().to_string(),
                    "CODEX_HOME must be honoured when locating rollouts"
                );
                assert_eq!(
                    capabilities.projects_dir,
                    claude_home.join("projects").display().to_string(),
                    "CLAUDE_CONFIG_DIR must be honoured when locating transcripts"
                );
                assert_eq!(
                    capabilities.opencode_db,
                    data_home.join("opencode/opencode.db").display().to_string(),
                    "XDG_DATA_HOME must be honoured when locating the opencode database"
                );
                assert_eq!(
                    capabilities.pi_version.as_deref(),
                    Some("0.82.1-stub"),
                    "and the pi binary, in the same probe"
                );
                assert_eq!(
                    capabilities.pi_sessions_dir,
                    pi_agent_dir.join("sessions").display().to_string(),
                    "PI_CODING_AGENT_DIR must be honoured when locating pi sessions"
                );
            }
            other => panic!("expected Connected, got {other:?}"),
        }

        Some(Self {
            connection: connection.expect("a trusted key must yield a live connection"),
            link,
            temp,
            tmux_tmpdir,
            turn_keys: Vec::new(),
        })
    }

    async fn start_turn(&mut self, key: &str, request: &TurnRequest) -> Result<String, String> {
        let settings = self.connection.settings();
        let command = start_turn_command(
            key,
            request,
            &settings.codex_bin,
            &settings.claude_bin,
            &settings.opencode_bin,
            &settings.pi_bin,
        );
        let started = self.connection.run_ok("start turn", &command).await;
        if started.is_ok() {
            self.turn_keys.push(key.to_string());
        }
        started
    }

    async fn poll(&mut self, key: &str, from: u64) -> TurnPoll {
        let out = self
            .connection
            .run_ok("poll turn", &poll_turn_command(key, from))
            .await
            .expect("polling the fake host must succeed");
        parse_turn_poll(&out).expect("the fake host must return a complete poll frame")
    }

    async fn follow(&mut self, key: &str) -> (String, TurnPoll, bool) {
        let mut cursor = 1;
        let mut text = String::new();
        let mut saw_partial = false;
        for _ in 0..200 {
            let poll = self.poll(key, cursor).await;
            if poll.line_count > 0 {
                text.push_str(&poll.lines);
                cursor += poll.line_count;
                if poll.running {
                    saw_partial = true;
                }
            }
            if !poll.running {
                // One last read: a turn can finish between the tail and the
                // status check.
                let last = self.poll(key, cursor).await;
                text.push_str(&last.lines);
                return (text, poll, saw_partial);
            }
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        }
        panic!("turn {key} never finished");
    }

    async fn sessions(&mut self) -> Vec<SessionSummary> {
        self.sessions_result().await.unwrap_or_default()
    }

    async fn read_history(&mut self, harness: Harness, path: &str) -> Result<String, String> {
        let opencode_bin = self.connection.settings().opencode_bin.clone();
        let command = read_rollout_command(harness, path, 1, &opencode_bin)?;
        self.connection.run_ok("read history", &command).await
    }

    async fn session_once_written(&mut self) -> Option<SessionSummary> {
        for _ in 0..100 {
            if let Some(session) = self.sessions().await.into_iter().next() {
                return Some(session);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        None
    }

    async fn run_guarded(&mut self, label: &str, command: Result<String, String>) -> String {
        let command = command.unwrap_or_else(|e| panic!("{label} must build a command: {e}"));
        self.connection
            .run_ok(label, &command)
            .await
            .unwrap_or_else(|e| panic!("{label} must run cleanly on the server: {e}"))
    }

    async fn sessions_result(&mut self) -> Result<Vec<SessionSummary>, String> {
        let opencode_bin = self.connection.settings().opencode_bin.clone();
        self.connection
            .run_ok("list sessions", &list_sessions_command(&opencode_bin))
            .await
            .map(|out| parse_sessions(&out))
    }

    fn cleanup(&self) {
        // Never kill a tmux server: if socket isolation is misconfigured that
        // would destroy unrelated user and agent sessions. Each test knows the
        // exact names it created, so cleanup is limited to those names.
        for key in &self.turn_keys {
            let _ = std::process::Command::new("tmux")
                .args(["kill-session", "-t", &format!("pabloagent-{key}")])
                .env("TMUX_TMPDIR", &self.tmux_tmpdir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = std::fs::remove_dir_all(&self.temp);
    }
}

// ---------------------------------------------------------------------------
// Host key and auth
// ---------------------------------------------------------------------------

async fn bare_server() -> (u16, String, Link) {
    let env: Env = Arc::new(HashMap::from([
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        (
            "HOME".into(),
            std::env::temp_dir()
                .join(format!("pabloagent-empty-home-{}", std::process::id()))
                .to_string_lossy()
                .into_owned(),
        ),
    ]));
    start_server(env).await
}

fn settings_for(port: u16, password: &str) -> SshSettings {
    SshSettings {
        host: "127.0.0.1".to_string(),
        port,
        username: USERNAME.to_string(),
        password: password.to_string(),
        codex_bin: "codex".to_string(),
        claude_bin: "claude".to_string(),
        opencode_bin: "opencode".to_string(),
        pi_bin: "pi".to_string(),
        default_cwd: "/tmp".to_string(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_host_key_is_rejected_and_surfaced() {
    let (port, fingerprint, _link) = bare_server().await;
    let (conn, outcome) = connect_full(settings_for(port, PASSWORD), None, Diagnostics::new())
        .await
        .expect("connect should not hard-error for an untrusted key");

    assert!(conn.is_none(), "no session may be established");
    match outcome {
        ConnectOutcome::HostKeyUnverified { prompt } => {
            assert_eq!(prompt.fingerprint, fingerprint);
            assert_eq!(prompt.algorithm, "ssh-ed25519");
            assert!(!prompt.mismatch, "first contact is not a mismatch");
            assert!(prompt.openssh.starts_with("ssh-ed25519 "));
        }
        other => panic!("expected HostKeyUnverified, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mismatched_host_key_is_flagged_as_a_mismatch() {
    let (port, fingerprint, _link) = bare_server().await;
    let stale = KnownHost {
        algorithm: "ssh-ed25519".to_string(),
        fingerprint: "SHA256:definitelyNotTheRightKey".to_string(),
        openssh: "ssh-ed25519 AAAA".to_string(),
    };

    let (conn, outcome) = connect_full(
        settings_for(port, PASSWORD),
        Some(stale),
        Diagnostics::new(),
    )
    .await
    .unwrap();

    assert!(conn.is_none());
    match outcome {
        ConnectOutcome::HostKeyUnverified { prompt } => {
            assert!(prompt.mismatch, "a changed key must be flagged");
            assert_eq!(prompt.fingerprint, fingerprint);
            assert_eq!(
                prompt.previous_fingerprint.as_deref(),
                Some("SHA256:definitelyNotTheRightKey")
            );
        }
        other => panic!("expected HostKeyUnverified, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_password_fails_with_a_useful_message() {
    let (port, fingerprint, _link) = bare_server().await;
    let known = KnownHost {
        algorithm: "ssh-ed25519".to_string(),
        fingerprint,
        openssh: String::new(),
    };

    // `Connection` is intentionally not Debug (it wraps live SSH state), so
    // unwrap the Result by hand rather than via expect_err.
    let err = match connect_full(settings_for(port, "wrong"), Some(known), Diagnostics::new()).await
    {
        Err(e) => e,
        Ok(_) => panic!("bad password must fail"),
    };
    assert!(
        err.contains("authentication failed"),
        "error should name the failure: {err}"
    );
    assert!(err.contains(USERNAME), "error should name the user: {err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_with_no_agent_cli_is_refused_with_an_explanation() {
    let (port, fingerprint, _link) = bare_server().await;
    let known = KnownHost {
        algorithm: "ssh-ed25519".to_string(),
        fingerprint,
        openssh: String::new(),
    };
    let mut settings = settings_for(port, PASSWORD);
    settings.codex_bin = "definitely-no-codex-anywhere".to_string();
    settings.claude_bin = "definitely-no-claude-anywhere".to_string();
    settings.opencode_bin = "definitely-no-opencode-anywhere".to_string();
    settings.pi_bin = "definitely-no-pi-anywhere".to_string();

    let err = match connect_full(settings, Some(known), Diagnostics::new()).await {
        Err(e) => e,
        Ok(_) => panic!("a host with no CLI has nothing to offer and must fail"),
    };
    assert!(
        err.contains("definitely-no-codex-anywhere")
            && err.contains("definitely-no-claude-anywhere")
            && err.contains("definitely-no-opencode-anywhere")
            && err.contains("definitely-no-pi-anywhere")
            && err.contains("codex exec")
            && err.contains("claude -p")
            && err.contains("opencode run")
            && err.contains("pi -a --mode json"),
        "the error must name every binary and say what they are for: {err}"
    );
}

// ---------------------------------------------------------------------------
// A whole turn, for real
// ---------------------------------------------------------------------------

const HOSTILE_PROMPT: &str =
    "fix 'quotes' and \"doubles\"; rm -rf / ; $(whoami) `id`\nsecond line\twith a tab";

struct Expected {
    harness: Harness,
    model: &'static str,
    effort: &'static str,
    marker: &'static str,
    path_fragment: &'static str,
    cli_version: Option<&'static str>,
    prompt_in_feed: bool,
}

const CODEX: Expected = Expected {
    harness: Harness::Codex,
    model: "gpt-5-codex",
    effort: "high",
    marker: "task_complete",
    path_fragment: "rollout-",
    cli_version: Some("0.145.0-stub"),
    prompt_in_feed: true,
};

const CLAUDE: Expected = Expected {
    harness: Harness::Claude,
    model: "sonnet",
    effort: "high",
    marker: "last-prompt",
    path_fragment: "/projects/",
    cli_version: Some("2.1.220-stub"),
    prompt_in_feed: true,
};

const OPENCODE: Expected = Expected {
    harness: Harness::Opencode,
    model: "opencode/big-pickle",
    effort: "high",
    marker: "step_finish",
    path_fragment: "pabloagent/opencode/",
    cli_version: Some("1.18.8-stub"),
    prompt_in_feed: false,
};

const PI: Expected = Expected {
    harness: Harness::Pi,
    model: "openai-codex/gpt-5.4-mini",
    effort: "high",
    marker: "done with",
    path_fragment: "/.pi/agent/sessions/",
    cli_version: None,
    prompt_in_feed: true,
};

async fn a_turn_runs_detached(name: &str, expected: Expected) {
    let Some(mut remote) = Remote::start(name).await else {
        return;
    };

    let started = remote
        .start_turn(
            "turnkey01",
            &TurnRequest {
                prompt: HOSTILE_PROMPT.to_string(),
                harness: expected.harness,
                thread_id: String::new(),
                cwd: remote.temp.display().to_string(),
                model: expected.model.to_string(),
                effort: expected.effort.to_string(),
                permission_mode: String::new(),
                // What the app does for a new claude session, and what codex
                // ignores because it names its own.
                session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d01".to_string(),
            },
        )
        .await;
    let started = match started {
        Ok(out) => out,
        Err(e) => {
            remote.cleanup();
            panic!("starting the turn failed: {e}");
        }
    };
    let host = started
        .lines()
        .find_map(|l| l.strip_prefix("PT_STARTED\t"))
        .unwrap_or("")
        .trim()
        .to_string();

    let (collected, last, saw_partial) = remote.follow("turnkey01").await;
    let sessions = remote.sessions().await;
    // What the app reads when the session is opened — for opencode the only
    // place the typed prompt can be found, since its live feed never carries it.
    let history = match &last.rollout_path {
        Some(path) => remote
            .read_history(expected.harness, path)
            .await
            // Folded in rather than unwrapped, so a failed read names itself in
            // whichever assertion it breaks instead of dying here half-explained.
            .unwrap_or_else(|e| format!("READ FAILED: {e}")),
        None => String::new(),
    };
    // Read before the host is torn down: codex's workspace trust is an entry in
    // this file, written by the turn itself, and nothing else on the wire can
    // show whether it happened. `codex_trust.rs` covers every shape of it; this
    // is the one assertion that the SSH-hosted turn does it at all.
    let codex_config =
        std::fs::read_to_string(remote.temp.join(".codex/config.toml")).unwrap_or_default();
    let workspace = std::fs::canonicalize(&remote.temp)
        .unwrap_or_else(|_| remote.temp.clone())
        .display()
        .to_string();
    remote.cleanup();

    if expected.harness == Harness::Codex {
        assert!(
            codex_config.contains(&format!(
                "[projects.\"{workspace}\"]\ntrust_level = \"trusted\""
            )),
            "a codex turn must trust the workspace it was pointed at before it \
             runs, or the workspace's own .codex/config.toml never loads: \
             {codex_config:?}"
        );
    } else {
        assert!(
            codex_config.is_empty(),
            "{:?} answers trust its own way and must not write codex's config: \
             {codex_config:?}",
            expected.harness
        );
    }

    assert!(
        host == "tmux" || host == "setsid",
        "a turn must report how it was hosted, got {host:?}"
    );
    if have("tmux") {
        assert_eq!(host, "tmux", "with tmux present it must be used");
    }
    assert_eq!(
        last.exit_code,
        Some(0),
        "the turn should finish cleanly; stderr was:\n{}",
        last.stderr
    );
    assert!(
        saw_partial,
        "session lines must arrive while the turn is still running, not only at the end"
    );
    assert!(
        last.rollout_path
            .as_deref()
            .is_some_and(|p| p.contains(expected.path_fragment)),
        "the session file must be discovered: {:?}",
        last.rollout_path
    );
    // The point of the base64 → file → stdin route: the prompt arrives whole.
    // opencode's live feed never carries the prompt, so for it the proof is the
    // history read — the same read the app does when the session is opened.
    let prompt_carrier = if expected.prompt_in_feed {
        &collected
    } else {
        &history
    };
    assert!(
        prompt_carrier.contains("rm -rf / ; $(whoami)"),
        "the prompt must reach the CLI verbatim; got:\n{prompt_carrier}"
    );
    assert!(
        collected.contains(expected.model) && collected.contains(expected.effort),
        "the model and effort overrides must reach the CLI: {collected}"
    );
    assert!(
        collected.contains(expected.marker),
        "the end of the turn must be in the live feed: {collected}"
    );

    // And the picker sees it, previewed by what the user *typed* rather than by
    // the injected context that shares the file with it.
    assert_eq!(sessions.len(), 1, "one session should have been created");
    let session = &sessions[0];
    assert_eq!(session.harness, expected.harness, "tagged with its CLI");
    assert!(
        session.preview.starts_with("fix 'quotes'"),
        "the preview must be the typed prompt, not injected context: {:?}",
        session.preview
    );
    assert!(!session.id.is_empty() && session.path.contains(&session.id));
    assert_eq!(session.cli_version.as_deref(), expected.cli_version);
    assert_eq!(session.cwd, remote.temp.display().to_string());
    assert!(session.modified_at.is_some());
    assert!(session.created_at_iso.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_codex_turn_runs_detached_and_its_rollout_streams_back_while_it_works() {
    a_turn_runs_detached("turn-codex", CODEX).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_turn_runs_detached_and_its_transcript_streams_back_while_it_works() {
    a_turn_runs_detached("turn-claude", CLAUDE).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_opencode_turn_runs_detached_and_its_events_stream_back_while_it_works() {
    a_turn_runs_detached("turn-opencode", OPENCODE).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pi_turn_runs_detached_and_its_session_streams_back_while_it_works() {
    a_turn_runs_detached("turn-pi", PI).await;
}

// ---------------------------------------------------------------------------
// A link that died while nobody was looking
// ---------------------------------------------------------------------------

async fn wait_until_dead(connection: &Connection) {
    for _ in 0..200 {
        if !connection.is_live() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the client never noticed the SSH session had gone");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_can_be_started_after_the_link_died_while_idle() {
    let Some(mut remote) = Remote::start("reconnect-start").await else {
        return;
    };

    // The link goes away with nothing in flight, exactly as it does while the
    // chat sits open and untouched.
    remote.link.cut();
    wait_until_dead(&remote.connection).await;

    let started = remote
        .start_turn(
            "turnkey-reconnect",
            &TurnRequest {
                prompt: "hello after the drop".to_string(),
                harness: Harness::Codex,
                thread_id: String::new(),
                cwd: remote.temp.display().to_string(),
                model: "gpt-5-codex".to_string(),
                effort: String::new(),
                permission_mode: String::new(),
                session_id: String::new(),
            },
        )
        .await;
    let started = match started {
        Ok(out) => out,
        Err(e) => {
            remote.cleanup();
            panic!("a dropped link must not fail the turn; got: {e}");
        }
    };

    let (collected, last, _) = remote.follow("turnkey-reconnect").await;
    let sessions = remote.sessions().await;
    remote.cleanup();

    assert!(
        started.contains("PT_STARTED"),
        "the turn must actually have been launched: {started}"
    );
    assert_eq!(
        last.exit_code,
        Some(0),
        "and run to completion; stderr was:\n{}",
        last.stderr
    );
    assert!(
        collected.contains("hello after the drop"),
        "the prompt must have survived the reconnect: {collected}"
    );
    assert_eq!(
        sessions.len(),
        1,
        "one prompt is one turn: the retry must not have started a second one"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reading_the_host_survives_the_link_dying_between_commands() {
    let Some(mut remote) = Remote::start("reconnect-read").await else {
        return;
    };

    // Something to find, so an empty list cannot pass for a working one.
    let request = TurnRequest {
        prompt: "before the drop".to_string(),
        harness: Harness::Claude,
        thread_id: String::new(),
        cwd: remote.temp.display().to_string(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d02".to_string(),
    };
    if let Err(e) = remote.start_turn("turnkey-read", &request).await {
        remote.cleanup();
        panic!("starting the turn failed: {e}");
    }
    remote.follow("turnkey-read").await;

    remote.link.cut();
    wait_until_dead(&remote.connection).await;

    let sessions = remote.sessions().await;
    // A second cut, to prove the rebuilt session is a real one that can itself
    // be replaced rather than a one-off.
    remote.link.cut();
    wait_until_dead(&remote.connection).await;
    let poll = remote.poll("turnkey-read", 1).await;
    let live = remote.connection.is_live();
    remote.cleanup();

    assert_eq!(
        sessions.len(),
        1,
        "the picker must still list the session after the link died"
    );
    assert!(
        sessions[0].preview.contains("before the drop"),
        "and read it properly, not partially: {:?}",
        sessions[0].preview
    );
    assert_eq!(
        poll.exit_code,
        Some(0),
        "the finished turn is still findable"
    );
    assert!(live, "the connection is usable again afterwards");
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnect_refreshes_host_capabilities() {
    let Some(mut remote) = Remote::start("reconnect-capabilities").await else {
        return;
    };
    assert_eq!(
        remote.connection.capabilities().codex_version.as_deref(),
        Some("codex-cli 0.145.0-stub")
    );

    let script = remote.temp.join("codex_stub.py");
    let source = std::fs::read_to_string(&script).unwrap();
    std::fs::write(
        &script,
        source.replace("codex-cli 0.145.0-stub", "codex-cli 0.146.0-stub"),
    )
    .unwrap();
    remote.link.cut();
    wait_until_dead(&remote.connection).await;

    let _ = remote.sessions().await;
    let refreshed = remote.connection.capabilities().codex_version.clone();
    remote.cleanup();
    assert_eq!(refreshed.as_deref(), Some("codex-cli 0.146.0-stub"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reconnect_refuses_a_host_key_that_changed() {
    let Some(mut remote) = Remote::start("reconnect-hostkey").await else {
        return;
    };

    // Same host, same port, different key from here on: what a rebuilt box — or
    // somebody in the middle — looks like to a client that reconnects.
    remote.link.change_host_key();
    remote.link.cut();
    wait_until_dead(&remote.connection).await;

    let err = match remote.sessions_result().await {
        Err(e) => e,
        Ok(rows) => {
            remote.cleanup();
            panic!(
                "a changed host key must not be accepted silently; got {} rows",
                rows.len()
            );
        }
    };
    remote.cleanup();

    assert!(
        err.contains("host key") && err.contains("Nothing was sent"),
        "the refusal must say what happened and that nothing was sent: {err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_without_an_exit_status_is_not_reported_as_successful() {
    let Some(mut remote) = Remote::start("missing-exit-status").await else {
        return;
    };

    let incomplete = remote
        .connection
        .run_ok("incomplete command", "pablo-test-no-exit-status")
        .await
        .expect_err("a missing exit status must not default to success");
    let after = remote
        .connection
        .run_ok("command after incomplete outcome", "printf usable")
        .await
        .expect("an incomplete channel must not poison the connection");
    remote.cleanup();

    assert!(
        incomplete.contains("ended without an exit status"),
        "the error must explain what confirmation is missing: {incomplete}"
    );
    assert_eq!(after, "usable");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_exec_returns_immediately_and_leaves_the_connection_usable() {
    let Some(mut remote) = Remote::start("exec-rejected").await else {
        return;
    };

    let rejected = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        remote
            .connection
            .run_ok("rejected command", "pablo-test-reject-exec"),
    )
    .await
    .expect("the SSH failure response must be handled immediately")
    .expect_err("the rejected command must not be reported as successful");
    let after = remote
        .connection
        .run_ok("command after rejection", "printf usable")
        .await
        .expect("a rejected channel must not poison the shared connection");
    remote.cleanup();

    assert!(
        rejected.contains("rejected the remote command request"),
        "the error must explain the server refusal: {rejected}"
    );
    assert_eq!(after, "usable");
}

#[tokio::test]
async fn a_stalled_exec_times_out_and_leaves_the_connection_usable() {
    let Some(mut remote) = Remote::start("exec-stalled").await else {
        return;
    };
    tokio::time::pause();

    let stalled = remote
        .connection
        .run_ok("stalled command", "pablo-test-stall-exec")
        .await
        .expect_err("an inactive command channel must time out");
    tokio::time::resume();
    let after = remote
        .connection
        .run_ok("command after timeout", "printf usable")
        .await
        .expect("a timed-out channel must not poison the shared connection");
    remote.cleanup();

    assert!(
        stalled.contains("no SSH channel activity for 60s"),
        "the error must identify the idle deadline: {stalled}"
    );
    assert_eq!(after, "usable");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_picker_lists_sessions_from_both_harnesses() {
    let Some(mut remote) = Remote::start("mixed").await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |harness, prompt: &str, session: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness,
        thread_id: String::new(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: session.to_string(),
    };

    for (key, harness, prompt, session) in [
        (
            "codexrun1",
            Harness::Codex,
            "a codex question",
            "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d02",
        ),
        (
            "clauderun1",
            Harness::Claude,
            "a claude question",
            "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d02",
        ),
        (
            "opencrun1",
            Harness::Opencode,
            "an opencode question",
            "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d02",
        ),
        // Its own id: a pi session is matched to turn records by id, and
        // sharing claude's would cross-wire the two rows.
        (
            "pirun0001",
            Harness::Pi,
            "a pi question",
            "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d09",
        ),
    ] {
        if let Err(e) = remote
            .start_turn(key, &request(harness, prompt, session))
            .await
        {
            remote.cleanup();
            panic!("{harness:?} turn failed to start: {e}");
        }
        remote.follow(key).await;
    }

    let sessions = remote.sessions().await;
    remote.cleanup();

    assert_eq!(sessions.len(), 4, "one session per harness: {sessions:?}");
    let claude = sessions
        .iter()
        .find(|s| s.harness == Harness::Claude)
        .expect("the claude session must be listed");
    let codex = sessions
        .iter()
        .find(|s| s.harness == Harness::Codex)
        .expect("the codex session must be listed");
    let opencode = sessions
        .iter()
        .find(|s| s.harness == Harness::Opencode)
        .expect("the opencode session must be listed");
    let pi = sessions
        .iter()
        .find(|s| s.harness == Harness::Pi)
        .expect("the pi session must be listed");
    assert_eq!(claude.preview, "a claude question");
    assert_eq!(codex.preview, "a codex question");
    // opencode's preview is the title a bare `--title` gave the new session.
    assert_eq!(opencode.preview, "an opencode question");
    assert_eq!(pi.preview, "a pi question");
    // A claude session directory holds a `tool-results` subdirectory of its own,
    // which must never be mistaken for another session.
    assert!(
        claude.path.ends_with(&format!("{}.jsonl", claude.id)),
        "a claude session is the file named after its id: {}",
        claude.path
    );
    assert!(
        opencode.path.ends_with(&format!("{}.jsonl", opencode.id))
            && opencode.id.starts_with("ses_"),
        "an opencode session is named after its own id: {}",
        opencode.path
    );
    assert!(
        pi.path.ends_with(&format!("_{}.jsonl", pi.id)),
        "a pi session file ends with its id, after the timestamp prefix: {}",
        pi.path
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn two_sessions_run_at_once_and_the_picker_tracks_both_without_turn_polls() {
    let Some(mut remote) = Remote::start("concurrent-status").await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |harness, session: &str| TurnRequest {
        prompt: "please sleep-forever now".to_string(),
        harness,
        thread_id: String::new(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: session.to_string(),
    };
    remote
        .start_turn(
            "parallelcodex01",
            &request(Harness::Codex, "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d21"),
        )
        .await
        .expect("the codex turn must start");
    remote
        .start_turn(
            "parallelclaude2",
            &request(Harness::Claude, "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d22"),
        )
        .await
        .expect("the claude turn must start");

    let mut running = Vec::new();
    for _ in 0..80 {
        running = remote.sessions().await;
        if running.len() == 2
            && running
                .iter()
                .all(|s| s.turn_state == TurnState::Running && s.turn_key.as_deref().is_some())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    for key in ["parallelcodex01", "parallelclaude2"] {
        let _ = remote
            .connection
            .run_ok("stop turn", &stop_turn_command(key))
            .await;
    }
    remote.cleanup();

    assert_eq!(
        running.len(),
        2,
        "both live sessions must be listed: {running:?}"
    );
    assert!(
        running.iter().any(|s| {
            s.harness == Harness::Codex
                && s.turn_key.as_deref() == Some("parallelcodex01")
                && s.turn_state == TurnState::Running
        }),
        "the codex row must carry its own spinner and turn key: {running:?}"
    );
    assert!(
        running.iter().any(|s| {
            s.harness == Harness::Claude
                && s.turn_key.as_deref() == Some("parallelclaude2")
                && s.turn_state == TurnState::Running
        }),
        "the claude row must carry its own spinner and turn key: {running:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_refuses_a_second_concurrent_turn() {
    let Some(mut remote) = Remote::start("same-session-lock").await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness: Harness::Codex,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d31".to_string(),
    };
    remote
        .start_turn("lockseed00000001", &request("create the session", ""))
        .await
        .expect("the seed turn must start");
    remote.follow("lockseed00000001").await;
    let thread = remote.sessions().await[0].id.clone();

    remote
        .start_turn(
            "lockowner0000002",
            &request("please sleep-forever now", &thread),
        )
        .await
        .expect("the first resumed turn must start");
    let refused = remote
        .start_turn("lockother0000003", &request("must not run", &thread))
        .await
        .expect_err("the same session must not accept another live writer");
    let _ = remote
        .connection
        .run_ok("stop turn", &stop_turn_command("lockowner0000002"))
        .await;
    remote.cleanup();

    assert!(
        refused.contains("already has a running turn"),
        "the refusal must identify the conflict: {refused}"
    );
}

async fn changing_a_session_is_refused_while_a_turn_writes_it(name: &str, harness: Harness) {
    let Some(mut remote) = Remote::start(name).await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d19".to_string(),
    };

    // A first turn, still running: no lock, so only the turn-directory scan can
    // see it. It hangs after writing its session, which is exactly the window a
    // delete would destroy work in.
    if let Err(e) = remote
        .start_turn("busynew001", &request("please sleep-forever now", ""))
        .await
    {
        remote.cleanup();
        panic!("the first turn failed to start: {e}");
    }
    let (thread, path) = match remote.session_once_written().await {
        Some(s) => (s.id.clone(), s.path.clone()),
        None => {
            remote.cleanup();
            panic!("the hanging first turn should still have created a session");
        }
    };
    let during_first = remote
        .run_guarded(
            "delete session",
            delete_session_command(harness, &path, &thread),
        )
        .await;

    let _ = remote
        .connection
        .run_ok("stop turn", &stop_turn_command("busynew001"))
        .await;

    // And now a resumed turn, which does hold the lock.
    if let Err(e) = remote
        .start_turn("busyowner1", &request("please sleep-forever now", &thread))
        .await
    {
        remote.cleanup();
        panic!("the resumed turn failed to start: {e}");
    }
    let total = std::fs::read_to_string(&path)
        .expect("the session file is on this disk")
        .lines()
        .count() as u64;

    let delete = remote
        .run_guarded(
            "delete session",
            delete_session_command(harness, &path, &thread),
        )
        .await;
    let rewind = remote
        .run_guarded(
            "rewind session",
            rewind_session_command(harness, &path, 1, total, &thread),
        )
        .await;
    let still_there = std::fs::read_to_string(&path).unwrap_or_default();
    let no_backup = !std::path::Path::new(&format!("{path}.rewind-bak")).exists();

    // With the turn stopped the very same delete goes through, which is what
    // proves the refusals above were the guard and not a broken command.
    let _ = remote
        .connection
        .run_ok("stop turn", &stop_turn_command("busyowner1"))
        .await;
    let after = remote
        .run_guarded(
            "delete session",
            delete_session_command(harness, &path, &thread),
        )
        .await;
    let deleted = !std::path::Path::new(&path).exists();
    remote.cleanup();

    assert_eq!(
        refused_because_busy(&during_first),
        Some("busynew001"),
        "a first turn holds no lock and must still be found: {during_first:?}"
    );
    assert_eq!(
        refused_because_busy(&delete),
        Some("busyowner1"),
        "the delete must name the turn in the way: {delete:?}"
    );
    assert_eq!(
        refused_because_busy(&rewind),
        Some("busyowner1"),
        "the rewind must be refused before it counts a line: {rewind:?}"
    );
    assert!(
        still_there.contains("sleep-forever"),
        "a refused operation must leave the session exactly as it was: {still_there}"
    );
    assert!(
        no_backup,
        "a refused rewind must not even write its .rewind-bak"
    );
    assert_eq!(
        refused_because_busy(&after),
        None,
        "nothing is in the way once the turn has stopped: {after:?}"
    );
    assert!(deleted, "and the session file must actually be gone");
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_a_codex_session_is_refused_while_a_turn_writes_it() {
    changing_a_session_is_refused_while_a_turn_writes_it("busy-codex", Harness::Codex).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_a_claude_session_is_refused_while_a_turn_writes_it() {
    changing_a_session_is_refused_while_a_turn_writes_it("busy-claude", Harness::Claude).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_a_pi_session_is_refused_while_a_turn_writes_it() {
    changing_a_session_is_refused_while_a_turn_writes_it("busy-pi", Harness::Pi).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_and_read_session_carries_its_sidecar_marks() {
    let Some(mut remote) = Remote::start("sidecar").await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = TurnRequest {
        prompt: "say hello".to_string(),
        harness: Harness::Claude,
        thread_id: String::new(),
        cwd,
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: "7a14e45f-ceea-467a-9d0f-2b0d0d0d0d20".to_string(),
    };
    if let Err(e) = remote.start_turn("sidecar001", &request).await {
        remote.cleanup();
        panic!("the turn failed to start: {e}");
    }
    let (thread, path) = match remote.session_once_written().await {
        Some(s) => (s.id.clone(), s.path.clone()),
        None => {
            remote.cleanup();
            panic!("the turn should have created a session");
        }
    };

    // Close and mark read — both must run cleanly even while the turn may
    // still be finishing, because neither touches the session file.
    let close = close_session_command(Harness::Claude, &thread)
        .expect("a uuid thread id builds a close command");
    let read = mark_session_read_command(Harness::Claude, &thread, 1_785_300_100)
        .expect("a uuid thread id builds a read-mark command");
    if let Err(e) = remote.connection.run_ok("close session", &close).await {
        remote.cleanup();
        panic!("closing must run cleanly on the server: {e}");
    }
    if let Err(e) = remote.connection.run_ok("mark read", &read).await {
        remote.cleanup();
        panic!("marking read must run cleanly on the server: {e}");
    }

    // The server env pins XDG_CACHE_HOME to <temp>/cache — see Remote::start.
    let meta_dir = remote
        .temp
        .join("cache/pabloagent/session-meta")
        .join(format!("claude-{thread}"));
    let first_close = std::fs::read_to_string(meta_dir.join("closed")).unwrap_or_default();
    // A second close must not move the timestamp — the flag is one-way and
    // the write is `[ -e ] ||`, so there is nothing for a repeat to change.
    let _ = remote
        .connection
        .run_ok("close session again", &close)
        .await;
    let second_close = std::fs::read_to_string(meta_dir.join("closed")).unwrap_or_default();
    // An older read mark must not move the shared one backwards.
    let stale = mark_session_read_command(Harness::Claude, &thread, 5).unwrap();
    let _ = remote.connection.run_ok("stale read mark", &stale).await;
    let read_value = std::fs::read_to_string(meta_dir.join("read")).unwrap_or_default();

    let listed = remote.sessions().await.into_iter().find(|s| s.id == thread);

    // Deleting the session takes its record with it. The turn is stopped
    // first so the busy guard is not what this asserts.
    let _ = remote
        .connection
        .run_ok("stop turn", &stop_turn_command("sidecar001"))
        .await;
    let delete = remote
        .run_guarded(
            "delete session",
            delete_session_command(Harness::Claude, &path, &thread),
        )
        .await;
    let record_gone = !meta_dir.exists();
    remote.cleanup();

    assert!(
        !first_close.trim().is_empty(),
        "the close must write a timestamp"
    );
    assert_eq!(
        first_close, second_close,
        "a repeated close must not move the timestamp"
    );
    assert_eq!(
        read_value.trim(),
        "1785300100",
        "an older mark must not move the shared one backwards"
    );
    let listed = listed.expect("the closed session is still listed");
    assert_eq!(
        listed.closed_at,
        first_close.trim().parse::<i64>().ok(),
        "the pill's timestamp is the record's"
    );
    assert_eq!(listed.read_at, Some(1_785_300_100));
    assert!(
        refused_because_busy(&delete).is_none(),
        "the stopped turn must not refuse the delete: {delete}"
    );
    assert!(record_gone, "the record goes with its session");
}

async fn a_row_reports_the_state_of_its_last_turn(name: &str, harness: Harness) {
    let Some(mut remote) = Remote::start(name).await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str, session: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: session.to_string(),
    };

    // 1. A turn watched to its end.
    if let Err(e) = remote
        .start_turn(
            "statusa01",
            &request(
                "a first question",
                "",
                "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d04",
            ),
        )
        .await
    {
        remote.cleanup();
        panic!("the first turn failed to start: {e}");
    }
    remote.follow("statusa01").await;
    let finished = remote.sessions().await;

    // 2. A turn still going, on that same session.
    let thread = finished.first().map(|s| s.id.clone()).unwrap_or_default();
    if let Err(e) = remote
        .start_turn(
            "statusb02",
            &request("please sleep-forever now", &thread, ""),
        )
        .await
    {
        remote.cleanup();
        panic!("the long turn failed to start: {e}");
    }
    // Polled until it has actually got going: `start` returns as soon as the
    // turn is launched, and a record with no rollout path yet cannot be matched
    // to a codex session.
    let mut running = Vec::new();
    for _ in 0..100 {
        let poll = remote.poll("statusb02", 1).await;
        if poll.running && poll.rollout_path.is_some() {
            running = remote.sessions().await;
            if running.iter().any(|s| s.turn_state == TurnState::Running) {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }

    // 3. Stopped part way through.
    let _ = remote
        .connection
        .run_ok("stop turn", &stop_turn_command("statusb02"))
        .await;
    let stopped = remote.sessions().await;
    remote.cleanup();

    assert_eq!(finished.len(), 1, "one session so far: {finished:?}");
    assert_eq!(
        finished[0].turn_state,
        TurnState::Succeeded,
        "a turn that exited zero must read as succeeded: {:?}",
        finished[0]
    );
    assert!(
        finished[0].turn_at.is_some_and(|at| at > 0),
        "a finished turn must be timestamped, or nothing can be marked read: {:?}",
        finished[0]
    );
    assert_eq!(finished[0].turn_exit_code, Some(0));

    assert_eq!(
        running.first().map(|s| s.turn_state),
        Some(TurnState::Running),
        "a turn still going must read as running: {running:?}"
    );
    assert_eq!(
        running[0].turn_exit_code, None,
        "a running turn has no exit status yet"
    );

    assert_eq!(
        stopped.first().map(|s| s.turn_state),
        Some(TurnState::Failed),
        "a stopped turn must read as failed, not stay a spinner forever: {stopped:?}"
    );
    assert_eq!(
        stopped[0].id, finished[0].id,
        "all three states are the same session"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_codex_row_reports_the_state_of_its_last_turn() {
    a_row_reports_the_state_of_its_last_turn("status-codex", Harness::Codex).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_row_reports_the_state_of_its_last_turn() {
    a_row_reports_the_state_of_its_last_turn("status-claude", Harness::Claude).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_opencode_row_reports_the_state_of_its_last_turn() {
    a_row_reports_the_state_of_its_last_turn("status-opencode", Harness::Opencode).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pi_row_reports_the_state_of_its_last_turn() {
    a_row_reports_the_state_of_its_last_turn("status-pi", Harness::Pi).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_this_app_never_ran_has_no_turn_state() {
    let Some(mut remote) = Remote::start("status-foreign").await else {
        return;
    };
    // A rollout written by something other than this app: no turn directory
    // names it, and the one turn record that does exist is for another session.
    let foreign = remote
        .temp
        .join(".codex")
        .join("sessions")
        .join("rollout-2026-07-29T09-00-00-00000000-0000-4000-8000-0000000000ff.jsonl");
    std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    std::fs::write(
        &foreign,
        concat!(
            r#"{"timestamp":"2026-07-29T09:00:00.000Z","type":"session_meta","payload":{"id":"00000000-0000-4000-8000-0000000000ff","cwd":"/elsewhere","cli_version":"0.145.0"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"ran from a laptop"}}"#,
            "\n",
        ),
    )
    .unwrap();

    let cwd = remote.temp.display().to_string();
    if let Err(e) = remote
        .start_turn(
            "foreign001",
            &TurnRequest {
                prompt: "a question from the app".to_string(),
                harness: Harness::Codex,
                thread_id: String::new(),
                cwd,
                model: String::new(),
                effort: String::new(),
                permission_mode: String::new(),
                session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d05".to_string(),
            },
        )
        .await
    {
        remote.cleanup();
        panic!("the turn failed to start: {e}");
    }
    remote.follow("foreign001").await;
    let sessions = remote.sessions().await;
    remote.cleanup();

    let outsider = sessions
        .iter()
        .find(|s| s.id == "00000000-0000-4000-8000-0000000000ff")
        .expect("a session written by something else must still be listed");
    assert_eq!(
        outsider.turn_state,
        TurnState::Unknown,
        "no turn record names it, so it has no status: {outsider:?}"
    );
    assert_eq!(outsider.turn_at, None);
    assert!(
        sessions
            .iter()
            .any(|s| s.turn_state == TurnState::Succeeded),
        "and the session the app did run keeps its own status: {sessions:?}"
    );
}

async fn resuming_appends_to_the_same_session(name: &str, harness: Harness) {
    let Some(mut remote) = Remote::start(name).await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        // A new session needs one; a resumed turn must ignore it and use the
        // thread it was given, or it would fork the conversation in two.
        session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d03".to_string(),
    };

    if let Err(e) = remote
        .start_turn("first0001", &request("first prompt", ""))
        .await
    {
        remote.cleanup();
        panic!("first turn failed to start: {e}");
    }
    let (first_text, _, _) = remote.follow("first0001").await;
    let sessions = remote.sessions().await;
    assert_eq!(
        sessions.len(),
        1,
        "the first turn should create one session"
    );
    let thread = sessions[0].id.clone();
    let path = sessions[0].path.clone();
    let first_lines = first_text.lines().count();

    if let Err(e) = remote
        .start_turn("second002", &request("second prompt", &thread))
        .await
    {
        remote.cleanup();
        panic!("resumed turn failed to start: {e}");
    }
    let (second_text, _, _) = remote.follow("second002").await;
    let second_lines = second_text.lines().count();

    // A turn that would run for ten minutes, stopped part way through.
    if let Err(e) = remote
        .start_turn("third0003", &request("please sleep-forever now", &thread))
        .await
    {
        remote.cleanup();
        panic!("third turn failed to start: {e}");
    }
    let mut stopped: Option<TurnPoll> = None;
    for _ in 0..100 {
        let poll = remote.poll("third0003", 1).await;
        if poll.running && poll.line_count > second_lines as u64 {
            let _ = remote
                .connection
                .run_ok("stop turn", &stop_turn_command("third0003"))
                .await;
            stopped = Some(remote.poll("third0003", 1).await);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }

    let after_all = remote.sessions().await;
    let tmux_exited = !std::process::Command::new("tmux")
        .args(["has-session", "-t", "pabloagent-third0003"])
        .env("TMUX_TMPDIR", &remote.tmux_tmpdir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let claude_was_interrupted = harness != Harness::Claude
        || std::path::Path::new(path.trim_end_matches(".jsonl"))
            .join("interrupted")
            .is_file();
    remote.cleanup();

    assert!(
        first_lines > 4,
        "the first turn should have written a session file, got {first_lines} lines"
    );
    assert!(
        second_text.lines().count() > first_lines,
        "resuming must append to the same file: had {first_lines} lines, now {}",
        second_text.lines().count()
    );
    assert!(
        second_text.contains("first prompt") && second_text.contains("second prompt"),
        "both turns must be in the one file"
    );
    assert_eq!(
        after_all.len(),
        1,
        "resuming must not create a second session, got {:?}",
        after_all.iter().map(|s| &s.path).collect::<Vec<_>>()
    );
    assert_eq!(after_all[0].path, path, "the session path must be stable");
    assert!(
        after_all[0].preview.starts_with("first prompt"),
        "the preview stays the session's first prompt: {:?}",
        after_all[0].preview
    );
    let stopped = stopped.expect("the long turn should have been caught running and stopped");
    assert!(
        !stopped.running && stopped.exit_code.is_some(),
        "stopping must end the turn and record a status, got {stopped:?}"
    );
    assert!(
        claude_was_interrupted,
        "stopping Claude must signal its documented interrupt and let tmux exit"
    );
    assert!(tmux_exited, "a successful stop must wait for tmux to exit");
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_a_codex_session_appends_to_it_and_a_turn_can_be_stopped() {
    resuming_appends_to_the_same_session("resume-codex", Harness::Codex).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_a_claude_session_appends_to_it_and_a_turn_can_be_stopped() {
    resuming_appends_to_the_same_session("resume-claude", Harness::Claude).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_a_pi_session_appends_to_it_and_a_turn_can_be_stopped() {
    resuming_appends_to_the_same_session("resume-pi", Harness::Pi).await;
}

async fn rewinding_cuts_the_session_and_a_resume_continues_from_the_cut(
    name: &str,
    harness: Harness,
) {
    let Some(mut remote) = Remote::start(name).await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: "8f14e45f-ceea-467a-9d0f-2b0d0d0d0d07".to_string(),
    };

    if let Err(e) = remote
        .start_turn("rwfirst01", &request("first prompt", ""))
        .await
    {
        remote.cleanup();
        panic!("first turn failed to start: {e}");
    }
    let _ = remote.follow("rwfirst01").await;
    let sessions = remote.sessions().await;
    assert_eq!(
        sessions.len(),
        1,
        "the first turn should create one session"
    );
    let thread = sessions[0].id.clone();
    let path = sessions[0].path.clone();

    if let Err(e) = remote
        .start_turn("rwsecond2", &request("second prompt", &thread))
        .await
    {
        remote.cleanup();
        panic!("resumed turn failed to start: {e}");
    }
    let _ = remote.follow("rwsecond2").await;

    // The cut point the app would use: the index of the second prompt's own
    // line, which is exactly how many lines come before it. The fake server
    // executes on this machine, so the file can be read directly.
    let text = std::fs::read_to_string(&path).expect("the session file is on this disk");
    let total = text.lines().count() as u64;
    let keep = text
        .lines()
        .position(|line| line.contains("second prompt"))
        .expect("the second prompt must be in the file") as u64;

    // A count that no longer matches what the app read is refused outright.
    let stale = rewind_session_command(harness, &path, keep, total + 5, &thread).unwrap();
    let refused = remote.connection.run_ok("rewind session", &stale).await;

    let command = rewind_session_command(harness, &path, keep, total, &thread).unwrap();
    let cut = remote.connection.run_ok("rewind session", &command).await;

    let after_text = std::fs::read_to_string(&path).unwrap_or_default();
    let bak = std::fs::read_to_string(format!("{path}.rewind-bak")).unwrap_or_default();
    let rows = remote.sessions().await;

    let third = remote
        .start_turn("rwthird003", &request("third prompt", &thread))
        .await;
    let (final_text, _, _) = remote.follow("rwthird003").await;
    remote.cleanup();

    assert!(
        refused.is_err(),
        "a mismatched line count must refuse the cut: {refused:?}"
    );
    assert!(
        after_text.contains("first prompt"),
        "the refusal must leave the file alone and the cut must keep the head: {after_text}"
    );
    cut.expect("the rewind must run");
    assert_eq!(
        after_text.lines().count() as u64,
        keep,
        "the file must be cut to exactly the lines before the prompt"
    );
    assert!(
        !after_text.contains("second prompt"),
        "the cut prompt must be gone from the session file"
    );
    assert!(
        bak.contains("second prompt"),
        "the removed tail must survive once over as .rewind-bak"
    );
    assert_eq!(
        rows.len(),
        1,
        "the .rewind-bak file must not appear in the picker: {:?}",
        rows.iter().map(|s| &s.path).collect::<Vec<_>>()
    );
    third.expect("a turn must still resume from the cut file");
    assert!(
        final_text.contains("first prompt") && final_text.contains("third prompt"),
        "the resumed session must hold the kept turn and the new one"
    );
    assert!(
        !final_text.contains("second prompt"),
        "the resumed session must have forgotten the cut turn"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rewinding_a_codex_session_cuts_it_and_a_resume_continues_from_the_cut() {
    rewinding_cuts_the_session_and_a_resume_continues_from_the_cut("rewind-codex", Harness::Codex)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn rewinding_a_claude_session_cuts_it_and_a_resume_continues_from_the_cut() {
    rewinding_cuts_the_session_and_a_resume_continues_from_the_cut(
        "rewind-claude",
        Harness::Claude,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn rewinding_a_pi_session_cuts_it_and_a_resume_continues_from_the_cut() {
    rewinding_cuts_the_session_and_a_resume_continues_from_the_cut("rewind-pi", Harness::Pi).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_an_opencode_session_accumulates_in_its_database() {
    let Some(mut remote) = Remote::start("resume-opencode").await else {
        return;
    };
    let cwd = remote.temp.display().to_string();
    let request = |prompt: &str, thread: &str| TurnRequest {
        prompt: prompt.to_string(),
        harness: Harness::Opencode,
        thread_id: thread.to_string(),
        cwd: cwd.clone(),
        model: String::new(),
        effort: String::new(),
        permission_mode: String::new(),
        session_id: String::new(),
    };

    if let Err(e) = remote
        .start_turn("ocfirst01", &request("first prompt", ""))
        .await
    {
        remote.cleanup();
        panic!("first turn failed to start: {e}");
    }
    remote.follow("ocfirst01").await;
    let after_first = remote.sessions().await;
    let (thread, path) = match after_first.first() {
        Some(s) => (s.id.clone(), s.path.clone()),
        None => {
            remote.cleanup();
            panic!("the first turn should have created a session");
        }
    };

    if let Err(e) = remote
        .start_turn("ocsecond2", &request("second prompt", &thread))
        .await
    {
        remote.cleanup();
        panic!("resumed turn failed to start: {e}");
    }
    remote.follow("ocsecond2").await;

    let after_all = remote.sessions().await;
    let history = remote.read_history(Harness::Opencode, &path).await;
    remote.cleanup();

    assert_eq!(
        after_all.len(),
        1,
        "resuming must not create a second session, got {:?}",
        after_all.iter().map(|s| &s.path).collect::<Vec<_>>()
    );
    assert_eq!(after_all[0].path, path, "the session path must be stable");
    assert!(
        after_all[0].preview.starts_with("first prompt"),
        "the preview stays the title the first prompt gave the session: {:?}",
        after_all[0].preview
    );
    let history = history.expect("history must be readable");
    let first = history.find("first prompt");
    let second = history.find("second prompt");
    assert!(
        first.is_some() && second.is_some() && first < second,
        "both turns must come back from the database, in order:\n{history}"
    );
    // Every line of that history must parse — it is what the frontend reader
    // gets, and a half-rendered line would be silently dropped there.
    assert!(
        history
            .lines()
            .filter(|l| !l.trim().is_empty())
            .all(|l| { serde_json::from_str::<serde_json::Value>(l).is_ok() }),
        "the rendered history must be whole JSONL lines:\n{history}"
    );
}

// ---------------------------------------------------------------------------
// Downloading a file whole
// ---------------------------------------------------------------------------

fn awkward_payload(size: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(b"PT_BYTES\t999999\nnot the real header\r\n\r\0\x1a");
    let mut n: u8 = 0;
    while bytes.len() < size {
        bytes.push(n);
        n = n.wrapping_add(1);
    }
    bytes.truncate(size);
    bytes
}

#[tokio::test(flavor = "multi_thread")]
async fn a_binary_file_downloads_byte_for_byte_over_the_exec_channel() {
    let Some(mut remote) = Remote::start("download").await else {
        return;
    };

    // Big enough to arrive as hundreds of separate chunks, so the header parser
    // and the writer are both exercised across real boundaries.
    let payload = awkward_payload(5 * 1024 * 1024 + 7);
    let source = remote.temp.join("app-release.apk");
    std::fs::write(&source, &payload).unwrap();
    let dest = remote.temp.join("downloaded.apk");

    let progress = Progress::default();
    assert!(progress.begin());
    let command = download_remote_file_command(&source.display().to_string()).unwrap();
    let mut sink = Download::create(dest.clone(), &progress).unwrap();
    let outcome = remote
        .connection
        .run_streamed("download", &command, &mut sink)
        .await;

    let out = match outcome {
        Ok(out) => out,
        Err(e) => {
            remote.cleanup();
            panic!("the download failed: {e}");
        }
    };
    let header = sink.header().cloned();
    let written = sink.written();
    let report = progress.report();
    sink.finish().unwrap();
    let landed = std::fs::read(&dest).unwrap();
    remote.cleanup();

    assert_eq!(out.exit_code, Some(0), "stderr said: {}", out.stderr);
    assert_eq!(
        header,
        Some(Header::Bytes(payload.len() as u64)),
        "the size is announced before the bytes"
    );
    assert_eq!(written as usize, payload.len());
    assert_eq!(
        report.total as usize,
        payload.len(),
        "the bar knows the size"
    );
    assert_eq!(report.received as usize, payload.len());
    assert!(
        landed == payload,
        "the copy must be identical: {} bytes landed of {}",
        landed.len(),
        payload.len()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_file_is_formatted_into_a_temp_file_on_the_server() {
    if !have("jq") {
        eprintln!("SKIPPED: this test needs jq, which is what does the formatting");
        return;
    }
    let Some(mut remote) = Remote::start("pretty").await else {
        return;
    };

    let source = remote.temp.join("rollout-two.jsonl");
    std::fs::write(
        &source,
        "{\"type\":\"user\",\"text\":\"hi\"}\n{\"type\":\"assistant\",\"text\":\"hello\"}\n",
    )
    .unwrap();

    let command = pretty_session_command(&source.display().to_string()).unwrap();
    let output = remote.connection.run_ok("pretty session", &command).await;

    let output = match output {
        Ok(out) => out,
        Err(e) => {
            remote.cleanup();
            panic!("formatting must run cleanly on the server: {e}");
        }
    };
    let parsed = parse_pretty_session(&output, &source.display().to_string());
    remote.cleanup();

    let (pretty, size) = parsed.expect("the server must name the copy it wrote");
    let text = std::fs::read_to_string(&pretty).expect("the copy must be on disk");
    let _ = std::fs::remove_dir_all(std::path::Path::new(&pretty).parent().unwrap());

    assert_ne!(
        pretty,
        source.display().to_string(),
        "the original is left alone"
    );
    assert_eq!(size as usize, text.len(), "the size describes the copy");
    assert!(
        text.contains("\"type\": \"user\""),
        "every object is laid out: {text}"
    );
    assert!(
        text.lines().count() > 4,
        "two minified lines become many: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn downloading_something_that_is_not_a_file_says_so_and_writes_nothing() {
    let Some(mut remote) = Remote::start("download-notfile").await else {
        return;
    };

    let dest = remote.temp.join("nope.bin");
    let progress = Progress::default();
    let command = download_remote_file_command(&remote.temp.display().to_string()).unwrap();
    let mut sink = Download::create(dest.clone(), &progress).unwrap();
    let out = remote
        .connection
        .run_streamed("download", &command, &mut sink)
        .await;
    let header = sink.header().cloned();
    let written = sink.written();
    sink.discard();
    let exists = dest.exists();
    remote.cleanup();

    assert_eq!(
        out.map(|o| o.exit_code),
        Ok(Some(0)),
        "a refusal is an answer"
    );
    assert_eq!(header, Some(Header::NotAFile));
    assert_eq!(written, 0);
    assert!(!exists, "nothing may be left in the cache");
}
