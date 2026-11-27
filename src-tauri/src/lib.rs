mod direct_usb;
mod valuetree;

use direct_usb::{
    build_direct_context, is_driver_dll_available, load_boot_state, poll_hardware_events,
    poll_hardware_meters, poll_watched_front_panel, save_boot_state, write_param_batch_to_hardware,
    BackendInfo, BackendMode, DirectUsbSettings, TusbApi,
};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::time::Instant;
use valuetree::{
    apply_sync_change, encode_property_change, extract_frames, parse_diff_frame,
    parse_full_sync_frame, parse_meter_packet, JuceVar, MeterFrame, ParamChangeEvent, SyncChange,
    ValueTreeNode,
};

const HANDSHAKE: [u8; 90] = [
    0x08, 0x27, 0x00, 0x00, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x4a, 0x00, 0x00, 0x27, 0x08,
    0x64, 0x00, 0x00, 0x00, 0x01, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xd2, 0xaf, 0x00, 0x00, 0xfa, 0x86, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x6e, 0xc9, 0x04, 0x54,
    0x83, 0x76, 0x00, 0x00, 0x00, 0x13, 0x41, 0x75, 0x64, 0x69, 0x65, 0x6e, 0x74, 0x20, 0x69, 0x44,
    0x20, 0x43, 0x6f, 0x6e, 0x74, 0x72, 0x6f, 0x6c, 0x00, 0x00,
];

const DEFAULT_HP1_VOL_PATH: [usize; 6] = [0, 1, 3, 3, 16, 1];

#[derive(Debug, Clone)]
struct OutboundPropertyChange {
    path: Vec<usize>,
    prop: String,
    value: JuceVar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateSnapshot {
    device_path: Vec<usize>,
    root: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CustomFnMode {
    None,
    MuteMics,
    MuteMic1,
    MuteMic2,
    MuteHeadphones,
    SwapSpkHp,
    MidSide,
    RefLevel,
    GlobalMute,
    BypassDsp,
    ToggleScene1,
    ToggleScene2,
    ToggleScene3,
    ToggleScene4,
}

impl Default for CustomFnMode {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedWindowBounds {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    maximized: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedWindowLayout {
    mode: Option<String>,
    full: SavedWindowBounds,
    compact: SavedWindowBounds,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedConfig {
    backend_mode: BackendMode,
    custom_fn_mode: CustomFnMode,
    fn_key_mode: Option<i32>,
    sample_rate: Option<i32>,
    buffer_size: Option<i32>,
    clock_source: Option<i32>,
    direct_usb: DirectUsbSettings,
    ui_prefs: serde_json::Value,
    window_layout: SavedWindowLayout,
}

fn load_config(path: &Option<PathBuf>) -> PersistedConfig {
    let Some(p) = path else {
        return PersistedConfig::default();
    };
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(path: &Option<PathBuf>, cfg: &PersistedConfig) {
    let Some(p) = path else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(p, json);
    }
}

fn find_child_idx(node: &ValueTreeNode, pred: impl Fn(&ValueTreeNode) -> bool) -> Option<usize> {
    node.children.iter().position(pred)
}

fn find_param_path(root: &ValueTreeNode, parent: &[usize], name: &str) -> Option<Vec<usize>> {
    let node = root.get_path(parent)?;
    let idx = find_child_idx(node, |c| {
        c.tag == "param" && c.props.get("name").and_then(|v| v.as_str()) == Some(name)
    })?;
    let mut p = parent.to_vec();
    p.push(idx);
    Some(p)
}

struct AdmStore {
    connected: bool,
    root: Option<ValueTreeNode>,
    device_path: Option<Vec<usize>>,
    vm_types: BTreeMap<i64, String>,
    hp1_vol_path: Vec<usize>,
    sr_path: Option<Vec<usize>>,
    buf_path: Option<Vec<usize>>,
    clk_path: Option<Vec<usize>>,
    fn_mode_path: Option<Vec<usize>>,
    fn_active_path: Option<Vec<usize>>,
    talkback_path: Option<Vec<usize>>,
    tb_src_path: Option<Vec<usize>>,
    vol_recall_path: Option<Vec<usize>>,
    mono_chnl_path: Option<Vec<usize>>,
    dim_atten_path: Option<Vec<usize>>,
    ref_vol_path: Option<Vec<usize>>,
    opt_mode_path: Option<Vec<usize>>,
    show_trim_path: Option<Vec<usize>>,
    room_byps_path: Option<Vec<usize>>,
    mic1_mute_path: Option<Vec<usize>>,
    mic2_mute_path: Option<Vec<usize>>,
    hp1_mute_path: Option<Vec<usize>>,
    main_mute_path: Option<Vec<usize>>,
    main_vol_path: Option<Vec<usize>>,
    dim_path: Option<Vec<usize>>,
    mono_path: Option<Vec<usize>>,
    speaker_sel_path: Option<Vec<usize>>,
    mid_side_path: Option<Vec<usize>>,
    global_mute_path: Option<Vec<usize>>,
    dsp_bypass_paths: Vec<Vec<usize>>,
    prev_main_vol_before_ref: Option<f64>,
    last_fn_active: Option<bool>,
    last_fn_scene_trigger: Option<std::time::Instant>,
    custom_fn_mode: CustomFnMode,
    config: PersistedConfig,
    startup_restored: bool,
    config_path: Option<PathBuf>,
    current_db: f64,
}

impl AdmStore {
    fn new(config_path: Option<PathBuf>) -> Self {
        let cfg = load_config(&config_path);
        let custom_fn_mode = cfg.custom_fn_mode;
        Self {
            connected: false,
            root: None,
            device_path: None,
            vm_types: BTreeMap::new(),
            hp1_vol_path: DEFAULT_HP1_VOL_PATH.to_vec(),
            sr_path: None,
            buf_path: None,
            clk_path: None,
            fn_mode_path: None,
            fn_active_path: None,
            talkback_path: None,
            tb_src_path: None,
            vol_recall_path: None,
            mono_chnl_path: None,
            dim_atten_path: None,
            ref_vol_path: None,
            opt_mode_path: None,
            show_trim_path: None,
            room_byps_path: None,
            mic1_mute_path: None,
            mic2_mute_path: None,
            hp1_mute_path: None,
            main_mute_path: None,
            main_vol_path: None,
            dim_path: None,
            mono_path: None,
            speaker_sel_path: None,
            mid_side_path: None,
            global_mute_path: None,
            dsp_bypass_paths: Vec::new(),
            prev_main_vol_before_ref: None,
            last_fn_active: None,
            last_fn_scene_trigger: None,
            custom_fn_mode,
            config: cfg,
            startup_restored: false,
            config_path,
            current_db: -35.0,
        }
    }

    fn save_current_config(&self) {
        save_config(&self.config_path, &self.config);
    }

    fn record_engine_setting(&mut self, path: &[usize], value: &JuceVar) {
        // Keep ADM settings owned by ADM and Direct USB settings owned by Direct USB.
        if self.config.backend_mode != BackendMode::DirectUsb {
            return;
        }
        let mut dirty = false;
        if let Some(v) = value.as_i64().map(|n| n as i32) {
            let d = &mut self.config.direct_usb;
            if self.sr_path.as_deref() == Some(path) && d.sample_rate != Some(v) {
                d.sample_rate = Some(v);
                dirty = true;
            } else if self.buf_path.as_deref() == Some(path) && d.buffer_size != v {
                d.buffer_size = v;
                dirty = true;
            } else if self.clk_path.as_deref() == Some(path) && d.clock_source != Some(v) {
                d.clock_source = Some(v);
                dirty = true;
            } else if self.fn_mode_path.as_deref() == Some(path)
                && self.custom_fn_mode == CustomFnMode::None
                && d.fn_key_mode != v
            {
                d.fn_key_mode = v;
                dirty = true;
            } else if self.vol_recall_path.as_deref() == Some(path) && d.vol_recall != v {
                d.vol_recall = v;
                dirty = true;
            } else if self.mono_chnl_path.as_deref() == Some(path) && d.mono_mode != v {
                d.mono_mode = v;
                dirty = true;
            } else if self.tb_src_path.as_deref() == Some(path) && d.talkback_src != v {
                d.talkback_src = v;
                dirty = true;
            } else if self.opt_mode_path.as_deref() == Some(path) && d.opt_mode != v {
                d.opt_mode = v;
                dirty = true;
            } else if self.show_trim_path.as_deref() == Some(path) && d.show_preamp_trim != v {
                d.show_preamp_trim = v;
                dirty = true;
            }
        }
        if let Some(f) = value.as_f64() {
            let d = &mut self.config.direct_usb;
            if self.dim_atten_path.as_deref() == Some(path) && (d.dim_atten - f).abs() > 1e-4 {
                d.dim_atten = f;
                dirty = true;
            } else if self.ref_vol_path.as_deref() == Some(path) && (d.ref_vol - f).abs() > 1e-4 {
                d.ref_vol = f;
                dirty = true;
            }
        }

        // Persist software-only mixer/routing/DSP states that hardware registers don't store independently
        // (StereoLink on Mixer & Output Router, Mixer Channel Mute + pre-mute Vol/Pan, EQ Bypass, Polarity,
        // Comp pre-bypass Blend, Main Src, Loopback VirtOut).
        enum SoftUpdate {
            MixerLink(String, i32),
            MixerMute(String, i32, Option<f64>, Option<i32>),
            MixerVol(String, f64),
            MixerPan(String, i32),
            OutRouterLink(usize, i32),
            LbVirtOut(i32),
            EqBypass(u8, i32),
            InputPolarity(u8, i32),
            CompBlend(u8, f64),
            MainSrc(i32),
        }

        let soft_update: Option<SoftUpdate> = (|| {
            let root = self.root.as_ref()?;
            let mut chain: Vec<(&ValueTreeNode, usize)> = Vec::with_capacity(path.len());
            let mut cur = root;
            for &idx in path {
                let next = cur.children.get(idx)?;
                chain.push((next, idx));
                cur = next;
            }
            let state_pos = chain.iter().position(|(n, _)| n.tag == "State")?;
            let rel = &chain[state_pos + 1..];
            if rel.len() < 2 {
                return None;
            }
            let section = rel[0].0.tag.as_str();
            let leaf = rel.last()?.0;
            let param_name = leaf.props.get("name").and_then(|v| v.as_str())?;

            match section {
                "Mixer" => {
                    if rel.len() < 4 || rel[1].0.tag != "Mix" || rel[2].0.tag != "Pair" {
                        return None;
                    }
                    let bus = rel[1].1;
                    let pair = rel[2]
                        .0
                        .props
                        .get("index")
                        .and_then(|v| v.as_i64())
                        .map(|n| n as usize)?;
                    if rel.len() == 4 && param_name == "StereoLink" {
                        let v = value.as_i64()? as i32;
                        return Some(SoftUpdate::MixerLink(format!("{bus}:{pair}"), v));
                    }
                    if rel.len() == 5 && rel[3].0.tag == "Channel" {
                        let ch_node = rel[3].0;
                        let side = ch_node
                            .props
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .map(|n| n as usize)?;
                        let src = pair * 2 + side;
                        let key = format!("{bus}:{src}");
                        match param_name {
                            "Mute" => {
                                let v = value.as_i64()? as i32;
                                let sib_vol = ch_node
                                    .children
                                    .iter()
                                    .find(|c| c.props.get("name").and_then(|s| s.as_str()) == Some("Vol"))
                                    .and_then(|c| c.props.get("value"))
                                    .and_then(|val| val.as_f64());
                                let sib_pan = ch_node
                                    .children
                                    .iter()
                                    .find(|c| c.props.get("name").and_then(|s| s.as_str()) == Some("Pan"))
                                    .and_then(|c| c.props.get("value"))
                                    .and_then(|val| val.as_i64())
                                    .map(|n| n as i32);
                                return Some(SoftUpdate::MixerMute(key, v, sib_vol, sib_pan));
                            }
                            "Vol" => return Some(SoftUpdate::MixerVol(key, value.as_f64()?)),
                            "Pan" => return Some(SoftUpdate::MixerPan(key, value.as_i64()? as i32)),
                            _ => {}
                        }
                    }
                    None
                }
                "Routers" => {
                    if rel.len() < 4 || rel[1].0.tag != "Router" {
                        return None;
                    }
                    let rname = rel[1].0.props.get("name").and_then(|v| v.as_str())?;
                    if rname == "Output Router" && rel[2].0.tag == "Pair" && param_name == "StereoLink" {
                        let pair_idx = rel[2]
                            .0
                            .props
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .map(|n| n as usize)?;
                        return Some(SoftUpdate::OutRouterLink(pair_idx, value.as_i64()? as i32));
                    }
                    if rname == "Loopback Router" && rel[2].0.tag == "Channel" && param_name == "VirtOut" {
                        return Some(SoftUpdate::LbVirtOut(value.as_i64()? as i32));
                    }
                    None
                }
                "Inputs" => {
                    if rel.len() < 3 || rel[1].0.tag != "Channel" {
                        return None;
                    }
                    let ch = rel[1]
                        .0
                        .props
                        .get("index")
                        .and_then(|v| v.as_i64())
                        .map(|n| n as u8)?;
                    if rel.len() == 3 && param_name == "plrty" {
                        return Some(SoftUpdate::InputPolarity(ch, value.as_i64()? as i32));
                    }
                    if rel.len() == 4 && rel[2].0.tag == "EQ" && param_name == "eqByps" {
                        return Some(SoftUpdate::EqBypass(ch, value.as_i64()? as i32));
                    }
                    if rel.len() == 4 && rel[2].0.tag == "Compressor" && param_name == "Blend" {
                        return Some(SoftUpdate::CompBlend(ch, value.as_f64()?));
                    }
                    None
                }
                "MonitorControl" => {
                    if rel.len() == 2 && param_name == "Src" {
                        return Some(SoftUpdate::MainSrc(value.as_i64()? as i32));
                    }
                    None
                }
                _ => None,
            }
        })();

        if let Some(upd) = soft_update {
            let d = &mut self.config.direct_usb;
            match upd {
                SoftUpdate::MixerLink(k, v) => {
                    if d.mixer_links.get(&k).copied() != Some(v) {
                        d.mixer_links.insert(k, v);
                        dirty = true;
                    }
                }
                SoftUpdate::MixerMute(k, v, sib_vol, sib_pan) => {
                    d.mixer_mutes.insert(k.clone(), v);
                    if let Some(sv) = sib_vol {
                        if sv > -127.5 || !d.mixer_vols.contains_key(&k) {
                            d.mixer_vols.insert(k.clone(), sv);
                        }
                    }
                    if let Some(sp) = sib_pan {
                        d.mixer_pans.insert(k, sp);
                    }
                    dirty = true;
                }
                SoftUpdate::MixerVol(k, f) => {
                    d.mixer_vols.insert(k, f);
                }
                SoftUpdate::MixerPan(k, v) => {
                    d.mixer_pans.insert(k, v);
                }
                SoftUpdate::OutRouterLink(idx, v) => {
                    if d.out_router_links.get(&idx).copied() != Some(v) {
                        d.out_router_links.insert(idx, v);
                        dirty = true;
                    }
                }
                SoftUpdate::LbVirtOut(v) => {
                    if d.lb_virt_out != v {
                        d.lb_virt_out = v;
                        dirty = true;
                    }
                }
                SoftUpdate::EqBypass(ch, v) => {
                    if d.eq_bypass.get(&ch).copied() != Some(v) {
                        d.eq_bypass.insert(ch, v);
                        dirty = true;
                    }
                }
                SoftUpdate::InputPolarity(ch, v) => {
                    if d.input_polarity.get(&ch).copied() != Some(v) {
                        d.input_polarity.insert(ch, v);
                        dirty = true;
                    }
                }
                SoftUpdate::CompBlend(ch, f) => {
                    d.comp_blend.insert(ch, f);
                }
                SoftUpdate::MainSrc(v) => {
                    if d.main_src != v {
                        d.main_src = v;
                        dirty = true;
                    }
                }
            }
        }

        if dirty {
            self.config.direct_usb.initialized = true;
            self.save_current_config();
        }
    }

    fn get_int_val(&self, opt_path: &Option<Vec<usize>>) -> i32 {
        opt_path
            .as_ref()
            .and_then(|p| self.root.as_ref()?.get_path(p))
            .and_then(|n| n.props.get("value"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32
    }

    fn get_f64_val(&self, opt_path: &Option<Vec<usize>>, fallback: f64) -> f64 {
        opt_path
            .as_ref()
            .and_then(|p| self.root.as_ref()?.get_path(p))
            .and_then(|n| n.props.get("value"))
            .and_then(|v| v.as_f64())
            .unwrap_or(fallback)
    }

    #[allow(dead_code)]
    fn custom_fn_is_active(&self) -> bool {
        match self.custom_fn_mode {
            CustomFnMode::MuteMics | CustomFnMode::MuteMic1 => self.get_int_val(&self.mic1_mute_path) != 0,
            CustomFnMode::MuteMic2 => self.get_int_val(&self.mic2_mute_path) != 0,
            CustomFnMode::MuteHeadphones => self.get_int_val(&self.hp1_mute_path) != 0,
            CustomFnMode::SwapSpkHp => {
                self.get_int_val(&self.main_mute_path) != 0 && self.get_int_val(&self.hp1_mute_path) == 0
            }
            CustomFnMode::MidSide => self.get_int_val(&self.mid_side_path) != 0,
            CustomFnMode::RefLevel => self.prev_main_vol_before_ref.is_some(),
            CustomFnMode::GlobalMute => self.get_int_val(&self.global_mute_path) != 0,
            CustomFnMode::BypassDsp => self.dsp_bypass_paths.iter().all(|p| {
                self.root
                    .as_ref()
                    .and_then(|r| r.get_path(p))
                    .and_then(|n| n.props.get("value"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    != 0
            }),
            CustomFnMode::ToggleScene1
            | CustomFnMode::ToggleScene2
            | CustomFnMode::ToggleScene3
            | CustomFnMode::ToggleScene4
            | CustomFnMode::None => false,
        }
    }

    fn apply_custom_fn_trigger(&mut self, active: bool) -> (Vec<(Vec<usize>, JuceVar)>, Option<usize>) {
        let mut cmds: Vec<(Vec<usize>, JuceVar)> = Vec::new();
        let mut scene_toggle: Option<usize> = None;
        let bit = if active { 1 } else { 0 };

        let mut set_val = |root: &mut Option<ValueTreeNode>, path_opt: Option<Vec<usize>>, val: JuceVar| {
            if let Some(tp) = path_opt {
                if let Some(r) = root.as_mut() {
                    if let Some(n) = r.get_path_mut(&tp) {
                        n.props.insert("value".into(), val.clone());
                    }
                }
                cmds.push((tp, val));
            }
        };

        match self.custom_fn_mode {
            CustomFnMode::None => {}
            CustomFnMode::MuteMics => {
                let p1 = self.mic1_mute_path.clone();
                let p2 = self.mic2_mute_path.clone();
                set_val(&mut self.root, p1, JuceVar::Int(bit));
                set_val(&mut self.root, p2, JuceVar::Int(bit));
            }
            CustomFnMode::MuteMic1 => {
                let p1 = self.mic1_mute_path.clone();
                set_val(&mut self.root, p1, JuceVar::Int(bit));
            }
            CustomFnMode::MuteMic2 => {
                let p2 = self.mic2_mute_path.clone();
                set_val(&mut self.root, p2, JuceVar::Int(bit));
            }
            CustomFnMode::MuteHeadphones => {
                let p = self.hp1_mute_path.clone();
                set_val(&mut self.root, p, JuceVar::Int(bit));
            }
            CustomFnMode::SwapSpkHp => {
                // active=true -> Headphones live (mute Main speakers, unmute HP1)
                // active=false -> Speakers live (unmute Main speakers, mute HP1)
                let pm = self.main_mute_path.clone();
                let ph = self.hp1_mute_path.clone();
                set_val(&mut self.root, pm, JuceVar::Int(if active { 1 } else { 0 }));
                set_val(&mut self.root, ph, JuceVar::Int(if active { 0 } else { 1 }));
            }
            CustomFnMode::MidSide => {
                let p = self.mid_side_path.clone();
                set_val(&mut self.root, p, JuceVar::Int(bit));
            }
            CustomFnMode::RefLevel => {
                let mv_path = self.main_vol_path.clone();
                if active {
                    if self.prev_main_vol_before_ref.is_none() {
                        let cur = self.get_f64_val(&self.main_vol_path, -35.0);
                        self.prev_main_vol_before_ref = Some(cur);
                    }
                    let target = self.get_f64_val(&self.ref_vol_path, -18.0);
                    set_val(&mut self.root, mv_path, JuceVar::Double(target));
                } else if let Some(prev) = self.prev_main_vol_before_ref.take() {
                    set_val(&mut self.root, mv_path, JuceVar::Double(prev));
                }
            }
            CustomFnMode::GlobalMute => {
                let p = self.global_mute_path.clone();
                set_val(&mut self.root, p, JuceVar::Int(bit));
            }
            CustomFnMode::BypassDsp => {
                let paths = self.dsp_bypass_paths.clone();
                for tp in paths {
                    set_val(&mut self.root, Some(tp), JuceVar::Int(bit));
                }
            }
            CustomFnMode::ToggleScene1
            | CustomFnMode::ToggleScene2
            | CustomFnMode::ToggleScene3
            | CustomFnMode::ToggleScene4 => {
                let now = std::time::Instant::now();
                let too_fast = self
                    .last_fn_scene_trigger
                    .map(|t| now.duration_since(t) < Duration::from_millis(250))
                    .unwrap_or(false);
                if !too_fast {
                    self.last_fn_scene_trigger = Some(now);
                    scene_toggle = Some(match self.custom_fn_mode {
                        CustomFnMode::ToggleScene1 => 0,
                        CustomFnMode::ToggleScene2 => 1,
                        CustomFnMode::ToggleScene3 => 2,
                        CustomFnMode::ToggleScene4 => 3,
                        _ => 0,
                    });
                }
            }
        }
        for (tp, val) in &cmds {
            self.record_engine_setting(tp, val);
        }
        (cmds, scene_toggle)
    }

    fn apply_standard_fn_trigger(&mut self, active: bool) -> Vec<(Vec<usize>, JuceVar)> {
        let mut cmds: Vec<(Vec<usize>, JuceVar)> = Vec::new();
        let bit = if active { 1 } else { 0 };
        let fn_mode = self.get_int_val(&self.fn_mode_path);

        let mut set_val = |root: &mut Option<ValueTreeNode>, path_opt: Option<Vec<usize>>, val: JuceVar| {
            if let Some(tp) = path_opt {
                if let Some(r) = root.as_mut() {
                    if let Some(n) = r.get_path_mut(&tp) {
                        n.props.insert("value".into(), val.clone());
                    }
                }
                cmds.push((tp, val));
            }
        };

        // Matches VMs lookup 4: 0=Off, 1=Dim, 2=Alt Speaker, 3=Talkback, 4=Mono, 5=Polarity, 6=Main Mute, 7=RoomTune
        match fn_mode {
            1 => set_val(&mut self.root, self.dim_path.clone(), JuceVar::Int(bit)),
            2 => set_val(&mut self.root, self.speaker_sel_path.clone(), JuceVar::Int(bit)),
            3 => set_val(&mut self.root, self.talkback_path.clone(), JuceVar::Int(bit)),
            4 => set_val(&mut self.root, self.mono_path.clone(), JuceVar::Int(bit)),
            5 => set_val(&mut self.root, self.mid_side_path.clone(), JuceVar::Int(bit)),
            6 => set_val(&mut self.root, self.main_mute_path.clone(), JuceVar::Int(bit)),
            7 => set_val(&mut self.root, self.room_byps_path.clone(), JuceVar::Int(if active { 0 } else { 1 })),
            _ => {}
        }

        for (tp, val) in &cmds {
            self.record_engine_setting(tp, val);
        }
        cmds
    }

    fn build_startup_restore_cmds(&mut self) -> Vec<OutboundPropertyChange> {
        if self.startup_restored {
            return Vec::new();
        }
        self.startup_restored = true;
        let mut cmds = Vec::new();

        fn push_int_if_diff(
            root: &mut Option<ValueTreeNode>,
            cmds: &mut Vec<OutboundPropertyChange>,
            opt_path: &Option<Vec<usize>>,
            target: i32,
        ) {
            let Some(p) = opt_path.as_ref() else { return };
            let current = root
                .as_ref()
                .and_then(|r| r.get_path(p))
                .and_then(|n| n.props.get("value"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);
            if current != Some(target) {
                if let Some(r) = root.as_mut() {
                    if let Some(n) = r.get_path_mut(p) {
                        n.props.insert("value".into(), JuceVar::Int(target));
                    }
                }
                cmds.push(OutboundPropertyChange {
                    path: p.clone(),
                    prop: "value".into(),
                    value: JuceVar::Int(target),
                });
            }
        }

        // In ADM mode, let ADM keep its own engine/monitor settings intact;
        // only restore our custom Fn hook if enabled.
        if self.custom_fn_mode != CustomFnMode::None {
            push_int_if_diff(&mut self.root, &mut cmds, &self.talkback_path, 0);
            push_int_if_diff(&mut self.root, &mut cmds, &self.fn_mode_path, 7);
            let byps = if self.custom_fn_is_active() { 0 } else { 1 };
            push_int_if_diff(&mut self.root, &mut cmds, &self.room_byps_path, byps);
        }
        cmds
    }

    fn snapshot(&self) -> Option<StateSnapshot> {
        let root = self.root.as_ref()?;
        let device_path = self.device_path.clone()?;
        Some(StateSnapshot {
            device_path,
            root: root.to_json(),
        })
    }

    fn load_tree(&mut self, tree: ValueTreeNode) {
        let device_path = tree.find_device_path();
        self.sr_path = None;
        self.buf_path = None;
        self.clk_path = None;
        self.fn_mode_path = None;
        self.fn_active_path = None;
        self.talkback_path = None;
        self.tb_src_path = None;
        self.vol_recall_path = None;
        self.mono_chnl_path = None;
        self.dim_atten_path = None;
        self.ref_vol_path = None;
        self.opt_mode_path = None;
        self.show_trim_path = None;
        self.room_byps_path = None;
        self.mic1_mute_path = None;
        self.mic2_mute_path = None;
        self.hp1_mute_path = None;
        self.main_mute_path = None;
        self.main_vol_path = None;
        self.dim_path = None;
        self.mono_path = None;
        self.speaker_sel_path = None;
        self.mid_side_path = None;
        self.global_mute_path = None;
        self.dsp_bypass_paths.clear();

        if let Some(ref dp) = device_path {
            self.vm_types = tree.build_vm_types(dp);
            if let Some(hp_path) = tree.find_hp1_vol_path(dp) {
                self.hp1_vol_path = hp_path;
            }
            if let Some(dev) = tree.get_path(dp) {
                if let Some(state_idx) = find_child_idx(dev, |c| c.tag == "State") {
                    let mut state_path = dp.clone();
                    state_path.push(state_idx);
                    if let Some(state_node) = tree.get_path(&state_path) {
                        if let Some(sys_idx) = find_child_idx(state_node, |c| c.tag == "System") {
                            let mut sys_path = state_path.clone();
                            sys_path.push(sys_idx);
                            self.sr_path = find_param_path(&tree, &sys_path, "SR");
                            self.buf_path = find_param_path(&tree, &sys_path, "BufferSize");
                            if let Some(sys_node) = tree.get_path(&sys_path) {
                                if let Some(clks_idx) =
                                    find_child_idx(sys_node, |c| c.tag == "ClockSources")
                                {
                                    let mut clks_path = sys_path.clone();
                                    clks_path.push(clks_idx);
                                    self.clk_path =
                                        find_param_path(&tree, &clks_path, "CurClkSrc");
                                }
                            }
                            self.fn_mode_path = find_param_path(&tree, &sys_path, "FnKeyModeSt");
                            self.fn_active_path = find_param_path(&tree, &sys_path, "FnActive");
                            self.global_mute_path = find_param_path(&tree, &sys_path, "Mute");
                        }
                        if let Some(dig_idx) =
                            find_child_idx(state_node, |c| c.tag == "DigitalInputs")
                        {
                            let mut dig_path = state_path.clone();
                            dig_path.push(dig_idx);
                            if let Some(dig_node) = tree.get_path(&dig_path) {
                                if let Some(d0) =
                                    find_child_idx(dig_node, |c| c.tag == "DigitalInput")
                                {
                                    let mut d0_path = dig_path.clone();
                                    d0_path.push(d0);
                                    self.opt_mode_path =
                                        find_param_path(&tree, &d0_path, "OptMode");
                                }
                            }
                        }
                        if let Some(mc_idx) =
                            find_child_idx(state_node, |c| c.tag == "MonitorControl")
                        {
                            let mut mc_path = state_path.clone();
                            mc_path.push(mc_idx);
                            self.talkback_path = find_param_path(&tree, &mc_path, "Tlkbck");
                            self.tb_src_path = find_param_path(&tree, &mc_path, "intTlkBckSrc");
                            self.vol_recall_path = find_param_path(&tree, &mc_path, "VolRecall");
                            self.mono_chnl_path = find_param_path(&tree, &mc_path, "MonoChnl");
                            self.dim_atten_path = find_param_path(&tree, &mc_path, "DimAtten");
                            self.ref_vol_path = find_param_path(&tree, &mc_path, "RefVol");
                            self.main_vol_path = find_param_path(&tree, &mc_path, "Vol");
                            self.main_mute_path = find_param_path(&tree, &mc_path, "Mute");
                            self.dim_path = find_param_path(&tree, &mc_path, "Dim");
                            self.mono_path = find_param_path(&tree, &mc_path, "mono");
                            self.mid_side_path = find_param_path(&tree, &mc_path, "midSide");
                            if let Some(mc_node) = tree.get_path(&mc_path) {
                                if let Some(hp_idx) = find_child_idx(mc_node, |c| {
                                    c.tag == "Channel"
                                        && c.props.get("name").and_then(|v| v.as_str()) == Some("HP1")
                                }) {
                                    let mut hp_path = mc_path.clone();
                                    hp_path.push(hp_idx);
                                    self.hp1_mute_path = find_param_path(&tree, &hp_path, "Mute");
                                }
                                if let Some(rc_idx) =
                                    find_child_idx(mc_node, |c| c.tag == "RoomCorrection")
                                {
                                    let mut rc_path = mc_path.clone();
                                    rc_path.push(rc_idx);
                                    self.room_byps_path =
                                        find_param_path(&tree, &rc_path, "byps");
                                }
                            }
                        }
                        if let Some(r_idx) = find_child_idx(state_node, |c| c.tag == "Routers") {
                            let mut r_path = state_path.clone();
                            r_path.push(r_idx);
                            if let Some(r_node) = tree.get_path(&r_path) {
                                if let Some(or_idx) = find_child_idx(r_node, |c| {
                                    c.tag == "Router"
                                        && c.props.get("name").and_then(|v| v.as_str())
                                            == Some("Output Router")
                                }) {
                                    let mut or_path = r_path.clone();
                                    or_path.push(or_idx);
                                    self.speaker_sel_path = find_param_path(&tree, &or_path, "Src");
                                }
                            }
                        }
                        if let Some(in_idx) = find_child_idx(state_node, |c| c.tag == "Inputs") {
                            let mut in_path = state_path.clone();
                            in_path.push(in_idx);
                            self.show_trim_path = find_param_path(&tree, &in_path, "Trim");
                            if let Some(in_node) = tree.get_path(&in_path) {
                                for ch_idx in [0i64, 1i64] {
                                    if let Some(ci) = find_child_idx(in_node, |c| {
                                        c.tag == "Channel"
                                            && c.props.get("index").and_then(|v| v.as_i64())
                                                == Some(ch_idx)
                                    }) {
                                        let mut p = in_path.clone();
                                        p.push(ci);
                                        if ch_idx == 0 {
                                            self.mic1_mute_path = find_param_path(&tree, &p, "Mute");
                                        } else {
                                            self.mic2_mute_path = find_param_path(&tree, &p, "Mute");
                                        }
                                        if let Some(ch_node) = tree.get_path(&p) {
                                            if let Some(eq_i) = find_child_idx(ch_node, |c| c.tag == "EQ") {
                                                let mut eq_p = p.clone();
                                                eq_p.push(eq_i);
                                                if let Some(bp) = find_param_path(&tree, &eq_p, "eqByps") {
                                                    self.dsp_bypass_paths.push(bp);
                                                }
                                            }
                                            if let Some(cp_i) =
                                                find_child_idx(ch_node, |c| c.tag == "Compressor")
                                            {
                                                let mut cp_p = p.clone();
                                                cp_p.push(cp_i);
                                                if let Some(bp) = find_param_path(&tree, &cp_p, "byps") {
                                                    self.dsp_bypass_paths.push(bp);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(db) = tree
            .get_path(&self.hp1_vol_path)
            .and_then(|n| n.props.get("value"))
            .and_then(|v| v.as_f64())
        {
            self.current_db = db.clamp(-128.0, 0.0);
        }
        self.device_path = device_path;
        self.root = Some(tree);
        self.last_fn_active = Some(self.get_int_val(&self.fn_active_path) != 0);
    }

    fn coerce_property_value(
        &self,
        path: &[usize],
        prop: &str,
        value: &serde_json::Value,
    ) -> Result<JuceVar, String> {
        let node = self.root.as_ref().and_then(|r| r.get_path(path));
        let existing = node.and_then(|n| n.props.get(prop));
        let vm_val_type = node
            .and_then(|n| n.props.get("key"))
            .and_then(|k| k.as_i64())
            .and_then(|id| self.vm_types.get(&id))
            .map(|s| s.as_str());
        JuceVar::from_json_with_hint(value, existing, vm_val_type)
    }
}

struct AppState {
    cmd_tx: mpsc::UnboundedSender<OutboundPropertyChange>,
    mode_tx: watch::Sender<BackendMode>,
    backend_info: Arc<Mutex<BackendInfo>>,
    store: Arc<Mutex<AdmStore>>,
}

#[tauri::command]
async fn get_backend_info(state: State<'_, AppState>) -> Result<BackendInfo, String> {
    Ok(state.backend_info.lock().await.clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAppearance {
    accent: Option<i32>,
    reduce_transparency: bool,
}

#[tauri::command]
fn get_system_accent() -> Option<i32> {
    get_system_appearance().accent
}

#[tauri::command]
fn get_system_appearance() -> SystemAppearance {
    #[cfg(target_os = "macos")]
    {
        let accent = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleAccentColor"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i32>().ok());
        let reduce_transparency = std::process::Command::new("defaults")
            .args(["read", "com.apple.universalaccess", "reduceTransparency"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
            .unwrap_or(false);
        return SystemAppearance {
            accent,
            reduce_transparency,
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        SystemAppearance {
            accent: None,
            reduce_transparency: false,
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_sync_window_mode(window: &tauri::WebviewWindow, is_full: bool) {
    extern "C" {
        fn macos_set_compact_window_style(ns_window_ptr: *mut std::ffi::c_void, is_compact: std::ffi::c_int);
    }
    if let Ok(ns_win) = window.ns_window() {
        unsafe {
            macos_set_compact_window_style(ns_win, if is_full { 0 } else { 1 });
        }
    }
}

#[tauri::command]
async fn set_backend_mode(
    mode: BackendMode,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackendInfo, String> {
    {
        let mut st = state.store.lock().await;
        st.config.backend_mode = mode;
        st.save_current_config();
    }
    let info = {
        let mut bi = state.backend_info.lock().await;
        bi.mode = mode;
        bi.clone()
    };
    let _ = state.mode_tx.send(mode);
    let _ = app.emit("backend-info", &info);
    Ok(info)
}

#[tauri::command]
async fn get_adm_status(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.store.lock().await.connected)
}

#[tauri::command]
async fn get_full_state(state: State<'_, AppState>) -> Result<Option<StateSnapshot>, String> {
    Ok(state.store.lock().await.snapshot())
}

#[tauri::command]
async fn save_hardware_boot_state(state: State<'_, AppState>) -> Result<(), String> {
    {
        let st = state.store.lock().await;
        st.save_current_config();
    }
    state
        .cmd_tx
        .send(OutboundPropertyChange {
            path: Vec::new(),
            prop: "__hw_save_boot".to_string(),
            value: JuceVar::Int(1),
        })
        .map_err(|e| format!("Failed to queue save boot state: {e}"))
}

#[tauri::command]
async fn load_hardware_boot_state(state: State<'_, AppState>) -> Result<(), String> {
    state
        .cmd_tx
        .send(OutboundPropertyChange {
            path: Vec::new(),
            prop: "__hw_load_boot".to_string(),
            value: JuceVar::Int(1),
        })
        .map_err(|e| format!("Failed to queue load boot state: {e}"))
}

#[tauri::command]
async fn set_param(
    path: Vec<usize>,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_property_inner(path, "value".to_string(), value, &state).await
}

#[tauri::command]
async fn set_property(
    path: Vec<usize>,
    prop: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_property_inner(path, prop, value, &state).await
}

async fn set_property_inner(
    path: Vec<usize>,
    prop: String,
    value: serde_json::Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let juce_val = {
        let mut store = state.store.lock().await;
        let coerced = store.coerce_property_value(&path, &prop, &value)?;
        if let Some(root) = store.root.as_mut() {
            if let Some(node) = root.get_path_mut(&path) {
                node.props.insert(prop.clone(), coerced.clone());
            }
        }
        if path == store.hp1_vol_path && prop == "value" {
            if let Some(db) = coerced.as_f64() {
                store.current_db = db.clamp(-128.0, 0.0);
            }
        }
        if prop == "value" {
            store.record_engine_setting(&path, &coerced);
        }
        coerced
    };

    state
        .cmd_tx
        .send(OutboundPropertyChange {
            path,
            prop,
            value: juce_val,
        })
        .map_err(|e| format!("Failed to queue command: {e}"))
}

#[tauri::command]
async fn set_volume(db: f64, state: State<'_, AppState>) -> Result<(), String> {
    let clamped = db.clamp(-128.0, 0.0);
    let path = {
        let mut store = state.store.lock().await;
        store.current_db = clamped;
        let path = store.hp1_vol_path.clone();
        if let Some(root) = store.root.as_mut() {
            if let Some(node) = root.get_path_mut(&path) {
                node.props
                    .insert("value".to_string(), JuceVar::Double(clamped));
            }
        }
        path
    };

    state
        .cmd_tx
        .send(OutboundPropertyChange {
            path,
            prop: "value".to_string(),
            value: JuceVar::Double(clamped),
        })
        .map_err(|e| format!("Failed to queue command: {e}"))
}

#[tauri::command]
async fn get_volume(state: State<'_, AppState>) -> Result<f64, String> {
    Ok(state.store.lock().await.current_db)
}

#[tauri::command]
async fn get_ui_prefs(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.store.lock().await.config.ui_prefs.clone())
}

#[tauri::command]
async fn save_ui_prefs(
    app: AppHandle,
    prefs: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let theme = prefs
        .get("theme")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    {
        let mut st = state.store.lock().await;
        st.config.ui_prefs = prefs;
        st.save_current_config();
    }
    if let Some(theme_id) = theme {
        if let Some(tray_win) = app.get_webview_window("tray-menu") {
            let _ = tray_win.emit("theme-changed", theme_id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_custom_fn_mode(state: State<'_, AppState>) -> Result<CustomFnMode, String> {
    Ok(state.store.lock().await.custom_fn_mode)
}

#[tauri::command]
async fn set_custom_fn_mode(
    mode: CustomFnMode,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut st = state.store.lock().await;
        st.custom_fn_mode = mode;
        st.config.custom_fn_mode = mode;
        st.save_current_config();
    }

    let _ = app.emit("custom-fn-mode", mode);
    Ok(())
}

static CURRENT_WINDOW_IS_FULL: AtomicBool = AtomicBool::new(true);
static WINDOW_LAYOUT_READY: AtomicBool = AtomicBool::new(false);
static APP_EXITING: AtomicBool = AtomicBool::new(false);
static USB_WORKER_ACTIVE: AtomicBool = AtomicBool::new(false);

fn wait_for_usb_worker_shutdown() {
    APP_EXITING.store(true, Ordering::SeqCst);
    for _ in 0..45 {
        if !USB_WORKER_ACTIVE.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn current_window_mode_str() -> &'static str {
    if CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed) {
        "full"
    } else {
        "compact"
    }
}

fn validate_window_position(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    phys_w: i32,
    phys_h: i32,
) -> PhysicalPosition<i32> {
    if let Ok(monitors) = window.available_monitors() {
        let min_visible_w = phys_w.min(80).max(1);
        let min_visible_h = phys_h.min(50).max(1);
        for mon in &monitors {
            let mp = mon.position();
            let ms = mon.size();
            let mon_r = mp.x + ms.width as i32;
            let mon_b = mp.y + ms.height as i32;
            let ov_w = (x + phys_w).min(mon_r) - x.max(mp.x);
            let ov_h = (y + phys_h).min(mon_b) - y.max(mp.y);
            if ov_w >= min_visible_w && ov_h >= min_visible_h {
                return PhysicalPosition::new(x, y);
            }
        }
        if let Ok(Some(primary)) = window.primary_monitor() {
            let mp = primary.position();
            let ms = primary.size();
            let max_x = mp.x + (ms.width as i32 - phys_w).max(0);
            let max_y = mp.y + (ms.height as i32 - phys_h).max(0);
            return PhysicalPosition::new(x.clamp(mp.x, max_x), y.clamp(mp.y, max_y));
        }
    }
    PhysicalPosition::new(x, y)
}

fn set_window_rect_atomic(
    window: &tauri::WebviewWindow,
    pos: PhysicalPosition<i32>,
    phys_w: i32,
    phys_h: i32,
) {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowPos(
                hwnd: *mut std::ffi::c_void,
                hwnd_insert_after: *mut std::ffi::c_void,
                x: i32,
                y: i32,
                cx: i32,
                cy: i32,
                u_flags: u32,
            ) -> i32;
        }
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                pos.x,
                pos.y,
                phys_w,
                phys_h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        return;
    }

    let _ = window.set_size(Size::Physical(tauri::PhysicalSize::new(
        phys_w.max(1) as u32,
        phys_h.max(1) as u32,
    )));
    let _ = window.set_position(Position::Physical(pos));
}

fn capture_current_window_bounds(window: &tauri::WebviewWindow, cfg: &mut PersistedConfig) {
    let is_full = CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed);
    cfg.window_layout.mode = Some(if is_full { "full" } else { "compact" }.to_string());

    if window.is_minimized().unwrap_or(false) {
        return;
    }

    if is_full {
        let state = query_window_state(window);
        cfg.window_layout.full.maximized = state.maximized;
        if !state.maximized && !state.fullscreen && !state.snapped {
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                if pos.x > -30000 && pos.y > -30000 && size.width >= 600 && size.height >= 400 {
                    cfg.window_layout.full.x = Some(pos.x);
                    cfg.window_layout.full.y = Some(pos.y);
                    cfg.window_layout.full.width = Some(size.width);
                    cfg.window_layout.full.height = Some(size.height);
                }
            }
        }
    } else if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
        if pos.x > -30000 && pos.y > -30000 && size.width >= 200 && size.height >= 140 {
            cfg.window_layout.compact.x = Some(pos.x);
            cfg.window_layout.compact.y = Some(pos.y);
            cfg.window_layout.compact.width = Some(size.width);
            cfg.window_layout.compact.height = Some(size.height);
            cfg.window_layout.compact.maximized = false;
        }
    }
}

fn schedule_window_layout_save(window: tauri::WebviewWindow) {
    use std::sync::atomic::AtomicU64;
    static SAVE_GEN: AtomicU64 = AtomicU64::new(0);

    if !WINDOW_LAYOUT_READY.load(Ordering::Relaxed) {
        return;
    }
    let gen = SAVE_GEN.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(350)).await;
        if SAVE_GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        let app_state = window.state::<AppState>();
        let mut st = app_state.store.lock().await;
        capture_current_window_bounds(&window, &mut st.config);
        st.save_current_config();
    });
}

#[tauri::command]
async fn set_window_size(
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    anchor_right: Option<bool>,
    resizable: Option<bool>,
    is_full: Option<bool>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let target_full = is_full.unwrap_or_else(|| resizable.unwrap_or(true));
    let prev_full = CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed);

    // Capture live pre-switch window geometry BEFORE unmaximizing so "anchor_right"
    // collapses smoothly to the exact top-right corner of the current window (even if maximized).
    let pre_switch_rect = (
        window.outer_position().ok(),
        window.outer_size().ok(),
        window.current_monitor().ok().flatten(),
    );

    // Save outgoing mode's exact monitor/position/maximized state before switching
    let (saved_target_bounds, remember_mode_pos) = {
        let mut st = state.store.lock().await;
        if prev_full != target_full {
            capture_current_window_bounds(&window, &mut st.config);
        }
        st.config.window_layout.mode =
            Some(if target_full { "full" } else { "compact" }.to_string());
        st.save_current_config();
        let remember = st
            .config
            .ui_prefs
            .get("compactPositionMode")
            .and_then(|v| v.as_str())
            == Some("remember");
        let bounds = if target_full {
            st.config.window_layout.full.clone()
        } else {
            st.config.window_layout.compact.clone()
        };
        (bounds, remember)
    };

    CURRENT_WINDOW_IS_FULL.store(target_full, Ordering::Relaxed);

    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
    }
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    #[cfg(target_os = "windows")]
    win32_sync_dwm_frame(&window, target_full);
    #[cfg(target_os = "macos")]
    macos_sync_window_mode(&window, target_full);

    if let Some(can_resize) = resizable {
        let _ = window.set_resizable(can_resize);
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let default_phys_w = (width * scale).round() as i32;
    let default_phys_h = (height * scale).round() as i32;
    let (phys_w, phys_h) = if target_full {
        let w = saved_target_bounds
            .width
            .map(|v| (v as i32).max(default_phys_w))
            .unwrap_or(default_phys_w);
        let h = saved_target_bounds
            .height
            .map(|v| (v as i32).max(default_phys_h))
            .unwrap_or(default_phys_h);
        (w, h)
    } else {
        (default_phys_w, default_phys_h)
    };

    let target_pos = if remember_mode_pos {
        if let (Some(sx), Some(sy)) = (saved_target_bounds.x, saved_target_bounds.y) {
            Some(validate_window_position(&window, sx, sy, phys_w, phys_h))
        } else {
            None
        }
    } else {
        None
    }
    .or_else(|| {
        if !anchor_right.unwrap_or(false) {
            return None;
        }
        let (Some(pos), Some(size)) = (pre_switch_rect.0, pre_switch_rect.1) else {
            return None;
        };
        let right_edge = pos.x + size.width as i32;
        let mut new_x = right_edge - phys_w;
        let mut new_y = pos.y;
        if let Some(mon) = pre_switch_rect.2.as_ref() {
            let mon_pos = mon.position();
            let mon_size = mon.size();
            let min_x = mon_pos.x;
            let max_x = mon_pos.x + mon_size.width as i32 - phys_w;
            let min_y = mon_pos.y;
            let max_y = mon_pos.y + mon_size.height as i32 - phys_h;
            new_x = new_x.clamp(min_x, max_x.max(min_x));
            new_y = new_y.clamp(min_y, max_y.max(min_y));
        }
        Some(PhysicalPosition::new(new_x, new_y))
    });

    if let (Some(mw), Some(mh)) = (min_width, min_height) {
        window
            .set_min_size(Some(Size::Logical(LogicalSize {
                width: mw,
                height: mh,
            })))
            .map_err(|e| format!("Failed to set min size: {e}"))?;
    }

    if let Some(pos) = target_pos {
        set_window_rect_atomic(&window, pos, phys_w, phys_h);
    } else {
        window
            .set_size(Size::Logical(LogicalSize { width, height }))
            .map_err(|e| format!("Failed to resize window: {e}"))?;
    }

    if target_full && saved_target_bounds.maximized {
        let _ = window.maximize();
    }

    let _ = emit_window_state_if_changed(&window, true);
    Ok(())
}

#[tauri::command]
async fn resize_compact_window(
    width: f64,
    height: f64,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let clamped_w = width.clamp(320.0, 660.0);
    let clamped_h = height.clamp(215.0, 444.0);

    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let phys_w = (clamped_w * scale).round() as i32;
        let phys_h = (clamped_h * scale).round() as i32;
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowPos(
                hwnd: *mut std::ffi::c_void,
                hwnd_insert_after: *mut std::ffi::c_void,
                x: i32,
                y: i32,
                cx: i32,
                cy: i32,
                u_flags: u32,
            ) -> i32;
        }
        const SWP_NOMOVE: u32 = 0x0002;
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                0,
                0,
                phys_w,
                phys_h,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        return Ok(());
    }

    window
        .set_size(Size::Logical(LogicalSize {
            width: clamped_w,
            height: clamped_h,
        }))
        .map_err(|e| format!("Failed to resize compact window: {e}"))
}

#[tauri::command]
async fn set_always_on_top(on_top: bool, window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_always_on_top(on_top)
        .map_err(|e| format!("Failed to set always-on-top: {e}"))
}

#[tauri::command]
async fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .minimize()
        .map_err(|e| format!("Failed to minimize window: {e}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowFrameState {
    mode: &'static str,
    maximized: bool,
    fullscreen: bool,
    snapped: bool,
}

impl WindowFrameState {
    fn bits(self) -> u8 {
        (self.maximized as u8)
            | ((self.fullscreen as u8) << 1)
            | ((self.snapped as u8) << 2)
            | (((self.mode == "compact") as u8) << 3)
    }
}

#[cfg(target_os = "windows")]
mod win32_frame {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU8, Ordering};

    static LAST_DWM_EDGE_MODE: AtomicU8 = AtomicU8::new(0xFF);

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
    }

    #[repr(C)]
    struct DwmBlurBehind {
        dw_flags: u32,
        f_enable: i32,
        h_rgn_blur: *mut c_void,
        f_transition_on_maximized: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn IsZoomed(hwnd: *mut c_void) -> i32;
        fn GetWindowRect(hwnd: *mut c_void, lp_rect: *mut Rect) -> i32;
        fn MonitorFromWindow(hwnd: *mut c_void, dw_flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(h_monitor: *mut c_void, lpmi: *mut MonitorInfo) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            hwnd_insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            u_flags: u32,
        ) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> *mut c_void;
        fn DeleteObject(ho: *mut c_void) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmEnableBlurBehindWindow(hwnd: *mut c_void, p_blur_behind: *const DwmBlurBehind)
            -> i32;
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            dw_attribute: u32,
            pv_attribute: *const c_void,
            cb_attribute: u32,
        ) -> i32;
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const DWM_BB_ENABLE: u32 = 0x0000_0001;
    const DWM_BB_BLURREGION: u32 = 0x0000_0002;
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DEFAULT: u32 = 0;
    const DWMWCP_DONOTROUND: u32 = 1;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_DEFAULT: u32 = 0xFFFF_FFFF;
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    pub fn is_zoomed(hwnd: *mut c_void) -> bool {
        unsafe { IsZoomed(hwnd) != 0 }
    }

    pub fn is_snapped(hwnd: *mut c_void) -> bool {
        unsafe {
            let mut wr = Rect::default();
            if GetWindowRect(hwnd, &mut wr) == 0 {
                return false;
            }
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if hmon.is_null() {
                return false;
            }
            let mut mi = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect::default(),
                rc_work: Rect::default(),
                dw_flags: 0,
            };
            if GetMonitorInfoW(hmon, &mut mi) == 0 {
                return false;
            }
            let work = mi.rc_work;
            let work_h = work.bottom - work.top;
            let win_h = wr.bottom - wr.top;
            let full_height =
                win_h >= work_h - 12 && (wr.top - work.top).abs() <= 12;
            let touches_side =
                (wr.left - work.left).abs() <= 12 || (wr.right - work.right).abs() <= 12;
            full_height && touches_side
        }
    }

    /// Configures Windows DWM to behave identically to native custom-titlebar apps (Discord, VS Code)
    /// when in Full Console Mode (native theme border, native corners, native shadow & Snap/tiling support),
    /// and switches cleanly to a transparent floating hardware faceplate in Compact Mode.
    pub fn apply_mode_dwm(hwnd: *mut c_void, native_full_frame: bool) {
        let mode = if native_full_frame { 1 } else { 0 };
        if LAST_DWM_EDGE_MODE.swap(mode, Ordering::Relaxed) == mode {
            return;
        }
        unsafe {
            let dark: i32 = 1;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                (&dark as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            );

            if native_full_frame {
                // Full Console Mode: opaque native DWM surface + default Windows theme border & corners.
                let bb = DwmBlurBehind {
                    dw_flags: DWM_BB_ENABLE,
                    f_enable: 0,
                    h_rgn_blur: std::ptr::null_mut(),
                    f_transition_on_maximized: 0,
                };
                let _ = DwmEnableBlurBehindWindow(hwnd, &bb);

                let corner = DWMWCP_DEFAULT;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    (&corner as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
                let border = DWMWA_COLOR_DEFAULT;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    (&border as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
            } else {
                // Compact Widget Mode: floating transparent rounded hardware faceplate with no OS border.
                let corner = DWMWCP_DONOTROUND;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    (&corner as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
                let border = DWMWA_COLOR_NONE;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    (&border as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );

                let region = CreateRectRgn(0, 0, -1, -1);
                let bb = DwmBlurBehind {
                    dw_flags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
                    f_enable: 1,
                    h_rgn_blur: region,
                    f_transition_on_maximized: 0,
                };
                let _ = DwmEnableBlurBehindWindow(hwnd, &bb);
                if !region.is_null() {
                    let _ = DeleteObject(region);
                }
            }

            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }

    pub fn apply_transparent_popup_dwm(hwnd: *mut c_void) {
        unsafe {
            let corner = DWMWCP_DONOTROUND;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                (&corner as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
            let border = DWMWA_COLOR_NONE;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                (&border as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
            let region = CreateRectRgn(0, 0, -1, -1);
            let bb = DwmBlurBehind {
                dw_flags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
                f_enable: 1,
                h_rgn_blur: region,
                f_transition_on_maximized: 0,
            };
            let _ = DwmEnableBlurBehindWindow(hwnd, &bb);
            if !region.is_null() {
                let _ = DeleteObject(region);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn win32_sync_dwm_frame(window: &tauri::WebviewWindow, native_full_frame: bool) {
    let _ = window.set_shadow(native_full_frame);
    if let Ok(hwnd) = window.hwnd() {
        win32_frame::apply_mode_dwm(hwnd.0, native_full_frame);
    }
}

fn query_window_state(window: &tauri::WebviewWindow) -> WindowFrameState {
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    #[cfg(target_os = "windows")]
    let (maximized, snapped) = if let Ok(hwnd) = window.hwnd() {
        let maxed =
            !fullscreen && (win32_frame::is_zoomed(hwnd.0) || window.is_maximized().unwrap_or(false));
        let snap = !fullscreen
            && !maxed
            && window.is_resizable().unwrap_or(true)
            && win32_frame::is_snapped(hwnd.0);
        (maxed, snap)
    } else {
        (!fullscreen && window.is_maximized().unwrap_or(false), false)
    };
    #[cfg(not(target_os = "windows"))]
    let (maximized, snapped) = (!fullscreen && window.is_maximized().unwrap_or(false), false);

    WindowFrameState {
        mode: current_window_mode_str(),
        maximized,
        fullscreen,
        snapped,
    }
}

fn emit_window_state_if_changed(window: &tauri::WebviewWindow, force: bool) -> WindowFrameState {
    use std::sync::atomic::{AtomicU8, Ordering};
    static LAST_STATE_BITS: AtomicU8 = AtomicU8::new(0xFF);

    let state = query_window_state(window);
    #[cfg(target_os = "windows")]
    win32_sync_dwm_frame(window, CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed));

    let bits = state.bits();
    if force || LAST_STATE_BITS.swap(bits, Ordering::Relaxed) != bits {
        let _ = window.emit("window-state-changed", state);
    }
    state
}

#[tauri::command]
async fn get_window_state(window: tauri::WebviewWindow) -> Result<WindowFrameState, String> {
    let state = query_window_state(&window);
    #[cfg(target_os = "windows")]
    win32_sync_dwm_frame(&window, CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed));
    Ok(state)
}

#[tauri::command]
async fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<WindowFrameState, String> {
    if window.is_fullscreen().unwrap_or(false) {
        window
            .set_fullscreen(false)
            .map_err(|e| format!("Failed to exit fullscreen: {e}"))?;
        let state = WindowFrameState {
            mode: current_window_mode_str(),
            maximized: false,
            fullscreen: false,
            snapped: false,
        };
        let _ = window.emit("window-state-changed", state);
        return Ok(state);
    }

    let is_max = query_window_state(&window).maximized;
    let next_max = !is_max;
    if is_max {
        window
            .unmaximize()
            .map_err(|e| format!("Failed to unmaximize window: {e}"))?;
    } else {
        window
            .maximize()
            .map_err(|e| format!("Failed to maximize window: {e}"))?;
    }
    let state = WindowFrameState {
        mode: current_window_mode_str(),
        maximized: next_max,
        fullscreen: false,
        snapped: false,
    };
    let _ = window.emit("window-state-changed", state);
    Ok(state)
}

#[tauri::command]
async fn toggle_fullscreen_window(window: tauri::WebviewWindow) -> Result<WindowFrameState, String> {
    let next_fs = !window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(next_fs)
        .map_err(|e| format!("Failed to toggle fullscreen: {e}"))?;
    let state = WindowFrameState {
        mode: current_window_mode_str(),
        maximized: false,
        fullscreen: next_fs,
        snapped: false,
    };
    let _ = window.emit("window-state-changed", state);
    Ok(state)
}

const TRAY_MENU_W: f64 = 224.0;
const TRAY_MENU_H: f64 = 196.0;

static LAST_TRAY_BLUR_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayMenuState {
    theme: String,
    connected: bool,
    device_name: String,
    is_compact: bool,
    is_muted: bool,
    is_visible: bool,
}

fn build_tray_menu_state_blocking(app: &AppHandle) -> TrayMenuState {
    let state = app.state::<AppState>();
    let (theme, connected, is_muted) = {
        let st = state.store.blocking_lock();
        let default_theme = if cfg!(target_os = "macos") { "liquidglass" } else { "obsidian" };
        let theme = st
            .config
            .ui_prefs
            .get("theme")
            .and_then(|v| v.as_str())
            .unwrap_or(default_theme)
            .to_string();
        let muted = st.get_int_val(&st.main_mute_path) != 0;
        (theme, st.connected, muted)
    };
    let device_name = {
        let bi = state.backend_info.blocking_lock();
        bi.device_name.clone()
    };
    let is_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    TrayMenuState {
        theme,
        connected,
        device_name,
        is_compact: !CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed),
        is_muted,
        is_visible,
    }
}

async fn build_tray_menu_state_async(app: &AppHandle) -> TrayMenuState {
    let state = app.state::<AppState>();
    let (theme, connected, is_muted) = {
        let st = state.store.lock().await;
        let default_theme = if cfg!(target_os = "macos") { "liquidglass" } else { "obsidian" };
        let theme = st
            .config
            .ui_prefs
            .get("theme")
            .and_then(|v| v.as_str())
            .unwrap_or(default_theme)
            .to_string();
        let muted = st.get_int_val(&st.main_mute_path) != 0;
        (theme, st.connected, muted)
    };
    let device_name = {
        let bi = state.backend_info.lock().await;
        bi.device_name.clone()
    };
    let is_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    TrayMenuState {
        theme,
        connected,
        device_name,
        is_compact: !CURRENT_WINDOW_IS_FULL.load(Ordering::Relaxed),
        is_muted,
        is_visible,
    }
}

fn ensure_tray_menu_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(existing) = app.get_webview_window("tray-menu") {
        return Some(existing);
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "tray-menu",
        tauri::WebviewUrl::App("tray-menu.html".into()),
    )
    .title("iD Interface Menu")
    .inner_size(TRAY_MENU_W, TRAY_MENU_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false);

    let win = builder.build().ok()?;
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        win32_frame::apply_transparent_popup_dwm(hwnd.0);
    }
    Some(win)
}

fn show_tray_menu_at(app: &AppHandle, click_pos: PhysicalPosition<f64>) {
    let Some(tray_win) = ensure_tray_menu_window(app) else {
        return;
    };

    if tray_win.is_visible().unwrap_or(false) {
        let _ = tray_win.hide();
        return;
    }

    // If the popup just closed from clicking the tray icon on mouse-down, treat as toggle-close
    if now_epoch_ms().saturating_sub(LAST_TRAY_BLUR_MS.load(Ordering::Relaxed)) < 160 {
        return;
    }

    let scale = tray_win.scale_factor().unwrap_or(1.0);
    let phys_w = (TRAY_MENU_W * scale).round() as i32;
    let phys_h = (TRAY_MENU_H * scale).round() as i32;
    let cx = click_pos.x.round() as i32;
    let cy = click_pos.y.round() as i32;

    let mut target_x = cx - phys_w / 2;
    let mut target_y = cy - phys_h - 6;

    if let Ok(monitors) = tray_win.available_monitors() {
        let hit_mon = monitors
            .iter()
            .find(|m| {
                let mp = m.position();
                let ms = m.size();
                cx >= mp.x
                    && cx < mp.x + ms.width as i32
                    && cy >= mp.y
                    && cy < mp.y + ms.height as i32
            })
            .or_else(|| monitors.first());

        if let Some(mon) = hit_mon {
            let mp = mon.position();
            let ms = mon.size();
            let mon_r = mp.x + ms.width as i32;
            let mon_b = mp.y + ms.height as i32;
            let pad = (8.0 * scale).round() as i32;

            // Open above cursor for bottom taskbars (Windows) and below cursor for top bars (macOS)
            if cy > mp.y + (ms.height as i32) / 2 {
                target_y = cy - phys_h - (6.0 * scale).round() as i32;
            } else {
                target_y = cy + (6.0 * scale).round() as i32;
            }
            target_x = target_x.clamp(mp.x + pad, (mon_r - phys_w - pad).max(mp.x + pad));
            target_y = target_y.clamp(mp.y + pad, (mon_b - phys_h - pad).max(mp.y + pad));
        }
    }

    set_window_rect_atomic(&tray_win, PhysicalPosition::new(target_x, target_y), phys_w, phys_h);
    let menu_state = build_tray_menu_state_blocking(app);
    let _ = tray_win.emit("tray-menu-state", menu_state);
    let _ = tray_win.show();
    let _ = tray_win.set_focus();
}

#[tauri::command]
async fn get_tray_menu_state(app: AppHandle) -> Result<TrayMenuState, String> {
    Ok(build_tray_menu_state_async(&app).await)
}

#[tauri::command]
async fn hide_tray_menu(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("tray-menu") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
async fn tray_menu_action(
    action: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("tray-menu") {
        let _ = w.hide();
    }
    match action.as_str() {
        "show" => {
            show_main_window(&app);
        }
        "toggle_mode" => {
            show_main_window(&app);
            if let Some(main_w) = app.get_webview_window("main") {
                let _ = main_w.emit("tray-toggle-mode", ());
            }
        }
        "toggle_mute" => {
            let change = {
                let mut st = state.store.lock().await;
                if let Some(path) = st.main_mute_path.clone() {
                    let cur = st.get_int_val(&Some(path.clone()));
                    let next = if cur != 0 { 0 } else { 1 };
                    let val = JuceVar::Int(next);
                    if let Some(root) = st.root.as_mut() {
                        if let Some(node) = root.get_path_mut(&path) {
                            node.props.insert("value".into(), val.clone());
                        }
                    }
                    st.record_engine_setting(&path, &val);
                    Some((path, val))
                } else {
                    None
                }
            };
            if let Some((path, val)) = change {
                let _ = state.cmd_tx.send(OutboundPropertyChange {
                    path: path.clone(),
                    prop: "value".into(),
                    value: val.clone(),
                });
                let _ = app.emit(
                    "param-changed",
                    ParamChangeEvent {
                        path,
                        prop: "value".into(),
                        value: val.to_json(),
                    },
                );
            }
        }
        "quit" => {
            {
                let mut st = state.store.lock().await;
                if let Some(w) = app.get_webview_window("main") {
                    capture_current_window_bounds(&w, &mut st.config);
                }
                st.save_current_config();
            }
            let _ = state.cmd_tx.send(OutboundPropertyChange {
                path: Vec::new(),
                prop: "__hw_save_boot".to_string(),
                value: JuceVar::Int(1),
            });
            tokio::time::sleep(Duration::from_millis(90)).await;
            wait_for_usb_worker_shutdown();
            app.exit(0);
        }
        _ => {}
    }
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn close_action_pref_key() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "closeActionMac"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "closeActionWin"
    }
}

#[tauri::command]
async fn hide_to_tray(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut st = state.store.lock().await;
        capture_current_window_bounds(&window, &mut st.config);
        st.save_current_config();
    }
    let _ = state.cmd_tx.send(OutboundPropertyChange {
        path: Vec::new(),
        prop: "__hw_save_boot".to_string(),
        value: JuceVar::Int(1),
    });
    window
        .hide()
        .map_err(|e| format!("Failed to hide window: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
async fn quit_app(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut st = state.store.lock().await;
        capture_current_window_bounds(&window, &mut st.config);
        st.save_current_config();
    }
    let _ = state.cmd_tx.send(OutboundPropertyChange {
        path: Vec::new(),
        prop: "__hw_save_boot".to_string(),
        value: JuceVar::Int(1),
    });
    tokio::time::sleep(Duration::from_millis(90)).await;
    wait_for_usb_worker_shutdown();
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn install_app_update(
    portable_url: String,
    setup_url: String,
    fallback_url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let allowed = |u: &str| {
            u.starts_with("https://github.com/1ps3/iD-Interface/")
                || u.starts_with("https://objects.githubusercontent.com/")
        };

        let cur_exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
        let cur_dir = cur_exe.parent().ok_or("missing exe dir")?;
        let in_prog_files = cur_exe
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("\\program files");

        // Flush config & hardware boot state before replacing/restarting
        {
            let mut st = state.store.lock().await;
            if let Some(w) = app.get_webview_window("main") {
                capture_current_window_bounds(&w, &mut st.config);
            }
            st.save_current_config();
        }
        let _ = state.cmd_tx.send(OutboundPropertyChange {
            path: Vec::new(),
            prop: "__hw_save_boot".to_string(),
            value: JuceVar::Int(1),
        });

        // Portable mode: download new exe next to current exe, swap & relaunch automatically
        if !in_prog_files && allowed(&portable_url) {
            let new_exe = cur_dir.join("id-interface.exe.update");
            let url_esc = portable_url.replace('\'', "''");
            let out_esc = new_exe.to_string_lossy().replace('\'', "''");
            let dl = tokio::task::spawn_blocking(move || {
                std::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
                            url_esc, out_esc
                        ),
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status()
            })
            .await
            .map_err(|e| format!("download join error: {e}"))?
            .map_err(|e| format!("download failed: {e}"))?;

            if !dl.success() {
                let _ = std::fs::remove_file(&new_exe);
                return Err("Failed to download update binary".into());
            }
            // Sanity-check valid PE executable header ("MZ") & non-trivial size
            let meta = std::fs::metadata(&new_exe).map_err(|e| format!("stat failed: {e}"))?;
            let header = std::fs::read(&new_exe)
                .map(|b| b.len() >= 2 && b[0] == b'M' && b[1] == b'Z')
                .unwrap_or(false);
            if meta.len() < 500_000 || !header {
                let _ = std::fs::remove_file(&new_exe);
                return Err("Downloaded file is not a valid Windows executable".into());
            }

            let cur_clean = cur_exe
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .replace('\'', "''");
            let new_clean = new_exe
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .replace('\'', "''");
            let ps_script = format!(
                "for ($i=0; $i -lt 10; $i++) {{ Start-Sleep -Milliseconds 400; try {{ Move-Item -Force -LiteralPath '{}' -Destination '{}' -ErrorAction Stop; break }} catch {{}} }}; Start-Process -FilePath '{}'",
                new_clean, cur_clean, cur_clean
            );
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    &ps_script,
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to spawn updater: {e}"))?;

            tokio::time::sleep(Duration::from_millis(80)).await;
            app.exit(0);
            return Ok(());
        }

        // Installed copy (Program Files): download & launch the NSIS installer directly
        if allowed(&setup_url) {
            let tmp_setup = std::env::temp_dir().join("iD-Interface-setup.exe");
            let url_esc = setup_url.replace('\'', "''");
            let out_esc = tmp_setup.to_string_lossy().replace('\'', "''");
            let dl = tokio::task::spawn_blocking(move || {
                std::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
                            url_esc, out_esc
                        ),
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status()
            })
            .await
            .map_err(|e| format!("download join error: {e}"))?
            .map_err(|e| format!("download failed: {e}"))?;

            if dl.success() && tmp_setup.exists() {
                let _ = std::process::Command::new(&tmp_setup).spawn();
                tokio::time::sleep(Duration::from_millis(80)).await;
                app.exit(0);
                return Ok(());
            }
        }

        open_external_url(fallback_url).await
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (portable_url, setup_url);
        let allowed = fallback_url.starts_with("https://github.com/1ps3/iD-Interface/")
            || fallback_url.starts_with("https://objects.githubusercontent.com/");
        if !allowed || !fallback_url.to_ascii_lowercase().ends_with(".dmg") {
            return open_external_url(fallback_url).await;
        }

        // Locate enclosing .app bundle (e.g. /Applications/iD Interface.app)
        let cur_exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
        let app_bundle = cur_exe
            .ancestors()
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
            .map(|p| p.to_path_buf());
        let Some(app_bundle) = app_bundle else {
            return open_external_url(fallback_url).await;
        };

        // Flush config & hardware boot state before replacing/restarting
        {
            let mut st = state.store.lock().await;
            if let Some(w) = app.get_webview_window("main") {
                capture_current_window_bounds(&w, &mut st.config);
            }
            st.save_current_config();
        }
        let _ = state.cmd_tx.send(OutboundPropertyChange {
            path: Vec::new(),
            prop: "__hw_save_boot".to_string(),
            value: JuceVar::Int(1),
        });

        let tmp_dmg = std::env::temp_dir().join("id-interface-update.dmg");
        let dmg_str = tmp_dmg.to_string_lossy().to_string();
        let url_clone = fallback_url.clone();
        let dl = tokio::task::spawn_blocking(move || {
            std::process::Command::new("curl")
                .args(["-fSL", "-o", &dmg_str, &url_clone])
                .status()
        })
        .await
        .map_err(|e| format!("download join error: {e}"))?
        .map_err(|e| format!("download failed: {e}"))?;

        if !dl.success() || std::fs::metadata(&tmp_dmg).map(|m| m.len()).unwrap_or(0) < 500_000 {
            let _ = std::fs::remove_file(&tmp_dmg);
            return open_external_url(fallback_url).await;
        }

        let mnt_dir = std::env::temp_dir().join("id-interface-update-mnt");
        let script_path = std::env::temp_dir().join("id-interface-updater.sh");
        let log_path = std::env::temp_dir().join("id-interface-updater.log");
        let app_esc = app_bundle.to_string_lossy().replace('\'', "'\\''");
        let dmg_esc = tmp_dmg.to_string_lossy().replace('\'', "'\\''");
        let mnt_esc = mnt_dir.to_string_lossy().replace('\'', "'\\''");
        let script_esc = script_path.to_string_lossy().replace('\'', "'\\''");
        let log_esc = log_path.to_string_lossy().replace('\'', "'\\''");
        let pid = std::process::id();
        let script = format!(
            "#!/bin/sh\n\
             for i in $(seq 1 60); do kill -0 {pid} 2>/dev/null || break; sleep 0.1; done\n\
             rm -rf '{mnt}' '{mnt}-stage'\n\
             mkdir -p '{mnt}' '{mnt}-stage'\n\
             hdiutil attach '{dmg}' -nobrowse -quiet -mountpoint '{mnt}' || exit 1\n\
             NEW_APP=$(find '{mnt}' -maxdepth 2 -name '*.app' | head -n 1)\n\
             if [ -n \"$NEW_APP\" ]; then\n\
               STAGE_APP='{mnt}-stage/iD Interface.app'\n\
               rm -rf '{app}.old'\n\
               if ditto \"$NEW_APP\" \"$STAGE_APP\" && [ -f \"$STAGE_APP/Contents/Info.plist\" ]; then\n\
                 if mv '{app}' '{app}.old'; then\n\
                   if mv \"$STAGE_APP\" '{app}'; then\n\
                     rm -rf '{app}.old'\n\
                     xattr -dr com.apple.quarantine '{app}' 2>/dev/null || true\n\
                     touch '{app}'\n\
                     /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f '{app}' 2>/dev/null || true\n\
                   else\n\
                     mv '{app}.old' '{app}' 2>/dev/null || true\n\
                   fi\n\
                 fi\n\
               fi\n\
             fi\n\
             hdiutil detach '{mnt}' -quiet 2>/dev/null || true\n\
             rm -rf '{mnt}' '{mnt}-stage' '{dmg}'\n\
             sleep 0.4\n\
             open '{app}' || open -n '{app}'\n\
             rm -f '{script}'\n",
            pid = pid,
            mnt = mnt_esc,
            dmg = dmg_esc,
            app = app_esc,
            script = script_esc,
        );

        std::fs::write(&script_path, &script)
            .map_err(|e| format!("Failed to write macOS updater script: {e}"))?;

        let launch_cmd = format!("nohup /bin/sh '{}' >'{}' 2>&1 &", script_esc, log_esc);
        std::process::Command::new("/bin/sh")
            .args(["-c", &launch_cmd])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn macOS updater: {e}"))?;

        tokio::time::sleep(Duration::from_millis(120)).await;
        app.exit(0);
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (portable_url, setup_url, app, state);
        open_external_url(fallback_url).await
    }
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http/https URLs are allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    Ok(())
}

fn generate_peer_id() -> [u8; 6] {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1d20_0001_0001);
    let pid = std::process::id() as u64;
    let mut x = nanos ^ pid.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 31;
    let b = x.to_be_bytes();
    [b[2], b[3], b[4], b[5], b[6], b[7]]
}

fn spawn_mdns_browser(addr_tx: watch::Sender<Option<SocketAddr>>) {
    // On macOS, Apple's mDNSResponder + Local Network privacy often blocks raw multicast
    // sockets or LAN IPs. Probe the local AudientDeviceManager listening TCP port directly
    // via `lsof` and connect over 127.0.0.1 so macOS connects reliably even with Wi-Fi off.
    #[cfg(target_os = "macos")]
    {
        let mac_tx = addr_tx.clone();
        std::thread::spawn(move || {
            let mut last_port: Option<u16> = None;
            loop {
                let mut found: Option<u16> = None;
                if let Ok(out) = std::process::Command::new("lsof")
                    .args(["-nP", "-a", "-c", "AudientDevice", "-iTCP", "-sTCP:LISTEN"])
                    .output()
                {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    for line in stdout.lines().skip(1) {
                        // Look for `*:PORT (LISTEN)` or `127.0.0.1:PORT (LISTEN)`
                        if let Some(listen_part) = line.split_whitespace().rev().nth(1) {
                            if let Some(port_str) = listen_part.rsplit(':').next() {
                                if let Ok(p) = port_str.parse::<u16>() {
                                    if p >= 1024 {
                                        found = Some(p);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(p) = found {
                    if last_port != Some(p) {
                        last_port = Some(p);
                        let _ = mac_tx.send(Some(SocketAddr::new(
                            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                            p,
                        )));
                    }
                } else {
                    last_port = None;
                }
                std::thread::sleep(Duration::from_millis(1200));
            }
        });
    }

    std::thread::spawn(move || {
        let Ok(mdns) = ServiceDaemon::new() else { return };
        let Ok(receiver) = mdns.browse("_adm._tcp.local.") else { return };

        while let Ok(event) = receiver.recv() {
            if let ServiceEvent::ServiceResolved(info) = event {
                // Only connect to AudientDeviceManager (TXT type=Server), never to iD Control clients
                let is_server = info
                    .get_property_val_str("type")
                    .map(|t| t.eq_ignore_ascii_case("Server"))
                    .unwrap_or_else(|| info.get_fullname().starts_with("ADM"));
                if !is_server {
                    continue;
                }

                let port = info.get_port();
                // Prefer 127.0.0.1 on macOS to avoid Local Network firewall blocks on LAN IPs
                #[cfg(target_os = "macos")]
                let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
                #[cfg(not(target_os = "macos"))]
                let ip = info
                    .get_addresses()
                    .iter()
                    .find(|ip| ip.is_ipv4())
                    .copied()
                    .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
                let _ = addr_tx.send(Some(SocketAddr::new(ip, port)));
            }
        }
    });
}

async fn emit_disconnected(app: &AppHandle, store: &Arc<Mutex<AdmStore>>) {
    {
        let mut st = store.lock().await;
        st.connected = false;
        st.root = None;
        st.device_path = None;
    }
    let silent = MeterFrame::silent();
    let _ = app.emit("adm-status", false);
    let _ = app.emit("meter-levels", silent.main_stereo());
    let _ = app.emit("meter-frame", &silent);
}

async fn handle_adm_frame(
    app: &AppHandle,
    store: &Arc<Mutex<AdmStore>>,
    cmd_tx: &mpsc::UnboundedSender<OutboundPropertyChange>,
    frame: &[u8],
) {
    if frame.len() < 17 {
        return;
    }
    match frame[16] {
        0x68 => {
            if let Some(tree) = parse_full_sync_frame(frame) {
                let (snapshot, current_db, restore_cmds) = {
                    let mut st = store.lock().await;
                    st.load_tree(tree);
                    let restore_cmds = st.build_startup_restore_cmds();
                    (st.snapshot(), st.current_db, restore_cmds)
                };
                for cmd in restore_cmds {
                    let _ = cmd_tx.send(cmd);
                }
                let _ = app.emit("volume-changed", current_db);
                if let Some(snap) = snapshot {
                    let _ = app.emit("state-snapshot", &snap);
                }
            }
        }
        0x69 => {
            let changes = parse_diff_frame(frame);
            if changes.is_empty() {
                return;
            }

            let mut param_events: Vec<ParamChangeEvent> = Vec::new();
            let mut auto_cmds: Vec<(Vec<usize>, JuceVar)> = Vec::new();
            let mut scene_toggle: Option<usize> = None;
            let mut hp1_db: Option<f64> = None;
            let mut needs_snapshot = changes.len() > 16;

            let snapshot = {
                let mut st = store.lock().await;
                for change in changes {
                    match change {
                        SyncChange::PropertyChanged { path, prop, value } => {
                            let json_val = value.to_json();
                            if let Some(root) = st.root.as_mut() {
                                if let Some(node) = root.get_path_mut(&path) {
                                    node.props.insert(prop.clone(), value.clone());
                                }
                            }

                            // Intercept physical Function button presses for Custom Studio Actions
                            if prop == "value"
                                && st.custom_fn_mode != CustomFnMode::None
                                && st.fn_active_path.as_ref() == Some(&path)
                            {
                                if let Some(active) = value.as_i64() {
                                    let (cmds, sc) = st.apply_custom_fn_trigger(active != 0);
                                    auto_cmds.extend(cmds);
                                    if sc.is_some() {
                                        scene_toggle = sc;
                                    }
                                }
                            }

                            if path == st.hp1_vol_path && prop == "value" {
                                if let Some(db) = value.as_f64() {
                                    let clamped = db.clamp(-128.0, 0.0);
                                    st.current_db = clamped;
                                    hp1_db = Some(clamped);
                                }
                            }

                            if prop == "value" && st.startup_restored {
                                st.record_engine_setting(&path, &value);
                            }

                            if !needs_snapshot {
                                param_events.push(ParamChangeEvent {
                                    path,
                                    prop,
                                    value: json_val,
                                });
                            }
                        }
                        other => {
                            needs_snapshot = true;
                            if let Some(root) = st.root.as_mut() {
                                apply_sync_change(root, &other);
                            } else if let SyncChange::FullSync(tree) = other {
                                st.load_tree(tree);
                            }
                        }
                    }
                }
                if needs_snapshot {
                    st.snapshot()
                } else {
                    None
                }
            };

            if let Some(snap) = snapshot {
                let _ = app.emit("state-snapshot", &snap);
            } else {
                for ev in param_events {
                    let _ = app.emit("param-changed", &ev);
                }
            }
            if let Some(db) = hp1_db {
                let _ = app.emit("volume-changed", db);
            }
            for (tp, mv) in auto_cmds {
                let json_mv = mv.to_json();
                let _ = cmd_tx.send(OutboundPropertyChange {
                    path: tp.clone(),
                    prop: "value".into(),
                    value: mv,
                });
                let _ = app.emit(
                    "param-changed",
                    &ParamChangeEvent {
                        path: tp,
                        prop: "value".into(),
                        value: json_mv,
                    },
                );
            }
            if let Some(sc_idx) = scene_toggle {
                let _ = app.emit("fn-toggle-scene", sc_idx);
            }
        }
        _ => {}
    }
}

async fn run_direct_usb_session(
    app: &AppHandle,
    mode_rx: &mut watch::Receiver<BackendMode>,
    cmd_rx: &mut mpsc::UnboundedReceiver<OutboundPropertyChange>,
    store: &Arc<Mutex<AdmStore>>,
    backend_info: &Arc<Mutex<BackendInfo>>,
) {
    enum UsbEvent {
        Connected {
            tree: ValueTreeNode,
            device_name: String,
            serial: String,
        },
        ParamUpdated {
            path: Vec<usize>,
            value: JuceVar,
        },
        Meters(MeterFrame),
        Disconnected,
    }

    enum UsbCmd {
        SetParam(Vec<usize>, JuceVar, ValueTreeNode),
        SaveBootState,
        LoadBootState,
    }

    let (usb_cmd_tx, usb_cmd_rx) = std::sync::mpsc::channel::<UsbCmd>();
    let (usb_ev_tx, mut usb_ev_rx) = mpsc::unbounded_channel::<UsbEvent>();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_worker = stop_flag.clone();
    let live_settings = Arc::new(std::sync::Mutex::new(
        store.lock().await.config.direct_usb.clone(),
    ));
    let worker_live_settings = live_settings.clone();

    let worker = std::thread::spawn(move || {
        struct ActiveGuard;
        impl Drop for ActiveGuard {
            fn drop(&mut self) {
                USB_WORKER_ACTIVE.store(false, Ordering::SeqCst);
            }
        }
        USB_WORKER_ACTIVE.store(true, Ordering::SeqCst);
        let _active_guard = ActiveGuard;

        let api = match TusbApi::load() {
            Ok(a) => a,
            Err(_) => {
                let _ = usb_ev_tx.send(UsbEvent::Disconnected);
                return;
            }
        };

        let mut had_disconnected = false;

        while !stop_worker.load(Ordering::Relaxed) && !APP_EXITING.load(Ordering::Relaxed) {
            let Ok(dev) = api.open_first() else {
                had_disconnected = true;
                let _ = usb_ev_tx.send(UsbEvent::Disconnected);
                std::thread::sleep(Duration::from_millis(800));
                continue;
            };

            // On USB hot-plug reconnect, release the handle briefly and let the iD MK3 firmware
            // + Windows Audio endpoints finish initializing before sending vendor control traffic.
            if had_disconnected {
                drop(dev);
                std::thread::sleep(Duration::from_millis(1800));
                if stop_worker.load(Ordering::Relaxed) || APP_EXITING.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(ready_dev) = api.open_first() else {
                    continue;
                };
                let snap_settings = worker_live_settings
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let mut ctx = build_direct_context(&ready_dev, &snap_settings);
                let _ = poll_watched_front_panel(&ready_dev, &mut ctx, true);
                if let Ok(mut g) = worker_live_settings.lock() {
                    g.initialized = true;
                }
                let _ = usb_ev_tx.send(UsbEvent::Connected {
                    tree: ctx.tree.clone(),
                    device_name: ctx.device_name.clone(),
                    serial: ctx.serial.clone(),
                });

                let mut last_event_poll = std::time::Instant::now() - Duration::from_millis(50);
                let mut last_panel_poll = std::time::Instant::now() - Duration::from_millis(80);
                let mut last_meter_poll = std::time::Instant::now() - Duration::from_millis(50);
                let mut err_streak = 0u32;

                while !stop_worker.load(Ordering::Relaxed) && !APP_EXITING.load(Ordering::Relaxed) {
                    let mut latest_tree: Option<ValueTreeNode> = None;
                    let mut batch: BTreeMap<Vec<usize>, JuceVar> = BTreeMap::new();
                    let mut do_save_boot = false;
                    let mut do_load_boot = false;
                    while let Ok(cmd) = usb_cmd_rx.try_recv() {
                        match cmd {
                            UsbCmd::SetParam(path, val, tree_snap) => {
                                batch.insert(path, val);
                                latest_tree = Some(tree_snap);
                            }
                            UsbCmd::SaveBootState => do_save_boot = true,
                            UsbCmd::LoadBootState => do_load_boot = true,
                        }
                    }
                    if let Some(ref tree_snap) = latest_tree {
                        write_param_batch_to_hardware(&ready_dev, &mut ctx, tree_snap, &batch);
                    }
                    if do_save_boot {
                        let _ = save_boot_state(&ready_dev);
                    }
                    if do_load_boot {
                        if load_boot_state(&ready_dev).is_ok() {
                            std::thread::sleep(Duration::from_millis(80));
                            let reload_settings = worker_live_settings
                                .lock()
                                .map(|g| g.clone())
                                .unwrap_or_default();
                            ctx = build_direct_context(&ready_dev, &reload_settings);
                            let _ = usb_ev_tx.send(UsbEvent::Connected {
                                tree: ctx.tree.clone(),
                                device_name: ctx.device_name.clone(),
                                serial: ctx.serial.clone(),
                            });
                        }
                    }

                    let now = std::time::Instant::now();
                    if now.duration_since(last_event_poll) >= Duration::from_millis(16) {
                        last_event_poll = now;
                        match poll_hardware_events(&ready_dev, &mut ctx) {
                            Ok(updates) => {
                                err_streak = 0;
                                for (path, value) in updates {
                                    let _ = usb_ev_tx.send(UsbEvent::ParamUpdated { path, value });
                                }
                            }
                            Err(_) => {
                                err_streak += 1;
                                if err_streak >= 6 {
                                    break;
                                }
                            }
                        }
                    }

                    if now.duration_since(last_panel_poll) >= Duration::from_millis(65) {
                        last_panel_poll = now;
                        if let Ok(updates) = poll_watched_front_panel(&ready_dev, &mut ctx, false) {
                            for (path, value) in updates {
                                let _ = usb_ev_tx.send(UsbEvent::ParamUpdated { path, value });
                            }
                        }
                    }

                    if now.duration_since(last_meter_poll) >= Duration::from_millis(33) {
                        last_meter_poll = now;
                        match poll_hardware_meters(&ready_dev) {
                            Ok(mf) => {
                                err_streak = 0;
                                let _ = usb_ev_tx.send(UsbEvent::Meters(mf));
                            }
                            Err(_) => {
                                err_streak += 1;
                                if err_streak >= 6 {
                                    break;
                                }
                            }
                        }
                    }

                    std::thread::sleep(Duration::from_millis(5));
                }

                had_disconnected = true;
                let _ = usb_ev_tx.send(UsbEvent::Disconnected);
                if !stop_worker.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(800));
                }
                continue;
            }

            let snap_settings = worker_live_settings
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let mut ctx = build_direct_context(&dev, &snap_settings);
            let _ = poll_watched_front_panel(&dev, &mut ctx, true);
            if let Ok(mut g) = worker_live_settings.lock() {
                g.initialized = true;
            }
            let _ = usb_ev_tx.send(UsbEvent::Connected {
                tree: ctx.tree.clone(),
                device_name: ctx.device_name.clone(),
                serial: ctx.serial.clone(),
            });

            let mut last_event_poll = std::time::Instant::now() - Duration::from_millis(50);
            let mut last_panel_poll = std::time::Instant::now() - Duration::from_millis(80);
            let mut last_meter_poll = std::time::Instant::now() - Duration::from_millis(50);
            let mut err_streak = 0u32;

            while !stop_worker.load(Ordering::Relaxed) && !APP_EXITING.load(Ordering::Relaxed) {
                // Drain all queued outbound parameter writes (coalescing duplicates per path)
                let mut latest_tree: Option<ValueTreeNode> = None;
                let mut batch: BTreeMap<Vec<usize>, JuceVar> = BTreeMap::new();
                let mut do_save_boot = false;
                let mut do_load_boot = false;
                while let Ok(cmd) = usb_cmd_rx.try_recv() {
                    match cmd {
                        UsbCmd::SetParam(path, val, tree_snap) => {
                            batch.insert(path, val);
                            latest_tree = Some(tree_snap);
                        }
                        UsbCmd::SaveBootState => do_save_boot = true,
                        UsbCmd::LoadBootState => do_load_boot = true,
                    }
                }
                if let Some(ref tree_snap) = latest_tree {
                    write_param_batch_to_hardware(&dev, &mut ctx, tree_snap, &batch);
                }
                if do_save_boot {
                    let _ = save_boot_state(&dev);
                }
                if do_load_boot {
                    if load_boot_state(&dev).is_ok() {
                        std::thread::sleep(Duration::from_millis(80));
                        let reload_settings = worker_live_settings
                            .lock()
                            .map(|g| g.clone())
                            .unwrap_or_default();
                        ctx = build_direct_context(&dev, &reload_settings);
                        let _ = usb_ev_tx.send(UsbEvent::Connected {
                            tree: ctx.tree.clone(),
                            device_name: ctx.device_name.clone(),
                            serial: ctx.serial.clone(),
                        });
                    }
                }

                let now = std::time::Instant::now();
                if now.duration_since(last_event_poll) >= Duration::from_millis(16) {
                    last_event_poll = now;
                    match poll_hardware_events(&dev, &mut ctx) {
                        Ok(updates) => {
                            err_streak = 0;
                            for (path, value) in updates {
                                let _ = usb_ev_tx.send(UsbEvent::ParamUpdated { path, value });
                            }
                        }
                        Err(_) => {
                            err_streak += 1;
                            if err_streak >= 8 {
                                break;
                            }
                        }
                    }
                }

                if now.duration_since(last_panel_poll) >= Duration::from_millis(65) {
                    last_panel_poll = now;
                    if let Ok(updates) = poll_watched_front_panel(&dev, &mut ctx, false) {
                        for (path, value) in updates {
                            let _ = usb_ev_tx.send(UsbEvent::ParamUpdated { path, value });
                        }
                    }
                }

                if now.duration_since(last_meter_poll) >= Duration::from_millis(33) {
                    last_meter_poll = now;
                    match poll_hardware_meters(&dev) {
                        Ok(mf) => {
                            err_streak = 0;
                            let _ = usb_ev_tx.send(UsbEvent::Meters(mf));
                        }
                        Err(_) => {
                            err_streak += 1;
                            if err_streak >= 8 {
                                break;
                            }
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(5));
            }

            had_disconnected = true;
            let _ = usb_ev_tx.send(UsbEvent::Disconnected);
            if !stop_worker.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(800));
            }
        }
    });

    loop {
        tokio::select! {
            ev = usb_ev_rx.recv() => {
                let Some(ev) = ev else { break };
                match ev {
                    UsbEvent::Connected { tree, device_name, serial } => {
                        let (snapshot, current_db) = {
                            let mut st = store.lock().await;
                            st.connected = true;
                            st.load_tree(tree);
                            if !st.config.direct_usb.initialized {
                                st.config.direct_usb.initialized = true;
                                st.save_current_config();
                            }
                            (st.snapshot(), st.current_db)
                        };
                        let info = {
                            let mut bi = backend_info.lock().await;
                            bi.active_engine = "direct_usb".into();
                            bi.device_name = device_name;
                            bi.serial = serial;
                            bi.clone()
                        };
                        let _ = app.emit("adm-status", true);
                        let _ = app.emit("backend-info", &info);
                        let _ = app.emit("volume-changed", current_db);
                        if let Some(snap) = snapshot {
                            let _ = app.emit("state-snapshot", &snap);
                        }
                    }
                    UsbEvent::ParamUpdated { path, value } => {
                        let json_val = value.to_json();
                        let mut auto_cmds: Vec<(Vec<usize>, JuceVar)> = Vec::new();
                        let mut scene_toggle: Option<usize> = None;
                        let mut dsp_editable_updates: Option<(bool, Vec<Vec<usize>>)> = None;
                        let (hp1_db, tree_snap_for_auto) = {
                            let mut st = store.lock().await;
                            let is_sr = st.sr_path.as_ref() == Some(&path);
                            if let Some(root) = st.root.as_mut() {
                                if let Some(node) = root.get_path_mut(&path) {
                                    node.props.insert("value".into(), value.clone());
                                }
                                if is_sr {
                                    if let Some(sr) = value.as_i64() {
                                        let sr_u32 = sr as u32;
                                        let paths = direct_usb::set_dsp_editable_for_sr(root, sr_u32);
                                        if !paths.is_empty() {
                                            dsp_editable_updates = Some((sr_u32 <= 96000, paths));
                                        }
                                    }
                                }
                            }

                            // Intercept physical Function button (ent=0x04 cs=0x0E -> FnActive)
                            // for both Standard Function modes and Custom Studio Actions
                            if st.fn_active_path.as_ref() == Some(&path) {
                                if let Some(active_raw) = value.as_i64() {
                                    let active = active_raw != 0;
                                    if st.last_fn_active != Some(active) {
                                        st.last_fn_active = Some(active);
                                        if st.custom_fn_mode != CustomFnMode::None {
                                            let (cmds, sc) = st.apply_custom_fn_trigger(active);
                                            auto_cmds.extend(cmds);
                                            scene_toggle = sc;
                                        } else {
                                            let cmds = st.apply_standard_fn_trigger(active);
                                            auto_cmds.extend(cmds);
                                        }
                                    }
                                }
                            }

                            let hp1 = if path == st.hp1_vol_path {
                                value.as_f64().map(|d| {
                                    let c = d.clamp(-128.0, 0.0);
                                    st.current_db = c;
                                    c
                                })
                            } else {
                                None
                            };
                            let snap = if auto_cmds.is_empty() { None } else { st.root.clone() };
                            (hp1, snap)
                        };
                        let _ = app.emit("param-changed", &ParamChangeEvent {
                            path,
                            prop: "value".into(),
                            value: json_val,
                        });
                        if let Some((ed, ed_paths)) = dsp_editable_updates {
                            for ep in ed_paths {
                                let _ = app.emit(
                                    "param-changed",
                                    &ParamChangeEvent {
                                        path: ep,
                                        prop: "editable".into(),
                                        value: serde_json::json!(ed),
                                    },
                                );
                            }
                        }
                        if let Some(db) = hp1_db {
                            let _ = app.emit("volume-changed", db);
                        }
                        if let Some(ref tree_snap) = tree_snap_for_auto {
                            for (tp, mv) in auto_cmds {
                                let json_mv = mv.to_json();
                                let _ = usb_cmd_tx.send(UsbCmd::SetParam(
                                    tp.clone(),
                                    mv,
                                    tree_snap.clone(),
                                ));
                                let _ = app.emit(
                                    "param-changed",
                                    &ParamChangeEvent {
                                        path: tp,
                                        prop: "value".into(),
                                        value: json_mv,
                                    },
                                );
                            }
                        }
                        if let Some(sc_idx) = scene_toggle {
                            let _ = app.emit("fn-toggle-scene", sc_idx);
                        }
                    }
                    UsbEvent::Meters(mf) => {
                        let _ = app.emit("meter-levels", mf.main_stereo());
                        let _ = app.emit("meter-frame", &mf);
                    }
                    UsbEvent::Disconnected => {
                        emit_disconnected(app, store).await;
                    }
                }
            }
            Some(cmd) = cmd_rx.recv() => {
                if cmd.prop == "__hw_save_boot" {
                    let latest = store.lock().await.config.direct_usb.clone();
                    if let Ok(mut g) = live_settings.lock() {
                        *g = latest;
                    }
                    let _ = usb_cmd_tx.send(UsbCmd::SaveBootState);
                } else if cmd.prop == "__hw_load_boot" {
                    let latest = store.lock().await.config.direct_usb.clone();
                    if let Ok(mut g) = live_settings.lock() {
                        *g = latest;
                    }
                    let _ = usb_cmd_tx.send(UsbCmd::LoadBootState);
                } else if cmd.prop == "value" {
                    let (tree_opt, sr_ed_updates, latest_direct) = {
                        let mut st = store.lock().await;
                        let is_sr = st.sr_path.as_ref() == Some(&cmd.path);
                        let ed_upd = if is_sr {
                            cmd.value.as_i64().and_then(|sr| {
                                let sr_u32 = sr as u32;
                                st.root.as_mut().map(|root| {
                                    let paths = direct_usb::set_dsp_editable_for_sr(root, sr_u32);
                                    (sr_u32 <= 96000, paths)
                                })
                            })
                        } else {
                            None
                        };
                        (st.root.clone(), ed_upd, st.config.direct_usb.clone())
                    };
                    if let Ok(mut g) = live_settings.lock() {
                        *g = latest_direct;
                    }
                    if let Some((ed, ed_paths)) = sr_ed_updates {
                        for ep in ed_paths {
                            let _ = app.emit(
                                "param-changed",
                                &ParamChangeEvent {
                                    path: ep,
                                    prop: "editable".into(),
                                    value: serde_json::json!(ed),
                                },
                            );
                        }
                    }
                    if let Some(tree_snap) = tree_opt {
                        let _ = usb_cmd_tx.send(UsbCmd::SetParam(cmd.path, cmd.value, tree_snap));
                    }
                }
            }
            Ok(_) = mode_rx.changed() => {
                if *mode_rx.borrow() != BackendMode::DirectUsb {
                    break;
                }
            }
        }
    }

    stop_flag.store(true, Ordering::Relaxed);
    let _ = tokio::task::spawn_blocking(move || {
        let _ = worker.join();
    })
    .await;
    emit_disconnected(app, store).await;
}

async fn run_adm_session(
    app: &AppHandle,
    addr_rx: &mut watch::Receiver<Option<SocketAddr>>,
    mode_rx: &mut watch::Receiver<BackendMode>,
    cmd_tx: &mpsc::UnboundedSender<OutboundPropertyChange>,
    cmd_rx: &mut mpsc::UnboundedReceiver<OutboundPropertyChange>,
    store: &Arc<Mutex<AdmStore>>,
    backend_info: &Arc<Mutex<BackendInfo>>,
) {
    ensure_audient_device_manager_running();

    let udp_sock = UdpSocket::bind("0.0.0.0:0").await.ok();
    let udp_port = udp_sock
        .as_ref()
        .and_then(|s| s.local_addr().ok())
        .map(|a| a.port());
    let peer_id = generate_peer_id();
    let mut seq: u16 = 1;

    while *mode_rx.borrow() == BackendMode::Adm {
        let target = *addr_rx.borrow();
        let Some(addr) = target else {
            emit_disconnected(app, store).await;
            tokio::select! {
                r = addr_rx.changed() => { if r.is_err() { break; } }
                r = mode_rx.changed() => { if r.is_err() || *mode_rx.borrow() != BackendMode::Adm { break; } }
            }
            continue;
        };

        let loopback = SocketAddr::from(([127, 0, 0, 1], addr.port()));
        let stream = match TcpStream::connect(loopback).await {
            Ok(s) => Ok(s),
            Err(_) => TcpStream::connect(addr).await,
        };

        let Ok(mut stream) = stream else {
            emit_disconnected(app, store).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = mode_rx.changed() => { break; }
            }
            continue;
        };

        let _ = stream.set_nodelay(true);

        let mut handshake = HANDSHAKE;
        if let Some(port) = udp_port {
            handshake[40..42].copy_from_slice(&port.to_be_bytes());
        }
        handshake[44..46].copy_from_slice(&0u16.to_be_bytes());
        handshake[60..66].copy_from_slice(&peer_id);

        if stream.write_all(&handshake).await.is_err() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        store.lock().await.connected = true;
        {
            let mut bi = backend_info.lock().await;
            bi.active_engine = "adm".into();
            let _ = app.emit("backend-info", &*bi);
        }
        let _ = app.emit("adm-status", true);

        let (mut reader, mut writer) = stream.into_split();
        let mut tcp_buf = Vec::with_capacity(262_144);
        let mut chunk = [0u8; 8192];
        let mut udp_buf = [0u8; 2048];

        const MIN_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
        let mut pending: BTreeMap<(Vec<usize>, String), JuceVar> = BTreeMap::new();
        let mut last_flush = Instant::now() - MIN_FLUSH_INTERVAL;
        let flush_sleep = tokio::time::sleep(Duration::from_secs(3600));
        tokio::pin!(flush_sleep);
        let mut flush_armed = false;

        loop {
            tokio::select! {
                read_res = reader.read(&mut chunk) => {
                    match read_res {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            tcp_buf.extend_from_slice(&chunk[..n]);
                            for frame in extract_frames(&mut tcp_buf) {
                                handle_adm_frame(app, store, cmd_tx, &frame).await;
                            }
                        }
                    }
                }
                udp_res = async {
                    match &udp_sock {
                        Some(sock) => sock.recv_from(&mut udp_buf).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Ok((n, _)) = udp_res {
                        if let Some(mf) = parse_meter_packet(&udp_buf[..n]) {
                            let _ = app.emit("meter-levels", mf.main_stereo());
                            let _ = app.emit("meter-frame", &mf);
                        }
                    }
                }
                Some(cmd) = cmd_rx.recv() => {
                    let now = Instant::now();
                    if pending.is_empty() && now.duration_since(last_flush) >= MIN_FLUSH_INTERVAL {
                        let pkt = encode_property_change(&cmd.path, &cmd.prop, &cmd.value, seq);
                        seq = seq.wrapping_add(1);
                        last_flush = now;
                        if writer.write_all(&pkt).await.is_err() {
                            break;
                        }
                    } else {
                        pending.insert((cmd.path, cmd.prop), cmd.value);
                        if !flush_armed {
                            let deadline = last_flush + MIN_FLUSH_INTERVAL;
                            flush_sleep.as_mut().reset(deadline);
                            flush_armed = true;
                        }
                    }
                }
                _ = &mut flush_sleep, if flush_armed => {
                    flush_armed = false;
                    if !pending.is_empty() {
                        let batch = std::mem::take(&mut pending);
                        let mut out = Vec::with_capacity(batch.len() * 80);
                        for ((path, prop), value) in batch {
                            let pkt = encode_property_change(&path, &prop, &value, seq);
                            seq = seq.wrapping_add(1);
                            out.extend_from_slice(&pkt);
                        }
                        last_flush = Instant::now();
                        if writer.write_all(&out).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(_) = addr_rx.changed() => {
                    if *addr_rx.borrow() != Some(addr) {
                        break;
                    }
                }
                Ok(_) = mode_rx.changed() => {
                    if *mode_rx.borrow() != BackendMode::Adm {
                        break;
                    }
                }
            }
        }

        emit_disconnected(app, store).await;
        if *mode_rx.borrow() != BackendMode::Adm {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn run_backend_coordinator(
    app: AppHandle,
    mut addr_rx: watch::Receiver<Option<SocketAddr>>,
    mut mode_rx: watch::Receiver<BackendMode>,
    cmd_tx: mpsc::UnboundedSender<OutboundPropertyChange>,
    mut cmd_rx: mpsc::UnboundedReceiver<OutboundPropertyChange>,
    store: Arc<Mutex<AdmStore>>,
    backend_info: Arc<Mutex<BackendInfo>>,
) {
    loop {
        let mode = *mode_rx.borrow();
        match mode {
            BackendMode::DirectUsb => {
                run_direct_usb_session(&app, &mut mode_rx, &mut cmd_rx, &store, &backend_info).await;
            }
            BackendMode::Adm => {
                run_adm_session(
                    &app,
                    &mut addr_rx,
                    &mut mode_rx,
                    &cmd_tx,
                    &mut cmd_rx,
                    &store,
                    &backend_info,
                )
                .await;
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn find_exe_recursive(dir: &std::path::Path, target_lower: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.eq_ignore_ascii_case(target_lower) {
                    return Some(path);
                }
            }
        } else if path.is_dir() {
            if let Some(found) = find_exe_recursive(&path, target_lower, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn ensure_audient_device_manager_running() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        // Check if AudientDeviceManager.exe is already running (without flashing a console)
        if let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq AudientDeviceManager.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.to_ascii_lowercase().contains("audientdevicemanager.exe") {
                return;
            }
        }

        // Locate AudientDeviceManager.exe across standard Audient install roots
        let mut roots: Vec<PathBuf> = Vec::new();
        for env_key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(env_key) {
                let p = PathBuf::from(&base).join("Audient");
                if p.exists() {
                    roots.push(p);
                }
                let p_prog = PathBuf::from(&base).join("Programs").join("Audient");
                if p_prog.exists() {
                    roots.push(p_prog);
                }
            }
        }

        for root in roots {
            if let Some(exe) = find_exe_recursive(&root, "audientdevicemanager.exe", 4) {
                let mut cmd = std::process::Command::new(&exe);
                if let Some(parent) = exe.parent() {
                    cmd.current_dir(parent);
                }
                let _ = cmd
                    .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
                    .spawn();
                return;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let running = std::process::Command::new("pgrep")
            .args(["-x", "AudientDeviceManager"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if running {
            return;
        }
            let candidates = [
                "/Library/Application Support/Audient/AudientDeviceManager.app/Contents/MacOS/AudientDeviceManager",
                "/Library/Application Support/Audient/iD/AudientDeviceManager.app/Contents/MacOS/AudientDeviceManager",
                "/Library/Application Support/Audient/AudientDeviceManager",
                "/Applications/iD.app/Contents/MacOS/AudientDeviceManager",
                "/Applications/iD.app/Contents/Resources/AudientDeviceManager",
                "/Applications/iD Control.app/Contents/MacOS/AudientDeviceManager",
                "/Applications/iD Control.app/Contents/Resources/AudientDeviceManager",
                "/Applications/Audient/iD.app/Contents/Resources/AudientDeviceManager",
            ];
            for c in candidates {
                let p = PathBuf::from(c);
                if p.exists() {
                    let _ = std::process::Command::new(&p).spawn();
                    return;
                }
            }
            let _ = std::process::Command::new("open")
                .args(["-gj", "-a", "AudientDeviceManager"])
                .spawn();
    }
}

#[cfg(target_os = "macos")]
fn macos_tray_template_icon() -> tauri::image::Image<'static> {
    // 44x44 (@2x Retina = 22pt) monochrome alpha-only silhouette of the iD rotary knob:
    // 270° outer meter arc + inner knob ring + angled indicator line.
    // Marked as a macOS template image (`icon_as_template(true)`), so macOS automatically
    // tints it flat white on Dark Mode menu bars and flat dark on Light Mode menu bars.
    const SIZE: usize = 44;
    let cx = 22.0_f32;
    let cy = 22.5_f32;

    let arc_r = 16.5_f32;
    let arc_hw = 1.85_f32;
    let gap_start = 48.0_f32.to_radians();  // ~4:30 o'clock (screen +y down)
    let gap_end = 132.0_f32.to_radians();   // ~7:30 o'clock
    let cap1_x = cx + arc_r * gap_start.cos();
    let cap1_y = cy + arc_r * gap_start.sin();
    let cap2_x = cx + arc_r * gap_end.cos();
    let cap2_y = cy + arc_r * gap_end.sin();

    let ring_r = 9.4_f32;
    let ring_hw = 1.65_f32;

    // Indicator pointer at -28° (~2 o'clock), matching the iD app icon
    let ptr_ang = (-28.0_f32).to_radians();
    let px0 = cx + 2.2 * ptr_ang.cos();
    let py0 = cy + 2.2 * ptr_ang.sin();
    let px1 = cx + 8.6 * ptr_ang.cos();
    let py1 = cy + 8.6 * ptr_ang.sin();
    let ptr_hw = 1.55_f32;
    let seg_dx = px1 - px0;
    let seg_dy = py1 - py0;
    let seg_len_sq = seg_dx * seg_dx + seg_dy * seg_dy;

    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut hits = 0u32;
            // 4x4 supersampling for crisp Retina anti-aliasing
            for sy in 0..4 {
                let fy = (y as f32) + (sy as f32 + 0.5) * 0.25;
                let dy = fy - cy;
                for sx in 0..4 {
                    let fx = (x as f32) + (sx as f32 + 0.5) * 0.25;
                    let dx = fx - cx;
                    let r = (dx * dx + dy * dy).sqrt();
                    let ang = dy.atan2(dx);

                    // 1. Outer 270° arc with rounded endcaps
                    let on_arc = ((r - arc_r).abs() <= arc_hw && !(ang > gap_start && ang < gap_end))
                        || ((fx - cap1_x).hypot(fy - cap1_y) <= arc_hw)
                        || ((fx - cap2_x).hypot(fy - cap2_y) <= arc_hw);

                    // 2. Inner rotary knob ring
                    let on_ring = (r - ring_r).abs() <= ring_hw;

                    // 3. Rounded indicator pointer inside knob
                    let t = (((fx - px0) * seg_dx + (fy - py0) * seg_dy) / seg_len_sq).clamp(0.0, 1.0);
                    let on_ptr = (fx - (px0 + t * seg_dx)).hypot(fy - (py0 + t * seg_dy)) <= ptr_hw;

                    if on_arc || on_ring || on_ptr {
                        hits += 1;
                    }
                }
            }
            if hits > 0 {
                let alpha = ((hits * 255 + 8) / 16).min(255) as u8;
                let idx = (y * SIZE + x) * 4;
                rgba[idx] = 0;
                rgba[idx + 1] = 0;
                rgba[idx + 2] = 0;
                rgba[idx + 3] = alpha;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (addr_tx, addr_rx) = watch::channel(None);

    spawn_mdns_browser(addr_tx);

    let cmd_tx_loop = cmd_tx.clone();
    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_window(app);
    }));
    builder
        .invoke_handler(tauri::generate_handler![
            get_adm_status,
            get_backend_info,
            get_system_accent,
            get_system_appearance,
            set_backend_mode,
            get_full_state,
            save_hardware_boot_state,
            load_hardware_boot_state,
            set_param,
            set_property,
            set_volume,
            get_volume,
            get_custom_fn_mode,
            set_custom_fn_mode,
            get_ui_prefs,
            save_ui_prefs,
            set_window_size,
            resize_compact_window,
            set_always_on_top,
            minimize_window,
            get_window_state,
            toggle_maximize_window,
            toggle_fullscreen_window,
            hide_to_tray,
            quit_app,
            install_app_update,
            open_external_url,
            get_tray_menu_state,
            hide_tray_menu,
            tray_menu_action
        ])
        .setup(move |app| {
            let config_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| d.join("config.json"));
            let adm_store = AdmStore::new(config_path);
            let direct_ok = is_driver_dll_available();
            let initial_mode = if adm_store.config.backend_mode == BackendMode::DirectUsb && !direct_ok {
                BackendMode::Adm
            } else {
                adm_store.config.backend_mode
            };
            let (mode_tx, mode_rx) = watch::channel(initial_mode);
            let backend_info = Arc::new(Mutex::new(BackendInfo {
                mode: initial_mode,
                active_engine: if initial_mode == BackendMode::DirectUsb {
                    "direct_usb".into()
                } else {
                    "adm".into()
                },
                direct_available: direct_ok,
                device_name: "Audient".into(),
                serial: String::new(),
                platform: std::env::consts::OS.to_string(),
                app_version: env!("CARGO_PKG_VERSION").to_string(),
            }));
            let saved_layout = adm_store.config.window_layout.clone();
            let saved_ui_prefs = adm_store.config.ui_prefs.clone();
            let store = Arc::new(Mutex::new(adm_store));
            app.manage(AppState {
                cmd_tx,
                mode_tx,
                backend_info: backend_info.clone(),
                store: store.clone(),
            });

            if let Some(window) = app.get_webview_window("main") {
                let start_compact = saved_layout.mode.as_deref() == Some("compact");
                CURRENT_WINDOW_IS_FULL.store(!start_compact, Ordering::Relaxed);
                #[cfg(target_os = "windows")]
                win32_sync_dwm_frame(&window, !start_compact);
                #[cfg(target_os = "macos")]
                macos_sync_window_mode(&window, !start_compact);
                let scale = window.scale_factor().unwrap_or(1.0);

                if start_compact {
                    let compact_aspect = 512.0 / 344.0;
                    let pref_w = saved_ui_prefs
                        .get("compactWidth")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(440.0)
                        .clamp(320.0, 640.0);
                    let pref_h = (pref_w / compact_aspect).round();
                    let phys_w = saved_layout
                        .compact
                        .width
                        .map(|v| v as i32)
                        .unwrap_or_else(|| (pref_w * scale).round() as i32)
                        .max((320.0 * scale).round() as i32);
                    let phys_h = saved_layout
                        .compact
                        .height
                        .map(|v| v as i32)
                        .unwrap_or_else(|| (pref_h * scale).round() as i32)
                        .max((215.0 * scale).round() as i32);

                    let _ = window.set_resizable(false);
                    let _ = window.set_min_size(Some(Size::Logical(LogicalSize {
                        width: 320.0,
                        height: (320.0 / compact_aspect).round(),
                    })));
                    let pinned_compact = saved_ui_prefs
                        .get("pinnedCompact")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let _ = window.set_always_on_top(pinned_compact);

                    if let (Some(sx), Some(sy)) = (saved_layout.compact.x, saved_layout.compact.y) {
                        let pos = validate_window_position(&window, sx, sy, phys_w, phys_h);
                        set_window_rect_atomic(&window, pos, phys_w, phys_h);
                    } else {
                        let _ = window.set_size(Size::Logical(LogicalSize {
                            width: pref_w,
                            height: pref_h,
                        }));
                    }
                } else {
                    let pinned_full = saved_ui_prefs
                        .get("pinned")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let _ = window.set_always_on_top(pinned_full);

                    let min_phys_w = (1330.0 * scale).round() as i32;
                    let min_phys_h = (790.0 * scale).round() as i32;
                    if let (Some(sx), Some(sy)) = (saved_layout.full.x, saved_layout.full.y) {
                        let phys_w = saved_layout
                            .full
                            .width
                            .map(|v| (v as i32).max(min_phys_w))
                            .unwrap_or(min_phys_w);
                        let phys_h = saved_layout
                            .full
                            .height
                            .map(|v| (v as i32).max(min_phys_h))
                            .unwrap_or(min_phys_h);
                        let pos = validate_window_position(&window, sx, sy, phys_w, phys_h);
                        set_window_rect_atomic(&window, pos, phys_w, phys_h);
                    }
                    if saved_layout.full.maximized {
                        let _ = window.maximize();
                    }
                }
                WINDOW_LAYOUT_READY.store(true, Ordering::Relaxed);
            }

            let _ = ensure_tray_menu_window(app.handle());

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("iD Interface")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        if let Some(tw) = tray.app_handle().get_webview_window("tray-menu") {
                            let _ = tw.hide();
                        }
                        show_main_window(tray.app_handle());
                    }
                    TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } => {
                        show_tray_menu_at(tray.app_handle(), position);
                    }
                    _ => {}
                });

            #[cfg(target_os = "macos")]
            {
                tray_builder = tray_builder
                    .icon(macos_tray_template_icon())
                    .icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let _ = tray_builder.build(app);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(run_backend_coordinator(
                handle,
                addr_rx,
                mode_rx,
                cmd_tx_loop,
                cmd_rx,
                store,
                backend_info,
            ));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "tray-menu" {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        LAST_TRAY_BLUR_MS.store(now_epoch_ms(), Ordering::Relaxed);
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    if let Some(wv) = window.app_handle().get_webview_window(window.label()) {
                        let _ = emit_window_state_if_changed(&wv, false);
                        schedule_window_layout_save(wv);
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                let pref_key = close_action_pref_key();
                let close_action = {
                    let mut st = state.store.blocking_lock();
                    if let Some(wv) = window.app_handle().get_webview_window(window.label()) {
                        capture_current_window_bounds(&wv, &mut st.config);
                    }
                    st.save_current_config();
                    st.config
                        .ui_prefs
                        .get(pref_key)
                        .or_else(|| {
                            #[cfg(not(target_os = "macos"))]
                            {
                                st.config.ui_prefs.get("closeAction")
                            }
                            #[cfg(target_os = "macos")]
                            {
                                None
                            }
                        })
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                };
                match close_action.as_deref() {
                    Some("tray") => {
                        api.prevent_close();
                        let _ = state.cmd_tx.send(OutboundPropertyChange {
                            path: Vec::new(),
                            prop: "__hw_save_boot".to_string(),
                            value: JuceVar::Int(1),
                        });
                        let _ = window.hide();
                        #[cfg(target_os = "macos")]
                        {
                            let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                        }
                    }
                    Some("quit") => {
                        let _ = state.cmd_tx.send(OutboundPropertyChange {
                            path: Vec::new(),
                            prop: "__hw_save_boot".to_string(),
                            value: JuceVar::Int(1),
                        });
                    }
                    _ => {
                        api.prevent_close();
                        let _ = window.emit("request-close-prompt", ());
                    }
                }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_main_window(app_handle);
                }
                tauri::RunEvent::Exit => {
                    // Wait for the Direct USB worker to finish any in-flight USB control transfer
                    // and release IOKit cleanly (prevents iD2 EP0 kIOReturnNotResponding 0xe00002ed on reopen).
                    wait_for_usb_worker_shutdown();
                }
                _ => {}
            }
            let _ = app_handle;
        });
}
