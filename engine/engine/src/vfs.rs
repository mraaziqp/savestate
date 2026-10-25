//! The libretro VFS, API v3: files a core opens through the host.
//!
//! Local paths are ordinary files. Paths starting with `http://` or `https://`
//! (a game on the SaveState host, `.../api/games/<id>/download/<file name>`)
//! are read with range requests through a block cache: 1 MiB blocks kept in
//! memory (LRU) and on disk next to a map of which blocks are present, so a
//! 4 GB disc starts after the first few megabytes and plays from disk the
//! second time. Sequential reads fetch ahead (up to 8 blocks per request).
use libretro_sys::*;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const BLOCK: u64 = 1 << 20;
const MEMORY_BLOCKS: usize = 64;
const READ_AHEAD_BLOCKS: u64 = 8;

#[derive(Clone, Default)]
pub struct VfsConfig {
    /// Sent as `Authorization: Bearer ...` to the host.
    pub token: Option<String>,
    /// Where streamed files are cached; no disk cache when None.
    pub cache_dir: Option<PathBuf>,
    /// The URLs a core may open (the game being streamed). Cores probe for
    /// companion files next to the game ("<dir>/neogeo.zip", "<name>.cue"),
    /// and the host's download route answers any name under a game with that
    /// game's file, so every other URL is "not found" to the core.
    pub remote_allowed: Vec<String>,
}

static CONFIG: OnceLock<Mutex<VfsConfig>> = OnceLock::new();
static CACHES: OnceLock<Mutex<HashMap<String, Arc<Mutex<RemoteFile>>>>> = OnceLock::new();

pub fn configure(cfg: VfsConfig) {
    *CONFIG.get_or_init(|| Mutex::new(VfsConfig::default())).lock().unwrap_or_else(|e| e.into_inner()) = cfg;
}

fn config() -> VfsConfig {
    CONFIG.get_or_init(|| Mutex::new(VfsConfig::default())).lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Lets the core open `url` (the game it's streaming).
pub fn allow_remote(url: &str) {
    let mut c = CONFIG.get_or_init(|| Mutex::new(VfsConfig::default())).lock().unwrap_or_else(|e| e.into_inner());
    if !c.remote_allowed.iter().any(|u| u == url) {
        c.remote_allowed.push(url.to_string());
    }
}

fn core_may_open(path: &str) -> bool {
    let Some(url) = url_of(path) else { return false };
    CONFIG.get_or_init(|| Mutex::new(VfsConfig::default())).lock().unwrap_or_else(|e| e.into_inner()).remote_allowed.iter().any(|u| *u == url)
}

pub fn is_remote(path: &str) -> bool {
    url_of(path).is_some()
}

/// The URL a remote path names. Cores get streamed games as
/// `core_path(url)`, which on Windows uses backslashes, because several
/// cores find the game's folder by splitting on `\` only (FinalBurn Neo);
/// this turns either form back into the URL.
pub fn url_of(path: &str) -> Option<String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        Some(path.to_string())
    } else if path.starts_with("http:\\\\") || path.starts_with("https:\\\\") {
        Some(path.replace('\\', "/"))
    } else {
        None
    }
}

/// How a streamed game's URL is shown to the core (see `url_of`).
pub fn core_path(url: &str) -> String {
    if cfg!(windows) { url.replace('/', "\\") } else { url.to_string() }
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        #[cfg_attr(not(windows), allow(unused_mut))] // changed only by Windows code
        let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60));
        // Windows: the system's TLS (schannel). Elsewhere (Android) ureq's rustls.
        #[cfg(windows)]
        if let Ok(tls) = native_tls::TlsConnector::new() {
            b = b.tls_connector(Arc::new(tls));
        }
        b.build()
    })
}

// ── Remote files ────────────────────────────────────────────────────────
/// One file on the host, shared by every handle open on it.
pub struct RemoteFile {
    url: String,
    pub size: u64,
    memory: HashMap<u64, Vec<u8>>,
    lru: VecDeque<u64>,
    disk: Option<File>,
    present: Vec<u8>,
    map_path: Option<PathBuf>,
    pub fetched_bytes: u64,
}

fn http_get(url: &str, range: Option<(u64, u64)>) -> Result<(u16, Option<u64>, Vec<u8>), String> {
    let mut req = agent().get(url);
    if let Some(t) = config().token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    if let Some((a, b)) = range {
        req = req.set("Range", &format!("bytes={a}-{b}"));
    }
    let resp = req.call().map_err(|e| e.to_string())?;
    let status = resp.status();
    let total = resp
        .header("Content-Range")
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .or_else(|| if status == 200 { resp.header("Content-Length").and_then(|l| l.parse().ok()) } else { None });
    let mut body = Vec::new();
    resp.into_reader().take(64 * BLOCK).read_to_end(&mut body).map_err(|e| e.to_string())?;
    Ok((status, total, body))
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

impl RemoteFile {
    fn open(url: &str) -> Result<Self, String> {
        let (status, total, _) = http_get(url, Some((0, 0)))?;
        if status != 206 && status != 200 {
            return Err(format!("host answered {status}"));
        }
        let size = total.ok_or("the host didn't say how big the file is")?;
        let blocks = size.div_ceil(BLOCK) as usize;
        let mut f = Self { url: url.to_string(), size, memory: HashMap::new(), lru: VecDeque::new(), disk: None, present: vec![0; blocks.div_ceil(8)], map_path: None, fetched_bytes: 0 };
        if let Some(dir) = config().cache_dir {
            let _ = std::fs::create_dir_all(&dir);
            let base = dir.join(format!("{:016x}", fnv(url)));
            let data_path = base.with_extension("bin");
            let map_path = base.with_extension("map");
            // A cache from an older file of another size is thrown away.
            let reuse = std::fs::metadata(&data_path).map(|m| m.len() == size).unwrap_or(false);
            if let Ok(file) = OpenOptions::new().read(true).write(true).create(true).truncate(!reuse).open(&data_path) {
                if !reuse {
                    let _ = file.set_len(size);
                }
                if reuse {
                    if let Ok(m) = std::fs::read(&map_path) {
                        if m.len() == f.present.len() {
                            f.present = m;
                        }
                    }
                }
                f.disk = Some(file);
                f.map_path = Some(map_path);
            }
        }
        Ok(f)
    }

    fn has_on_disk(&self, b: u64) -> bool {
        self.disk.is_some() && self.present[(b / 8) as usize] & (1 << (b % 8)) != 0
    }

    fn block_len(&self, b: u64) -> usize {
        (self.size - b * BLOCK).min(BLOCK) as usize
    }

    fn remember(&mut self, b: u64, data: Vec<u8>) {
        if let Some(disk) = self.disk.as_mut() {
            if disk.seek(SeekFrom::Start(b * BLOCK)).is_ok() && disk.write_all(&data).is_ok() {
                self.present[(b / 8) as usize] |= 1 << (b % 8);
            }
        }
        self.memory.insert(b, data);
        self.lru.retain(|x| *x != b);
        self.lru.push_back(b);
        while self.lru.len() > MEMORY_BLOCKS {
            if let Some(old) = self.lru.pop_front() {
                self.memory.remove(&old);
            }
        }
    }

    fn save_map(&self) {
        if let Some(p) = &self.map_path {
            let _ = std::fs::write(p, &self.present);
        }
    }

    /// Block `b`, from memory, the disk cache or the host (fetching ahead).
    fn block(&mut self, b: u64) -> Result<&[u8], String> {
        if !self.memory.contains_key(&b) {
            if self.has_on_disk(b) {
                let mut buf = vec![0u8; self.block_len(b)];
                let disk = self.disk.as_mut().ok_or("cache gone")?;
                disk.seek(SeekFrom::Start(b * BLOCK)).map_err(|e| e.to_string())?;
                disk.read_exact(&mut buf).map_err(|e| e.to_string())?;
                self.memory.insert(b, buf);
                self.lru.push_back(b);
            } else {
                // Fetch this block and the following missing ones in one request.
                let last_block = (self.size - 1) / BLOCK;
                let mut end_block = b;
                while end_block < last_block && end_block - b + 1 < READ_AHEAD_BLOCKS && !self.has_on_disk(end_block + 1) && !self.memory.contains_key(&(end_block + 1)) {
                    end_block += 1;
                }
                let start = b * BLOCK;
                let end = ((end_block + 1) * BLOCK).min(self.size) - 1;
                let mut tries = 0;
                let body = loop {
                    match http_get(&self.url, Some((start, end))) {
                        Ok((206, _, body)) if body.len() as u64 == end - start + 1 => break body,
                        Ok((200, _, body)) if start == 0 && body.len() as u64 == self.size => break body[..=(end as usize)].to_vec(),
                        Ok((status, _, body)) if tries >= 2 => return Err(format!("host answered {status} with {} bytes for bytes {start}-{end}", body.len())),
                        Err(e) if tries >= 2 => return Err(e),
                        _ => {
                            tries += 1;
                            std::thread::sleep(Duration::from_millis(300 * tries));
                        }
                    }
                };
                self.fetched_bytes += body.len() as u64;
                for (i, chunk) in body.chunks(BLOCK as usize).enumerate() {
                    self.remember(b + i as u64, chunk.to_vec());
                }
                self.save_map();
            }
        } else {
            self.lru.retain(|x| *x != b);
            self.lru.push_back(b);
        }
        self.memory.get(&b).map(|v| v.as_slice()).ok_or_else(|| "block missing after fetch".to_string())
    }

    /// Reads into `buf` from `pos`; returns bytes read (0 at the end).
    pub fn read_at(&mut self, pos: u64, buf: &mut [u8]) -> Result<usize, String> {
        if pos >= self.size {
            return Ok(0);
        }
        let want = (buf.len() as u64).min(self.size - pos) as usize;
        let mut done = 0;
        while done < want {
            let at = pos + done as u64;
            let b = at / BLOCK;
            let off = (at % BLOCK) as usize;
            let block = self.block(b)?;
            let n = (block.len() - off).min(want - done);
            buf[done..done + n].copy_from_slice(&block[off..off + n]);
            done += n;
        }
        Ok(done)
    }
}

/// The shared cache entry for a URL (opened on first use).
pub fn remote(url: &str) -> Result<Arc<Mutex<RemoteFile>>, String> {
    let map = CACHES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(f) = map.lock().unwrap_or_else(|e| e.into_inner()).get(url) {
        return Ok(f.clone());
    }
    let f = Arc::new(Mutex::new(RemoteFile::open(url)?));
    map.lock().unwrap_or_else(|e| e.into_inner()).insert(url.to_string(), f.clone());
    Ok(f)
}

// ── Handles ─────────────────────────────────────────────────────────────
enum Backend {
    Local(File),
    Remote { file: Arc<Mutex<RemoteFile>>, pos: u64, size: u64 },
}

struct Handle {
    path: CString,
    backend: Backend,
}

struct DirHandle {
    entries: Vec<(CString, bool)>,
    /// Index of the current entry + 1 (0 = before the first readdir).
    at: usize,
}

unsafe fn path_of(p: *const c_char) -> Option<String> {
    if p.is_null() { None } else { Some(CStr::from_ptr(p).to_string_lossy().into_owned()) }
}

unsafe fn handle<'a>(stream: *mut retro_vfs_file_handle) -> Option<&'a mut Handle> {
    (stream as *mut Handle).as_mut()
}

unsafe extern "C" fn vfs_get_path(stream: *mut retro_vfs_file_handle) -> *const c_char {
    handle(stream).map(|h| h.path.as_ptr()).unwrap_or(std::ptr::null())
}

unsafe extern "C" fn vfs_open(path: *const c_char, mode: c_uint, _hints: c_uint) -> *mut retro_vfs_file_handle {
    let Some(p) = path_of(path) else { return std::ptr::null_mut() };
    let backend = if is_remote(&p) {
        if mode & RETRO_VFS_FILE_ACCESS_WRITE != 0 || !core_may_open(&p) {
            return std::ptr::null_mut();
        }
        match remote(&url_of(&p).unwrap_or_default()) {
            Ok(file) => {
                let size = file.lock().unwrap_or_else(|e| e.into_inner()).size;
                Backend::Remote { file, pos: 0, size }
            }
            Err(e) => {
                crate::log::emit(crate::log::Level::Warn, "vfs", &format!("can't open {p}: {e}"));
                return std::ptr::null_mut();
            }
        }
    } else {
        let mut o = OpenOptions::new();
        let read = mode & RETRO_VFS_FILE_ACCESS_READ != 0;
        let write = mode & RETRO_VFS_FILE_ACCESS_WRITE != 0;
        let keep = mode & RETRO_VFS_FILE_ACCESS_UPDATE_EXISTING != 0;
        match (read, write, keep) {
            (true, false, _) => o.read(true),
            // "wb" / "w+b": create, empty it.
            (false, true, false) => o.write(true).create(true).truncate(true),
            (true, true, false) => o.read(true).write(true).create(true).truncate(true),
            // "r+b": the file stays as it is.
            (_, true, true) => o.read(true).write(true).create(true),
            _ => return std::ptr::null_mut(),
        };
        match o.open(&p) {
            Ok(f) => Backend::Local(f),
            Err(e) => {
                crate::log::emit(crate::log::Level::Debug, "vfs", &format!("open {p} (mode {mode}): {e}"));
                return std::ptr::null_mut();
            }
        }
    };
    let h = Box::new(Handle { path: CString::new(p).unwrap_or_default(), backend });
    Box::into_raw(h) as *mut retro_vfs_file_handle
}

unsafe extern "C" fn vfs_close(stream: *mut retro_vfs_file_handle) -> c_int {
    if stream.is_null() {
        return -1;
    }
    drop(Box::from_raw(stream as *mut Handle));
    0
}

unsafe extern "C" fn vfs_size(stream: *mut retro_vfs_file_handle) -> i64 {
    match handle(stream).map(|h| &h.backend) {
        Some(Backend::Local(f)) => f.metadata().map(|m| m.len() as i64).unwrap_or(-1),
        Some(Backend::Remote { size, .. }) => *size as i64,
        None => -1,
    }
}

unsafe extern "C" fn vfs_tell(stream: *mut retro_vfs_file_handle) -> i64 {
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) => f.stream_position().map(|p| p as i64).unwrap_or(-1),
        Some(Backend::Remote { pos, .. }) => *pos as i64,
        None => -1,
    }
}

/// Returns 0 on success, -1 on error. libretro.h says "the new position", but
/// RetroArch returns 0 and cores rely on it: minizip (FinalBurn Neo, MAME and
/// others read zips through the VFS) treats any non-zero result as a failure.
unsafe extern "C" fn vfs_seek(stream: *mut retro_vfs_file_handle, offset: i64, whence: c_int) -> i64 {
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) => {
            let to = match whence {
                RETRO_VFS_SEEK_POSITION_START => SeekFrom::Start(offset.max(0) as u64),
                RETRO_VFS_SEEK_POSITION_CURRENT => SeekFrom::Current(offset),
                RETRO_VFS_SEEK_POSITION_END => SeekFrom::End(offset),
                _ => return -1,
            };
            f.seek(to).map(|_| 0).unwrap_or(-1)
        }
        Some(Backend::Remote { pos, size, .. }) => {
            let base = match whence {
                RETRO_VFS_SEEK_POSITION_START => 0,
                RETRO_VFS_SEEK_POSITION_CURRENT => *pos as i64,
                RETRO_VFS_SEEK_POSITION_END => *size as i64,
                _ => return -1,
            };
            let to = base + offset;
            if to < 0 {
                return -1;
            }
            *pos = to as u64;
            0
        }
        None => -1,
    }
}

unsafe extern "C" fn vfs_read(stream: *mut retro_vfs_file_handle, s: *mut c_void, len: u64) -> i64 {
    if s.is_null() {
        return -1;
    }
    let buf = std::slice::from_raw_parts_mut(s as *mut u8, len as usize);
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) => {
            let mut done = 0;
            while done < buf.len() {
                match f.read(&mut buf[done..]) {
                    Ok(0) => break,
                    Ok(n) => done += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return if done > 0 { done as i64 } else { -1 },
                }
            }
            done as i64
        }
        Some(Backend::Remote { file, pos, .. }) => {
            let r = file.lock().unwrap_or_else(|e| e.into_inner()).read_at(*pos, buf);
            match r {
                Ok(n) => {
                    *pos += n as u64;
                    n as i64
                }
                Err(e) => {
                    crate::log::emit(crate::log::Level::Warn, "vfs", &format!("read failed: {e}"));
                    -1
                }
            }
        }
        None => -1,
    }
}

unsafe extern "C" fn vfs_write(stream: *mut retro_vfs_file_handle, s: *const c_void, len: u64) -> i64 {
    if s.is_null() {
        return -1;
    }
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) => f.write_all(std::slice::from_raw_parts(s as *const u8, len as usize)).map(|_| len as i64).unwrap_or(-1),
        _ => -1,
    }
}

unsafe extern "C" fn vfs_flush(stream: *mut retro_vfs_file_handle) -> c_int {
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) => if f.flush().is_ok() { 0 } else { -1 },
        Some(Backend::Remote { .. }) => 0,
        None => -1,
    }
}

unsafe extern "C" fn vfs_remove(path: *const c_char) -> c_int {
    match path_of(path) {
        Some(p) if !is_remote(&p) => if std::fs::remove_file(&p).is_ok() { 0 } else { -1 },
        _ => -1,
    }
}

unsafe extern "C" fn vfs_rename(old: *const c_char, new: *const c_char) -> c_int {
    match (path_of(old), path_of(new)) {
        (Some(a), Some(b)) if !is_remote(&a) && !is_remote(&b) => if std::fs::rename(a, b).is_ok() { 0 } else { -1 },
        _ => -1,
    }
}

unsafe extern "C" fn vfs_truncate(stream: *mut retro_vfs_file_handle, length: i64) -> i64 {
    match handle(stream).map(|h| &mut h.backend) {
        Some(Backend::Local(f)) if length >= 0 => if f.set_len(length as u64).is_ok() { 0 } else { -1 },
        _ => -1,
    }
}

unsafe extern "C" fn vfs_stat(path: *const c_char, size: *mut i32) -> c_int {
    let Some(p) = path_of(path) else { return 0 };
    let (flags, len) = if is_remote(&p) {
        if !core_may_open(&p) {
            return 0;
        }
        match remote(&url_of(&p).unwrap_or_default()) {
            Ok(f) => (RETRO_VFS_STAT_IS_VALID, f.lock().unwrap_or_else(|e| e.into_inner()).size),
            Err(_) => (0, 0),
        }
    } else {
        match std::fs::metadata(&p) {
            Ok(m) => (RETRO_VFS_STAT_IS_VALID | if m.is_dir() { RETRO_VFS_STAT_IS_DIRECTORY } else { 0 }, m.len()),
            Err(e) => {
                crate::log::emit(crate::log::Level::Debug, "vfs", &format!("stat {p}: {e}"));
                (0, 0)
            }
        }
    };
    if !size.is_null() {
        *size = len.min(i32::MAX as u64) as i32;
    }
    flags
}

unsafe extern "C" fn vfs_mkdir(dir: *const c_char) -> c_int {
    let Some(p) = path_of(dir) else { return -1 };
    if Path::new(&p).is_dir() {
        return -2;
    }
    if std::fs::create_dir_all(&p).is_ok() { 0 } else { -1 }
}

fn is_hidden(entry: &std::fs::DirEntry) -> bool {
    if entry.file_name().to_string_lossy().starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(m) = entry.metadata() {
            return m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    false
}

unsafe extern "C" fn vfs_opendir(dir: *const c_char, include_hidden: bool) -> *mut retro_vfs_dir_handle {
    let Some(p) = path_of(dir) else { return std::ptr::null_mut() };
    let Ok(rd) = std::fs::read_dir(&p) else { return std::ptr::null_mut() };
    let mut entries = Vec::new();
    for e in rd.flatten() {
        if !include_hidden && is_hidden(&e) {
            continue;
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if let Ok(name) = CString::new(e.file_name().to_string_lossy().into_owned()) {
            entries.push((name, is_dir));
        }
    }
    Box::into_raw(Box::new(DirHandle { entries, at: 0 })) as *mut retro_vfs_dir_handle
}

unsafe extern "C" fn vfs_readdir(d: *mut retro_vfs_dir_handle) -> bool {
    match (d as *mut DirHandle).as_mut() {
        Some(h) if h.at < h.entries.len() => {
            h.at += 1;
            true
        }
        _ => false,
    }
}

unsafe extern "C" fn vfs_dirent_get_name(d: *mut retro_vfs_dir_handle) -> *const c_char {
    match (d as *mut DirHandle).as_ref() {
        Some(h) if h.at > 0 => h.entries[h.at - 1].0.as_ptr(),
        _ => std::ptr::null(),
    }
}

unsafe extern "C" fn vfs_dirent_is_dir(d: *mut retro_vfs_dir_handle) -> bool {
    match (d as *mut DirHandle).as_ref() {
        Some(h) if h.at > 0 => h.entries[h.at - 1].1,
        _ => false,
    }
}

unsafe extern "C" fn vfs_closedir(d: *mut retro_vfs_dir_handle) -> c_int {
    if d.is_null() {
        return -1;
    }
    drop(Box::from_raw(d as *mut DirHandle));
    0
}

pub static INTERFACE: retro_vfs_interface = retro_vfs_interface {
    get_path: Some(vfs_get_path),
    open: Some(vfs_open),
    close: Some(vfs_close),
    size: Some(vfs_size),
    tell: Some(vfs_tell),
    seek: Some(vfs_seek),
    read: Some(vfs_read),
    write: Some(vfs_write),
    flush: Some(vfs_flush),
    remove: Some(vfs_remove),
    rename: Some(vfs_rename),
    truncate: Some(vfs_truncate),
    stat: Some(vfs_stat),
    mkdir: Some(vfs_mkdir),
    opendir: Some(vfs_opendir),
    readdir: Some(vfs_readdir),
    dirent_get_name: Some(vfs_dirent_get_name),
    dirent_is_dir: Some(vfs_dirent_is_dir),
    closedir: Some(vfs_closedir),
};

/// Downloads a remote file completely through the block cache to `to` (for
/// cores that open the game file themselves). Calls `progress(done, total)`.
pub fn download(url: &str, to: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let f = remote(url)?;
    let size = f.lock().unwrap_or_else(|e| e.into_inner()).size;
    let tmp = to.with_extension("part");
    let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (BLOCK * READ_AHEAD_BLOCKS) as usize];
    let mut pos = 0u64;
    while pos < size {
        let n = f.lock().unwrap_or_else(|e| e.into_inner()).read_at(pos, &mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        pos += n as u64;
        progress(pos, size);
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if pos != size {
        return Err(format!("download stopped at {pos} of {size} bytes"));
    }
    std::fs::rename(&tmp, to).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_in_either_form() {
        let url = "http://host:3000/api/games/abc/download/mslugx.zip";
        assert_eq!(url_of(url).as_deref(), Some(url));
        assert_eq!(url_of(&core_path(url)).as_deref(), Some(url));
        assert_eq!(url_of(r"http:\\host:3000\api\games\abc\download\neogeo.zip").as_deref(), Some("http://host:3000/api/games/abc/download/neogeo.zip"));
        assert_eq!(url_of(r"C:\games\mslugx.zip"), None);
        // Only the game being streamed is visible to the core.
        allow_remote(url);
        assert!(core_may_open(&core_path(url)));
        assert!(!core_may_open(r"http:\\host:3000\api\games\abc\download\neogeo.zip"));
    }

    #[test]
    fn local_files_through_the_interface() {
        let dir = std::env::temp_dir().join(format!("ssvfs-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = CString::new(dir.join("a.bin").to_string_lossy().into_owned()).unwrap();
        unsafe {
            let w = vfs_open(path.as_ptr(), RETRO_VFS_FILE_ACCESS_WRITE, 0);
            assert!(!w.is_null());
            assert_eq!(vfs_write(w, b"hello world".as_ptr() as *const c_void, 11), 11);
            assert_eq!(vfs_close(w), 0);
            let r = vfs_open(path.as_ptr(), RETRO_VFS_FILE_ACCESS_READ, 0);
            assert_eq!(vfs_size(r), 11);
            assert_eq!(vfs_seek(r, 6, RETRO_VFS_SEEK_POSITION_START), 0);
            assert_eq!(vfs_tell(r), 6);
            let mut buf = [0u8; 16];
            assert_eq!(vfs_read(r, buf.as_mut_ptr() as *mut c_void, 16), 5);
            assert_eq!(&buf[..5], b"world");
            assert_eq!(vfs_tell(r), 11);
            assert_eq!(CStr::from_ptr(vfs_get_path(r)).to_bytes(), path.to_bytes());
            vfs_close(r);
            let mut size = 0i32;
            assert_eq!(vfs_stat(path.as_ptr(), &mut size) & RETRO_VFS_STAT_IS_VALID, RETRO_VFS_STAT_IS_VALID);
            assert_eq!(size, 11);
            let d = CString::new(dir.to_string_lossy().into_owned()).unwrap();
            let dh = vfs_opendir(d.as_ptr(), false);
            let mut names = Vec::new();
            while vfs_readdir(dh) {
                names.push(CStr::from_ptr(vfs_dirent_get_name(dh)).to_string_lossy().into_owned());
            }
            vfs_closedir(dh);
            assert!(names.contains(&"a.bin".to_string()));
            assert_eq!(vfs_remove(path.as_ptr()), 0);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
