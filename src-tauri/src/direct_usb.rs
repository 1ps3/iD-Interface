use crate::valuetree::{JuceVar, MeterFrame, ValueTreeNode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendMode {
    DirectUsb,
    Adm,
}

impl Default for BackendMode {
    fn default() -> Self {
        Self::DirectUsb
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub mode: BackendMode,
    pub active_engine: String,
    pub direct_available: bool,
    pub device_name: String,
    pub serial: String,
    pub platform: String,
    pub app_version: String,
}

/// Persistent standalone preferences for Direct USB ("No ADM") mode.
/// Kept completely separate from ADM so swapping between Direct USB and ADM
/// never clobbers either engine's settings. Live hardware registers (48V, Glow,
/// Lift, Orbit, Gain, Main/HP1 Vol, Mixer, EQ, Comp, etc.) are always polled
/// directly from the interface on connect.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DirectUsbSettings {
    pub initialized: bool,
    pub sample_rate: Option<i32>,
    pub buffer_size: i32,
    pub clock_source: Option<i32>,
    pub mono_mode: i32,
    pub fn_key_mode: i32,
    pub vol_recall: i32,
    pub talkback_src: i32,
    pub show_preamp_trim: i32,
    pub dim_atten: f64,
    pub ref_vol: f64,
    pub opt_mode: i32,
    pub main_src: i32,
    pub lb_virt_out: i32,
    pub mixer_links: BTreeMap<String, i32>,
    pub mixer_mutes: BTreeMap<String, i32>,
    pub mixer_vols: BTreeMap<String, f64>,
    pub mixer_pans: BTreeMap<String, i32>,
    pub out_router_links: BTreeMap<usize, i32>,
    pub eq_bypass: BTreeMap<u8, i32>,
    pub input_polarity: BTreeMap<u8, i32>,
    pub comp_blend: BTreeMap<u8, f64>,
}

impl Default for DirectUsbSettings {
    fn default() -> Self {
        Self {
            initialized: false,
            sample_rate: None,   // Use live hardware sample rate until user sets one
            buffer_size: 256,    // Balanced studio latency (~5.3ms @ 48kHz)
            clock_source: None,  // Use live hardware clock source until user sets one
            mono_mode: 1,        // CENTRE (standard L+R mono sum check)
            fn_key_mode: 1,      // Dim (most-used non-destructive monitor button)
            vol_recall: 1,       // ON (restore calibrated monitor volume)
            talkback_src: -1,    // None (safe default until user assigns mic)
            show_preamp_trim: 0, // OFF (clean preamp layout)
            dim_atten: -15.0,    // -15 dB broadcast/mastering standard dim
            ref_vol: -18.0,      // -18 dB calibrated studio reference level
            opt_mode: 0,         // ADAT (8-ch optical expansion default)
            main_src: 0,         // Main Mix
            lb_virt_out: 0,
            mixer_links: BTreeMap::new(),
            mixer_mutes: BTreeMap::new(),
            mixer_vols: BTreeMap::new(),
            mixer_pans: BTreeMap::new(),
            out_router_links: BTreeMap::new(),
            eq_bypass: BTreeMap::new(),
            input_polarity: BTreeMap::new(),
            comp_blend: BTreeMap::new(),
        }
    }
}

/// Hardware entity IDs (`wIndex = (entity << 8)`)
pub const ENT_SYSTEM: u8 = 0x00;
pub const ENT_INPUTS: u8 = 0x01;
pub const ENT_OUTPUTS: u8 = 0x02;
pub const ENT_DIGITAL: u8 = 0x03;
pub const ENT_MONITOR: u8 = 0x04;
pub const ENT_MIXER: u8 = 0x05;
pub const ENT_BUS_MASTER: u8 = 0x06;
pub const ENT_DSP: u8 = 0x07;
pub const ENT_ROOM: u8 = 0x08;
pub const ENT_REVERB: u8 = 0x09;
pub const ENT_SMARTGAIN: u8 = 0x0B;

const BREQ_PARAM: u8 = 1;
const BREQ_EVENT_POLL: u8 = 3;
const BREQ_METERS: u8 = 4;
const BREQ_SYS_CMD: u8 = 5;
const BREQ_FILTER_COEFF: u8 = 7;

pub const SYS_CMD_SAVE_BOOT_STATE: u16 = 5;
pub const SYS_CMD_LOAD_BOOT_STATE: u16 = 6;

const SAMPLE_RATES_DSP: [u32; 4] = [44100, 48000, 88200, 96000];
const SAMPLE_RATES_ALL: [u32; 6] = [44100, 48000, 88200, 96000, 176400, 192000];

/// Convert dB value to Q8.8 signed 16-bit little-endian bytes (`-128.0 dB` = `0x8000` mute)
pub fn db_to_q88(db: f64) -> [u8; 2] {
    let clamped = db.clamp(-128.0, 127.996);
    let raw = if clamped <= -128.0 {
        i16::MIN
    } else {
        (clamped * 256.0).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
    };
    raw.to_le_bytes()
}

/// Convert Q8.8 little-endian bytes to f64 dB
pub fn q88_to_db(bytes: &[u8]) -> f64 {
    if bytes.len() < 2 {
        return 0.0;
    }
    let raw = i16::from_le_bytes([bytes[0], bytes[1]]);
    if raw == i16::MIN {
        -128.0
    } else {
        (raw as f64) / 256.0
    }
}

/// Convert linear u16 meter reading (0..65535) to dBFS
pub fn meter_u16_to_dbfs(v: u16) -> f64 {
    if v == 0 {
        -128.0
    } else {
        (20.0 * (v as f64 / 65535.0).log10()).clamp(-128.0, 0.0)
    }
}

/// Convert linear u16 compressor gain reduction (65535 = 0 dB GR) to negative dB
pub fn meter_gr_u16_to_db(v: u16) -> f64 {
    if v >= 65535 {
        0.0
    } else if v == 0 {
        -24.0
    } else {
        (20.0 * (v as f64 / 65535.0).log10()).clamp(-24.0, 0.0)
    }
}

/// Compute 32-byte Cytomic SVF fixed-point coefficient packet for `bReq=7, wVal=0x1D00|ch`.
/// `m_shift` = 29 for HPF/EQ bands (0, 4..7), 28 for Polarity/APF band (1).
pub fn encode_svf_packet(
    band_idx: u32,
    sample_rate: u32,
    filter_type: u16,
    freq_hz: f64,
    gain_db: f64,
    q_val: f64,
    polarity_invert: bool,
    bypassed: bool,
) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..4].copy_from_slice(&band_idx.to_le_bytes());
    out[4..8].copy_from_slice(&sample_rate.to_le_bytes());

    let m_scale = if band_idx == 1 {
        (1u64 << 28) as f64
    } else {
        (1u64 << 29) as f64
    };
    let a_scale = (1u64 << 30) as f64;

    // Band 1 handles Polarity invert & V-Phase (All-Pass Filter)
    if bypassed || filter_type == 11 {
        let m0 = if band_idx == 1 && polarity_invert {
            -1.0
        } else {
            1.0
        };
        out[8..12].copy_from_slice(&((m0 * m_scale).round() as i32).to_le_bytes());
        return out;
    }

    let sr = sample_rate as f64;
    let f = freq_hz.clamp(15.0, sr * 0.45);
    let q = q_val.clamp(0.1, 24.0);
    let mut g = (PI * f / sr).tan();
    let mut k = 1.0 / q;
    let a_amp = 10.0_f64.powf(gain_db / 40.0);

    let (m0, m1, m2) = match filter_type {
        // 3 = High Pass
        3 => (1.0, -k, -1.0),
        // 1 = Low Pass
        1 => (0.0, 0.0, 1.0),
        // 8 = Bell / Peak
        8 => {
            k = 1.0 / (q * a_amp);
            (1.0, k * (a_amp * a_amp - 1.0), 0.0)
        }
        // 5 = Low Shelf
        5 => {
            g /= a_amp.sqrt();
            (1.0, k * (a_amp - 1.0), a_amp * a_amp - 1.0)
        }
        // 7 = High Shelf
        7 => {
            g *= a_amp.sqrt();
            (a_amp * a_amp, k * (1.0 - a_amp) * a_amp, 1.0 - a_amp * a_amp)
        }
        // 13 = All-Pass (V-Phase)
        13 => {
            let sign = if polarity_invert { -1.0 } else { 1.0 };
            (sign, -2.0 * k * sign, 0.0)
        }
        _ => (1.0, 0.0, 0.0),
    };

    let a1 = 1.0 / (1.0 + g * (g + k));
    let a2 = g * a1;
    let a3 = g * a2;

    let to_i32 = |v: f64, sc: f64| -> i32 {
        (v * sc).round().clamp(i32::MIN as f64, i32::MAX as f64) as i32
    };

    out[8..12].copy_from_slice(&to_i32(m0, m_scale).to_le_bytes());
    out[12..16].copy_from_slice(&to_i32(m1, m_scale).to_le_bytes());
    out[16..20].copy_from_slice(&to_i32(m2, m_scale).to_le_bytes());
    out[20..24].copy_from_slice(&to_i32(a1, a_scale).to_le_bytes());
    out[24..28].copy_from_slice(&to_i32(a2, a_scale).to_le_bytes());
    out[28..32].copy_from_slice(&to_i32(a3, a_scale).to_le_bytes());
    out
}

/// Hardware binding target attached to a synthesized ValueTree param path
#[derive(Debug, Clone)]
pub enum HwBinding {
    SampleRate,
    ClockSource,
    BufferSize,
    SystemBool(u8),
    DigitalBool(u8),
    MonitorVol,
    MonitorBool(u8),
    MonitorQ88(u8),
    Hp1Vol,
    Hp1Mute,
    Hp1Src,
    OutputSrc { ch: u8 },
    OutputVol { ch: u8 },
    OutputMute { ch: u8 },
    LoopbackSrc,
    InputGain { ch: u8 },
    InputTrim { ch: u8 },
    InputBool { ch: u8, cs: u8 },
    InputPolarity { ch: u8 },
    InputHpfEnable { ch: u8 },
    InputHpfFreq { ch: u8 },
    InputApfType { ch: u8 },
    InputApfPhase { ch: u8 },
    EqBypass { ch: u8 },
    EqBand { ch: u8, band: u8 },
    CompParam { ch: u8, cs: u8 },
    CompBypassOrBlend { ch: u8 },
    DspOrder { ch: u8 },
    MixerChannel { bus: u8, src: u8 },
    BusMasterVol { bus: u8 },
    ReverbParam { cs: u8, scale: f64 },
    SmartGainTrigger,
    SmartGainArm { ch: u8 },
    RoomBypass,
    RoomProfTrim,
    RoomSpkTrim { ch: u8 },
    RoomSpkDelay { ch: u8 },
    RoomSpkDelayOn { ch: u8, dly_path: Vec<usize> },
    RoomEqBand {
        ch: u8,
        cs: u8,
        t_path: Vec<usize>,
        f_path: Vec<usize>,
        g_path: Vec<usize>,
        q_path: Vec<usize>,
    },
    FnKeyMode,
}

/// Reverse lookup key for hardware change events `[cs, ch, 0, entity]`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HwRegKey {
    pub entity: u8,
    pub cs: u8,
    pub ch: u8,
}

/// Complete synthesized tree + bidirectional hardware binding tables
pub struct DirectContext {
    pub tree: ValueTreeNode,
    pub device_name: String,
    pub serial: String,
    pub sample_rate: u32,
    pub analog_count: u8,
    pub path_to_hw: HashMap<Vec<usize>, HwBinding>,
    pub hw_to_path: HashMap<HwRegKey, Vec<usize>>,
    /// Last known raw hardware values for fast diff-polling of physical knob & front-panel buttons
    pub last_watched: HashMap<HwRegKey, i32>,
    /// Round-robin cursor so front-panel fallback polling never stalls the 60 Hz meter loop
    pub panel_cursor: usize,
    /// Per-bus, per-src live channel state `(vol, pan, mute)`
    pub mixer_ch_paths: HashMap<(u8, u8), MixerChPaths>,
    /// Per-input-channel DSP paths for recomputing SVF filters cleanly
    pub input_dsp_paths: HashMap<u8, InputDspPaths>,
}

#[derive(Debug, Clone)]
pub struct MixerChPaths {
    pub vol: Vec<usize>,
    pub pan: Vec<usize>,
    pub mute: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct InputDspPaths {
    pub hpf_en: Option<Vec<usize>>,
    pub hpf_freq: Option<Vec<usize>>,
    pub polarity: Option<Vec<usize>>,
    pub apf_type: Option<Vec<usize>>,
    pub apf_phase: Option<Vec<usize>>,
    pub eq_byps: Vec<usize>,
    pub eq_bands: [(Vec<usize>, Vec<usize>, Vec<usize>, Vec<usize>); 4], // (T, F, G, Q)
    pub comp_byps: Vec<usize>,
    pub comp_blend: Vec<usize>,
}

// ============================================================================
// Platform USB Transport Layer
// ============================================================================

#[cfg(target_os = "windows")]
mod transport {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *const c_void;
        fn FreeLibrary(h_lib_module: *mut c_void) -> i32;
    }

    type FnEnumerate = unsafe extern "C" fn() -> u32;
    type FnGetCount = unsafe extern "C" fn() -> u32;
    type FnOpenByIdx = unsafe extern "C" fn(u32, *mut usize) -> u32;
    type FnClose = unsafe extern "C" fn(usize) -> u32;
    type FnGetU32 = unsafe extern "C" fn(usize, *mut u32) -> u32;
    type FnSetU32 = unsafe extern "C" fn(usize, u32) -> u32;
    type FnVendorIn = unsafe extern "C" fn(
        usize,
        u32,
        u8,
        u8,
        u16,
        u16,
        u16,
        *mut u8,
        *mut u32,
        u32,
    ) -> u32;
    type FnVendorOut = unsafe extern "C" fn(
        usize,
        u32,
        u8,
        u8,
        u16,
        u16,
        u16,
        *const u8,
        *mut u32,
        u32,
    ) -> u32;
    type FnGetInstId = unsafe extern "C" fn(usize, *mut u16, u32) -> u32;
    type FnGetDevProps = unsafe extern "C" fn(usize, *mut u8) -> u32;

    pub struct TusbApi {
        module: *mut c_void,
        enumerate: FnEnumerate,
        get_count: FnGetCount,
        open_by_idx: FnOpenByIdx,
        close: FnClose,
        get_sr: Option<FnGetU32>,
        set_sr: Option<FnSetU32>,
        set_clk: Option<FnSetU32>,
        set_asio_buf: Option<FnSetU32>,
        get_inst_id: Option<FnGetInstId>,
        get_dev_props: Option<FnGetDevProps>,
        vendor_in: FnVendorIn,
        vendor_out: FnVendorOut,
    }

    unsafe impl Send for TusbApi {}
    unsafe impl Sync for TusbApi {}

    impl Drop for TusbApi {
        fn drop(&mut self) {
            if !self.module.is_null() {
                unsafe {
                    FreeLibrary(self.module);
                }
            }
        }
    }

    fn candidate_dll_paths() -> Vec<PathBuf> {
        let mut out = Vec::new();
        for env_k in ["ProgramW6432", "ProgramFiles"] {
            if let Ok(base) = std::env::var(env_k) {
                let p = PathBuf::from(base)
                    .join("Audient")
                    .join("USBAudioDriver")
                    .join("x64")
                    .join("audientusbaudioapi_x64.dll");
                if p.exists() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        let fallback = PathBuf::from(r"C:\Program Files\Audient\USBAudioDriver\x64\audientusbaudioapi_x64.dll");
        if fallback.exists() && !out.contains(&fallback) {
            out.push(fallback);
        }
        out
    }

    pub fn is_driver_dll_available() -> bool {
        !candidate_dll_paths().is_empty()
    }

    unsafe fn sym<T: Copy>(m: *mut c_void, name: &[u8]) -> Option<T> {
        let ptr = GetProcAddress(m, name.as_ptr());
        if ptr.is_null() {
            None
        } else {
            Some(std::mem::transmute_copy(&ptr))
        }
    }

    impl TusbApi {
        pub fn load() -> Result<Self, String> {
            let paths = candidate_dll_paths();
            let Some(path) = paths.into_iter().next() else {
                return Err("audientusbaudioapi_x64.dll not found".into());
            };
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let module = unsafe { LoadLibraryW(wide.as_ptr()) };
            if module.is_null() {
                return Err(format!("LoadLibraryW failed for {}", path.display()));
            }
            unsafe {
                let enumerate: FnEnumerate = sym(module, b"TUSBAUDIO_EnumerateDevices\0")
                    .ok_or("Missing TUSBAUDIO_EnumerateDevices")?;
                let get_count: FnGetCount = sym(module, b"TUSBAUDIO_GetDeviceCount\0")
                    .ok_or("Missing TUSBAUDIO_GetDeviceCount")?;
                let open_by_idx: FnOpenByIdx = sym(module, b"TUSBAUDIO_OpenDeviceByIndex\0")
                    .ok_or("Missing TUSBAUDIO_OpenDeviceByIndex")?;
                let close: FnClose = sym(module, b"TUSBAUDIO_CloseDevice\0")
                    .ok_or("Missing TUSBAUDIO_CloseDevice")?;
                let vendor_in: FnVendorIn = sym(module, b"TUSBAUDIO_ClassVendorRequestIn\0")
                    .ok_or("Missing TUSBAUDIO_ClassVendorRequestIn")?;
                let vendor_out: FnVendorOut = sym(module, b"TUSBAUDIO_ClassVendorRequestOut\0")
                    .ok_or("Missing TUSBAUDIO_ClassVendorRequestOut")?;
                let get_sr = sym(module, b"TUSBAUDIO_GetCurrentSampleRate\0");
                let set_sr = sym(module, b"TUSBAUDIO_SetSampleRate\0");
                let set_clk = sym(module, b"TUSBAUDIO_SetCurrentClockSource\0");
                let set_asio_buf = sym(module, b"TUSBAUDIO_SetASIOBufferPreferredSize\0");
                let get_inst_id = sym(module, b"TUSBAUDIO_GetDeviceInstanceIdString\0");
                let get_dev_props = sym(module, b"TUSBAUDIO_GetDeviceProperties\0");
                Ok(Self {
                    module,
                    enumerate,
                    get_count,
                    open_by_idx,
                    close,
                    get_sr,
                    set_sr,
                    set_clk,
                    set_asio_buf,
                    get_inst_id,
                    get_dev_props,
                    vendor_in,
                    vendor_out,
                })
            }
        }

        pub fn open_first(&self) -> Result<TusbDevice<'_>, String> {
            unsafe {
                let _ = (self.enumerate)();
                let cnt = (self.get_count)();
                if cnt == 0 {
                    return Err("No Audient USB device detected".into());
                }
                for idx in 0..cnt {
                    let mut handle: usize = 0;
                    let st = (self.open_by_idx)(idx, &mut handle);
                    if st != 0 || handle == 0 {
                        continue;
                    }
                    let dev = TusbDevice { api: self, handle };
                    if dev.is_supported_mk3() {
                        // Wait until the TUSBAudio clock/streaming interface is actually ready
                        if dev.get_sample_rate().is_some() {
                            return Ok(dev);
                        }
                        return Err("Audient MK3 device still initializing".into());
                    }
                }
                Err("No supported Audient MK3 device (iD1, iD2, iD2+, iD4+) detected".into())
            }
        }
    }

    pub struct TusbDevice<'a> {
        api: &'a TusbApi,
        handle: usize,
    }

    impl<'a> Drop for TusbDevice<'a> {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe {
                    (self.api.close)(self.handle);
                }
            }
        }
    }

    impl<'a> TusbDevice<'a> {
        pub fn vendor_in(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            len: u16,
        ) -> Result<Vec<u8>, u32> {
            let mut buf = vec![0u8; len as usize];
            let mut ret: u32 = 0;
            let w_index = (entity as u16) << 8;
            let st = unsafe {
                (self.api.vendor_in)(
                    self.handle,
                    1, // recipient = interface
                    0, // is_class = 0 (vendor)
                    b_req,
                    w_index,
                    w_value,
                    len,
                    buf.as_mut_ptr(),
                    &mut ret,
                    1000,
                )
            };
            if st != 0 {
                return Err(st);
            }
            buf.truncate(ret as usize);
            Ok(buf)
        }

        pub fn vendor_out(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            data: &[u8],
        ) -> Result<(), u32> {
            let mut ret: u32 = 0;
            let w_index = (entity as u16) << 8;
            let st = unsafe {
                (self.api.vendor_out)(
                    self.handle,
                    1, // recipient = interface
                    0, // is_class = 0 (vendor)
                    b_req,
                    w_index,
                    w_value,
                    data.len() as u16,
                    data.as_ptr(),
                    &mut ret,
                    1000,
                )
            };
            if st != 0 {
                return Err(st);
            }
            Ok(())
        }

        pub fn get_sample_rate(&self) -> Option<u32> {
            let f = self.api.get_sr?;
            let mut sr: u32 = 0;
            let st = unsafe { f(self.handle, &mut sr) };
            if st == 0 && sr > 0 { Some(sr) } else { None }
        }

        pub fn set_sample_rate(&self, sr: u32) -> Result<(), u32> {
            let Some(f) = self.api.set_sr else {
                return Ok(());
            };
            let st = unsafe { f(self.handle, sr) };
            if st == 0 { Ok(()) } else { Err(st) }
        }

        pub fn set_clock_source(&self, clk_id: u32) -> Result<(), u32> {
            let Some(f) = self.api.set_clk else {
                return Ok(());
            };
            let st = unsafe { f(self.handle, clk_id) };
            if st == 0 { Ok(()) } else { Err(st) }
        }

        pub fn set_asio_buffer_size(&self, samples: u32) -> Result<(), u32> {
            let Some(f) = self.api.set_asio_buf else {
                return Ok(());
            };
            let st = unsafe { f(self.handle, samples) };
            if st == 0 { Ok(()) } else { Err(st) }
        }

        pub fn is_supported_mk3(&self) -> bool {
            let model = self.detect_model_name();
            if matches!(model.as_str(), "iD1" | "iD2" | "iD2+" | "iD4+") {
                return true;
            }
            if let Some(f) = self.api.get_inst_id {
                let mut wide = [0u16; 256];
                let st = unsafe { f(self.handle, wide.as_mut_ptr(), wide.len() as u32) };
                if st == 0 {
                    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
                    let s = String::from_utf16_lossy(&wide[..end]).to_ascii_uppercase();
                    return s.contains("PID_0014")
                        || s.contains("PID_0015")
                        || s.contains("PID_0016")
                        || s.contains("PID_0018");
                }
            }
            false
        }

        pub fn detect_model_name(&self) -> String {
            // Primary: read exact USB product descriptor string from TUSBAudio driver properties
            // Layout: [0..4]=VID, [4..8]=PID, [8..12]=Rev, [12..268]=Serial(UTF-16),
            //         [268..524]=Manufacturer(UTF-16), [524..780]=ProductName(UTF-16)
            if let Some(f) = self.api.get_dev_props {
                let mut raw = [0u8; 4096];
                let st = unsafe { f(self.handle, raw.as_mut_ptr()) };
                if st == 0 {
                    let units: Vec<u16> = raw[524..780]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .take_while(|&u| u != 0)
                        .collect();
                    let product = String::from_utf16_lossy(&units).trim().to_string();
                    let cleaned = product
                        .strip_prefix("Audient ")
                        .or_else(|| product.strip_prefix("AUDIENT "))
                        .unwrap_or(&product)
                        .trim()
                        .to_string();
                    if !cleaned.is_empty() {
                        return cleaned;
                    }
                }
            }
            // Fallback: map known USB PID from device instance ID
            if let Some(f) = self.api.get_inst_id {
                let mut wide = [0u16; 256];
                let st = unsafe { f(self.handle, wide.as_mut_ptr(), wide.len() as u32) };
                if st == 0 {
                    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
                    let s = String::from_utf16_lossy(&wide[..end]).to_ascii_uppercase();
                    if s.contains("PID_0014") {
                        return "iD1".into();
                    } else if s.contains("PID_0015") {
                        return "iD2".into();
                    } else if s.contains("PID_0016") {
                        return "iD2+".into();
                    } else if s.contains("PID_0017") {
                        return "iD4".into();
                    } else if s.contains("PID_0018") {
                        return "iD4+".into();
                    }
                }
            }
            "Audient".into()
        }
    }
}

#[cfg(target_os = "macos")]
mod transport {
    use std::ffi::{c_char, c_int, c_void, CStr};

    extern "C" {
        fn macos_usb_open_mk3(out_name: *mut c_char, out_name_len: c_int) -> *mut c_void;
        fn macos_usb_close(handle: *mut c_void);
        fn macos_usb_vendor_in(
            handle: *mut c_void,
            b_req: u8,
            entity: u8,
            w_value: u16,
            buf: *mut u8,
            len: u16,
            out_len: *mut u32,
        ) -> c_int;
        fn macos_usb_vendor_out(
            handle: *mut c_void,
            b_req: u8,
            entity: u8,
            w_value: u16,
            buf: *const u8,
            len: u16,
        ) -> c_int;
    }

    pub fn is_driver_dll_available() -> bool {
        true
    }

    pub struct TusbApi;

    impl TusbApi {
        pub fn load() -> Result<Self, String> {
            Ok(Self)
        }

        pub fn open_first(&self) -> Result<TusbDevice<'_>, String> {
            let mut name_buf = [0u8; 128];
            let handle = unsafe {
                macos_usb_open_mk3(name_buf.as_mut_ptr() as *mut c_char, name_buf.len() as c_int)
            };
            if handle.is_null() {
                return Err("No supported Audient MK3 device (iD1, iD2, iD2+, iD4+) detected".into());
            }
            let raw_name = unsafe { CStr::from_ptr(name_buf.as_ptr() as *const c_char) }
                .to_string_lossy()
                .trim()
                .to_string();
            let model_name = raw_name
                .strip_prefix("Audient ")
                .or_else(|| raw_name.strip_prefix("AUDIENT "))
                .unwrap_or(&raw_name)
                .trim()
                .to_string();
            let dev = TusbDevice {
                _marker: std::marker::PhantomData,
                handle,
                model_name: if model_name.is_empty() {
                    "Audient".into()
                } else {
                    model_name
                },
            };
            // Verify control endpoint is awake before reporting ready (retry briefly after rapid Cmd+Q relaunch)
            let mut awake = false;
            for attempt in 0..3 {
                if dev.vendor_in(0x01, 0x00, 0x0200, 4).is_ok()
                    || dev.vendor_in(0x01, 0x04, 0x0A00, 2).is_ok()
                {
                    awake = true;
                    break;
                }
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(60));
                }
            }
            if !awake {
                return Err("Audient MK3 device still initializing".into());
            }
            Ok(dev)
        }
    }

    pub struct TusbDevice<'a> {
        _marker: std::marker::PhantomData<&'a ()>,
        handle: *mut c_void,
        model_name: String,
    }

    unsafe impl<'a> Send for TusbDevice<'a> {}

    impl<'a> Drop for TusbDevice<'a> {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    macos_usb_close(self.handle);
                }
                self.handle = std::ptr::null_mut();
            }
        }
    }

    impl<'a> TusbDevice<'a> {
        pub fn vendor_in(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            len: u16,
        ) -> Result<Vec<u8>, u32> {
            let mut buf = vec![0u8; len as usize];
            let mut ret: u32 = 0;
            let st = unsafe {
                macos_usb_vendor_in(
                    self.handle,
                    b_req,
                    entity,
                    w_value,
                    buf.as_mut_ptr(),
                    len,
                    &mut ret,
                )
            };
            if st != 0 {
                return Err(st as u32);
            }
            buf.truncate((ret as usize).min(buf.len()));
            Ok(buf)
        }

        pub fn vendor_out(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            data: &[u8],
        ) -> Result<(), u32> {
            let st = unsafe {
                macos_usb_vendor_out(
                    self.handle,
                    b_req,
                    entity,
                    w_value,
                    data.as_ptr(),
                    data.len() as u16,
                )
            };
            if st != 0 {
                return Err(st as u32);
            }
            Ok(())
        }

        pub fn get_sample_rate(&self) -> Option<u32> {
            self.vendor_in(0x01, 0x00, 0x0200, 4)
                .ok()
                .filter(|b| b.len() >= 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .filter(|&sr| sr > 0)
        }

        pub fn set_sample_rate(&self, sr: u32) -> Result<(), u32> {
            self.vendor_out(0x01, 0x00, 0x0200, &sr.to_le_bytes())
        }

        pub fn set_clock_source(&self, _clk_id: u32) -> Result<(), u32> {
            Ok(())
        }

        pub fn set_asio_buffer_size(&self, _samples: u32) -> Result<(), u32> {
            Ok(())
        }

        pub fn detect_model_name(&self) -> String {
            self.model_name.clone()
        }
    }
}

#[cfg(target_os = "linux")]
mod transport {
    use std::ffi::{c_int, c_ulong, c_void};
    use std::fs::{File, OpenOptions};
    use std::os::unix::io::AsRawFd;

    #[repr(C)]
    struct UsbdevfsCtrlTransfer {
        b_request_type: u8,
        b_request: u8,
        w_value: u16,
        w_index: u16,
        w_length: u16,
        timeout: u32,
        data: *mut c_void,
    }

    // _IOWR('U', 0, struct usbdevfs_ctrltransfer)
    const USBDEVFS_CONTROL: c_ulong = (3u64 << 30) as c_ulong
        | ((std::mem::size_of::<UsbdevfsCtrlTransfer>() as c_ulong) << 16)
        | ((b'U' as c_ulong) << 8);

    extern "C" {
        fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    }

    pub fn is_driver_dll_available() -> bool {
        true
    }

    pub struct TusbApi;

    impl TusbApi {
        pub fn load() -> Result<Self, String> {
            Ok(Self)
        }

        pub fn open_first(&self) -> Result<TusbDevice<'_>, String> {
            let entries = std::fs::read_dir("/sys/bus/usb/devices")
                .map_err(|e| format!("Failed to scan /sys/bus/usb/devices: {e}"))?;

            for entry in entries.flatten() {
                let p = entry.path();
                let vid = match std::fs::read_to_string(p.join("idVendor")) {
                    Ok(s) => s.trim().to_ascii_lowercase(),
                    Err(_) => continue,
                };
                if vid != "2708" {
                    continue;
                }
                let pid = match std::fs::read_to_string(p.join("idProduct")) {
                    Ok(s) => s.trim().to_ascii_lowercase(),
                    Err(_) => continue,
                };
                let fallback_name = match pid.as_str() {
                    "0014" => "iD1",
                    "0015" => "iD2",
                    "0016" => "iD2+",
                    "0018" => "iD4+",
                    _ => continue,
                };
                let busnum: u32 = match std::fs::read_to_string(p.join("busnum"))
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                {
                    Some(n) => n,
                    None => continue,
                };
                let devnum: u32 = match std::fs::read_to_string(p.join("devnum"))
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                {
                    Some(n) => n,
                    None => continue,
                };
                let raw_name = std::fs::read_to_string(p.join("product"))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let model_name = raw_name
                    .strip_prefix("Audient ")
                    .or_else(|| raw_name.strip_prefix("AUDIENT "))
                    .unwrap_or(&raw_name)
                    .trim()
                    .to_string();
                let model_name = if model_name.is_empty() {
                    fallback_name.to_string()
                } else {
                    model_name
                };

                let dev_path = format!("/dev/bus/usb/{busnum:03}/{devnum:03}");
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&dev_path)
                    .map_err(|e| {
                        format!(
                            "Found Audient {model_name} at {dev_path}, but failed to open ({e}). Install the Audient udev rule (99-audient-id.rules)."
                        )
                    })?;

                let dev = TusbDevice {
                    _marker: std::marker::PhantomData,
                    file,
                    model_name,
                };
                // Verify control endpoint is awake before reporting ready
                if dev.vendor_in(0x01, 0x00, 0x0200, 4).is_err() {
                    return Err("Audient MK3 device still initializing".into());
                }
                return Ok(dev);
            }

            Err("No supported Audient MK3 device (iD1, iD2, iD2+, iD4+) detected".into())
        }
    }

    pub struct TusbDevice<'a> {
        _marker: std::marker::PhantomData<&'a ()>,
        file: File,
        model_name: String,
    }

    impl<'a> TusbDevice<'a> {
        pub fn vendor_in(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            len: u16,
        ) -> Result<Vec<u8>, u32> {
            let mut buf = vec![0u8; len as usize];
            let mut ctrl = UsbdevfsCtrlTransfer {
                b_request_type: 0xC1, // IN | Vendor | Interface
                b_request: b_req,
                w_value,
                w_index: (entity as u16) << 8,
                w_length: len,
                timeout: 1000,
                data: buf.as_mut_ptr() as *mut c_void,
            };
            let ret = unsafe { ioctl(self.file.as_raw_fd(), USBDEVFS_CONTROL, &mut ctrl) };
            if ret < 0 {
                return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(1) as u32);
            }
            buf.truncate((ret as usize).min(buf.len()));
            Ok(buf)
        }

        pub fn vendor_out(
            &self,
            b_req: u8,
            entity: u8,
            w_value: u16,
            data: &[u8],
        ) -> Result<(), u32> {
            let mut ctrl = UsbdevfsCtrlTransfer {
                b_request_type: 0x41, // OUT | Vendor | Interface
                b_request: b_req,
                w_value,
                w_index: (entity as u16) << 8,
                w_length: data.len() as u16,
                timeout: 1000,
                data: data.as_ptr() as *mut c_void,
            };
            let ret = unsafe { ioctl(self.file.as_raw_fd(), USBDEVFS_CONTROL, &mut ctrl) };
            if ret < 0 {
                return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(1) as u32);
            }
            Ok(())
        }

        pub fn get_sample_rate(&self) -> Option<u32> {
            self.vendor_in(0x01, 0x00, 0x0200, 4)
                .ok()
                .filter(|b| b.len() >= 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .filter(|&sr| sr > 0)
        }

        pub fn set_sample_rate(&self, sr: u32) -> Result<(), u32> {
            self.vendor_out(0x01, 0x00, 0x0200, &sr.to_le_bytes())
        }

        pub fn set_clock_source(&self, _clk_id: u32) -> Result<(), u32> {
            Ok(())
        }

        pub fn set_asio_buffer_size(&self, _samples: u32) -> Result<(), u32> {
            Ok(())
        }

        pub fn detect_model_name(&self) -> String {
            self.model_name.clone()
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod transport {
    pub struct TusbApi;
    pub struct TusbDevice<'a>(std::marker::PhantomData<&'a ()>);

    pub fn is_driver_dll_available() -> bool {
        false
    }

    impl TusbApi {
        pub fn load() -> Result<Self, String> {
            Err("Direct USB transport currently implemented for Windows TUSBAudio driver".into())
        }
        pub fn open_first(&self) -> Result<TusbDevice<'_>, String> {
            Err("Unsupported".into())
        }
    }

    impl<'a> TusbDevice<'a> {
        pub fn vendor_in(&self, _: u8, _: u8, _: u16, _: u16) -> Result<Vec<u8>, u32> { Err(1) }
        pub fn vendor_out(&self, _: u8, _: u8, _: u16, _: &[u8]) -> Result<(), u32> { Err(1) }
        pub fn get_sample_rate(&self) -> Option<u32> { None }
        pub fn set_sample_rate(&self, _: u32) -> Result<(), u32> { Err(1) }
        pub fn set_clock_source(&self, _: u32) -> Result<(), u32> { Err(1) }
        pub fn set_asio_buffer_size(&self, _: u32) -> Result<(), u32> { Err(1) }
        pub fn detect_model_name(&self) -> String { "Audient".into() }
    }
}

pub use transport::{is_driver_dll_available, TusbApi, TusbDevice};

// ============================================================================
// ValueTree Builder & Live Hardware Snapshot Reader
// ============================================================================

fn node(tag: &str, props: Vec<(&str, JuceVar)>, children: Vec<ValueTreeNode>) -> ValueTreeNode {
    let mut map = BTreeMap::new();
    for (k, v) in props {
        map.insert(k.to_string(), v);
    }
    ValueTreeNode {
        tag: tag.to_string(),
        props: map,
        children,
    }
}

fn param_int(name: &str, val: i32, key: Option<i32>, editable: bool) -> ValueTreeNode {
    let mut props = vec![
        ("name", JuceVar::String(name.into())),
        ("value", JuceVar::Int(val)),
        ("editable", JuceVar::Bool(editable)),
    ];
    if let Some(k) = key {
        props.push(("key", JuceVar::Int(k)));
    }
    node("param", props, vec![])
}

fn param_f64(name: &str, val: f64, key: Option<i32>, editable: bool) -> ValueTreeNode {
    let mut props = vec![
        ("name", JuceVar::String(name.into())),
        ("value", JuceVar::Double(val)),
        ("editable", JuceVar::Bool(editable)),
    ];
    if let Some(k) = key {
        props.push(("key", JuceVar::Int(k)));
    }
    node("param", props, vec![])
}

fn param_str(name: &str, val: &str) -> ValueTreeNode {
    node(
        "param",
        vec![
            ("name", JuceVar::String(name.into())),
            ("value", JuceVar::String(val.into())),
            ("editable", JuceVar::Bool(true)),
        ],
        vec![],
    )
}

fn lookup_vm(vm_id: i32, opts: &[(i32, &str)]) -> ValueTreeNode {
    let children = opts
        .iter()
        .map(|(v, n)| {
            node(
                "option",
                vec![
                    ("value", JuceVar::Int(*v)),
                    ("name", JuceVar::String((*n).into())),
                ],
                vec![],
            )
        })
        .collect();
    node(
        "VM",
        vec![
            ("vmId", JuceVar::Int(vm_id)),
            ("type", JuceVar::String("lookup".into())),
            ("valType", JuceVar::String("int".into())),
        ],
        children,
    )
}

fn hw_get_u8(dev: &TusbDevice<'_>, ent: u8, cs: u8, ch: u8, default: u8) -> u8 {
    dev.vendor_in(BREQ_PARAM, ent, ((cs as u16) << 8) | (ch as u16), 1)
        .ok()
        .and_then(|b| b.first().copied())
        .unwrap_or(default)
}

fn hw_get_q88(dev: &TusbDevice<'_>, ent: u8, cs: u8, ch: u8, default: f64) -> f64 {
    dev.vendor_in(BREQ_PARAM, ent, ((cs as u16) << 8) | (ch as u16), 2)
        .ok()
        .filter(|b| b.len() >= 2)
        .map(|b| q88_to_db(&b))
        .unwrap_or(default)
}

fn hw_get_u16(dev: &TusbDevice<'_>, ent: u8, cs: u8, ch: u8, default: u16) -> u16 {
    dev.vendor_in(BREQ_PARAM, ent, ((cs as u16) << 8) | (ch as u16), 2)
        .ok()
        .filter(|b| b.len() >= 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .unwrap_or(default)
}

fn hw_get_q24_8(dev: &TusbDevice<'_>, ent: u8, cs: u8, ch: u8, default: f64) -> f64 {
    dev.vendor_in(BREQ_PARAM, ent, ((cs as u16) << 8) | (ch as u16), 4)
        .ok()
        .filter(|b| b.len() >= 4)
        .map(|b| (i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64) / 256.0)
        .unwrap_or(default)
}

fn hw_get_u32(dev: &TusbDevice<'_>, ent: u8, cs: u8, ch: u8, default: u32) -> u32 {
    dev.vendor_in(BREQ_PARAM, ent, ((cs as u16) << 8) | (ch as u16), 4)
        .ok()
        .filter(|b| b.len() >= 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .unwrap_or(default)
}

fn hw_get_room_eq_band(dev: &TusbDevice<'_>, cs: u8, ch: u8, def_t: i32, def_f: f64, def_q: f64) -> (i32, f64, f64, f64) {
    if let Ok(b) = dev.vendor_in(BREQ_PARAM, ENT_ROOM, ((cs as u16) << 8) | (ch as u16), 8) {
        if b.len() >= 8 {
            let t = u16::from_le_bytes([b[0], b[1]]) as i32;
            let f = u16::from_le_bytes([b[2], b[3]]) as f64;
            let g = q88_to_db(&b[4..6]);
            let q = (u16::from_le_bytes([b[6], b[7]]) as f64) / 256.0;
            // Hardware stores placeholder (1000 Hz, +1 dB) for bypassed (t==11) bands; keep clean default spread when bypassed.
            if t == 11 {
                return (11, def_f, 0.0, def_q);
            }
            if (1..=14).contains(&t) && (20.0..=20000.0).contains(&f) {
                return (t, f, g.clamp(-12.0, 12.0), q.clamp(0.3, 12.0));
            }
        }
    }
    (def_t, def_f, 0.0, def_q)
}

fn hw_get_eq_band(dev: &TusbDevice<'_>, cs: u8, ch: u8, def_t: i32, def_f: f64, def_q: f64) -> (i32, f64, f64, f64) {
    if let Ok(b) = dev.vendor_in(BREQ_PARAM, ENT_DSP, ((cs as u16) << 8) | (ch as u16), 8) {
        if b.len() >= 8 {
            let t = u16::from_le_bytes([b[0], b[1]]) as i32;
            let f = u16::from_le_bytes([b[2], b[3]]) as f64;
            let g = q88_to_db(&b[4..6]);
            let q = (u16::from_le_bytes([b[6], b[7]]) as f64) / 256.0;
            // Hardware stores placeholder frequencies (e.g. 1000 Hz / 20000 Hz) for bypassed (t==11) bands; keep clean default spread.
            if t == 11 {
                return (11, def_f, 0.0, def_q);
            }
            if (1..=14).contains(&t) && (20.0..=20000.0).contains(&f) {
                return (t, f, g.clamp(-12.0, 12.0), q.clamp(0.1, 20.0));
            }
        }
    }
    (def_t, def_f, 0.0, def_q)
}

/// Convert hardware router source code (ent=0x02 cs=0x00) <-> UI source index
fn hw_out_src_to_ui(code: u8, is_hp: bool) -> i32 {
    if is_hp {
        match code {
            0x2B | 0x2C | 0x27 | 0x28 => 0, // MAIN
            0x1E | 0x1F => 1,               // MIX A
            0x20 | 0x21 => 2,               // MIX B
            0x0A..=0x0F => 3,               // VIRTUAL THRU
            _ => 0,                         // Safe fallback to MAIN on transient 0x00/0xFF boot reads
        }
    } else {
        match code {
            0x27 | 0x28 => 0, // MAIN
            0x29 | 0x2A => 1, // ALT
            0x1E | 0x1F => 2, // MIX A
            0x20 | 0x21 => 3, // MIX B
            0x0A..=0x0F => 4, // VIRTUAL THRU
            _ => 0,           // Safe fallback to MAIN on transient 0x00/0xFF boot reads
        }
    }
}

fn ui_out_src_to_hw(ui_val: i32, side: u8, is_hp: bool) -> u8 {
    let s = side & 1;
    if is_hp {
        match ui_val {
            0 => 0x2B + s, // HP MAIN
            1 => 0x1E + s, // MIX A
            2 => 0x20 + s, // MIX B
            _ => 0x0A + s, // VIRTUAL THRU
        }
    } else {
        match ui_val {
            0 => 0x27 + s, // MAIN
            1 => 0x29 + s, // ALT
            2 => 0x1E + s, // MIX A
            3 => 0x20 + s, // MIX B
            _ => 0x0A + s, // VIRTUAL THRU
        }
    }
}

fn ui_lb_src_to_hw(ui_val: i32, side: u8) -> u8 {
    let s = side & 1;
    match ui_val {
        0 => 0x27 + s, // MAIN MIX
        1 => 0x1E + s, // MIX A
        2 => 0x20 + s, // MIX B
        _ => 0x0A + s, // VIRTUAL THRU
    }
}

/// Convert stereo mixer crosspoints `(gain_l_db, gain_r_db)` back into `(vol_db, pan -64..64)`
fn crosspoints_to_vol_pan(gl: f64, gr: f64) -> (f64, i32) {
    if gl <= -127.5 && gr <= -127.5 {
        return (-128.0, 0);
    }
    if gr <= -127.5 {
        return (gl.clamp(-128.0, 6.0), -64);
    }
    if gl <= -127.5 {
        return (gr.clamp(-128.0, 6.0), 64);
    }
    let vol = gl.max(gr).clamp(-128.0, 6.0);
    let diff = gr - gl;
    let pan = if diff.abs() < 0.25 {
        0
    } else {
        (diff * 3.0).round().clamp(-64.0, 64.0) as i32
    };
    (vol, pan)
}

/// Convert UI mixer `(vol_db, pan -64..64, muted)` into hardware `(gain_l_db, gain_r_db)`
pub fn vol_pan_to_crosspoints(vol: f64, pan: i32, muted: bool) -> (f64, f64) {
    if muted || vol <= -128.0 {
        return (-128.0, -128.0);
    }
    let p = (pan.clamp(-64, 64) as f64) / 64.0; // -1.0 .. +1.0
    if p == 0.0 {
        return (vol, vol);
    }
    if p <= -0.99 {
        return (vol, -128.0);
    }
    if p >= 0.99 {
        return (-128.0, vol);
    }
    // Linear pan law (0 dB on dominant side, smooth attenuation on opposite side)
    if p < 0.0 {
        let right_lin = (1.0 + p).max(0.0001);
        (vol, (vol + 20.0 * right_lin.log10()).max(-128.0))
    } else {
        let left_lin = (1.0 - p).max(0.0001);
        ((vol + 20.0 * left_lin.log10()).max(-128.0), vol)
    }
}

/// Encode the 4-byte hardware Function button target binding for `ENT_MONITOR (0x04), cs=0x0D`:
/// `[target_cs, target_ch, target_entity, 0x00]` (entity `0xFF` = unbound/Off).
/// Standard modes 1..=6 bind directly to native hardware registers (zero latency + synced LED);
/// RoomTune (7) and Custom Studio Actions bind to `FnActive` (`ENT_MONITOR, cs=0x0E`) so hardware
/// toggles the LED and fires `FnActive` events without touching other monitor controls.
pub fn fn_key_mode_to_hw_bytes(fn_mode: i32, custom_active: bool) -> [u8; 4] {
    if custom_active {
        return [0x0E, 0x00, ENT_MONITOR, 0x00];
    }
    match fn_mode {
        1 => [0x03, 0x00, ENT_MONITOR, 0x00], // Dim
        2 => [0x07, 0x00, ENT_MONITOR, 0x00], // Alt Speaker
        3 => [0x05, 0x00, ENT_MONITOR, 0x00], // Talkback
        4 => [0x00, 0x00, ENT_MONITOR, 0x00], // Mono
        5 => [0x01, 0x00, ENT_MONITOR, 0x00], // Polarity / Mid-Side
        6 => [0x02, 0x00, ENT_MONITOR, 0x00], // Main Mute
        7 => [0x0E, 0x00, ENT_MONITOR, 0x00], // RoomTune (handled via FnActive)
        _ => [0x00, 0x00, 0xFF, 0x00],        // Off / Unbound
    }
}

/// Program the iD MK3 hardware Function button binding register (`ENT_MONITOR, cs=0x0D`).
pub fn write_fn_key_mode(dev: &TusbDevice<'_>, fn_mode: i32, custom_active: bool) {
    let bytes = fn_key_mode_to_hw_bytes(fn_mode, custom_active);
    let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x0D00, &bytes);
}

/// Read the complete live iD MK3 state directly over USB and build the ValueTree + binding map.
/// Always polls live hardware state (48V, Glow, Lift, Orbit, Gain, Main/HP1, Mixer, EQ, Comp, etc.);
/// applies pro studio defaults for monitor preferences on first launch (`!settings.initialized`).
pub fn build_direct_context(
    dev: &TusbDevice<'_>,
    settings: &DirectUsbSettings,
    custom_fn_active: bool,
) -> DirectContext {
    let model_name = dev.detect_model_name();
    let serial = dev
        .vendor_in(BREQ_PARAM, ENT_SYSTEM, 0x0100, 32)
        .ok()
        .map(|b| {
            let clean: Vec<u8> = b
                .into_iter()
                .take_while(|&c| c != 0 && c != 0xFF)
                .collect();
            String::from_utf8_lossy(&clean).trim().to_string()
        })
        .unwrap_or_default();

    let mut sr = dev
        .get_sample_rate()
        .or_else(|| {
            dev.vendor_in(BREQ_PARAM, ENT_SYSTEM, 0x0200, 4)
                .ok()
                .filter(|b| b.len() >= 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        })
        .unwrap_or(48000);
    let mut clk_src = hw_get_u8(dev, ENT_SYSTEM, 0x03, 0, 0) as i32;
    let buf_size = settings.buffer_size;

    // Restore user's saved Audio Engine settings (Sample Rate, Buffer Size, Clock Source) on connect
    if let Some(saved_sr) = settings.sample_rate {
        if saved_sr > 0 && saved_sr as u32 != sr {
            if dev.set_sample_rate(saved_sr as u32).is_ok() {
                sr = saved_sr as u32;
            }
        }
    }
    if let Some(saved_clk) = settings.clock_source {
        if saved_clk != clk_src {
            let _ = dev.set_clock_source(saved_clk as u32);
            let _ = dev.vendor_out(BREQ_PARAM, ENT_SYSTEM, 0x0300, &[saved_clk as u8]);
            clk_src = saved_clk;
        }
    }
    if buf_size > 0 {
        let _ = dev.set_asio_buffer_size(buf_size as u32);
    }

    let dsp_editable = sr <= 96000;

    // First-time Direct USB launch: seed pro monitor defaults onto hardware where appropriate
    // (never touches 48V, Glow, Lift, Orbit, Gain, Main/HP1 Vol, or Mixer — those always come live from hardware).
    if !settings.initialized {
        let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x0400, &db_to_q88(settings.dim_atten));
        let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x1300, &db_to_q88(settings.ref_vol));
        let _ = dev.vendor_out(BREQ_PARAM, ENT_DIGITAL, 0x0100, &[settings.opt_mode as u8]);
    }

    // Use exact fixed hardware mixer channel counts for the 4 Audient MK3 models
    // (never fall back to dynamic USB probing, which can shift Comp Out 11+12 <-> 13+14 on hot-plug).
    let model_upper = model_name.to_ascii_uppercase();
    let (analog_count, digital_count): (u8, u8) = if model_upper.contains("ID4+") {
        (4, 16)
    } else if model_upper.contains("ID1") {
        (1, 0)
    } else {
        // iD2 / iD2+ (and safe MK3 default): 2 analog + 8 digital -> Comp Out 1+2 is always 11+12
        (2, 8)
    };
    let total_inputs = analog_count + digital_count;

    let mut path_to_hw: HashMap<Vec<usize>, HwBinding> = HashMap::new();
    let mut hw_to_path: HashMap<HwRegKey, Vec<usize>> = HashMap::new();
    let mut mixer_ch_paths: HashMap<(u8, u8), MixerChPaths> = HashMap::new();
    let mut input_dsp_paths: HashMap<u8, InputDspPaths> = HashMap::new();

    // Base path of State: [0 (Devices), 0 (Device), 1 (State)]
    let dev_p = vec![0usize, 0usize];
    let state_p = vec![0usize, 0usize, 1usize];

    // --- VMs (index 0 under Device) ---
    let vms_node = node(
        "VMs",
        vec![],
        vec![
            lookup_vm(1, &[(44100, "44.1kHz"), (48000, "48kHz"), (88200, "88.2kHz"), (96000, "96kHz"), (176400, "176.4kHz"), (192000, "192kHz")]),
            lookup_vm(2, &[(0, "Internal"), (1, "Optical")]),
            lookup_vm(3, &[(16, "16 Samples"), (32, "32 Samples"), (64, "64 Samples"), (128, "128 Samples"), (256, "256 Samples"), (512, "512 Samples"), (1024, "1024 Samples"), (2048, "2048 Samples")]),
            lookup_vm(4, &[(0, "Off"), (1, "Dim"), (2, "Alt Speaker"), (3, "Talkback"), (4, "Mono"), (5, "Polarity"), (6, "Main Mute"), (7, "RoomTune")]),
            lookup_vm(5, &[(0, "ADAT"), (1, "S/PDIF")]),
            lookup_vm(6, &[(0, "Ready"), (1, "Running"), (2, "Clipping"), (3, "No Signal"), (4, "Complete"), (5, "Ready")]),
            lookup_vm(7, &[(0, "Main"), (1, "Alt")]),
            lookup_vm(8, &[(0, "Main Mix"), (1, "Mix A"), (2, "Mix B"), (3, "Virtual Thru")]),
            lookup_vm(9, &[(0, "LEFT"), (1, "CENTRE"), (2, "RIGHT")]),
            lookup_vm(10, &[(-1, "None"), (0, "Mic 1"), (1, "Mic 2")]),
            lookup_vm(11, &[(0, "Main Out"), (1, "Inputs")]),
        ],
    );

    // --- 0: System ---
    let sys_p = [state_p.as_slice(), &[0]].concat();
    let global_mute = hw_get_u8(dev, ENT_SYSTEM, 0x0A, 0, 0) as i32;
    let fp_mtr_src = hw_get_u8(dev, ENT_SYSTEM, 0x0B, 0, 0) as i32;
    let fn_active = hw_get_u8(dev, ENT_MONITOR, 0x0E, 0, 0) as i32;
    let sys_node = node(
        "System",
        vec![],
        vec![
            param_int("SR", sr as i32, Some(1), true),                    // 0
            param_int("BufferSize", buf_size, Some(3), true),             // 1
            param_int("FnKeyModeSt", settings.fn_key_mode, Some(4), true), // 2
            param_int("FnActive", fn_active, None, true),                 // 3
            param_int("Mute", global_mute, None, true),                   // 4
            param_int("FpMtrSrc", fp_mtr_src, Some(11), true),            // 5
            node(
                "ClockSources",
                vec![],
                vec![param_int("CurClkSrc", clk_src, Some(2), true)],     // [6, 0]
            ),
        ],
    );
    path_to_hw.insert([sys_p.as_slice(), &[0]].concat(), HwBinding::SampleRate);
    hw_to_path.insert(HwRegKey { entity: ENT_SYSTEM, cs: 0x02, ch: 0 }, [sys_p.as_slice(), &[0]].concat());
    path_to_hw.insert([sys_p.as_slice(), &[1]].concat(), HwBinding::BufferSize);
    path_to_hw.insert([sys_p.as_slice(), &[2]].concat(), HwBinding::FnKeyMode);
    path_to_hw.insert([sys_p.as_slice(), &[3]].concat(), HwBinding::MonitorBool(0x0E));
    hw_to_path.insert(HwRegKey { entity: ENT_MONITOR, cs: 0x0E, ch: 0 }, [sys_p.as_slice(), &[3]].concat());
    path_to_hw.insert([sys_p.as_slice(), &[4]].concat(), HwBinding::SystemBool(0x0A));
    hw_to_path.insert(HwRegKey { entity: ENT_SYSTEM, cs: 0x0A, ch: 0 }, [sys_p.as_slice(), &[4]].concat());
    path_to_hw.insert([sys_p.as_slice(), &[5]].concat(), HwBinding::SystemBool(0x0B));
    hw_to_path.insert(HwRegKey { entity: ENT_SYSTEM, cs: 0x0B, ch: 0 }, [sys_p.as_slice(), &[5]].concat());
    path_to_hw.insert([sys_p.as_slice(), &[6, 0]].concat(), HwBinding::ClockSource);

    // --- 1: DigitalInputs ---
    let dig_p = [state_p.as_slice(), &[1]].concat();
    let opt_mode = hw_get_u8(dev, ENT_DIGITAL, 0x01, 0, settings.opt_mode as u8) as i32;
    let dig_node = node(
        "DigitalInputs",
        vec![],
        vec![node(
            "DigitalInput",
            vec![("index", JuceVar::Int(0))],
            vec![param_int("OptMode", opt_mode, Some(5), true)],
        )],
    );
    path_to_hw.insert([dig_p.as_slice(), &[0, 0]].concat(), HwBinding::DigitalBool(0x01));

    // --- 2: Inputs ---
    let inputs_p = [state_p.as_slice(), &[2]].concat();
    let mut input_children: Vec<ValueTreeNode> = Vec::new();
    // Child 0: Trim toggle
    input_children.push(param_int("Trim", settings.show_preamp_trim, None, true));

    // Child 1: SmartGain node
    let sg_status = hw_get_u8(dev, ENT_SMARTGAIN, 0x00, 0, 5) as i32;
    let sg_p = [inputs_p.as_slice(), &[1]].concat();
    input_children.push(node(
        "SmartGain",
        vec![],
        vec![
            param_int("Status", sg_status, Some(6), false),
            param_int("Trigger", 0, None, true),
        ],
    ));
    path_to_hw.insert([sg_p.as_slice(), &[1]].concat(), HwBinding::SmartGainTrigger);
    hw_to_path.insert(HwRegKey { entity: ENT_SMARTGAIN, cs: 0x00, ch: 0 }, [sg_p.as_slice(), &[0]].concat());

    // Input Channels 0..total_inputs
    for ch in 0..total_inputs {
        let is_analog = ch < analog_count;
        let child_idx = input_children.len();
        let ch_p = [inputs_p.as_slice(), &[child_idx]].concat();
        let mut ch_children: Vec<ValueTreeNode> = Vec::new();

        let mut hpf_en_p = None;
        let mut hpf_freq_p = None;
        let mut pol_p = None;

        if is_analog {
            let raw_gain = hw_get_q88(dev, ENT_INPUTS, 0x00, ch, 0.0);
            let gain = if (-0.5..=60.0).contains(&raw_gain) { raw_gain.clamp(0.0, 58.0) } else { 0.0 };
            let raw_trim = hw_get_q88(dev, ENT_INPUTS, 0x02, ch, 0.0);
            let trim = if (-0.5..=16.0).contains(&raw_trim) { raw_trim.clamp(0.0, 15.0) } else { 0.0 };
            let mute = if hw_get_u8(dev, ENT_INPUTS, 0x01, ch, 0) == 1 { 1 } else { 0 };
            let p48 = if hw_get_u8(dev, ENT_INPUTS, 0x05, ch, 0) == 1 { 1 } else { 0 };
            let glow = if hw_get_u8(dev, ENT_INPUTS, 0x03, ch, 0) == 1 { 1 } else { 0 };
            let raw_orbit = hw_get_u8(dev, ENT_INPUTS, 0x04, ch, 0);
            let orbit = if raw_orbit <= 2 { raw_orbit as i32 } else { 0 };
            let lift = if hw_get_u8(dev, ENT_INPUTS, 0x0A, ch, 0) == 1 { 1 } else { 0 };
            let hpf_en = if hw_get_u8(dev, ENT_INPUTS, 0x0B, ch, 0) == 1 { 1 } else { 0 };
            let armed = if hw_get_u8(dev, ENT_INPUTS, 0x08, ch, 0) == 1 { 1 } else { 0 };
            let stereo_link = if hw_get_u8(dev, ENT_INPUTS, 0x0C, ch, 0) == 1 { 1 } else { 0 };
            let (_, raw_hpf_freq, _, _) = hw_get_eq_band(dev, 0x06, ch, 3, 100.0, 0.71);
            let hpf_freq = if (20.0..=500.0).contains(&raw_hpf_freq) { raw_hpf_freq } else { 100.0 };

            let mut add_p = |n: ValueTreeNode, bind: HwBinding, reg: Option<(u8, u8)>| -> Vec<usize> {
                let idx = ch_children.len();
                ch_children.push(n);
                let p = [ch_p.as_slice(), &[idx]].concat();
                path_to_hw.insert(p.clone(), bind);
                if let Some((ent, cs)) = reg {
                    hw_to_path.insert(HwRegKey { entity: ent, cs, ch }, p.clone());
                }
                p
            };

            add_p(param_f64("G", gain, None, true), HwBinding::InputGain { ch }, Some((ENT_INPUTS, 0x00)));
            add_p(param_f64("Trim", trim, None, true), HwBinding::InputTrim { ch }, Some((ENT_INPUTS, 0x02)));
            add_p(param_int("Mute", mute, None, true), HwBinding::InputBool { ch, cs: 0x01 }, Some((ENT_INPUTS, 0x01)));
            add_p(param_int("48V", p48, None, true), HwBinding::InputBool { ch, cs: 0x05 }, Some((ENT_INPUTS, 0x05)));
            let saved_plrty = settings.input_polarity.get(&ch).copied().unwrap_or(0);
            pol_p = Some(add_p(param_int("plrty", saved_plrty, None, true), HwBinding::InputPolarity { ch }, None));
            hpf_en_p = Some(add_p(param_int("HpfEnable", hpf_en, None, true), HwBinding::InputHpfEnable { ch }, Some((ENT_INPUTS, 0x0B))));
            hpf_freq_p = Some(add_p(param_f64("HpfFreq", hpf_freq, None, true), HwBinding::InputHpfFreq { ch }, None));
            add_p(param_int("Imp", orbit, None, true), HwBinding::InputBool { ch, cs: 0x04 }, Some((ENT_INPUTS, 0x04)));
            add_p(param_int("AIR", lift, None, true), HwBinding::InputBool { ch, cs: 0x0A }, Some((ENT_INPUTS, 0x0A)));
            add_p(param_int("HMX", glow, None, true), HwBinding::InputBool { ch, cs: 0x03 }, Some((ENT_INPUTS, 0x03)));
            if ch % 2 == 0 {
                add_p(param_int("StereoLink", stereo_link, None, true), HwBinding::InputBool { ch, cs: 0x0C }, Some((ENT_INPUTS, 0x0C)));
            }
            let rec_fx = hw_get_u8(dev, ENT_INPUTS, 0x0D, ch, 0) as i32;
            add_p(param_int("RecSrc", rec_fx, None, dsp_editable), HwBinding::InputBool { ch, cs: 0x0D }, Some((ENT_INPUTS, 0x0D)));

            // SmartGain arm child (ent=0x01, cs=0x08, ch)
            let sg_ch_idx = ch_children.len();
            let sg_ch_p = [ch_p.as_slice(), &[sg_ch_idx, 0]].concat();
            ch_children.push(node("SmartGain", vec![], vec![param_int("Armed", armed, None, true)]));
            path_to_hw.insert(sg_ch_p.clone(), HwBinding::SmartGainArm { ch });
            hw_to_path.insert(HwRegKey { entity: ENT_INPUTS, cs: 0x08, ch }, sg_ch_p);
        } else {
            let trim = hw_get_q88(dev, ENT_INPUTS, 0x02, ch, 0.0);
            let idx = ch_children.len();
            ch_children.push(param_f64("Trim", trim, None, true));
            path_to_hw.insert([ch_p.as_slice(), &[idx]].concat(), HwBinding::InputTrim { ch });
            let rec_fx = hw_get_u8(dev, ENT_INPUTS, 0x0D, ch, 0) as i32;
            let r_idx = ch_children.len();
            ch_children.push(param_int("RecSrc", rec_fx, None, dsp_editable));
            path_to_hw.insert([ch_p.as_slice(), &[r_idx]].concat(), HwBinding::InputBool { ch, cs: 0x0D });
        }

        // DSP Order directly on Channel: hardware ent=0x07 cs=0x05 (1 = EQ->COMP [UI 0], 0 = COMP->EQ [UI 1])
        let hw_order = hw_get_u8(dev, ENT_DSP, 0x05, ch, 1);
        let ui_order = if hw_order == 0 { 1 } else { 0 };
        let order_idx = ch_children.len();
        ch_children.push(param_int("DspOrder", ui_order, None, dsp_editable));
        let order_p = [ch_p.as_slice(), &[order_idx]].concat();
        path_to_hw.insert(order_p.clone(), HwBinding::DspOrder { ch });
        hw_to_path.insert(HwRegKey { entity: ENT_DSP, cs: 0x05, ch }, order_p);

        // EQ node (APF + 4 parametric bands)
        let eq_idx = ch_children.len();
        let eq_p = [ch_p.as_slice(), &[eq_idx]].concat();
        let defaults = [(5, 25.0, 0.71), (8, 500.0, 2.0), (8, 2000.0, 2.0), (7, 12800.0, 0.71)];
        let mut hw_bands = Vec::with_capacity(4);
        let mut any_eq_active = false;
        for b in 0..4u8 {
            let (dt, df, dq) = defaults[b as usize];
            let (bt, bf, bg, bq) = hw_get_eq_band(dev, 0x0A + b, ch, dt, df, dq);
            if bg.abs() >= 0.05 || bt == 1 || bt == 3 {
                any_eq_active = true;
            }
            hw_bands.push((bt, bf, bg, bq));
        }
        let eq_byps = settings
            .eq_bypass
            .get(&ch)
            .copied()
            .unwrap_or(if any_eq_active { 0 } else { 1 });

        let mut eq_children: Vec<ValueTreeNode> = Vec::new();
        eq_children.push(param_int("eqByps", eq_byps, None, dsp_editable)); // 0
        let eq_byps_p = [eq_p.as_slice(), &[0]].concat();
        path_to_hw.insert(eq_byps_p.clone(), HwBinding::EqBypass { ch });

        let (raw_apf_t, apf_f, _, _) = hw_get_eq_band(dev, 0x07, ch, 11, 90.0, 0.5);
        // Hardware returns 0 / 0xFFFF / 11 when V-Phase (APF) is bypassed on boot; only 13/14 means active.
        let apf_t = if raw_apf_t == 13 || raw_apf_t == 14 { 13 } else { 11 };
        let apf_deg = if apf_t == 11 {
            90.0
        } else {
            ((apf_f.max(40.0) / 40.0).log2() * 36.0).clamp(0.0, 180.0)
        };
        let apf_idx = eq_children.len();
        eq_children.push(node(
            "Band",
            vec![("name", JuceVar::String("APF".into()))],
            vec![
                param_int("T", apf_t, None, dsp_editable),
                param_f64("Phase", apf_deg.round(), None, dsp_editable),
            ],
        ));
        let apf_type_p = [eq_p.as_slice(), &[apf_idx, 0]].concat();
        let apf_phase_p = [eq_p.as_slice(), &[apf_idx, 1]].concat();
        path_to_hw.insert(apf_type_p.clone(), HwBinding::InputApfType { ch });
        path_to_hw.insert(apf_phase_p.clone(), HwBinding::InputApfPhase { ch });

        let mut band_paths_vec = Vec::with_capacity(4);
        for (b, &(bt, bf, bg, bq)) in hw_bands.iter().enumerate() {
            let b = b as u8;
            let bi = eq_children.len();
            eq_children.push(node(
                "Band",
                vec![
                    ("index", JuceVar::Int(b as i32)),
                    ("name", JuceVar::String(format!("Band {}", b + 1))),
                ],
                vec![
                    param_int("T", bt, None, dsp_editable),
                    param_f64("F", bf, None, dsp_editable),
                    param_f64("G", bg, None, dsp_editable),
                    param_f64("Q", bq, None, dsp_editable),
                ],
            ));
            let pt = [eq_p.as_slice(), &[bi, 0]].concat();
            let pf = [eq_p.as_slice(), &[bi, 1]].concat();
            let pg = [eq_p.as_slice(), &[bi, 2]].concat();
            let pq = [eq_p.as_slice(), &[bi, 3]].concat();
            path_to_hw.insert(pt.clone(), HwBinding::EqBand { ch, band: b });
            path_to_hw.insert(pf.clone(), HwBinding::EqBand { ch, band: b });
            path_to_hw.insert(pg.clone(), HwBinding::EqBand { ch, band: b });
            path_to_hw.insert(pq.clone(), HwBinding::EqBand { ch, band: b });
            band_paths_vec.push((pt, pf, pg, pq));
        }
        ch_children.push(node("EQ", vec![], eq_children));

        // Compressor node
        // Verified hardware registers on ent=0x07:
        //   0x00=Attack(ms*6), 0x01=Release(ms*6), 0x02=Threshold(Q8.8), 0x03=Ratio(Q8.8),
        //   0x04=Blend/Wet (u16: 0=bypassed, 1..32767=active blend), 0x0E=Makeup(Q8.8 dB)
        let comp_idx = ch_children.len();
        let comp_p = [ch_p.as_slice(), &[comp_idx]].concat();
        let raw_atk = hw_get_u16(dev, ENT_DSP, 0x00, ch, 60);
        let atk = if (1..=1500).contains(&raw_atk) { (raw_atk as f64) / 6.0 } else { 10.0 };
        let raw_rel = hw_get_u16(dev, ENT_DSP, 0x01, ch, 600);
        let rel = if (60..=6000).contains(&raw_rel) { (raw_rel as f64) / 6.0 } else { 100.0 };
        let raw_thresh = hw_get_q88(dev, ENT_DSP, 0x02, ch, 0.0);
        let thresh = if (-60.5..=0.5).contains(&raw_thresh) { raw_thresh.clamp(-60.0, 0.0) } else { 0.0 };
        let raw_ratio = hw_get_q88(dev, ENT_DSP, 0x03, ch, 2.0);
        let ratio = if (1.0..=20.5).contains(&raw_ratio) { raw_ratio.clamp(2.0, 20.0) } else { 2.0 };
        let raw_blend = hw_get_u16(dev, ENT_DSP, 0x04, ch, 0);
        let byps = if raw_blend == 0 || raw_blend > 32767 { 1 } else { 0 };
        let blend = if byps == 1 {
            settings.comp_blend.get(&ch).copied().unwrap_or(1.0).clamp(0.0, 1.0)
        } else {
            (raw_blend as f64 / 32767.0).clamp(0.0, 1.0)
        };
        let raw_makeup = hw_get_q88(dev, ENT_DSP, 0x0E, ch, 0.0);
        let makeup = if (-0.5..=12.5).contains(&raw_makeup) { raw_makeup.clamp(0.0, 12.0) } else { 0.0 };
        let comp_byps_p = [comp_p.as_slice(), &[0]].concat();
        let comp_blend_p = [comp_p.as_slice(), &[6]].concat();
        let comp_children = vec![
            param_int("byps", byps, None, dsp_editable),          // 0
            param_f64("Threshold", thresh, None, dsp_editable),   // 1
            param_f64("Ratio", ratio, None, dsp_editable),        // 2
            param_f64("Attack", atk, None, dsp_editable),         // 3
            param_f64("Release", rel, None, dsp_editable),        // 4
            param_f64("Makeup", makeup, None, dsp_editable),      // 5
            param_f64("Blend", blend, None, dsp_editable),        // 6
        ];
        ch_children.push(node("Compressor", vec![], comp_children));
        path_to_hw.insert(comp_byps_p.clone(), HwBinding::CompBypassOrBlend { ch });
        path_to_hw.insert([comp_p.as_slice(), &[1]].concat(), HwBinding::CompParam { ch, cs: 0x02 });
        path_to_hw.insert([comp_p.as_slice(), &[2]].concat(), HwBinding::CompParam { ch, cs: 0x03 });
        path_to_hw.insert([comp_p.as_slice(), &[3]].concat(), HwBinding::CompParam { ch, cs: 0x00 });
        path_to_hw.insert([comp_p.as_slice(), &[4]].concat(), HwBinding::CompParam { ch, cs: 0x01 });
        path_to_hw.insert([comp_p.as_slice(), &[5]].concat(), HwBinding::CompParam { ch, cs: 0x0E });
        path_to_hw.insert(comp_blend_p.clone(), HwBinding::CompBypassOrBlend { ch });

        input_dsp_paths.insert(
            ch,
            InputDspPaths {
                hpf_en: hpf_en_p,
                hpf_freq: hpf_freq_p,
                polarity: pol_p,
                apf_type: Some(apf_type_p),
                apf_phase: Some(apf_phase_p),
                eq_byps: eq_byps_p,
                eq_bands: [
                    band_paths_vec[0].clone(),
                    band_paths_vec[1].clone(),
                    band_paths_vec[2].clone(),
                    band_paths_vec[3].clone(),
                ],
                comp_byps: comp_byps_p,
                comp_blend: comp_blend_p,
            },
        );

        input_children.push(node(
            "Channel",
            vec![
                ("index", JuceVar::Int(ch as i32)),
                (
                    "name",
                    JuceVar::String(if is_analog {
                        format!("Mic {}", ch + 1)
                    } else {
                        format!("Dig {}", ch - analog_count + 1)
                    }),
                ),
            ],
            ch_children,
        ));
    }
    let inputs_node = node("Inputs", vec![], input_children);

    // --- 3: MonitorControl ---
    let mc_p = [state_p.as_slice(), &[3]].concat();
    let main_vol = hw_get_q88(dev, ENT_MONITOR, 0x0A, 0, -35.0);
    let main_mute = hw_get_u8(dev, ENT_MONITOR, 0x02, 0, 0) as i32;
    let dim = hw_get_u8(dev, ENT_MONITOR, 0x03, 0, 0) as i32;
    let mono = hw_get_u8(dev, ENT_MONITOR, 0x00, 0, 0) as i32;
    let mid_side = hw_get_u8(dev, ENT_MONITOR, 0x01, 0, 0) as i32;
    let talkback = hw_get_u8(dev, ENT_MONITOR, 0x05, 0, 0) as i32;
    let raw_dim_atten = hw_get_q88(dev, ENT_MONITOR, 0x04, 0, settings.dim_atten);
    let dim_atten = if raw_dim_atten <= -127.5 && settings.dim_atten > -127.5 {
        let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x0400, &db_to_q88(settings.dim_atten));
        settings.dim_atten
    } else {
        raw_dim_atten
    };
    let raw_ref_vol = hw_get_q88(dev, ENT_MONITOR, 0x13, 0, settings.ref_vol);
    let ref_vol = if raw_ref_vol <= -127.5 && settings.ref_vol > -127.5 {
        let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x1300, &db_to_q88(settings.ref_vol));
        settings.ref_vol
    } else {
        raw_ref_vol
    };
    let raw_alt_trim = hw_get_q88(dev, ENT_MONITOR, 0x08, 0, 0.0);
    let alt_trim = if (-13.0..=13.0).contains(&raw_alt_trim) { raw_alt_trim.clamp(-12.0, 12.0) } else { 0.0 };
    let speaker_sel = if hw_get_u8(dev, ENT_MONITOR, 0x07, 0, 0) == 1 { 1 } else { 0 };

    let hp1_vol = hw_get_q88(dev, ENT_OUTPUTS, 0x01, 4, -28.0).clamp(-128.0, 0.0);
    let hp1_mute = if hw_get_u8(dev, ENT_OUTPUTS, 0x02, 4, 0) == 1 { 1 } else { 0 };
    let hp1_src_raw = hw_get_u8(dev, ENT_OUTPUTS, 0x00, 4, 0x2B);
    let hp1_src = hw_out_src_to_ui(hp1_src_raw, true);
    // Hardware-verified ENT_ROOM (0x08) registers:
    //   cs=0x01 ch=0 (u16): bit 1 = RoomTune bypass
    //   cs=0x04 ch=0/1 (i32 Q24.8): Speaker L/R Trim (dB)
    //   cs=0x06 ch=0/1 (u32): Speaker L/R Delay (hundredths of ms, 0..1000 = 0..10.00ms)
    //   cs=0x23 ch=0 (i32 Q24.8): Profile Trim (dB)
    let room_flags = hw_get_u16(dev, ENT_ROOM, 0x01, 0, 0);
    let room_byps = if room_flags != 0xFFFF && (room_flags & 0x02) != 0 { 1 } else { 0 };
    let safe_room_trim = |v: f64| if (-13.0..=13.0).contains(&v) { v.clamp(-12.0, 12.0) } else { 0.0 };
    let safe_room_dly = |v: u32| if v <= 1000 { v as f64 / 100.0 } else { 0.0 };
    let prof_trim = safe_room_trim(hw_get_q24_8(dev, ENT_ROOM, 0x23, 0, 0.0));
    let spk_l_trim = safe_room_trim(hw_get_q24_8(dev, ENT_ROOM, 0x04, 0, 0.0));
    let spk_r_trim = safe_room_trim(hw_get_q24_8(dev, ENT_ROOM, 0x04, 1, 0.0));
    let spk_l_dly = safe_room_dly(hw_get_u32(dev, ENT_ROOM, 0x06, 0, 0));
    let spk_r_dly = safe_room_dly(hw_get_u32(dev, ENT_ROOM, 0x06, 1, 0));

    let mut mc_children = vec![
        param_f64("Vol", main_vol, None, true),                     // 0
        param_f64("RefVol", ref_vol, None, true),                   // 1
        param_int("SetToRef", 0, None, true),                       // 2
        param_int("VolRecall", settings.vol_recall, None, true),    // 3
        param_f64("DimAtten", dim_atten, None, true),               // 4
        param_int("Mute", main_mute, None, true),                   // 5
        param_int("mono", mono, None, true),                        // 6
        param_int("midSide", mid_side, None, true),                 // 7
        param_int("Dim", dim, None, true),                          // 8
        param_int("Tlkbck", talkback, None, true),                  // 9
        param_int("intTlkBckSrc", settings.talkback_src, Some(10), true), // 10
        param_int("MonoChnl", settings.mono_mode, Some(9), true),   // 11
        param_int("Src", settings.main_src, Some(8), true),         // 12
    ];

    // Index 13: HP1 Channel
    mc_children.push(node(
        "Channel",
        vec![("name", JuceVar::String("HP1".into()))],
        vec![
            param_int("Src", hp1_src, Some(8), true),   // 0
            param_f64("Vol", hp1_vol, None, true),      // 1
            param_int("Mute", hp1_mute, None, true),    // 2
        ],
    ));

    // Index 14: RoomCorrection (with 6 hardware-verified RoomTune EQ bands per speaker L/R)
    const ROOM_EQ_SPEC: [(u8, &str, i32, f64, f64); 6] = [
        (0x1D, "LS", 5, 80.0, 0.71),
        (0x0B, "Band 1", 8, 250.0, 2.0),
        (0x0C, "Band 2", 8, 600.0, 2.0),
        (0x0D, "Band 3", 8, 1500.0, 2.0),
        (0x0E, "Band 4", 8, 4000.0, 2.0),
        (0x1E, "HS", 7, 8000.0, 0.71),
    ];
    let rc_p = [mc_p.as_slice(), &[14]].concat();
    let build_room_eq_node = |ch: u8, spk_child_idx: usize, path_to_hw: &mut HashMap<Vec<usize>, HwBinding>| -> ValueTreeNode {
        let eq_p = [rc_p.as_slice(), &[spk_child_idx, 5]].concat();
        let mut bands = Vec::with_capacity(6);
        for (bi, &(cs, label, def_t, def_f, def_q)) in ROOM_EQ_SPEC.iter().enumerate() {
            let (bt, bf, bg, bq) = hw_get_room_eq_band(dev, cs, ch, 11, def_f, def_q);
            let _ = def_t;
            let bp = [eq_p.as_slice(), &[bi]].concat();
            let t_p = [bp.as_slice(), &[0]].concat();
            let f_p = [bp.as_slice(), &[1]].concat();
            let g_p = [bp.as_slice(), &[2]].concat();
            let q_p = [bp.as_slice(), &[3]].concat();
            let bind = HwBinding::RoomEqBand {
                ch,
                cs,
                t_path: t_p.clone(),
                f_path: f_p.clone(),
                g_path: g_p.clone(),
                q_path: q_p.clone(),
            };
            path_to_hw.insert(t_p, bind.clone());
            path_to_hw.insert(f_p, bind.clone());
            path_to_hw.insert(g_p, bind.clone());
            path_to_hw.insert(q_p, bind);
            bands.push(node(
                "Band",
                vec![("index", JuceVar::Int(bi as i32)), ("name", JuceVar::String(label.into()))],
                vec![
                    param_int("T", bt, None, true),
                    param_f64("F", bf, None, true),
                    param_f64("G", bg, None, true),
                    param_f64("Q", bq, None, true),
                ],
            ));
        }
        node("EQ", vec![], bands)
    };
    let rc_l_eq = build_room_eq_node(0, 5, &mut path_to_hw);
    let rc_r_eq = build_room_eq_node(1, 6, &mut path_to_hw);

    mc_children.push(node(
        "RoomCorrection",
        vec![],
        vec![
            param_int("byps", room_byps, None, true),
            param_int("MainByps", room_byps, None, true),
            param_int("AltByps", room_byps, None, true),
            param_int("CurProfile", speaker_sel, Some(7), false),
            param_f64("ProfTrim", prof_trim, None, true),
            node(
                "Channel",
                vec![("name", JuceVar::String("L".into()))],
                vec![
                    param_f64("SpkTrim", spk_l_trim, None, true),
                    param_f64("Dly", spk_l_dly, None, true),
                    param_int("DlyOn", if spk_l_dly > 0.0 { 1 } else { 0 }, None, true),
                    param_int("Mute", 0, None, true),
                    param_int("Solo", 0, None, true),
                    rc_l_eq,
                ],
            ),
            node(
                "Channel",
                vec![("name", JuceVar::String("R".into()))],
                vec![
                    param_f64("SpkTrim", spk_r_trim, None, true),
                    param_f64("Dly", spk_r_dly, None, true),
                    param_int("DlyOn", if spk_r_dly > 0.0 { 1 } else { 0 }, None, true),
                    param_int("Mute", 0, None, true),
                    param_int("Solo", 0, None, true),
                    rc_r_eq,
                ],
            ),
        ],
    ));

    let mc_node = node("MonitorControl", vec![], mc_children);

    let mut reg_mc = |idx: usize, bind: HwBinding, reg: Option<(u8, u8, u8)>| {
        let p = [mc_p.as_slice(), &[idx]].concat();
        path_to_hw.insert(p.clone(), bind);
        if let Some((ent, cs, ch)) = reg {
            hw_to_path.insert(HwRegKey { entity: ent, cs, ch }, p);
        }
    };
    reg_mc(0, HwBinding::MonitorVol, Some((ENT_MONITOR, 0x0A, 0)));
    reg_mc(1, HwBinding::MonitorQ88(0x13), Some((ENT_MONITOR, 0x13, 0)));
    reg_mc(4, HwBinding::MonitorQ88(0x04), Some((ENT_MONITOR, 0x04, 0)));
    reg_mc(5, HwBinding::MonitorBool(0x02), Some((ENT_MONITOR, 0x02, 0)));
    reg_mc(6, HwBinding::MonitorBool(0x00), Some((ENT_MONITOR, 0x00, 0)));
    reg_mc(7, HwBinding::MonitorBool(0x01), Some((ENT_MONITOR, 0x01, 0)));
    reg_mc(8, HwBinding::MonitorBool(0x03), Some((ENT_MONITOR, 0x03, 0)));
    reg_mc(9, HwBinding::MonitorBool(0x05), Some((ENT_MONITOR, 0x05, 0)));

    let hp1_p = [mc_p.as_slice(), &[13]].concat();
    path_to_hw.insert([hp1_p.as_slice(), &[0]].concat(), HwBinding::Hp1Src);
    path_to_hw.insert([hp1_p.as_slice(), &[1]].concat(), HwBinding::Hp1Vol);
    path_to_hw.insert([hp1_p.as_slice(), &[2]].concat(), HwBinding::Hp1Mute);
    hw_to_path.insert(HwRegKey { entity: ENT_OUTPUTS, cs: 0x00, ch: 4 }, [hp1_p.as_slice(), &[0]].concat());
    hw_to_path.insert(HwRegKey { entity: ENT_OUTPUTS, cs: 0x01, ch: 4 }, [hp1_p.as_slice(), &[1]].concat());
    hw_to_path.insert(HwRegKey { entity: ENT_OUTPUTS, cs: 0x02, ch: 4 }, [hp1_p.as_slice(), &[2]].concat());
    path_to_hw.insert([rc_p.as_slice(), &[0]].concat(), HwBinding::RoomBypass);
    path_to_hw.insert([rc_p.as_slice(), &[1]].concat(), HwBinding::RoomBypass);
    path_to_hw.insert([rc_p.as_slice(), &[2]].concat(), HwBinding::RoomBypass);
    path_to_hw.insert([rc_p.as_slice(), &[4]].concat(), HwBinding::RoomProfTrim);
    let rc_l_dly_p = [rc_p.as_slice(), &[5, 1]].concat();
    let rc_r_dly_p = [rc_p.as_slice(), &[6, 1]].concat();
    path_to_hw.insert([rc_p.as_slice(), &[5, 0]].concat(), HwBinding::RoomSpkTrim { ch: 0 });
    path_to_hw.insert(rc_l_dly_p.clone(), HwBinding::RoomSpkDelay { ch: 0 });
    path_to_hw.insert([rc_p.as_slice(), &[5, 2]].concat(), HwBinding::RoomSpkDelayOn { ch: 0, dly_path: rc_l_dly_p });
    path_to_hw.insert([rc_p.as_slice(), &[6, 0]].concat(), HwBinding::RoomSpkTrim { ch: 1 });
    path_to_hw.insert(rc_r_dly_p.clone(), HwBinding::RoomSpkDelay { ch: 1 });
    path_to_hw.insert([rc_p.as_slice(), &[6, 2]].concat(), HwBinding::RoomSpkDelayOn { ch: 1, dly_path: rc_r_dly_p });

    // --- 4: Routers ---
    let routers_p = [state_p.as_slice(), &[4]].concat();
    let out_r_p = [routers_p.as_slice(), &[0]].concat();
    let out0_src = hw_out_src_to_ui(hw_get_u8(dev, ENT_OUTPUTS, 0x00, 0, 0x27), false);
    let out1_src = hw_out_src_to_ui(hw_get_u8(dev, ENT_OUTPUTS, 0x00, 1, 0x28), false);
    let out2_src = hw_out_src_to_ui(hw_get_u8(dev, ENT_OUTPUTS, 0x00, 2, 0x27), false);
    let out3_src = hw_out_src_to_ui(hw_get_u8(dev, ENT_OUTPUTS, 0x00, 3, 0x28), false);
    let lb_src = hw_out_src_to_ui(hw_get_u8(dev, ENT_OUTPUTS, 0x00, 6, 0x27), true);

    let out_link0 = settings.out_router_links.get(&0).copied().unwrap_or(1);
    let out_link1 = settings.out_router_links.get(&1).copied().unwrap_or(1);

    let out_router = node(
        "Router",
        vec![("name", JuceVar::String("Output Router".into()))],
        vec![
            param_int("Src", speaker_sel, Some(7), true), // 0: Speaker MAIN/ALT
            node(
                "Pair",
                vec![("index", JuceVar::Int(0))],
                vec![
                    param_int("StereoLink", out_link0, None, true),
                    node("Channel", vec![("index", JuceVar::Int(0))], vec![param_int("Src", out0_src, None, true)]),
                    node("Channel", vec![("index", JuceVar::Int(1))], vec![param_int("Src", out1_src, None, true)]),
                ],
            ),
            node(
                "Pair",
                vec![("index", JuceVar::Int(1))],
                vec![
                    param_int("StereoLink", out_link1, None, true),
                    param_f64("Trim", alt_trim, None, true),
                    node("Channel", vec![("index", JuceVar::Int(0))], vec![param_int("Src", out2_src, None, true)]),
                    node("Channel", vec![("index", JuceVar::Int(1))], vec![param_int("Src", out3_src, None, true)]),
                ],
            ),
        ],
    );
    path_to_hw.insert([out_r_p.as_slice(), &[0]].concat(), HwBinding::MonitorBool(0x07));
    hw_to_path.insert(HwRegKey { entity: ENT_MONITOR, cs: 0x07, ch: 0 }, [out_r_p.as_slice(), &[0]].concat());
    path_to_hw.insert([out_r_p.as_slice(), &[1, 1, 0]].concat(), HwBinding::OutputSrc { ch: 0 });
    path_to_hw.insert([out_r_p.as_slice(), &[1, 2, 0]].concat(), HwBinding::OutputSrc { ch: 1 });
    path_to_hw.insert([out_r_p.as_slice(), &[2, 1]].concat(), HwBinding::MonitorQ88(0x08));
    path_to_hw.insert([out_r_p.as_slice(), &[2, 2, 0]].concat(), HwBinding::OutputSrc { ch: 2 });
    path_to_hw.insert([out_r_p.as_slice(), &[2, 3, 0]].concat(), HwBinding::OutputSrc { ch: 3 });

    let lb_r_p = [routers_p.as_slice(), &[1]].concat();
    let lb_router = node(
        "Router",
        vec![("name", JuceVar::String("Loopback Router".into()))],
        vec![node(
            "Channel",
            vec![("index", JuceVar::Int(0))],
            vec![
                param_int("Src", lb_src, None, true),
                param_int("VirtOut", settings.lb_virt_out, None, true),
            ],
        )],
    );
    path_to_hw.insert([lb_r_p.as_slice(), &[0, 0]].concat(), HwBinding::LoopbackSrc);

    let routers_node = node("Routers", vec![], vec![out_router, lb_router]);

    // --- 5: Mixer (4 buses × 9 pairs = 18 sources) ---
    let mixer_p = [state_p.as_slice(), &[5]].concat();
    let total_sources = (total_inputs as usize) + 8; // inputs + 6 host + 2 reverb
    let num_pairs = (total_sources + 1) / 2;

    let mut mix_children: Vec<ValueTreeNode> = Vec::new();
    let bus_names = ["Main Mix", "Mix A", "Mix B", "Reverb"];
    for bus in 0..4u8 {
        let bus_p = [mixer_p.as_slice(), &[bus as usize]].concat();
        let bus_vol = hw_get_q88(dev, ENT_BUS_MASTER, 0x00, bus * 2, 0.0);
        let mut bus_children: Vec<ValueTreeNode> = vec![param_f64("Vol", bus_vol, None, true)];
        path_to_hw.insert([bus_p.as_slice(), &[0]].concat(), HwBinding::BusMasterVol { bus });

        let cs_l = bus * 2 + 1;
        let cs_r = bus * 2 + 2;

        for pair in 0..num_pairs {
            let pair_ci = bus_children.len();
            let pair_p = [bus_p.as_slice(), &[pair_ci]].concat();
            let src0 = (pair * 2) as u8;
            let src1 = (pair * 2 + 1) as u8;

            let (hw_v0, hw_p0) = crosspoints_to_vol_pan(
                hw_get_q88(dev, ENT_MIXER, cs_l, src0, -128.0),
                hw_get_q88(dev, ENT_MIXER, cs_r, src0, -128.0),
            );
            let (hw_v1, hw_p1) = crosspoints_to_vol_pan(
                hw_get_q88(dev, ENT_MIXER, cs_l, src1, -128.0),
                hw_get_q88(dev, ENT_MIXER, cs_r, src1, -128.0),
            );
            let is_reverb_pair = pair == num_pairs - 1;
            let is_host_pair = !is_reverb_pair && (src0 >= total_inputs);
            let stereo_default = if is_host_pair || is_reverb_pair { 1 } else { 0 };
            let pair_key = format!("{bus}:{pair}");
            let stereo_link = settings
                .mixer_links
                .get(&pair_key)
                .copied()
                .unwrap_or(stereo_default);

            let ch0_name = if is_reverb_pair { "Reverb L".into() } else { format!("Ch {}", src0 + 1) };
            let ch1_name = if is_reverb_pair { "Reverb R".into() } else { format!("Ch {}", src1 + 1) };

            let restore_ch = |src: u8, hw_v: f64, hw_p: i32| -> (f64, i32, i32) {
                let key = format!("{bus}:{src}");
                let saved_m = settings.mixer_mutes.get(&key).copied();
                if hw_v > -127.5 {
                    (hw_v, hw_p, 0)
                } else if saved_m == Some(1) {
                    let v = settings
                        .mixer_vols
                        .get(&key)
                        .copied()
                        .unwrap_or(if bus == 3 { -12.0 } else { 0.0 });
                    let p = settings.mixer_pans.get(&key).copied().unwrap_or(hw_p);
                    (v, p, 1)
                } else {
                    let m = saved_m.unwrap_or(if bus == 3 { 1 } else { 0 });
                    let p = settings.mixer_pans.get(&key).copied().unwrap_or(hw_p);
                    (-128.0, p, m)
                }
            };
            let (v0, p0, m0) = restore_ch(src0, hw_v0, hw_p0);
            let (v1, p1, m1) = restore_ch(src1, hw_v1, hw_p1);

            let pair_node = node(
                "Pair",
                vec![("index", JuceVar::Int(pair as i32))],
                vec![
                    param_int("StereoLink", stereo_link, None, true),
                    node(
                        "Channel",
                        vec![("index", JuceVar::Int(0)), ("name", JuceVar::String(ch0_name))],
                        vec![
                            param_f64("Vol", v0, None, true),
                            param_int("Pan", p0, None, true),
                            param_int("Mute", m0, None, true),
                            param_int("Solo", 0, None, true),
                        ],
                    ),
                    node(
                        "Channel",
                        vec![("index", JuceVar::Int(1)), ("name", JuceVar::String(ch1_name))],
                        vec![
                            param_f64("Vol", v1, None, true),
                            param_int("Pan", p1, None, true),
                            param_int("Mute", m1, None, true),
                            param_int("Solo", 0, None, true),
                        ],
                    ),
                ],
            );
            bus_children.push(pair_node);

            for (side, src) in [(0u8, src0), (1u8, src1)] {
                let ci = (side + 1) as usize;
                let vp = [pair_p.as_slice(), &[ci, 0]].concat();
                let pp = [pair_p.as_slice(), &[ci, 1]].concat();
                let mp = [pair_p.as_slice(), &[ci, 2]].concat();
                let sp = [pair_p.as_slice(), &[ci, 3]].concat();
                let b = HwBinding::MixerChannel { bus, src };
                path_to_hw.insert(vp.clone(), b.clone());
                path_to_hw.insert(pp.clone(), b.clone());
                path_to_hw.insert(mp.clone(), b.clone());
                path_to_hw.insert(sp, b);
                mixer_ch_paths.insert((bus, src), MixerChPaths { vol: vp, pan: pp, mute: mp });
            }
        }
        // Attach Reverb Engine parameters directly on Bus 3 ("Reverb") so mixer.js inspector finds them
        if bus == 3 {
            let raw_decay = hw_get_u16(dev, ENT_REVERB, 0x02, 0, 19660);
            let rev_decay = if raw_decay <= 32768 { (raw_decay as f64) / 32768.0 } else { 0.6 };
            let raw_damp = hw_get_u16(dev, ENT_REVERB, 0x03, 0, 8000);
            let rev_damp_hz = if (20..=20000).contains(&raw_damp) { raw_damp as f64 } else { 8000.0 };
            let raw_rev_blend = hw_get_u16(dev, ENT_REVERB, 0x04, 0, 26213);
            let rev_blend = if raw_rev_blend <= 32768 { (raw_rev_blend as f64) / 32768.0 } else { 0.8 };
            let d_idx = bus_children.len();
            bus_children.push(param_f64("Decay", rev_decay, None, dsp_editable));
            bus_children.push(param_f64("Damping", rev_damp_hz, None, dsp_editable));
            bus_children.push(param_f64("Blend", rev_blend, None, dsp_editable));
            path_to_hw.insert([bus_p.as_slice(), &[d_idx]].concat(), HwBinding::ReverbParam { cs: 0x02, scale: 32768.0 });
            path_to_hw.insert([bus_p.as_slice(), &[d_idx + 1]].concat(), HwBinding::ReverbParam { cs: 0x03, scale: 1.0 });
            path_to_hw.insert([bus_p.as_slice(), &[d_idx + 2]].concat(), HwBinding::ReverbParam { cs: 0x04, scale: 32768.0 });
        }

        mix_children.push(node("Mix", vec![("name", JuceVar::String(bus_names[bus as usize].into()))], bus_children));
    }

    // Sources names child (index 4 under Mixer)
    let mut src_nodes = Vec::new();
    for i in 0..total_sources {
        let name = if i < analog_count as usize {
            format!("Mic {}", i + 1)
        } else if i < total_inputs as usize {
            format!("Dig {}", i - analog_count as usize + 1)
        } else if i < total_sources - 2 {
            format!("Comp Out {}", i - total_inputs as usize + 1)
        } else if i == total_sources - 2 {
            "Reverb L".into()
        } else {
            "Reverb R".into()
        };
        src_nodes.push(node("Channel", vec![("index", JuceVar::Int(i as i32))], vec![param_str("name", &name)]));
    }
    mix_children.push(node("Sources", vec![], src_nodes));

    let mixer_node = node("Mixer", vec![], mix_children);

    // --- 6: Physical Outputs (L1, R2, L3, R4) ---
    let outputs_p = [state_p.as_slice(), &[6]].concat();
    let out_names = ["OUT 1 (L)", "OUT 2 (R)", "OUT 3 (L)", "OUT 4 (R)"];
    let mut out_children = Vec::new();
    for ch in 0..4u8 {
        let vol = hw_get_q88(dev, ENT_OUTPUTS, 0x01, ch, 0.0);
        let mute = hw_get_u8(dev, ENT_OUTPUTS, 0x02, ch, 0) as i32;
        out_children.push(node(
            "Channel",
            vec![("name", JuceVar::String(out_names[ch as usize].into()))],
            vec![param_f64("Vol", vol, None, true), param_int("Mute", mute, None, true)],
        ));
        path_to_hw.insert([outputs_p.as_slice(), &[ch as usize, 0]].concat(), HwBinding::OutputVol { ch });
        path_to_hw.insert([outputs_p.as_slice(), &[ch as usize, 1]].concat(), HwBinding::OutputMute { ch });
    }
    let outputs_node = node("Outputs", vec![], out_children);

    let state_node = node(
        "State",
        vec![],
        vec![
            sys_node,     // 0
            dig_node,     // 1
            inputs_node,  // 2
            mc_node,      // 3
            routers_node, // 4
            mixer_node,   // 5
            outputs_node, // 6
        ],
    );

    let device_node = node(
        "Device",
        vec![
            ("name", JuceVar::String(model_name.clone())),
            ("serial", JuceVar::String(serial.clone())),
            ("backend", JuceVar::String("direct_usb".into())),
        ],
        vec![vms_node, state_node],
    );

    let _ = dev_p;
    let tree = node("Node", vec![], vec![node("Devices", vec![], vec![device_node])]);

    // Finish host-online handshake so hardware event notifications are active,
    // then arm the physical Function button in hardware so it works immediately
    // even after a fresh power cycle without Audient Device Manager.
    let _ = dev.vendor_out(BREQ_PARAM, ENT_SYSTEM, 0x0C00, &[1]);
    write_fn_key_mode(dev, settings.fn_key_mode, custom_fn_active);

    let mut ctx = DirectContext {
        tree,
        device_name: model_name,
        serial,
        sample_rate: sr,
        analog_count,
        path_to_hw,
        hw_to_path,
        last_watched: HashMap::new(),
        panel_cursor: 0,
        mixer_ch_paths,
        input_dsp_paths,
    };
    // Seed watched front-panel registers with initial hardware values
    let _ = poll_watched_front_panel(dev, &mut ctx, true);
    ctx
}

// ============================================================================
// Outbound Writes (ValueTree param -> Direct USB Vendor Transfer)
// ============================================================================

fn tree_f64(tree: &ValueTreeNode, path: &[usize], default: f64) -> f64 {
    tree.get_path(path)
        .and_then(|n| n.props.get("value"))
        .and_then(|v| v.as_f64())
        .unwrap_or(default)
}

fn tree_i32(tree: &ValueTreeNode, path: &[usize], default: i32) -> i32 {
    tree.get_path(path)
        .and_then(|n| n.props.get("value"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(default)
}

fn push_eq_band_to_hw(
    dev: &TusbDevice<'_>,
    ch: u8,
    cs: u8,
    band_idx: u32,
    ft: u16,
    freq: f64,
    gain: f64,
    q: f64,
    pol_inv: bool,
    bypassed: bool,
    rates: &[u32],
) {
    let mut hdr = [0u8; 8];
    hdr[0..2].copy_from_slice(&ft.to_le_bytes());
    hdr[2..4].copy_from_slice(&(freq.round().clamp(15.0, 24000.0) as u16).to_le_bytes());
    hdr[4..6].copy_from_slice(&db_to_q88(gain));
    hdr[6..8].copy_from_slice(&((q.clamp(0.1, 24.0) * 256.0).round() as u16).to_le_bytes());
    let _ = dev.vendor_out(BREQ_PARAM, ENT_DSP, ((cs as u16) << 8) | (ch as u16), &hdr);

    for &sr in rates {
        let pkt = encode_svf_packet(band_idx, sr, ft, freq, gain, q, pol_inv, bypassed);
        let _ = dev.vendor_out(BREQ_FILTER_COEFF, ENT_DSP, 0x1D00 | (ch as u16), &pkt);
    }
}

/// Write a coalesced batch of parameter changes to hardware, deduplicating compound targets
/// (MixerChannel Vol/Pan/Mute, EqBand T/F/G/Q, EqBypass, HPF, APF, CompBypass/Blend) so scene
/// recalls fire each hardware USB transfer at most once.
pub fn write_param_batch_to_hardware(
    dev: &TusbDevice<'_>,
    ctx: &mut DirectContext,
    tree: &ValueTreeNode,
    batch: &BTreeMap<Vec<usize>, JuceVar>,
) {
    let mut done_mixer: HashSet<(u8, u8)> = HashSet::new();
    let mut done_hpf: HashSet<u8> = HashSet::new();
    let mut done_apf: HashSet<u8> = HashSet::new();
    let mut done_eq_byps: HashSet<u8> = HashSet::new();
    let mut done_eq_band: HashSet<(u8, u8)> = HashSet::new();
    let mut done_comp_blend: HashSet<u8> = HashSet::new();

    // Pre-scan EqBypass channels so we don't also redundantly push individual bands for that channel
    for path in batch.keys() {
        if let Some(HwBinding::EqBypass { ch }) = ctx.path_to_hw.get(path) {
            done_eq_byps.insert(*ch);
        }
    }
    let mut flushed_eq_byps: HashSet<u8> = HashSet::new();

    for (path, val) in batch {
        let Some(binding) = ctx.path_to_hw.get(path).cloned() else {
            continue;
        };
        match binding {
            HwBinding::MixerChannel { bus, src } => {
                if !done_mixer.insert((bus, src)) {
                    continue;
                }
            }
            HwBinding::InputHpfEnable { ch } | HwBinding::InputHpfFreq { ch } => {
                if !done_hpf.insert(ch) {
                    continue;
                }
            }
            HwBinding::InputPolarity { ch }
            | HwBinding::InputApfType { ch }
            | HwBinding::InputApfPhase { ch } => {
                if !done_apf.insert(ch) {
                    continue;
                }
            }
            HwBinding::EqBypass { ch } => {
                if !flushed_eq_byps.insert(ch) {
                    continue;
                }
            }
            HwBinding::EqBand { ch, band } => {
                if done_eq_byps.contains(&ch) || !done_eq_band.insert((ch, band)) {
                    continue;
                }
            }
            HwBinding::CompBypassOrBlend { ch } => {
                if !done_comp_blend.insert(ch) {
                    continue;
                }
            }
            _ => {}
        }
        write_param_to_hardware(dev, ctx, tree, path, val);
    }
}

pub fn write_param_to_hardware(
    dev: &TusbDevice<'_>,
    ctx: &mut DirectContext,
    tree: &ValueTreeNode,
    path: &[usize],
    value: &JuceVar,
) {
    let Some(binding) = ctx.path_to_hw.get(path).cloned() else {
        return;
    };

    match binding {
        HwBinding::SampleRate => {
            if let Some(sr) = value.as_i64() {
                let _ = dev.set_sample_rate(sr as u32);
                ctx.sample_rate = sr as u32;
            }
        }
        HwBinding::ClockSource => {
            if let Some(v) = value.as_i64() {
                let _ = dev.set_clock_source(v as u32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_SYSTEM, 0x0300, &[v as u8]);
            }
        }
        HwBinding::BufferSize => {
            if let Some(v) = value.as_i64() {
                let _ = dev.set_asio_buffer_size(v as u32);
            }
        }
        HwBinding::SystemBool(cs) => {
            if let Some(v) = value.as_i64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_SYSTEM, (cs as u16) << 8, &[if v != 0 { 1 } else { 0 }]);
            }
        }
        HwBinding::DigitalBool(cs) => {
            if let Some(v) = value.as_i64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_DIGITAL, (cs as u16) << 8, &[if v != 0 { 1 } else { 0 }]);
            }
        }
        HwBinding::MonitorVol => {
            if let Some(db) = value.as_f64() {
                let q = db_to_q88(db);
                ctx.last_watched.insert(HwRegKey { entity: ENT_MONITOR, cs: 0x0A, ch: 0 }, i16::from_le_bytes(q) as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, 0x0A00, &q);
            }
        }
        HwBinding::MonitorBool(cs) => {
            if let Some(v) = value.as_i64() {
                let b = if v != 0 { 1 } else { 0 };
                ctx.last_watched.insert(HwRegKey { entity: ENT_MONITOR, cs, ch: 0 }, b as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, (cs as u16) << 8, &[b]);
            }
        }
        HwBinding::MonitorQ88(cs) => {
            if let Some(db) = value.as_f64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_MONITOR, (cs as u16) << 8, &db_to_q88(db));
            }
        }
        HwBinding::Hp1Vol => {
            if let Some(db) = value.as_f64() {
                let q = db_to_q88(db);
                ctx.last_watched.insert(HwRegKey { entity: ENT_OUTPUTS, cs: 0x01, ch: 4 }, i16::from_le_bytes(q) as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0104, &q);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0105, &q);
            }
        }
        HwBinding::Hp1Mute => {
            if let Some(v) = value.as_i64() {
                let b = if v != 0 { 1 } else { 0 };
                ctx.last_watched.insert(HwRegKey { entity: ENT_OUTPUTS, cs: 0x02, ch: 4 }, b as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0204, &[b]);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0205, &[b]);
            }
        }
        HwBinding::Hp1Src => {
            if let Some(v) = value.as_i64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0004, &[ui_out_src_to_hw(v as i32, 0, true)]);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0005, &[ui_out_src_to_hw(v as i32, 1, true)]);
            }
        }
        HwBinding::OutputSrc { ch } => {
            if let Some(v) = value.as_i64() {
                let code = ui_out_src_to_hw(v as i32, ch & 1, false);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, ch as u16, &[code]);
            }
        }
        HwBinding::OutputVol { ch } => {
            if let Some(db) = value.as_f64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0100 | (ch as u16), &db_to_q88(db));
            }
        }
        HwBinding::OutputMute { ch } => {
            if let Some(v) = value.as_i64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0200 | (ch as u16), &[if v != 0 { 1 } else { 0 }]);
            }
        }
        HwBinding::LoopbackSrc => {
            if let Some(v) = value.as_i64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0006, &[ui_lb_src_to_hw(v as i32, 0)]);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_OUTPUTS, 0x0007, &[ui_lb_src_to_hw(v as i32, 1)]);
            }
        }
        HwBinding::InputGain { ch } => {
            if let Some(db) = value.as_f64() {
                let q = db_to_q88(db);
                ctx.last_watched.insert(HwRegKey { entity: ENT_INPUTS, cs: 0x00, ch }, i16::from_le_bytes(q) as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_INPUTS, ch as u16, &q);
            }
        }
        HwBinding::InputTrim { ch } => {
            if let Some(db) = value.as_f64() {
                let _ = dev.vendor_out(BREQ_PARAM, ENT_INPUTS, 0x0200 | (ch as u16), &db_to_q88(db));
            }
        }
        HwBinding::InputBool { ch, cs } => {
            if let Some(v) = value.as_i64() {
                let b = v as u8;
                ctx.last_watched.insert(HwRegKey { entity: ENT_INPUTS, cs, ch }, b as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_INPUTS, ((cs as u16) << 8) | (ch as u16), &[b]);
            }
        }
        HwBinding::InputHpfEnable { ch } | HwBinding::InputHpfFreq { ch } => {
            if let Some(dsp) = ctx.input_dsp_paths.get(&ch) {
                let en = dsp.hpf_en.as_ref().map(|p| tree_i32(tree, p, 0) != 0).unwrap_or(false);
                let freq = dsp.hpf_freq.as_ref().map(|p| tree_f64(tree, p, 100.0)).unwrap_or(100.0);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_INPUTS, 0x0B00 | (ch as u16), &[if en { 1 } else { 0 }]);
                push_eq_band_to_hw(dev, ch, 0x06, 0, 3, freq, 0.0, 0.707, false, !en, &SAMPLE_RATES_ALL);
            }
        }
        HwBinding::InputPolarity { ch } | HwBinding::InputApfType { ch } | HwBinding::InputApfPhase { ch } => {
            if let Some(dsp) = ctx.input_dsp_paths.get(&ch) {
                let pol = dsp.polarity.as_ref().map(|p| tree_i32(tree, p, 0) != 0).unwrap_or(false);
                let apf_t = dsp.apf_type.as_ref().map(|p| tree_i32(tree, p, 11) as u16).unwrap_or(11);
                let phase = dsp.apf_phase.as_ref().map(|p| tree_f64(tree, p, 90.0)).unwrap_or(90.0);
                // Map 0..180 deg V-Phase into ~50..2000 Hz all-pass corner frequency
                let apf_freq = 40.0 * (2.0_f64).powf(phase / 36.0);
                let bypassed = apf_t == 11;
                push_eq_band_to_hw(dev, ch, 0x07, 1, apf_t, apf_freq, 0.0, 0.47, pol, bypassed, &SAMPLE_RATES_ALL);
            }
        }
        HwBinding::EqBypass { ch } => {
            if let Some(dsp) = ctx.input_dsp_paths.get(&ch).cloned() {
                let byps = tree_i32(tree, &dsp.eq_byps, 0) != 0;
                for b in 0..4u8 {
                    let (pt, pf, pg, pq) = &dsp.eq_bands[b as usize];
                    let ft = tree_i32(tree, pt, 8) as u16;
                    let freq = tree_f64(tree, pf, 1000.0);
                    let gain = tree_f64(tree, pg, 0.0);
                    let q = tree_f64(tree, pq, 1.0);
                    push_eq_band_to_hw(dev, ch, 0x0A + b, 4 + b as u32, ft, freq, gain, q, false, byps, &SAMPLE_RATES_DSP);
                }
            }
        }
        HwBinding::EqBand { ch, band } => {
            if let Some(dsp) = ctx.input_dsp_paths.get(&ch).cloned() {
                let byps = tree_i32(tree, &dsp.eq_byps, 0) != 0;
                let (pt, pf, pg, pq) = &dsp.eq_bands[band as usize];
                let ft = tree_i32(tree, pt, 8) as u16;
                let freq = tree_f64(tree, pf, 1000.0);
                let gain = tree_f64(tree, pg, 0.0);
                let q = tree_f64(tree, pq, 1.0);
                push_eq_band_to_hw(dev, ch, 0x0A + band, 4 + band as u32, ft, freq, gain, q, false, byps, &SAMPLE_RATES_DSP);
            }
        }
        HwBinding::CompBypassOrBlend { ch } => {
            if let Some(dsp) = ctx.input_dsp_paths.get(&ch) {
                let byps = tree_i32(tree, &dsp.comp_byps, 1) != 0;
                let blend = tree_f64(tree, &dsp.comp_blend, 1.0).clamp(0.0, 1.0);
                let raw: u16 = if byps {
                    0
                } else {
                    (blend * 32767.0).round().clamp(1.0, 32767.0) as u16
                };
                let _ = dev.vendor_out(BREQ_PARAM, ENT_DSP, 0x0400 | (ch as u16), &raw.to_le_bytes());
            }
        }
        HwBinding::DspOrder { ch } => {
            if let Some(v) = value.as_i64() {
                // Hardware ent=0x07 cs=0x05: 1 = EQ->COMP (UI 0), 0 = COMP->EQ (UI 1)
                let hw_val: u8 = if v == 0 { 1 } else { 0 };
                let _ = dev.vendor_out(BREQ_PARAM, ENT_DSP, 0x0500 | (ch as u16), &[hw_val]);
            }
        }
        HwBinding::CompParam { ch, cs } => {
            if let Some(val) = value.as_f64() {
                let bytes = match cs {
                    0x00 | 0x01 => ((val * 6.0).round().clamp(20.0, 60000.0) as u16).to_le_bytes(),
                    _ => db_to_q88(val),
                };
                let _ = dev.vendor_out(BREQ_PARAM, ENT_DSP, ((cs as u16) << 8) | (ch as u16), &bytes);
            }
        }
        HwBinding::MixerChannel { bus, src } => {
            if let Some(paths) = ctx.mixer_ch_paths.get(&(bus, src)) {
                let vol = tree_f64(tree, &paths.vol, -128.0);
                let pan = tree_i32(tree, &paths.pan, 0);
                let muted = tree_i32(tree, &paths.mute, 0) != 0;
                let (gl, gr) = vol_pan_to_crosspoints(vol, pan, muted);
                let cs_l = bus * 2 + 1;
                let cs_r = bus * 2 + 2;
                let _ = dev.vendor_out(BREQ_PARAM, ENT_MIXER, ((cs_l as u16) << 8) | (src as u16), &db_to_q88(gl));
                let _ = dev.vendor_out(BREQ_PARAM, ENT_MIXER, ((cs_r as u16) << 8) | (src as u16), &db_to_q88(gr));
            }
        }
        HwBinding::BusMasterVol { bus } => {
            if let Some(db) = value.as_f64() {
                let q = db_to_q88(db);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_BUS_MASTER, (bus * 2) as u16, &q);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_BUS_MASTER, (bus * 2 + 1) as u16, &q);
            }
        }
        HwBinding::ReverbParam { cs, scale } => {
            if let Some(v) = value.as_f64() {
                let max_val = if scale > 1.0 { 32767.0 } else { 20000.0 };
                let raw = (v * scale).round().clamp(0.0, max_val) as u16;
                let _ = dev.vendor_out(BREQ_PARAM, ENT_REVERB, (cs as u16) << 8, &raw.to_le_bytes());
            }
        }
        HwBinding::SmartGainTrigger => {
            if let Some(v) = value.as_i64() {
                // Hardware verified: ent=0x0B cs=0x04 (1=Start/Run, 4=Stop/Close)
                let _ = dev.vendor_out(BREQ_PARAM, ENT_SMARTGAIN, 0x0400, &[v as u8]);
            }
        }
        HwBinding::SmartGainArm { ch } => {
            if let Some(v) = value.as_i64() {
                // Hardware verified: ent=0x01 cs=0x08 ch=N (0/1 per analog preamp)
                let b = if v != 0 { 1 } else { 0 };
                ctx.last_watched.insert(HwRegKey { entity: ENT_INPUTS, cs: 0x08, ch }, b as i32);
                let _ = dev.vendor_out(BREQ_PARAM, ENT_INPUTS, 0x0800 | (ch as u16), &[b]);
            }
        }
        HwBinding::RoomBypass => {
            if let Some(v) = value.as_i64() {
                let cur = hw_get_u16(dev, ENT_ROOM, 0x01, 0, 0);
                let next = if v != 0 { cur | 0x02 } else { cur & !0x02 };
                let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, 0x0100, &next.to_le_bytes());
            }
        }
        HwBinding::RoomProfTrim => {
            if let Some(db) = value.as_f64() {
                let raw = (db.clamp(-12.0, 12.0) * 256.0).round() as i32;
                let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, 0x2300, &raw.to_le_bytes());
            }
        }
        HwBinding::RoomSpkTrim { ch } => {
            if let Some(db) = value.as_f64() {
                let raw = (db.clamp(-12.0, 12.0) * 256.0).round() as i32;
                let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, 0x0400 | (ch as u16), &raw.to_le_bytes());
            }
        }
        HwBinding::RoomSpkDelay { ch } => {
            if let Some(ms) = value.as_f64() {
                let raw = (ms.clamp(0.0, 10.0) * 100.0).round() as u32;
                let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, 0x0600 | (ch as u16), &raw.to_le_bytes());
            }
        }
        HwBinding::RoomSpkDelayOn { ch, dly_path } => {
            if let Some(v) = value.as_i64() {
                let raw: u32 = if v != 0 {
                    let ms = tree_f64(tree, &dly_path, 0.0);
                    (ms.clamp(0.0, 10.0) * 100.0).round() as u32
                } else {
                    0
                };
                let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, 0x0600 | (ch as u16), &raw.to_le_bytes());
            }
        }
        HwBinding::RoomEqBand {
            ch,
            cs,
            t_path,
            f_path,
            g_path,
            q_path,
        } => {
            let t = tree_i32(tree, &t_path, 11).clamp(0, 65535) as u16;
            let f = tree_f64(tree, &f_path, 1000.0).clamp(20.0, 20000.0).round() as u16;
            let g = db_to_q88(tree_f64(tree, &g_path, 0.0).clamp(-12.0, 12.0));
            let q = (tree_f64(tree, &q_path, 0.71).clamp(0.3, 12.0) * 256.0).round() as u16;
            let mut pkt = [0u8; 8];
            pkt[0..2].copy_from_slice(&t.to_le_bytes());
            pkt[2..4].copy_from_slice(&f.to_le_bytes());
            pkt[4..6].copy_from_slice(&g);
            pkt[6..8].copy_from_slice(&q.to_le_bytes());
            let _ = dev.vendor_out(BREQ_PARAM, ENT_ROOM, ((cs as u16) << 8) | (ch as u16), &pkt);
        }
        HwBinding::FnKeyMode => {
            if let Some(v) = value.as_i64() {
                write_fn_key_mode(dev, v as i32, false);
            }
        }
    }
}

// ============================================================================
// Live Hardware Event Polling (`bReq=3`) & Meter Polling (`bReq=4`)
// ============================================================================

/// Directly poll physical knob & front-panel toggle registers so hardware adjustments always
/// sync cleanly even if the hardware FIFO does not emit an event for a given control.
pub fn poll_watched_front_panel(
    dev: &TusbDevice<'_>,
    ctx: &mut DirectContext,
    seed_only: bool,
) -> Result<Vec<(Vec<usize>, JuceVar)>, u32> {
    let mut regs: Vec<(HwRegKey, bool)> = vec![
        (HwRegKey { entity: ENT_MONITOR, cs: 0x0A, ch: 0 }, true),  // Main Vol
        (HwRegKey { entity: ENT_MONITOR, cs: 0x02, ch: 0 }, false), // Main Mute
        (HwRegKey { entity: ENT_MONITOR, cs: 0x03, ch: 0 }, false), // Dim
        (HwRegKey { entity: ENT_MONITOR, cs: 0x00, ch: 0 }, false), // Mono
        (HwRegKey { entity: ENT_MONITOR, cs: 0x01, ch: 0 }, false), // Polarity / Mid-Side
        (HwRegKey { entity: ENT_MONITOR, cs: 0x05, ch: 0 }, false), // Talkback
        (HwRegKey { entity: ENT_MONITOR, cs: 0x07, ch: 0 }, false), // Alt Speaker
        (HwRegKey { entity: ENT_MONITOR, cs: 0x0E, ch: 0 }, false), // Physical Fn button (FnActive)
        (HwRegKey { entity: ENT_OUTPUTS, cs: 0x01, ch: 4 }, true),  // HP1 Vol
        (HwRegKey { entity: ENT_OUTPUTS, cs: 0x02, ch: 4 }, false), // HP1 Mute
        (HwRegKey { entity: ENT_SYSTEM, cs: 0x0A, ch: 0 }, false),    // Global Mute (knob click)
        (HwRegKey { entity: ENT_SMARTGAIN, cs: 0x00, ch: 0 }, false), // SmartGain Status
    ];
    for ch in 0..ctx.analog_count {
        regs.push((HwRegKey { entity: ENT_INPUTS, cs: 0x00, ch }, true));  // Mic Gain
        regs.push((HwRegKey { entity: ENT_INPUTS, cs: 0x05, ch }, false)); // 48V
        regs.push((HwRegKey { entity: ENT_INPUTS, cs: 0x01, ch }, false)); // Mic Mute
        regs.push((HwRegKey { entity: ENT_INPUTS, cs: 0x08, ch }, false)); // SmartGain Armed
    }

    let mut updates = Vec::new();
    let total_slots = regs.len() + 1; // +1 for external sample-rate check
    let slots_to_poll = if seed_only { total_slots } else { 2 };

    for _ in 0..slots_to_poll {
        let slot = if seed_only {
            let cur = ctx.panel_cursor;
            ctx.panel_cursor += 1;
            cur
        } else {
            let cur = ctx.panel_cursor % total_slots;
            ctx.panel_cursor = (cur + 1) % total_slots;
            cur
        };

        if slot < regs.len() {
            let (key, is_q88) = regs[slot];
            let len = if is_q88 { 2 } else { 1 };
            let Ok(buf) = dev.vendor_in(BREQ_PARAM, key.entity, ((key.cs as u16) << 8) | (key.ch as u16), len) else {
                continue;
            };
            if buf.len() < len as usize {
                continue;
            }
            let raw_i32 = if is_q88 {
                i16::from_le_bytes([buf[0], buf[1]]) as i32
            } else {
                buf[0] as i32
            };
            let prev = ctx.last_watched.insert(key, raw_i32);
            if seed_only || prev == Some(raw_i32) {
                continue;
            }
            if let Some(path) = ctx.hw_to_path.get(&key) {
                let val = if is_q88 {
                    JuceVar::Double(q88_to_db(&buf))
                } else {
                    JuceVar::Int(raw_i32)
                };
                updates.push((path.clone(), val));
            }
        } else {
            // Also detect external sample rate changes (e.g. DAW / Windows Sound Settings)
            if let Some(live_sr) = dev.get_sample_rate() {
                if live_sr > 0 && live_sr != ctx.sample_rate {
                    ctx.sample_rate = live_sr;
                    if !seed_only {
                        if let Some(sr_path) = ctx.hw_to_path.get(&HwRegKey { entity: ENT_SYSTEM, cs: 0x02, ch: 0 }) {
                            updates.push((sr_path.clone(), JuceVar::Int(live_sr as i32)));
                        }
                    }
                }
            }
        }
    }
    if seed_only {
        ctx.panel_cursor = 0;
    }
    Ok(updates)
}

/// Drain up to 8 pending hardware change events from `bReq=3` FIFO and read their updated values.
pub fn poll_hardware_events(
    dev: &TusbDevice<'_>,
    ctx: &mut DirectContext,
) -> Result<Vec<(Vec<usize>, JuceVar)>, u32> {
    let mut updates = Vec::new();
    for _ in 0..8 {
        let ev = dev.vendor_in(BREQ_EVENT_POLL, ENT_SYSTEM, 0x0000, 4)?;
        if ev.len() < 4 || (ev[0] == 0xFF && ev[3] == 0xFF) {
            break;
        }
        let cs = ev[0];
        let ch = ev[1];
        let entity = ev[3];
        let key = HwRegKey { entity, cs, ch };
        let Some(path) = ctx.hw_to_path.get(&key) else {
            continue;
        };
        let Some(binding) = ctx.path_to_hw.get(path) else {
            continue;
        };
        let new_val = match binding {
            HwBinding::MonitorVol | HwBinding::MonitorQ88(_) | HwBinding::Hp1Vol | HwBinding::InputGain { .. } | HwBinding::InputTrim { .. } | HwBinding::OutputVol { .. } => {
                let db = hw_get_q88(dev, entity, cs, ch, -128.0);
                ctx.last_watched.insert(key, i16::from_le_bytes(db_to_q88(db)) as i32);
                JuceVar::Double(db)
            }
            HwBinding::Hp1Src => {
                let raw = hw_get_u8(dev, entity, cs, ch, 0x2B);
                JuceVar::Int(hw_out_src_to_ui(raw, true))
            }
            HwBinding::SampleRate => {
                let live_sr = dev
                    .get_sample_rate()
                    .or_else(|| {
                        dev.vendor_in(BREQ_PARAM, ENT_SYSTEM, 0x0200, 4)
                            .ok()
                            .filter(|b| b.len() >= 4)
                            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    })
                    .unwrap_or(ctx.sample_rate);
                ctx.sample_rate = live_sr;
                JuceVar::Int(live_sr as i32)
            }
            HwBinding::DspOrder { .. } => {
                let hw_v = hw_get_u8(dev, entity, cs, ch, 1);
                JuceVar::Int(if hw_v == 0 { 1 } else { 0 })
            }
            _ => {
                let v = hw_get_u8(dev, entity, cs, ch, 0) as i32;
                let prev = ctx.last_watched.insert(key, v);
                if prev == Some(v) {
                    continue;
                }
                JuceVar::Int(v)
            }
        };
        updates.push((path.clone(), new_val));
    }
    Ok(updates)
}

/// Update `editable` on all DSP parameters (EQ, Compressor, DspOrder, RecSrc, Reverb)
/// whenever the hardware sample rate changes: DSP is available at <= 96 kHz, locked at 176.4/192 kHz.
pub fn set_dsp_editable_for_sr(root: &mut ValueTreeNode, sr: u32) -> Vec<Vec<usize>> {
    let editable = sr <= 96000;
    let mut changed = Vec::new();

    fn mark_subtree(node: &mut ValueTreeNode, path: &mut Vec<usize>, editable: bool, out: &mut Vec<Vec<usize>>) {
        if node.tag == "param" {
            let prev = match node.props.get("editable") {
                Some(JuceVar::Bool(b)) => *b,
                _ => true,
            };
            if prev != editable {
                node.props.insert("editable".into(), JuceVar::Bool(editable));
                out.push(path.clone());
            }
        }
        for i in 0..node.children.len() {
            path.push(i);
            mark_subtree(&mut node.children[i], path, editable, out);
            path.pop();
        }
    }

    fn walk(node: &mut ValueTreeNode, path: &mut Vec<usize>, editable: bool, out: &mut Vec<Vec<usize>>) {
        match node.tag.as_str() {
            "EQ" | "Compressor" => {
                mark_subtree(node, path, editable, out);
                return;
            }
            "param" => {
                if let Some(JuceVar::String(nm)) = node.props.get("name") {
                    if matches!(nm.as_str(), "DspOrder" | "RecSrc" | "Decay" | "Damping" | "Blend") {
                        let prev = match node.props.get("editable") {
                            Some(JuceVar::Bool(b)) => *b,
                            _ => true,
                        };
                        if prev != editable {
                            node.props.insert("editable".into(), JuceVar::Bool(editable));
                            out.push(path.clone());
                        }
                    }
                }
                return;
            }
            _ => {}
        }
        for i in 0..node.children.len() {
            path.push(i);
            walk(&mut node.children[i], path, editable, out);
            path.pop();
        }
    }

    let mut path = Vec::new();
    walk(root, &mut path, editable, &mut changed);
    changed
}

/// Commit the iD2's current live DSP/mixer/preamp/routing/monitor state into onboard flash memory
/// (`bmReq=0x41, bReq=5, wIndex=0, wValue=5, data=[0]`).
pub fn save_boot_state(dev: &TusbDevice<'_>) -> Result<(), u32> {
    dev.vendor_out(BREQ_SYS_CMD, ENT_SYSTEM, SYS_CMD_SAVE_BOOT_STATE, &[0])
}

/// Reload the saved Boot State from the iD2's onboard flash memory into live DSP RAM
/// (`bmReq=0x41, bReq=5, wIndex=0, wValue=6, data=[0]`).
pub fn load_boot_state(dev: &TusbDevice<'_>) -> Result<(), u32> {
    dev.vendor_out(BREQ_SYS_CMD, ENT_SYSTEM, SYS_CMD_LOAD_BOOT_STATE, &[0])
}

/// Poll all 4 live hardware meter blocks (`bReq=4`, `wVal=0..3`) and return a standard `MeterFrame`.
pub fn poll_hardware_meters(dev: &TusbDevice<'_>) -> Result<MeterFrame, u32> {
    let b0 = dev.vendor_in(BREQ_METERS, ENT_SYSTEM, 0x0000, 36)?;
    let b1 = dev.vendor_in(BREQ_METERS, ENT_SYSTEM, 0x0001, 16)?;
    let b2 = dev.vendor_in(BREQ_METERS, ENT_SYSTEM, 0x0002, 12)?;
    let b3 = dev.vendor_in(BREQ_METERS, ENT_SYSTEM, 0x0003, 20)?;

    let parse_dbfs = |raw: &[u8]| -> Vec<f64> {
        raw.chunks_exact(2)
            .map(|c| meter_u16_to_dbfs(u16::from_le_bytes([c[0], c[1]])))
            .collect()
    };
    let parse_gr = |raw: &[u8]| -> Vec<f64> {
        raw.chunks_exact(2)
            .map(|c| meter_gr_u16_to_db(u16::from_le_bytes([c[0], c[1]])))
            .collect()
    };

    let m0 = parse_dbfs(&b0); // 18 ch: 0..2 analogue, 2..10 digital, 10..16 host, 16..18 reverb
    let mixbus = parse_dbfs(&b1); // 8 ch: Main L/R, Mix A L/R, Mix B L/R, Reverb L/R
    let room = parse_dbfs(&b2); // 6 ch: Main Out L/R, Alt L/R, HP1 L/R
    let comp_gr = parse_gr(&b3); // 10 ch: Input comp GR

    let slice_or = |v: &[f64], start: usize, end: usize| -> Vec<f64> {
        if v.len() >= end {
            v[start..end].to_vec()
        } else {
            vec![-128.0; end - start]
        }
    };

    Ok(MeterFrame {
        analogue: slice_or(&m0, 0, 2),
        digital: slice_or(&m0, 2, 10),
        host: slice_or(&m0, 10, 16),
        reverb: slice_or(&m0, 16, 18),
        mixbus,
        room,
        comp_gr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q88_db_roundtrip() {
        assert_eq!(db_to_q88(-33.0), [0x00, 0xDF]);
        assert_eq!(db_to_q88(47.0), [0x00, 0x2F]);
        assert_eq!(db_to_q88(-128.0), [0x00, 0x80]);
        assert!((q88_to_db(&[0x00, 0xDF]) - (-33.0)).abs() < 1e-6);
        assert!((q88_to_db(&[0x00, 0x2F]) - 47.0).abs() < 1e-6);
        assert!((q88_to_db(&[0x00, 0x80]) - (-128.0)).abs() < 1e-6);
    }

    #[test]
    fn svf_hpf_matches_captured_id2_coefficients() {
        // Captured at t=39.05 for 100 Hz HPF, Q=0x00B5/256 (0.70703125), SR=44100 Hz:
        // a1 = 0x3F5BBE18 (1062977048), a2 = 0x00738C4C (7572556), a3 = 0x0000D2BA (53946)
        let pkt = encode_svf_packet(0, 44100, 3, 100.0, 0.0, 181.0 / 256.0, false, false);
        let m0 = i32::from_le_bytes(pkt[8..12].try_into().unwrap());
        let a1 = i32::from_le_bytes(pkt[20..24].try_into().unwrap());
        let a2 = i32::from_le_bytes(pkt[24..28].try_into().unwrap());
        let a3 = i32::from_le_bytes(pkt[28..32].try_into().unwrap());
        assert_eq!(m0, 0x2000_0000);
        assert!((a1 - 0x3F5B_BE18_i32).abs() < 50_000);
        assert!((a2 - 0x0073_8C4C_i32).abs() < 500);
        assert!((a3 - 0x0000_D2BA_i32).abs() < 20);
    }

    #[test]
    fn direct_usb_settings_roundtrip_and_compat() {
        // Older config.json without mixer_links/eq_bypass/etc. deserializes cleanly with defaults
        let legacy: DirectUsbSettings = serde_json::from_str(r#"{"initialized":true,"buffer_size":128}"#).unwrap();
        assert!(legacy.initialized);
        assert_eq!(legacy.buffer_size, 128);
        assert_eq!(legacy.mono_mode, 1);
        assert!(legacy.mixer_links.is_empty());

        let mut cfg = DirectUsbSettings::default();
        cfg.mixer_links.insert("0:5".into(), 0); // Comp Out 1+2 set to MONO
        cfg.mixer_mutes.insert("0:10".into(), 1);
        cfg.mixer_vols.insert("0:10".into(), -6.0);
        cfg.out_router_links.insert(0, 0);
        cfg.eq_bypass.insert(0, 1);
        cfg.input_polarity.insert(1, 1);
        cfg.comp_blend.insert(0, 0.5);
        cfg.main_src = 2;
        cfg.lb_virt_out = 1;

        let json = serde_json::to_string(&cfg).unwrap();
        let back: DirectUsbSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.mixer_links.get("0:5"), Some(&0));
        assert_eq!(back.mixer_mutes.get("0:10"), Some(&1));
        assert_eq!(back.mixer_vols.get("0:10"), Some(&-6.0));
        assert_eq!(back.out_router_links.get(&0), Some(&0));
        assert_eq!(back.eq_bypass.get(&0), Some(&1));
        assert_eq!(back.input_polarity.get(&1), Some(&1));
        assert_eq!(back.comp_blend.get(&0), Some(&0.5));
        assert_eq!(back.main_src, 2);
        assert_eq!(back.lb_virt_out, 1);
    }

    #[test]
    #[ignore]
    fn probe_fn_registers() {
        let api = TusbApi::load().expect("Audient USB driver not found");
        let dev = api.open_first().expect("No Audient iD device connected");
        for &(name, ent) in &[("ENT_SYSTEM", ENT_SYSTEM), ("ENT_MONITOR", ENT_MONITOR)] {
            println!("=== {name} (0x{ent:02X}) ===");
            for cs in 0x00u8..=0x20u8 {
                if let Ok(buf) = dev.vendor_in(BREQ_PARAM, ent, (cs as u16) << 8, 4) {
                    if !buf.is_empty() {
                        println!("  cs=0x{cs:02X}: {:02X?}", buf);
                    }
                }
            }
        }
    }
}
