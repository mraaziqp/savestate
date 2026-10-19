//! Rewind: the last stretch of play kept as save states, in a fixed budget.
//!
//! Consecutive save states differ in a few bytes, so each is stored as the
//! XOR against the next one (mostly zero bytes), compressed with LZ4. The
//! newest state is kept whole. Stepping back pops the newest difference and
//! XORs it into the whole state, which gives the state before; the oldest
//! differences are dropped when the budget is full. A state of a different
//! size (some cores grow theirs) is stored whole instead of as a difference.
use std::collections::VecDeque;

pub struct Rewind {
    /// The newest state, whole.
    latest: Vec<u8>,
    /// Older states, newest last: (whole, data); data is XOR-with-the-next
    /// (whole = false) or the full state (whole = true), LZ4-compressed.
    steps: VecDeque<(bool, Vec<u8>)>,
    bytes: usize,
    budget: usize,
    scratch: Vec<u8>,
    /// Frames between captures.
    pub every: u32,
}

impl Rewind {
    pub fn new(budget_bytes: usize, every: u32) -> Self {
        Self { latest: Vec::new(), steps: VecDeque::new(), bytes: 0, budget: budget_bytes, scratch: Vec::new(), every: every.max(1) }
    }

    /// Adds the state the game is in now.
    pub fn push(&mut self, state: &[u8]) {
        if self.latest.is_empty() {
            self.latest.extend_from_slice(state);
            return;
        }
        let entry = if self.latest.len() == state.len() {
            self.scratch.clear();
            self.scratch.extend(self.latest.iter().zip(state).map(|(a, b)| a ^ b));
            (false, lz4_flex::compress_prepend_size(&self.scratch))
        } else {
            (true, lz4_flex::compress_prepend_size(&self.latest))
        };
        self.bytes += entry.1.len();
        self.steps.push_back(entry);
        self.latest.clear();
        self.latest.extend_from_slice(state);
        while self.bytes + self.latest.len() > self.budget && !self.steps.is_empty() {
            if let Some((_, d)) = self.steps.pop_front() {
                self.bytes -= d.len();
            }
        }
    }

    /// Goes one capture back; returns the state to restore, or None at the start.
    pub fn back(&mut self) -> Option<&[u8]> {
        let (whole, data) = self.steps.pop_back()?;
        self.bytes -= data.len();
        let raw = lz4_flex::decompress_size_prepended(&data).ok()?;
        if whole {
            self.latest = raw;
        } else if raw.len() == self.latest.len() {
            for (l, d) in self.latest.iter_mut().zip(&raw) {
                *l ^= d;
            }
        } else {
            return None;
        }
        Some(&self.latest)
    }

    /// The newest state kept (what stepping back starts from).
    pub fn current(&self) -> Option<&[u8]> {
        (!self.latest.is_empty()).then_some(&self.latest[..])
    }

    /// Captures that can be stepped back through.
    pub fn len(&self) -> usize {
        self.steps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes + self.latest.len()
    }

    pub fn clear(&mut self) {
        self.latest.clear();
        self.steps.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_back_through_exact_states_and_keeps_the_budget() {
        let mut r = Rewind::new(64 * 1024, 1);
        let states: Vec<Vec<u8>> = (0..200u32).map(|i| {
            let mut s = vec![0u8; 4096];
            s[(i as usize * 7) % 4096] = i as u8;
            s[100..104].copy_from_slice(&i.to_le_bytes());
            s
        }).collect();
        for s in &states {
            r.push(s);
        }
        assert!(r.bytes() <= 64 * 1024);
        let kept = r.len();
        assert!(kept > 50, "only {kept} kept");
        for i in (199 - kept..199).rev() {
            assert_eq!(r.back().unwrap(), &states[i][..], "state {i}");
        }
        assert!(r.back().is_none());
    }

    #[test]
    fn a_state_of_another_size_is_kept_whole() {
        let mut r = Rewind::new(1 << 20, 1);
        r.push(&[1, 2, 3]);
        r.push(&[1, 2, 3, 4]);
        r.push(&[9, 2, 3, 4]);
        assert_eq!(r.back().unwrap(), &[1, 2, 3, 4]);
        assert_eq!(r.back().unwrap(), &[1, 2, 3]);
    }
}
