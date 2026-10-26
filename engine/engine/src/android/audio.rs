//! Sound on Android (Phase 7): an AAudio output stream at the phone's own
//! rate, fed from the emulation thread. The core's samples (32-48 kHz,
//! whatever it makes) are resampled to the stream's rate, with the ratio
//! nudged by up to 0.5% from how full the stream's buffer is, so the sound
//! neither runs dry (crackle) nor drifts behind the picture.
#![allow(non_camel_case_types)]

use std::ffi::c_void;

type aaudio_result_t = i32;
type AAudioStreamBuilder = c_void;
type AAudioStream = c_void;

const AAUDIO_FORMAT_PCM_I16: i32 = 1;
const AAUDIO_PERFORMANCE_MODE_LOW_LATENCY: i32 = 12;
const AAUDIO_OK: i32 = 0;

#[link(name = "aaudio")]
extern "C" {
    fn AAudio_createStreamBuilder(builder: *mut *mut AAudioStreamBuilder) -> aaudio_result_t;
    fn AAudioStreamBuilder_setFormat(b: *mut AAudioStreamBuilder, format: i32);
    fn AAudioStreamBuilder_setChannelCount(b: *mut AAudioStreamBuilder, channels: i32);
    fn AAudioStreamBuilder_setPerformanceMode(b: *mut AAudioStreamBuilder, mode: i32);
    fn AAudioStreamBuilder_openStream(b: *mut AAudioStreamBuilder, stream: *mut *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStreamBuilder_delete(b: *mut AAudioStreamBuilder) -> aaudio_result_t;
    fn AAudioStream_requestStart(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_requestPause(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_close(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_write(s: *mut AAudioStream, buffer: *const c_void, frames: i32, timeout_ns: i64) -> aaudio_result_t;
    fn AAudioStream_getSampleRate(s: *mut AAudioStream) -> i32;
    fn AAudioStream_getFramesPerBurst(s: *mut AAudioStream) -> i32;
    fn AAudioStream_setBufferSizeInFrames(s: *mut AAudioStream, frames: i32) -> aaudio_result_t;
    fn AAudioStream_getBufferSizeInFrames(s: *mut AAudioStream) -> i32;
    fn AAudioStream_getFramesWritten(s: *mut AAudioStream) -> i64;
    fn AAudioStream_getFramesRead(s: *mut AAudioStream) -> i64;
}

pub struct Sound {
    stream: *mut AAudioStream,
    rate: f64,
    /// Fractional read position into the core's samples, carried between calls.
    phase: f64,
    /// The last stereo frame of the previous batch (interpolation across batches).
    last: [i16; 2],
    out: Vec<i16>,
    paused: bool,
}

// SAFETY: used from the emulation thread only.
unsafe impl Send for Sound {}

impl Sound {
    pub fn open() -> Result<Self, String> {
        unsafe {
            let mut b = std::ptr::null_mut();
            if AAudio_createStreamBuilder(&mut b) != AAUDIO_OK {
                return Err("AAudio isn't available".into());
            }
            AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_I16);
            AAudioStreamBuilder_setChannelCount(b, 2);
            AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
            let mut s = std::ptr::null_mut();
            let r = AAudioStreamBuilder_openStream(b, &mut s);
            AAudioStreamBuilder_delete(b);
            if r != AAUDIO_OK || s.is_null() {
                return Err(format!("the sound stream didn't open ({r})"));
            }
            // About 4 bursts of buffer (~20-40 ms): low delay, room for one late frame.
            let burst = AAudioStream_getFramesPerBurst(s).max(64);
            AAudioStream_setBufferSizeInFrames(s, burst * 4);
            AAudioStream_requestStart(s);
            let rate = AAudioStream_getSampleRate(s).max(8000) as f64;
            crate::info!("android: sound {} Hz, buffer {} frames", rate, AAudioStream_getBufferSizeInFrames(s));
            Ok(Sound { stream: s, rate, phase: 0.0, last: [0, 0], out: Vec::new(), paused: false })
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        if paused != self.paused {
            unsafe {
                if paused { AAudioStream_requestPause(self.stream); } else { AAudioStream_requestStart(self.stream); }
            }
            self.paused = paused;
        }
    }

    /// Plays interleaved stereo `samples` made at `core_rate` Hz.
    pub fn push(&mut self, samples: &[i16], core_rate: f64) {
        if samples.len() < 2 || core_rate <= 0.0 || self.paused {
            return;
        }
        let (fill, capacity) = unsafe {
            let queued = AAudioStream_getFramesWritten(self.stream) - AAudioStream_getFramesRead(self.stream);
            (queued.max(0) as f64, AAudioStream_getBufferSizeInFrames(self.stream).max(1) as f64)
        };
        // Half full is the target: emptier -> make slightly more, fuller -> fewer.
        let deviation = ((fill / capacity) - 0.5).clamp(-0.5, 0.5);
        let ratio = core_rate / self.rate * (1.0 + deviation * 0.01);
        let frames = samples.len() / 2;
        self.out.clear();
        let at = |i: isize, ch: usize, last: &[i16; 2]| -> f64 {
            if i < 0 { last[ch] as f64 } else { samples[(i as usize).min(frames - 1) * 2 + ch] as f64 }
        };
        // Linear interpolation: position p between core frames floor(p)-1 and floor(p).
        while self.phase < frames as f64 {
            let i = self.phase.floor() as isize;
            let t = self.phase - i as f64;
            for ch in 0..2 {
                let a = at(i - 1, ch, &self.last);
                let b = at(i, ch, &self.last);
                self.out.push((a + (b - a) * t).round().clamp(-32768.0, 32767.0) as i16);
            }
            self.phase += ratio;
        }
        self.phase -= frames as f64;
        self.last = [samples[(frames - 1) * 2], samples[(frames - 1) * 2 + 1]];
        let n = (self.out.len() / 2) as i32;
        if n > 0 {
            // Never waits: if the stream is full, the rest is dropped (the
            // ratio above then makes less next time).
            unsafe { AAudioStream_write(self.stream, self.out.as_ptr() as *const c_void, n, 0) };
        }
    }
}

impl Drop for Sound {
    fn drop(&mut self) {
        unsafe { AAudioStream_close(self.stream) };
    }
}
