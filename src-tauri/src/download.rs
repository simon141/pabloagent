use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::ssh::ByteSink;

const KEEP_FOR: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
pub struct Progress {
    received: AtomicU64,
    total: AtomicU64,
    active: AtomicBool,
    cancel: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressReport {
    pub received: u64,
    pub total: u64,
    pub active: bool,
}

impl Progress {
    pub fn begin(&self) -> bool {
        if self.active.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.received.store(0, Ordering::SeqCst);
        self.total.store(0, Ordering::SeqCst);
        self.cancel.store(false, Ordering::SeqCst);
        true
    }

    pub fn end(&self) {
        self.active.store(false, Ordering::SeqCst);
        self.cancel.store(false, Ordering::SeqCst);
    }

    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::SeqCst);
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn report(&self) -> ProgressReport {
        ProgressReport {
            received: self.received.load(Ordering::SeqCst),
            total: self.total.load(Ordering::SeqCst),
            active: self.active.load(Ordering::SeqCst),
        }
    }
}

pub fn dir(cache: &Path) -> Result<PathBuf, String> {
    let dir = cache.join("downloads");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot make the download directory {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            // Each download lives in its own token directory; the plain-file
            // arm covers older layouts. On Windows a directory still holding a
            // running exe refuses to go, and the next prune tries again.
            let path = entry.path();
            let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

pub fn token_dir(dir: &Path, token: &str) -> Result<PathBuf, String> {
    let sound = !token.is_empty()
        && token.len() <= 64
        && token.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !sound {
        return Err("The download token must be a UUID.".to_string());
    }
    let sub = dir.join(token);
    std::fs::create_dir_all(&sub)
        .map_err(|e| format!("cannot make the download directory {}: {e}", sub.display()))?;
    Ok(sub)
}

pub fn local_name(remote_path: &str) -> String {
    let base = remote_path.rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        // Android's own limit is 255 bytes per name; a long tail is worth
        // keeping over a long head because the extension lives at the end.
        let mut trimmed = cleaned;
        while trimmed.len() > 200 {
            trimmed.remove(0);
        }
        trimmed
    }
}

pub struct Download<'a> {
    file: std::io::BufWriter<std::fs::File>,
    path: PathBuf,
    progress: &'a Progress,
    header: Vec<u8>,
    announced: Option<Header>,
    written: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Header {
    Bytes(u64),
    NotAFile,
    TooBig(u64),
}

pub fn parse_header(line: &str) -> Result<Header, String> {
    let line = line.trim_end_matches('\r');
    if line == "PT_NOTFILE" {
        return Ok(Header::NotAFile);
    }
    if let Some(size) = line.strip_prefix("PT_TOOBIG\t") {
        return size
            .trim()
            .parse()
            .map(Header::TooBig)
            .map_err(|_| format!("the server reported an unreadable size: {size:?}"));
    }
    if let Some(size) = line.strip_prefix("PT_BYTES\t") {
        return size
            .trim()
            .parse()
            .map(Header::Bytes)
            .map_err(|_| format!("the server reported an unreadable size: {size:?}"));
    }
    Err(format!(
        "the server answered with {line:?} rather than a size"
    ))
}

const HEADER_MAX: usize = 256;

impl<'a> Download<'a> {
    pub fn create(path: PathBuf, progress: &'a Progress) -> Result<Self, String> {
        let file = std::fs::File::create(&path)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(Self {
            // 512 KiB, so a phone's flash is written in useful lumps rather
            // than once per SSH channel packet.
            file: std::io::BufWriter::with_capacity(512 * 1024, file),
            path,
            progress,
            header: Vec::new(),
            announced: None,
            written: 0,
        })
    }

    pub fn header(&self) -> Option<&Header> {
        self.announced.as_ref()
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn finish(mut self) -> Result<PathBuf, String> {
        self.file
            .flush()
            .map_err(|e| format!("cannot finish writing {}: {e}", self.path.display()))?;
        Ok(self.path)
    }

    pub fn discard(self) {
        let path = self.path.clone();
        drop(self);
        let _ = std::fs::remove_file(path);
    }

    fn take_header(&mut self, chunk: &[u8]) -> Result<usize, String> {
        let Some(nl) = chunk.iter().position(|&b| b == b'\n') else {
            self.header.extend_from_slice(chunk);
            if self.header.len() > HEADER_MAX {
                return Err(
                    "The server did not start its reply with a file size, so what it \
                     sent is not the file this app asked for."
                        .to_string(),
                );
            }
            return Ok(chunk.len());
        };
        self.header.extend_from_slice(&chunk[..nl]);
        let line = String::from_utf8_lossy(&self.header).into_owned();
        let header = parse_header(&line)?;
        if let Header::Bytes(total) = header {
            self.progress.set_total(total);
        }
        self.announced = Some(header);
        Ok(nl + 1)
    }
}

impl ByteSink for Download<'_> {
    fn write(&mut self, chunk: &[u8]) -> Result<(), String> {
        // Checked per chunk rather than per byte: a cancel takes effect within
        // one channel packet, which is as immediate as the wire allows.
        if self.progress.cancelled() {
            return Err("The download was cancelled.".to_string());
        }
        let mut rest = chunk;
        if self.announced.is_none() {
            let consumed = self.take_header(rest)?;
            rest = &rest[consumed..];
        }
        // A refusal is a header with nothing behind it. If bytes do follow one,
        // they are not a file and must not be written as one.
        match self.announced {
            Some(Header::Bytes(_)) => {}
            _ => return Ok(()),
        }
        if rest.is_empty() {
            return Ok(());
        }
        self.file
            .write_all(rest)
            .map_err(|e| format!("cannot write to {}: {e}", self.path.display()))?;
        self.written += rest.len() as u64;
        self.progress
            .received
            .store(self.written, Ordering::Relaxed);
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        self.file = std::io::BufWriter::with_capacity(
            512 * 1024,
            std::fs::File::create(&self.path)
                .map_err(|e| format!("cannot write {}: {e}", self.path.display()))?,
        );
        self.header.clear();
        self.announced = None;
        self.written = 0;
        self.progress.set_total(0);
        self.progress.received.store(0, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_says_the_size_or_why_there_is_none() {
        assert_eq!(
            parse_header("PT_BYTES\t1048576").unwrap(),
            Header::Bytes(1048576)
        );
        assert_eq!(parse_header("PT_NOTFILE").unwrap(), Header::NotAFile);
        assert_eq!(parse_header("PT_TOOBIG\t999").unwrap(), Header::TooBig(999));
        // A login banner or a shell error is not a size, and saying so is
        // better than treating the words as the first bytes of a file.
        assert!(parse_header("bash: cat: command not found").is_err());
        assert!(parse_header("PT_BYTES\tlots").is_err());
    }

    #[test]
    fn a_local_name_keeps_the_file_name_and_nothing_else() {
        assert_eq!(
            local_name("/build/outputs/app-release.apk"),
            "app-release.apk"
        );
        assert_eq!(local_name("/tmp/../../etc/passwd"), "passwd");
        assert_eq!(local_name("/tmp/"), "download");
        assert_eq!(local_name("/tmp/.bashrc"), "bashrc");
        assert_eq!(local_name("/tmp/a\nb.txt"), "a_b.txt");
        assert!(local_name(&format!("/tmp/{}.apk", "n".repeat(400))).len() <= 200);
        assert!(local_name(&format!("/tmp/{}.apk", "n".repeat(400))).ends_with(".apk"));
    }

    #[test]
    fn the_header_is_split_off_however_the_chunks_fall() {
        let dir = std::env::temp_dir().join(format!("pt-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chunked.bin");
        let progress = Progress::default();

        let mut sink = Download::create(path.clone(), &progress).unwrap();
        // "PT_BY" | "TES\t4\nab" | "cd", the header split across two chunks,
        // then the file split across two more.
        sink.write(b"PT_BY").unwrap();
        sink.write(b"TES\t4\nab").unwrap();
        sink.write(b"cd").unwrap();
        assert_eq!(sink.header(), Some(&Header::Bytes(4)));
        assert_eq!(sink.written(), 4);
        let written = sink.finish().unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"abcd");
        assert_eq!(progress.report().total, 4);
        assert_eq!(progress.report().received, 4);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_refusal_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("pt-dl-refuse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("refused.bin");
        let progress = Progress::default();

        let mut sink = Download::create(path.clone(), &progress).unwrap();
        sink.write(b"PT_NOTFILE\n").unwrap();
        assert_eq!(sink.header(), Some(&Header::NotAFile));
        assert_eq!(sink.written(), 0);
        sink.finish().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn cancelling_stops_the_transfer_at_the_next_chunk() {
        let dir = std::env::temp_dir().join(format!("pt-dl-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cancelled.bin");
        let progress = Progress::default();
        progress.begin();

        let mut sink = Download::create(path.clone(), &progress).unwrap();
        sink.write(b"PT_BYTES\t8\nabcd").unwrap();
        progress.cancel();
        assert!(
            sink.write(b"efgh").is_err(),
            "a cancel must refuse the next chunk"
        );
        sink.discard();
        assert!(!path.exists(), "a cancelled download leaves nothing behind");
    }

    #[test]
    fn only_one_download_runs_at_a_time() {
        let progress = Progress::default();
        assert!(progress.begin());
        assert!(!progress.begin());
        progress.end();
        assert!(progress.begin());
    }
}
