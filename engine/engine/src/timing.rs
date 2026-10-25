//! Frame pacing: sleeping until a deadline to within a fraction of a millisecond.
//!
//! `std::thread::sleep` on Windows rounds up to the scheduler tick (often
//! 15.6 ms, 1 ms at best), far too coarse for 60 frames a second. There this
//! uses a high-resolution waitable timer (Windows 10 1803+) for the bulk of
//! the wait and spins only the last few hundred microseconds; older systems
//! fall back to a 1 ms tick (timeBeginPeriod) plus the same short spin.
//! Linux and Android sleep precisely already (nanosleep, well under 1 ms), so
//! there the bulk is a plain sleep, then the same spin.
use std::time::Duration;

/// The part of a wait that is spun rather than slept.
const SPIN: Duration = Duration::from_micros(400);

#[cfg(windows)]
mod imp {
    use super::SPIN;
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
}

#[cfg(not(windows))]
mod imp {
    use super::SPIN;
    use std::time::Instant;

    pub struct Pacer;

    impl Pacer {
        pub fn new() -> Self {
            Pacer
        }

        /// Sleeps until `deadline` (returns at once if it has passed).
        pub fn sleep_until(&self, deadline: Instant) {
            let now = Instant::now();
            if deadline > now + SPIN {
                std::thread::sleep(deadline - now - SPIN);
            }
            while Instant::now() < deadline {
                std::hint::spin_loop();
            }
        }
    }
}

pub use imp::Pacer;

impl Default for Pacer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn sleeps_close_to_the_deadline() {
        // The pacer's precision, not the scheduler's worst moment: 9 in 10
        // sleeps within 1 ms of the deadline (another busy thread can still
        // delay the odd one, so only a gross outlier fails).
        let p = Pacer::new();
        let mut late: Vec<Duration> = (0..30)
            .map(|_| {
                let deadline = Instant::now() + Duration::from_micros(4_000);
                p.sleep_until(deadline);
                Instant::now() - deadline
            })
            .collect();
        late.sort();
        assert!(late[26] < Duration::from_millis(1), "90th percentile {:?}", late[26]);
        assert!(late[29] < Duration::from_millis(20), "worst {:?}", late[29]);
    }
}
