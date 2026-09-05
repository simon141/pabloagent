use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

use crate::store::NewChatDefaults;

pub const SCRIPT: &str = include_str!("turn.sh");

const SESSION_LIMIT: usize = 60;

const TURN_LIMIT: usize = 80;

pub const SESSION_READ_BYTE_CAP: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    #[default]
    Codex,
    Claude,
    Opencode,
    Pi,
}

impl Harness {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
        }
    }

    fn from_tag(tag: &str) -> Self {
        match tag.trim() {
            "claude" => Self::Claude,
            "opencode" => Self::Opencode,
            "pi" => Self::Pi,
            _ => Self::Codex,
        }
    }
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn turn_dir(key: &str) -> String {
    format!("\"${{XDG_CACHE_HOME:-$HOME/.cache}}/pabloagent/turns/{key}\"")
}

fn write_file(path_expr: &str, contents: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(contents.as_bytes());
    format!("printf %s {} | base64 -d >{path_expr}\n", quote(&encoded))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    pub codex_version: Option<String>,
    pub claude_version: Option<String>,
    #[serde(default)]
    pub opencode_version: Option<String>,
    pub tmux: bool,
    pub sessions_dir: String,
    pub sessions_dir_exists: bool,
    pub projects_dir: String,
    pub projects_dir_exists: bool,
    #[serde(default)]
    pub opencode_db: String,
    #[serde(default)]
    pub opencode_db_exists: bool,
    #[serde(default)]
    pub pi_version: Option<String>,
    #[serde(default)]
    pub pi_sessions_dir: String,
    #[serde(default)]
    pub pi_sessions_dir_exists: bool,
}

impl HostCapabilities {
    pub fn any_harness(&self) -> bool {
        self.codex_version.is_some()
            || self.claude_version.is_some()
            || self.opencode_version.is_some()
            || self.pi_version.is_some()
    }
}

pub fn probe_command(
    codex_bin: &str,
    claude_bin: &str,
    opencode_bin: &str,
    pi_bin: &str,
) -> String {
    let codex = quote(codex_bin);
    let claude = quote(claude_bin);
    let opencode = quote(opencode_bin);
    let pi = quote(pi_bin);
    format!(
        "d=\"${{CODEX_HOME:-$HOME/.codex}}/sessions\"\n\
         printf 'PT_SESSIONS\\t%s\\n' \"$d\"\n\
         [ -d \"$d\" ] && echo PT_SESSIONS_DIR_OK || echo PT_SESSIONS_DIR_MISSING\n\
         p=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\"\n\
         printf 'PT_PROJECTS\\t%s\\n' \"$p\"\n\
         [ -d \"$p\" ] && echo PT_PROJECTS_DIR_OK || echo PT_PROJECTS_DIR_MISSING\n\
         o=\"${{OPENCODE_DB:-${{XDG_DATA_HOME:-$HOME/.local/share}}/opencode/opencode.db}}\"\n\
         printf 'PT_OPENCODE_DB\\t%s\\n' \"$o\"\n\
         [ -f \"$o\" ] && echo PT_OPENCODE_DB_OK || echo PT_OPENCODE_DB_MISSING\n\
         q=\"${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions\"\n\
         printf 'PT_PI_SESSIONS\\t%s\\n' \"$q\"\n\
         [ -d \"$q\" ] && echo PT_PI_SESSIONS_DIR_OK || echo PT_PI_SESSIONS_DIR_MISSING\n\
         command -v tmux >/dev/null 2>&1 && echo PT_TMUX_OK || echo PT_TMUX_MISSING\n\
         v=$(bash -lc 'exec \"$0\" --version' {codex} | head -n 1) && \
         [ -n \"$v\" ] && printf 'PT_CODEX\\t%s\\n' \"$v\" || echo PT_CODEX_MISSING\n\
         v=$(bash -lc 'exec \"$0\" --version' {claude} | head -n 1) && \
         [ -n \"$v\" ] && printf 'PT_CLAUDE\\t%s\\n' \"$v\" || echo PT_CLAUDE_MISSING\n\
         v=$(bash -lc 'exec \"$0\" --version' {opencode} | head -n 1) && \
         [ -n \"$v\" ] && printf 'PT_OPENCODE\\t%s\\n' \"$v\" || echo PT_OPENCODE_MISSING\n\
         v=$(bash -lc 'p=$(command -v \"$0\" 2>/dev/null || echo \"$0\"); \
         if [ -x /usr/bin/node ] && head -c 64 \"$p\" 2>/dev/null | grep -q \"^#!.*node\"; then \
         exec /usr/bin/node \"$p\" --version; else exec \"$p\" --version; fi' {pi} | head -n 1) && \
         [ -n \"$v\" ] && printf 'PT_PI\\t%s\\n' \"$v\" || echo PT_PI_MISSING\n"
    )
}

pub fn parse_probe(output: &str) -> HostCapabilities {
    let mut caps = HostCapabilities::default();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("PT_SESSIONS\t") {
            caps.sessions_dir = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("PT_PROJECTS\t") {
            caps.projects_dir = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("PT_OPENCODE_DB\t") {
            caps.opencode_db = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("PT_PI_SESSIONS\t") {
            caps.pi_sessions_dir = rest.trim().to_string();
        } else if line.trim() == "PT_SESSIONS_DIR_OK" {
            caps.sessions_dir_exists = true;
        } else if line.trim() == "PT_PROJECTS_DIR_OK" {
            caps.projects_dir_exists = true;
        } else if line.trim() == "PT_OPENCODE_DB_OK" {
            caps.opencode_db_exists = true;
        } else if line.trim() == "PT_PI_SESSIONS_DIR_OK" {
            caps.pi_sessions_dir_exists = true;
        } else if line.trim() == "PT_TMUX_OK" {
            caps.tmux = true;
        } else if let Some(rest) = line.strip_prefix("PT_CODEX\t") {
            caps.codex_version = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("PT_CLAUDE\t") {
            caps.claude_version = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("PT_OPENCODE\t") {
            caps.opencode_version = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("PT_PI\t") {
            caps.pi_version = Some(rest.trim().to_string());
        }
    }
    caps
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub memory: Option<UsageStats>,
    pub cpu: Option<f64>,
    pub cores: Vec<f64>,
    pub disk: Option<UsageStats>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub used_kb: u64,
    pub total_kb: u64,
}

pub fn host_stats_command() -> String {
    "if [ -r /proc/stat ]; then awk '/^cpu/ {print \"PT_CPU_A\\t\" $0}' /proc/stat; fi\n\
     sleep 0.3 2>/dev/null || sleep 1\n\
     if [ -r /proc/stat ]; then awk '/^cpu/ {print \"PT_CPU_B\\t\" $0}' /proc/stat; fi\n\
     if [ -r /proc/meminfo ]; then \
     awk '/^(MemTotal|MemAvailable|MemFree|Buffers|Cached):/ {print \"PT_MEM\\t\" $1 \"\\t\" $2}' \
     /proc/meminfo; fi\n\
     df -kP / 2>/dev/null | awk 'NR==2 {print \"PT_DISK\\t\" $3 \"\\t\" $2}'\n"
        .to_string()
}

fn cpu_busy_total(fields: &[&str]) -> Option<(u64, u64)> {
    let values: Vec<u64> = fields
        .iter()
        .filter_map(|f| f.parse::<u64>().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    let total: u64 = values.iter().sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total.saturating_sub(idle), total))
}

fn busy_percent(before: (u64, u64), after: (u64, u64)) -> Option<f64> {
    let elapsed = after.1.saturating_sub(before.1);
    if elapsed == 0 {
        return None;
    }
    let busy = after.0.saturating_sub(before.0) as f64;
    let percent = (busy * 100.0 / elapsed as f64).clamp(0.0, 100.0);
    Some((percent * 10.0).round() / 10.0)
}

pub fn parse_host_stats(output: &str) -> HostStats {
    let mut stats = HostStats::default();
    let mut before: Vec<(&str, (u64, u64))> = Vec::new();
    let mut after: Vec<(&str, (u64, u64))> = Vec::new();
    let mut mem_total_kb = None;
    let mut available_kb = None;
    let mut free_kb = 0u64;
    let mut buffers_kb = 0u64;
    let mut cached_kb = 0u64;
    let mut have_reclaimable = false;

    for line in output.lines() {
        let mut fields = line.split('\t');
        let marker = fields.next().map(str::trim);
        match marker {
            Some("PT_CPU_A") | Some("PT_CPU_B") => {
                let row: Vec<&str> = fields.next().unwrap_or("").split_whitespace().collect();
                let Some((name, times)) = row
                    .split_first()
                    .and_then(|(name, rest)| cpu_busy_total(rest).map(|t| (*name, t)))
                else {
                    continue;
                };
                if marker == Some("PT_CPU_A") {
                    before.push((name, times));
                } else {
                    after.push((name, times));
                }
            }
            Some("PT_MEM") => {
                let key = fields.next().unwrap_or("").trim_end_matches(':');
                let Some(value) = fields.next().and_then(|v| v.trim().parse::<u64>().ok()) else {
                    continue;
                };
                match key {
                    "MemTotal" => mem_total_kb = Some(value),
                    "MemAvailable" => available_kb = Some(value),
                    "MemFree" => {
                        free_kb = value;
                        have_reclaimable = true;
                    }
                    "Buffers" => buffers_kb = value,
                    "Cached" => cached_kb = value,
                    _ => {}
                }
            }
            Some("PT_DISK") => {
                let used = fields.next().and_then(|v| v.trim().parse::<u64>().ok());
                let total = fields.next().and_then(|v| v.trim().parse::<u64>().ok());
                if let (Some(used_kb), Some(total_kb)) = (used, total) {
                    if total_kb > 0 {
                        stats.disk = Some(UsageStats { used_kb, total_kb });
                    }
                }
            }
            _ => {}
        }
    }

    for (name, first) in &before {
        let Some((_, second)) = after.iter().find(|(other, _)| other == name) else {
            continue;
        };
        let Some(percent) = busy_percent(*first, *second) else {
            continue;
        };
        if *name == "cpu" {
            stats.cpu = Some(percent);
        } else {
            stats.cores.push(percent);
        }
    }

    // `MemAvailable` is the kernel's own answer and the only honest one, because
    // not all of the page cache can actually be handed back. Older kernels do not
    // publish it, and there the classic free+buffers+cached is closer to the
    // truth than free alone, which would report a healthy host as nearly full.
    if let Some(total) = mem_total_kb.filter(|t| *t > 0) {
        let unused = match available_kb {
            Some(available) => Some(available),
            None if have_reclaimable => Some(free_kb + buffers_kb + cached_kb),
            None => None,
        };
        if let Some(unused) = unused {
            stats.memory = Some(UsageStats {
                used_kb: total.saturating_sub(unused.min(total)),
                total_kb: total,
            });
        }
    }

    stats
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModel {
    pub id: String,
    pub thinking: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
}

pub fn list_claude_models_command(claude_bin: &str) -> String {
    let request = r#"{"request_id":"pablo-models","type":"control_request","request":{"subtype":"initialize"}}"#;
    format!(
        "printf '%s\\n' {} | CLAUDE_CODE_ENTRYPOINT=sdk-ts bash -lc \
         'exec \"$0\" --output-format stream-json --verbose --input-format stream-json \
         --no-session-persistence' {}",
        quote(request),
        quote(claude_bin)
    )
}

pub fn parse_claude_models(output: &str) -> Vec<ClaudeModel> {
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(models) = value
            .pointer("/response/response/models")
            .and_then(|models| models.as_array())
        else {
            continue;
        };
        return models
            .iter()
            .filter_map(|model| {
                let id = model.get("value")?.as_str()?.to_string();
                let display = model.get("displayName")?.as_str()?;
                let label = model
                    .get("description")
                    .and_then(|description| description.as_str())
                    .and_then(|description| description.split(" · ").next())
                    .filter(|description| !description.is_empty())
                    .unwrap_or(display)
                    .to_string();
                let efforts = model
                    .get("supportedEffortLevels")
                    .and_then(|levels| levels.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|level| level.as_str().map(str::to_string))
                    .collect();
                Some(ClaudeModel { id, label, efforts })
            })
            .collect();
    }
    Vec::new()
}

pub fn list_pi_models_command(pi_bin: &str) -> String {
    format!(
        "NO_COLOR=1 bash -lc 'p=$(command -v \"$0\" 2>/dev/null || echo \"$0\"); \
         if [ -x /usr/bin/node ] && head -c 64 \"$p\" 2>/dev/null | grep -q \"^#!.*node\"; then \
         exec /usr/bin/node \"$p\" --list-models; else exec \"$0\" --list-models; fi' {}",
        quote(pi_bin)
    )
}

pub fn parse_pi_models(output: &str) -> Vec<PiModel> {
    let mut in_table = false;
    let mut models = Vec::new();
    for line in output.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.first() == Some(&"provider") && fields.get(1) == Some(&"model") {
            in_table = true;
            continue;
        }
        if !in_table || fields.len() < 5 {
            continue;
        }
        let id = format!("{}/{}", fields[0], fields[1]);
        if !models.iter().any(|model: &PiModel| model.id == id) {
            models.push(PiModel {
                id,
                thinking: fields[4].eq_ignore_ascii_case("yes"),
            });
        }
    }
    models
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    #[default]
    Unknown,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub harness: Harness,
    pub path: String,
    pub cwd: String,
    pub preview: String,
    pub title: Option<String>,
    pub created_at_iso: Option<String>,
    pub modified_at: Option<i64>,
    pub cli_version: Option<String>,
    #[serde(default)]
    pub turn_state: TurnState,
    #[serde(default)]
    pub turn_at: Option<i64>,
    #[serde(default)]
    pub turn_exit_code: Option<i32>,
    #[serde(default)]
    pub turn_key: Option<String>,
    #[serde(default)]
    pub closed_at: Option<i64>,
    #[serde(default)]
    pub read_at: Option<i64>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SessionMeta {
    closed_at: Option<i64>,
    read_at: Option<i64>,
    label: Option<String>,
    // What this app last named the session in pi, kept because the entry pi
    // wrote can be pushed out of the tail the picker reads.
    name: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct TurnRecord {
    key: String,
    harness: Harness,
    at: Option<i64>,
    running: bool,
    exit_code: Option<i32>,
    id: String,
    rollout: String,
}

impl TurnRecord {
    fn state(&self) -> TurnState {
        if self.running {
            TurnState::Running
        } else {
            match self.exit_code {
                Some(0) => TurnState::Succeeded,
                // No status file and no live process is a failure however it
                // happened.
                _ => TurnState::Failed,
            }
        }
    }

    fn matches(&self, session: &SessionSummary) -> bool {
        self.harness == session.harness
            && ((!self.rollout.is_empty() && self.rollout == session.path)
                || (!self.id.is_empty() && self.id == session.id))
    }
}

fn opencode_list_sql() -> String {
    format!(
        "SELECT s.time_updated/1000, s.id, json_object(\
         'sessionId',s.id,\
         'cwd',s.directory,\
         'timestamp',strftime('%Y-%m-%dT%H:%M:%fZ',s.time_created/1000.0,'unixepoch'),\
         'version',s.version,\
         'title',s.title) \
         FROM session s WHERE s.parent_id IS NULL AND s.time_archived IS NULL \
         ORDER BY s.time_updated DESC LIMIT {SESSION_LIMIT}"
    )
}

const OPENCODE_CACHE_DIR: &str = "${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent/opencode";

// pi appends its `session_info` name entry and keeps writing after it, so the
// picker reads back only the tail of a file it polls every couple of seconds.
// A name pushed out of that window survives in the sidecar record the rename
// writes beside it.
const PI_NAME_TAIL_BYTES: usize = 64 * 1024;

pub fn list_sessions_command(opencode_bin: &str, with_favorites: bool) -> String {
    let turns = turn_records_command();
    let opencode = quote(opencode_bin);
    let sql = quote(&opencode_list_sql());
    let meta = session_meta_records_command();
    let favorites = if with_favorites {
        favorites_records_command()
    } else {
        String::new()
    };
    format!(
        "tab=$(printf '\\t')\n\
         {turns}\
         {meta}\
         {favorites}\
         {{\n\
         d=\"${{CODEX_HOME:-$HOME/.codex}}/sessions\"\n\
         [ -d \"$d\" ] && find \"$d\" -type f -name 'rollout-*.jsonl' \
           -printf 'codex\\t%T@\\t%p\\n' 2>/dev/null\n\
         p=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects\"\n\
         [ -d \"$p\" ] && find \"$p\" -mindepth 2 -maxdepth 2 -type f \
           -name '????????-????-????-????-????????????.jsonl' \
           -printf 'claude\\t%T@\\t%p\\n' 2>/dev/null\n\
         q=\"${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions\"\n\
         [ -d \"$q\" ] && find \"$q\" -mindepth 2 -maxdepth 2 -type f \
           -name '*_*.jsonl' \
           -printf 'pi\\t%T@\\t%p\\n' 2>/dev/null\n\
         }} | sort -t\"$tab\" -k2,2 -rn | head -n {SESSION_LIMIT} \
           | while IFS=\"$tab\" read -r h mt path; do\n\
           printf 'PT_S\\t%s\\t%s\\t%s\\n' \"$h\" \"${{mt%%.*}}\" \"$path\"\n\
           if [ \"$h\" = claude ]; then\n\
             printf 'PT_M\\t'; head -n 40 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"cwd\"[[:space:]]*:' | tail -c 2000 || true; printf '\\n'\n\
             printf 'PT_P\\t'; head -n 80 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"promptSource\"[[:space:]]*:' | head -c 1200 || true; printf '\\n'\n\
             printf 'PT_A\\t'; head -n 40 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"type\"[[:space:]]*:[[:space:]]*\"ai-title\"' | head -c 1200 || true; printf '\\n'\n\
           elif [ \"$h\" = pi ]; then\n\
             printf 'PT_M\\t'; head -n 1 \"$path\" 2>/dev/null | head -c 4000; printf '\\n'\n\
             printf 'PT_P\\t'; head -n 80 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"role\"[[:space:]]*:[[:space:]]*\"user\"' \
               | head -c 1200 || true; printf '\\n'\n\
             printf 'PT_PN\\t'; tail -c {PI_NAME_TAIL_BYTES} \"$path\" 2>/dev/null \
               | grep -E '^\\{{[[:space:]]*\"type\"[[:space:]]*:[[:space:]]*\"session_info\"' \
               | tail -n 1 | head -c 1200 || true; printf '\\n'\n\
           else\n\
             printf 'PT_M\\t'; head -n 1 \"$path\" 2>/dev/null | head -c 4000; printf '\\n'\n\
             printf 'PT_P\\t'; head -n 60 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"type\"[[:space:]]*:[[:space:]]*\"(user_message|UserMessage)\"' \
               | head -c 1200 || true; printf '\\n'\n\
           fi\n\
         done\n\
         ocdb=\"${{OPENCODE_DB:-${{XDG_DATA_HOME:-$HOME/.local/share}}/opencode/opencode.db}}\"\n\
         occache=\"{OPENCODE_CACHE_DIR}\"\n\
         if [ -f \"$ocdb\" ]; then\n\
           bash -lc 'exec \"$0\" db \"$1\" --format tsv' {opencode} {sql} \
             2>/dev/null | tail -n +2 \
             | while IFS=\"$tab\" read -r mt sid meta; do\n\
             [ -n \"$sid\" ] || continue\n\
             printf 'PT_S\\topencode\\t%s\\t%s/%s.jsonl\\n' \"$mt\" \"$occache\" \"$sid\"\n\
             printf 'PT_M\\t%s\\n' \"$meta\"\n\
             printf 'PT_P\\t%s\\n' \"$meta\"\n\
           done\n\
         fi\n"
    )
}

const SESSION_META_DIR: &str = "${XDG_DATA_HOME:-$HOME/.local/share}/pabloagent/session-meta";

const SESSION_META_LIMIT: usize = 400;

fn session_meta_name(harness: Harness, thread_id: &str) -> Result<String, String> {
    let id = thread_id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "'{id}' is not a session id this app can keep a record for"
        ));
    }
    Ok(format!("{}-{}", harness.tag(), id))
}

fn session_meta_records_command() -> String {
    format!(
        "sm=\"{SESSION_META_DIR}\"\n\
         [ -d \"$sm\" ] && find \"$sm\" -mindepth 1 -maxdepth 1 -type d \
           -printf '%T@\\t%f\\n' 2>/dev/null \
           | sort -t\"$tab\" -k1,1 -rn | head -n {SESSION_META_LIMIT} \
           | while IFS=\"$tab\" read -r _mt name; do\n\
           for k in closed read label name; do\n\
             v=$(tr -d '\\n' <\"$sm/$name/$k\" 2>/dev/null)\n\
             [ -n \"$v\" ] && printf 'PT_C\\t%s\\t%s\\t%s\\n' \"$name\" \"$k\" \"$v\"\n\
           done\n\
         done\n"
    )
}

pub fn set_session_closed_command(
    harness: Harness,
    thread_id: &str,
    closed: bool,
) -> Result<String, String> {
    let name = session_meta_name(harness, thread_id)?;
    if closed {
        Ok(format!(
            "d=\"{SESSION_META_DIR}/{name}\"\n\
             mkdir -p -- \"$d\"\n\
             [ -e \"$d/closed\" ] || date +%s > \"$d/closed\"\n\
             touch -- \"$d\""
        ))
    } else {
        Ok(format!(
            "d=\"{SESSION_META_DIR}/{name}\"\n\
             mkdir -p -- \"$d\"\n\
             rm -f -- \"$d/closed\"\n\
             touch -- \"$d\""
        ))
    }
}

pub fn mark_session_read_command(
    harness: Harness,
    thread_id: &str,
    at: i64,
) -> Result<String, String> {
    let name = session_meta_name(harness, thread_id)?;
    if at <= 0 {
        return Err(format!("'{at}' is not a turn timestamp"));
    }
    Ok(format!(
        "d=\"{SESSION_META_DIR}/{name}\"\n\
         mkdir -p -- \"$d\"\n\
         cur=$(tr -d '\\n' <\"$d/read\" 2>/dev/null)\n\
         case $cur in ''|*[!0-9]*) cur=0;; esac\n\
         [ \"$cur\" -lt {at} ] && printf '%s\\n' {at} > \"$d/read\"\n\
         touch -- \"$d\""
    ))
}

pub fn set_session_label_command(
    harness: Harness,
    thread_id: &str,
    label: &str,
) -> Result<String, String> {
    let name = session_meta_name(harness, thread_id)?;
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        return Ok(format!(
            "d=\"{SESSION_META_DIR}/{name}\"\n\
             mkdir -p -- \"$d\"\n\
             rm -f -- \"$d/label\"\n\
             touch -- \"$d\""
        ));
    }
    Ok(format!(
        "d=\"{SESSION_META_DIR}/{name}\"\n\
         mkdir -p -- \"$d\"\n\
         {}\
         touch -- \"$d\"",
        write_file("\"$d/label\"", &format!("{label}\n"))
    ))
}

pub const PI_SESSION_NAME_MAX: usize = 120;

/// Names a pi session in pi's own record, which is what `pi --name` writes.
/// Only pi has a name of its own; every other harness gets the sidecar label.
pub fn set_pi_session_name_command(
    pi_bin: &str,
    path: &str,
    thread_id: &str,
    name: &str,
) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') || !path.ends_with(".jsonl") {
        return Err(format!("'{path}' does not name a session file"));
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("pi refuses an empty session name, so this needs one".to_string());
    }
    if name.chars().count() > PI_SESSION_NAME_MAX {
        return Err(format!(
            "a session name is at most {PI_SESSION_NAME_MAX} characters"
        ));
    }
    // Renaming appends to the session file, so it waits for a turn exactly as
    // deleting and rewinding do.
    let mut cmd = session_busy_guard(Harness::Pi, thread_id, path)?;
    // `-p` is what makes pi set the name and quit, and `</dev/null` is what
    // keeps it from waiting on stdin and running whatever arrives as a turn.
    // The session is addressed by file so no working directory is implied. The
    // node rule is the probe's, see `probe_command`.
    cmd.push_str(&format!(
        "NO_COLOR=1 bash -lc 'p=$(command -v \"$0\" 2>/dev/null || echo \"$0\"); \
         if [ -x /usr/bin/node ] && head -c 64 \"$p\" 2>/dev/null | grep -q \"^#!.*node\"; then \
         exec /usr/bin/node \"$p\" -p --session \"$1\" --name \"$2\"; \
         else exec \"$p\" -p --session \"$1\" --name \"$2\"; fi' {} {} {} \
         </dev/null >/dev/null || exit 1\n",
        quote(pi_bin),
        quote(path),
        quote(&name)
    ));
    // The same name in this app's own record, because pi keeps appending to the
    // session and the picker reads back only the tail of the file.
    if let Ok(record) = session_meta_name(Harness::Pi, thread_id) {
        cmd.push_str(&format!(
            "d=\"{SESSION_META_DIR}/{record}\"\n\
             mkdir -p -- \"$d\"\n\
             {}\
             touch -- \"$d\"\n",
            write_file("\"$d/name\"", &format!("{name}\n"))
        ));
    }
    Ok(cmd)
}

const FAVORITES_DIR: &str = "${XDG_DATA_HOME:-$HOME/.local/share}/pabloagent/favorites";

const FAVORITES_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<SessionSummary>,
    pub favorites: Option<Vec<NewChatDefaults>>,
}

// Hashed in Rust rather than by the shell: every Pablo build must name the
// same favorite the same way, and a name from a path could exceed the
// filename limit.
pub fn favorite_name(favorite: &NewChatDefaults) -> String {
    let mut hasher = sha2::Sha256::new();
    for field in [
        &favorite.harness,
        &favorite.model,
        &favorite.effort,
        &favorite.cwd,
        &favorite.permission_mode,
    ] {
        hasher.update(field.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn favorite_record(favorite: &NewChatDefaults) -> Result<(String, String), String> {
    if Harness::from_tag(&favorite.harness).tag() != favorite.harness.trim() {
        return Err(format!(
            "'{}' is not an agent this app knows",
            favorite.harness
        ));
    }
    if !favorite.cwd.starts_with('/') {
        return Err("a favorite needs an absolute workspace path".to_string());
    }
    let json = serde_json::to_string(favorite)
        .map_err(|e| format!("cannot serialize the favorite: {e}"))?;
    Ok((favorite_name(favorite), json))
}

// An `if`, not `&&`: this ends the save and delete commands, and a host with
// no favorites yet must not read as a failed write.
fn favorites_records_command() -> String {
    format!(
        "fd=\"{FAVORITES_DIR}\"\n\
         if [ -d \"$fd\" ]; then\n\
           find \"$fd\" -mindepth 1 -maxdepth 1 -type f -name '*.json' \
           -printf '%f\\n' 2>/dev/null | sort | head -n {FAVORITES_LIMIT} \
           | while read -r name; do\n\
             v=$(base64 <\"$fd/$name\" 2>/dev/null | tr -d '\\n')\n\
             [ -n \"$v\" ] && printf 'PT_F\\t%s\\n' \"$v\"\n\
           done\n\
         fi\n"
    )
}

pub fn save_favorite_command(favorite: &NewChatDefaults) -> Result<String, String> {
    let (name, json) = favorite_record(favorite)?;
    let write = write_file(&format!("\"{FAVORITES_DIR}/{name}.json\""), &json);
    Ok(format!(
        "mkdir -p -- \"{FAVORITES_DIR}\" || exit 1\n\
         {} || exit 1\n\
         {}",
        write.trim_end(),
        favorites_records_command()
    ))
}

pub fn delete_favorite_command(favorite: &NewChatDefaults) -> Result<String, String> {
    let (name, _) = favorite_record(favorite)?;
    Ok(format!(
        "rm -f -- \"{FAVORITES_DIR}/{name}.json\" || exit 1\n\
         {}",
        favorites_records_command()
    ))
}

pub fn parse_favorites(output: &str) -> Vec<NewChatDefaults> {
    let mut out: Vec<NewChatDefaults> = Vec::new();
    for line in output.lines() {
        let Some(b64) = line.strip_prefix("PT_F\t") else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
            continue;
        };
        let Ok(favorite) = serde_json::from_slice::<NewChatDefaults>(&bytes) else {
            continue;
        };
        if favorite_record(&favorite).is_ok() && !out.contains(&favorite) {
            out.push(favorite);
        }
    }
    out
}

const DRAFT_PROMPTS_DIR: &str = "${XDG_DATA_HOME:-$HOME/.local/share}/pabloagent/draft";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    pub id: String,
    pub text: String,
    pub read_only: bool,
}

fn draft_dir_expr(dir: &str) -> Result<String, String> {
    let dir = dir.trim().trim_end_matches('/');
    if dir.is_empty() {
        return Ok(format!("\"{DRAFT_PROMPTS_DIR}\""));
    }
    if dir == "~" {
        return Ok("\"$HOME\"".to_string());
    }
    if let Some(rest) = dir.strip_prefix("~/") {
        return Ok(format!("\"$HOME\"/{}", quote(rest)));
    }
    if dir.starts_with('/') {
        return Ok(quote(dir));
    }
    Err(format!(
        "'{dir}' is not an absolute path — the draft prompts path must start with / or ~/."
    ))
}

fn draft_name(id: &str) -> Result<&str, String> {
    let id = id.trim();
    let bad_segment = |s: &str| s.trim().is_empty() || s.trim().starts_with('.');
    if id.is_empty()
        || id.len() > 200
        || id.contains("..")
        || id.chars().any(char::is_control)
        || id.split('/').any(bad_segment)
    {
        return Err(format!("'{id}' is not a name a draft can be saved under"));
    }
    Ok(id)
}

pub fn save_draft_prompt_command(dir: &str, id: &str, text: &str) -> Result<String, String> {
    let d = draft_dir_expr(dir)?;
    let stem = quote(draft_name(id)?);
    Ok(format!(
        "d={d}\n\
         f={stem}\n\
         if [ -e \"$d/$f.md\" ]; then\n\
           printf 'PT_DE\\n'\n\
           exit 0\n\
         fi\n\
         mkdir -p -- \"$(dirname -- \"$d/$f.md\")\" || exit 1\n\
         set -C\n\
         {}",
        write_file("\"$d/$f.md\"", text)
    ))
}

pub fn draft_save_conflict(output: &str) -> bool {
    output.lines().any(|line| line.trim() == "PT_DE")
}

pub fn list_draft_prompts_command(dir: &str) -> Result<String, String> {
    let d = draft_dir_expr(dir)?;
    Ok(format!(
        "tab=$(printf '\\t')\n\
         d={d}\n\
         [ -d \"$d\" ] || exit 0\n\
         find \"$d\" -mindepth 1 -type f \\( -name '*.md' -o -name '*.txt' \\) \
           -printf '%T@\\t%P\\n' 2>/dev/null \
           | sort -t\"$tab\" -k1,1 -rn | while IFS=\"$tab\" read -r _mt name; do\n\
           v=$(base64 <\"$d/$name\" 2>/dev/null | tr -d '\\n')\n\
           [ -n \"$v\" ] && printf 'PT_DP\\t%s\\t%s\\n' \"$name\" \"$v\"\n\
         done\n\
         exit 0"
    ))
}

pub fn parse_draft_prompts(output: &str) -> Vec<DraftFile> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("PT_DP\t")?;
            let (name, b64) = rest.split_once('\t')?;
            let (id, read_only) = name
                .strip_suffix(".md")
                .map(|id| (id, false))
                .or_else(|| name.strip_suffix(".txt").map(|id| (id, true)))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .ok()?;
            Some(DraftFile {
                id: id.to_string(),
                text: String::from_utf8_lossy(&bytes).into_owned(),
                read_only,
            })
        })
        .collect()
}

pub fn rename_draft_prompt_command(dir: &str, id: &str, new_id: &str) -> Result<String, String> {
    let d = draft_dir_expr(dir)?;
    let from = quote(draft_name(id)?);
    let to = quote(draft_name(new_id)?);
    Ok(format!(
        "d={d}\n\
         f={from}\n\
         t={to}\n\
         if [ ! -f \"$d/$f.md\" ]; then\n\
           printf 'PT_DM\\n'\n\
           exit 0\n\
         fi\n\
         if [ -e \"$d/$t.md\" ]; then\n\
           printf 'PT_DE\\n'\n\
           exit 0\n\
         fi\n\
         mkdir -p -- \"$(dirname -- \"$d/$t.md\")\" || exit 1\n\
         mv -- \"$d/$f.md\" \"$d/$t.md\""
    ))
}

pub fn draft_rename_missing(output: &str) -> bool {
    output.lines().any(|line| line.trim() == "PT_DM")
}

pub fn delete_draft_prompt_command(dir: &str, id: &str) -> Result<String, String> {
    let d = draft_dir_expr(dir)?;
    let name = quote(&format!("{}.md", draft_name(id)?));
    Ok(format!("d={d}\nrm -f -- \"$d\"/{name}"))
}

fn turn_records_command() -> String {
    format!(
        "t=\"${{XDG_CACHE_HOME:-$HOME/.cache}}/pabloagent/turns\"\n\
         [ -d \"$t\" ] && find \"$t\" -mindepth 1 -maxdepth 1 -type d \
           -printf '%T@\\t%p\\n' 2>/dev/null \
           | sort -t\"$tab\" -k1,1 -rn | head -n {TURN_LIMIT} \
           | while IFS=\"$tab\" read -r mt dir; do\n\
           key=${{dir##*/}}\n\
           st=$(tr -d '\\n' <\"$dir/status\" 2>/dev/null)\n\
           run=false\n\
           if [ -z \"$st\" ]; then\n\
             if command -v tmux >/dev/null 2>&1 && \
                tmux has-session -t \"pabloagent-$key\" 2>/dev/null; then\n\
               run=true\n\
             else\n\
               pid=$(tr -d '\\n' <\"$dir/pid\" 2>/dev/null)\n\
               [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null && run=true\n\
             fi\n\
           fi\n\
           id=$(tr -d '\\n' <\"$dir/resolved_thread\" 2>/dev/null)\n\
           [ -n \"$id\" ] || id=$(tr -d '\\n' <\"$dir/thread\" 2>/dev/null)\n\
           h=$(tr -d '\\n' <\"$dir/harness\" 2>/dev/null)\n\
           if [ -z \"$id\" ] && {{ [ \"$h\" = claude ] || [ \"$h\" = pi ]; }}; then\n\
             id=$(tr -d '\\n' <\"$dir/session\" 2>/dev/null)\n\
           fi\n\
           printf 'PT_T\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$key\" \"$h\" \
             \"${{mt%%.*}}\" \"$run\" \"${{st:--}}\" \"$id\" \
             \"$(tr -d '\\n' <\"$dir/rollout\" 2>/dev/null)\"\n\
         done\n"
    )
}

fn user_message_text(line: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => {
            if let Some(text) = value.pointer("/payload/message").and_then(|m| m.as_str()) {
                return text.to_string();
            }
            value
                .pointer("/payload/item/content")
                .and_then(|c| c.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }
        // A prompt longer than the byte cut never parses, so the readable head
        // of it is dug out by hand rather than showing nothing.
        Err(_) => {
            let message = dig_string(line, "message");
            if message.is_empty() {
                dig_string(line, "text")
            } else {
                message
            }
        }
    }
}

fn claude_prompt_text(line: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return dig_string(line, "content");
    };
    match value.pointer("/message/content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn pi_session_name(line: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => {
            if value.pointer("/type").and_then(|t| t.as_str()) != Some("session_info") {
                return String::new();
            }
            value
                .pointer("/name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string()
        }
        // An entry longer than its byte cut, or one pi was still writing when
        // the tail was read, never parses; the grep already proved the type.
        Err(_) => dig_string(line, "name"),
    }
}

fn opencode_title_text(line: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => value
            .pointer("/title")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string(),
        Err(_) => dig_string(line, "title"),
    }
}

fn dig_string(line: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let Some(rest) = line
        .match_indices(&needle)
        .map(|(at, _)| line[at + needle.len()..].trim_start())
        .filter_map(|rest| rest.strip_prefix(':'))
        .find_map(|rest| rest.trim_start().strip_prefix('"'))
    else {
        return String::new();
    };
    let bytes = rest.as_bytes();
    let mut end = rest.len();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => {
                end = i;
                break;
            }
            _ => i += 1,
        }
    }
    unescape(&rest[..end.min(rest.len())])
}

fn unescape(text: &str) -> String {
    text.replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
}

pub fn parse_sessions(output: &str) -> Vec<SessionSummary> {
    let mut out: Vec<SessionSummary> = Vec::new();
    // Newest first, as the shell sorted them, so the first match for a session
    // is its most recent turn.
    let mut turns: Vec<TurnRecord> = Vec::new();
    // Sidecar facts keyed by directory name, `<harness>-<id>`.
    let mut metas: std::collections::HashMap<String, SessionMeta> =
        std::collections::HashMap::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("PT_T\t") {
            // The rollout path is last because it is the only field that could
            // contain a tab, and being last it survives one.
            let mut parts = rest.splitn(7, '\t');
            let key = parts.next().unwrap_or_default().trim().to_string();
            let harness = Harness::from_tag(parts.next().unwrap_or_default());
            let at = parts.next().and_then(|s| s.trim().parse::<i64>().ok());
            let running = parts.next().is_some_and(|s| s.trim() == "true");
            let exit_code = parts.next().and_then(|s| s.trim().parse::<i32>().ok());
            turns.push(TurnRecord {
                key,
                harness,
                at,
                running,
                exit_code,
                id: parts.next().unwrap_or_default().trim().to_string(),
                rollout: parts.next().unwrap_or_default().to_string(),
            });
        } else if let Some(rest) = line.strip_prefix("PT_S\t") {
            let mut parts = rest.splitn(3, '\t');
            let harness = Harness::from_tag(parts.next().unwrap_or_default());
            let modified_at = parts.next().and_then(|s| s.trim().parse::<i64>().ok());
            let Some(path) = parts.next() else { continue };
            out.push(SessionSummary {
                id: String::new(),
                harness,
                path: path.to_string(),
                cwd: String::new(),
                preview: String::new(),
                title: None,
                created_at_iso: None,
                modified_at,
                cli_version: None,
                turn_state: TurnState::default(),
                turn_at: None,
                turn_exit_code: None,
                turn_key: None,
                closed_at: None,
                read_at: None,
                label: None,
            });
        } else if let Some(rest) = line.strip_prefix("PT_M\t") {
            let Some(current) = out.last_mut() else {
                continue;
            };
            let parsed = serde_json::from_str::<serde_json::Value>(rest).ok();
            // A header line longer than its byte cut arrives truncated and will
            // not parse, codex `session_meta` lines always are, so each field
            // falls back to being dug out of the raw text.
            let field = |paths: &[&str], key: &str| -> Option<String> {
                if let Some(value) = parsed.as_ref() {
                    return paths.iter().find_map(|p| {
                        value
                            .pointer(p)
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                }
                let dug = dig_string(rest, key);
                (!dug.is_empty()).then_some(dug)
            };

            let (id, cwd, timestamp, version) = match current.harness {
                Harness::Codex => (
                    field(&["/payload/id", "/payload/session_id"], "session_id"),
                    field(&["/payload/cwd"], "cwd"),
                    field(&["/timestamp"], "timestamp"),
                    field(&["/payload/cli_version"], "cli_version"),
                ),
                // claude has no header entry; every message line repeats the
                // identity, and the shell offered the first one carrying `cwd`.
                Harness::Claude => (
                    field(&["/sessionId"], "sessionId"),
                    field(&["/cwd"], "cwd"),
                    field(&["/timestamp"], "timestamp"),
                    field(&["/version"], "version"),
                ),
                // opencode's header is built by `opencode_list_sql` with the
                // claude field names on purpose, so the two arms read the same.
                Harness::Opencode => (
                    field(&["/sessionId"], "sessionId"),
                    field(&["/cwd"], "cwd"),
                    field(&["/timestamp"], "timestamp"),
                    field(&["/version"], "version"),
                ),
                // pi's `version` is the file-format version, not a CLI
                // version, so none is reported.
                Harness::Pi => (
                    field(&["/id"], "id"),
                    field(&["/cwd"], "cwd"),
                    field(&["/timestamp"], "timestamp"),
                    None,
                ),
            };
            current.id = id.unwrap_or_default();
            current.cwd = cwd.unwrap_or_default();
            current.created_at_iso = timestamp;
            current.cli_version = version;
            // A session whose header line is unreadable still gets an id, from
            // the filename, so it stays openable.
            if current.id.is_empty() {
                current.id = id_from_path(&current.path);
            }
        } else if let Some(rest) = line.strip_prefix("PT_A\t") {
            // Only claude rows emit one, and only when the grep matched.
            if let Some(current) = out.last_mut() {
                let title = serde_json::from_str::<serde_json::Value>(rest)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/aiTitle")
                            .and_then(|t| t.as_str())
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| dig_string(rest, "aiTitle"));
                if !title.trim().is_empty() {
                    current.title = Some(title);
                }
            }
        } else if let Some(rest) = line.strip_prefix("PT_C\t") {
            // One sidecar fact: record name, key, value. A key this build does
            // not know is skipped, not refused.
            let mut parts = rest.splitn(3, '\t');
            let (Some(name), Some(key), Some(value)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let entry = metas.entry(name.trim().to_string()).or_default();
            match key.trim() {
                "closed" => entry.closed_at = value.trim().parse::<i64>().ok(),
                "read" => entry.read_at = value.trim().parse::<i64>().ok(),
                "label" => {
                    let label = value.trim();
                    if !label.is_empty() {
                        entry.label = Some(label.to_string());
                    }
                }
                "name" => {
                    let name = value.trim();
                    if !name.is_empty() {
                        entry.name = Some(name.to_string());
                    }
                }
                _ => {}
            }
        } else if let Some(rest) = line.strip_prefix("PT_PN\t") {
            // Only pi rows emit one, and only when the grep matched.
            if let Some(current) = out.last_mut() {
                let name = pi_session_name(rest);
                if !name.trim().is_empty() {
                    current.title = Some(name);
                }
            }
        } else if let Some(rest) = line.strip_prefix("PT_P\t") {
            if let Some(current) = out.last_mut() {
                current.preview = match current.harness {
                    Harness::Codex => user_message_text(rest),
                    Harness::Claude => claude_prompt_text(rest),
                    Harness::Opencode => opencode_title_text(rest),
                    // A pi prompt lives at `message.content` exactly like a
                    // claude one, so the same reader serves both.
                    Harness::Pi => claude_prompt_text(rest),
                };
            }
        }
    }
    out.retain(|s| !s.id.is_empty());
    // Attached last, because a turn is matched by the session's id or path and
    // neither is known until its header line has been read.
    for session in &mut out {
        if let Some(meta) = metas.get(&format!("{}-{}", session.harness.tag(), session.id)) {
            session.closed_at = meta.closed_at;
            session.read_at = meta.read_at;
            session.label = meta.label.clone();
            // The file is the truth about a pi name; the record only answers
            // for the sessions whose entry is now too far from the tail.
            if session.title.is_none() {
                session.title = meta.name.clone();
            }
        }
        let Some(turn) = turns.iter().find(|t| t.matches(session)) else {
            continue;
        };
        session.turn_state = turn.state();
        session.turn_at = turn.at;
        session.turn_exit_code = turn.exit_code;
        session.turn_key = turn.running.then(|| turn.key.clone());
    }
    out
}

fn id_from_path(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.strip_suffix(".jsonl").unwrap_or(name);
    if let Some(rest) = stem.strip_prefix("ses_") {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()) {
            return stem.to_string();
        }
    }
    let stem = stem.rsplit('_').next().unwrap_or(stem);
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 5 {
        parts[parts.len() - 5..].join("-")
    } else {
        String::new()
    }
}

fn opencode_history_sql(session_id: &str) -> String {
    format!(
        "SELECT line FROM (\
         SELECT m.id AS mid, 0 AS k, m.id AS pid, \
         json_object('kind','message','id',m.id,'data',json(m.data)) AS line \
         FROM message m WHERE m.session_id='{session_id}' \
         UNION ALL \
         SELECT p.message_id, 1, p.id, \
         json_object('kind','part','id',p.id,'messageId',p.message_id,'data',json(p.data)) \
         FROM part p WHERE p.session_id='{session_id}') \
         ORDER BY mid, k, pid"
    )
}

pub fn read_rollout_command(
    harness: Harness,
    path: &str,
    from_line: u64,
    opencode_bin: &str,
) -> Result<String, String> {
    let from = from_line.max(1);
    if harness != Harness::Opencode {
        return Ok(format!(
            "tail -n +{from} {} | head -c {SESSION_READ_BYTE_CAP}",
            quote(path)
        ));
    }
    let sid = id_from_path(path);
    if sid.is_empty() || !sid.starts_with("ses_") {
        return Err(format!(
            "'{path}' does not name an opencode session — expected …/ses_<id>.jsonl"
        ));
    }
    // `tail -n +2` strips the TSV header `opencode db` prints. The db call's
    // stderr is left flowing to the channel so a failure says why.
    Ok(format!(
        "p={}\n\
         mkdir -p \"$(dirname \"$p\")\"\n\
         out=$(bash -lc 'exec \"$0\" db \"$1\" --format tsv' {} {}) || exit 9\n\
         printf '%s\\n' \"$out\" | tail -n +2 >\"$p.tmp\" && mv \"$p.tmp\" \"$p\"\n\
         tail -n +{from} \"$p\" | head -c {SESSION_READ_BYTE_CAP}",
        quote(path),
        quote(opencode_bin),
        quote(&opencode_history_sql(&sid)),
    ))
}

pub const REMOTE_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;

pub fn read_remote_file_command(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') {
        return Err(format!("'{path}' is not an absolute path"));
    }
    Ok(format!(
        "p={}\n\
         s=$(wc -c <\"$p\") || exit 9\n\
         if [ \"$s\" -gt {REMOTE_FILE_MAX_BYTES} ]; then printf 'PT_TOOBIG\\t%s\\n' \"$s\"; exit 0; fi\n\
         printf 'PT_SIZE\\t%s\\n' \"$s\"\n\
         base64 <\"$p\" | tr -d '\\n'",
        quote(path)
    ))
}

pub const REMOTE_DOWNLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;

pub fn download_remote_file_command(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') {
        return Err(format!("'{path}' is not an absolute path"));
    }
    Ok(format!(
        "p={}\n\
         if [ ! -f \"$p\" ]; then printf 'PT_NOTFILE\\n'; exit 0; fi\n\
         s=$(wc -c <\"$p\") || exit 9\n\
         s=$(printf '%s' \"$s\" | tr -d ' ')\n\
         if [ \"$s\" -gt {REMOTE_DOWNLOAD_MAX_BYTES} ]; then printf 'PT_TOOBIG\\t%s\\n' \"$s\"; exit 0; fi\n\
         printf 'PT_BYTES\\t%s\\n' \"$s\"\n\
         exec cat \"$p\"",
        quote(path)
    ))
}

pub fn remote_file_size_command(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') {
        return Err(format!("'{path}' is not an absolute path"));
    }
    Ok(format!(
        "p={}\n\
         if [ ! -f \"$p\" ]; then printf 'PT_NOTFILE\\n'; exit 0; fi\n\
         s=$(wc -c <\"$p\") || exit 9\n\
         s=$(printf '%s' \"$s\" | tr -d ' ')\n\
         if [ \"$s\" -gt {REMOTE_DOWNLOAD_MAX_BYTES} ]; then printf 'PT_TOOBIG\\t%s\\n' \"$s\"; exit 0; fi\n\
         printf 'PT_BYTES\\t%s\\n' \"$s\"",
        quote(path)
    ))
}

pub fn pretty_session_command(path: &str) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') {
        return Err(format!("'{path}' is not an absolute path"));
    }
    Ok(format!(
        "p={}\n\
         if [ ! -f \"$p\" ]; then printf 'PT_NOTFILE\\n'; exit 0; fi\n\
         command -v jq >/dev/null 2>&1 || {{ printf 'PT_NOJQ\\n'; exit 0; }}\n\
         t=${{TMPDIR:-/tmp}}\n\
         find \"$t\" -maxdepth 1 -type d -name '{PRETTY_DIR_PREFIX}*' -mtime +0 \
         -exec rm -rf {{}} + 2>/dev/null || :\n\
         d=$(mktemp -d \"$t/{PRETTY_DIR_PREFIX}XXXXXX\") || exit 9\n\
         n=${{p##*/}}\n\
         o=\"$d/${{n%.jsonl}}.pretty.json\"\n\
         if ! e=$(jq . \"$p\" 2>&1 >\"$o\"); then\n\
         rm -rf \"$d\"\n\
         printf 'PT_JQFAIL\\t%s\\n' \"$(printf '%s' \"$e\" | tr '\\n\\t' '  ')\"\n\
         exit 0\n\
         fi\n\
         s=$(wc -c <\"$o\") || exit 9\n\
         s=$(printf '%s' \"$s\" | tr -d ' ')\n\
         printf 'PT_PRETTY\\t%s\\t%s\\n' \"$s\" \"$o\"",
        quote(path)
    ))
}

const PRETTY_DIR_PREFIX: &str = "pabloagent-pretty.";

pub fn parse_pretty_session(output: &str, path: &str) -> Result<(String, u64), String> {
    let line = output.lines().find(|l| l.starts_with("PT_")).unwrap_or("");
    if line == "PT_NOJQ" {
        return Err(
            "jq is not installed on the server, so the session file cannot be formatted \
             there. Install jq and try again."
                .to_string(),
        );
    }
    if line == "PT_NOTFILE" {
        return Err(format!("{path} is not a file on the server."));
    }
    if let Some(reason) = line.strip_prefix("PT_JQFAIL\t") {
        return Err(format!("jq could not format {path}: {}", reason.trim()));
    }
    let mut fields = line
        .strip_prefix("PT_PRETTY\t")
        .unwrap_or("")
        .splitn(2, '\t');
    let size = fields
        .next()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .ok_or_else(|| format!("The server did not say what it did with {path}."))?;
    let pretty = fields.next().unwrap_or("").trim();
    if pretty.is_empty() {
        return Err(format!("The server did not say where it formatted {path}."));
    }
    Ok((pretty.to_string(), size))
}

const BUSY_MARKER: &str = "PT_BUSY";

fn session_busy_guard(
    harness: Harness,
    thread_id: &str,
    rollout_path: &str,
) -> Result<String, String> {
    let thread_id = thread_id.trim();
    let rollout_path = rollout_path.trim();
    // The id becomes a path component in the lock directory's name.
    if thread_id
        .chars()
        .any(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
    {
        return Err(format!("'{thread_id}' is not a session id"));
    }
    let tag = harness.tag();
    // `pt_read` is `turn.sh`'s own `read_file`, down to the missing-file case:
    // a turn file not written yet is normal.
    let mut guard = String::from(
        "r=\"${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent\"\n\
         pt_read() {\n\
         \t[ -f \"$1\" ] && tr -d '\\n' <\"$1\" || true\n\
         }\n\
         pt_live() {\n\
         \ttd=\"$r/turns/$1\"\n\
         \t[ -d \"$td\" ] || return 1\n\
         \t[ -f \"$td/status\" ] && return 1\n\
         \tif command -v tmux >/dev/null 2>&1 && \
         tmux has-session -t \"pabloagent-$1\" 2>/dev/null; then\n\
         \t\treturn 0\n\
         \tfi\n\
         \ttp=$(pt_read \"$td/pid\")\n\
         \tif [ -n \"$tp\" ] && kill -0 \"$tp\" 2>/dev/null; then\n\
         \t\treturn 0\n\
         \tfi\n\
         \t! find \"$td\" -maxdepth 0 -mmin +1 -print 2>/dev/null | grep -q .\n\
         }\n\
         busy=\n",
    );
    if !thread_id.is_empty() {
        guard.push_str(&format!(
            "lk=\"$r/locks/{tag}-{thread_id}\"\n\
             if [ -d \"$lk\" ]; then\n\
             \tow=$(pt_read \"$lk/owner\")\n\
             \tif [ -n \"$ow\" ] && pt_live \"$ow\"; then\n\
             \t\tbusy=$ow\n\
             \tfi\n\
             fi\n"
        ));
    }
    // The identity of a live turn, read exactly the way `sync_identity` and
    // the picker's turn records read it.
    guard.push_str(
        "if [ -z \"$busy\" ] && [ -d \"$r/turns\" ]; then\n\
         \tfor td0 in \"$r/turns\"/*; do\n\
         \t\t[ -d \"$td0\" ] || continue\n\
         \t\tk=${td0##*/}\n\
         \t\tpt_live \"$k\" || continue\n\
         \t\th=$(pt_read \"$td0/harness\")\n\
         \t\t[ -n \"$h\" ] || h=codex\n\
         \t\tro=$(pt_read \"$td0/rollout\")\n\
         \t\tid=$(pt_read \"$td0/resolved_thread\")\n\
         \t\t[ -n \"$id\" ] || id=$(pt_read \"$td0/thread\")\n\
         \t\tif [ -z \"$id\" ] && { [ \"$h\" = claude ] || [ \"$h\" = pi ]; }; then\n\
         \t\t\tid=$(pt_read \"$td0/session\")\n\
         \t\tfi\n\
         \t\tif [ -z \"$ro\" ] && [ -z \"$id\" ]; then\n\
         \t\t\tbusy=$k\n\
         \t\t\tbreak\n\
         \t\tfi\n",
    );
    if !rollout_path.is_empty() {
        guard.push_str(&format!(
            "\t\tif [ \"$ro\" = {} ]; then\n\
             \t\t\tbusy=$k\n\
             \t\t\tbreak\n\
             \t\tfi\n",
            quote(rollout_path)
        ));
    }
    if !thread_id.is_empty() {
        guard.push_str(&format!(
            "\t\tif [ \"$h\" = {tag} ] && [ \"$id\" = '{thread_id}' ]; then\n\
             \t\t\tbusy=$k\n\
             \t\t\tbreak\n\
             \t\tfi\n"
        ));
    }
    guard.push_str("\tdone\nfi\n");
    guard.push_str(&format!(
        "if [ -n \"$busy\" ]; then\n\
         \tprintf '{BUSY_MARKER}\\t%s\\n' \"$busy\"\n\
         \texit 0\n\
         fi\n"
    ));
    Ok(guard)
}

pub fn refused_because_busy(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| {
            line.strip_prefix(BUSY_MARKER)
                .and_then(|rest| rest.strip_prefix('\t'))
        })
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

pub fn busy_session_message(action: &str, turn: &str) -> String {
    format!(
        "A turn is still running for this session on the server (turn {turn}), \
         so it cannot be {action}. Wait for it to finish, or stop it, then try again."
    )
}

/// Claude Code keeps a run's environment at `<config>/session-env/<id>`, beside
/// the `projects` tree that holds the transcript.
fn claude_session_env(path: &str) -> Option<String> {
    let (dir, file) = path.rsplit_once('/')?;
    let (projects, slug) = dir.rsplit_once('/')?;
    let (config, name) = projects.rsplit_once('/')?;
    if name != "projects" || slug.is_empty() || config.is_empty() {
        return None;
    }
    let id = file.strip_suffix(".jsonl")?;
    Some(format!("{config}/session-env/{id}"))
}

pub fn delete_session_command(
    harness: Harness,
    path: &str,
    thread_id: &str,
    opencode_bin: &str,
) -> Result<String, String> {
    let path = path.trim();
    if !path.starts_with('/') || !path.ends_with(".jsonl") {
        return Err(format!("'{path}' does not name a session file"));
    }
    let opencode_id = if harness == Harness::Opencode {
        let sid = id_from_path(path);
        if sid.is_empty() || !sid.starts_with("ses_") {
            return Err(format!(
                "'{path}' does not name an opencode session — expected …/ses_<id>.jsonl"
            ));
        }
        Some(sid)
    } else {
        None
    };
    let thread_id = opencode_id.as_deref().unwrap_or(thread_id);
    let file = quote(path);
    let mut cmd = session_busy_guard(harness, thread_id, path)?;
    if let Some(sid) = &opencode_id {
        cmd.push_str(&opencode_delete_command(opencode_bin, sid));
    }
    // Every removal exits on failure, or the last one supplies the script's
    // exit status and a delete that removed nothing reads as success.
    cmd.push_str(&format!("rm -f -- {file} || exit 1"));
    if harness != Harness::Opencode {
        cmd.push_str(&format!(
            "\nrm -f -- {} || exit 1",
            quote(&format!("{path}.rewind-bak"))
        ));
    }
    if harness == Harness::Claude {
        let dir = path.strip_suffix(".jsonl").expect("checked above");
        cmd.push_str(&format!("\nrm -rf -- {} || exit 1", quote(dir)));
        if let Some(env) = claude_session_env(path) {
            cmd.push_str(&format!("\nrm -rf -- {} || exit 1", quote(&env)));
        }
    }
    // The sidecar record goes with the session. Skipped when the id is empty
    // or odd rather than failing the delete.
    if let Ok(name) = session_meta_name(harness, thread_id) {
        cmd.push_str(&format!(
            "\nrm -rf -- \"{SESSION_META_DIR}/{name}\" || exit 1"
        ));
    }
    // A remote filesystem can report a removal it did not make.
    cmd.push_str(&format!(
        "\nif [ -e {file} ]; then\n\
         \tprintf 'the server still has %s after removing it\\n' {file} >&2\n\
         \texit 1\n\
         fi"
    ));
    Ok(cmd)
}

/// `opencode session delete` takes the row, its messages and its child
/// sessions, and exits non-zero for an id it does not have. Its `remove` logs
/// and swallows failures, so the row is counted afterwards rather than
/// trusting the exit status alone. The file Pablo deletes after this is only
/// its own render of the row.
fn opencode_delete_command(opencode_bin: &str, sid: &str) -> String {
    let bin = quote(opencode_bin);
    let sql = quote(&format!(
        "SELECT count(*) AS n FROM session WHERE id='{sid}'"
    ));
    format!(
        "bash -lc 'exec \"$0\" session delete \"$1\"' {bin} '{sid}' || exit 1\n\
         out=$(bash -lc 'exec \"$0\" db \"$1\" --format tsv' {bin} {sql}) || exit 1\n\
         n=$(printf '%s\\n' \"$out\" | tail -n +2)\n\
         if [ \"$n\" != 0 ]; then\n\
         \tprintf 'the server still has session %s after deleting it\\n' '{sid}' >&2\n\
         \texit 1\n\
         fi\n"
    )
}

pub fn rewind_session_command(
    harness: Harness,
    path: &str,
    keep_lines: u64,
    expected_lines: u64,
    thread_id: &str,
) -> Result<String, String> {
    if harness == Harness::Opencode {
        return Err(
            "opencode sessions live in opencode's own database, so this app cannot rewind them"
                .to_string(),
        );
    }
    let path = path.trim();
    if !path.starts_with('/') || !path.ends_with(".jsonl") {
        return Err(format!("'{path}' does not name a session file"));
    }
    if keep_lines == 0 {
        return Err("rewinding to before the first entry would empty the session".to_string());
    }
    if keep_lines >= expected_lines {
        return Err("there is nothing after this message to rewind".to_string());
    }
    let guard = session_busy_guard(harness, thread_id, path)?;
    let f = quote(path);
    Ok(format!(
        "{guard}\
         f={f}\n\
         total=$(wc -l < \"$f\") || exit 1\n\
         if [ \"$total\" -ne {expected_lines} ]; then\n\
         \techo \"the session changed on the server ($total lines, expected {expected_lines}); reopen the chat and try again\" >&2\n\
         \texit 1\n\
         fi\n\
         cp -- \"$f\" \"$f.rewind-bak\" || exit 1\n\
         head -n {keep_lines} < \"$f\" > \"$f.rewind-tmp\" || exit 1\n\
         mv -- \"$f.rewind-tmp\" \"$f\""
    ))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub prompt: String,
    #[serde(default)]
    pub harness: Harness,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default)]
    pub session_id: String,
}

pub fn start_turn_command(
    key: &str,
    request: &TurnRequest,
    codex_bin: &str,
    claude_bin: &str,
    opencode_bin: &str,
    pi_bin: &str,
) -> String {
    let bin = match request.harness {
        Harness::Codex => codex_bin,
        Harness::Claude => claude_bin,
        Harness::Opencode => opencode_bin,
        Harness::Pi => pi_bin,
    };
    let dir = turn_dir(key);
    let mut cmd = format!("set -e\nd={dir}\nmkdir -p \"$d\"\n");
    cmd.push_str(&write_file("\"$d/turn.sh\"", SCRIPT));
    cmd.push_str(&write_file("\"$d/prompt\"", &request.prompt));
    cmd.push_str(&write_file("\"$d/cwd\"", request.cwd.trim()));
    cmd.push_str(&write_file("\"$d/model\"", request.model.trim()));
    cmd.push_str(&write_file("\"$d/effort\"", request.effort.trim()));
    cmd.push_str(&write_file("\"$d/thread\"", request.thread_id.trim()));
    cmd.push_str(&write_file("\"$d/harness\"", request.harness.tag()));
    cmd.push_str(&write_file("\"$d/bin\"", bin.trim()));
    cmd.push_str(&write_file(
        "\"$d/permission\"",
        request.permission_mode.trim(),
    ));
    cmd.push_str(&write_file("\"$d/session\"", request.session_id.trim()));
    cmd.push_str(&format!("exec sh \"$d/turn.sh\" start {key}\n"));
    cmd
}

pub fn poll_turn_command(key: &str, from_line: u64) -> String {
    let dir = turn_dir(key);
    format!(
        "d={dir}; exec sh \"$d/turn.sh\" poll {key} {}",
        from_line.max(1)
    )
}

pub fn stop_turn_command(key: &str) -> String {
    let dir = turn_dir(key);
    format!("d={dir}; exec sh \"$d/turn.sh\" stop {key}")
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnPoll {
    pub running: bool,
    pub exit_code: Option<i32>,
    pub thread_id: Option<String>,
    pub rollout_path: Option<String>,
    pub lines: String,
    pub line_count: u64,
    pub stderr: String,
    pub truncated: bool,
}

pub fn parse_turn_poll(output: &str) -> Result<TurnPoll, String> {
    let mut poll = TurnPoll::default();
    let mut in_body = false;
    let mut body: Vec<&str> = Vec::new();
    let mut saw_status = false;
    let mut saw_lines = false;

    for line in output.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if in_body {
            body.push(line);
            continue;
        }
        if trimmed == "PT_LINES" {
            saw_lines = true;
            in_body = true;
        } else if let Some(rest) = trimmed.strip_prefix("PT_STATUS\t") {
            if saw_status {
                return Err("Malformed turn poll: duplicate PT_STATUS line.".to_string());
            }
            saw_status = true;
            let mut running = None;
            let mut exit = None;
            let mut from = None;
            for field in rest.split('\t') {
                match field.split_once('=') {
                    Some(("running", "true")) => running = Some(true),
                    Some(("running", "false")) => running = Some(false),
                    Some(("running", v)) => {
                        return Err(format!("Malformed turn poll: invalid running value '{v}'."));
                    }
                    Some(("exit", "-")) => exit = Some(None),
                    Some(("exit", v)) => {
                        exit = Some(Some(v.parse::<i32>().map_err(|_| {
                            format!("Malformed turn poll: invalid exit status '{v}'.")
                        })?));
                    }
                    Some(("from", v)) => {
                        let parsed = v.parse::<u64>().map_err(|_| {
                            format!("Malformed turn poll: invalid line cursor '{v}'.")
                        })?;
                        if parsed == 0 {
                            return Err("Malformed turn poll: the line cursor must be at least 1."
                                .to_string());
                        }
                        from = Some(parsed);
                    }
                    _ => {}
                }
            }
            poll.running = running.ok_or_else(|| {
                "Malformed turn poll: PT_STATUS has no running field.".to_string()
            })?;
            poll.exit_code = exit
                .ok_or_else(|| "Malformed turn poll: PT_STATUS has no exit field.".to_string())?;
            if from.is_none() {
                return Err("Malformed turn poll: PT_STATUS has no line cursor.".to_string());
            }
            if poll.running && poll.exit_code.is_some() {
                return Err(
                    "Malformed turn poll: a running turn already has an exit status.".to_string(),
                );
            }
        } else if let Some(rest) = trimmed.strip_prefix("PT_THREAD\t") {
            if !rest.trim().is_empty() {
                poll.thread_id = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = trimmed.strip_prefix("PT_ROLLOUT\t") {
            if !rest.trim().is_empty() {
                poll.rollout_path = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = trimmed.strip_prefix("PT_STDERR\t") {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(rest.trim())
                .map_err(|_| "Malformed turn poll: PT_STDERR is not valid base64.".to_string())?;
            poll.stderr = String::from_utf8_lossy(&bytes).trim().to_string();
        }
    }

    if !saw_status {
        return Err("Incomplete turn poll: PT_STATUS is missing.".to_string());
    }
    if !saw_lines {
        return Err("Incomplete turn poll: PT_LINES is missing.".to_string());
    }

    // A rollout being appended to as it is read can end mid-line; the frontend
    // drops an unparsable last line, and the cursor only counts whole ones.
    poll.line_count = body.iter().filter(|l| l.ends_with('\n')).count() as u64;
    poll.lines = body.concat();
    poll.truncated = poll.lines.len() as u64 >= SESSION_READ_BYTE_CAP;
    Ok(poll)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_the_awkward_characters() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn delete_removes_what_each_harness_wrote() {
        let codex = delete_session_command(
            Harness::Codex,
            "/h/.codex/sessions/r-abc.jsonl",
            "abc",
            "opencode",
        );
        let codex = codex.unwrap();
        assert!(
            codex.contains("rm -f -- '/h/.codex/sessions/r-abc.jsonl' || exit 1"),
            "{codex}"
        );
        // The app's own sidecar record goes with the session.
        assert!(
            codex.contains(
                "rm -rf -- \
                 \"${XDG_DATA_HOME:-$HOME/.local/share}/pabloagent/session-meta/codex-abc\" \
                 || exit 1"
            ),
            "{codex}"
        );

        let claude = delete_session_command(
            Harness::Claude,
            "/h/.claude/projects/-w/id.jsonl",
            "id",
            "opencode",
        );
        let claude = claude.unwrap();
        assert!(
            claude.contains("rm -f -- '/h/.claude/projects/-w/id.jsonl' || exit 1"),
            "{claude}"
        );
        assert!(
            claude.contains("rm -rf -- '/h/.claude/projects/-w/id' || exit 1"),
            "{claude}"
        );
        assert!(
            claude.contains("rm -f -- '/h/.claude/projects/-w/id.jsonl.rewind-bak' || exit 1"),
            "{claude}"
        );
        assert!(
            claude.contains("rm -rf -- '/h/.claude/session-env/id' || exit 1"),
            "{claude}"
        );
        assert!(
            codex.contains("rm -f -- '/h/.codex/sessions/r-abc.jsonl.rewind-bak' || exit 1"),
            "{codex}"
        );
        assert!(!codex.contains("session-env"), "{codex}");
        // A transcript outside a `projects` tree names no environment record.
        let flat =
            delete_session_command(Harness::Claude, "/h/id.jsonl", "id", "opencode").unwrap();
        assert!(!flat.contains("session-env"), "{flat}");

        // opencode names its sessions after their ids; anything else is not one.
        assert!(
            delete_session_command(Harness::Opencode, "/x/rollout-a.jsonl", "a", "opencode")
                .is_err()
        );
        // A path that is not a session file is refused before any shell runs.
        assert!(delete_session_command(Harness::Codex, "relative.jsonl", "a", "opencode").is_err());
        assert!(delete_session_command(Harness::Pi, "/etc/passwd", "a", "opencode").is_err());
    }

    #[test]
    fn a_delete_that_removed_nothing_exits_non_zero() {
        for (what, harness, path, id) in [
            ("codex", Harness::Codex, "/h/s/r-abc.jsonl", "abc"),
            ("claude", Harness::Claude, "/h/p/-w/id.jsonl", "id"),
            ("idless", Harness::Codex, "/h/s/r-abc.jsonl", ""),
            (
                "opencode",
                Harness::Opencode,
                "/h/.cache/pabloagent/opencode/ses_abc123.jsonl",
                "",
            ),
        ] {
            let cmd = delete_session_command(harness, path, id, "opencode").unwrap();
            for line in cmd.lines().filter(|l| l.starts_with("rm ")) {
                assert!(line.ends_with(" || exit 1"), "{what}: {line}");
            }
            assert!(
                cmd.ends_with(&format!(
                    "if [ -e '{path}' ]; then\n\
                     \tprintf 'the server still has %s after removing it\\n' '{path}' >&2\n\
                     \texit 1\n\
                     fi"
                )),
                "{what}: a delete must prove the file is gone: {cmd}"
            );
        }
        // The path reaches the message as a quoted argument, never as shell.
        let hostile =
            delete_session_command(Harness::Codex, "/h/$(id).jsonl", "abc", "opencode").unwrap();
        assert!(!hostile.contains("\"the server"), "{hostile}");
        assert!(hostile.contains("'/h/$(id).jsonl' >&2"), "{hostile}");
    }

    #[test]
    fn an_opencode_delete_goes_through_its_own_cli() {
        let sid = "ses_05045079cffe3XjhRn27W8hZuU";
        let path = format!("/h/.cache/pabloagent/opencode/{sid}.jsonl");
        let cmd = delete_session_command(Harness::Opencode, &path, "", "/opt/opencode").unwrap();
        assert!(
            cmd.contains(&format!(
                "bash -lc 'exec \"$0\" session delete \"$1\"' '/opt/opencode' '{sid}' || exit 1"
            )),
            "{cmd}"
        );
        assert!(
            cmd.contains("bash -lc 'exec \"$0\" db \"$1\" --format tsv' '/opt/opencode'"),
            "{cmd}"
        );
        assert!(
            cmd.contains("SELECT count(*) AS n FROM session WHERE id=")
                && cmd.contains("\"$n\" != 0"),
            "the row must be counted after the delete: {cmd}"
        );
        let guard = cmd.find("PT_BUSY").unwrap();
        let delete = cmd.find("session delete").unwrap();
        let count = cmd.find("SELECT count(*)").unwrap();
        let file = cmd.find("rm -f -- ").unwrap();
        assert!(guard < delete && delete < count && count < file, "{cmd}");
        // The id is the file's name, so the lock and the sidecar are found
        // without one being passed.
        assert!(cmd.contains(&format!("$r/locks/opencode-{sid}")), "{cmd}");
        assert!(cmd.contains(&format!("[ \"$ro\" = '{path}' ]")), "{cmd}");
        assert!(
            cmd.contains(&format!("session-meta/opencode-{sid}\" || exit 1")),
            "{cmd}"
        );
        // The file is this app's render of the row and goes with it; there is
        // never a rewind backup to take.
        assert!(
            cmd.contains(&format!("rm -f -- '{path}' || exit 1")),
            "{cmd}"
        );
        assert!(!cmd.contains("rewind-bak"), "{cmd}");
        assert!(delete_session_command(
            Harness::Opencode,
            "/h/x/rollout-abc.jsonl",
            "",
            "opencode"
        )
        .is_err());
    }

    #[test]
    fn changing_a_session_is_guarded_by_the_turn_locks() {
        let del =
            delete_session_command(Harness::Claude, "/h/p/-w/id.jsonl", "s-1", "opencode").unwrap();
        let rew = rewind_session_command(Harness::Pi, "/h/s/w/1_s-1.jsonl", 3, 9, "s-1").unwrap();

        for (what, cmd) in [("delete", &del), ("rewind", &rew)] {
            assert!(
                cmd.contains("/pabloagent\""),
                "{what} must resolve the cache root: {cmd}"
            );
            assert!(
                cmd.contains("PT_BUSY"),
                "{what} must refuse in the marker: {cmd}"
            );
            assert!(
                cmd.contains("$r/turns"),
                "{what} must scan live turns: {cmd}"
            );
            assert!(
                cmd.contains("tmux has-session -t \"pabloagent-$1\""),
                "{what} must decide liveness as turn.sh does: {cmd}"
            );
            assert!(
                cmd.contains("-mmin +1"),
                "{what} must treat a just-claimed turn as live: {cmd}"
            );
        }
        // The lock's name is the one `claim_session` mkdirs, per harness.
        assert!(del.contains("$r/locks/claude-s-1"), "{del}");
        assert!(rew.contains("$r/locks/pi-s-1"), "{rew}");
        // Delete and rewind know the session's path too, so a first turn that
        // has resolved its rollout but taken no lock is matched on that.
        assert!(del.contains("[ \"$ro\" = '/h/p/-w/id.jsonl' ]"), "{del}");
        assert!(rew.contains("[ \"$ro\" = '/h/s/w/1_s-1.jsonl' ]"), "{rew}");
        // Both read the rollout regardless, because a live turn that has
        // not yet named its session is one neither of them may clear.
        for (what, cmd) in [("delete", &del), ("rewind", &rew)] {
            assert!(cmd.contains("$td0/rollout"), "{what}: {cmd}");
            assert!(
                cmd.contains("if [ -z \"$ro\" ] && [ -z \"$id\" ]; then"),
                "{what} must treat an unplaceable live turn as busy: {cmd}"
            );
        }
        // The guard runs before anything it protects.
        assert!(
            rew.find("PT_BUSY").unwrap() < rew.find("rewind-bak").unwrap(),
            "{rew}"
        );

        // An id that could not be a lock directory's name never becomes one.
        assert!(
            delete_session_command(Harness::Codex, "/h/s/r.jsonl", "../../x", "opencode").is_err()
        );
        assert!(rewind_session_command(Harness::Codex, "/h/s/r.jsonl", 1, 9, "a b").is_err());

        // A session whose header would not parse has no id, and is guarded by
        // its path alone rather than refused.
        let idless =
            delete_session_command(Harness::Codex, "/h/s/r.jsonl", "", "opencode").unwrap();
        assert!(idless.contains("$td0/rollout"), "{idless}");
        assert!(!idless.contains("$r/locks/"), "{idless}");
    }

    #[test]
    fn a_busy_refusal_is_read_back_as_the_turn_in_the_way() {
        assert_eq!(
            refused_because_busy("PT_BUSY\tturnkey01\n"),
            Some("turnkey01")
        );
        assert_eq!(refused_because_busy(""), None);
        assert_eq!(refused_because_busy("{\"result\":{}}\n"), None);
        // A turn key is required: an empty marker line is not a refusal anyone
        // could act on, and reporting it would blame no turn at all.
        assert_eq!(refused_because_busy("PT_BUSY\t\n"), None);
        // And the marker is the whole field, not a prefix of one.
        assert_eq!(refused_because_busy("PT_BUSYISH\tturnkey01\n"), None);
        assert!(busy_session_message("deleted", "turnkey01").contains("turnkey01"));
        assert!(busy_session_message("deleted", "turnkey01").contains("cannot be deleted"));
    }

    #[test]
    fn rewind_cuts_the_file_and_guards_its_inputs() {
        let cmd = rewind_session_command(
            Harness::Claude,
            "/h/.claude/projects/-w/id.jsonl",
            12,
            17,
            "id",
        );
        let cmd = cmd.unwrap();
        assert!(cmd.contains("f='/h/.claude/projects/-w/id.jsonl'"), "{cmd}");
        assert!(cmd.contains("-ne 17"), "{cmd}");
        assert!(cmd.contains("head -n 12"), "{cmd}");
        assert!(cmd.contains("$f.rewind-bak"), "{cmd}");
        assert!(cmd.contains("mv -- \"$f.rewind-tmp\" \"$f\""), "{cmd}");

        assert!(rewind_session_command(Harness::Opencode, "/x/ses_a.jsonl", 3, 5, "a").is_err());
        assert!(rewind_session_command(Harness::Codex, "relative.jsonl", 3, 5, "a").is_err());
        assert!(rewind_session_command(Harness::Pi, "/etc/passwd", 3, 5, "a").is_err());
        assert!(rewind_session_command(Harness::Codex, "/h/s/r.jsonl", 0, 5, "a").is_err());
        assert!(rewind_session_command(Harness::Codex, "/h/s/r.jsonl", 5, 5, "a").is_err());
    }

    #[test]
    fn read_remote_file_guards_size_and_shape() {
        let cmd = read_remote_file_command("/work/chart's.png").unwrap();
        assert!(cmd.contains(r"'/work/chart'\''s.png'"), "{cmd}");
        assert!(cmd.contains("PT_SIZE"), "{cmd}");
        assert!(cmd.contains("PT_TOOBIG"), "{cmd}");
        assert!(cmd.contains(&REMOTE_FILE_MAX_BYTES.to_string()), "{cmd}");
        assert!(read_remote_file_command("relative/chart.png").is_err());
        assert!(read_remote_file_command("").is_err());
    }

    #[test]
    fn download_streams_raw_bytes_behind_one_header_line() {
        let cmd = download_remote_file_command("/build/app's release.apk").unwrap();
        assert!(cmd.contains(r"'/build/app'\''s release.apk'"), "{cmd}");
        assert!(cmd.contains("PT_BYTES"), "{cmd}");
        assert!(cmd.contains("PT_NOTFILE"), "{cmd}");
        assert!(cmd.contains("PT_TOOBIG"), "{cmd}");
        assert!(
            cmd.contains(&REMOTE_DOWNLOAD_MAX_BYTES.to_string()),
            "{cmd}"
        );
        assert!(!cmd.contains("base64"), "a download is raw bytes: {cmd}");
        assert!(
            cmd.trim_end().ends_with("exec cat \"$p\""),
            "nothing may print after the file: {cmd}"
        );
        assert!(download_remote_file_command("build/app.apk").is_err());
        assert!(download_remote_file_command("").is_err());
    }

    #[test]
    fn the_size_probe_is_the_download_command_without_the_file() {
        let path = "/build/app's release.apk";
        let probe = remote_file_size_command(path).unwrap();
        let download = download_remote_file_command(path).unwrap();
        assert_eq!(
            download.trim_end(),
            format!("{}\nexec cat \"$p\"", probe.trim_end()),
            "probe:\n{probe}\n\ndownload:\n{download}"
        );
        assert!(!probe.contains("cat"), "a probe fetches nothing: {probe}");
        assert!(remote_file_size_command("build/app.apk").is_err());
        assert!(remote_file_size_command("").is_err());
    }

    #[test]
    fn pretty_formatting_happens_on_the_server_and_names_the_copy() {
        let cmd = pretty_session_command("/home/me/.claude/projects/p/it's.jsonl").unwrap();
        assert!(
            cmd.contains(r"'/home/me/.claude/projects/p/it'\''s.jsonl'"),
            "{cmd}"
        );
        assert!(cmd.contains("command -v jq"), "{cmd}");
        assert!(cmd.contains("PT_NOJQ"), "{cmd}");
        assert!(cmd.contains("PT_PRETTY"), "{cmd}");
        assert!(cmd.contains("mktemp -d"), "{cmd}");
        assert!(pretty_session_command("relative/session.jsonl").is_err());
        assert!(pretty_session_command("").is_err());

        let (path, size) = parse_pretty_session(
            "PT_PRETTY\t4096\t/tmp/pabloagent-pretty.aB1/it's.pretty.json",
            "/s.jsonl",
        )
        .unwrap();
        assert_eq!(path, "/tmp/pabloagent-pretty.aB1/it's.pretty.json");
        assert_eq!(size, 4096);

        let missing = parse_pretty_session("PT_NOJQ", "/s.jsonl").unwrap_err();
        assert!(missing.contains("jq is not installed"), "{missing}");
        assert!(parse_pretty_session("PT_NOTFILE", "/s.jsonl").is_err());
        assert!(parse_pretty_session("PT_JQFAIL\tparse error", "/s.jsonl")
            .unwrap_err()
            .contains("parse error"));
        assert!(parse_pretty_session("", "/s.jsonl").is_err());
    }

    #[test]
    fn an_unknown_record_prefix_is_ignored() {
        let id = "019fac00-0000-7000-8000-000000000001";
        let output = format!(
            "PT_S\tcodex\t10\t/h/rollout-{id}.jsonl\n\
             PT_M\t{{\"timestamp\":\"2026-07-31T00:00:00Z\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"/work\"}}}}\n\
             PT_P\t{{\"payload\":{{\"message\":\"Original prompt\"}}}}\n\
             PT_N\t{{\"id\":91,\"result\":{{\"data\":[{{\"id\":\"{id}\",\"name\":\"Saved name\"}}]}}}}\n"
        );
        let sessions = parse_sessions(&output);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, None);
        assert_eq!(sessions[0].preview, "Original prompt");
    }

    #[test]
    fn a_session_id_falls_back_to_the_filename() {
        assert_eq!(
            id_from_path("/h/.codex/sessions/2026/07/29/rollout-2026-07-29T16-48-43-019faca1-f70d-7980-ae44-c61b58456a91.jsonl"),
            "019faca1-f70d-7980-ae44-c61b58456a91"
        );
        // claude names the file after the session id and nothing else.
        assert_eq!(
            id_from_path(
                "/h/.claude/projects/-home-me-project/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl"
            ),
            "e60d9da3-971b-4f4e-961e-43d51c20e3ae"
        );
        // An opencode cache file is named after the `ses_…` id itself.
        assert_eq!(
            id_from_path("/h/.cache/pabloagent/opencode/ses_05045079cffe3XjhRn27W8hZuU.jsonl"),
            "ses_05045079cffe3XjhRn27W8hZuU"
        );
        // A pi session file leads with a flattened timestamp; the id is what
        // follows the underscore.
        assert_eq!(
            id_from_path("/h/.pi/agent/sessions/--agents-adam--/2026-07-30T03-24-08-942Z_019fb10d-076e-7df4-b072-af353ac76046.jsonl"),
            "019fb10d-076e-7df4-b072-af353ac76046"
        );
        assert_eq!(id_from_path("/tmp/nonsense.jsonl"), "");
        assert_eq!(id_from_path("/tmp/ses_not!an!id.jsonl"), "");
    }

    #[test]
    fn sessions_parse_into_picker_rows() {
        let output = concat!(
            "PT_S\tcodex\t1785300000\t/h/.codex/sessions/rollout-2026-07-29T16-48-43-019faca1-f70d-7980-ae44-c61b58456a91.jsonl\n",
            r#"PT_M	{"timestamp":"2026-07-29T05:58:30.846Z","type":"session_meta","payload":{"id":"019faca1-f70d-7980-ae44-c61b58456a91","cwd":"/home/me/project","cli_version":"0.145.0"}}"#,
            "\n",
            r#"PT_P	{"type":"event_msg","payload":{"type":"user_message","message":"fix the login bug"}}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.harness, Harness::Codex);
        assert_eq!(s.id, "019faca1-f70d-7980-ae44-c61b58456a91");
        assert_eq!(s.cwd, "/home/me/project");
        assert_eq!(s.preview, "fix the login bug");
        assert_eq!(
            s.created_at_iso.as_deref(),
            Some("2026-07-29T05:58:30.846Z")
        );
        assert_eq!(s.modified_at, Some(1785300000));
        assert_eq!(s.cli_version.as_deref(), Some("0.145.0"));
    }

    #[test]
    fn a_paginated_codex_row_previews_its_item_completed_prompt() {
        let output = concat!(
            "PT_S\tcodex\t1785300000\t/h/.codex/sessions/rollout-2026-07-29T16-48-43-019faca1-f70d-7980-ae44-c61b58456a91.jsonl\n",
            r#"PT_M	{"timestamp":"2026-07-29T05:58:30.846Z","type":"session_meta","payload":{"id":"019faca1-f70d-7980-ae44-c61b58456a91","cwd":"/home/me/project","cli_version":"0.149.0","history_mode":"paginated"}}"#,
            "\n",
            r#"PT_P	{"type":"event_msg","payload":{"type":"item_completed","item":{"type": "UserMessage", "id": "01a0272d", "content": [{"type": "text", "text": "fix the login bug"}]}}}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].preview, "fix the login bug");
    }

    #[test]
    fn the_picker_mixes_both_harnesses() {
        let output = concat!(
            "PT_S\tclaude\t1785300100\t/h/.claude/projects/-home-me-project/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	{"parentUuid":null,"type":"user","cwd":"/home/me/project","sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae","version":"2.1.220","timestamp":"2026-07-29T09:26:03.130Z"}"#,
            "\n",
            r#"PT_P	{"type":"user","promptSource":"typed","message":{"role":"user","content":"add claude support"},"sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae"}"#,
            "\n",
            "PT_S\tcodex\t1785300000\t/h/.codex/sessions/rollout-2026-07-29T16-48-43-019faca1-f70d-7980-ae44-c61b58456a91.jsonl\n",
            r#"PT_M	{"timestamp":"2026-07-29T05:58:30.846Z","type":"session_meta","payload":{"id":"019faca1-f70d-7980-ae44-c61b58456a91","cwd":"/home/me/other","cli_version":"0.145.0"}}"#,
            "\n",
            r#"PT_P	{"type":"event_msg","payload":{"type":"user_message","message":"fix the login bug"}}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 2);
        let claude = &sessions[0];
        assert_eq!(claude.harness, Harness::Claude);
        assert_eq!(claude.id, "e60d9da3-971b-4f4e-961e-43d51c20e3ae");
        assert_eq!(claude.cwd, "/home/me/project");
        assert_eq!(claude.preview, "add claude support");
        assert_eq!(claude.cli_version.as_deref(), Some("2.1.220"));
        assert_eq!(
            claude.created_at_iso.as_deref(),
            Some("2026-07-29T09:26:03.130Z")
        );
        assert_eq!(sessions[1].harness, Harness::Codex);
        assert_eq!(sessions[1].cwd, "/home/me/other");
    }

    #[test]
    fn a_claude_row_carries_its_ai_title() {
        let output = concat!(
            "PT_S\tclaude\t1785300100\t/h/.claude/projects/-w/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	{"type":"user","cwd":"/w","sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae","version":"2.1.220"}"#,
            "\n",
            r#"PT_P	{"type":"user","promptSource":"typed","message":{"role":"user","content":"add claude support"}}"#,
            "\n",
            r#"PT_A	{"type":"ai-title","aiTitle":"Add Claude Code support","sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae"}"#,
            "\n",
            "PT_S\tclaude\t1785300000\t/h/.claude/projects/-w/f60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	{"type":"user","cwd":"/w","sessionId":"f60d9da3-971b-4f4e-961e-43d51c20e3ae"}"#,
            "\n",
            r#"PT_P	{"type":"user","promptSource":"typed","message":{"role":"user","content":"untitled work"}}"#,
            "\n",
            "PT_A\t\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[0].title.as_deref(),
            Some("Add Claude Code support")
        );
        assert_eq!(sessions[0].preview, "add claude support");
        assert_eq!(sessions[1].title, None);

        let cmd = list_sessions_command("opencode", false);
        assert!(cmd.contains(r#""ai-title""#), "{cmd}");
        // The title probe must stay a bounded read, never a whole-file grep.
        assert!(
            cmd.contains(
                "head -n 40 \"$path\" 2>/dev/null \
               | grep -m1 -E '\"type\"[[:space:]]*:[[:space:]]*\"ai-title\"'"
            ),
            "{cmd}"
        );
    }

    #[test]
    fn sidecar_facts_join_onto_their_session() {
        let output = concat!(
            "PT_C\tclaude-e60d9da3-971b-4f4e-961e-43d51c20e3ae\tclosed\t1785300200\n",
            "PT_C\tclaude-e60d9da3-971b-4f4e-961e-43d51c20e3ae\tread\t1785300100\n",
            "PT_C\tclaude-e60d9da3-971b-4f4e-961e-43d51c20e3ae\tlabel\tDeploy pipeline fix\n",
            "PT_C\tclaude-e60d9da3-971b-4f4e-961e-43d51c20e3ae\ttitle\tnot a number\n",
            "PT_C\tcodex-e60d9da3-971b-4f4e-961e-43d51c20e3ae\tclosed\t1785300400\n",
            "PT_C\tclaude-11111111-1111-1111-1111-111111111111\tclosed\t1785300300\n",
            "PT_S\tclaude\t1785300100\t/h/.claude/projects/-w/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	{"type":"user","cwd":"/w","sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae"}"#,
            "\n",
            "PT_S\tclaude\t1785300000\t/h/.claude/projects/-w/f60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	{"type":"user","cwd":"/w","sessionId":"f60d9da3-971b-4f4e-961e-43d51c20e3ae"}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].closed_at, Some(1785300200));
        assert_eq!(sessions[0].read_at, Some(1785300100));
        assert_eq!(sessions[0].label.as_deref(), Some("Deploy pipeline fix"));
        assert_eq!(sessions[1].closed_at, None);
        assert_eq!(sessions[1].read_at, None);
        assert_eq!(sessions[1].label, None);

        // The listing itself must ask the server for the records, label included.
        let cmd = list_sessions_command("opencode", false);
        assert!(cmd.contains("pabloagent/session-meta"), "{cmd}");
        assert!(cmd.contains("PT_C"), "{cmd}");
        assert!(cmd.contains("for k in closed read label"), "{cmd}");
    }

    fn favorite(cwd: &str) -> NewChatDefaults {
        NewChatDefaults {
            harness: "codex".into(),
            model: "gpt-5.5".into(),
            effort: "high".into(),
            cwd: cwd.into(),
            permission_mode: String::new(),
        }
    }

    fn favorite_line(favorite: &NewChatDefaults) -> String {
        let json = serde_json::to_string(favorite).unwrap();
        format!(
            "PT_F\t{}\n",
            base64::engine::general_purpose::STANDARD.encode(json)
        )
    }

    #[test]
    fn favorites_ride_along_only_on_a_full_listing() {
        let full = list_sessions_command("opencode", true);
        assert!(full.contains("pabloagent/favorites"), "{full}");
        assert!(full.contains("PT_F"), "{full}");
        let poll = list_sessions_command("opencode", false);
        assert!(!poll.contains("pabloagent/favorites"), "{poll}");
        assert!(!poll.contains("PT_F"), "{poll}");
    }

    #[test]
    fn a_favorite_is_named_by_every_field_and_nothing_else() {
        let name = favorite_name(&favorite("/home/user/project"));
        assert_eq!(name.len(), 64);
        assert!(name.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(name, favorite_name(&favorite("/home/user/project")));
        assert_ne!(name, favorite_name(&favorite("/home/user/other")));
        let mut effort = favorite("/home/user/project");
        effort.effort = "low".into();
        assert_ne!(name, favorite_name(&effort));
    }

    #[test]
    fn favorite_commands_touch_the_named_record_and_relist() {
        let f = favorite("/home/user/it's here");
        let name = favorite_name(&f);
        let save = save_favorite_command(&f).unwrap();
        assert!(
            save.contains(
                "mkdir -p -- \"${XDG_DATA_HOME:-$HOME/.local/share}/pabloagent/favorites\""
            ),
            "{save}"
        );
        assert!(
            save.contains(&format!("/pabloagent/favorites/{name}.json\"")),
            "{save}"
        );
        assert!(save.contains("| base64 -d >"), "{save}");
        assert!(!save.contains("it's"), "the record travels encoded: {save}");
        assert!(save.contains("PT_F"), "{save}");

        let delete = delete_favorite_command(&f).unwrap();
        assert!(delete.contains(&format!("rm -f -- \"${{XDG_DATA_HOME:-$HOME/.local/share}}/pabloagent/favorites/{name}.json\"")), "{delete}");
        assert!(delete.contains("PT_F"), "{delete}");

        let mut unknown = favorite("/home/user/project");
        unknown.harness = "cursor".into();
        assert!(save_favorite_command(&unknown).is_err());
        assert!(save_favorite_command(&favorite("project")).is_err());
    }

    #[test]
    fn favorite_records_are_decoded_deduplicated_and_bad_ones_skipped() {
        let mut claude = favorite("/w");
        claude.harness = "claude".into();
        claude.permission_mode = "plan".into();
        let mut unknown = favorite("/w");
        unknown.harness = "cursor".into();
        let output = format!(
            "{}{}{}PT_F\tnot base64!\nPT_F\t{}\n{}PT_S\tcodex\t1785300100\t/h/.codex/sessions/rollout-x.jsonl\n",
            favorite_line(&favorite("/home/user/project")),
            favorite_line(&claude),
            favorite_line(&favorite("/home/user/project")),
            base64::engine::general_purpose::STANDARD.encode("{\"harness\":"),
            favorite_line(&unknown),
        );
        let favorites = parse_favorites(&output);
        assert_eq!(favorites, vec![favorite("/home/user/project"), claude]);
        // The same output is what the picker reads its sessions from.
        assert!(parse_sessions(&output).is_empty());
        assert!(parse_favorites("PT_S\tcodex\t1\t/x.jsonl\n").is_empty());
    }

    #[test]
    fn sidecar_writes_are_guarded_and_open_to_every_harness() {
        let close = set_session_closed_command(Harness::Opencode, "ses_abc123DEF", true).unwrap();
        assert!(
            close.contains("session-meta/opencode-ses_abc123DEF"),
            "{close}"
        );
        assert!(close.contains("[ -e \"$d/closed\" ] ||"), "{close}");

        let reopen = set_session_closed_command(Harness::Opencode, "ses_abc123DEF", false).unwrap();
        assert!(
            reopen.contains("session-meta/opencode-ses_abc123DEF"),
            "{reopen}"
        );
        assert!(reopen.contains("rm -f -- \"$d/closed\""), "{reopen}");

        let read = mark_session_read_command(
            Harness::Claude,
            "e60d9da3-971b-4f4e-961e-43d51c20e3ae",
            1785300100,
        )
        .unwrap();
        assert!(
            read.contains("session-meta/claude-e60d9da3-971b-4f4e-961e-43d51c20e3ae"),
            "{read}"
        );
        assert!(read.contains("[ \"$cur\" -lt 1785300100 ]"), "{read}");

        assert!(set_session_closed_command(Harness::Codex, "../../etc", true).is_err());
        assert!(set_session_closed_command(Harness::Codex, "a b", true).is_err());
        assert!(set_session_closed_command(Harness::Codex, "", true).is_err());
        assert!(set_session_closed_command(Harness::Codex, "../../etc", false).is_err());
        assert!(mark_session_read_command(Harness::Codex, "abc", 0).is_err());
        assert!(mark_session_read_command(Harness::Codex, "abc", -5).is_err());

        // The record goes with its session when one is deleted; a session
        // whose id never parsed skips that line rather than failing the rm.
        let del = delete_session_command(
            Harness::Claude,
            "/h/p/-w/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl",
            "e60d9da3-971b-4f4e-961e-43d51c20e3ae",
            "opencode",
        )
        .unwrap();
        assert!(
            del.contains("session-meta/claude-e60d9da3-971b-4f4e-961e-43d51c20e3ae"),
            "{del}"
        );
        let idless =
            delete_session_command(Harness::Codex, "/h/s/r.jsonl", "", "opencode").unwrap();
        assert!(!idless.contains("session-meta"), "{idless}");
    }

    #[test]
    fn a_session_label_is_written_encoded_and_removed_when_blank() {
        let set = set_session_label_command(
            Harness::Claude,
            "e60d9da3-971b-4f4e-961e-43d51c20e3ae",
            "  Deploy\n pipeline\tfix  ",
        )
        .unwrap();
        assert!(
            set.contains("session-meta/claude-e60d9da3-971b-4f4e-961e-43d51c20e3ae"),
            "{set}"
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"Deploy pipeline fix\n");
        assert!(
            set.contains(&format!("printf %s '{encoded}' | base64 -d")),
            "{set}"
        );
        assert!(!set.contains("Deploy pipeline fix"), "{set}");

        let clear = set_session_label_command(Harness::Opencode, "ses_abc123DEF", " \n ").unwrap();
        assert!(
            clear.contains("session-meta/opencode-ses_abc123DEF"),
            "{clear}"
        );
        assert!(clear.contains("rm -f -- \"$d/label\""), "{clear}");
        assert!(!clear.contains("base64"), "{clear}");

        assert!(set_session_label_command(Harness::Codex, "a b", "x").is_err());
        assert!(set_session_label_command(Harness::Codex, "", "x").is_err());
    }

    #[test]
    fn a_pi_session_is_named_by_pi_itself_and_remembered_beside_it() {
        let path = "/h/.pi/agent/sessions/--w--/2026-07-30T03-24-08-942Z_019fb10d-076e-7df4-b072-af353ac76046.jsonl";
        let id = "019fb10d-076e-7df4-b072-af353ac76046";
        let cmd = set_pi_session_name_command("pi", path, id, "  PREVIEW\n VER1  ").unwrap();

        // The rename is a write to the session file, so it waits like the rest.
        assert!(cmd.contains(BUSY_MARKER), "{cmd}");
        assert!(cmd.contains(&format!("locks/pi-{id}")), "{cmd}");
        assert!(cmd.contains("-p --session \"$1\" --name \"$2\""), "{cmd}");
        assert!(
            cmd.contains(&format!("fi' 'pi' '{path}' 'PREVIEW VER1'")),
            "{cmd}"
        );
        // Left on stdin, pi waits for a prompt and runs it as a turn.
        assert!(cmd.contains("</dev/null"), "{cmd}");
        // The same node rule as every other one-shot pi command.
        assert!(cmd.contains("/usr/bin/node"), "{cmd}");
        // And the app's own record of that name, for when the entry pi wrote
        // has been pushed out of the tail the picker reads.
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"PREVIEW VER1\n");
        assert!(
            cmd.contains(&format!("printf %s '{encoded}' | base64 -d >\"$d/name\"")),
            "{cmd}"
        );
        assert!(cmd.contains(&format!("session-meta/pi-{id}")), "{cmd}");

        // pi refuses a blank name, so this one never reaches the server.
        assert!(set_pi_session_name_command("pi", path, id, " \n ").is_err());
        assert!(
            set_pi_session_name_command("pi", path, id, &"n".repeat(PI_SESSION_NAME_MAX + 1))
                .is_err()
        );
        assert!(set_pi_session_name_command("pi", "sessions/s.jsonl", id, "x").is_err());
        assert!(set_pi_session_name_command("pi", "/h/s.txt", id, "x").is_err());
        assert!(set_pi_session_name_command("pi", path, "a b", "x").is_err());
    }

    #[test]
    fn a_pi_row_carries_the_name_pi_recorded() {
        let output = concat!(
            "PT_C\tpi-119fb10d-076e-7df4-b072-af353ac76046\tname\tRemembered name\n",
            "PT_S\tpi\t1785300100\t/h/.pi/agent/sessions/--w--/2026-07-30T03-24-08-942Z_019fb10d-076e-7df4-b072-af353ac76046.jsonl\n",
            r#"PT_M	{"type":"session","version":3,"id":"019fb10d-076e-7df4-b072-af353ac76046","cwd":"/w"}"#,
            "\n",
            r#"PT_P	{"type":"message","message":{"role":"user","content":[{"type":"text","text":"what version is on preview"}]}}"#,
            "\n",
            r#"PT_PN	{"type":"session_info","id":"0609b17b","parentId":"6fc5eacf","name":"PREVIEW VER1"}"#,
            "\n",
            "PT_S\tpi\t1785300000\t/h/.pi/agent/sessions/--w--/2026-07-30T03-24-08-942Z_119fb10d-076e-7df4-b072-af353ac76046.jsonl\n",
            r#"PT_M	{"type":"session","version":3,"id":"119fb10d-076e-7df4-b072-af353ac76046","cwd":"/w"}"#,
            "\n",
            r#"PT_P	{"type":"message","message":{"role":"user","content":[{"type":"text","text":"unnamed work"}]}}"#,
            "\n",
            "PT_PN\t\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].title.as_deref(), Some("PREVIEW VER1"));
        assert_eq!(sessions[0].preview, "what version is on preview");
        // No entry near the tail, so the row falls back to the app's record.
        assert_eq!(sessions[1].title.as_deref(), Some("Remembered name"));

        // A prompt that quotes a session_info entry is not one: the probe reads
        // whole lines that begin with the entry, and the parse checks the type.
        assert_eq!(
            pi_session_name(
                r#"{"type":"message","message":{"content":"{\"type\":\"session_info\",\"name\":\"nope\"}"}}"#
            ),
            ""
        );
        assert_eq!(
            pi_session_name(r#"{ "type" : "session_info", "name" : "spaced out" }"#),
            "spaced out"
        );

        let cmd = list_sessions_command("opencode", false);
        assert!(cmd.contains("PT_PN"), "{cmd}");
        // The name probe must stay a bounded read, never a whole-file grep, and
        // must match the entry only where pi writes it: at the head of a line.
        assert!(
            cmd.contains(
                "tail -c 65536 \"$path\" 2>/dev/null \
               | grep -E '^\\{[[:space:]]*\"type\"[[:space:]]*:[[:space:]]*\"session_info\"' \
               | tail -n 1"
            ),
            "{cmd}"
        );
        assert!(cmd.contains("for k in closed read label name"), "{cmd}");
    }

    #[test]
    fn draft_prompt_commands_quote_the_directory_and_the_name() {
        let save = save_draft_prompt_command("~/my drafts", "fix-the-build", "---\n---\n").unwrap();
        assert!(save.contains("d=\"$HOME\"/'my drafts'"), "{save}");
        assert!(save.contains("f='fix-the-build'"), "{save}");
        assert!(save.contains("base64 -d >\"$d/$f.md\""), "{save}");

        let default = list_draft_prompts_command(" ").unwrap();
        assert!(default.contains("pabloagent/draft"), "{default}");
        assert!(default.contains("-name '*.md'"), "{default}");
        assert!(default.contains("-name '*.txt'"), "{default}");
        // Any depth, with the path relative to the drafts directory.
        assert!(!default.contains("-maxdepth"), "{default}");
        assert!(default.contains("%P"), "{default}");

        assert!(save_draft_prompt_command("relative/dir", "abc-1", "x").is_err());
    }

    #[test]
    fn a_draft_name_is_quoted_rather_than_held_to_an_alphabet() {
        for name in [
            "my_notes",
            "release notes v2",
            "a'b",
            "ünïcode",
            "project1/tasks/fix-bug",
        ] {
            let del = delete_draft_prompt_command("/tmp/drafts", name).unwrap();
            assert!(
                del.contains(&format!("rm -f -- \"$d\"/{}", quote(&format!("{name}.md")))),
                "{del}"
            );
        }

        for bad in [
            "",
            "../oops",
            "a/../b",
            ".hidden",
            "x..y",
            "a/.hidden",
            "/rooted",
            "a//b",
            "trailing/",
            "line\nbreak",
        ] {
            assert!(
                delete_draft_prompt_command("/tmp/drafts", bad).is_err(),
                "{bad} was accepted"
            );
            assert!(
                save_draft_prompt_command("/tmp/drafts", bad, "x").is_err(),
                "{bad} was accepted"
            );
        }

        let del = delete_draft_prompt_command("/tmp/dr'afts", "abc-1").unwrap();
        assert!(del.contains(r#"d='/tmp/dr'\''afts'"#), "{del}");
    }

    #[test]
    fn a_saved_draft_refuses_a_name_already_taken() {
        let save = save_draft_prompt_command("/tmp/drafts", "a/b", "x").unwrap();
        assert!(save.contains("[ -e \"$d/$f.md\" ]"), "{save}");
        assert!(
            save.contains("mkdir -p -- \"$(dirname -- \"$d/$f.md\")\""),
            "{save}"
        );
        assert!(save.contains("set -C"), "{save}");

        assert!(draft_save_conflict("PT_DE\n"));
        assert!(draft_save_conflict("noise\nPT_DE\n"));
        assert!(!draft_save_conflict("nothing here\n"));
    }

    #[test]
    fn a_renamed_draft_checks_both_names_before_moving() {
        let cmd = rename_draft_prompt_command("~/drafts", "old name", "new/na'me").unwrap();
        assert!(cmd.contains("d=\"$HOME\"/'drafts'"), "{cmd}");
        assert!(cmd.contains("f='old name'"), "{cmd}");
        assert!(cmd.contains(r#"t='new/na'\''me'"#), "{cmd}");
        assert!(cmd.contains("[ ! -f \"$d/$f.md\" ]"), "{cmd}");
        assert!(cmd.contains("[ -e \"$d/$t.md\" ]"), "{cmd}");
        assert!(
            cmd.contains("mkdir -p -- \"$(dirname -- \"$d/$t.md\")\""),
            "{cmd}"
        );
        assert!(cmd.contains("mv -- \"$d/$f.md\" \"$d/$t.md\""), "{cmd}");

        assert!(rename_draft_prompt_command("/tmp/drafts", "../oops", "fine").is_err());
        assert!(rename_draft_prompt_command("/tmp/drafts", "fine", ".hidden").is_err());

        assert!(draft_rename_missing("PT_DM\n"));
        assert!(!draft_rename_missing("PT_DE\n"));
    }

    #[test]
    fn draft_prompt_listing_round_trips_a_whole_markdown_file() {
        let text = "---\ntitle: Fix the build\n---\n\ndo it\n\n---\n\nnow\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let output = format!(
            "PT_DP\tfix-the-build.md\t{encoded}\n\
             PT_DP\tplain-prompt.txt\t{encoded}\n\
             PT_DP\tno-encoding\n\
             PT_DP\tstale.json\t{encoded}\n\
             noise\n"
        );
        let drafts = parse_draft_prompts(&output);
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].id, "fix-the-build");
        assert_eq!(drafts[0].text, text);
        assert!(!drafts[0].read_only);
        assert_eq!(drafts[1].id, "plain-prompt");
        assert_eq!(drafts[1].text, text);
        assert!(drafts[1].read_only);
    }

    #[test]
    fn a_pi_row_reads_its_header_and_first_user_message() {
        let output = concat!(
            "PT_S\tpi\t1785381865\t/h/.pi/agent/sessions/--tmp-x--/2026-07-30T03-24-08-942Z_019fb10d-076e-7df4-b072-af353ac76046.jsonl\n",
            r#"PT_M	{"type":"session","version":3,"id":"019fb10d-076e-7df4-b072-af353ac76046","timestamp":"2026-07-30T03:24:08.942Z","cwd":"/tmp/x"}"#,
            "\n",
            r#"PT_P	{"type":"message","id":"1d50a8a4","parentId":"aa54ca72","timestamp":"2026-07-30T03:24:08.987Z","message":{"role":"user","content":[{"type":"text","text":"fix the login bug"}],"timestamp":1785381848986}}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.harness, Harness::Pi);
        assert_eq!(s.id, "019fb10d-076e-7df4-b072-af353ac76046");
        assert_eq!(s.cwd, "/tmp/x");
        assert_eq!(s.preview, "fix the login bug");
        assert_eq!(
            s.created_at_iso.as_deref(),
            Some("2026-07-30T03:24:08.942Z")
        );
        assert_eq!(s.modified_at, Some(1785381865));
        // pi's `version` is the session *format* version, not a CLI version.
        assert_eq!(s.cli_version, None);
    }

    #[test]
    fn an_opencode_row_reads_its_title_as_the_preview() {
        let output = concat!(
            "PT_S\topencode\t1785359837\t/h/.cache/pabloagent/opencode/ses_05043a45cfferzj2RJZiIJWoq3.jsonl\n",
            r#"PT_M	{"sessionId":"ses_05043a45cfferzj2RJZiIJWoq3","cwd":"/home/me/project","timestamp":"2026-07-29T21:16:24.867Z","version":"1.18.8","title":"Fix the login bug"}"#,
            "\n",
            r#"PT_P	{"sessionId":"ses_05043a45cfferzj2RJZiIJWoq3","cwd":"/home/me/project","timestamp":"2026-07-29T21:16:24.867Z","version":"1.18.8","title":"Fix the login bug"}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.harness, Harness::Opencode);
        assert_eq!(s.id, "ses_05043a45cfferzj2RJZiIJWoq3");
        assert_eq!(s.cwd, "/home/me/project");
        assert_eq!(s.preview, "Fix the login bug");
        assert_eq!(s.cli_version.as_deref(), Some("1.18.8"));
        assert_eq!(
            s.created_at_iso.as_deref(),
            Some("2026-07-29T21:16:24.867Z")
        );
        assert_eq!(s.modified_at, Some(1785359837));
    }

    #[test]
    fn reading_a_session_builds_the_right_command_per_harness() {
        let tail = read_rollout_command(Harness::Codex, "/s/rollout-x.jsonl", 5, "opencode")
            .expect("a plain tail");
        assert_eq!(
            tail,
            format!("tail -n +5 '/s/rollout-x.jsonl' | head -c {SESSION_READ_BYTE_CAP}")
        );

        let oc = read_rollout_command(
            Harness::Opencode,
            "/h/.cache/pabloagent/opencode/ses_05043a45cfferzj2RJZiIJWoq3.jsonl",
            3,
            "/opt/opencode",
        )
        .expect("a render-then-tail");
        assert!(oc.contains("'/opt/opencode'"), "{oc}");
        assert!(oc.contains("ses_05043a45cfferzj2RJZiIJWoq3"), "{oc}");
        assert!(oc.contains("--format tsv"), "{oc}");
        assert!(oc.contains("tail -n +3"), "{oc}");
        assert!(
            oc.contains(&format!("head -c {SESSION_READ_BYTE_CAP}")),
            "an opencode read pages like everyone else: {oc}"
        );
        assert!(
            oc.contains("mv \"$p.tmp\" \"$p\""),
            "the render must be atomic so a poll cannot read half of one: {oc}"
        );

        let bad = read_rollout_command(
            Harness::Opencode,
            "/tmp/ses_x'; DROP--.jsonl",
            1,
            "opencode",
        );
        assert!(bad.is_err(), "an id outside the alphabet must be refused");
    }

    #[test]
    fn a_row_carries_the_state_of_its_last_turn() {
        let session = |harness: &str, mt: i64, path: &str, id: &str| {
            format!(
                "PT_S\t{harness}\t{mt}\t{path}\n\
                 PT_M\t{{\"timestamp\":\"2026-07-29T05:58:30.846Z\",\"type\":\"session_meta\",\
                 \"payload\":{{\"id\":\"{id}\",\"cwd\":\"/w\"}}}}\n\
                 PT_P\t\n"
            )
        };
        let output = concat!(
            // A turn still going: no exit status, and the process is still there.
            "PT_T\tturn-live\tcodex\t1785300300\ttrue\t-\t\t/s/rollout-live.jsonl\n",
            // Finished cleanly, matched by the thread it resumed rather than by a
            // path, a resumed turn has no rollout until its first poll.
            "PT_T\tturn-resumed\tcodex\t1785300200\tfalse\t0\t00000000-0000-4000-8000-00000000000b\t\n",
            // Exited non-zero.
            "PT_T\tturn-broken\tcodex\t1785300100\tfalse\t1\t\t/s/rollout-broken.jsonl\n",
            // An older turn for the live session, which must not win.
            "PT_T\tturn-old\tcodex\t1785300000\tfalse\t0\t\t/s/rollout-live.jsonl\n",
        )
        .to_string()
            + &session("codex", 1785300300, "/s/rollout-live.jsonl", "00000000-0000-4000-8000-00000000000a")
            + &session("codex", 1785300200, "/s/rollout-resumed.jsonl", "00000000-0000-4000-8000-00000000000b")
            + &session("codex", 1785300100, "/s/rollout-broken.jsonl", "00000000-0000-4000-8000-00000000000c")
            + &session("codex", 1785300050, "/s/rollout-elsewhere.jsonl", "00000000-0000-4000-8000-00000000000d");

        let sessions = parse_sessions(&output);
        assert_eq!(sessions.len(), 4);
        let state = |i: usize| {
            (
                sessions[i].turn_state,
                sessions[i].turn_at,
                sessions[i].turn_exit_code,
            )
        };
        assert_eq!(
            state(0),
            (TurnState::Running, Some(1785300300), None),
            "a turn with no status and a live process is still running"
        );
        assert_eq!(sessions[0].turn_key.as_deref(), Some("turn-live"));
        assert_eq!(
            state(1),
            (TurnState::Succeeded, Some(1785300200), Some(0)),
            "a resumed turn is matched by its thread id, with no rollout path"
        );
        assert_eq!(state(2), (TurnState::Failed, Some(1785300100), Some(1)));
        assert_eq!(
            state(3),
            (TurnState::Unknown, None, None),
            "a session this app never ran has no status to show"
        );
        assert!(sessions[1..].iter().all(|s| s.turn_key.is_none()));
    }

    #[test]
    fn turn_status_is_scoped_to_its_harness() {
        let id = "00000000-0000-4000-8000-00000000000a";
        let output = format!(
            "PT_T\tcodex-turn\tcodex\t1785300300\ttrue\t-\t{id}\t\n\
             PT_S\tclaude\t1785300300\t/h/.claude/projects/-w/{id}.jsonl\n\
             PT_M\t{{\"type\":\"user\",\"cwd\":\"/w\",\"sessionId\":\"{id}\"}}\n\
             PT_P\t\n"
        );
        let sessions = parse_sessions(&output);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].harness, Harness::Claude);
        assert_eq!(sessions[0].turn_state, TurnState::Unknown);
        assert_eq!(sessions[0].turn_key, None);
    }

    #[test]
    fn a_turn_that_vanished_without_a_status_is_a_failure() {
        let output = concat!(
            "PT_T\tturn-x\tcodex\t1785300000\tfalse\t-\t\t/s/rollout-x.jsonl\n",
            "PT_S\tcodex\t1785300000\t/s/rollout-x.jsonl\n",
            r#"PT_M	{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-00000000000e","cwd":"/w"}}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions[0].turn_state, TurnState::Failed);
        assert_eq!(sessions[0].turn_exit_code, None);
    }

    #[test]
    fn the_list_command_reads_the_turn_records() {
        let cmd = list_sessions_command("opencode", false);
        assert!(cmd.contains("pabloagent/turns"), "{cmd}");
        assert!(cmd.contains("XDG_CACHE_HOME"), "{cmd}");
        assert!(
            cmd.contains("tmux has-session -t \"pabloagent-$key\""),
            "running must be decided as turn.sh decides it: {cmd}"
        );
        assert!(cmd.contains("PT_T"), "{cmd}");
        // Bounded, or a long-lived install pays for every turn it ever ran.
        assert!(cmd.contains(&format!("head -n {TURN_LIMIT}")), "{cmd}");
    }

    #[test]
    fn a_truncated_session_meta_still_yields_its_fields() {
        let output = concat!(
            "PT_S\tcodex\t1785300000\t/h/.codex/sessions/rollout-2026-07-29T16-48-43-019faca1-f70d-7980-ae44-c61b58456a91.jsonl\n",
            r#"PT_M	{"timestamp":"2026-07-29T09:21:40.690Z","type":"session_meta","payload":{"session_id":"019faca1-f70d-7980-ae44-c61b58456a91","cwd":"/agents/adam","originator":"codex_exec","cli_version":"0.145.0","base_instructions":{"text":"You are Codex, an agent based on GPT-5. You and the user share one workspa"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "019faca1-f70d-7980-ae44-c61b58456a91");
        assert_eq!(s.cwd, "/agents/adam");
        assert_eq!(s.cli_version.as_deref(), Some("0.145.0"));
        assert_eq!(
            s.created_at_iso.as_deref(),
            Some("2026-07-29T09:21:40.690Z")
        );
    }

    #[test]
    fn a_front_truncated_claude_header_still_yields_its_fields() {
        let output = concat!(
            "PT_S\tclaude\t1785300100\t/h/.claude/projects/-agents-adam/e60d9da3-971b-4f4e-961e-43d51c20e3ae.jsonl\n",
            r#"PT_M	 a very long prompt that ran past the cut"},"uuid":"9e275c28","timestamp":"2026-07-29T09:24:42.110Z","cwd":"/agents/adam","sessionId":"e60d9da3-971b-4f4e-961e-43d51c20e3ae","version":"2.1.220","gitBranch":"HEAD"}"#,
            "\n",
        );
        let sessions = parse_sessions(output);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "e60d9da3-971b-4f4e-961e-43d51c20e3ae");
        assert_eq!(s.cwd, "/agents/adam");
        assert_eq!(s.cli_version.as_deref(), Some("2.1.220"));
        assert_eq!(
            s.created_at_iso.as_deref(),
            Some("2026-07-29T09:24:42.110Z")
        );
    }

    #[test]
    fn a_claude_preview_reads_both_content_shapes() {
        let parts = r#"{"type":"user","promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"first part"},{"type":"text","text":"second part"}]}}"#;
        assert_eq!(claude_prompt_text(parts), "first part\nsecond part");
        assert_eq!(claude_prompt_text(r#"{"type":"user"}"#), "");
    }

    #[test]
    fn a_preview_truncated_mid_json_still_yields_text() {
        // What an 800-byte cut of a long prompt looks like: no closing brace.
        let line = r#"{"type":"event_msg","payload":{"type":"user_message","message":"line one\nline two and then it gets cut"#;
        assert_eq!(
            user_message_text(line),
            "line one\nline two and then it gets cut"
        );
        // The same, for claude's shape: the prompt is the `content` string.
        let claude = r#"{"type":"user","promptSource":"typed","message":{"role":"user","content":"a very long prompt that ran"#;
        assert_eq!(claude_prompt_text(claude), "a very long prompt that ran");
        // A quote inside the prompt must not be read as the end of it.
        let quoted = r#"{"message":{"content":"say \"hi\" twice"},"sessionId":"x"}"#;
        assert_eq!(claude_prompt_text(quoted), "say \"hi\" twice");
        // A paginated cut ends inside the item's own `text`, whose name appears
        // as a *value* first, so digging must not stop at that sighting.
        let item = r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type": "UserMessage", "content": [{"type": "text", "text": "line one\nline two and then it"#;
        assert_eq!(user_message_text(item), "line one\nline two and then it");
    }

    #[test]
    fn a_poll_separates_status_from_rollout_content() {
        let output = concat!(
            "PT_STATUS\trunning=true\texit=-\tfrom=4\n",
            "PT_THREAD\t019fac00-0000-7000-8000-000000000001\n",
            "PT_ROLLOUT\t/h/.codex/sessions/rollout-x.jsonl\n",
            "PT_STDERR\tYm9vbQ==\n",
            "PT_LINES\n",
            "{\"a\":1}\n",
            "{\"b\":2}\n",
        );
        let poll = parse_turn_poll(output).unwrap();
        assert!(poll.running);
        assert_eq!(poll.exit_code, None);
        assert_eq!(
            poll.thread_id.as_deref(),
            Some("019fac00-0000-7000-8000-000000000001")
        );
        assert_eq!(
            poll.rollout_path.as_deref(),
            Some("/h/.codex/sessions/rollout-x.jsonl")
        );
        assert_eq!(poll.stderr, "boom");
        assert_eq!(poll.line_count, 2);
        assert_eq!(poll.lines, "{\"a\":1}\n{\"b\":2}\n");
    }

    #[test]
    fn a_finished_turn_reports_its_status() {
        let poll = parse_turn_poll(
            "PT_STATUS\trunning=false\texit=0\tfrom=1\nPT_ROLLOUT\t\nPT_STDERR\t\nPT_LINES\n",
        )
        .unwrap();
        assert!(!poll.running);
        assert_eq!(poll.exit_code, Some(0));
        assert_eq!(poll.rollout_path, None);
        assert_eq!(poll.line_count, 0);
    }

    #[test]
    fn session_read_cap_matches_turn_sh() {
        assert!(
            SCRIPT.contains(&format!("head -c {SESSION_READ_BYTE_CAP}")),
            "turn.sh's poll page cap must equal SESSION_READ_BYTE_CAP"
        );
    }

    #[test]
    fn a_full_page_is_reported_as_truncated() {
        let head =
            "PT_STATUS\trunning=true\texit=-\tfrom=1\nPT_ROLLOUT\t/x\nPT_STDERR\t\nPT_LINES\n";
        let line = format!("{}\n", "x".repeat(SESSION_READ_BYTE_CAP as usize - 1));
        let poll = parse_turn_poll(&format!("{head}{line}")).unwrap();
        assert!(poll.truncated);
        assert_eq!(
            poll.line_count, 1,
            "a whole line in the page still advances"
        );

        let small = parse_turn_poll(&format!("{head}{{\"a\":1}}\n")).unwrap();
        assert!(!small.truncated);
    }

    #[test]
    fn a_half_written_final_line_is_not_counted() {
        // The cursor must not step over a line the frontend cannot parse yet.
        let poll = parse_turn_poll("PT_STATUS\trunning=true\texit=-\tfrom=1\nPT_ROLLOUT\t/x\nPT_STDERR\t\nPT_LINES\n{\"a\":1}\n{\"half\":").unwrap();
        assert_eq!(poll.line_count, 1);
        assert!(poll.lines.ends_with("{\"half\":"));
    }

    #[test]
    fn an_incomplete_or_malformed_poll_is_rejected() {
        for output in [
            "",
            "PT_STATUS\trunning=false\texit=0\tfrom=1\n",
            "PT_STATUS\trunning=maybe\texit=-\tfrom=1\nPT_LINES\n",
            "PT_STATUS\trunning=true\texit=0\tfrom=1\nPT_LINES\n",
            "PT_STATUS\trunning=true\texit=-\tfrom=nope\nPT_LINES\n",
        ] {
            assert!(
                parse_turn_poll(output).is_err(),
                "an invalid frame must not become a finished turn: {output:?}"
            );
        }
    }

    #[test]
    fn a_finished_poll_can_report_that_its_exit_status_was_lost() {
        let poll =
            parse_turn_poll("PT_STATUS\trunning=false\texit=-\tfrom=1\nPT_STDERR\t\nPT_LINES\n")
                .unwrap();
        assert!(!poll.running);
        assert_eq!(poll.exit_code, None);
    }

    #[test]
    fn the_probe_reads_back_what_the_host_has() {
        let caps = parse_probe(concat!(
            "PT_SESSIONS\t/home/me/.codex/sessions\nPT_SESSIONS_DIR_OK\n",
            "PT_PROJECTS\t/home/me/.claude/projects\nPT_PROJECTS_DIR_OK\n",
            "PT_OPENCODE_DB\t/home/me/.local/share/opencode/opencode.db\nPT_OPENCODE_DB_OK\n",
            "PT_PI_SESSIONS\t/home/me/.pi/agent/sessions\nPT_PI_SESSIONS_DIR_OK\n",
            "PT_TMUX_OK\nPT_CODEX\tcodex-cli 0.145.0\nPT_CLAUDE\t2.1.220 (Claude Code)\n",
            "PT_OPENCODE\t1.18.8\nPT_PI\t0.82.1\n",
        ));
        assert_eq!(caps.sessions_dir, "/home/me/.codex/sessions");
        assert_eq!(caps.projects_dir, "/home/me/.claude/projects");
        assert_eq!(
            caps.opencode_db,
            "/home/me/.local/share/opencode/opencode.db"
        );
        assert_eq!(caps.pi_sessions_dir, "/home/me/.pi/agent/sessions");
        assert!(caps.sessions_dir_exists && caps.projects_dir_exists && caps.opencode_db_exists);
        assert!(caps.pi_sessions_dir_exists);
        assert!(caps.tmux);
        assert_eq!(caps.codex_version.as_deref(), Some("codex-cli 0.145.0"));
        assert_eq!(
            caps.claude_version.as_deref(),
            Some("2.1.220 (Claude Code)")
        );
        assert_eq!(caps.opencode_version.as_deref(), Some("1.18.8"));
        assert_eq!(caps.pi_version.as_deref(), Some("0.82.1"));
        assert!(caps.any_harness());

        let bare = parse_probe(concat!(
            "PT_SESSIONS\t/x\nPT_SESSIONS_DIR_MISSING\nPT_PROJECTS\t/y\n",
            "PT_PROJECTS_DIR_MISSING\nPT_OPENCODE_DB\t/z\nPT_OPENCODE_DB_MISSING\n",
            "PT_PI_SESSIONS\t/w\nPT_PI_SESSIONS_DIR_MISSING\n",
            "PT_TMUX_MISSING\nPT_CODEX_MISSING\nPT_CLAUDE_MISSING\nPT_OPENCODE_MISSING\n",
            "PT_PI_MISSING\n",
        ));
        assert!(!bare.tmux);
        assert!(!bare.sessions_dir_exists && !bare.projects_dir_exists);
        assert!(!bare.opencode_db_exists);
        assert!(!bare.pi_sessions_dir_exists);
        assert_eq!(bare.codex_version, None);
        assert_eq!(bare.claude_version, None);
        assert_eq!(bare.opencode_version, None);
        assert_eq!(bare.pi_version, None);
        assert!(!bare.any_harness(), "a host with no CLI offers nothing");

        // Any one on its own is a usable host.
        let claude_only = parse_probe("PT_CODEX_MISSING\nPT_CLAUDE\t2.1.220\n");
        assert!(claude_only.any_harness());
        let opencode_only =
            parse_probe("PT_CODEX_MISSING\nPT_CLAUDE_MISSING\nPT_OPENCODE\t1.18.8\n");
        assert!(opencode_only.any_harness());
        let pi_only = parse_probe(
            "PT_CODEX_MISSING\nPT_CLAUDE_MISSING\nPT_OPENCODE_MISSING\nPT_PI\t0.82.1\n",
        );
        assert!(pi_only.any_harness());
    }

    #[test]
    fn the_stats_sample_becomes_a_percentage_per_core() {
        // Core 0 spends the window entirely busy, core 1 entirely idle, and the
        // aggregate row lands between them.
        let stats = parse_host_stats(concat!(
            "PT_CPU_A\tcpu  100 0 100 800 0 0 0 0 0 0\n",
            "PT_CPU_A\tcpu0 100 0 100 200 0 0 0 0 0 0\n",
            "PT_CPU_A\tcpu1 0 0 0 400 0 0 0 0 0 0\n",
            "PT_CPU_B\tcpu  150 0 150 900 0 0 0 0 0 0\n",
            "PT_CPU_B\tcpu0 150 0 150 200 0 0 0 0 0 0\n",
            "PT_CPU_B\tcpu1 0 0 0 500 0 0 0 0 0 0\n",
            "PT_MEM\tMemTotal:\t8000000\n",
            "PT_MEM\tMemAvailable:\t2000000\n",
            "PT_MEM\tMemFree:\t500000\n",
            "PT_MEM\tBuffers:\t100000\n",
            "PT_MEM\tCached:\t1400000\n",
            "PT_DISK\t20000000\t50000000\n",
        ));
        assert_eq!(stats.cores, vec![100.0, 0.0]);
        assert_eq!(stats.cpu, Some(50.0));
        assert_eq!(
            stats.memory,
            Some(UsageStats {
                used_kb: 6000000,
                total_kb: 8000000
            }),
            "MemAvailable is what the kernel says can be handed back"
        );
        assert_eq!(
            stats.disk,
            Some(UsageStats {
                used_kb: 20000000,
                total_kb: 50000000
            })
        );
    }

    #[test]
    fn waiting_on_a_disk_is_not_busy() {
        let stats = parse_host_stats(concat!(
            "PT_CPU_A\tcpu0 0 0 0 0 0 0 0 0 0 0\n",
            "PT_CPU_B\tcpu0 0 0 0 500 500 0 0 0 0 0\n",
        ));
        assert_eq!(stats.cores, vec![0.0]);
    }

    #[test]
    fn a_host_that_cannot_answer_reports_unknown_not_zero() {
        let nothing = parse_host_stats("");
        assert_eq!(nothing.memory, None);
        assert_eq!(nothing.cpu, None);
        assert_eq!(nothing.disk, None);
        assert!(nothing.cores.is_empty());

        let disk_only = parse_host_stats("PT_DISK\t1000\t4000\n");
        assert_eq!(disk_only.cpu, None);
        assert_eq!(
            disk_only.disk,
            Some(UsageStats {
                used_kb: 1000,
                total_kb: 4000
            })
        );

        // One sample is not a rate, and neither is a window in which no jiffy
        // moved, an idle-looking 0% would be a guess either way.
        let half = parse_host_stats("PT_CPU_A\tcpu0 1 2 3 4 5 6 7 8 0 0\n");
        assert!(half.cores.is_empty());
        let frozen = parse_host_stats(concat!(
            "PT_CPU_A\tcpu0 1 2 3 4 0 0 0 0 0 0\n",
            "PT_CPU_B\tcpu0 1 2 3 4 0 0 0 0 0 0\n",
        ));
        assert!(frozen.cores.is_empty());
    }

    #[test]
    fn memory_falls_back_to_free_plus_the_reclaimable_caches() {
        let stats = parse_host_stats(concat!(
            "PT_MEM\tMemTotal:\t8000000\n",
            "PT_MEM\tMemFree:\t500000\n",
            "PT_MEM\tBuffers:\t100000\n",
            "PT_MEM\tCached:\t1400000\n",
        ));
        assert_eq!(
            stats.memory,
            Some(UsageStats {
                used_kb: 6000000,
                total_kb: 8000000
            })
        );

        // A total with nothing to subtract from it is not a reading.
        let bare = parse_host_stats("PT_MEM\tMemTotal:\t8000000\n");
        assert_eq!(bare.memory, None);
    }

    #[test]
    fn the_stats_command_guards_every_read() {
        let cmd = host_stats_command();
        assert!(cmd.contains("[ -r /proc/stat ]"), "{cmd}");
        assert!(cmd.contains("[ -r /proc/meminfo ]"), "{cmd}");
        assert!(cmd.contains("sleep 0.3 2>/dev/null || sleep 1"), "{cmd}");
        assert!(cmd.contains("PT_CPU_A"), "{cmd}");
        assert!(cmd.contains("PT_CPU_B"), "{cmd}");
        assert!(
            cmd.contains("df -kP / 2>/dev/null"),
            "the mountpoint asked about is / itself: {cmd}"
        );
    }

    #[test]
    fn the_list_command_queries_the_opencode_db() {
        let cmd = list_sessions_command("/opt/open code", false);
        assert!(cmd.contains("'/opt/open code'"), "{cmd}");
        assert!(cmd.contains("opencode.db"), "{cmd}");
        assert!(cmd.contains("--format tsv"), "{cmd}");
        assert!(cmd.contains("PT_S\\topencode"), "{cmd}");
        assert!(
            cmd.contains("if [ -f \"$ocdb\" ]; then"),
            "a host without opencode must not fail the whole list: {cmd}"
        );
        assert!(
            cmd.contains("parent_id IS NULL"),
            "subagent child sessions are not sessions: {cmd}"
        );
        assert!(cmd.contains(&format!("LIMIT {SESSION_LIMIT}")), "{cmd}");
    }

    #[test]
    fn the_probe_forces_the_system_node_for_pi() {
        let cmd = probe_command("codex", "claude", "opencode", "pi");
        assert!(cmd.contains("/usr/bin/node"), "{cmd}");
        assert!(
            cmd.contains("#!.*node"),
            "only a script whose shebang names node is rerouted: {cmd}"
        );
        assert!(
            SCRIPT.contains("/usr/bin/node"),
            "turn.sh must launch pi the same way the probe checks it"
        );
    }

    #[test]
    fn a_pi_turn_autotrusts_the_workspace() {
        assert!(
            SCRIPT.contains("/usr/bin/node \"$pibin\" -a --mode json"),
            "the system-node path must autotrust"
        );
        assert!(
            SCRIPT.contains("\"$bin\" -a --mode json"),
            "the direct path must autotrust"
        );
    }

    #[test]
    fn the_pi_model_command_uses_the_configured_binary_and_parses_its_table() {
        let cmd = list_pi_models_command("/opt/pi agent");
        assert!(cmd.contains("'/opt/pi agent'"), "{cmd}");
        assert!(cmd.contains("--list-models"), "{cmd}");
        assert!(cmd.contains("/usr/bin/node"), "{cmd}");

        let models = parse_pi_models(
            "a harmless warning\n\
             provider      model          context  max-out  thinking  images\n\
             openai-codex  gpt-5.6-sol    272K     128K     yes       yes\n\
             openai-codex  gpt-5.6-terra  272K     128K     no        yes\n",
        );
        assert_eq!(
            models,
            vec![
                PiModel {
                    id: "openai-codex/gpt-5.6-sol".into(),
                    thinking: true,
                },
                PiModel {
                    id: "openai-codex/gpt-5.6-terra".into(),
                    thinking: false,
                },
            ]
        );
    }

    #[test]
    fn the_claude_model_command_uses_the_sdk_catalog() {
        let cmd = list_claude_models_command("/opt/claude code");
        assert!(cmd.contains("'/opt/claude code'"), "{cmd}");
        assert!(cmd.contains("--input-format stream-json"), "{cmd}");
        assert!(cmd.contains("--no-session-persistence"), "{cmd}");
        assert!(cmd.contains(r#""subtype":"initialize""#), "{cmd}");

        let models = parse_claude_models(
            r#"{"type":"control_response","response":{"subtype":"success","response":{"models":[{"value":"default","displayName":"Default (recommended)","description":"Opus 5 with 1M context · Best for everyday tasks","supportedEffortLevels":["low","high"]},{"value":"haiku","displayName":"Haiku","description":"Haiku 4.5 · Fastest for quick answers"}]}}}"#,
        );
        assert_eq!(
            models,
            vec![
                ClaudeModel {
                    id: "default".into(),
                    label: "Opus 5 with 1M context".into(),
                    efforts: vec!["low".into(), "high".into()],
                },
                ClaudeModel {
                    id: "haiku".into(),
                    label: "Haiku 4.5".into(),
                    efforts: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn the_list_command_walks_the_pi_session_tree() {
        let cmd = list_sessions_command("opencode", false);
        assert!(cmd.contains("PI_CODING_AGENT_DIR"), "{cmd}");
        assert!(cmd.contains(".pi/agent"), "{cmd}");
        assert!(
            cmd.contains("-printf 'pi\\t%T@\\t%p\\n'"),
            "pi rows must enter the merged sort: {cmd}"
        );
        assert!(
            cmd.contains(r#""role"[[:space:]]*:[[:space:]]*"user""#),
            "a pi preview is the first user message: {cmd}"
        );
    }

    #[test]
    fn a_turn_never_exposes_user_text_to_the_shell() {
        let request = TurnRequest {
            prompt: "rm -rf / ; echo '\"$(whoami)\"' `id`".into(),
            harness: Harness::Codex,
            thread_id: String::new(),
            cwd: "/home/me/my project".into(),
            model: "gpt-5".into(),
            effort: "high".into(),
            permission_mode: String::new(),
            session_id: String::new(),
        };
        let cmd = start_turn_command("abc123", &request, "codex", "claude", "opencode", "pi");
        assert!(
            !cmd.contains("whoami"),
            "the prompt must be base64, not inline: {cmd}"
        );
        assert!(!cmd.contains("my project"));
        assert!(cmd.contains("base64 -d"));
        assert!(cmd.trim_end().ends_with("start abc123"));
    }

    #[test]
    fn the_harness_picks_the_binary() {
        let request = |harness| TurnRequest {
            prompt: "hi".into(),
            harness,
            thread_id: String::new(),
            cwd: "/w".into(),
            model: String::new(),
            effort: String::new(),
            permission_mode: String::new(),
            session_id: String::new(),
        };
        let decode = |cmd: &str, file: &str| {
            // Each input is written as `printf %s '<base64>' | base64 -d >"$d/<file>"`.
            let marker = format!(">\"$d/{file}\"");
            let line = cmd
                .lines()
                .find(|l| l.ends_with(&marker))
                .unwrap_or_else(|| panic!("no line writing {file} in:\n{cmd}"));
            let encoded = line
                .split('\'')
                .nth(1)
                .expect("the payload is single quoted");
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .expect("valid base64"),
            )
            .expect("valid utf8")
        };

        let codex = start_turn_command(
            "k",
            &request(Harness::Codex),
            "/opt/codex",
            "/opt/claude",
            "/opt/opencode",
            "/opt/pi",
        );
        assert_eq!(decode(&codex, "harness"), "codex");
        assert_eq!(decode(&codex, "bin"), "/opt/codex");

        let claude = start_turn_command(
            "k",
            &request(Harness::Claude),
            "/opt/codex",
            "/opt/claude",
            "/opt/opencode",
            "/opt/pi",
        );
        assert_eq!(decode(&claude, "harness"), "claude");
        assert_eq!(decode(&claude, "bin"), "/opt/claude");

        let opencode = start_turn_command(
            "k",
            &request(Harness::Opencode),
            "/opt/codex",
            "/opt/claude",
            "/opt/opencode",
            "/opt/pi",
        );
        assert_eq!(decode(&opencode, "harness"), "opencode");
        assert_eq!(decode(&opencode, "bin"), "/opt/opencode");

        let pi = start_turn_command(
            "k",
            &request(Harness::Pi),
            "/opt/codex",
            "/opt/claude",
            "/opt/opencode",
            "/opt/pi",
        );
        assert_eq!(decode(&pi, "harness"), "pi");
        assert_eq!(decode(&pi, "bin"), "/opt/pi");
    }
}
