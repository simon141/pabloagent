//! What a turn does to `$CODEX_HOME/config.toml` before it runs codex.
//!
//! codex's workspace trust cannot be granted per invocation. It is
//! `projects."<path>".trust_level = "trusted"` in that file and only there, so
//! `turn.sh` writes the entry itself. Each test hands the script a config in
//! some shape a real host might have it in and checks both what changed and
//! what did not.
//!
//! The script runs directly rather than over SSH, because `remote_session.rs`
//! already covers the SSH hop and everything interesting here happens in one
//! function of shell. The stub CLI is a two-line `sh` script: a turn's exit
//! status is beside the point for what is being asserted.

#![cfg(unix)]

use std::path::{Path, PathBuf};

use pabloagent_lib::testing::SCRIPT;

struct Host {
    root: PathBuf,
    script: PathBuf,
    stub: PathBuf,
    turn: u32,
}

impl Host {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pt-trust-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home/.codex")).unwrap();
        std::fs::create_dir_all(root.join("ws")).unwrap();

        let script = root.join("turn.sh");
        std::fs::write(&script, SCRIPT).unwrap();
        let stub = root.join("codex-stub");
        std::fs::write(&stub, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        Self {
            root,
            script,
            stub,
            turn: 0,
        }
    }

    fn config(&self) -> PathBuf {
        self.root.join("home/.codex/config.toml")
    }

    fn read_config(&self) -> Option<String> {
        std::fs::read_to_string(self.config()).ok()
    }

    fn write_config(&self, body: &str) {
        std::fs::write(self.config(), body).unwrap();
    }

    fn workspace(&self) -> String {
        std::fs::canonicalize(self.root.join("ws"))
            .unwrap()
            .display()
            .to_string()
    }

    fn run(&mut self, harness: &str, cwd: &Path) -> String {
        self.turn += 1;
        let key = format!("trustkey{:02}", self.turn);
        let cache = self.root.join("cache");
        let dir = cache.join("pabloagent/turns").join(&key);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prompt"), "hello").unwrap();
        std::fs::write(dir.join("cwd"), cwd.display().to_string()).unwrap();
        std::fs::write(dir.join("harness"), harness).unwrap();
        std::fs::write(dir.join("bin"), self.stub.display().to_string()).unwrap();

        let status = std::process::Command::new("sh")
            .arg(&self.script)
            .arg("run")
            .arg(&key)
            .env("HOME", self.root.join("home"))
            .env("CODEX_HOME", self.root.join("home/.codex"))
            .env("XDG_CACHE_HOME", &cache)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("sh must be able to run turn.sh");
        assert!(
            status.success(),
            "the turn itself must still succeed, whatever trust did"
        );
        std::fs::read_to_string(dir.join("stderr")).unwrap_or_default()
    }

    fn run_in_workspace(&mut self) -> String {
        let ws = self.root.join("ws");
        self.run("codex", &ws)
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn entry_for(path: &str) -> String {
    format!("[projects.\"{path}\"]\ntrust_level = \"trusted\"")
}

#[test]
fn a_turn_trusts_its_workspace_in_a_config_that_did_not_exist() {
    let mut host = Host::new("fresh");
    let stderr = host.run_in_workspace();

    let config = host
        .read_config()
        .expect("the config must have been created");
    assert_eq!(
        config,
        format!("{}\n", entry_for(&host.workspace())),
        "the entry is the whole of what a turn writes — no note, no banner, \
         nothing explaining itself in somebody else's config file"
    );
    assert!(stderr.is_empty(), "and quietly: {stderr}");
}

#[test]
fn everything_already_in_the_config_survives_the_entry_being_added() {
    let mut host = Host::new("append");
    host.write_config(
        "# my own note\n\
         model = \"gpt-5-codex\"\n\
         approval_policy = \"never\"\n\
         \n\
         [projects.\"/somewhere/else\"]\n\
         trust_level = \"trusted\"\n",
    );
    host.run_in_workspace();

    let config = host.read_config().unwrap();
    for kept in [
        "# my own note",
        "model = \"gpt-5-codex\"",
        "approval_policy = \"never\"",
        "[projects.\"/somewhere/else\"]",
    ] {
        assert!(config.contains(kept), "{kept:?} must survive: {config}");
    }
    assert!(config.contains(&entry_for(&host.workspace())));
}

#[test]
fn a_second_turn_in_the_same_workspace_changes_nothing_at_all() {
    let mut host = Host::new("idempotent");
    host.run_in_workspace();
    let after_first = host.read_config().unwrap();
    host.run_in_workspace();

    assert_eq!(
        host.read_config().unwrap(),
        after_first,
        "an already trusted workspace must leave the file byte for byte alone"
    );
    assert_eq!(
        after_first.matches("trust_level").count(),
        1,
        "and certainly must not gain a second entry: {after_first}"
    );
}

#[test]
fn an_existing_entry_is_flipped_wherever_it_is_written() {
    for (name, body, expected) in [
        (
            "its own table",
            "[projects.\"{ws}\"]\ntrust_level = \"untrusted\"\nother = 1\n".to_string(),
            "trust_level = \"trusted\"",
        ),
        (
            "a dotted key at the root",
            "projects.\"{ws}\".trust_level = \"untrusted\"\nmodel = \"x\"\n".to_string(),
            "projects.\"{ws}\".trust_level = \"trusted\"",
        ),
        (
            "a dotted key under [projects]",
            "[projects]\n\"{ws}\".trust_level = \"untrusted\"\n".to_string(),
            "\"{ws}\".trust_level = \"trusted\"",
        ),
    ] {
        let mut host = Host::new("flip");
        let ws = host.workspace();
        host.write_config(&body.replace("{ws}", &ws));
        host.run_in_workspace();

        let config = host.read_config().unwrap();
        assert!(
            config.contains(&expected.replace("{ws}", &ws)),
            "{name} must be flipped in place: {config}"
        );
        assert_eq!(
            config.matches("trust_level").count(),
            1,
            "{name} must not also gain a second entry: {config}"
        );
        assert!(
            !config.contains("untrusted"),
            "{name} must not leave the old value behind: {config}"
        );
    }
}

#[test]
fn a_table_the_workspace_already_has_gains_the_line_under_its_header() {
    let mut host = Host::new("insert");
    let ws = host.workspace();
    host.write_config(&format!(
        "[projects.\"{ws}\"]\n\
         some_other_setting = 1\n\
         \n\
         [projects.\"/somewhere/else\"]\n\
         trust_level = \"trusted\"\n"
    ));
    host.run_in_workspace();

    let config = host.read_config().unwrap();
    assert!(
        config.contains(&format!(
            "[projects.\"{ws}\"]\ntrust_level = \"trusted\"\nsome_other_setting = 1\n"
        )),
        "the line belongs inside the table it is about, not after the blank \
         line that ends it: {config}"
    );
    assert!(config.contains("[projects.\"/somewhere/else\"]"));
}

#[test]
fn an_inline_projects_table_is_left_alone_and_explained() {
    let mut host = Host::new("inline");
    let ws = host.workspace();
    let body = format!("projects = {{ \"{ws}\" = {{ trust_level = \"untrusted\" }} }}\n");
    host.write_config(&body);
    let stderr = host.run_in_workspace();

    assert_eq!(host.read_config().unwrap(), body, "not one byte may change");
    assert!(
        stderr.contains("workspace trust") && stderr.contains("cannot safely edit"),
        "the turn must say it declined, on the stderr the app shows: {stderr:?}"
    );
}

#[test]
fn a_header_hiding_inside_a_multi_line_string_is_not_mistaken_for_one() {
    let mut host = Host::new("multiline");
    let ws = host.workspace();
    let body = format!("notes = \"\"\"\n[projects.\"{ws}\"]\ntrust_level = \"trusted\"\n\"\"\"\n");
    host.write_config(&body);
    host.run_in_workspace();

    let config = host.read_config().unwrap();
    assert!(config.starts_with(&body), "the string is copied untouched");
    assert!(
        config[body.len()..].contains(&entry_for(&ws)),
        "and a real entry is still added after it: {config}"
    );
}

#[test]
fn an_awkward_workspace_path_is_escaped_and_recognised_again() {
    let mut host = Host::new("awkward");
    let awkward = host.root.join("ws with \"quotes\" and a \\ backslash");
    std::fs::create_dir_all(&awkward).unwrap();
    let real = std::fs::canonicalize(&awkward)
        .unwrap()
        .display()
        .to_string();

    host.run("codex", &awkward);
    let after_first = host.read_config().unwrap();
    host.run("codex", &awkward);

    assert!(
        after_first.contains(&format!(
            "[projects.\"{}\"]",
            real.replace('\\', "\\\\").replace('"', "\\\"")
        )),
        "the path must be escaped as a basic string: {after_first}"
    );
    assert_eq!(
        host.read_config().unwrap(),
        after_first,
        "and read back as the same path, so the entry is written once"
    );
}

#[test]
fn the_other_harnesses_never_touch_the_codex_config() {
    for harness in ["claude", "opencode", "pi"] {
        let mut host = Host::new("other");
        let ws = host.root.join("ws");
        host.run(harness, &ws);
        assert!(
            host.read_config().is_none(),
            "{harness} has its own answer to trust and no business here"
        );
    }
}

#[test]
fn a_chat_with_no_workspace_of_its_own_trusts_nothing() {
    let mut host = Host::new("nocwd");
    host.run("codex", Path::new(""));
    assert!(
        host.read_config().is_none(),
        "there is no directory the user chose, so there is nothing to trust"
    );
}

#[test]
fn the_configs_own_permissions_survive_the_rewrite() {
    use std::os::unix::fs::PermissionsExt;

    let mut host = Host::new("mode");
    host.write_config("model = \"gpt-5-codex\"\n");
    std::fs::set_permissions(host.config(), std::fs::Permissions::from_mode(0o600)).unwrap();
    host.run_in_workspace();

    let mode = std::fs::metadata(host.config())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "the file must keep the mode it had");
}

#[test]
fn a_symlinked_config_stays_a_symlink() {
    let mut host = Host::new("symlink");
    let target = host.root.join("dotfiles/codex.toml");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "model = \"gpt-5-codex\"\n").unwrap();
    let _ = std::fs::remove_file(host.config());
    std::os::unix::fs::symlink(&target, host.config()).unwrap();

    host.run_in_workspace();

    assert!(
        std::fs::symlink_metadata(host.config())
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link itself must survive"
    );
    let written = std::fs::read_to_string(&target).unwrap();
    assert!(
        written.contains("model = \"gpt-5-codex\"")
            && written.contains(&entry_for(&host.workspace())),
        "and the entry must land in the file it points at: {written}"
    );
}

#[test]
fn concurrent_turns_each_get_their_entry() {
    let host = Host::new("concurrent");
    let cache = host.root.join("cache");
    let workspaces: Vec<PathBuf> = (0..6)
        .map(|i| {
            let ws = host.root.join(format!("ws{i}"));
            std::fs::create_dir_all(&ws).unwrap();
            ws
        })
        .collect();

    let started: Vec<_> = workspaces
        .iter()
        .enumerate()
        .map(|(i, ws)| {
            let key = format!("racekey{i}");
            let dir = cache.join("pabloagent/turns").join(&key);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("prompt"), "hello").unwrap();
            std::fs::write(dir.join("cwd"), ws.display().to_string()).unwrap();
            std::fs::write(dir.join("harness"), "codex").unwrap();
            std::fs::write(dir.join("bin"), host.stub.display().to_string()).unwrap();
            std::process::Command::new("sh")
                .arg(&host.script)
                .arg("run")
                .arg(&key)
                .env("HOME", host.root.join("home"))
                .env("CODEX_HOME", host.root.join("home/.codex"))
                .env("XDG_CACHE_HOME", &cache)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("sh must be able to run turn.sh")
        })
        .collect();
    for mut child in started {
        assert!(child.wait().unwrap().success());
    }

    let config = host.read_config().unwrap();
    for ws in &workspaces {
        let real = std::fs::canonicalize(ws).unwrap().display().to_string();
        assert!(
            config.contains(&entry_for(&real)),
            "every turn's workspace must be trusted, {real} is not: {config}"
        );
    }
}
