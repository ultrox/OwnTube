use serde_json::Value;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

// Full values, not just IDs: new uploads must not change the middle of a history page.
// No long-lived SQLite transactions and no unbounded history cache.
#[derive(Default)]
pub struct Snapshots {
    entries: VecDeque<(String, Instant, usize, Value)>,
}
impl Snapshots {
    pub fn get(&mut self, key: &str) -> Option<Value> {
        self.entries
            .retain(|e| e.1.elapsed() < Duration::from_secs(900));
        let at = self.entries.iter().position(|e| e.0 == key)?;
        let mut entry = self.entries.remove(at)?;
        entry.1 = Instant::now();
        let value = entry.3.clone();
        self.entries.push_front(entry);
        Some(value)
    }
    pub fn put(&mut self, key: String, value: Value) {
        let size = value.to_string().len();
        if size > 32 * 1024 * 1024 {
            return;
        }
        self.entries
            .retain(|e| e.0 != key && e.1.elapsed() < Duration::from_secs(900));
        while self.entries.len() >= 4
            || self.entries.iter().map(|e| e.2).sum::<usize>() + size > 32 * 1024 * 1024
        {
            self.entries.pop_back();
        }
        self.entries.push_front((key, Instant::now(), size, value));
    }
}
