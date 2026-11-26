use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Full-scale reference for ADM linear UDP meter integers (0..65535 = -inf..0 dBFS)
pub const METER_FULL_SCALE: f64 = 65535.0;

pub const FRAME_MAGIC: [u8; 4] = [0x08, 0x27, 0x00, 0x00];

#[derive(Debug, Clone, PartialEq)]
pub enum JuceVar {
    Void,
    Int(i32),
    Bool(bool),
    Double(f64),
    String(String),
    Int64(i64),
    Array(Vec<JuceVar>),
    Binary(Vec<u8>),
    Undefined,
}

impl JuceVar {
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            JuceVar::Void | JuceVar::Undefined => serde_json::Value::Null,
            JuceVar::Int(v) => serde_json::json!(v),
            JuceVar::Bool(v) => serde_json::json!(v),
            JuceVar::Double(v) => {
                if v.is_finite() {
                    serde_json::json!(v)
                } else {
                    serde_json::Value::Null
                }
            }
            JuceVar::String(s) => serde_json::json!(s),
            JuceVar::Int64(v) => serde_json::json!(v),
            JuceVar::Array(arr) => serde_json::Value::Array(arr.iter().map(|x| x.to_json()).collect()),
            JuceVar::Binary(b) => serde_json::json!(format!("<bin {}B>", b.len())),
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JuceVar::Double(v) => Some(*v),
            JuceVar::Int(v) => Some(*v as f64),
            JuceVar::Int64(v) => Some(*v as f64),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            JuceVar::Int(v) => Some(*v as i64),
            JuceVar::Int64(v) => Some(*v),
            JuceVar::Double(v) => Some(*v as i64),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JuceVar::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Coerce a JSON value from the frontend into the matching JuceVar wire type.
    pub fn from_json_with_hint(
        val: &serde_json::Value,
        existing: Option<&JuceVar>,
        vm_val_type: Option<&str>,
    ) -> Result<JuceVar, String> {
        match existing {
            Some(JuceVar::Int(_)) => return json_to_int(val).map(JuceVar::Int),
            Some(JuceVar::Double(_)) => return json_to_f64(val).map(JuceVar::Double),
            Some(JuceVar::Bool(_)) => return json_to_bool(val).map(JuceVar::Bool),
            Some(JuceVar::String(_)) => {
                return val
                    .as_str()
                    .map(|s| JuceVar::String(s.to_string()))
                    .ok_or_else(|| "Expected string value".to_string())
            }
            Some(JuceVar::Int64(_)) => {
                return val
                    .as_i64()
                    .or_else(|| val.as_f64().map(|f| f.round() as i64))
                    .map(JuceVar::Int64)
                    .ok_or_else(|| "Expected integer value".to_string())
            }
            _ => {}
        }

        match vm_val_type {
            Some("int") => return json_to_int(val).map(JuceVar::Int),
            Some("float") | Some("double") => return json_to_f64(val).map(JuceVar::Double),
            Some(s) if s.contains("String") => {
                return val
                    .as_str()
                    .map(|st| JuceVar::String(st.to_string()))
                    .ok_or_else(|| "Expected string value".to_string())
            }
            _ => {}
        }

        // Fallback inference directly from JSON value
        match val {
            serde_json::Value::Bool(b) => Ok(JuceVar::Int(if *b { 1 } else { 0 })),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Ok(JuceVar::Int(i as i32))
                } else if let Some(f) = n.as_f64() {
                    Ok(JuceVar::Double(f))
                } else {
                    Err("Unsupported numeric value".to_string())
                }
            }
            serde_json::Value::String(s) => Ok(JuceVar::String(s.clone())),
            serde_json::Value::Null => Ok(JuceVar::Void),
            _ => Err("Unsupported JSON value type".to_string()),
        }
    }
}

fn json_to_int(val: &serde_json::Value) -> Result<i32, String> {
    if let Some(b) = val.as_bool() {
        Ok(if b { 1 } else { 0 })
    } else if let Some(i) = val.as_i64() {
        Ok(i as i32)
    } else if let Some(f) = val.as_f64() {
        Ok(f.round() as i32)
    } else {
        Err(format!("Expected int value, got {val}"))
    }
}

fn json_to_f64(val: &serde_json::Value) -> Result<f64, String> {
    if let Some(f) = val.as_f64() {
        Ok(f)
    } else if let Some(i) = val.as_i64() {
        Ok(i as f64)
    } else {
        Err(format!("Expected float value, got {val}"))
    }
}

fn json_to_bool(val: &serde_json::Value) -> Result<bool, String> {
    if let Some(b) = val.as_bool() {
        Ok(b)
    } else if let Some(i) = val.as_i64() {
        Ok(i != 0)
    } else {
        Err(format!("Expected bool value, got {val}"))
    }
}

#[derive(Debug, Clone)]
pub struct ValueTreeNode {
    pub tag: String,
    pub props: BTreeMap<String, JuceVar>,
    pub children: Vec<ValueTreeNode>,
}

impl ValueTreeNode {
    pub fn get_path(&self, path: &[usize]) -> Option<&ValueTreeNode> {
        let mut cur = self;
        for &idx in path {
            cur = cur.children.get(idx)?;
        }
        Some(cur)
    }

    pub fn get_path_mut(&mut self, path: &[usize]) -> Option<&mut ValueTreeNode> {
        let mut cur = self;
        for &idx in path {
            cur = cur.children.get_mut(idx)?;
        }
        Some(cur)
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut props_map = serde_json::Map::new();
        for (k, v) in &self.props {
            props_map.insert(k.clone(), v.to_json());
        }
        serde_json::json!({
            "tag": self.tag,
            "props": props_map,
            "children": self.children.iter().map(|c| c.to_json()).collect::<Vec<_>>(),
        })
    }

    /// Locate the first `Device` node under `Node -> Devices` and return its child path `[devices_idx, device_idx]`.
    pub fn find_device_path(&self) -> Option<Vec<usize>> {
        for (di, d) in self.children.iter().enumerate() {
            if d.tag == "Devices" {
                for (ci, c) in d.children.iter().enumerate() {
                    if c.tag == "Device" {
                        return Some(vec![di, ci]);
                    }
                }
            }
        }
        None
    }

    /// Build a map of `vmId -> valType` from `Device -> VMs`.
    pub fn build_vm_types(&self, device_path: &[usize]) -> BTreeMap<i64, String> {
        let mut out = BTreeMap::new();
        let Some(dev) = self.get_path(device_path) else {
            return out;
        };
        let Some(vms) = dev.children.iter().find(|c| c.tag == "VMs") else {
            return out;
        };
        for vm in &vms.children {
            if let (Some(id), Some(vt)) = (
                vm.props.get("vmId").and_then(|v| v.as_i64()),
                vm.props.get("valType").and_then(|v| v.as_str()),
            ) {
                out.insert(id, vt.to_string());
            }
        }
        out
    }

    /// Find the `HP1 -> Vol` path dynamically (defaults to `[0, 1, 3, 3, 16, 1]` on iD2 MK3).
    pub fn find_hp1_vol_path(&self, device_path: &[usize]) -> Option<Vec<usize>> {
        let dev = self.get_path(device_path)?;
        let (state_idx, state) = dev.children.iter().enumerate().find(|(_, c)| c.tag == "State")?;
        let (mc_idx, mc) = state
            .children
            .iter()
            .enumerate()
            .find(|(_, c)| c.tag == "MonitorControl")?;
        let (hp_idx, hp) = mc.children.iter().enumerate().find(|(_, c)| {
            c.tag == "Channel" && c.props.get("name").and_then(|v| v.as_str()) == Some("HP1")
        })?;
        let (vol_idx, _) = hp.children.iter().enumerate().find(|(_, c)| {
            c.tag == "param" && c.props.get("name").and_then(|v| v.as_str()) == Some("Vol")
        })?;
        let mut p = device_path.to_vec();
        p.extend_from_slice(&[state_idx, mc_idx, hp_idx, vol_idx]);
        Some(p)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamChangeEvent {
    pub path: Vec<usize>,
    pub prop: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeterFrame {
    pub analogue: Vec<f64>,
    pub digital: Vec<f64>,
    pub host: Vec<f64>,
    pub reverb: Vec<f64>,
    pub mixbus: Vec<f64>,
    pub room: Vec<f64>,
    pub comp_gr: Vec<f64>,
}

impl MeterFrame {
    pub fn silent() -> Self {
        Self {
            analogue: vec![-128.0; 2],
            digital: vec![-128.0; 8],
            host: vec![-128.0; 6],
            reverb: vec![-128.0; 2],
            mixbus: vec![-128.0; 8],
            room: vec![-128.0; 6],
            comp_gr: vec![0.0; 10],
        }
    }

    pub fn main_stereo(&self) -> [f64; 2] {
        if self.room.len() >= 2 {
            [self.room[0], self.room[1]]
        } else if self.mixbus.len() >= 2 {
            [self.mixbus[0], self.mixbus[1]]
        } else if self.host.len() >= 2 {
            [self.host[0], self.host[1]]
        } else {
            [-128.0, -128.0]
        }
    }
}

// --- Binary Reader ---

struct BinReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinReader<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let b = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn read_cstring(&mut self) -> Option<String> {
        let rel_end = self.data.get(self.pos..)?.iter().position(|&b| b == 0)?;
        let s = String::from_utf8_lossy(&self.data[self.pos..self.pos + rel_end]).into_owned();
        self.pos += rel_end + 1;
        Some(s)
    }

    fn read_compressed_int(&mut self) -> Option<usize> {
        let n = self.read_u8()? as usize;
        if n > 4 || self.pos + n > self.data.len() {
            return None;
        }
        let mut val: usize = 0;
        for i in 0..n {
            val |= (self.data[self.pos + i] as usize) << (8 * i);
        }
        self.pos += n;
        Some(val)
    }

    fn read_var(&mut self) -> Option<JuceVar> {
        let len = self.read_compressed_int()?;
        if len == 0 {
            return Some(JuceVar::Void);
        }
        if self.pos + len > self.data.len() {
            return None;
        }
        let end = self.pos + len;
        let tag = self.read_u8()?;
        let val = match tag {
            1 => {
                let bytes: [u8; 4] = self.data.get(self.pos..self.pos + 4)?.try_into().ok()?;
                JuceVar::Int(i32::from_le_bytes(bytes))
            }
            2 => JuceVar::Bool(true),
            3 => JuceVar::Bool(false),
            4 => {
                let bytes: [u8; 8] = self.data.get(self.pos..self.pos + 8)?.try_into().ok()?;
                JuceVar::Double(f64::from_le_bytes(bytes))
            }
            5 => JuceVar::String(self.read_cstring()?),
            6 => {
                let bytes: [u8; 8] = self.data.get(self.pos..self.pos + 8)?.try_into().ok()?;
                JuceVar::Int64(i64::from_le_bytes(bytes))
            }
            7 => {
                let cnt = self.read_compressed_int()?;
                let mut items = Vec::with_capacity(cnt.min(256));
                for _ in 0..cnt {
                    items.push(self.read_var()?);
                }
                JuceVar::Array(items)
            }
            8 => JuceVar::Binary(self.data[self.pos..end].to_vec()),
            9 => JuceVar::Undefined,
            _ => JuceVar::Binary(self.data[self.pos..end].to_vec()),
        };
        self.pos = end;
        Some(val)
    }

    fn read_path(&mut self) -> Option<Vec<usize>> {
        let depth = self.read_compressed_int()?;
        if depth > 64 {
            return None;
        }
        let mut path = Vec::with_capacity(depth);
        for _ in 0..depth {
            path.push(self.read_compressed_int()?);
        }
        Some(path)
    }

    fn read_valuetree(&mut self, depth: usize) -> Option<ValueTreeNode> {
        if depth > 32 {
            return None;
        }
        let tag = self.read_cstring()?;
        let num_props = self.read_compressed_int()?;
        let mut props = BTreeMap::new();
        for _ in 0..num_props {
            let k = self.read_cstring()?;
            let v = self.read_var()?;
            props.insert(k, v);
        }
        let num_children = self.read_compressed_int()?;
        let mut children = Vec::with_capacity(num_children.min(256));
        for _ in 0..num_children {
            children.push(self.read_valuetree(depth + 1)?);
        }
        Some(ValueTreeNode {
            tag,
            props,
            children,
        })
    }
}

// --- Binary Writer ---

fn write_compressed_int(out: &mut Vec<u8>, val: usize) {
    if val == 0 {
        out.push(0);
    } else if val <= 0xFF {
        out.push(1);
        out.push(val as u8);
    } else if val <= 0xFFFF {
        out.push(2);
        out.extend_from_slice(&(val as u16).to_le_bytes());
    } else if val <= 0xFF_FFFF {
        out.push(3);
        let b = (val as u32).to_le_bytes();
        out.extend_from_slice(&b[..3]);
    } else {
        out.push(4);
        out.extend_from_slice(&(val as u32).to_le_bytes());
    }
}

fn write_var(out: &mut Vec<u8>, var: &JuceVar) {
    match var {
        JuceVar::Void => write_compressed_int(out, 0),
        JuceVar::Int(v) => {
            write_compressed_int(out, 5);
            out.push(1);
            out.extend_from_slice(&v.to_le_bytes());
        }
        JuceVar::Bool(true) => {
            write_compressed_int(out, 1);
            out.push(2);
        }
        JuceVar::Bool(false) => {
            write_compressed_int(out, 1);
            out.push(3);
        }
        JuceVar::Double(v) => {
            write_compressed_int(out, 9);
            out.push(4);
            out.extend_from_slice(&v.to_le_bytes());
        }
        JuceVar::String(s) => {
            let bytes = s.as_bytes();
            write_compressed_int(out, 1 + bytes.len() + 1);
            out.push(5);
            out.extend_from_slice(bytes);
            out.push(0);
        }
        JuceVar::Int64(v) => {
            write_compressed_int(out, 9);
            out.push(6);
            out.extend_from_slice(&v.to_le_bytes());
        }
        JuceVar::Undefined => {
            write_compressed_int(out, 1);
            out.push(9);
        }
        JuceVar::Binary(b) => {
            write_compressed_int(out, 1 + b.len());
            out.push(8);
            out.extend_from_slice(b);
        }
        JuceVar::Array(arr) => {
            let mut inner = Vec::new();
            inner.push(7);
            write_compressed_int(&mut inner, arr.len());
            for item in arr {
                write_var(&mut inner, item);
            }
            write_compressed_int(out, inner.len());
            out.extend_from_slice(&inner);
        }
    }
}

// --- ADM Frame Framing & Diffs ---

/// Extract complete ADM TCP frames (`08 27 00 00 <len_le_u32> ...`) from a rolling byte buffer.
pub fn extract_frames(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut pos = 0usize;

    while pos + 8 <= buf.len() {
        let Some(rel) = buf[pos..].windows(4).position(|w| w == FRAME_MAGIC) else {
            // Keep trailing 3 bytes in case magic is split across reads
            let keep = buf.len().saturating_sub(3);
            pos = keep;
            break;
        };
        let start = pos + rel;
        if start + 8 > buf.len() {
            pos = start;
            break;
        }
        let plen = u32::from_le_bytes([
            buf[start + 4],
            buf[start + 5],
            buf[start + 6],
            buf[start + 7],
        ]) as usize;

        // Sanity guard against corrupted length
        if plen > 16 * 1024 * 1024 {
            pos = start + 4;
            continue;
        }

        let total = 8 + plen;
        if start + total > buf.len() {
            pos = start;
            break;
        }
        frames.push(buf[start..start + total].to_vec());
        pos = start + total;
    }

    if pos > 0 {
        buf.drain(..pos);
    }
    frames
}

/// Parse an ADM `0x68` full-sync frame into a `ValueTreeNode`.
pub fn parse_full_sync_frame(frame: &[u8]) -> Option<ValueTreeNode> {
    if frame.len() < 46 || frame[16] != 0x68 {
        return None;
    }
    let mut reader = BinReader::new(frame, 42);
    reader.read_valuetree(0)
}

#[derive(Debug, Clone)]
pub enum SyncChange {
    PropertyChanged {
        path: Vec<usize>,
        prop: String,
        value: JuceVar,
    },
    PropertyRemoved {
        path: Vec<usize>,
        prop: String,
    },
    ChildAdded {
        parent_path: Vec<usize>,
        index: usize,
        child: ValueTreeNode,
    },
    ChildRemoved {
        parent_path: Vec<usize>,
        index: usize,
    },
    ChildMoved {
        parent_path: Vec<usize>,
        old_index: usize,
        new_index: usize,
    },
    FullSync(ValueTreeNode),
}

/// Parse an ADM `0x69` incremental ValueTreeSynchroniser diff frame.
/// ADM packs multiple sequential ValueTreeSynchroniser operations back-to-back
/// inside a single `0x69` frame (for example, ~350 `editable` updates when changing sample rate).
pub fn parse_diff_frame(frame: &[u8]) -> Vec<SyncChange> {
    let mut changes = Vec::new();
    if frame.len() < 44 || frame[16] != 0x69 {
        return changes;
    }
    let payload_len = u32::from_be_bytes([frame[38], frame[39], frame[40], frame[41]]) as usize;
    let end = (42 + payload_len).min(frame.len());
    let mut reader = BinReader::new(&frame[..end], 42);
    while reader.pos < end {
        let Some(opcode) = reader.read_u8() else {
            break;
        };
        let parsed = match opcode {
            1 => (|| {
                let path = reader.read_path()?;
                let prop = reader.read_cstring()?;
                let value = reader.read_var()?;
                Some(SyncChange::PropertyChanged { path, prop, value })
            })(),
            2 => reader.read_valuetree(0).map(SyncChange::FullSync),
            3 => (|| {
                let parent_path = reader.read_path()?;
                let index = reader.read_compressed_int()?;
                let child = reader.read_valuetree(0)?;
                Some(SyncChange::ChildAdded {
                    parent_path,
                    index,
                    child,
                })
            })(),
            4 => (|| {
                let parent_path = reader.read_path()?;
                let index = reader.read_compressed_int()?;
                Some(SyncChange::ChildRemoved { parent_path, index })
            })(),
            5 => (|| {
                let parent_path = reader.read_path()?;
                let old_index = reader.read_compressed_int()?;
                let new_index = reader.read_compressed_int()?;
                Some(SyncChange::ChildMoved {
                    parent_path,
                    old_index,
                    new_index,
                })
            })(),
            6 => (|| {
                let path = reader.read_path()?;
                let prop = reader.read_cstring()?;
                Some(SyncChange::PropertyRemoved { path, prop })
            })(),
            _ => None,
        };
        match parsed {
            Some(change) => changes.push(change),
            None => break,
        }
    }
    changes
}

/// Apply a parsed `SyncChange` onto our local `ValueTreeNode`.
pub fn apply_sync_change(root: &mut ValueTreeNode, change: &SyncChange) {
    match change {
        SyncChange::PropertyChanged { path, prop, value } => {
            if let Some(node) = root.get_path_mut(path) {
                node.props.insert(prop.clone(), value.clone());
            }
        }
        SyncChange::PropertyRemoved { path, prop } => {
            if let Some(node) = root.get_path_mut(path) {
                node.props.remove(prop);
            }
        }
        SyncChange::ChildAdded {
            parent_path,
            index,
            child,
        } => {
            if let Some(parent) = root.get_path_mut(parent_path) {
                let idx = (*index).min(parent.children.len());
                parent.children.insert(idx, child.clone());
            }
        }
        SyncChange::ChildRemoved { parent_path, index } => {
            if let Some(parent) = root.get_path_mut(parent_path) {
                if *index < parent.children.len() {
                    parent.children.remove(*index);
                }
            }
        }
        SyncChange::ChildMoved {
            parent_path,
            old_index,
            new_index,
        } => {
            if let Some(parent) = root.get_path_mut(parent_path) {
                if *old_index < parent.children.len() {
                    let item = parent.children.remove(*old_index);
                    let dst = (*new_index).min(parent.children.len());
                    parent.children.insert(dst, item);
                }
            }
        }
        SyncChange::FullSync(new_root) => {
            *root = new_root.clone();
        }
    }
}

/// Encode a universal ADM `0x69` property-change packet for any ValueTree path and property.
pub fn encode_property_change(path: &[usize], prop: &str, value: &JuceVar, seq: u16) -> Vec<u8> {
    let mut diff = Vec::with_capacity(48);
    diff.push(1); // opcode 1 = propertyChanged
    write_compressed_int(&mut diff, path.len());
    for &idx in path {
        write_compressed_int(&mut diff, idx);
    }
    diff.extend_from_slice(prop.as_bytes());
    diff.push(0);
    write_var(&mut diff, value);

    let total_len = 42 + diff.len();
    let payload_len = (total_len - 8) as u32;
    let inner_len = (total_len - 16) as u32;

    let mut pkt = Vec::with_capacity(total_len);
    pkt.extend_from_slice(&FRAME_MAGIC);
    pkt.extend_from_slice(&payload_len.to_le_bytes());
    pkt.extend_from_slice(&inner_len.to_be_bytes());
    pkt.extend_from_slice(&[0x00, 0x00, 0x27, 0x08]);
    pkt.extend_from_slice(&[0x69, 0x00, 0x00, 0x00, 0x01, 0x69, 0x00, 0x00]);
    pkt.extend_from_slice(&seq.to_be_bytes());
    pkt.extend_from_slice(&[0u8; 12]);
    pkt.extend_from_slice(&(diff.len() as u32).to_be_bytes());
    pkt.extend_from_slice(&diff);
    pkt
}

// --- UDP Meter Packet Decoder (All 7 Meter Groups) ---

fn linear_to_dbfs(val: u32) -> f64 {
    if val == 0 {
        return -128.0;
    }
    (20.0 * (val as f64 / METER_FULL_SCALE).log10()).clamp(-128.0, 0.0)
}

/// Compressor GR arrives as 0xFFFF (65535) for 0 dB GR, scaling linearly downward on attenuation.
fn gr_to_db(val: u32) -> f64 {
    if val >= 65535 {
        return 0.0;
    }
    if val == 0 {
        return -30.0;
    }
    (20.0 * (val as f64 / METER_FULL_SCALE).log10()).clamp(-30.0, 0.0)
}

pub fn parse_meter_packet(buf: &[u8]) -> Option<MeterFrame> {
    if buf.len() < 42 || buf[..6] != [0x6b, 0x00, 0x00, 0x00, 0x01, 0x6b] {
        return None;
    }

    let n_blocks = u32::from_be_bytes(buf[34..38].try_into().ok()?) as usize;
    if n_blocks == 0 || n_blocks > 32 {
        return None;
    }

    let mut pos = 38usize;
    let mut blocks: Vec<Vec<u32>> = Vec::with_capacity(n_blocks);

    for _ in 0..n_blocks {
        if pos + 4 > buf.len() {
            return None;
        }
        let blen = u32::from_be_bytes(buf[pos..pos + 4].try_into().ok()?) as usize;
        pos += 4;
        if pos + blen > buf.len() || blen < 5 {
            return None;
        }
        let b = &buf[pos..pos + blen];
        pos += blen;

        if b[2] != 0x07 {
            blocks.push(Vec::new());
            continue;
        }

        let cnt = b[4] as usize;
        let mut vals = Vec::with_capacity(cnt);
        let mut vp = 5usize;
        for _ in 0..cnt {
            if vp + 7 > b.len() {
                break;
            }
            if b[vp..vp + 3] == [0x01, 0x05, 0x01] {
                let v = u32::from_le_bytes(b[vp + 3..vp + 7].try_into().ok()?);
                vals.push(v);
            }
            vp += 7;
        }
        blocks.push(vals);
    }

    let to_db = |idx: usize| -> Vec<f64> {
        blocks
            .get(idx)
            .map(|v| v.iter().map(|&x| linear_to_dbfs(x)).collect())
            .unwrap_or_default()
    };

    let comp_gr = blocks
        .get(6)
        .map(|v| v.iter().map(|&x| gr_to_db(x)).collect())
        .unwrap_or_default();

    Some(MeterFrame {
        analogue: to_db(0),
        digital: to_db(1),
        host: to_db(2),
        reverb: to_db(3),
        mixbus: to_db(4),
        room: to_db(5),
        comp_gr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_hp1_volume_matches_known_packet_byte_for_byte() {
        const KNOWN_PREFIX: [u8; 65] = [
            0x08, 0x27, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x39, 0x00, 0x00,
            0x27, 0x08, 0x69, 0x00, 0x00, 0x00, 0x01, 0x69, 0x00, 0x00, 0x00, 0x19, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
            0x01, 0x01, 0x06, 0x00, 0x01, 0x01, 0x01, 0x03, 0x01, 0x03, 0x01, 0x10, 0x01, 0x01,
            0x76, 0x61, 0x6c, 0x75, 0x65, 0x00, 0x01, 0x09, 0x04,
        ];
        let db = -35.0_f64;
        let pkt = encode_property_change(&[0, 1, 3, 3, 16, 1], "value", &JuceVar::Double(db), 0x0019);
        assert_eq!(pkt.len(), 73);
        assert_eq!(&pkt[..65], &KNOWN_PREFIX);
        assert_eq!(&pkt[65..], &db.to_le_bytes());

        // Round-trip parse the encoded diff frame
        let parsed = parse_diff_frame(&pkt);
        assert_eq!(parsed.len(), 1);
        match &parsed[0] {
            SyncChange::PropertyChanged { path, prop, value } => {
                assert_eq!(path, &vec![0, 1, 3, 3, 16, 1]);
                assert_eq!(prop, "value");
                assert_eq!(value, &JuceVar::Double(db));
            }
            other => panic!("Unexpected diff: {other:?}"),
        }
    }

    #[test]
    fn roundtrip_int_and_string_property_changes() {
        let pkt_int = encode_property_change(&[0, 1, 3, 2, 1, 9], "value", &JuceVar::Int(1), 42);
        let parsed_int = parse_diff_frame(&pkt_int);
        assert_eq!(parsed_int.len(), 1);
        match &parsed_int[0] {
            SyncChange::PropertyChanged { path, prop, value } => {
                assert_eq!(path, &vec![0, 1, 3, 2, 1, 9]);
                assert_eq!(prop, "value");
                assert_eq!(value, &JuceVar::Int(1));
            }
            _ => panic!("expected PropertyChanged"),
        }

        let pkt_str = encode_property_change(
            &[0, 1, 3, 5, 4, 0, 0],
            "value",
            &JuceVar::String("Vocal".to_string()),
            43,
        );
        let parsed_str = parse_diff_frame(&pkt_str);
        assert_eq!(parsed_str.len(), 1);
        match &parsed_str[0] {
            SyncChange::PropertyChanged { path, prop, value } => {
                assert_eq!(path, &vec![0, 1, 3, 5, 4, 0, 0]);
                assert_eq!(prop, "value");
                assert_eq!(value, &JuceVar::String("Vocal".to_string()));
            }
            _ => panic!("expected PropertyChanged"),
        }
    }

    #[test]
    fn parses_batched_multi_op_diff_frame() {
        let p1 = encode_property_change(&[0, 1, 3, 2, 1, 4], "editable", &JuceVar::Bool(true), 1);
        let p2 = encode_property_change(&[0, 1, 3, 2, 1, 16, 1], "editable", &JuceVar::Bool(true), 2);
        let p3 = encode_property_change(&[0, 1, 3, 2, 1, 16, 2, 2], "value", &JuceVar::Double(3.5), 3);

        let mut combined_diff = Vec::new();
        combined_diff.extend_from_slice(&p1[42..]);
        combined_diff.extend_from_slice(&p2[42..]);
        combined_diff.extend_from_slice(&p3[42..]);

        let total_len = 42 + combined_diff.len();
        let mut frame = Vec::with_capacity(total_len);
        frame.extend_from_slice(&FRAME_MAGIC);
        frame.extend_from_slice(&((total_len - 8) as u32).to_le_bytes());
        frame.extend_from_slice(&((total_len - 16) as u32).to_be_bytes());
        frame.extend_from_slice(&[0x00, 0x00, 0x27, 0x08]);
        frame.extend_from_slice(&[0x69, 0x00, 0x00, 0x00, 0x01, 0x69, 0x00, 0x00]);
        frame.extend_from_slice(&[0x00, 0x01]);
        frame.extend_from_slice(&[0u8; 12]);
        frame.extend_from_slice(&(combined_diff.len() as u32).to_be_bytes());
        frame.extend_from_slice(&combined_diff);

        let parsed = parse_diff_frame(&frame);
        assert_eq!(parsed.len(), 3);
        assert!(matches!(
            &parsed[1],
            SyncChange::PropertyChanged { path, prop, value: JuceVar::Bool(true) }
            if path == &vec![0, 1, 3, 2, 1, 16, 1] && prop == "editable"
        ));
        assert!(matches!(
            &parsed[2],
            SyncChange::PropertyChanged { path, prop, value: JuceVar::Double(v) }
            if path == &vec![0, 1, 3, 2, 1, 16, 2, 2] && prop == "value" && (*v - 3.5).abs() < 1e-9
        ));
    }
}
