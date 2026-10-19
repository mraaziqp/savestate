//! The host's copy of a game's saves, so they follow the person between PCs.
//!
//! - Battery saves (`/api/savefile/<game>`, shared with the browser player and
//!   the PS Vita app): before the game starts, the newer of this PC's and the
//!   host's copy is used (the one replaced is kept as `.srm.bak`); after each
//!   battery save the engine sends it up when it changed.
//! - Save states (`/api/engine/states/<game>/<slot>`, host keeps 5 versions
//!   of each slot): sent up after saving (LZ4-compressed, with the slot's
//!   picture); loading a slot uses the newer of the two copies; earlier
//!   versions can be listed and loaded.
//!
//! Uploads run on their own thread so the game never waits for the network;
//! with no network the game plays from this PC's copies as before.
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A slot as the host has it.
#[derive(Clone, Debug)]
pub struct HostSlot {
    pub slot: u32,
    pub version: u32,
    /// Milliseconds since 1970.
    pub saved_at: u64,
    pub device: Option<String>,
    /// PNG, base64.
    pub thumb: Option<String>,
    pub versions: u32,
}

pub struct Sync {
    base: String,
    token: String,
    game: String,
    device: String,
    last_sram_crc: Mutex<Option<u32>>,
    agent: ureq::Agent,
}

/// CRC-32 (zlib's), as the host computes it.
pub fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, e) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *e = c;
        }
        t
    });
    !data.iter().fold(!0u32, |c, &b| t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8))
}

fn modified_ms(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Sync {
    pub fn new(base: &str, token: &str, game_id: &str) -> Option<Arc<Self>> {
        let game: String = game_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect();
        if base.is_empty() || token.is_empty() || game.is_empty() {
            return None;
        }
        let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(60));
        if let Ok(tls) = native_tls::TlsConnector::new() {
            b = b.tls_connector(Arc::new(tls));
        }
        let device = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into());
        Some(Arc::new(Self { base: base.trim_end_matches('/').to_string(), token: token.to_string(), game, device, last_sram_crc: Mutex::new(None), agent: b.build() }))
    }

    fn url(&self, tail: &str) -> String {
        format!("{}{}", self.base, tail)
    }

    fn get(&self, tail: &str) -> Result<ureq::Response, String> {
        match self.agent.get(&self.url(tail)).set("Authorization", &format!("Bearer {}", self.token)).call() {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(404, _)) => Err("404".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn put(&self, tail: &str, body: &[u8]) -> Result<Value, String> {
        let r = self
            .agent
            .put(&self.url(tail))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/octet-stream")
            .set("X-Device", &self.device)
            .send_bytes(body)
            .map_err(|e| e.to_string())?;
        Self::json(r)
    }

    fn json(r: ureq::Response) -> Result<Value, String> {
        serde_json::from_slice(&Self::body(r)?).map_err(|e| e.to_string())
    }

    fn body(r: ureq::Response) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        r.into_reader().take(64 << 20).read_to_end(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    }

    // ── Battery saves ───────────────────────────────────────────────────
    /// Before the game starts: makes `local` the newer of this PC's and the
    /// host's battery save. Returns what happened, for the log.
    pub fn pull_sram(&self, local: &Path) -> String {
        let info = match self.get(&format!("/api/savefile/{}/info", self.game)).and_then(Self::json) {
            Ok(v) => v,
            Err(e) if e == "404" => {
                // Nothing on the host yet: this PC's save goes up after the next save.
                return "no battery save on the host yet".into();
            }
            Err(e) => return format!("host not reachable ({e}); using this PC's battery save"),
        };
        let host_crc = info["crc"].as_u64().unwrap_or(0) as u32;
        let host_at = info["savedAt"].as_u64().unwrap_or(0);
        let local_bytes = std::fs::read(local).ok();
        if let Some(b) = &local_bytes {
            if crc32(b) == host_crc {
                *self.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner()) = Some(host_crc);
                return "battery save matches the host".into();
            }
            if modified_ms(local).unwrap_or(0) >= host_at {
                return "this PC's battery save is newer; it goes to the host after the next save".into();
            }
        }
        match self.get(&format!("/api/savefile/{}", self.game)).and_then(Self::body) {
            Ok(bytes) if !bytes.is_empty() => {
                if local_bytes.is_some() {
                    let _ = std::fs::copy(local, local.with_extension("srm.bak"));
                }
                if let Some(dir) = local.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let tmp = local.with_extension("srm.tmp");
                if std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, local)).is_ok() {
                    *self.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner()) = Some(crc32(&bytes));
                    format!("battery save from the host ({} bytes)", bytes.len())
                } else {
                    "couldn't write the host's battery save; using this PC's".into()
                }
            }
            Ok(_) => "the host's battery save is empty; using this PC's".into(),
            Err(e) => format!("couldn't fetch the host's battery save ({e}); using this PC's"),
        }
    }

    /// Sends the battery save up (in the background) when it changed.
    pub fn push_sram(self: &Arc<Self>, bytes: &[u8]) {
        let crc = crc32(bytes);
        {
            let mut last = self.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner());
            if *last == Some(crc) {
                return;
            }
            *last = Some(crc);
        }
        let (me, bytes) = (self.clone(), bytes.to_vec());
        let _ = std::thread::Builder::new().name("sync-sram".into()).spawn(move || {
            if let Err(e) = me.put(&format!("/api/savefile/{}", me.game), &bytes) {
                crate::warn!("battery save not sent to the host: {e}");
                *me.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
        });
    }

    /// Sends a battery save up now (the game is closing).
    pub fn push_sram_now(&self, bytes: &[u8]) {
        let crc = crc32(bytes);
        if *self.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner()) == Some(crc) {
            return;
        }
        match self.put(&format!("/api/savefile/{}", self.game), bytes) {
            Ok(_) => *self.last_sram_crc.lock().unwrap_or_else(|e| e.into_inner()) = Some(crc),
            Err(e) => crate::warn!("battery save not sent to the host: {e}"),
        }
    }

    // ── Save states ─────────────────────────────────────────────────────
    /// Sends a slot up (in the background): LZ4 + the slot's picture.
    /// `done` runs on that thread with the host's answer.
    pub fn push_state(self: &Arc<Self>, slot: u32, state: Vec<u8>, thumb: Vec<u8>, done: impl FnOnce(Result<Value, String>) + Send + 'static) {
        let me = self.clone();
        let _ = std::thread::Builder::new().name("sync-state".into()).spawn(move || {
            let packed = lz4_flex::compress_prepend_size(&state);
            let mut body = Vec::with_capacity(12 + thumb.len() + packed.len());
            body.extend_from_slice(b"SSST");
            body.extend_from_slice(&[1, 1, 0, 0]);
            body.extend_from_slice(&(thumb.len() as u32).to_le_bytes());
            body.extend_from_slice(&thumb);
            body.extend_from_slice(&packed);
            done(me.put(&format!("/api/engine/states/{}/{slot}", me.game), &body));
        });
    }

    /// The host's slots for this game.
    pub fn list_states(&self) -> Result<Vec<HostSlot>, String> {
        let v = Self::json(self.get(&format!("/api/engine/states/{}", self.game))?)?;
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .map(|x| HostSlot {
                        slot: x["slot"].as_u64().unwrap_or(0) as u32,
                        version: x["version"].as_u64().unwrap_or(0) as u32,
                        saved_at: x["savedAt"].as_u64().unwrap_or(0),
                        device: x["device"].as_str().map(str::to_string),
                        thumb: x["thumb"].as_str().map(str::to_string),
                        versions: x["versions"].as_u64().unwrap_or(1) as u32,
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// A slot's earlier versions: [{version, savedAt, size, device}], newest first.
    pub fn versions(&self, slot: u32) -> Result<Value, String> {
        Self::json(self.get(&format!("/api/engine/states/{}/{slot}/versions", self.game))?)
    }

    /// A slot from the host (the newest, or `version`): (state, saved at ms).
    pub fn fetch_state(&self, slot: u32, version: Option<u32>) -> Result<(Vec<u8>, u64), String> {
        let tail = match version {
            Some(v) => format!("/api/engine/states/{}/{slot}?version={v}", self.game),
            None => format!("/api/engine/states/{}/{slot}", self.game),
        };
        let r = self.get(&tail).map_err(|e| if e == "404" { "there's no save in that slot".to_string() } else { e })?;
        let saved_at = r.header("X-Saved-At").and_then(|v| v.parse().ok()).unwrap_or_else(now_ms);
        let lz4 = r.header("X-Encoding") == Some("lz4");
        let body = Self::body(r)?;
        let state = if lz4 { lz4_flex::decompress_size_prepended(&body).map_err(|e| e.to_string())? } else { body };
        Ok((state, saved_at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_zlib() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }
}
