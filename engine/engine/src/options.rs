//! Core options: every way a core declares them (SET_VARIABLES, v1, v1 intl,
//! v2, v2 intl), the values in effect, and curated defaults per core so a
//! game boots well without anyone opening a settings page.
use libretro_sys::*;
use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};

#[derive(Clone, Debug)]
pub struct OptionDef {
    pub key: String,
    pub desc: String,
    pub info: String,
    pub category: Option<String>,
    /// (value, label)
    pub values: Vec<(String, String)>,
    pub default: String,
    pub visible: bool,
}

#[derive(Default)]
pub struct Options {
    defs: Vec<OptionDef>,
    index: HashMap<String, usize>,
    /// The value in effect for each key.
    current: HashMap<String, String>,
    /// Requested values (curated, per game, the person's): applied whenever valid.
    wanted: HashMap<String, String>,
    /// Strings handed to the core; each stays alive until its key's value changes.
    handed_out: HashMap<String, CString>,
    updated: bool,
}

unsafe fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

unsafe fn values_of(vals: &[retro_core_option_value; RETRO_NUM_CORE_OPTION_VALUES_MAX]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for v in vals.iter() {
        if v.value.is_null() {
            break;
        }
        let value = text(v.value);
        let label = if v.label.is_null() { value.clone() } else { text(v.label) };
        out.push((value, label));
    }
    out
}

impl Options {
    pub fn new(wanted: HashMap<String, String>) -> Self {
        Self { wanted, ..Self::default() }
    }

    pub fn defs(&self) -> &[OptionDef] {
        &self.defs
    }

    pub fn current(&self) -> &HashMap<String, String> {
        &self.current
    }

    fn add(&mut self, def: OptionDef) {
        if def.key.is_empty() || def.values.is_empty() {
            return;
        }
        let default = if def.values.iter().any(|(v, _)| *v == def.default) { def.default.clone() } else { def.values[0].0.clone() };
        let chosen = match self.wanted.get(&def.key) {
            Some(w) if def.values.iter().any(|(v, _)| v == w) => w.clone(),
            _ => self.current.get(&def.key).filter(|c| def.values.iter().any(|(v, _)| v == *c)).cloned().unwrap_or(default.clone()),
        };
        self.current.insert(def.key.clone(), chosen);
        let def = OptionDef { default, ..def };
        match self.index.get(&def.key) {
            Some(&i) => self.defs[i] = def,
            None => {
                self.index.insert(def.key.clone(), self.defs.len());
                self.defs.push(def);
            }
        }
        self.updated = true;
    }

    /// SET_VARIABLES: `{ key, "Description; a|b|c" }`, terminated by a NULL key.
    ///
    /// # Safety
    /// `vars` points to a NULL-key-terminated array of valid C strings.
    pub unsafe fn set_variables(&mut self, mut vars: *const retro_variable) {
        self.defs.clear();
        self.index.clear();
        while !vars.is_null() && !(*vars).key.is_null() {
            let key = text((*vars).key);
            let spec = text((*vars).value);
            let (desc, list) = match spec.split_once("; ") {
                Some((d, l)) => (d.to_string(), l.to_string()),
                None => match spec.split_once(';') {
                    Some((d, l)) => (d.trim().to_string(), l.trim().to_string()),
                    None => (key.clone(), spec.clone()),
                },
            };
            let values: Vec<(String, String)> = list.split('|').filter(|v| !v.is_empty()).map(|v| (v.to_string(), v.to_string())).collect();
            let default = values.first().map(|v| v.0.clone()).unwrap_or_default();
            self.add(OptionDef { key, desc, info: String::new(), category: None, values, default, visible: true });
            vars = vars.add(1);
        }
    }

    /// SET_CORE_OPTIONS (v1).
    ///
    /// # Safety
    /// `defs` points to a NULL-key-terminated array of v1 definitions.
    pub unsafe fn set_v1(&mut self, mut defs: *const retro_core_option_definition) {
        self.defs.clear();
        self.index.clear();
        while !defs.is_null() && !(*defs).key.is_null() {
            let d = &*defs;
            self.add(OptionDef {
                key: text(d.key),
                desc: text(d.desc),
                info: text(d.info),
                category: None,
                values: values_of(&d.values),
                default: text(d.default_value),
                visible: true,
            });
            defs = defs.add(1);
        }
    }

    /// SET_CORE_OPTIONS_V2: categories and definitions.
    ///
    /// # Safety
    /// `opts` points to a valid `retro_core_options_v2`.
    pub unsafe fn set_v2(&mut self, opts: *const retro_core_options_v2) {
        if opts.is_null() {
            return;
        }
        self.defs.clear();
        self.index.clear();
        let mut defs = (*opts).definitions;
        while !defs.is_null() && !(*defs).key.is_null() {
            let d = &*defs;
            let category = if d.category_key.is_null() { None } else { Some(text(d.category_key)) };
            self.add(OptionDef {
                key: text(d.key),
                desc: text(d.desc),
                info: text(d.info),
                category,
                values: values_of(&d.values),
                default: text(d.default_value),
                visible: true,
            });
            defs = defs.add(1);
        }
    }

    pub fn set_visible(&mut self, key: &str, visible: bool) {
        if let Some(&i) = self.index.get(key) {
            self.defs[i].visible = visible;
        }
    }

    /// GET_VARIABLE: the value in effect, as a C string that stays valid.
    pub fn get(&mut self, key: &str) -> Option<*const c_char> {
        let value = self.current.get(key)?.clone();
        let entry = self.handed_out.entry(key.to_string()).or_insert_with(|| CString::new(value.clone()).unwrap_or_default());
        if entry.to_bytes() != value.as_bytes() {
            *entry = CString::new(value).unwrap_or_default();
        }
        Some(entry.as_ptr())
    }

    /// Sets a value (from the person, a profile, or the core's SET_VARIABLE).
    /// Values the core doesn't list are refused.
    pub fn set(&mut self, key: &str, value: &str) -> bool {
        let ok = match self.index.get(key) {
            Some(&i) => self.defs[i].values.iter().any(|(v, _)| v == value),
            None => false,
        };
        if ok && self.current.get(key).map(String::as_str) != Some(value) {
            self.current.insert(key.to_string(), value.to_string());
            self.updated = true;
        }
        self.wanted.insert(key.to_string(), value.to_string());
        ok
    }

    /// GET_VARIABLE_UPDATE: whether anything changed since the core last asked.
    pub fn take_updated(&mut self) -> bool {
        std::mem::replace(&mut self.updated, false)
    }
}

/// Curated defaults by core (`library_name`): faster boots and sharper 3D,
/// applied only when the core lists that value.
pub fn curated(library_name: &str) -> HashMap<String, String> {
    let pairs: &[(&str, &str)] = match library_name {
        "mGBA" => &[("mgba_skip_bios", "ON"), ("mgba_sgb_borders", "OFF"), ("mgba_idle_optimization", "Remove Known")],
        "Genesis Plus GX" => &[("genesis_plus_gx_bram", "per game"), ("genesis_plus_gx_audio_filter", "disabled")],
        "Snes9x" => &[("snes9x_overclock_superfx", "100%"), ("snes9x_audio_interpolation", "gaussian")],
        "PCSX-ReARMed" => &[("pcsx_rearmed_frameskip_type", "disabled"), ("pcsx_rearmed_show_bios_bootlogo", "disabled"), ("pcsx_rearmed_memcard2", "disabled")],
        "Beetle PCE Fast" | "Beetle PCE" => &[("pce_fast_cdimagecache", "enabled")],
        "FinalBurn Neo" => &[("fbneo-allow-patched-romsets", "enabled"), ("fbneo-load-subsystem-from-parent", "enabled")],
        "Mupen64Plus-Next" => &[("mupen64plus-rdp-plugin", "gliden64"), ("mupen64plus-rsp-plugin", "hle"), ("mupen64plus-43screensize", "1280x960"), ("mupen64plus-EnableNativeResFactor", "4")],
        "PPSSPP" => &[("ppsspp_internal_resolution", "1920x1088"), ("ppsspp_fast_memory", "enabled"), ("ppsspp_frameskip", "0")],
        "dolphin-emu" => &[("dolphin_efb_scale", "x3 (1920 x 1584)"), ("dolphin_fast_disc_speed", "enabled"), ("dolphin_dsp_hle", "enabled")],
        "Flycast" => &[("reicast_internal_resolution", "1920x1440"), ("reicast_threaded_rendering", "enabled"), ("reicast_hle_bios", "enabled")],
        "LRPS2" | "PCSX2" => &[("pcsx2_renderer", "Auto"), ("pcsx2_upscale_multiplier", "3x Native (~1080p)"), ("pcsx2_fastboot", "enabled")],
        "melonDS DS" => &[("melonds_sysfile_mode", "builtin"), ("melonds_render_mode", "software")],
        "Citra" => &[("citra_resolution_factor", "3x"), ("citra_use_cpu_jit", "enabled")],
        _ => &[],
    };
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v0_variables_parse_and_switch() {
        let k = CString::new("core_speed").unwrap();
        let v = CString::new("Speed hack; off|on|turbo").unwrap();
        let vars = [retro_variable { key: k.as_ptr(), value: v.as_ptr() }, retro_variable { key: std::ptr::null(), value: std::ptr::null() }];
        let mut o = Options::new([("core_speed".to_string(), "turbo".to_string())].into_iter().collect());
        unsafe { o.set_variables(vars.as_ptr()) };
        let got = unsafe { CStr::from_ptr(o.get("core_speed").unwrap()) };
        assert_eq!(got.to_str().unwrap(), "turbo");
        assert!(o.take_updated());
        assert!(!o.take_updated());
        assert!(o.set("core_speed", "on"));
        assert!(!o.set("core_speed", "warp"));
        assert!(o.take_updated());
        assert_eq!(o.defs()[0].values.len(), 3);
    }
}
