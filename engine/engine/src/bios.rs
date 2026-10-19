//! System files (BIOS) a core needs, checked before the game loads and
//! fetched from the SaveState host when they're missing.
//!
//! Each core lists groups of files; a group is satisfied by any one of its
//! files (a PlayStation BIOS of any region, for example). Files are matched
//! by MD5 where the dump is known; a different dump is used anyway (regional
//! dumps differ) and noted in the report.
use md5::{Digest, Md5};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub struct BiosFile {
    /// Relative to the system folder (e.g. "dc/dc_boot.bin").
    pub path: &'static str,
    pub md5: Option<&'static str>,
}

#[derive(Clone, Copy)]
pub struct Group {
    pub any_of: &'static [BiosFile],
    /// Without it the core can't start games (otherwise only some games need it).
    pub required: bool,
    /// Also placed next to the game (FinalBurn Neo looks there for neogeo.zip).
    pub beside_content: bool,
}

const fn f(path: &'static str, md5: Option<&'static str>) -> BiosFile {
    BiosFile { path, md5 }
}

const PSX: &[BiosFile] = &[
    f("scph5501.bin", Some("490f666e1afb15b7362b406ed1cea246")),
    f("scph5500.bin", Some("8dd7d5296a650fac7319bce665a6a53c")),
    f("scph5502.bin", Some("32736f17079d0b2b7024407c39bd3050")),
    f("scph1001.bin", Some("924e392ed05558ffdb115408c263dccf")),
];
const SEGACD: &[BiosFile] = &[f("bios_CD_U.bin", Some("2efd74e3232ff260e371b99f84024f7f")), f("bios_CD_E.bin", Some("e66fa1dc5820d254611fdcdba0662372")), f("bios_CD_J.bin", Some("278a9397d192149e84e820ac621a8edd"))];
const SATURN: &[BiosFile] = &[f("saturn_bios.bin", Some("af5828fdff51384f99b3c4926be27762")), f("sega_101.bin", Some("85ec9ca47d8f6807718151cbcca8b964")), f("mpr-17933.bin", Some("3240872c70984b6cbfda1586cab68dbe"))];
const PS2: &[BiosFile] = &[f("pcsx2/bios/scph70012.bin", None), f("pcsx2/bios/scph39001.bin", None), f("pcsx2/bios/scph30004r.bin", None)];

const PCE: &[BiosFile] = &[f("syscard3.pce", Some("38179df8f4ac870017db21ebcbf53114"))];
const LYNX: &[BiosFile] = &[f("lynxboot.img", Some("fcd403db69f54290b51035d82f835e7b"))];
const GBA: &[BiosFile] = &[f("gba_bios.bin", Some("a860e8c0b6d573d191e4ec7db1b1e4f6"))];
const NDS7: &[BiosFile] = &[f("bios7.bin", Some("df692a80a5b1bc90728bc3dfc76cd948"))];
const NDS9: &[BiosFile] = &[f("bios9.bin", Some("a392174eb3e572fed6447e956bde4b25"))];
const NDS_FW: &[BiosFile] = &[f("firmware.bin", None)];
const DC_BOOT: &[BiosFile] = &[f("dc/dc_boot.bin", Some("e10c53c2f8b90bab96ead2d368858623"))];
const DC_FLASH: &[BiosFile] = &[f("dc/dc_flash.bin", None)];
const NEOGEO: &[BiosFile] = &[f("neogeo.zip", None)];

/// What a core needs, by `library_name`.
pub fn requirements(library_name: &str) -> Vec<Group> {
    let g = |any_of: &'static [BiosFile], required: bool| Group { any_of, required, beside_content: false };
    match library_name {
        "PCSX-ReARMed" => vec![g(PSX, false)],
        "Beetle PSX" | "Beetle PSX HW" | "SwanStation" | "DuckStation" => vec![g(PSX, true)],
        "Genesis Plus GX" | "PicoDrive" => vec![g(SEGACD, false)],
        "Beetle PCE Fast" | "Beetle PCE" => vec![g(PCE, false)],
        "Beetle Lynx" | "Handy" => vec![g(LYNX, true)],
        "mGBA" | "gpSP" | "VBA-M" => vec![g(GBA, false)],
        "melonDS" => vec![
            g(NDS7, true),
            g(NDS9, true),
            g(NDS_FW, true),
        ],
        "melonDS DS" => vec![g(NDS7, false), g(NDS9, false), g(NDS_FW, false)],
        "Flycast" => vec![g(DC_BOOT, false), g(DC_FLASH, false)],
        "Beetle Saturn" | "Kronos" => vec![g(SATURN, true)],
        "Yabause" => vec![g(SATURN, false)],
        "FinalBurn Neo" | "MAME 2003-Plus" | "MAME" => vec![Group { any_of: NEOGEO, required: false, beside_content: true }],
        "LRPS2" | "PCSX2" => vec![g(PS2, true)],
        _ => vec![],
    }
}

pub fn md5_of(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut h = Md5::new();
    std::io::copy(&mut file, &mut h).ok()?;
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The SaveState host that serves BIOS files (`/api/emulator/bios/serve/<name>`).
#[derive(Clone)]
pub struct Host {
    pub base_url: String,
    pub token: Option<String>,
}

impl Host {
    fn fetch(&self, name: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/api/emulator/bios/serve/{}", self.base_url.trim_end_matches('/'), name);
        let mut req = ureq::get(&url);
        if let Some(t) = &self.token {
            req = req.set("Authorization", &format!("Bearer {t}"));
        }
        let resp = req.call().map_err(|e| e.to_string())?;
        let mut body = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut body).map_err(|e| e.to_string())?;
        if body.is_empty() {
            return Err("empty file".into());
        }
        Ok(body)
    }
}

#[derive(Debug, Default)]
pub struct Report {
    /// Files in place (path, whether the MD5 matched a known dump, or None if unknown).
    pub present: Vec<(PathBuf, Option<bool>)>,
    pub fetched: Vec<PathBuf>,
    /// Groups with no file: (names, required).
    pub missing: Vec<(Vec<String>, bool)>,
}

impl Report {
    pub fn blocking(&self) -> Option<String> {
        let names: Vec<String> = self.missing.iter().filter(|(_, r)| *r).map(|(n, _)| n.join(" or ")).collect();
        if names.is_empty() { None } else { Some(format!("This core needs its system files: {}. Add them in Set up games.", names.join("; "))) }
    }
}

/// Makes sure the files `library_name` needs are in `system_dir` (and next to
/// the game where the core looks there), fetching missing ones from `host`.
pub fn ensure(library_name: &str, system_dir: &Path, content_dir: Option<&Path>, host: Option<&Host>) -> Report {
    let mut report = Report::default();
    for group in requirements(library_name) {
        let mut satisfied = false;
        for file in group.any_of {
            let path = system_dir.join(file.path);
            if path.is_file() {
                let matched = file.md5.map(|want| md5_of(&path).map(|got| got == want).unwrap_or(false));
                report.present.push((path.clone(), matched));
                satisfied = true;
                if group.beside_content {
                    if let Some(dir) = content_dir {
                        let beside = dir.join(Path::new(file.path).file_name().unwrap_or_default());
                        if !beside.exists() {
                            let _ = std::fs::copy(&path, &beside);
                        }
                    }
                }
                break;
            }
        }
        if !satisfied {
            if let Some(host) = host {
                for file in group.any_of {
                    let name = Path::new(file.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if let Ok(bytes) = host.fetch(&name) {
                        let path = system_dir.join(file.path);
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if std::fs::write(&path, &bytes).is_ok() {
                            if group.beside_content {
                                if let Some(dir) = content_dir {
                                    let _ = std::fs::write(dir.join(&name), &bytes);
                                }
                            }
                            report.fetched.push(path);
                            satisfied = true;
                            break;
                        }
                    }
                }
            }
        }
        if !satisfied {
            report.missing.push((group.any_of.iter().map(|f| f.path.to_string()).collect(), group.required));
        }
    }
    report
}
