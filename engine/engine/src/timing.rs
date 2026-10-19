//! Frame pacing: sleeping until a deadline to within a fraction of a millisecond.
//!
//! `std::thread::sleep` on Windows rounds up to the scheduler tick (often
//! 15.6 ms, 1 ms at best), far too coarse for 60 frames a second. This uses a
//! high-resolution waitable timer (Windows 10 1803+) for the bulk of the wait
//! and spins only the last few hundred microseconds. Older systems fall back
//! to a 1 ms tick (timeBeginPeriod) plus the same short spin.
use std::ffi::c_void;
use std::time::{Duration, Instant};

#[link(name = "kernel32")]
extern "system" {
    fn CreateWaitableTimerExW(attributes: *mut c_void, name: *const u16, flags: u32, access: u32) -> *mut c_void;
    fn SetWaitableTimer(timer: *mut c_void, due: *const i64, period: i32, routine: *mut c_void, arg: *mut c_void, resume: i32) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, ms: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(ms: u32) -> u32;
    fn timeEndPeriod(ms: u32) -> u32;
}

const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION: u32 = 0x2;
const TIMER_ALL_ACCESS: u32 = 0x1F_0003;
const INFINITE: u32 = 0xFFFF_FFFF;
/// The part of a wait that is spun rather than slept.
const SPIN: Duration = Duration::from_micros(400);

pub struct Pacer {
    timer: *mut c_void,
    coarse: bool,
}

// SAFETY: the timer handle belongs to the one thread that paces.
unsafe impl Send for Pacer {}

impl Pacer {
    pub fn new() -> Self {
        let mut timer = unsafe { CreateWaitableTimerExW(std::ptr::null_mut(), std::ptr::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS) };
        let coarse = timer.is_null();
        if coarse {
            unsafe {
                timeBeginPeriod(1);
                timer = CreateWaitableTimerExW(std::ptr::null_mut(), std::ptr::null(), 0, TIMER_ALL_ACCESS);
            }
        }
        Self { timer, coarse }
    }

    /// Sleeps until `deadline` (returns at once if it has passed).
    pub fn sleep_until(&self, deadline: Instant) {
        let margin = if self.coarse { SPIN + Duration::from_millis(1) } else { SPIN };
        let now = Instant::now();
        if deadline > now + margin && !self.timer.is_null() {
            let wait = deadline - now - margin;
            // Relative due time: negative, in 100 ns units.
            let due = -((wait.as_nanos() / 100) as i64).max(1);
            unsafe {
                if SetWaitableTimer(self.timer, &due, 0, std::ptr::null_mut(), std::ptr::null_mut(), 0) != 0 {
                    WaitForSingleObject(self.timer, INFINITE);
                }
            }
        }
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
    }
}

impl Default for Pacer {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Pacer {
    fn drop(&mut self) {
        unsafe {
            if !self.timer.is_null() {
                CloseHandle(self.timer);
            }
            if self.coarse {
                timeEndPeriod(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sleeps_close_to_the_deadline() {
        let p = Pacer::new();
        let mut worst = Duration::ZERO;
        for _ in 0..20 {
            let deadline = Instant::now() + Duration::from_micros(4_000);
            p.sleep_until(deadline);
            worst = worst.max(Instant::now() - deadline);
        }
        assert!(worst < Duration::from_millis(2), "overslept by {worst:?}");
    }
}
