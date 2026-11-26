// Live two-way synced ValueTree & UDP meter store for AudientDeviceManager

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export function pathKey(path) {
  return path.join(".");
}

class AdmClientStore {
  constructor() {
    this.connected = false;
    this.root = null;
    this.devicePath = null;
    this.vmMap = new Map(); // vmId -> { type, valType, options, range }
    this.paths = {}; // named resolved paths for quick access

    this.meters = {
      analogue: [-128, -128],
      digital: [-128, -128, -128, -128, -128, -128, -128, -128],
      host: [-128, -128, -128, -128, -128, -128],
      reverb: [-128, -128],
      mixbus: [-128, -128, -128, -128, -128, -128, -128, -128],
      room: [-128, -128, -128, -128, -128, -128],
      comp_gr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };

    this._statusSubs = new Set();
    this._snapshotSubs = new Set();
    this._paramSubs = new Set();
    this._meterSubs = new Set();
    this._fnModeSubs = new Set();
    this._prefsSubs = new Set();
    this._mixBusSubs = new Set();
    this.activeMixBus = 0; // 0=Main Mix, 1=Mix A, 2=Mix B, 3=Reverb
    this.customFnMode = "none";
    this.uiPrefs = {};
    this._prefsSaveTimer = null;
    this._lastSent = new Map(); // pathKey -> { value, ts, lastLocalEditMs, timer, pendingVal, pendingPath }
  }

  async init() {
    listen("adm-status", (e) => {
      this.connected = Boolean(e.payload);
      this._statusSubs.forEach((fn) => fn(this.connected));
    });

    listen("state-snapshot", (e) => {
      this._loadSnapshot(e.payload);
    });

    listen("param-changed", (e) => {
      const { path, prop, value } = e.payload;
      if (prop === "value") {
        const slot = this._lastSent.get(pathKey(path));
        // Ignore stale in-flight ADM echoes while the user is actively dragging/editing this param
        if (slot && (slot.timer || performance.now() - slot.lastLocalEditMs < 240)) {
          return;
        }
        if (slot) slot.value = value;
      }
      this._applyLocal(path, prop, value);
      this._paramSubs.forEach((fn) => fn(path, prop, value, false));
    });

    listen("meter-frame", (e) => {
      this.meters = e.payload;
      this._meterSubs.forEach((fn) => fn(this.meters));
    });

    listen("custom-fn-mode", (e) => {
      this.customFnMode = e.payload || "none";
      this._fnModeSubs.forEach((fn) => fn(this.customFnMode));
    });

    const [status, snap, customFn, uiPrefs] = await Promise.all([
      invoke("get_adm_status").catch(() => false),
      invoke("get_full_state").catch(() => null),
      invoke("get_custom_fn_mode").catch(() => "none"),
      invoke("get_ui_prefs").catch(() => ({})),
    ]);

    this.uiPrefs = uiPrefs && typeof uiPrefs === "object" && !Array.isArray(uiPrefs) ? { ...uiPrefs } : {};
    this._prefsSubs.forEach((fn) => fn(this.uiPrefs));
    this.customFnMode = customFn || "none";
    this._fnModeSubs.forEach((fn) => fn(this.customFnMode));
    this.connected = Boolean(status);
    this._statusSubs.forEach((fn) => fn(this.connected));
    if (snap) {
      this._loadSnapshot(snap);
    }
  }

  onUiPrefs(fn) {
    this._prefsSubs.add(fn);
    return () => this._prefsSubs.delete(fn);
  }

  onMixBus(fn) {
    this._mixBusSubs.add(fn);
    return () => this._mixBusSubs.delete(fn);
  }

  setActiveMixBus(busIdx) {
    if (!Number.isInteger(busIdx) || busIdx < 0 || busIdx > 3) return;
    if (this.activeMixBus === busIdx) return;
    this.activeMixBus = busIdx;
    this._mixBusSubs.forEach((fn) => fn(busIdx));
  }

  getUiPref(key, fallback) {
    return this.uiPrefs[key] !== undefined ? this.uiPrefs[key] : fallback;
  }

  saveUiPref(key, value) {
    if (this.uiPrefs[key] === value) return Promise.resolve();
    this.uiPrefs[key] = value;
    return invoke("save_ui_prefs", { prefs: this.uiPrefs }).catch(() => {});
  }

  async flushPendingParams() {
    const sends = [];
    this._lastSent.forEach((slot) => {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
        if (slot.pendingVal !== undefined && slot.pendingVal !== slot.value) {
          const valToSend = slot.pendingVal;
          const pToSend = slot.pendingPath;
          slot.value = valToSend;
          slot.ts = performance.now();
          sends.push(invoke("set_param", { path: pToSend, value: valToSend }).catch(() => {}));
        }
      }
    });
    if (sends.length) await Promise.all(sends);
  }

  onCustomFnMode(fn) {
    this._fnModeSubs.add(fn);
    return () => this._fnModeSubs.delete(fn);
  }

  async setCustomFnMode(mode) {
    this.customFnMode = mode;
    this._fnModeSubs.forEach((fn) => fn(this.customFnMode));
    await invoke("set_custom_fn_mode", { mode });
  }

  onStatus(fn) {
    this._statusSubs.add(fn);
    return () => this._statusSubs.delete(fn);
  }

  onSnapshot(fn) {
    this._snapshotSubs.add(fn);
    return () => this._snapshotSubs.delete(fn);
  }

  onParam(fn) {
    this._paramSubs.add(fn);
    return () => this._paramSubs.delete(fn);
  }

  onMeters(fn) {
    this._meterSubs.add(fn);
    return () => this._meterSubs.delete(fn);
  }

  _loadSnapshot(snap) {
    if (!snap || !snap.root || !snap.devicePath) return;
    this._lastSent.forEach((s) => s.timer && clearTimeout(s.timer));
    this._lastSent.clear();
    this.root = snap.root;
    this.devicePath = snap.devicePath;
    this._indexVMs();
    this._resolveKnownPaths();
    this._snapshotSubs.forEach((fn) => fn(this));
  }

  _applyLocal(path, prop, value) {
    const node = this.getNode(path);
    if (node && node.props) {
      node.props[prop] = value;
    }
  }

  getNode(path) {
    if (!this.root || !path) return null;
    let cur = this.root;
    for (const idx of path) {
      if (!cur.children || idx < 0 || idx >= cur.children.length) return null;
      cur = cur.children[idx];
    }
    return cur;
  }

  getVal(path, fallback = null) {
    const node = this.getNode(path);
    if (!node || !node.props || node.props.value === undefined || node.props.value === null) {
      return fallback;
    }
    return node.props.value;
  }

  isEditable(path) {
    const node = this.getNode(path);
    if (!node || !node.props) return false;
    return node.props.editable !== false;
  }

  getVm(path) {
    const node = this.getNode(path);
    if (!node || !node.props || node.props.key == null) return null;
    return this.vmMap.get(node.props.key) || null;
  }

  getOptionLabel(path, fallback = "") {
    const val = this.getVal(path);
    const vm = this.getVm(path);
    if (vm && vm.options) {
      const hit = vm.options.find((o) => o.value === val);
      if (hit && hit.name) return hit.name;
    }
    return val != null ? String(val) : fallback;
  }

  findChildPath(parentPath, predicate) {
    const parent = this.getNode(parentPath);
    if (!parent || !parent.children) return null;
    const idx = parent.children.findIndex(predicate);
    if (idx === -1) return null;
    return [...parentPath, idx];
  }

  findParamPath(parentPath, paramName) {
    return this.findChildPath(
      parentPath,
      (c) => c.tag === "param" && c.props && c.props.name === paramName
    );
  }

  _indexVMs() {
    this.vmMap.clear();
    const vmsPath = this.findChildPath(this.devicePath, (c) => c.tag === "VMs");
    const vmsNode = this.getNode(vmsPath);
    if (!vmsNode || !vmsNode.children) return;
    for (const vm of vmsNode.children) {
      const id = vm.props?.vmId;
      if (id == null) continue;
      const type = vm.props.type;
      const valType = vm.props.valType;
      if (type === "lookup") {
        const options = (vm.children || []).map((c) => ({
          value: c.props?.value,
          name: c.props?.name ?? String(c.props?.value ?? ""),
        }));
        this.vmMap.set(id, { type, valType, options });
      } else if (type === "range") {
        const r = vm.children?.[0]?.props || {};
        this.vmMap.set(id, { type, valType, range: r });
      }
    }
  }

  _resolveKnownPaths() {
    const p = {};
    const statePath = this.findChildPath(this.devicePath, (c) => c.tag === "State");
    if (!statePath) {
      this.paths = p;
      return;
    }
    p.device = this.devicePath;
    p.state = statePath;

    const sys = this.findChildPath(statePath, (c) => c.tag === "System");
    const dig = this.findChildPath(statePath, (c) => c.tag === "DigitalInputs");
    const inputs = this.findChildPath(statePath, (c) => c.tag === "Inputs");
    const mc = this.findChildPath(statePath, (c) => c.tag === "MonitorControl");
    const routers = this.findChildPath(statePath, (c) => c.tag === "Routers");
    const mixer = this.findChildPath(statePath, (c) => c.tag === "Mixer");
    const outputs = this.findChildPath(statePath, (c) => c.tag === "Outputs");

    p.system = sys;
    p.digitalInputs = dig;
    p.inputs = inputs;
    p.monitorControl = mc;
    p.routers = routers;
    p.mixer = mixer;
    p.outputs = outputs;

    if (sys) {
      p.sampleRate = this.findParamPath(sys, "SR");
      p.bufferSize = this.findParamPath(sys, "BufferSize");
      p.fnKeyMode = this.findParamPath(sys, "FnKeyModeSt");
      p.globalMute = this.findParamPath(sys, "Mute");
      p.fpMtrSrc = this.findParamPath(sys, "FpMtrSrc");
      const clks = this.findChildPath(sys, (c) => c.tag === "ClockSources");
      if (clks) {
        p.clockSource = this.findParamPath(clks, "CurClkSrc");
      }
    }

    if (mc) {
      p.mainVol = this.findParamPath(mc, "Vol");
      p.refVol = this.findParamPath(mc, "RefVol");
      p.setToRef = this.findParamPath(mc, "SetToRef");
      p.volRecall = this.findParamPath(mc, "VolRecall");
      p.dimAtten = this.findParamPath(mc, "DimAtten");
      p.mainMute = this.findParamPath(mc, "Mute");
      p.mono = this.findParamPath(mc, "mono");
      p.midSide = this.findParamPath(mc, "midSide");
      p.dim = this.findParamPath(mc, "Dim");
      p.talkback = this.findParamPath(mc, "Tlkbck");
      p.talkbackSrc = this.findParamPath(mc, "intTlkBckSrc");
      p.monoChnl = this.findParamPath(mc, "MonoChnl");
      p.mainSrc = this.findParamPath(mc, "Src");

      const hp1 = this.findChildPath(mc, (c) => c.tag === "Channel" && c.props?.name === "HP1");
      if (hp1) {
        p.hp1 = hp1;
        p.hp1Src = this.findParamPath(hp1, "Src");
        p.hp1Vol = this.findParamPath(hp1, "Vol");
        p.hp1Mute = this.findParamPath(hp1, "Mute");
      }

      const rc = this.findChildPath(mc, (c) => c.tag === "RoomCorrection");
      if (rc) {
        p.roomCorr = rc;
        p.roomByps = this.findParamPath(rc, "byps");
        p.roomMainByps = this.findParamPath(rc, "MainByps");
        p.roomAltByps = this.findParamPath(rc, "AltByps");
      }
    }

    if (routers) {
      const outRouter = this.findChildPath(
        routers,
        (c) => c.tag === "Router" && c.props?.name === "Output Router"
      );
      if (outRouter) {
        p.outputRouter = outRouter;
        p.speakerSel = this.findParamPath(outRouter, "Src"); // 0 = MAIN, 1 = ALT
      }
      const lbRouter = this.findChildPath(
        routers,
        (c) => c.tag === "Router" && c.props?.name === "Loopback Router"
      );
      if (lbRouter) {
        p.loopbackRouter = lbRouter;
      }
    }

    this.paths = p;
  }

  getDeviceName() {
    const dev = this.getNode(this.devicePath);
    return dev?.props?.name || "";
  }

  // Dynamically inspects the live Audient ValueTree to support iD1, iD2, iD2+, iD4, iD14, iD24, iD44, etc.
  getDeviceTopology() {
    const fullName = this.getDeviceName();
    const shortName = fullName.replace(/\s+MK\d+$/i, "").trim() || "iD2";

    const inputChannels = [];
    let analogCount = 0;
    let digitalCount = 0;

    if (this.paths.inputs) {
      const inputsNode = this.getNode(this.paths.inputs);
      if (inputsNode?.children) {
        const chEntries = [];
        inputsNode.children.forEach((c, idx) => {
          if (c.tag === "Channel") {
            const chPath = [...this.paths.inputs, idx];
            const chIdx = typeof c.props?.index === "number" ? c.props.index : chEntries.length;
            const hasPreamp = Boolean(this.findParamPath(chPath, "G") || this.findParamPath(chPath, "48V"));
            chEntries.push({ chIdx, hasPreamp, name: c.props?.name || "" });
          }
        });
        chEntries.sort((a, b) => a.chIdx - b.chIdx);
        for (const entry of chEntries) {
          if (entry.hasPreamp) {
            analogCount++;
            inputChannels.push({
              index: entry.chIdx,
              isAnalog: true,
              num: analogCount,
              label: `MIC ${analogCount}`,
              longLabel: analogCount === 1 ? "MIC / LINE / INST 1" : `MIC / LINE ${analogCount}`,
            });
          } else {
            digitalCount++;
            inputChannels.push({
              index: entry.chIdx,
              isAnalog: false,
              num: digitalCount,
              label: `DIG ${digitalCount}`,
              longLabel: `DIG ${digitalCount}`,
            });
          }
        }
      }
    }

    // Fallback defaults before ADM connects
    if (inputChannels.length === 0) {
      analogCount = 2;
      digitalCount = 8;
      for (let i = 0; i < 2; i++) {
        inputChannels.push({ index: i, isAnalog: true, num: i + 1, label: `MIC ${i + 1}`, longLabel: i === 0 ? "MIC / LINE / INST 1" : `MIC / LINE ${i + 1}` });
      }
      for (let i = 0; i < 8; i++) {
        inputChannels.push({ index: 2 + i, isAnalog: false, num: i + 1, label: `DIG ${i + 1}`, longLabel: `DIG ${i + 1}` });
      }
    }

    const analogPairs = Math.ceil(analogCount / 2);
    const digitalPairs = Math.ceil(digitalCount / 2);
    const pairs = [];
    let totalMixPairs = analogPairs + digitalPairs + 4; // default: analog + dig + 3 host + 1 reverb
    let bus0Pairs = null;

    if (this.paths.mixer) {
      const bus0Node = this.getNode([...this.paths.mixer, 0]);
      if (bus0Node?.children) {
        bus0Pairs = bus0Node.children.filter((c) => c.tag === "Pair");
        if (bus0Pairs.length > 0) totalMixPairs = bus0Pairs.length;
      }
    }

    let reverbPairIdx = -1;
    let hostIdx = 0;
    let digCursor = 0;
    let anaCursor = 0;

    for (let pIdx = 0; pIdx < totalMixPairs; pIdx++) {
      const nums = [pIdx * 2 + 1, pIdx * 2 + 2];
      const pairNode = bus0Pairs?.[pIdx];
      const ch0Name = pairNode?.children?.find((c) => c.tag === "Channel")?.props?.name || "";
      const looksReverb = /reverb|fx/i.test(ch0Name) || (pIdx === totalMixPairs - 1 && totalMixPairs > analogPairs + digitalPairs + 1);

      if (pIdx < analogPairs) {
        const i0 = inputChannels[anaCursor]?.index ?? anaCursor;
        const i1 = inputChannels[anaCursor + 1]?.index ?? anaCursor + 1;
        pairs.push({
          pairIdx: pIdx,
          nums,
          group: "analogue",
          base: anaCursor,
          isDig: false,
          isAnalog: true,
          isReverb: false,
          accent: "accent-mic",
          tag: `${shortName} · IN`,
          tags: [String(anaCursor + 1), String(anaCursor + 2)],
          inputChs: [i0, i1],
        });
        anaCursor += 2;
      } else if (pIdx < analogPairs + digitalPairs) {
        const i0 = inputChannels[analogCount + digCursor]?.index ?? (analogCount + digCursor);
        const i1 = inputChannels[analogCount + digCursor + 1]?.index ?? (analogCount + digCursor + 1);
        pairs.push({
          pairIdx: pIdx,
          nums,
          group: "digital",
          base: digCursor,
          isDig: true,
          isAnalog: false,
          isReverb: false,
          accent: "accent-dig",
          tag: `${shortName} · DIG`,
          tags: [String(digCursor + 1), String(digCursor + 2)],
          inputChs: [i0, i1],
        });
        digCursor += 2;
      } else if (looksReverb) {
        reverbPairIdx = pIdx;
        pairs.push({
          pairIdx: pIdx,
          nums,
          group: "reverb",
          base: 0,
          isDig: false,
          isAnalog: false,
          isReverb: true,
          accent: "accent-rev",
          tag: `${shortName} · FX`,
          tags: ["L", "R"],
          inputChs: null,
        });
      } else {
        pairs.push({
          pairIdx: pIdx,
          nums,
          group: "host",
          base: hostIdx,
          isDig: false,
          isAnalog: false,
          isReverb: false,
          accent: "accent-out",
          tag: `${shortName} · VIRT`,
          tags: [String(hostIdx + 1), String(hostIdx + 2)],
          inputChs: null,
        });
        hostIdx += 2;
      }
    }

    const reverbChannelId = inputChannels.reduce((m, c) => Math.max(m, c.index), -1) + 1;

    return {
      fullName,
      shortName,
      analogCount,
      digitalCount,
      hasDigital: digitalCount > 0,
      inputChannels,
      pairs,
      reverbPairIdx,
      reverbChannelId,
    };
  }

  async setParam(path, value, opts = null) {
    if (!path) return;
    const k = pathKey(path);
    const prevLocal = this.getVal(path);
    this._applyLocal(path, "value", value);
    if (prevLocal !== value && !(opts && opts.silent)) {
      this._paramSubs.forEach((fn) => fn(path, "value", value, true));
    }

    // Deduplicate & coalesce rapid IPC calls per path (~16ms / 60Hz) so dragging never floods ADM
    const now = performance.now();
    let slot = this._lastSent.get(k);
    if (!slot) {
      slot = { value: undefined, ts: 0, lastLocalEditMs: 0, timer: null, pendingVal: undefined, pendingPath: path };
      this._lastSent.set(k, slot);
    }
    slot.lastLocalEditMs = now;

    if (slot.value === value && !slot.timer) {
      return;
    }

    const elapsed = now - slot.ts;
    if (elapsed >= 16 && !slot.timer) {
      slot.value = value;
      slot.ts = now;
      await invoke("set_param", { path, value });
      return;
    }

    slot.pendingVal = value;
    slot.pendingPath = path;
    if (!slot.timer) {
      const wait = Math.max(4, 16 - elapsed);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (slot.pendingVal !== undefined && slot.pendingVal !== slot.value) {
          const valToSend = slot.pendingVal;
          const pToSend = slot.pendingPath;
          slot.value = valToSend;
          slot.ts = performance.now();
          invoke("set_param", { path: pToSend, value: valToSend }).catch(() => {});
        }
      }, wait);
    }
  }

  async toggleParam(path) {
    if (!path) return;
    const cur = this.getVal(path, 0);
    await this.setParam(path, cur ? 0 : 1);
  }
}

export const store = new AdmClientStore();
