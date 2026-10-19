//! Sound: the core's rate to 48 kHz, with dynamic rate control.
//!
//! Cores produce sound at their console's rate (32,040 Hz SNES, 65,536 Hz
//! GBA, 131,072 Hz Game Boy in mGBA, 48,000 Hz arcade...). The page plays at
//! 48 kHz. `Resampler` is a windowed-sinc interpolator (32 taps, 512 phases,
//! linear between phases) whose cut-off follows the conversion, so
//! downsampling a Game Boy's square waves doesn't alias; the ratio can move a
//! little every frame without clicks.
//!
//! The engine runs on its own clock and the page's sound card on another;
//! left alone the page's buffer slowly fills up or runs dry. `RateControl`
//! nudges the ratio by at most ±0.5 % towards a target fill the page reports
//! (RetroArch's dynamic rate control):
//! `ratio = base * (1 + d_max * (target - fill) / target)`.

pub const OUTPUT_RATE: f64 = 48_000.0;
const HALF_TAPS: usize = 16;
const TAPS: usize = HALF_TAPS * 2;
const PHASES: usize = 512;

pub struct Resampler {
    in_rate: f64,
    /// Kernel rows for each phase, plus one extra row for interpolation.
    table: Vec<[f32; TAPS]>,
    /// Interleaved stereo input not consumed yet (with HALF_TAPS of history).
    buf: Vec<f32>,
    /// Position of the next output sample, in input frames from the start of `buf`.
    pos: f64,
}

fn kernel(cutoff: f64) -> Vec<[f32; TAPS]> {
    let mut table = vec![[0f32; TAPS]; PHASES + 1];
    for (p, row) in table.iter_mut().enumerate() {
        let frac = p as f64 / PHASES as f64;
        let mut sum = 0.0;
        let mut vals = [0f64; TAPS];
        for (k, v) in vals.iter_mut().enumerate() {
            // Distance from the output point to input sample k of the window.
            let x = k as f64 - (HALF_TAPS as f64 - 1.0) - frac;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * cutoff * x) };
            // Blackman window over the full span.
            let w = {
                let t = (x + HALF_TAPS as f64) / TAPS as f64;
                if !(0.0..=1.0).contains(&t) { 0.0 } else { 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos() + 0.08 * (4.0 * std::f64::consts::PI * t).cos() }
            };
            *v = cutoff * sinc * w;
            sum += *v;
        }
        // Unity gain at every phase (no level wobble as the phase moves).
        for (k, v) in vals.iter().enumerate() {
            row[k] = (v / sum) as f32;
        }
    }
    table
}

impl Resampler {
    pub fn new(in_rate: f64) -> Self {
        let in_rate = if in_rate > 1000.0 { in_rate } else { OUTPUT_RATE };
        // Pass up to 95 % of the lower Nyquist frequency.
        let cutoff = (OUTPUT_RATE / in_rate).min(1.0) * 0.95;
        Self { in_rate, table: kernel(cutoff), buf: vec![0.0; HALF_TAPS * 2], pos: HALF_TAPS as f64 - 1.0 }
    }

    pub fn in_rate(&self) -> f64 {
        self.in_rate
    }

    /// Converts `input` (interleaved stereo) at `adjust` x the nominal ratio
    /// (1.0 = exactly 48 kHz out), appending interleaved stereo to `out`.
    pub fn process(&mut self, input: &[i16], adjust: f64, out: &mut Vec<i16>) {
        self.buf.extend(input.iter().map(|&s| s as f32 * (1.0 / 32768.0)));
        let frames = self.buf.len() / 2;
        // Input frames per output frame.
        let step = self.in_rate / (OUTPUT_RATE * adjust);
        while (self.pos as usize) + HALF_TAPS < frames {
            let i = self.pos as usize;
            let frac = self.pos - i as f64;
            let pf = frac * PHASES as f64;
            let p = pf as usize;
            let t = (pf - p as f64) as f32;
            let (a, b) = (&self.table[p], &self.table[p + 1]);
            let start = i + 1 - HALF_TAPS;
            let (mut l, mut r) = (0f32, 0f32);
            for k in 0..TAPS {
                let w = a[k] + (b[k] - a[k]) * t;
                let s = (start + k) * 2;
                l += self.buf[s] * w;
                r += self.buf[s + 1] * w;
            }
            out.push((l * 32767.0).clamp(-32768.0, 32767.0) as i16);
            out.push((r * 32767.0).clamp(-32768.0, 32767.0) as i16);
            self.pos += step;
        }
        // Keep HALF_TAPS of history before the next output position.
        let keep_from = (self.pos as usize + 1).saturating_sub(HALF_TAPS);
        if keep_from > 0 {
            self.buf.drain(..keep_from * 2);
            self.pos -= keep_from as f64;
        }
    }
}

/// Dynamic rate control from the page's reported buffer fill.
pub struct RateControl {
    pub target_ms: f64,
    pub fill_ms: f64,
    max_deviation: f64,
}

impl RateControl {
    pub fn new(target_ms: f64) -> Self {
        Self { target_ms, fill_ms: target_ms, max_deviation: 0.005 }
    }
    /// The factor to apply to the resampling ratio now.
    pub fn adjust(&self) -> f64 {
        let e = ((self.target_ms - self.fill_ms) / self.target_ms).clamp(-1.0, 1.0);
        1.0 + self.max_deviation * e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: f64, hz: f64, seconds: f64) -> Vec<i16> {
        let n = (rate * seconds) as usize;
        (0..n).flat_map(|i| {
            let v = ((2.0 * std::f64::consts::PI * hz * i as f64 / rate).sin() * 16000.0) as i16;
            [v, v]
        }).collect()
    }

    #[test]
    fn converts_rates_and_keeps_level() {
        for rate in [32_040.0, 44_100.0, 48_000.0, 65_536.0, 131_072.0] {
            let mut r = Resampler::new(rate);
            let mut out = Vec::new();
            // Fed in frame-sized pieces, as the engine does.
            let input = tone(rate, 440.0, 1.0);
            for chunk in input.chunks((rate / 60.0) as usize * 2) {
                r.process(chunk, 1.0, &mut out);
            }
            let frames = out.len() / 2;
            assert!((frames as f64 - 48_000.0).abs() < 64.0, "{rate}: {frames} frames");
            let peak = out[4000..out.len() - 4000].iter().map(|v| v.unsigned_abs()).max().unwrap();
            assert!((15_000..=16_600).contains(&peak), "{rate}: peak {peak}");
        }
    }

    #[test]
    fn rate_control_nudges_both_ways() {
        let mut c = RateControl::new(50.0);
        c.fill_ms = 10.0;
        assert!(c.adjust() > 1.0 && c.adjust() <= 1.005);
        c.fill_ms = 90.0;
        assert!(c.adjust() < 1.0 && c.adjust() >= 0.995);
    }
}
