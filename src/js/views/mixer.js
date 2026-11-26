// Full 4-Bus Software Mixer (Main Mix, Mix A, Mix B, Reverb)
// + Zero-Scroll Smart Channel Inspector Deck (INPUT, V-PHASE, V-HPF, TONE [GLOW/LIFT/ORBIT],
//   EQ, COMPRESSOR, RECORD FX, REVERB SEND) + Color-Coded Stereo/Mono Strips

import { createKnob } from "../components/knob.js";
import { createStereoMeter, createMonoMeter } from "../components/meter.js";
import { pathKey } from "../store.js";

const FADER_MIN = -128.0;
const FADER_MAX = 6.0;

const INF_SVG = `<svg class="inf-icon" viewBox="0 0 18 10" aria-hidden="true"><path d="M5.1 1.7C3.1 1.7 1.7 3.1 1.7 5s1.4 3.3 3.4 3.3c2.1 0 3.2-2 3.9-3.3.7-1.3 1.8-3.3 3.9-3.3 2 0 3.4 1.4 3.4 3.3s-1.4 3.3-3.4 3.3c-2.1 0-3.2-2-3.9-3.3C8.3 3.7 7.2 1.7 5.1 1.7Z" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Exact Audient iD Control piecewise-linear fader taper & scale marks (no double-minus)
const FADER_TICKS = [
  { db: 6, norm: 1.0, label: "+6" },
  { db: 0, norm: 0.77, label: "0" },
  { db: -5, norm: 0.6, label: "5" },
  { db: -10, norm: 0.49, label: "10" },
  { db: -15, norm: 0.39, label: "15" },
  { db: -20, norm: 0.3, label: "20" },
  { db: -30, norm: 0.21, label: "30" },
  { db: -40, norm: 0.13, label: "40" },
  { db: -50, norm: 0.065, label: "50" },
  { db: -128, norm: 0.0, label: INF_SVG },
];

const IMP_OPTIONS = [
  { value: 0, name: "PUNCH", cls: "orbit-punch" },
  { value: 1, name: "SMOOTH", cls: "orbit-smooth" },
  { value: 3, name: "VINTAGE", cls: "orbit-vintage" },
];

const EQ_TYPES = [
  { value: 8, name: "PEAK" },
  { value: 5, name: "LOW SHELF" },
  { value: 7, name: "HIGH SHELF" },
  { value: 3, name: "HIGH PASS" },
  { value: 1, name: "LOW PASS" },
  { value: 11, name: "BYPASS" },
];

const EQ_BAND_COLORS = ["#93c5fd", "#2dd4bf", "#f5b83d", "#b18aff"];

const EQ_DEFAULT_BANDS = [
  { t: 5, f: 25, g: 0.0, q: 0.71 },
  { t: 8, f: 500, g: 0.0, q: 2.0 },
  { t: 8, f: 2000, g: 0.0, q: 2.0 },
  { t: 7, f: 12800, g: 0.0, q: 0.71 },
];

const COMP_DEFAULTS = {
  Threshold: 0.0,
  Ratio: 2.0,
  Attack: 10.0,
  Release: 100.0,
  Makeup: 0.0,
  Blend: 1.0,
};

function evalEqBandDb(freq, b) {
  if (b.type === 11 || b.type === 13) return 0;
  if (b.type === 14) return -24;
  const f0 = Math.max(20, b.freq || 1000);
  const q = Math.max(0.5, b.q || 1.0);
  const g = b.gain || 0;
  const ratio = freq / f0;
  const logDist = Math.log2(ratio);
  if (b.type === 8) {
    const bw = 1 / q;
    return g * Math.exp(-0.5 * Math.pow(logDist / (bw * 0.55), 2));
  }
  if (b.type === 5) return g / (1 + Math.pow(ratio, 2 * Math.min(2, q)));
  if (b.type === 7) return g / (1 + Math.pow(1 / ratio, 2 * Math.min(2, q)));
  if (b.type === 3) return Math.max(-18, 20 * Math.log10(1 / Math.sqrt(1 + Math.pow(1 / ratio, 4))));
  if (b.type === 1) return Math.max(-18, 20 * Math.log10(1 / Math.sqrt(1 + Math.pow(ratio, 4))));
  return 0;
}

function fmtFreqShort(hz) {
  const f = Math.round(hz);
  if (f >= 10000) return `${(f / 1000).toFixed(0)}k`;
  if (f >= 1000) return `${(f / 1000).toFixed(1)}k`;
  return String(f);
}

function dbToFaderNorm(db) {
  if (db <= FADER_MIN) return 0;
  if (db >= FADER_MAX) return 1;
  for (let i = 0; i < FADER_TICKS.length - 1; i++) {
    const hi = FADER_TICKS[i];
    const lo = FADER_TICKS[i + 1];
    if (db <= hi.db && db >= lo.db) {
      const frac = (db - lo.db) / (hi.db - lo.db);
      return lo.norm + frac * (hi.norm - lo.norm);
    }
  }
  return 0;
}

function faderNormToDb(norm) {
  const n = Math.max(0, Math.min(1, norm));
  if (n <= 0.002) return FADER_MIN;
  if (n >= 0.998) return FADER_MAX;
  for (let i = 0; i < FADER_TICKS.length - 1; i++) {
    const hi = FADER_TICKS[i];
    const lo = FADER_TICKS[i + 1];
    if (n <= hi.norm && n >= lo.norm) {
      const frac = (n - lo.norm) / (hi.norm - lo.norm);
      return lo.db + frac * (hi.db - lo.db);
    }
  }
  return FADER_MIN;
}

function createFader(container, opts = {}) {
  const onChange = opts.onChange ?? (() => {});
  let currentDb = Math.round(opts.defaultValue ?? 0);
  let isDragging = false;
  let isScrolling = false;
  let scrollTimer = null;
  let lastInteractMs = 0;

  const wrap = document.createElement("div");
  wrap.className = "fader-widget";
  wrap.innerHTML = `
    <div class="fader-track-area">
      <div class="fader-rail">
        <div class="fader-slot">
          <div class="fader-fill"></div>
        </div>
        <div class="fader-thumb">
          <div class="fader-thumb-ridge"></div>
          <div class="fader-thumb-line"></div>
          <div class="fader-thumb-ridge"></div>
        </div>
      </div>
    </div>
    <div class="fader-scale"></div>
  `;
  container.appendChild(wrap);

  const trackArea = wrap.querySelector(".fader-track-area");
  const railEl = wrap.querySelector(".fader-rail");
  const fillEl = wrap.querySelector(".fader-fill");
  const thumbEl = wrap.querySelector(".fader-thumb");
  const scaleEl = wrap.querySelector(".fader-scale");

  for (const tk of FADER_TICKS) {
    const topPct = (1 - tk.norm) * 100;
    const row = document.createElement("div");
    row.className = "fader-tick";
    row.style.top = `${topPct.toFixed(2)}%`;
    row.innerHTML = `<span class="fader-tick-dash"></span><span>${tk.label}</span>`;
    scaleEl.appendChild(row);
  }

  function render(db) {
    const stepped = Math.round(Math.max(FADER_MIN, Math.min(FADER_MAX, db)));
    const clean = stepped === 0 ? 0 : stepped;
    currentDb = clean;
    const norm = dbToFaderNorm(clean);
    const topPct = (1 - norm) * 100;
    thumbEl.style.top = `${topPct.toFixed(2)}%`;
    fillEl.style.height = `${(norm * 100).toFixed(2)}%`;
    wrap.title = clean <= FADER_MIN ? "-∞ dB" : `${clean} dB`;
  }

  function push(db, settle = false) {
    lastInteractMs = performance.now();
    const stepped = Math.round(Math.max(FADER_MIN, Math.min(FADER_MAX, db)));
    const clean = stepped === 0 ? 0 : stepped;
    if (clean === currentDb && !settle) return;
    render(clean);
    onChange(clean, settle);
  }

  function dbFromClientY(clientY) {
    const rect = railEl.getBoundingClientRect();
    const usable = Math.max(10, rect.height);
    const norm = 1 - (clientY - rect.top) / usable;
    return faderNormToDb(norm);
  }

  let fineAnchorY = 0;
  let fineAnchorDb = 0;
  let wasFine = false;

  trackArea.addEventListener("mousedown", (e) => e.stopPropagation());

  trackArea.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    clearTimeout(scrollTimer);
    isScrolling = false;
    isDragging = true;
    thumbEl.classList.add("dragging");
    trackArea.setPointerCapture(e.pointerId);
    wasFine = e.shiftKey;
    if (e.shiftKey) {
      fineAnchorY = e.clientY;
      fineAnchorDb = currentDb;
    } else {
      push(dbFromClientY(e.clientY), false);
    }
  });

  trackArea.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    if (e.shiftKey) {
      if (!wasFine) {
        wasFine = true;
        fineAnchorY = e.clientY;
        fineAnchorDb = currentDb;
      }
      const dy = fineAnchorY - e.clientY;
      push(fineAnchorDb + dy * 0.12, false);
    } else {
      wasFine = false;
      push(dbFromClientY(e.clientY), false);
    }
  });

  function finishDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove("dragging");
    if (trackArea.hasPointerCapture(e.pointerId)) {
      trackArea.releasePointerCapture(e.pointerId);
    }
    push(currentDb, true);
  }

  trackArea.addEventListener("pointerup", finishDrag);
  trackArea.addEventListener("pointercancel", finishDrag);

  trackArea.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      isScrolling = true;
      const step = 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      push(currentDb + dir * step, false);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        isScrolling = false;
        if (!isDragging) push(currentDb, true);
      }, 220);
    },
    { passive: false }
  );

  trackArea.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    push(0, true);
  });

  render(currentDb);

  return {
    setValue(db, force = false) {
      if ((force || (!isDragging && !isScrolling)) && typeof db === "number" && Number.isFinite(db)) {
        render(db);
      }
    },
    isInteracting() {
      return isDragging || isScrolling || performance.now() - lastInteractMs < 180;
    },
    getValue() {
      return currentDb;
    },
  };
}

export function createMixerView(container, store) {
  let activeBusIdx = 0; // 0=Main Mix, 1=Mix A, 2=Mix B, 3=Reverb
  let showDigital = false;
  let inspectorOpen = true;
  let inspectedChannel = 0; // 0=Mic 1, 1=Mic 2, 2..9=DIG 1..8, 10=Reverb Engine
  let inspectorTab = "strip"; // "strip" | "eq" | "comp"
  let selectedEqBand = 0; // 0..3

  let pairRecords = [];
  let busParamBindings = new Map();
  let inspectorBindings = new Map();
  let inspectorGrBar = null;
  let inspectorGrVal = null;

  container.innerHTML = `
    <div class="mixer-toolbar">
      <div class="bus-tabs" id="mixerBusTabs">
        <button class="bus-tab active" data-bus="0">MAIN MIX</button>
        <button class="bus-tab" data-bus="1">MIX A</button>
        <button class="bus-tab" data-bus="2">MIX B</button>
        <button class="bus-tab" data-bus="3">REVERB</button>
      </div>
      <div class="mixer-tools-right">
        <div class="scene-bar" id="mixerSceneBar" title="Click 1–4 to recall · Right-click or click SAVE to store scene">
          <span class="scene-label">SCENES</span>
          <button type="button" class="scene-slot-btn" data-scene="0">1</button>
          <button type="button" class="scene-slot-btn" data-scene="1">2</button>
          <button type="button" class="scene-slot-btn" data-scene="2">3</button>
          <button type="button" class="scene-slot-btn" data-scene="3">4</button>
          <button type="button" class="scene-save-btn" id="btnSceneSave" title="Arm Save Mode, then click a slot 1–4">SAVE</button>
        </div>
        <div id="busMasterSlot" class="bus-master-slot"></div>
        <button class="action-btn active" id="btnToggleInspector">CHANNEL STRIP</button>
        <button class="action-btn" id="btnToggleDig">SHOW DIG</button>
      </div>
    </div>

    <!-- Zero-Scroll Horizontal Smart Channel Inspector Deck -->
    <div id="channelInspector" class="channel-inspector"></div>

    <div class="mixer-strips-scroll">
      <div class="mixer-strips" id="mixerStrips"></div>
    </div>
  `;

  const busBtns = Array.from(container.querySelectorAll(".bus-tab"));
  const btnToggleInspector = container.querySelector("#btnToggleInspector");
  const btnToggleDig = container.querySelector("#btnToggleDig");
  const busMasterSlot = container.querySelector("#busMasterSlot");
  const inspectorEl = container.querySelector("#channelInspector");
  const stripsEl = container.querySelector("#mixerStrips");
  const sceneBtns = Array.from(container.querySelectorAll(".scene-slot-btn"));
  const btnSceneSave = container.querySelector("#btnSceneSave");

  // --- 4-Slot Studio Scene / Snapshot Recall + Live Working Scene (No-Scene Slot) ---
  let sceneSaveArmed = false;
  let activeSceneIdx = -1;
  let sceneSaveTimer = null;
  let workingSaveTimer = null;
  let isApplyingScene = false;

  function disarmSceneSave() {
    sceneSaveArmed = false;
    clearTimeout(sceneSaveTimer);
    sceneSaveTimer = null;
    btnSceneSave?.classList.remove("armed");
  }

  function getSavedScenes() {
    const s = store.getUiPref("scenes", null);
    return Array.isArray(s) ? s : [null, null, null, null];
  }

  function syncSceneButtons() {
    const scenes = getSavedScenes();
    sceneBtns.forEach((b) => {
      const idx = Number(b.dataset.scene);
      const hasData = Boolean(scenes[idx]);
      const isActive = idx === activeSceneIdx;
      b.classList.toggle("has-scene", hasData);
      b.classList.toggle("active", isActive);
      b.title = isActive
        ? `Scene ${idx + 1} (active) — Click to return to Live Working Scene · Right-click to overwrite`
        : hasData
          ? `Scene ${idx + 1} (saved) — Click to recall · Right-click to overwrite`
          : `Scene ${idx + 1} (empty) — Right-click or press SAVE to store current desk`;
    });
  }

  function captureCurrentScene() {
    const snap = { buses: [], monitor: {}, preamps: [], dsp: [] };
    const p = store.paths;
    if (p.mixer) {
      for (let b = 0; b < 4; b++) {
        const busPath = [...p.mixer, b];
        const busNode = store.getNode(busPath);
        if (!busNode?.children) continue;
        const pairs = [];
        busNode.children.forEach((child, cIdx) => {
          if (child.tag !== "Pair") return;
          const pairPath = [...busPath, cIdx];
          const linkP = store.findParamPath(pairPath, "StereoLink");
          const ch0 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 0) || [...pairPath, 1];
          const ch1 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 1) || [...pairPath, 2];
          pairs.push({
            idx: child.props?.index ?? pairs.length,
            link: store.getVal(linkP, 0),
            v0: store.getVal(store.findParamPath(ch0, "Vol"), 0),
            p0: store.getVal(store.findParamPath(ch0, "Pan"), 0),
            m0: store.getVal(store.findParamPath(ch0, "Mute"), 0),
            v1: store.getVal(store.findParamPath(ch1, "Vol"), 0),
            p1: store.getVal(store.findParamPath(ch1, "Pan"), 0),
            m1: store.getVal(store.findParamPath(ch1, "Mute"), 0),
          });
        });
        snap.buses.push({ bus: b, pairs });
      }
    }
    if (p.monitorControl) {
      snap.monitor = {
        mainVol: store.getVal(p.mainVol),
        mainMute: store.getVal(p.mainMute),
        dim: store.getVal(p.dim),
        mono: store.getVal(p.mono),
        midSide: store.getVal(p.midSide),
        mainSrc: store.getVal(p.mainSrc),
        speakerSel: store.getVal(p.speakerSel),
        hp1Vol: store.getVal(p.hp1Vol),
        hp1Mute: store.getVal(p.hp1Mute),
        hp1Src: store.getVal(p.hp1Src),
      };
    }
    if (p.inputs) {
      const topo = store.getDeviceTopology();
      for (const chInfo of topo.inputChannels) {
        const ch = chInfo.index;
        const chP = store.findChildPath(p.inputs, (c) => c.tag === "Channel" && c.props?.index === ch);
        if (!chP) continue;
        const eqP = store.findChildPath(chP, (c) => c.tag === "EQ");
        const compP = store.findChildPath(chP, (c) => c.tag === "Compressor");
        if (chInfo.isAnalog) {
          const apfP = eqP ? store.findChildPath(eqP, (c) => c.tag === "Band" && c.props?.name === "APF") : null;
          snap.preamps.push({
            ch,
            g: store.getVal(store.findParamPath(chP, "G")),
            mute: store.getVal(store.findParamPath(chP, "Mute")),
            hmx: store.getVal(store.findParamPath(chP, "HMX")),
            air: store.getVal(store.findParamPath(chP, "AIR")),
            imp: store.getVal(store.findParamPath(chP, "Imp")),
            hpf: store.getVal(store.findParamPath(chP, "HpfEnable")),
            hpfFreq: store.getVal(store.findParamPath(chP, "HpfFreq")),
            plrty: store.getVal(store.findParamPath(chP, "plrty")),
            apfT: apfP ? store.getVal(store.findParamPath(apfP, "T")) : null,
            apfPhase: apfP ? store.getVal(store.findParamPath(apfP, "Phase")) : null,
          });
        }
        const eqBands = [];
        const eqNode = eqP ? store.getNode(eqP) : null;
        if (eqNode?.children) {
          eqNode.children.forEach((c, bi) => {
            if (c.tag === "Band" && c.props?.name?.startsWith("Band")) {
              const bp = [...eqP, bi];
              eqBands.push({
                t: store.getVal(store.findParamPath(bp, "T")),
                f: store.getVal(store.findParamPath(bp, "F")),
                g: store.getVal(store.findParamPath(bp, "G")),
                q: store.getVal(store.findParamPath(bp, "Q")),
              });
            }
          });
        }
        snap.dsp.push({
          ch,
          order: store.getVal(store.findParamPath(chP, "DspOrder")),
          recFx: store.getVal(store.findParamPath(chP, "RecSrc")),
          eqByps: eqP ? store.getVal(store.findParamPath(eqP, "eqByps")) : null,
          eqBands,
          compByps: compP ? store.getVal(store.findParamPath(compP, "byps")) : null,
          compTh: compP ? store.getVal(store.findParamPath(compP, "Threshold")) : null,
          compRa: compP ? store.getVal(store.findParamPath(compP, "Ratio")) : null,
          compAt: compP ? store.getVal(store.findParamPath(compP, "Attack")) : null,
          compRe: compP ? store.getVal(store.findParamPath(compP, "Release")) : null,
          compMk: compP ? store.getVal(store.findParamPath(compP, "Makeup")) : null,
          compBl: compP ? store.getVal(store.findParamPath(compP, "Blend")) : null,
        });
      }
    }
    return snap;
  }

  function applySceneSnapshot(snap) {
    if (!snap) return false;
    isApplyingScene = true;
    const setIfChanged = (path, val) => {
      if (!path || val == null) return;
      const cur = store.getVal(path);
      if (typeof cur === "number" && typeof val === "number") {
        if (Math.abs(cur - val) < 1e-4) return;
      } else if (cur === val) {
        return;
      }
      store.setParam(path, val);
    };
    try {
      const p = store.paths;
      if (p.mixer && Array.isArray(snap.buses)) {
        for (const bEntry of snap.buses) {
          const busPath = [...p.mixer, bEntry.bus];
          const busNode = store.getNode(busPath);
          if (!busNode?.children) continue;
          for (const pr of bEntry.pairs || []) {
            const pairPath = store.findChildPath(busPath, (c) => c.tag === "Pair" && c.props?.index === pr.idx);
            if (!pairPath) continue;
            const linkP = store.findParamPath(pairPath, "StereoLink");
            const ch0 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 0) || [...pairPath, 1];
            const ch1 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 1) || [...pairPath, 2];
            setIfChanged(linkP, pr.link);
            const v0P = store.findParamPath(ch0, "Vol");
            const p0P = store.findParamPath(ch0, "Pan");
            const m0P = store.findParamPath(ch0, "Mute");
            const v1P = store.findParamPath(ch1, "Vol");
            const p1P = store.findParamPath(ch1, "Pan");
            const m1P = store.findParamPath(ch1, "Mute");
            setIfChanged(v0P, pr.v0);
            setIfChanged(p0P, pr.p0);
            setIfChanged(m0P, pr.m0);
            setIfChanged(v1P, pr.v1);
            setIfChanged(p1P, pr.p1);
            setIfChanged(m1P, pr.m1);
          }
        }
      }

      const m = snap.monitor || {};
      const monPairs = [
        [p.mainVol, m.mainVol],
        [p.mainMute, m.mainMute],
        [p.dim, m.dim],
        [p.mono, m.mono],
        [p.midSide, m.midSide],
        [p.mainSrc, m.mainSrc],
        [p.speakerSel, m.speakerSel],
        [p.hp1Vol, m.hp1Vol],
        [p.hp1Mute, m.hp1Mute],
        [p.hp1Src, m.hp1Src],
      ];
      monPairs.forEach(([mp, val]) => setIfChanged(mp, val));

      if (p.inputs && Array.isArray(snap.preamps)) {
        for (const pr of snap.preamps) {
          const chP = store.findChildPath(p.inputs, (c) => c.tag === "Channel" && c.props?.index === pr.ch);
          if (!chP) continue;
          const map = [
            ["G", pr.g],
            ["Mute", pr.mute],
            ["HMX", pr.hmx],
            ["AIR", pr.air],
            ["Imp", pr.imp],
            ["HpfEnable", pr.hpf],
            ["HpfFreq", pr.hpfFreq],
            ["plrty", pr.plrty],
          ];
          map.forEach(([nm, val]) => {
            const pp = store.findParamPath(chP, nm);
            setIfChanged(pp, val);
          });
          const eqP = store.findChildPath(chP, (c) => c.tag === "EQ");
          const apfP = eqP ? store.findChildPath(eqP, (c) => c.tag === "Band" && c.props?.name === "APF") : null;
          if (apfP) {
            const tP = store.findParamPath(apfP, "T");
            const phP = store.findParamPath(apfP, "Phase");
            setIfChanged(tP, pr.apfT);
            setIfChanged(phP, pr.apfPhase);
          }
        }
      }

      if (p.inputs && Array.isArray(snap.dsp)) {
        for (const ds of snap.dsp) {
          const chP = store.findChildPath(p.inputs, (c) => c.tag === "Channel" && c.props?.index === ds.ch);
          if (!chP) continue;
          const ordP = store.findParamPath(chP, "DspOrder");
          const recP = store.findParamPath(chP, "RecSrc");
          setIfChanged(ordP, ds.order);
          setIfChanged(recP, ds.recFx);
          const eqP = store.findChildPath(chP, (c) => c.tag === "EQ");
          if (eqP) {
            const eqB = store.findParamPath(eqP, "eqByps");
            setIfChanged(eqB, ds.eqByps);
            const eqNode = store.getNode(eqP);
            let bCursor = 0;
            eqNode?.children?.forEach((c, bi) => {
              if (c.tag === "Band" && c.props?.name?.startsWith("Band")) {
                const savedB = ds.eqBands?.[bCursor++];
                if (!savedB) return;
                const bp = [...eqP, bi];
                [
                  ["T", savedB.t],
                  ["F", savedB.f],
                  ["G", savedB.g],
                  ["Q", savedB.q],
                ].forEach(([nm, val]) => {
                  const pp = store.findParamPath(bp, nm);
                  setIfChanged(pp, val);
                });
              }
            });
          }
          const compP = store.findChildPath(chP, (c) => c.tag === "Compressor");
          if (compP) {
            [
              ["Threshold", ds.compTh],
              ["Ratio", ds.compRa],
              ["Attack", ds.compAt],
              ["Release", ds.compRe],
              ["Makeup", ds.compMk],
              ["Blend", ds.compBl],
              ["byps", ds.compByps],
            ].forEach(([nm, val]) => {
              const pp = store.findParamPath(compP, nm);
              setIfChanged(pp, val);
            });
          }
        }
      }
      return true;
    } finally {
      setTimeout(() => {
        isApplyingScene = false;
      }, 80);
    }
  }

  function persistWorkingSceneNow() {
    if (isApplyingScene || activeSceneIdx !== -1 || !store.paths.mixer) return Promise.resolve();
    clearTimeout(workingSaveTimer);
    workingSaveTimer = null;
    return store.saveUiPref("workingScene", captureCurrentScene());
  }

  function scheduleWorkingSceneSave() {
    if (isApplyingScene || activeSceneIdx !== -1 || !store.paths.mixer) return;
    clearTimeout(workingSaveTimer);
    workingSaveTimer = setTimeout(() => {
      workingSaveTimer = null;
      if (!isApplyingScene && activeSceneIdx === -1 && store.paths.mixer) {
        store.saveUiPref("workingScene", captureCurrentScene());
      }
    }, 450);
  }

  function saveScene(idx) {
    const scenes = [...getSavedScenes()];
    while (scenes.length < 4) scenes.push(null);
    scenes[idx] = captureCurrentScene();
    activeSceneIdx = idx;
    store.saveUiPref("scenes", scenes);
    store.saveUiPref("activeSceneIdx", activeSceneIdx);
    disarmSceneSave();
    syncSceneButtons();
  }

  function recallScene(idx) {
    const scenes = getSavedScenes();
    const snap = scenes[idx];
    if (!snap) return false;
    // Before leaving the live Working Scene (no-scene slot), preserve it so nothing is ever lost
    if (activeSceneIdx === -1) {
      persistWorkingSceneNow();
    }
    activeSceneIdx = idx;
    store.saveUiPref("activeSceneIdx", activeSceneIdx);
    applySceneSnapshot(snap);
    syncSceneButtons();
    return true;
  }

  function returnToWorkingScene() {
    activeSceneIdx = -1;
    store.saveUiPref("activeSceneIdx", -1);
    const working = store.getUiPref("workingScene", null);
    if (working) {
      applySceneSnapshot(working);
    }
    syncSceneButtons();
  }

  window.addEventListener("beforeunload", () => {
    persistWorkingSceneNow();
    window.__TAURI__?.core?.invoke("save_hardware_boot_state").catch(() => {});
  });

  btnSceneSave?.addEventListener("click", () => {
    if (sceneSaveArmed) {
      disarmSceneSave();
    } else {
      sceneSaveArmed = true;
      btnSceneSave.classList.add("armed");
      clearTimeout(sceneSaveTimer);
      sceneSaveTimer = setTimeout(disarmSceneSave, 5000);
    }
  });

  sceneBtns.forEach((btn) => {
    const idx = Number(btn.dataset.scene);
    btn.addEventListener("click", (e) => {
      if (sceneSaveArmed || e.shiftKey) {
        saveScene(idx);
      } else if (activeSceneIdx === idx) {
        returnToWorkingScene();
      } else {
        recallScene(idx);
      }
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      saveScene(idx);
    });
  });

  store.onUiPrefs((prefs) => {
    if (typeof prefs.activeSceneIdx === "number" && prefs.activeSceneIdx >= -1 && prefs.activeSceneIdx < 4) {
      activeSceneIdx = prefs.activeSceneIdx;
    }
    syncSceneButtons();
  });
  syncSceneButtons();

  busBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      activeBusIdx = Number(btn.dataset.bus);
      store.setActiveMixBus(activeBusIdx);
      store.saveUiPref("mixerBus", activeBusIdx);
      busBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.bus) === activeBusIdx));
      const topo = store.getDeviceTopology();
      if (activeBusIdx === 3) {
        inspectedChannel = topo.reverbChannelId; // Jump inspector to Reverb Engine on Reverb bus
        store.saveUiPref("inspectedChannel", inspectedChannel);
      } else if (inspectedChannel === topo.reverbChannelId) {
        inspectedChannel = 0;
        store.saveUiPref("inspectedChannel", inspectedChannel);
      }
      rebuildMixer();
    });
  });

  btnToggleInspector.addEventListener("click", () => {
    inspectorOpen = !inspectorOpen;
    store.saveUiPref("inspectorOpen", inspectorOpen);
    btnToggleInspector.classList.toggle("active", inspectorOpen);
    inspectorEl.style.display = inspectorOpen ? "flex" : "none";
  });

  btnToggleDig.addEventListener("click", () => {
    showDigital = !showDigital;
    store.saveUiPref("showDigital", showDigital);
    btnToggleDig.classList.toggle("active", showDigital);
    btnToggleDig.textContent = showDigital ? "HIDE DIG" : "SHOW DIG";
    rebuildMixer();
  });

  function bindBusParam(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!busParamBindings.has(k)) busParamBindings.set(k, []);
    busParamBindings.get(k).push(fn);
  }

  function bindInsp(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!inspectorBindings.has(k)) inspectorBindings.set(k, []);
    inspectorBindings.get(k).push(fn);
  }

  function getInputChannelPath(chIdx) {
    const inputs = store.paths.inputs;
    if (!inputs) return null;
    return store.findChildPath(inputs, (c) => c.tag === "Channel" && c.props?.index === chIdx);
  }

  function getReverbSendPath(pairIdx, side) {
    const mixerPath = store.paths.mixer;
    if (!mixerPath) return null;
    const revMix = [...mixerPath, 3];
    const pairPath = store.findChildPath(revMix, (c) => c.tag === "Pair" && c.props?.index === pairIdx);
    if (!pairPath) return null;
    const chPath = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === side);
    return chPath ? store.findParamPath(chPath, "Vol") : null;
  }

  function getReverbSendMutePath(pairIdx, side) {
    const mixerPath = store.paths.mixer;
    if (!mixerPath) return null;
    const revMix = [...mixerPath, 3];
    const pairPath = store.findChildPath(revMix, (c) => c.tag === "Pair" && c.props?.index === pairIdx);
    if (!pairPath) return null;
    const chPath = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === side);
    return chPath ? store.findParamPath(chPath, "Mute") : null;
  }

  function highlightSelectedChannel() {
    stripsEl.querySelectorAll(".mixer-pair").forEach((pair) => {
      const stereo = pair.classList.contains("is-stereo");
      const headRow = pair.querySelector(".pair-head-row");
      const heads = Array.from(pair.querySelectorAll("[data-inspect-ch]"));
      const anyMatch = heads.some((h) => Number(h.dataset.inspectCh) === inspectedChannel);
      if (headRow) {
        headRow.classList.toggle("is-inspected-pair", stereo && anyMatch);
      }
      heads.forEach((h) => {
        h.classList.toggle("is-inspected", !stereo && Number(h.dataset.inspectCh) === inspectedChannel);
      });
    });
  }

  function selectInspectedChannel(chIdx, tab = null) {
    inspectedChannel = chIdx;
    store.saveUiPref("inspectedChannel", inspectedChannel);
    if (tab) {
      inspectorTab = tab;
      store.saveUiPref("inspectorTab", inspectorTab);
    }
    if (!inspectorOpen) {
      inspectorOpen = true;
      store.saveUiPref("inspectorOpen", true);
      btnToggleInspector.classList.add("active");
      inspectorEl.style.display = "flex";
    }
    highlightSelectedChannel();
    buildInspector();
  }

  // --- SMART HORIZONTAL CHANNEL INSPECTOR DECK ---
  function buildInspector() {
    inspectorBindings.clear();
    inspectorGrBar = null;
    inspectorGrVal = null;
    inspectorEl.innerHTML = "";
    inspectorEl.style.display = inspectorOpen ? "flex" : "none";

    if (!store.paths.inputs || !store.paths.mixer) return;

    const topo = store.getDeviceTopology();
    const chEntry = topo.inputChannels.find((c) => c.index === inspectedChannel);
    const isReverb = inspectedChannel === topo.reverbChannelId;
    const isAnalog = Boolean(chEntry?.isAnalog);
    if (!chEntry && !isReverb) {
      inspectedChannel = topo.inputChannels[0]?.index ?? 0;
    }
    const accentClass = isAnalog ? "accent-mic" : isReverb ? "accent-rev" : "accent-dig";
    inspectorEl.className = `channel-inspector ${accentClass}`;

    // Dynamic channel dropdown adapting to any connected Audient interface (iD1/iD2/iD2+/iD4/iD14/iD24/iD44)
    const chOptions = topo.inputChannels.map((c, idx) => ({
      id: c.index,
      title: `${idx + 1} · ${c.label}`,
    }));
    if (topo.reverbPairIdx >= 0) {
      const rp = topo.pairs[topo.reverbPairIdx];
      chOptions.push({ id: topo.reverbChannelId, title: `${rp.nums[0]}+${rp.nums[1]} · REVERB` });
    }

    const navCol = document.createElement("div");
    navCol.className = "insp-nav-col";
    navCol.innerHTML = `
      <div class="insp-nav-top">
        <span class="micro-label">CHANNEL</span>
        <select class="dock-select insp-ch-select" id="iChSelect" title="Select Channel">
          ${chOptions.map((c) => `<option value="${c.id}" ${c.id === inspectedChannel ? "selected" : ""}>${c.title}</option>`).join("")}
        </select>
      </div>
      ${!isReverb ? `
      <div class="seg-group full-width insp-subtabs">
        <button class="seg-btn ${inspectorTab === "strip" ? "active" : ""}" data-itab="strip">STRIP</button>
        <button class="seg-btn ${inspectorTab === "eq" ? "active" : ""}" data-itab="eq">EQ</button>
        <button class="seg-btn ${inspectorTab === "comp" ? "active" : ""}" data-itab="comp">COMP</button>
      </div>` : `<div class="insp-rev-badge">STEREO FX ENGINE</div>`}
    `;
    inspectorEl.appendChild(navCol);

    navCol.querySelector("#iChSelect").addEventListener("change", (e) => {
      selectInspectedChannel(Number(e.target.value));
    });

    navCol.querySelectorAll(".insp-subtabs .seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        inspectorTab = b.dataset.itab;
        store.saveUiPref("inspectorTab", inspectorTab);
        buildInspector();
      });
    });

    const content = document.createElement("div");
    content.className = "insp-content pair-fade-in";
    inspectorEl.appendChild(content);

    // 1) REVERB ENGINE DECK
    if (isReverb) {
      const revMix = [...store.paths.mixer, 3];
      const decayPath = store.findParamPath(revMix, "Decay");
      const dampPath = store.findParamPath(revMix, "Damping");
      const blendPath = store.findParamPath(revMix, "Blend");
      const editable = decayPath ? store.isEditable(decayPath) : false;

      content.innerHTML = `
        <div class="insp-module insp-reverb-mod">
          <div class="insp-mod-head">
            <span class="micro-label">REVERB PARAMETERS</span>
            ${editable ? "" : `<span class="dsp-lock-pill">LOCKED AT ${store.getOptionLabel(store.paths.sampleRate, "192kHz")}</span>`}
          </div>
          <div class="insp-knob-group">
            <div class="insp-knob-unit"><div class="insp-knob-sm" id="irDecay"></div><span>DECAY</span></div>
            <div class="insp-knob-unit"><div class="insp-knob-sm" id="irDamp"></div><span>DAMPING</span></div>
            <div class="insp-knob-unit"><div class="insp-knob-sm" id="irBlend"></div><span>BLEND</span></div>
          </div>
        </div>
      `;

      const kDecay = createKnob(content.querySelector("#irDecay"), {
        min: 0, max: 100, muteAtMin: false, unit: "%", compact: true,
        defaultValue: Math.round((store.getVal(decayPath, 0.6) ?? 0.6) * 100),
        onChange: (v) => store.setParam(decayPath, v / 100),
      });
      kDecay.setDisabled(!editable);
      bindInsp(decayPath, (v) => typeof v === "number" && kDecay.setValue(v * 100));

      const kDamp = createKnob(content.querySelector("#irDamp"), {
        min: 20, max: 20000, muteAtMin: false, unit: "Hz", compact: true, logScale: true,
        formatValue: fmtFreqShort,
        defaultValue: Math.round(store.getVal(dampPath, 8000) ?? 8000),
        onChange: (v) => store.setParam(dampPath, Math.round(v)),
      });
      kDamp.setDisabled(!editable);
      bindInsp(dampPath, (v) => typeof v === "number" && kDamp.setValue(v));

      const kBlend = createKnob(content.querySelector("#irBlend"), {
        min: 0, max: 100, muteAtMin: false, unit: "%", compact: true,
        defaultValue: Math.round((store.getVal(blendPath, 0.8) ?? 0.8) * 100),
        onChange: (v) => store.setParam(blendPath, v / 100),
      });
      kBlend.setDisabled(!editable);
      bindInsp(blendPath, (v) => typeof v === "number" && kBlend.setValue(v * 100));
      return;
    }

    const chPath = getInputChannelPath(inspectedChannel);
    if (!chPath) return;

    const eqPath = store.findChildPath(chPath, (c) => c.tag === "EQ");
    const compPath = store.findChildPath(chPath, (c) => c.tag === "Compressor");
    const eqBypsPath = eqPath ? store.findParamPath(eqPath, "eqByps") : null;
    const compBypsPath = compPath ? store.findParamPath(compPath, "byps") : null;
    const recFxPath = store.findParamPath(chPath, "RecSrc");
    const orderPath = store.findParamPath(chPath, "DspOrder");
    const dspEditable = (eqBypsPath && store.isEditable(eqBypsPath)) || (compBypsPath && store.isEditable(compBypsPath));
    const pairIdx = Math.floor(inspectedChannel / 2);
    const side = inspectedChannel % 2;
    const revSendPath = getReverbSendPath(pairIdx, side);
    const revMutePath = getReverbSendMutePath(pairIdx, side);

    // 2) STRIP SUB-TAB (INPUT + V-PHASE + V-HPF + TONE [GLOW/LIFT/ORBIT] + FX/SEND)
    if (inspectorTab === "strip") {
      if (isAnalog) {
        const gainPath = store.findParamPath(chPath, "G");
        const p48Path = store.findParamPath(chPath, "48V");
        const polPath = store.findParamPath(chPath, "plrty");
        const mutePath = store.findParamPath(chPath, "Mute");
        const hpfEnPath = store.findParamPath(chPath, "HpfEnable");
        const hpfFreqPath = store.findParamPath(chPath, "HpfFreq");
        const impPath = store.findParamPath(chPath, "Imp");
        const glowPath = store.findParamPath(chPath, "HMX");
        const liftPath = store.findParamPath(chPath, "AIR");
        const apfPath = eqPath ? store.findChildPath(eqPath, (c) => c.tag === "Band" && c.props?.name === "APF") : null;
        const apfTypePath = apfPath ? store.findParamPath(apfPath, "T") : null;
        const apfPhasePath = apfPath ? store.findParamPath(apfPath, "Phase") : null;

        content.innerHTML = `
          <div class="insp-module insp-input-mod">
            <div class="insp-knob-unit">
              <span class="micro-label">INPUT</span>
              <div class="insp-knob-sm" id="iGain"></div>
              <div class="insp-mini-pair">
                <button class="mini-pill-btn danger-active" id="i48v">48V</button>
                <button class="mini-pill-btn danger-active" id="iMute">MUTE</button>
              </div>
            </div>
          </div>

          <div class="insp-module insp-filters-mod">
            <div class="insp-knob-row-pair">
              <div class="insp-knob-unit">
                <span class="micro-label">V-PHASE</span>
                <div class="insp-knob-sm" id="iPhase"></div>
                <div class="insp-mini-pair">
                  <button class="mini-pill-btn green-active" id="iPhaseOn" title="Toggle V-Phase">⏻</button>
                  <button class="mini-pill-btn" id="iPol" title="Polarity Invert">Ø</button>
                </div>
              </div>
              <div class="insp-knob-unit">
                <span class="micro-label">V-HPF</span>
                <div class="insp-knob-sm" id="iHpf"></div>
                <button class="mini-pill-btn green-active" id="iHpfBtn" title="Toggle V-HPF">HPF</button>
              </div>
            </div>
          </div>

          <div class="insp-module insp-tone-mod">
            <div class="insp-tone-group">
              <span class="micro-label">TONE</span>
              <div class="insp-tone-top">
                <button class="tone-btn tone-glow" id="iGlow">GLOW</button>
                <button class="tone-btn tone-hmx" id="iHmx">HMX</button>
                <button class="tone-btn tone-lift" id="iLift">LIFT</button>
              </div>
            </div>
            <div class="insp-orbit-wrap">
              <span class="micro-label">ORBIT</span>
              <div class="orbit-btn-row" id="iOrbitSeg">
                ${IMP_OPTIONS.map((o) => `<button class="orbit-btn ${o.cls}" data-val="${o.value}">${o.name}</button>`).join("")}
              </div>
            </div>
          </div>

          <div class="insp-module insp-fx-mod">
            <div class="insp-fx-group">
              <span class="micro-label">DSP &amp; SEND</span>
              <div class="insp-fx-btns">
                <button class="mini-pill-btn" id="iEqBtn">EQ</button>
                <button class="mini-pill-btn" id="iCompBtn">COMP</button>
                <button class="mini-pill-btn" id="iRecFx">REC FX</button>
              </div>
            </div>
            <div class="insp-send-wrap">
              <div class="insp-send-head">
                <span class="micro-label">REVERB SEND</span>
                <button class="mini-pill-btn green-active insp-rev-pwr" id="iRevOn" title="Toggle Reverb Send On/Off">⏻</button>
              </div>
              <div class="insp-send-row">
                <input type="range" class="mini-slider" id="iRevSend" min="0" max="1000" step="1" />
                <span class="insp-send-val" id="iRevVal">-∞</span>
              </div>
            </div>
          </div>
        `;

        const kGain = createKnob(content.querySelector("#iGain"), {
          min: 0, max: 75, muteAtMin: false, unit: "dB", compact: true, wheelStep: 1,
          defaultValue: store.getVal(gainPath, 0),
          onChange: (v) => store.setParam(gainPath, Math.round(v)),
        });
        bindInsp(gainPath, (v) => kGain.setValue(v));

        const kPhase = createKnob(content.querySelector("#iPhase"), {
          min: 0, max: 180, muteAtMin: false, unit: "°", compact: true, wheelStep: 1,
          defaultValue: store.getVal(apfPhasePath, 90),
          onChange: (v) => {
            if (apfTypePath && store.getVal(apfTypePath, 11) === 11) {
              store.setParam(apfTypePath, 13);
            }
            store.setParam(apfPhasePath, Math.round(v));
          },
        });
        bindInsp(apfPhasePath, (v) => kPhase.setValue(v));

        const kHpf = createKnob(content.querySelector("#iHpf"), {
          min: 20, max: 250, muteAtMin: false, unit: "Hz", compact: true, wheelStep: 1,
          defaultValue: store.getVal(hpfFreqPath, 100),
          onChange: (v) => {
            if (hpfEnPath && !store.getVal(hpfEnPath, 0)) {
              store.setParam(hpfEnPath, 1);
            }
            store.setParam(hpfFreqPath, Math.round(v));
          },
        });
        bindInsp(hpfFreqPath, (v) => kHpf.setValue(v));

        const wireT = (sel, path, invert = false, enabled = true) => {
          const btn = content.querySelector(sel);
          if (!btn || !path) return;
          btn.disabled = !enabled;
          const sync = () => {
            const on = invert ? !store.getVal(path, 1) : Boolean(store.getVal(path, 0));
            btn.classList.toggle("active", on);
          };
          btn.addEventListener("click", () => enabled && store.toggleParam(path));
          bindInsp(path, sync);
          sync();
        };

        wireT("#i48v", p48Path);
        wireT("#iPol", polPath);
        wireT("#iMute", mutePath);
        wireT("#iEqBtn", eqBypsPath, true, dspEditable);
        wireT("#iCompBtn", compBypsPath, true, dspEditable);
        wireT("#iRecFx", recFxPath, false, store.isEditable(recFxPath));

        // V-PHASE On/Off (11=OFF <-> 13=ON) + fade dial when OFF (touching knob auto-enables)
        const btnPhaseOn = content.querySelector("#iPhaseOn");
        const syncPhaseOn = () => {
          const on = store.getVal(apfTypePath, 11) !== 11;
          btnPhaseOn.classList.toggle("active", on);
          kPhase.setFaded(!on);
        };
        btnPhaseOn.addEventListener("click", () => {
          const on = store.getVal(apfTypePath, 11) !== 11;
          store.setParam(apfTypePath, on ? 11 : 13);
        });
        bindInsp(apfTypePath, syncPhaseOn);
        syncPhaseOn();

        // V-HPF On/Off + fade dial when OFF (touching knob auto-enables)
        const btnHpf = content.querySelector("#iHpfBtn");
        const syncHpfOn = () => {
          const on = Boolean(store.getVal(hpfEnPath, 0));
          btnHpf.classList.toggle("active", on);
          kHpf.setFaded(!on);
        };
        btnHpf.addEventListener("click", () => store.toggleParam(hpfEnPath));
        bindInsp(hpfEnPath, syncHpfOn);
        syncHpfOn();

        // TONE: GLOW (HMX + LIFT together), HMX, LIFT
        const btnGlow = content.querySelector("#iGlow");
        const btnHmx = content.querySelector("#iHmx");
        const btnLift = content.querySelector("#iLift");
        const syncTone = () => {
          const hmxOn = Boolean(store.getVal(glowPath, 0));
          const liftOn = Boolean(store.getVal(liftPath, 0));
          btnHmx.classList.toggle("active", hmxOn);
          btnLift.classList.toggle("active", liftOn);
          btnGlow.classList.toggle("active", hmxOn && liftOn);
        };
        btnHmx.addEventListener("click", () => store.toggleParam(glowPath));
        btnLift.addEventListener("click", () => store.toggleParam(liftPath));
        btnGlow.addEventListener("click", () => {
          const bothOn = Boolean(store.getVal(glowPath, 0)) && Boolean(store.getVal(liftPath, 0));
          const next = bothOn ? 0 : 1;
          store.setParam(glowPath, next);
          store.setParam(liftPath, next);
        });
        bindInsp(glowPath, syncTone);
        bindInsp(liftPath, syncTone);
        syncTone();

        // Double-click EQ/COMP pill jumps straight to EQ/COMP sub-tab
        content.querySelector("#iEqBtn").addEventListener("dblclick", () => { inspectorTab = "eq"; buildInspector(); });
        content.querySelector("#iCompBtn").addEventListener("dblclick", () => { inspectorTab = "comp"; buildInspector(); });

        const orbitBtns = Array.from(content.querySelectorAll("#iOrbitSeg .orbit-btn"));
        const syncOrbit = () => {
          const v = store.getVal(impPath, 0);
          orbitBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
        };
        orbitBtns.forEach((b) => b.addEventListener("click", () => store.setParam(impPath, Number(b.dataset.val))));
        bindInsp(impPath, syncOrbit);
        syncOrbit();

        const btnRevOn = content.querySelector("#iRevOn");
        const slRev = content.querySelector("#iRevSend");
        const valRev = content.querySelector("#iRevVal");
        const revRow = content.querySelector(".insp-send-row");
        const fmtRevDb = (v) => (v <= -128 ? "-∞" : `${v > 0 ? "+" : ""}${Math.round(v)}dB`);
        const syncRev = () => {
          const v = Number(store.getVal(revSendPath, -128));
          const on = revMutePath ? !Boolean(store.getVal(revMutePath, 1)) : v > -128;
          btnRevOn?.classList.toggle("active", on);
          revRow?.classList.toggle("is-bypassed", !on);
          slRev.value = String(Math.round(dbToFaderNorm(v) * 1000));
          valRev.textContent = fmtRevDb(v);
        };
        btnRevOn?.addEventListener("click", () => {
          if (!revMutePath) return;
          const currentlyMuted = Boolean(store.getVal(revMutePath, 1));
          store.setParam(revMutePath, currentlyMuted ? 0 : 1);
          if (currentlyMuted && Number(store.getVal(revSendPath, -128)) <= -128) {
            store.setParam(revSendPath, -12);
          }
        });
        slRev.addEventListener("input", () => {
          if (revMutePath && Boolean(store.getVal(revMutePath, 1))) {
            store.setParam(revMutePath, 0);
          }
          const db = Math.round(faderNormToDb(Number(slRev.value) / 1000));
          valRev.textContent = fmtRevDb(db);
          store.setParam(revSendPath, db);
        });
        bindInsp(revSendPath, syncRev);
        bindInsp(revMutePath, syncRev);
        syncRev();
      } else {
        // Digital Input (DIG 1..8) Strip Summary
        content.innerHTML = `
          <div class="insp-module insp-fx-mod">
            <span class="micro-label">DIGITAL CHANNEL DSP</span>
            <div class="insp-fx-btns">
              <button class="mini-pill-btn" id="iEqBtn">EQ</button>
              <button class="mini-pill-btn" id="iCompBtn">COMP</button>
              <button class="mini-pill-btn" id="iRecFx">REC FX</button>
            </div>
            ${dspEditable ? "" : `<span class="dsp-lock-pill">DSP LOCKED AT ${store.getOptionLabel(store.paths.sampleRate, "192kHz")}</span>`}
          </div>
          <div class="insp-module insp-fx-mod">
            <div class="insp-send-head">
              <span class="micro-label">REVERB SEND</span>
              <button class="mini-pill-btn green-active insp-rev-pwr" id="iRevOn" title="Toggle Reverb Send On/Off">⏻</button>
            </div>
            <div class="insp-send-row">
              <input type="range" class="mini-slider" id="iRevSend" min="0" max="1000" step="1" />
              <span class="insp-send-val" id="iRevVal">-∞</span>
            </div>
          </div>
        `;
        const wireD = (sel, path, inv, en) => {
          const btn = content.querySelector(sel);
          if (!btn || !path) return;
          btn.disabled = !en;
          const s = () => btn.classList.toggle("active", inv ? !store.getVal(path, 1) : Boolean(store.getVal(path, 0)));
          btn.addEventListener("click", () => en && store.toggleParam(path));
          bindInsp(path, s);
          s();
        };
        wireD("#iEqBtn", eqBypsPath, true, dspEditable);
        wireD("#iCompBtn", compBypsPath, true, dspEditable);
        wireD("#iRecFx", recFxPath, false, store.isEditable(recFxPath));

        const btnRevOn = content.querySelector("#iRevOn");
        const slRev = content.querySelector("#iRevSend");
        const valRev = content.querySelector("#iRevVal");
        const revRow = content.querySelector(".insp-send-row");
        const fmtRevDb = (v) => (v <= -128 ? "-∞" : `${v > 0 ? "+" : ""}${Math.round(v)}dB`);
        const syncRev = () => {
          const v = Number(store.getVal(revSendPath, -128));
          const on = revMutePath ? !Boolean(store.getVal(revMutePath, 1)) : v > -128;
          btnRevOn?.classList.toggle("active", on);
          revRow?.classList.toggle("is-bypassed", !on);
          slRev.value = String(Math.round(dbToFaderNorm(v) * 1000));
          valRev.textContent = fmtRevDb(v);
        };
        btnRevOn?.addEventListener("click", () => {
          if (!revMutePath) return;
          const currentlyMuted = Boolean(store.getVal(revMutePath, 1));
          store.setParam(revMutePath, currentlyMuted ? 0 : 1);
          if (currentlyMuted && Number(store.getVal(revSendPath, -128)) <= -128) {
            store.setParam(revSendPath, -12);
          }
        });
        slRev.addEventListener("input", () => {
          if (revMutePath && Boolean(store.getVal(revMutePath, 1))) {
            store.setParam(revMutePath, 0);
          }
          const db = Math.round(faderNormToDb(Number(slRev.value) / 1000));
          valRev.textContent = fmtRevDb(db);
          store.setParam(revSendPath, db);
        });
        bindInsp(revSendPath, syncRev);
        bindInsp(revMutePath, syncRev);
        syncRev();
      }
      return;
    }

    // 3) INLINE 4-BAND EQ SUB-TAB (OLED INTERACTIVE CURVE + 3 FLAT WHITE KNOBS)
    if (inspectorTab === "eq") {
      const eqNode = store.getNode(eqPath);
      const bands = [];
      if (eqNode?.children) {
        eqNode.children.forEach((c, idx) => {
          if (c.tag === "Band" && c.props?.name?.startsWith("Band")) {
            const bp = [...eqPath, idx];
            bands.push({
              name: c.props.name,
              t: store.findParamPath(bp, "T"),
              f: store.findParamPath(bp, "F"),
              g: store.findParamPath(bp, "G"),
              q: store.findParamPath(bp, "Q"),
            });
          }
        });
      }
      if (selectedEqBand >= bands.length) selectedEqBand = 0;
      const srLabel = store.getOptionLabel(store.paths.sampleRate, "192kHz");

      content.innerHTML = `
        <div class="insp-module insp-eq-ctrl">
          <div class="insp-eq-top">
            <span class="micro-label">4-BAND EQ</span>
            <button class="mini-pill-btn green-active" id="ieqOn" ${dspEditable ? "" : "disabled"}>ON</button>
          </div>
          <div class="eq-band-pills" id="ieqBandPills">
            ${bands
              .map(
                (_, i) =>
                  `<button class="eq-band-pill ${i === selectedEqBand ? "active" : ""}" data-band="${i}" style="--band-col:${EQ_BAND_COLORS[i % 4]}">${i + 1}</button>`
              )
              .join("")}
          </div>
          <div class="eq-type-row">
            <select class="dock-select eq-type-sel" id="ieqType" ${dspEditable ? "" : "disabled"}>
              ${EQ_TYPES.map((o) => `<option value="${o.value}">${o.name}</option>`).join("")}
            </select>
            <button class="mini-pill-btn eq-flat-btn" id="ieqFlat" title="Reset EQ to default profile" ${dspEditable ? "" : "disabled"}>RESET</button>
          </div>
        </div>

        <div class="insp-module insp-eq-graph-mod">
          <div class="eq-oled-wrap">
            <svg class="eq-oled-svg" id="ieqSvg" viewBox="0 0 380 96" preserveAspectRatio="none">
              <defs>
                <linearGradient id="eqFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="rgba(255,255,255,0.16)" />
                  <stop offset="100%" stop-color="rgba(255,255,255,0.01)" />
                </linearGradient>
              </defs>
              <line x1="88" y1="0" x2="88" y2="96" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="215" y1="0" x2="215" y2="96" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="342" y1="0" x2="342" y2="96" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="24" x2="380" y2="24" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="48" x2="380" y2="48" class="eq-grid-zero" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="72" x2="380" y2="72" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <path id="ieqFillPath" fill="url(#eqFillGrad)" />
              <path id="ieqCurvePath" fill="none" stroke="#f0f0f0" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            </svg>
            <span class="eq-axis-lbl" style="left:23.8%;bottom:3px;">100</span>
            <span class="eq-axis-lbl" style="left:57.2%;bottom:3px;">1k</span>
            <span class="eq-axis-lbl" style="left:90.5%;bottom:3px;">10k</span>
            <div class="eq-nodes-layer" id="ieqNodes"></div>
            <span class="eq-oled-readout" id="ieqReadout"></span>
            ${dspEditable ? "" : `<div class="dsp-oled-lock">DSP UNAVAILABLE AT ${srLabel} · LOWER SAMPLE RATE</div>`}
          </div>
        </div>

        <div class="insp-module insp-eq-knobs-mod">
          <div class="insp-knob-row-pair eq-knobs-trio">
            <div class="insp-knob-unit">
              <span class="micro-label">FREQ</span>
              <div class="insp-knob-sm" id="ieqFreq"></div>
              <span class="knob-sub-unit">HZ</span>
            </div>
            <div class="insp-knob-unit">
              <span class="micro-label">GAIN</span>
              <div class="insp-knob-sm" id="ieqGain"></div>
              <span class="knob-sub-unit">DB</span>
            </div>
            <div class="insp-knob-unit">
              <span class="micro-label">WIDTH</span>
              <div class="insp-knob-sm" id="ieqQ"></div>
              <span class="knob-sub-unit">Q</span>
            </div>
          </div>
        </div>
      `;

      const curBand = () => bands[selectedEqBand] || bands[0];
      const isEqActive = () => dspEditable && !store.getVal(eqBypsPath, 1);
      const ensureEqEngaged = () => {
        if (dspEditable && eqBypsPath && store.getVal(eqBypsPath, 1)) {
          store.setParam(eqBypsPath, 0);
        }
      };

      const btnOn = content.querySelector("#ieqOn");
      const selType = content.querySelector("#ieqType");
      const btnFlat = content.querySelector("#ieqFlat");
      const bandPills = Array.from(content.querySelectorAll("#ieqBandPills .eq-band-pill"));
      const svgEl = content.querySelector("#ieqSvg");
      const curvePath = content.querySelector("#ieqCurvePath");
      const fillPath = content.querySelector("#ieqFillPath");
      const nodesGroup = content.querySelector("#ieqNodes");
      const readoutEl = content.querySelector("#ieqReadout");

      const freqToX = (f) => (Math.log(Math.max(20, Math.min(20000, f)) / 20) / Math.log(1000)) * 380;
      const xToFreq = (x) => 20 * Math.pow(1000, Math.max(0, Math.min(1, x / 380)));
      const dbToY = (db) => 48 - (Math.max(-14, Math.min(14, db)) / 14) * 40;
      const yToDb = (y) => Math.max(-12, Math.min(12, ((48 - y) / 40) * 14));

      // Precompute log-spaced X/frequency grid once (zero Math.pow per draw frame)
      const EQ_GRID = [];
      for (let x = 0; x <= 380; x += 3) {
        EQ_GRID.push({ x, freq: xToFreq(x) });
      }
      if (EQ_GRID[EQ_GRID.length - 1].x !== 380) {
        EQ_GRID.push({ x: 380, freq: 20000 });
      }

      let rafDrawId = null;
      let draggingBandIdx = -1;
      function scheduleDrawGraph() {
        if (rafDrawId !== null) return;
        rafDrawId = requestAnimationFrame(() => {
          rafDrawId = null;
          drawGraph();
        });
      }

      const kFreq = createKnob(content.querySelector("#ieqFreq"), {
        min: 20, max: 20000, muteAtMin: false, compact: true, logScale: true,
        defaultValue: curBand() ? store.getVal(curBand().f, 1000) : 1000,
        formatValue: fmtFreqShort,
        onChange: (v) => {
          const b = curBand();
          if (b && dspEditable) {
            ensureEqEngaged();
            store.setParam(b.f, Math.round(v), { silent: true });
            scheduleDrawGraph();
          }
        },
      });
      const kGain = createKnob(content.querySelector("#ieqGain"), {
        min: -12, max: 12, centerZero: true, muteAtMin: false, compact: true,
        roundOnSettle: false, decimals: 1, wheelStep: 1, fineWheelStep: 0.1,
        defaultValue: curBand() ? store.getVal(curBand().g, 0) : 0,
        formatValue: (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
        onChange: (v) => {
          const b = curBand();
          if (b && dspEditable) {
            ensureEqEngaged();
            store.setParam(b.g, Math.round(v * 10) / 10, { silent: true });
            scheduleDrawGraph();
          }
        },
      });
      const kQ = createKnob(content.querySelector("#ieqQ"), {
        min: 0.5, max: 12, muteAtMin: false, compact: true, logScale: true,
        roundOnSettle: false, decimals: 1, wheelStep: 0.2, fineWheelStep: 0.1,
        defaultValue: curBand() ? store.getVal(curBand().q, 1) : 1,
        onChange: (v) => {
          const b = curBand();
          if (b && dspEditable) {
            ensureEqEngaged();
            store.setParam(b.q, Math.round(v * 10) / 10, { silent: true });
            scheduleDrawGraph();
          }
        },
      });

      // Create 4 draggable circular HTML band dots (always 1:1 true circles)
      const nodeEls = bands.map((b, idx) => {
        const g = document.createElement("button");
        g.type = "button";
        g.className = "eq-dot eq-dot-sm";
        const col = EQ_BAND_COLORS[idx % 4];
        g.style.setProperty("--dot-col", col);
        g.textContent = String(idx + 1);
        nodesGroup.appendChild(g);

        let dragRect = null;
        g.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          selectBand(idx);
          if (!dspEditable) return;
          ensureEqEngaged();
          draggingBandIdx = idx;
          dragRect = svgEl.getBoundingClientRect();
          g.setPointerCapture(e.pointerId);
        });
        g.addEventListener("pointermove", (e) => {
          if (draggingBandIdx !== idx || !dspEditable || !dragRect) return;
          const sx = ((e.clientX - dragRect.left) / dragRect.width) * 380;
          const sy = ((e.clientY - dragRect.top) / dragRect.height) * 96;
          const nf = Math.round(xToFreq(sx));
          const ng = Math.round(yToDb(sy) * 10) / 10;
          store.setParam(b.f, nf, { silent: true });
          store.setParam(b.g, ng, { silent: true });
          kFreq.setValue(nf);
          kGain.setValue(ng);
          scheduleDrawGraph();
        });
        const endDrag = (e) => {
          if (draggingBandIdx !== idx) return;
          draggingBandIdx = -1;
          dragRect = null;
          if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
        };
        g.addEventListener("pointerup", endDrag);
        g.addEventListener("pointercancel", endDrag);
        g.addEventListener(
          "wheel",
          (e) => {
            if (!dspEditable) return;
            e.preventDefault();
            e.stopPropagation();
            selectBand(idx);
            ensureEqEngaged();
            const curQ = Number(store.getVal(b.q, 1));
            const nextQ = Math.max(0.5, Math.min(12, Math.round((curQ + (e.deltaY < 0 ? 0.3 : -0.3)) * 10) / 10));
            store.setParam(b.q, nextQ, { silent: true });
            kQ.setValue(nextQ);
            scheduleDrawGraph();
          },
          { passive: false }
        );
        return g;
      });

      function drawGraph() {
        const active = isEqActive();
        const bStates = bands.map((b) => ({
          type: Number(store.getVal(b.t, 11)),
          freq: Number(store.getVal(b.f, 1000)),
          gain: Number(store.getVal(b.g, 0)),
          q: Number(store.getVal(b.q, 1)),
        }));

        const pts = new Array(EQ_GRID.length);
        for (let i = 0; i < EQ_GRID.length; i++) {
          const { x, freq } = EQ_GRID[i];
          let db = 0;
          if (dspEditable) {
            for (let j = 0; j < bStates.length; j++) db += evalEqBandDb(freq, bStates[j]);
          }
          pts[i] = `${i === 0 ? "M" : "L"}${x} ${dbToY(db).toFixed(1)}`;
        }
        const dStr = pts.join(" ");
        curvePath.setAttribute("d", dStr);
        curvePath.setAttribute("opacity", active ? "1" : "0.35");
        fillPath.setAttribute("d", `${dStr} L380 48 L0 48 Z`);
        fillPath.setAttribute("opacity", active ? "1" : "0");

        nodeEls.forEach((g, i) => {
          const bs = bStates[i];
          const nx = freqToX(bs.freq);
          const ny = bs.type === 3 || bs.type === 1 || bs.type === 11 ? 48 : dbToY(bs.gain);
          g.style.left = `${((nx / 380) * 100).toFixed(2)}%`;
          g.style.top = `${((ny / 96) * 100).toFixed(2)}%`;
          g.classList.toggle("selected", i === selectedEqBand);
          g.classList.toggle("bypassed", !active || bs.type === 11);
        });

        const sb = bStates[selectedEqBand];
        if (sb) {
          const gStr = sb.gain > 0 ? `+${sb.gain.toFixed(1)}` : sb.gain.toFixed(1);
          readoutEl.textContent = `B${selectedEqBand + 1} · ${fmtFreqShort(sb.freq)}Hz · ${gStr}dB · Q${sb.q.toFixed(1)}`;
        }
      }

      function syncSelectedBandControls() {
        const b = curBand();
        bandPills.forEach((p) => p.classList.toggle("active", Number(p.dataset.band) === selectedEqBand));
        if (!b) return;
        const tv = Number(store.getVal(b.t, 11));
        selType.value = String(tv);
        selType.disabled = !dspEditable;
        kFreq.setValue(Number(store.getVal(b.f, 1000)));
        kGain.setValue(Number(store.getVal(b.g, 0)));
        kQ.setValue(Number(store.getVal(b.q, 1)));
        const bandOff = !dspEditable || tv === 11;
        kFreq.setDisabled(bandOff);
        kGain.setDisabled(bandOff || tv === 3 || tv === 1);
        kQ.setDisabled(bandOff);
        drawGraph();
      }

      function selectBand(idx) {
        selectedEqBand = idx;
        syncSelectedBandControls();
      }

      bandPills.forEach((p) => p.addEventListener("click", () => selectBand(Number(p.dataset.band))));

      selType.addEventListener("change", () => {
        const b = curBand();
        if (b && dspEditable) {
          ensureEqEngaged();
          store.setParam(b.t, Number(selType.value));
          syncSelectedBandControls();
        }
      });

      btnFlat.addEventListener("click", () => {
        if (!dspEditable) return;
        bands.forEach((b, idx) => {
          const def = EQ_DEFAULT_BANDS[idx] || EQ_DEFAULT_BANDS[1];
          if (b.t) store.setParam(b.t, def.t);
          if (b.f) store.setParam(b.f, def.f);
          if (b.g) store.setParam(b.g, def.g);
          if (b.q) store.setParam(b.q, def.q);
        });
        syncSelectedBandControls();
      });

      const syncEqOn = () => {
        const on = isEqActive();
        btnOn.classList.toggle("active", on);
        btnFlat.disabled = !dspEditable;
        const faded = !on;
        content.querySelector("#ieqBandPills")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".eq-type-row")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".insp-eq-graph-mod")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".insp-eq-knobs-mod")?.classList.toggle("is-bypassed", faded);
        syncSelectedBandControls();
      };
      btnOn.addEventListener("click", () => dspEditable && store.toggleParam(eqBypsPath));
      bindInsp(eqBypsPath, syncEqOn);
      bands.forEach((b) => [b.t, b.f, b.g, b.q].forEach((p) => bindInsp(p, syncSelectedBandControls)));
      syncEqOn();
      return;
    }

    // 4) INLINE COMPRESSOR SUB-TAB (6 FLAT WHITE KNOBS + LIVE AUDIENT GR METER)
    if (inspectorTab === "comp") {
      const srLabel = store.getOptionLabel(store.paths.sampleRate, "192kHz");

      content.innerHTML = `
        <div class="insp-module insp-comp-ctrl">
          <div class="insp-eq-top">
            <span class="micro-label">COMP</span>
            <button class="mini-pill-btn green-active" id="icompOn" ${dspEditable ? "" : "disabled"}>ON</button>
          </div>
          <div class="insp-comp-order-wrap">
            <span class="micro-label">DSP ORDER</span>
            <div class="seg-group full-width" id="iOrderSeg">
              <button class="seg-btn" data-val="0" ${dspEditable ? "" : "disabled"}>EQ → C</button>
              <button class="seg-btn" data-val="1" ${dspEditable ? "" : "disabled"}>C → EQ</button>
            </div>
          </div>
          <div class="insp-comp-bottom">
            ${dspEditable ? `<span class="insp-comp-spacer"></span>` : `<span class="dsp-lock-pill comp-lock-tag">LOCKED · ${srLabel}</span>`}
            <button class="mini-pill-btn eq-flat-btn" id="icompReset" title="Reset Compressor to default profile" ${dspEditable ? "" : "disabled"}>RESET</button>
          </div>
        </div>

        <div class="insp-module insp-comp-knobs-mod">
          <div class="comp-knobs-row" id="icKnobs"></div>
        </div>

        <div class="insp-module insp-comp-gr-mod">
          <div class="insp-mod-head">
            <span class="micro-label">GAIN REDUCTION</span>
            <span class="comp-gr-readout" id="icGrVal">0.0 dB</span>
          </div>
          <div class="comp-gr-oled">
            <div class="comp-gr-track"><div class="comp-gr-bar" id="icGrBar"></div></div>
            <div class="comp-gr-ticks">
              <span>20</span><span>15</span><span>10</span><span>6</span><span>3</span><span>0</span>
            </div>
          </div>
        </div>
      `;

      inspectorGrBar = content.querySelector("#icGrBar");
      inspectorGrVal = content.querySelector("#icGrVal");

      const btnOn = content.querySelector("#icompOn");
      const isCompActive = () => dspEditable && !store.getVal(compBypsPath, 1);
      const ensureCompEngaged = () => {
        if (dspEditable && compBypsPath && store.getVal(compBypsPath, 1)) {
          store.setParam(compBypsPath, 0);
        }
      };

      const ordBtns = Array.from(content.querySelectorAll("#iOrderSeg .seg-btn"));
      const syncOrd = () => {
        const v = store.getVal(orderPath, 0);
        ordBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
      };
      ordBtns.forEach((b) => b.addEventListener("click", () => dspEditable && store.setParam(orderPath, Number(b.dataset.val))));
      bindInsp(orderPath, syncOrd);
      syncOrd();

      const knobsHost = content.querySelector("#icKnobs");
      const fmtAttackMs = (v) => {
        if (v < 10) return v.toFixed(1);
        if (v >= 10000) return "10k";
        if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
        return String(Math.round(v));
      };
      const fmtReleaseSec = (v) => {
        const s = v / 1000;
        if (s < 1) return s.toFixed(2);
        return s.toFixed(1);
      };
      const compKnobSpecs = [
        { name: "Threshold", label: "THRESH", sub: "DB", min: -60, max: 0, wheelStep: 1, defaultVal: 0 },
        {
          name: "Ratio", label: "RATIO", sub: ":1", min: 2, max: 16, steps: [2, 4, 8, 16],
          roundOnSettle: true, decimals: 0, defaultVal: 2,
          formatValue: (v) => String(Math.round(v)),
        },
        {
          name: "Attack", label: "ATTACK", sub: "MS", min: 3.3333333333333335, max: 10000, logScale: true,
          roundOnSettle: false, decimals: 1, defaultVal: 10, formatValue: fmtAttackMs,
        },
        {
          name: "Release", label: "RELEASE", sub: "S", min: 3.3333333333333335, max: 10000, logScale: true,
          roundOnSettle: false, decimals: 1, defaultVal: 100, formatValue: fmtReleaseSec,
        },
        { name: "Makeup", label: "MAKEUP", sub: "DB", min: 0, max: 12, roundOnSettle: false, decimals: 1, wheelStep: 1, defaultVal: 0 },
        { name: "Blend", label: "MIX", sub: "%", min: 0, max: 100, scale: 100, wheelStep: 1, defaultVal: 100 },
      ];

      const compKnobs = [];
      const compKnobEntries = new Map();
      compKnobSpecs.forEach((sp) => {
        const p = compPath ? store.findParamPath(compPath, sp.name) : null;
        const unit = document.createElement("div");
        unit.className = "insp-knob-unit";
        unit.innerHTML = `
          <span class="micro-label">${sp.label}</span>
          <div class="insp-knob-comp" id="ck"></div>
          <span class="knob-sub-unit">${sp.sub}</span>
        `;
        knobsHost.appendChild(unit);

        const rawInit = p ? Number(store.getVal(p, sp.defaultVal / (sp.scale || 1))) : sp.defaultVal / (sp.scale || 1);
        const knob = createKnob(unit.querySelector("#ck"), {
          min: sp.min,
          max: sp.max,
          muteAtMin: false,
          compact: true,
          logScale: Boolean(sp.logScale),
          steps: sp.steps ?? null,
          roundOnSettle: sp.roundOnSettle ?? true,
          decimals: sp.decimals ?? 0,
          wheelStep: sp.wheelStep ?? 1,
          formatValue: sp.formatValue ?? null,
          defaultValue: sp.scale ? Math.round(rawInit * sp.scale) : rawInit,
          onChange: (v) => {
            if (!p || !dspEditable) return;
            ensureCompEngaged();
            store.setParam(p, sp.scale ? v / sp.scale : v);
          },
        });
        compKnobs.push(knob);
        compKnobEntries.set(sp.name, { path: p, knob, scale: sp.scale || 1 });

        if (p) {
          bindInsp(p, (val) => {
            if (typeof val === "number") knob.setValue(sp.scale ? val * sp.scale : val);
          });
        }
      });

      const btnCompReset = content.querySelector("#icompReset");
      btnCompReset.addEventListener("click", () => {
        if (!dspEditable) return;
        for (const [name, defVal] of Object.entries(COMP_DEFAULTS)) {
          const entry = compKnobEntries.get(name);
          if (entry?.path) {
            store.setParam(entry.path, defVal);
            entry.knob.setValue(entry.scale !== 1 ? Math.round(defVal * entry.scale) : defVal);
          }
        }
      });

      const syncCompOn = () => {
        const on = isCompActive();
        btnOn.classList.toggle("active", on);
        btnCompReset.disabled = !dspEditable;
        compKnobs.forEach((k) => k.setDisabled(!dspEditable));
        const faded = !on;
        content.querySelector(".insp-comp-order-wrap")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".insp-comp-bottom")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".insp-comp-knobs-mod")?.classList.toggle("is-bypassed", faded);
        content.querySelector(".insp-comp-gr-mod")?.classList.toggle("is-bypassed", faded);
      };
      btnOn.addEventListener("click", () => dspEditable && store.toggleParam(compBypsPath));
      bindInsp(compBypsPath, syncCompOn);
      syncCompOn();
    }
  }

  function cleanupAll() {
    for (const rec of pairRecords) rec.cleanup();
    pairRecords = [];
    busParamBindings.clear();
  }

  function getSourceNames() {
    const names = [];
    const mixerPath = store.paths.mixer;
    if (!mixerPath) return names;
    const srcPath = store.findChildPath(mixerPath, (c) => c.tag === "Sources");
    const srcNode = store.getNode(srcPath);
    if (!srcNode?.children) return names;
    for (let i = 0; i < srcNode.children.length; i++) {
      const chPath = [...srcPath, i];
      const nameParam = store.findParamPath(chPath, "name");
      names.push(store.getVal(nameParam, `CH ${i + 1}`));
    }
    return names;
  }

  function buildBusHeaderExtras(mixPath) {
    busMasterSlot.innerHTML = "";
    const volPath = store.findParamPath(mixPath, "Vol");
    if (volPath && store.isEditable(volPath)) {
      const volVal = store.getVal(volPath, 0);
      const wrap = document.createElement("div");
      wrap.className = "bus-vol-inline";
      wrap.innerHTML = `
        <span class="micro-label">BUS LEVEL</span>
        <input type="range" class="mini-slider" min="-128" max="0" step="1" value="${Math.round(volVal)}" />
        <span class="bus-vol-val">${volVal <= -128 ? "-∞" : `${Math.round(volVal)} dB`}</span>
      `;
      const slider = wrap.querySelector("input");
      const valLabel = wrap.querySelector(".bus-vol-val");
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        valLabel.textContent = v <= -128 ? "-∞" : `${v} dB`;
        store.setParam(volPath, v);
      });
      bindBusParam(volPath, (v) => {
        if (typeof v === "number") {
          slider.value = String(Math.round(v));
          valLabel.textContent = v <= -128 ? "-∞" : `${Math.round(v)} dB`;
        }
      });
      busMasterSlot.appendChild(wrap);
    }
  }

  function rebuildMixer() {
    cleanupAll();
    stripsEl.innerHTML = "";

    const mixerPath = store.paths.mixer;
    if (!mixerPath) {
      stripsEl.innerHTML = `<div class="phase-placeholder"><span class="phase-tag">WAITING FOR DEVICE</span><h3>Connecting to AudientDeviceManager…</h3></div>`;
      return;
    }

    const mixPath = [...mixerPath, activeBusIdx];
    const mixNode = store.getNode(mixPath);
    if (!mixNode?.children) return;

    const topo = store.getDeviceTopology();
    btnToggleDig.style.display = topo.hasDigital ? "" : "none";
    btnToggleDig.textContent = showDigital ? "HIDE DIG" : "SHOW DIG";

    buildBusHeaderExtras(mixPath);
    buildInspector();
    const srcNames = getSourceNames();

    mixNode.children.forEach((child, ci) => {
      if (child.tag !== "Pair") return;
      const pairIdx = child.props?.index ?? ci - 1;
      const meta = topo.pairs[pairIdx] || {
        nums: [pairIdx * 2 + 1, pairIdx * 2 + 2],
        group: "host",
        base: 0,
        isDig: false,
        isAnalog: false,
        isReverb: false,
        accent: "accent-out",
        tag: `${topo.shortName} · CH`,
        tags: ["1", "2"],
        inputChs: null,
      };
      if (meta.isDig && !showDigital) return;

      const pairPath = [...mixPath, ci];
      const linkPath = store.findParamPath(pairPath, "StereoLink");
      const linkKey = linkPath ? pathKey(linkPath) : null;

      const ch0Path = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 0) || [...pairPath, 1];
      const ch1Path = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 1) || [...pairPath, 2];

      const shortChName = (name) => String(name || "").replace(/^Computer\s+Out\b/i, "Comp Out");
      const ch0 = {
        path: ch0Path,
        name: shortChName(srcNames[pairIdx * 2] || store.getNode(ch0Path)?.props?.name || `CH ${meta.nums[0]}`),
        vol: store.findParamPath(ch0Path, "Vol"),
        pan: store.findParamPath(ch0Path, "Pan"),
        mute: store.findParamPath(ch0Path, "Mute"),
        solo: store.findParamPath(ch0Path, "Solo"),
      };
      const ch1 = {
        path: ch1Path,
        name: shortChName(srcNames[pairIdx * 2 + 1] || store.getNode(ch1Path)?.props?.name || `CH ${meta.nums[1]}`),
        vol: store.findParamPath(ch1Path, "Vol"),
        pan: store.findParamPath(ch1Path, "Pan"),
        mute: store.findParamPath(ch1Path, "Mute"),
        solo: store.findParamPath(ch1Path, "Solo"),
      };

      const pairCard = document.createElement("div");
      pairCard.className = `mixer-pair ${meta.accent}`;
      stripsEl.appendChild(pairCard);

      const localParams = new Map();
      const bindLocal = (path, fn) => {
        if (!path) return;
        const k = pathKey(path);
        if (!localParams.has(k)) localParams.set(k, []);
        localParams.get(k).push(fn);
      };

      let isStereo = Boolean(store.getVal(linkPath, 0));
      const inspCh0 = meta.inputChs ? meta.inputChs[0] : meta.isReverb ? topo.reverbChannelId : null;
      const inspCh1 = meta.inputChs ? meta.inputChs[1] : meta.isReverb ? topo.reverbChannelId : null;
      const inspAttr0 = inspCh0 != null ? `data-inspect-ch="${inspCh0}"` : "";
      const inspAttr1 = inspCh1 != null ? `data-inspect-ch="${inspCh1}"` : "";

      const customNames = store.getUiPref("channelNames", {}) || {};
      const key0 = `ch_${meta.nums[0]}`;
      const key1 = `ch_${meta.nums[1]}`;
      const dispName0 = customNames[key0] || ch0.name;
      const dispName1 = customNames[key1] || ch1.name;

      pairCard.innerHTML = `
        <div class="pair-inner pair-fixed">
          <div class="pair-center-divider"></div>

          <div class="pair-head-row">
            <div class="strip-head clickable-head head-left" ${inspAttr0}>
              <div class="strip-nums">${meta.nums[0]}</div>
              <div class="strip-subtag">${meta.tag} ${meta.tags[0]}<span class="pip-48" id="pip48_0" title="48V Phantom Power ON"></span></div>
              <div class="strip-name scribble-name" id="name0" title="Double-click to rename">${dispName0}</div>
            </div>
            <span class="pair-plus-glyph" aria-hidden="true">+</span>
            <div class="strip-head clickable-head head-right" ${inspAttr1}>
              <div class="strip-nums">${meta.nums[1]}</div>
              <div class="strip-subtag">${meta.tag} ${meta.tags[1]}<span class="pip-48" id="pip48_1" title="48V Phantom Power ON"></span></div>
              <div class="strip-name scribble-name" id="name1" title="Double-click to rename">${dispName1}</div>
            </div>
          </div>

          <div class="pair-pan-bridge">
            <div class="pan-slot pan-left">
              <div class="pan-knob-host" id="pan0"></div>
              <div class="pan-lr"><span>L</span><span>R</span></div>
            </div>
            <div class="pan-link-connector">
              <span class="pan-link-line"></span>
              <button class="link-pill pan-link-pill" id="btnLink" title="Toggle Mono / Stereo Link">MONO</button>
              <span class="pan-link-line"></span>
            </div>
            <div class="pan-slot pan-right">
              <div class="pan-knob-host" id="pan1"></div>
              <div class="pan-lr"><span>L</span><span>R</span></div>
            </div>
          </div>

          <div class="pair-ms-area">
            <div class="strip-ms-row ms-left">
              <button class="ms-btn mute-btn" id="btnMute0">MUTE</button>
              <button class="ms-btn solo-btn" id="btnSolo0">SOLO</button>
            </div>
            <div class="strip-ms-row ms-right">
              <button class="ms-btn mute-btn" id="btnMute1">MUTE</button>
              <button class="ms-btn solo-btn" id="btnSolo1">SOLO</button>
            </div>
          </div>

          <div class="pair-peak-row">
            <div class="pair-peak-cell" id="peak0"></div>
            <div class="pair-peak-cell" id="peak1"></div>
          </div>

          <div class="pair-stage">
            <div class="stage-slot slot-meter-0" id="meter0"></div>
            <div class="stage-slot slot-fader-0" id="fader0"></div>
            <div class="stage-slot slot-meter-1" id="meter1"></div>
            <div class="stage-slot slot-fader-1" id="fader1"></div>
          </div>

          <div class="pair-db-row">
            <div class="strip-db-readout db-left" id="db0">0 dB</div>
            <div class="strip-db-readout db-right" id="db1">0 dB</div>
          </div>
        </div>
      `;

      if (inspCh0 != null) {
        pairCard.querySelector(".head-left").addEventListener("click", () => selectInspectedChannel(inspCh0, "strip"));
      }
      if (inspCh1 != null) {
        pairCard.querySelector(".head-right").addEventListener("click", () => selectInspectedChannel(inspCh1, "strip"));
      }

      // Scribble strip inline rename (double-click channel label)
      function wireScribble(el, key, defaultName) {
        if (!el) return;
        el.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          const curText = el.textContent.trim();
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "scribble-input";
          inp.maxLength = 14;
          inp.value = curText;
          el.textContent = "";
          el.appendChild(inp);
          inp.focus();
          inp.select();
          const commit = (cancel = false) => {
            if (!inp.isConnected) return;
            const next = cancel ? curText : inp.value.trim();
            const map = { ...(store.getUiPref("channelNames", {}) || {}) };
            if (!next || next.toUpperCase() === defaultName.toUpperCase()) {
              delete map[key];
              el.textContent = defaultName;
            } else {
              map[key] = next;
              el.textContent = next;
            }
            if (!cancel) store.saveUiPref("channelNames", map);
          };
          inp.addEventListener("click", (ev) => ev.stopPropagation());
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); commit(false); }
            else if (ev.key === "Escape") { ev.preventDefault(); commit(true); }
          });
          inp.addEventListener("blur", () => commit(false));
        });
      }
      wireScribble(pairCard.querySelector("#name0"), key0, ch0.name);
      wireScribble(pairCard.querySelector("#name1"), key1, ch1.name);

      // Subtle 48V phantom power indicator pip on analog mic channels (invisible when OFF)
      if (meta.isAnalog && meta.inputChs) {
        [0, 1].forEach((side) => {
          const inCh = getInputChannelPath(meta.inputChs[side]);
          const p48 = inCh ? store.findParamPath(inCh, "48V") : null;
          const pip = pairCard.querySelector(`#pip48_${side}`);
          if (p48 && pip) {
            const syncPip = () => pip.classList.toggle("on", Boolean(store.getVal(p48, 0)));
            bindLocal(p48, syncPip);
            syncPip();
          }
        });
      }

      const pan0 = createKnob(pairCard.querySelector("#pan0"), {
        min: -64, max: 64, centerZero: true, muteAtMin: false, showUnit: false, compact: true, showTicks: false,
        defaultValue: store.getVal(ch0.pan, 0),
        onChange: (v) => store.setParam(ch0.pan, v),
      });
      const pan1 = createKnob(pairCard.querySelector("#pan1"), {
        min: -64, max: 64, centerZero: true, muteAtMin: false, showUnit: false, compact: true, showTicks: false,
        defaultValue: store.getVal(ch1.pan, 0),
        onChange: (v) => store.setParam(ch1.pan, v),
      });
      bindLocal(ch0.pan, (v) => pan0.setValue(v));
      bindLocal(ch1.pan, (v) => pan1.setValue(v));

      const btnLink = pairCard.querySelector("#btnLink");
      const btnMute0 = pairCard.querySelector("#btnMute0");
      const btnSolo0 = pairCard.querySelector("#btnSolo0");
      const btnMute1 = pairCard.querySelector("#btnMute1");
      const btnSolo1 = pairCard.querySelector("#btnSolo1");

      const syncMS = () => {
        const m0 = Boolean(store.getVal(ch0.mute, 0));
        const m1 = Boolean(store.getVal(ch1.mute, 0));
        const s0 = Boolean(store.getVal(ch0.solo, 0));
        const s1 = Boolean(store.getVal(ch1.solo, 0));
        btnMute0.classList.toggle("active", isStereo ? (m0 || m1) : m0);
        btnMute1.classList.toggle("active", isStereo ? (m0 || m1) : m1);
        btnSolo0.classList.toggle("active", isStereo ? (s0 || s1) : s0);
        btnSolo1.classList.toggle("active", isStereo ? (s0 || s1) : s1);
      };

      const toggleMute = (side) => {
        if (isStereo) {
          const next = (store.getVal(ch0.mute, 0) || store.getVal(ch1.mute, 0)) ? 0 : 1;
          store.setParam(ch0.mute, next);
          store.setParam(ch1.mute, next);
        } else {
          store.toggleParam(side === 0 ? ch0.mute : ch1.mute);
        }
      };
      const toggleSolo = (side) => {
        if (isStereo) {
          const next = (store.getVal(ch0.solo, 0) || store.getVal(ch1.solo, 0)) ? 0 : 1;
          store.setParam(ch0.solo, next);
          store.setParam(ch1.solo, next);
        } else {
          store.toggleParam(side === 0 ? ch0.solo : ch1.solo);
        }
      };

      btnMute0.addEventListener("click", () => toggleMute(0));
      btnMute1.addEventListener("click", () => toggleMute(1));
      btnSolo0.addEventListener("click", () => toggleSolo(0));
      btnSolo1.addEventListener("click", () => toggleSolo(1));
      bindLocal(ch0.mute, syncMS);
      bindLocal(ch1.mute, syncMS);
      bindLocal(ch0.solo, syncMS);
      bindLocal(ch1.solo, syncMS);

      const meter0 = createMonoMeter(pairCard.querySelector("#meter0"), {
        scaleSide: "left",
        peakContainer: pairCard.querySelector("#peak0"),
      });
      const meter1 = createMonoMeter(pairCard.querySelector("#meter1"), {
        scaleSide: "left",
        peakContainer: pairCard.querySelector("#peak1"),
      });

      const db0El = pairCard.querySelector("#db0");
      const db1El = pairCard.querySelector("#db1");
      const setDbReadout = (el, v) => {
        if (v <= FADER_MIN) {
          el.innerHTML = INF_SVG;
        } else {
          const r = Math.round(v);
          el.textContent = r > 0 ? `+${r} dB` : `${r} dB`;
        }
      };

      let fader0, fader1;
      const initV0 = store.getVal(ch0.vol, 0);
      const initV1 = store.getVal(ch1.vol, 0);

      fader0 = createFader(pairCard.querySelector("#fader0"), {
        defaultValue: initV0,
        onChange: (v) => {
          setDbReadout(db0El, v);
          store.setParam(ch0.vol, v);
          if (isStereo) {
            setDbReadout(db1El, v);
            fader1?.setValue(v, true);
            store.setParam(ch1.vol, v);
          }
        },
      });
      fader1 = createFader(pairCard.querySelector("#fader1"), {
        defaultValue: initV1,
        onChange: (v) => {
          setDbReadout(db1El, v);
          store.setParam(ch1.vol, v);
          if (isStereo) {
            setDbReadout(db0El, v);
            fader0?.setValue(v, true);
            store.setParam(ch0.vol, v);
          }
        },
      });
      setDbReadout(db0El, initV0);
      setDbReadout(db1El, initV1);

      // Click-to-type exact dB value on fader readout
      function wireDbType(el, getVal, applyVal) {
        el.title = "Double-click to type exact dB";
        el.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          const cur = getVal();
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "db-type-input";
          inp.value = cur <= FADER_MIN ? "-128" : String(Math.round(cur));
          el.textContent = "";
          el.appendChild(inp);
          inp.focus();
          inp.select();
          const commit = (cancel = false) => {
            if (!inp.isConnected) return;
            const parsed = parseFloat(inp.value.trim());
            if (!cancel && Number.isFinite(parsed)) {
              const clamped = Math.round(Math.max(FADER_MIN, Math.min(FADER_MAX, parsed)));
              applyVal(clamped);
            } else {
              setDbReadout(el, getVal());
            }
          };
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); commit(false); }
            else if (ev.key === "Escape") { ev.preventDefault(); commit(true); }
          });
          inp.addEventListener("blur", () => commit(false));
        });
      }
      wireDbType(db0El, () => fader0.getValue(), (v) => {
        fader0.setValue(v, true);
        setDbReadout(db0El, v);
        store.setParam(ch0.vol, v);
        if (isStereo) {
          fader1.setValue(v, true);
          setDbReadout(db1El, v);
          store.setParam(ch1.vol, v);
        }
      });
      wireDbType(db1El, () => fader1.getValue(), (v) => {
        fader1.setValue(v, true);
        setDbReadout(db1El, v);
        store.setParam(ch1.vol, v);
        if (isStereo) {
          fader0.setValue(v, true);
          setDbReadout(db0El, v);
          store.setParam(ch0.vol, v);
        }
      });

      bindLocal(ch0.vol, (v) => {
        if (isStereo && (fader0.isInteracting() || fader1.isInteracting())) return;
        fader0.setValue(v);
        setDbReadout(db0El, v);
        if (isStereo) {
          fader1.setValue(v);
          setDbReadout(db1El, v);
        }
      });
      bindLocal(ch1.vol, (v) => {
        if (isStereo && (fader0.isInteracting() || fader1.isInteracting())) return;
        fader1.setValue(v);
        setDbReadout(db1El, v);
        if (isStereo) {
          fader0.setValue(v);
          setDbReadout(db0El, v);
        }
      });

      const preampLinkPath =
        meta.isAnalog && meta.inputChs && getInputChannelPath(meta.inputChs[0])
          ? store.findParamPath(getInputChannelPath(meta.inputChs[0]), "StereoLink")
          : null;

      const syncLinkState = (overrideVal = null) => {
        isStereo = overrideVal !== null ? Boolean(overrideVal) : Boolean(store.getVal(linkPath, 0));
        pairCard.classList.toggle("is-stereo", isStereo);
        pairCard.classList.toggle("is-mono", !isStereo);
        btnLink.classList.toggle("active", isStereo);
        btnLink.textContent = isStereo ? "STEREO" : "MONO";
        if (isStereo) {
          const v0 = fader0.getValue();
          fader1.setValue(v0, true);
          setDbReadout(db1El, v0);
        }
        syncMS();
        highlightSelectedChannel();
      };

      btnLink.addEventListener("click", () => {
        if (!linkPath) return;
        const next = isStereo ? 0 : 1;
        store.setParam(linkPath, next);
        if (preampLinkPath) store.setParam(preampLinkPath, next);
        if (next === 1) {
          const v0 = fader0.getValue();
          const m = store.getVal(ch0.mute, 0) || store.getVal(ch1.mute, 0) ? 1 : 0;
          const s = store.getVal(ch0.solo, 0) || store.getVal(ch1.solo, 0) ? 1 : 0;
          store.setParam(ch1.vol, v0);
          store.setParam(ch0.mute, m);
          store.setParam(ch1.mute, m);
          store.setParam(ch0.solo, s);
          store.setParam(ch1.solo, s);
          store.setParam(ch0.pan, -64);
          store.setParam(ch1.pan, 64);
          pan0.setValue(-64);
          pan1.setValue(64);
        } else {
          store.setParam(ch0.pan, 0);
          store.setParam(ch1.pan, 0);
          pan0.setValue(0);
          pan1.setValue(0);
        }
        syncLinkState(next);
      });

      syncLinkState();

      pairRecords.push({
        linkKey,
        syncLinkState,
        cleanup() {
          meter0.destroy();
          meter1.destroy();
          localParams.clear();
        },
        handleParam(k, value) {
          const cbs = localParams.get(k);
          if (cbs) cbs.forEach((fn) => fn(value));
        },
        updateMeters(mf) {
          const arr = mf[meta.group] || [];
          meter0.setLevel(arr[meta.base] ?? -128);
          meter1.setLevel(arr[meta.base + 1] ?? -128);
        },
      });
    });

    highlightSelectedChannel();
  }

  let inspRebuildTimer = null;
  function scheduleInspectorRebuild() {
    clearTimeout(inspRebuildTimer);
    inspRebuildTimer = setTimeout(() => {
      inspRebuildTimer = null;
      buildInspector();
    }, 40);
  }

  store.onUiPrefs((prefs) => {
    let changed = false;
    if (Number.isInteger(prefs.mixerBus) && prefs.mixerBus >= 0 && prefs.mixerBus <= 3) {
      activeBusIdx = prefs.mixerBus;
      store.setActiveMixBus(activeBusIdx);
      busBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.bus) === activeBusIdx));
      changed = true;
    }
    if (typeof prefs.showDigital === "boolean") {
      showDigital = prefs.showDigital;
      btnToggleDig.classList.toggle("active", showDigital);
      btnToggleDig.textContent = showDigital ? "HIDE DIG" : "SHOW DIG";
      changed = true;
    }
    if (typeof prefs.inspectorOpen === "boolean") {
      inspectorOpen = prefs.inspectorOpen;
      btnToggleInspector.classList.toggle("active", inspectorOpen);
      inspectorEl.style.display = inspectorOpen ? "flex" : "none";
      changed = true;
    }
    if (Number.isInteger(prefs.inspectedChannel) && prefs.inspectedChannel >= 0) {
      inspectedChannel = prefs.inspectedChannel;
      changed = true;
    }
    if (prefs.inspectorTab === "strip" || prefs.inspectorTab === "eq" || prefs.inspectorTab === "comp") {
      inspectorTab = prefs.inspectorTab;
      changed = true;
    }
    if (changed && store.paths.mixer) {
      rebuildMixer();
    }
  });

  store.onSnapshot(() => {
    rebuildMixer();
    if (activeSceneIdx === -1 && store.paths.mixer && !store.getUiPref("workingScene", null)) {
      persistWorkingSceneNow();
    }
  });
  store.onParam((changedPath, prop, value) => {
    const k = pathKey(changedPath);
    if (prop === "editable" || (store.paths.sampleRate && pathKey(store.paths.sampleRate) === k)) {
      scheduleInspectorRebuild();
    }
    if (prop === "value") {
      scheduleWorkingSceneSave();
    }
    const busCbs = busParamBindings.get(k);
    if (busCbs) busCbs.forEach((fn) => fn(value));

    const inspCbs = inspectorBindings.get(k);
    if (inspCbs) inspCbs.forEach((fn) => fn(value));

    for (const rec of pairRecords) {
      if (rec.linkKey === k) {
        rec.syncLinkState();
        return;
      }
      rec.handleParam(k, value);
    }
  });

  store.onMeters((mf) => {
    for (const rec of pairRecords) {
      rec.updateMeters(mf);
    }
    if (inspectorGrBar && inspectorGrVal && inspectedChannel < store.getDeviceTopology().reverbChannelId) {
      const gr = mf.comp_gr?.[inspectedChannel] ?? 0;
      inspectorGrBar.style.width = `${Math.min(100, (Math.abs(gr) / 20) * 100).toFixed(1)}%`;
      inspectorGrVal.textContent = `${gr.toFixed(1)} dB`;
    }
  });

  rebuildMixer();

  return {
    recallScene(idx) {
      if (activeSceneIdx === idx) {
        returnToWorkingScene();
        return true;
      }
      return recallScene(idx);
    },
    flushWorkingScene() {
      return persistWorkingSceneNow();
    },
  };
}
