use std::sync::{Arc, Mutex};

const MAX_LINES: usize = 600;

#[derive(Clone, Default)]
pub struct Diagnostics {
    lines: Arc<Mutex<Vec<String>>>,
}

impl Diagnostics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, source: &str, message: impl AsRef<str>) {
        let entry = format!("[{source}] {}", message.as_ref());
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        lines.push(entry);
        if lines.len() > MAX_LINES {
            let overflow = lines.len() - MAX_LINES;
            lines.drain(0..overflow);
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|l| l.clone())
            .unwrap_or_else(|_| vec!["<diagnostics lock poisoned>".to_string()])
    }

    pub fn clear(&self) {
        if let Ok(mut lines) = self.lines.lock() {
            lines.clear();
        }
    }

    pub fn tail(&self, n: usize) -> String {
        let lines = self.snapshot();
        let start = lines.len().saturating_sub(n);
        lines[start..].join("\n")
    }
}
