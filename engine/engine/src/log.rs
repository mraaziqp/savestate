//! Logging for the engine and the cores.
//!
//! A core logs through `retro_log_printf_t`, a C printf with variable
//! arguments. Stable Rust can't define a variadic function, but the Windows
//! x64 calling convention passes variadic arguments exactly like ordinary
//! ones: the first four in RCX/RDX/R8/R9 (a double also copied into its
//! integer register), the rest in 8-byte stack slots. So `core_log` declares
//! enough pointer-sized parameters to cover the arguments a log line uses and
//! formats them with a small printf of its own. Arguments a format string
//! doesn't mention are never read.
use std::ffi::{c_char, c_int, CStr};
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

static MIN_LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);
static SINK: Mutex<Option<std::fs::File>> = Mutex::new(None);
/// The last errors the core reported (a core showing its own error screen
/// still "loads"; this is how the host finds out).
static CORE_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const CORE_ERRORS_KEPT: usize = 16;

/// Errors the core has logged since the last call, oldest first.
pub fn take_core_errors() -> Vec<String> {
    std::mem::take(&mut *CORE_ERRORS.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Lowest level written (Debug shows every core message).
pub fn set_min_level(level: Level) {
    MIN_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// Also write the log to a file (the launcher shows it when a game fails).
pub fn set_file(path: &std::path::Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    Ok(())
}

pub fn emit(level: Level, source: &str, msg: &str) {
    if level == Level::Error && source == "core" {
        let mut errors = CORE_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
        if errors.len() == CORE_ERRORS_KEPT {
            errors.remove(0);
        }
        errors.push(msg.trim_end().to_string());
    }
    if (level as u8) < MIN_LEVEL.load(Ordering::Relaxed) {
        return;
    }
    let tag = match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
    };
    let line = format!("[{tag}][{source}] {}", msg.trim_end());
    let _ = writeln!(std::io::stderr(), "{line}");
    if let Some(f) = SINK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = writeln!(f, "{line}");
    }
}

#[macro_export]
macro_rules! info { ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Info, "engine", &format!($($t)*)) } }
#[macro_export]
macro_rules! warn { ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Warn, "engine", &format!($($t)*)) } }
#[macro_export]
macro_rules! error { ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Error, "engine", &format!($($t)*)) } }
#[macro_export]
macro_rules! debug { ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Debug, "engine", &format!($($t)*)) } }

/// The core's log callback (see the module comment for how it reads arguments).
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn core_log(
    level: c_int, fmt: *const c_char,
    a0: usize, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize, a6: usize,
    a7: usize, a8: usize, a9: usize, a10: usize, a11: usize, a12: usize, a13: usize,
) {
    if fmt.is_null() {
        return;
    }
    let level = match level {
        0 => Level::Debug,
        1 => Level::Info,
        2 => Level::Warn,
        _ => Level::Error,
    };
    if (level as u8) < MIN_LEVEL.load(Ordering::Relaxed) {
        return;
    }
    let args = [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13];
    let text = format_printf(CStr::from_ptr(fmt).to_bytes(), &args);
    emit(level, "core", &text);
}

/// The log callback as libretro's variadic type.
pub fn core_log_fn() -> libretro_sys::retro_log_printf_t {
    // SAFETY: on Windows x64 a variadic call passes arguments the same way as
    // a call to a function with that many integer parameters (module comment).
    unsafe {
        std::mem::transmute::<
            unsafe extern "C" fn(c_int, *const c_char, usize, usize, usize, usize, usize, usize, usize, usize, usize, usize, usize, usize, usize, usize),
            libretro_sys::retro_log_printf_t,
        >(core_log)
    }
}

/// printf formatting over raw argument words: %d %i %u %x %X %o %c %s %p %f %F %e %E %g %G %%,
/// flags (- + space 0 #), width and precision (numbers or *), lengths (hh h l ll z j t L q I64).
pub fn format_printf(fmt: &[u8], args: &[usize]) -> String {
    let mut out = String::with_capacity(fmt.len() + 16);
    let mut next = 0usize;
    let mut take = || -> usize {
        let v = if next < args.len() { args[next] } else { 0 };
        next += 1;
        v
    };
    let mut i = 0;
    while i < fmt.len() {
        let c = fmt[i];
        if c != b'%' {
            // Copy a run of plain bytes (UTF-8 kept intact).
            let start = i;
            while i < fmt.len() && fmt[i] != b'%' {
                i += 1;
            }
            out.push_str(&String::from_utf8_lossy(&fmt[start..i]));
            continue;
        }
        i += 1;
        if i >= fmt.len() {
            out.push('%');
            break;
        }
        if fmt[i] == b'%' {
            out.push('%');
            i += 1;
            continue;
        }
        let (mut left, mut plus, mut space, mut zero, mut alt) = (false, false, false, false, false);
        while i < fmt.len() {
            match fmt[i] {
                b'-' => left = true,
                b'+' => plus = true,
                b' ' => space = true,
                b'0' => zero = true,
                b'#' => alt = true,
                _ => break,
            }
            i += 1;
        }
        let mut width: Option<usize> = None;
        if i < fmt.len() && fmt[i] == b'*' {
            let w = take() as i32;
            if w < 0 {
                left = true;
                width = Some(w.unsigned_abs() as usize);
            } else {
                width = Some(w as usize);
            }
            i += 1;
        } else {
            let mut w = 0usize;
            let mut any = false;
            while i < fmt.len() && fmt[i].is_ascii_digit() {
                w = w * 10 + (fmt[i] - b'0') as usize;
                any = true;
                i += 1;
            }
            if any {
                width = Some(w);
            }
        }
        let mut precision: Option<usize> = None;
        if i < fmt.len() && fmt[i] == b'.' {
            i += 1;
            if i < fmt.len() && fmt[i] == b'*' {
                let p = take() as i32;
                precision = if p < 0 { None } else { Some(p as usize) };
                i += 1;
            } else {
                let mut p = 0usize;
                while i < fmt.len() && fmt[i].is_ascii_digit() {
                    p = p * 10 + (fmt[i] - b'0') as usize;
                    i += 1;
                }
                precision = Some(p);
            }
        }
        // Length: only the width of the integer matters (8 bytes covers all on x64).
        let mut bits = 32u32;
        while i < fmt.len() {
            match fmt[i] {
                b'h' => bits = if bits == 16 { 8 } else { 16 },
                b'l' | b'z' | b'j' | b't' | b'q' | b'L' => bits = 64,
                b'I' => {
                    if fmt[i..].starts_with(b"I64") {
                        bits = 64;
                        i += 2;
                    } else if fmt[i..].starts_with(b"I32") {
                        bits = 32;
                        i += 2;
                    } else {
                        bits = 64;
                    }
                }
                _ => break,
            }
            i += 1;
        }
        if i >= fmt.len() {
            break;
        }
        let conv = fmt[i];
        i += 1;
        let body: String = match conv {
            b'd' | b'i' => {
                let raw = take();
                let v: i64 = match bits {
                    8 => raw as i8 as i64,
                    16 => raw as i16 as i64,
                    32 => raw as i32 as i64,
                    _ => raw as i64,
                };
                let mut s = v.unsigned_abs().to_string();
                if let Some(p) = precision {
                    while s.len() < p {
                        s.insert(0, '0');
                    }
                }
                let sign = if v < 0 { "-" } else if plus { "+" } else if space { " " } else { "" };
                pad_number(sign, &s, width, left, zero && precision.is_none())
            }
            b'u' | b'x' | b'X' | b'o' => {
                let raw = take();
                let v: u64 = match bits {
                    8 => raw as u8 as u64,
                    16 => raw as u16 as u64,
                    32 => raw as u32 as u64,
                    _ => raw as u64,
                };
                let mut s = match conv {
                    b'u' => v.to_string(),
                    b'x' => format!("{v:x}"),
                    b'X' => format!("{v:X}"),
                    _ => format!("{v:o}"),
                };
                if let Some(p) = precision {
                    while s.len() < p {
                        s.insert(0, '0');
                    }
                }
                let prefix = if alt && v != 0 {
                    match conv {
                        b'x' => "0x",
                        b'X' => "0X",
                        b'o' => "0",
                        _ => "",
                    }
                } else {
                    ""
                };
                pad_number(prefix, &s, width, left, zero && precision.is_none())
            }
            b'c' => pad_text(&((take() as u8) as char).to_string(), width, left),
            b's' => {
                let p = take() as *const c_char;
                let s = if p.is_null() {
                    "(null)".to_string()
                } else {
                    // SAFETY: the core passes a NUL-terminated string for %s.
                    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
                };
                let s = match precision {
                    Some(p) => s.chars().take(p).collect(),
                    None => s,
                };
                pad_text(&s, width, left)
            }
            b'p' => pad_text(&format!("0x{:x}", take()), width, left),
            b'f' | b'F' | b'e' | b'E' | b'g' | b'G' | b'a' | b'A' => {
                let v = f64::from_bits(take() as u64);
                let p = precision.unwrap_or(6);
                let s = match conv {
                    b'f' | b'F' => format!("{:.*}", p, v.abs()),
                    b'e' => format!("{:.*e}", p, v.abs()),
                    b'E' => format!("{:.*E}", p, v.abs()),
                    _ => {
                        // %g: shortest of %e and %f at the given significant digits.
                        let p = if p == 0 { 1 } else { p };
                        let exp = if v == 0.0 { 0 } else { v.abs().log10().floor() as i32 };
                        let s = if exp < -4 || exp >= p as i32 {
                            format!("{:.*e}", p.saturating_sub(1), v.abs())
                        } else {
                            format!("{:.*}", (p as i32 - 1 - exp).max(0) as usize, v.abs())
                        };
                        if alt || !s.contains('.') { s } else { s.trim_end_matches('0').trim_end_matches('.').to_string() }
                    }
                };
                let sign = if v.is_sign_negative() && v != 0.0 { "-" } else if plus { "+" } else if space { " " } else { "" };
                pad_number(sign, &s, width, left, zero)
            }
            b'n' => {
                take();
                String::new()
            }
            other => {
                // Unknown conversion: show it as written.
                format!("%{}", other as char)
            }
        };
        out.push_str(&body);
    }
    out
}

fn pad_text(s: &str, width: Option<usize>, left: bool) -> String {
    let n = s.chars().count();
    match width {
        Some(w) if w > n => {
            let fill = " ".repeat(w - n);
            if left { format!("{s}{fill}") } else { format!("{fill}{s}") }
        }
        _ => s.to_string(),
    }
}

fn pad_number(prefix: &str, digits: &str, width: Option<usize>, left: bool, zero: bool) -> String {
    let n = prefix.len() + digits.len();
    match width {
        Some(w) if w > n => {
            if left {
                format!("{prefix}{digits}{}", " ".repeat(w - n))
            } else if zero {
                format!("{prefix}{}{digits}", "0".repeat(w - n))
            } else {
                format!("{}{prefix}{digits}", " ".repeat(w - n))
            }
        }
        _ => format!("{prefix}{digits}"),
    }
}

#[cfg(test)]
mod tests {
    use super::format_printf;
    use std::ffi::CString;

    #[test]
    fn formats_like_printf() {
        let s = CString::new("dolphin").unwrap();
        let args = [s.as_ptr() as usize, 42usize, (-7i32) as u32 as usize, 255, 1.5f64.to_bits() as usize];
        assert_eq!(format_printf(b"core %s v%d (%d) %#x %.2f\n", &args), "core dolphin v42 (-7) 0xff 1.50\n");
        assert_eq!(format_printf(b"[%5s|%-4d|%03u]", &[s.as_ptr() as usize, 9, 7]), "[dolphin|9   |007]");
        assert_eq!(format_printf(b"%lld %llu %zu %%", &[(-3i64) as usize, 12, 5]), "-3 12 5 %");
        assert_eq!(format_printf(b"%s", &[0]), "(null)");
        assert_eq!(format_printf(b"%g %g", &[0.0001f64.to_bits() as usize, 1234567.0f64.to_bits() as usize]), "0.0001 1.23457e6");
    }
}
