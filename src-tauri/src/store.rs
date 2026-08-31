use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSettings {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub codex_bin: String,
    pub claude_bin: String,
    pub opencode_bin: String,
    pub pi_bin: String,
    pub default_cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub algorithm: String,
    pub fingerprint: String,
    pub openssh: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChatDefaults {
    pub harness: String,
    pub model: String,
    pub effort: String,
    pub cwd: String,
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub settings: Option<SshSettings>,
    pub known_hosts: std::collections::HashMap<String, KnownHost>,
    pub last_harness: String,
    pub agent_defaults: std::collections::HashMap<String, NewChatDefaults>,
    pub transcript_filters: std::collections::HashMap<String, Vec<String>>,
    pub theme: String,
    pub chat_font_size: u8,
    pub send_on_enter: bool,
    pub maintenance_mode: bool,
    pub draft_prompts_path: String,
    // Defaulted so a state file written before favorites existed still parses;
    // a parse failure here falls back to a default state, losing the settings.
    #[serde(default)]
    pub favorites: Vec<NewChatDefaults>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            settings: None,
            known_hosts: Default::default(),
            last_harness: "codex".into(),
            agent_defaults: Default::default(),
            transcript_filters: Default::default(),
            theme: "system".into(),
            chat_font_size: 15,
            send_on_enter: false,
            maintenance_mode: false,
            draft_prompts_path: String::new(),
            favorites: Vec::new(),
        }
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create app data dir {}: {e}", dir.display()))?;
    Ok(dir.join("connection.json"))
}

pub fn load(app: &AppHandle) -> PersistedState {
    let Ok(path) = state_path(app) else {
        return PersistedState::default();
    };
    // The state contains an SSH password. Repair broad permissions on every
    // load, including files copied in from elsewhere.
    restrict_permissions(&path);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return PersistedState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(app: &AppHandle, state: &PersistedState) -> Result<(), String> {
    let path = state_path(app)?;
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| format!("cannot serialize persisted state: {e}"))?;
    write_privately(&path, raw.as_bytes())
}

fn write_privately(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let tmp = path.with_extension("json.tmp");
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        // Without the sync a rename can land before the data does, and a crash
        // then leaves a complete-looking file full of nothing.
        file.sync_all()
            .map_err(|e| format!("cannot sync {}: {e}", tmp.display()))?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    let mode = meta.permissions().mode();
    if mode & 0o077 != 0 {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

pub fn host_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pabloagent-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_write_is_atomic_owner_only_and_leaves_no_temp_file() {
        let dir = scratch_dir("write");
        let path = dir.join("connection.json");
        write_privately(&path, b"{\"first\":true}").unwrap();
        write_privately(&path, b"{\"second\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"second\":true}");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temp file must not outlive the rename"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the state file must be owner-only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_preserves_the_previous_file() {
        let dir = scratch_dir("failed");
        let path = dir.join("connection.json");
        write_privately(&path, b"{\"kept\":true}").unwrap();
        // A directory squatting on the temp path fails the write before the
        // destination is ever touched, the shape of every failure here: the
        // last valid file has to survive it.
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(write_privately(&path, b"{\"lost\":true}").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"kept\":true}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_overly_broad_existing_file_is_repaired() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("repair");
        let path = dir.join("connection.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        restrict_permissions(&path);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn current_state_round_trips() {
        let state = PersistedState {
            chat_font_size: 17,
            send_on_enter: true,
            favorites: vec![NewChatDefaults {
                harness: "codex".into(),
                model: "gpt-5.5".into(),
                effort: "high".into(),
                cwd: "/home/user/project".into(),
                permission_mode: String::new(),
            }],
            ..PersistedState::default()
        };
        let restored: PersistedState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert_eq!(restored.chat_font_size, 17);
        assert!(restored.send_on_enter);
        assert_eq!(restored.favorites, state.favorites);
    }

    #[test]
    fn a_state_file_without_favorites_still_parses() {
        let state = PersistedState::default();
        let mut json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("favorites");
        let restored: PersistedState = serde_json::from_value(json).unwrap();
        assert!(restored.favorites.is_empty());
    }
}
