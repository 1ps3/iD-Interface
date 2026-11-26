// Preamps, Analogue Tone Suite (PUNCH/SMOOTH/VINTAGE, AIR, HMX, ORBIT),
// SmartGain, and Onboard 4-Band Parametric EQ + Compressor + Live GR Meter

import { createKnob } from "../components/knob.js";
import { createMonoMeter } from "../components/meter.js";
import { pathKey } from "../store.js";

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

function fmtFreqShort(hz) {
  const f = Math.round(hz);
  if (f >= 10000) return `${(f / 1000).toFixed(0)}k`;
  if (f >= 1000) return `${(f / 1000).toFixed(1)}k`;
  return String(f);
}

function fmtAttackMs(v) {
  if (v < 10) return v.toFixed(1);
  if (v >= 10000) return "10k";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtReleaseSec(v) {
  const s = v / 1000;
  if (s < 1) return s.toFixed(2);
  return s.toFixed(1);
}

const IMP_OPTIONS = [
  { value: 0, name: "PUNCH", cls: "orbit-punch" },
  { value: 1, name: "SMOOTH", cls: "orbit-smooth" },
  { value: 3, name: "VINTAGE", cls: "orbit-vintage" },
];

// Approximate magnitude response (dB) of 4-band EQ for visual preview curve
function evalBandDb(freq, b) {
  if (b.type === 11 || b.type === 13) return 0; // Bypass / All-pass
  if (b.type === 14) return -24;
  const f0 = Math.max(20, b.freq || 1000);
  const q = Math.max(0.5, b.q || 1.0);
  const g = b.gain || 0;
  const ratio = freq / f0;
  const logDist = Math.log2(ratio);

  if (b.type === 8) {
    // Parametric bell
    const bw = 1 / q;
    return g * Math.exp(-0.5 * Math.pow(logDist / (bw * 0.55), 2));
  }
  if (b.type === 5) {
    // Low shelf
    const t = 1 / (1 + Math.pow(ratio, 2 * Math.min(2, q)));
    return g * t;
  }
  if (b.type === 7) {
    // High shelf
    const t = 1 / (1 + Math.pow(1 / ratio, 2 * Math.min(2, q)));
    return g * t;
  }
  if (b.type === 3) {
    // High-pass 12dB/oct
    const mag = 1 / Math.sqrt(1 + Math.pow(1 / ratio, 4));
    return Math.max(-18, 20 * Math.log10(mag));
  }
  if (b.type === 1) {
    // Low-pass 12dB/oct
    const mag = 1 / Math.sqrt(1 + Math.pow(ratio, 4));
    return Math.max(-18, 20 * Math.log10(mag));
  }
  return 0;
}

export function createPreampsView(container, store) {
  let selectedDspCh = 0; // 0=Mic 1, 1=Mic 2, 2..9=DIG 1..8
  let selectedEqBand = 0; // 0..3
  // Per-channel A/B Compare memory for EQ & Compressor
  const eqAbMemory = new Map();   // chIdx -> { slot: 'A'|'B', A: bands|null, B: bands|null }
  const compAbMemory = new Map(); // chIdx -> { slot: 'A'|'B', A: vals|null, B: vals|null }
  let inputMeters = [];
  let grBarEl = null;
  let grValEl = null;
  let paramBindings = new Map();
  let dspBindings = new Map();

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2 class="view-title">PREAMPS &amp; DSP</h2>
        <p class="view-subtitle">Console Mic Preamps, Analogue Tone Suite, SmartGain &amp; Zero-Latency DSP</p>
      </div>
      <div class="smartgain-quick" id="smartGainBar"></div>
    </div>

    <div class="preamp-grid" id="preampGrid"></div>

    <div class="dsp-panel" id="dspPanel"></div>
  `;

  const sgBar = container.querySelector("#smartGainBar");
  const preampGrid = container.querySelector("#preampGrid");
  const dspPanel = container.querySelector("#dspPanel");

  function bind(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!paramBindings.has(k)) paramBindings.set(k, []);
    paramBindings.get(k).push(fn);
  }

  function bindDsp(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!dspBindings.has(k)) dspBindings.set(k, []);
    dspBindings.get(k).push(fn);
  }

  function cleanup() {
    inputMeters.forEach((m) => m.destroy());
    inputMeters = [];
    paramBindings.clear();
    dspBindings.clear();
    grBarEl = null;
    grValEl = null;
  }

  function getChannelPath(chIdx) {
    const inputs = store.paths.inputs;
    if (!inputs) return null;
    return store.findChildPath(inputs, (c) => c.tag === "Channel" && c.props?.index === chIdx);
  }

  function buildSmartGain() {
    sgBar.innerHTML = "";
    const inputs = store.paths.inputs;
    if (!inputs) return;
    const sgPath = store.findChildPath(inputs, (c) => c.tag === "SmartGain");
    if (!sgPath) return;

    const statusPath = store.findParamPath(sgPath, "Status");
    const triggerPath = store.findParamPath(sgPath, "Trigger");
    const topo = store.getDeviceTopology();
    const analogChs = topo.inputChannels.filter((c) => c.isAnalog);

    const armEntries = analogChs
      .map((ch) => {
        const chPath = getChannelPath(ch.index);
        const sgNode = chPath ? store.findChildPath(chPath, (c) => c.tag === "SmartGain") : null;
        const armPath = sgNode ? store.findParamPath(sgNode, "Armed") : null;
        return armPath ? { num: ch.num, armPath } : null;
      })
      .filter(Boolean);

    const linkEntries = analogChs
      .filter((_, i) => i % 2 === 0 && i + 1 < analogChs.length)
      .map((ch) => {
        const chPath = getChannelPath(ch.index);
        const linkPath = chPath ? store.findParamPath(chPath, "StereoLink") : null;
        return linkPath ? { label: `LINK ${ch.num}+${ch.num + 1}`, linkPath } : null;
      })
      .filter(Boolean);

    sgBar.innerHTML = `
      ${linkEntries.map((l, i) => `<button class="mini-pill-btn" data-link-idx="${i}">${l.label}</button>`).join("")}
      ${linkEntries.length ? `<span class="sg-divider"></span>` : ""}
      <span class="sg-status-pill" id="sgStatus">SMARTGAIN</span>
      ${armEntries.map((e, i) => `<button class="mini-pill-btn" data-arm-idx="${i}">ARM ${e.num}</button>`).join("")}
      <button class="action-btn accent-btn" id="btnSgRun">START SMARTGAIN</button>
    `;

    const statusEl = sgBar.querySelector("#sgStatus");
    const linkBtns = Array.from(sgBar.querySelectorAll("[data-link-idx]"));
    const armBtns = Array.from(sgBar.querySelectorAll("[data-arm-idx]"));
    const btnRun = sgBar.querySelector("#btnSgRun");

    const syncSg = () => {
      const stLabel = store.getOptionLabel(statusPath, "Ready").toUpperCase();
      statusEl.textContent = `SG: ${stLabel}`;
      statusEl.classList.toggle("running", stLabel === "RUNNING");
      linkEntries.forEach((l, i) => {
        linkBtns[i]?.classList.toggle("active", Boolean(store.getVal(l.linkPath, 0)));
      });
      armEntries.forEach((e, i) => {
        armBtns[i]?.classList.toggle("active", Boolean(store.getVal(e.armPath, 0)));
      });
      btnRun.textContent = stLabel === "RUNNING" ? "STOP SMARTGAIN" : "START SMARTGAIN";
    };

    linkEntries.forEach((l, i) => {
      linkBtns[i]?.addEventListener("click", () => store.toggleParam(l.linkPath));
      bind(l.linkPath, syncSg);
    });
    armEntries.forEach((e, i) => {
      armBtns[i]?.addEventListener("click", () => store.toggleParam(e.armPath));
      bind(e.armPath, syncSg);
    });
    btnRun.addEventListener("click", () => {
      const running = store.getOptionLabel(statusPath, "") === "Running";
      store.setParam(triggerPath, running ? 4 : 1); // 1=Run, 4=Close
    });

    bind(statusPath, syncSg);
    syncSg();
  }

  function buildAnalogCard(chIdx, label) {
    const chPath = getChannelPath(chIdx);
    if (!chPath) return null;

    const gainPath = store.findParamPath(chPath, "G");
    const trimPath = store.findParamPath(chPath, "Trim");
    const mutePath = store.findParamPath(chPath, "Mute");
    const linkPath = store.findParamPath(chPath, "StereoLink");
    const p48Path = store.findParamPath(chPath, "48V");
    const polPath = store.findParamPath(chPath, "plrty");
    const hpfEnPath = store.findParamPath(chPath, "HpfEnable");
    const hpfFreqPath = store.findParamPath(chPath, "HpfFreq");
    const impPath = store.findParamPath(chPath, "Imp");
    const airPath = store.findParamPath(chPath, "AIR");
    const hmxPath = store.findParamPath(chPath, "HMX");

    const eqPath = store.findChildPath(chPath, (c) => c.tag === "EQ");
    const apfPath = eqPath ? store.findChildPath(eqPath, (c) => c.tag === "Band" && c.props?.name === "APF") : null;
    const apfTypePath = apfPath ? store.findParamPath(apfPath, "T") : null;
    const apfPhasePath = apfPath ? store.findParamPath(apfPath, "Phase") : null;

    const showTrim = Boolean(store.getVal(store.findParamPath(store.paths.inputs, "Trim"), 0));

    const card = document.createElement("div");
    card.className = "preamp-card";
    card.innerHTML = `
      <div class="preamp-card-head">
        <div class="preamp-title-group">
          <span class="preamp-ch-num">${chIdx + 1}</span>
          <span class="preamp-ch-name">${label}</span>
        </div>
        <div class="preamp-head-btns">
          <button class="mini-pill-btn danger-active" id="btn48v">48V</button>
          <button class="mini-pill-btn" id="btnPol">Ø</button>
          <button class="mini-pill-btn danger-active" id="btnMute">MUTE</button>
        </div>
      </div>

      <div class="preamp-main-row">
        <div class="preamp-meter-slot" id="inMeter"></div>

        <div class="preamp-knobs-col">
          <div class="preamp-knob-row">
            <div class="preamp-knob-box">
              <div class="preamp-gain-knob" id="gainKnob"></div>
              <span class="micro-label">GAIN</span>
            </div>
            ${showTrim ? `
            <div class="preamp-knob-box">
              <div class="preamp-trim-knob" id="trimKnob"></div>
              <span class="micro-label">TRIM</span>
            </div>` : ""}
          </div>

          <div class="preamp-hpf-row">
            <button class="mini-pill-btn green-active" id="btnHpf">V-HPF</button>
            <input type="range" class="mini-slider" id="hpfSlider" min="20" max="250" step="1" />
            <span class="hpf-freq-val" id="hpfVal">100 Hz</span>
          </div>
        </div>

        <div class="tone-suite-col">
          <span class="micro-label">TONE</span>
          <div class="insp-tone-top">
            <button class="tone-btn tone-glow" id="btnGlow">GLOW</button>
            <button class="tone-btn tone-hmx" id="btnHmx">HMX</button>
            <button class="tone-btn tone-lift" id="btnAir">LIFT</button>
          </div>
          <span class="micro-label">ORBIT</span>
          <div class="orbit-btn-row" id="impSeg">
            ${IMP_OPTIONS.map((o) => `<button class="orbit-btn ${o.cls}" data-val="${o.value}">${o.name}</button>`).join("")}
          </div>
          <div class="orbit-row">
            <button class="mini-pill-btn green-active" id="btnApfOn" title="Toggle V-Phase">V-PHASE</button>
            <input type="range" class="mini-slider" id="apfSlider" min="0" max="180" step="1" />
            <span class="hpf-freq-val" id="apfVal">90°</span>
          </div>
        </div>
      </div>
    `;

    const meter = createMonoMeter(card.querySelector("#inMeter"), {
      scaleSide: "left",
      frameless: true,
    });
    inputMeters.push(meter);

    const gainKnob = createKnob(card.querySelector("#gainKnob"), {
      min: 0,
      max: 75,
      muteAtMin: false,
      unit: "dB",
      defaultValue: store.getVal(gainPath, 0),
      wheelStep: 1,
      fineWheelStep: 1,
      onChange: (v) => store.setParam(gainPath, Math.round(v)),
    });
    bind(gainPath, (v) => gainKnob.setValue(v));

    if (showTrim && trimPath) {
      const trimKnob = createKnob(card.querySelector("#trimKnob"), {
        min: 0,
        max: 15,
        muteAtMin: false,
        unit: "dB",
        compact: true,
        defaultValue: store.getVal(trimPath, 0),
        wheelStep: 1,
        onChange: (v) => store.setParam(trimPath, Math.round(v)),
      });
      bind(trimPath, (v) => trimKnob.setValue(v));
    }

    const wireToggle = (sel, path) => {
      const btn = card.querySelector(sel);
      if (!btn || !path) return;
      const sync = () => btn.classList.toggle("active", Boolean(store.getVal(path, 0)));
      btn.addEventListener("click", () => store.toggleParam(path));
      bind(path, sync);
      sync();
    };

    wireToggle("#btn48v", p48Path);
    wireToggle("#btnPol", polPath);
    wireToggle("#btnMute", mutePath);
    wireToggle("#btnLink", linkPath);

    // HPF Enable + Frequency slider (faded when OFF, touching slider auto-enables)
    const btnHpf = card.querySelector("#btnHpf");
    const hpfSlider = card.querySelector("#hpfSlider");
    const hpfVal = card.querySelector("#hpfVal");
    const syncHpfEn = () => {
      const on = Boolean(store.getVal(hpfEnPath, 0));
      btnHpf.classList.toggle("active", on);
      hpfSlider.classList.toggle("is-bypassed", !on);
      hpfVal.classList.toggle("is-bypassed", !on);
    };
    btnHpf.addEventListener("click", () => store.toggleParam(hpfEnPath));
    bind(hpfEnPath, syncHpfEn);
    syncHpfEn();

    const syncHpf = () => {
      const v = Math.round(store.getVal(hpfFreqPath, 100));
      hpfSlider.value = String(v);
      hpfVal.textContent = `${v} Hz`;
    };
    hpfSlider.addEventListener("input", () => {
      if (hpfEnPath && !store.getVal(hpfEnPath, 0)) {
        store.setParam(hpfEnPath, 1);
      }
      const v = Number(hpfSlider.value);
      hpfVal.textContent = `${v} Hz`;
      store.setParam(hpfFreqPath, v);
    });
    bind(hpfFreqPath, syncHpf);
    syncHpf();

    // TONE: GLOW (HMX + LIFT together), HMX, LIFT
    const btnGlow = card.querySelector("#btnGlow");
    const btnHmx = card.querySelector("#btnHmx");
    const btnAir = card.querySelector("#btnAir");
    const syncTone = () => {
      const hmxOn = Boolean(store.getVal(hmxPath, 0));
      const liftOn = Boolean(store.getVal(airPath, 0));
      btnHmx.classList.toggle("active", hmxOn);
      btnAir.classList.toggle("active", liftOn);
      btnGlow.classList.toggle("active", hmxOn && liftOn);
    };
    btnHmx.addEventListener("click", () => store.toggleParam(hmxPath));
    btnAir.addEventListener("click", () => store.toggleParam(airPath));
    btnGlow.addEventListener("click", () => {
      const bothOn = Boolean(store.getVal(hmxPath, 0)) && Boolean(store.getVal(airPath, 0));
      const next = bothOn ? 0 : 1;
      store.setParam(hmxPath, next);
      store.setParam(airPath, next);
    });
    bind(hmxPath, syncTone);
    bind(airPath, syncTone);
    syncTone();

    // ORBIT Impedance buttons
    const impBtns = Array.from(card.querySelectorAll("#impSeg .orbit-btn"));
    const syncImp = () => {
      const v = store.getVal(impPath, 0);
      impBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
    };
    impBtns.forEach((b) => b.addEventListener("click", () => store.setParam(impPath, Number(b.dataset.val))));
    bind(impPath, syncImp);
    syncImp();

    // V-PHASE On/Off (11=OFF <-> 13=ON) + faded slider when OFF (touching slider auto-enables)
    const btnApfOn = card.querySelector("#btnApfOn");
    const apfSlider = card.querySelector("#apfSlider");
    const apfVal = card.querySelector("#apfVal");
    const syncApfType = () => {
      const on = store.getVal(apfTypePath, 11) !== 11;
      btnApfOn.classList.toggle("active", on);
      apfSlider.classList.toggle("is-bypassed", !on);
      apfVal.classList.toggle("is-bypassed", !on);
    };
    btnApfOn.addEventListener("click", () => {
      const on = store.getVal(apfTypePath, 11) !== 11;
      store.setParam(apfTypePath, on ? 11 : 13);
    });
    bind(apfTypePath, syncApfType);
    syncApfType();

    const syncApfPhase = () => {
      const v = Math.round(store.getVal(apfPhasePath, 90));
      apfSlider.value = String(v);
      apfVal.textContent = `${v}°`;
    };
    apfSlider.addEventListener("input", () => {
      if (apfTypePath && store.getVal(apfTypePath, 11) === 11) {
        store.setParam(apfTypePath, 13);
      }
      const v = Number(apfSlider.value);
      apfVal.textContent = `${v}°`;
      store.setParam(apfPhasePath, v);
    });
    bind(apfPhasePath, syncApfPhase);
    syncApfPhase();

    return card;
  }

  function buildDspSection() {
    dspBindings.clear();
    dspPanel.innerHTML = "";
    const chPath = getChannelPath(selectedDspCh);
    if (!chPath) return;

    const eqPath = store.findChildPath(chPath, (c) => c.tag === "EQ");
    const compPath = store.findChildPath(chPath, (c) => c.tag === "Compressor");
    const orderPath = store.findParamPath(chPath, "DspOrder");

    const eqBypsPath = eqPath ? store.findParamPath(eqPath, "eqByps") : null;
    const compBypsPath = compPath ? store.findParamPath(compPath, "byps") : null;

    const dspEditable = (eqBypsPath && store.isEditable(eqBypsPath)) || (compBypsPath && store.isEditable(compBypsPath));
    const srLabel = store.getOptionLabel(store.paths.sampleRate, "192kHz");

    const topo = store.getDeviceTopology();
    const dspChannels = topo.inputChannels;
    if (!dspChannels.some((c) => c.index === selectedDspCh)) {
      selectedDspCh = dspChannels[0]?.index ?? 0;
    }

    const eqNode = store.getNode(eqPath);
    const bandRefs = [];
    if (eqNode?.children) {
      eqNode.children.forEach((c, idx) => {
        if (c.tag === "Band" && c.props?.name?.startsWith("Band")) {
          const bp = [...eqPath, idx];
          bandRefs.push({
            name: c.props.name,
            t: store.findParamPath(bp, "T"),
            f: store.findParamPath(bp, "F"),
            g: store.findParamPath(bp, "G"),
            q: store.findParamPath(bp, "Q"),
          });
        }
      });
    }
    if (selectedEqBand >= bandRefs.length) selectedEqBand = 0;

    dspPanel.innerHTML = `
      <div class="dsp-header">
        <div class="dsp-ch-picker">
          <span class="micro-label">DSP CHANNEL</span>
          <select class="dock-select dsp-ch-select" id="dspChSelect" title="Select DSP Input Channel">
            ${dspChannels
              .map(
                (c, i) =>
                  `<option value="${c.index}" ${c.index === selectedDspCh ? "selected" : ""}>${i + 1} · ${c.label}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="dsp-head-right">
          ${dspEditable ? "" : `<span class="dsp-lock-pill">DSP UNAVAILABLE AT ${srLabel} · SWITCH TO ≤ 96 kHz</span>`}
          <div class="seg-group" id="dspOrderSeg">
            <button class="seg-btn" data-val="0">EQ → COMP</button>
            <button class="seg-btn" data-val="1">COMP → EQ</button>
          </div>
        </div>
      </div>

      <div class="dsp-split ${dspEditable ? "" : "dsp-disabled"}">
        <!-- LEFT: FLAGSHIP 4-BAND PARAMETRIC EQ -->
        <div class="dsp-card eq-card">
          <div class="dsp-card-head">
            <span class="dock-title">4-BAND PARAMETRIC EQ</span>
            <div class="dsp-card-actions">
              <button class="mini-pill-btn ab-btn" id="btnEqAb" title="Toggle A/B EQ Compare" ${dspEditable ? "" : "disabled"}>A / B</button>
              <button class="mini-pill-btn" id="btnEqReset" title="Reset EQ to default profile" ${dspEditable ? "" : "disabled"}>RESET</button>
              <button class="mini-pill-btn green-active" id="btnEqOn" ${dspEditable ? "" : "disabled"}>EQ</button>
            </div>
          </div>

          <div class="preamp-eq-oled">
            <svg class="eq-oled-svg" id="pEqSvg" viewBox="0 0 520 150" preserveAspectRatio="none">
              <defs>
                <linearGradient id="pEqFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="rgba(255,255,255,0.18)" />
                  <stop offset="100%" stop-color="rgba(255,255,255,0.01)" />
                </linearGradient>
              </defs>
              <!-- Vertical log frequency grid (50, 100, 200, 500, 1k, 2k, 5k, 10k) -->
              <line x1="69" y1="0" x2="69" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="121" y1="0" x2="121" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="173" y1="0" x2="173" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="242" y1="0" x2="242" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="295" y1="0" x2="295" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="347" y1="0" x2="347" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="416" y1="0" x2="416" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="468" y1="0" x2="468" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <!-- Horizontal dB grid (+12, +6, 0, -6, -12) -->
              <line x1="0" y1="20" x2="520" y2="20" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="47.5" x2="520" y2="47.5" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="75" x2="520" y2="75" class="eq-grid-zero" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="102.5" x2="520" y2="102.5" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="130" x2="520" y2="130" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <g id="pEqBandFills"></g>
              <path id="pEqFillPath" fill="url(#pEqFillGrad)" />
              <path id="pEqCurvePath" fill="none" stroke="#f4f4f6" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            </svg>
            <span class="eq-axis-lbl" style="left:6px;top:11%;">+12</span>
            <span class="eq-axis-lbl" style="left:6px;top:45%;">0</span>
            <span class="eq-axis-lbl" style="left:6px;bottom:10%;">-12</span>
            <span class="eq-axis-lbl" style="left:13.8%;bottom:4px;">50</span>
            <span class="eq-axis-lbl" style="left:23.8%;bottom:4px;">100</span>
            <span class="eq-axis-lbl" style="left:47.1%;bottom:4px;">500</span>
            <span class="eq-axis-lbl" style="left:57.2%;bottom:4px;">1k</span>
            <span class="eq-axis-lbl" style="left:80.5%;bottom:4px;">5k</span>
            <span class="eq-axis-lbl" style="left:90.5%;bottom:4px;">10k</span>
            <div class="eq-nodes-layer" id="pEqNodes"></div>
            <span class="eq-oled-readout" id="pEqReadout"></span>
            ${dspEditable ? "" : `<div class="dsp-oled-lock">DSP UNAVAILABLE AT ${srLabel} · LOWER SAMPLE RATE</div>`}
          </div>

          <div class="preamp-eq-deck">
            <div class="preamp-eq-left">
              <div class="preamp-eq-bands-row" id="pEqBandTiles">
                ${bandRefs
                  .map(
                    (_, i) => `
                  <button class="preamp-eq-band-tile ${i === selectedEqBand ? "active" : ""}" data-band="${i}" style="--band-col:${EQ_BAND_COLORS[i % 4]}">
                    <span class="peq-tile-num">${i + 1}</span>
                    <span class="peq-tile-meta" id="peqTileMeta${i}">—</span>
                  </button>`
                  )
                  .join("")}
              </div>
              <div class="preamp-eq-type-row">
                <span class="micro-label">FILTER TYPE</span>
                <select class="dock-select preamp-eq-type-sel" id="pEqType" ${dspEditable ? "" : "disabled"}>
                  ${EQ_TYPES.map((o) => `<option value="${o.value}">${o.name}</option>`).join("")}
                </select>
              </div>
            </div>

            <div class="preamp-eq-knobs">
              <div class="insp-knob-unit">
                <span class="micro-label">FREQ</span>
                <div class="preamp-dsp-knob" id="pEqFreq"></div>
                <span class="knob-sub-unit">HZ</span>
              </div>
              <div class="insp-knob-unit">
                <span class="micro-label">GAIN</span>
                <div class="preamp-dsp-knob" id="pEqGain"></div>
                <span class="knob-sub-unit">DB</span>
              </div>
              <div class="insp-knob-unit">
                <span class="micro-label">WIDTH</span>
                <div class="preamp-dsp-knob" id="pEqQ"></div>
                <span class="knob-sub-unit">Q</span>
              </div>
            </div>
          </div>
        </div>

        <!-- RIGHT: FLAGSHIP COMPRESSOR + TRANSFER CURVE OLED -->
        <div class="dsp-card comp-card">
          <div class="dsp-card-head">
            <span class="dock-title">COMPRESSOR</span>
            <div class="dsp-card-actions">
              <button class="mini-pill-btn ab-btn" id="btnCompAb" title="Toggle A/B Compressor Compare" ${dspEditable ? "" : "disabled"}>A / B</button>
              <button class="mini-pill-btn" id="btnCompReset" title="Reset Compressor to default profile" ${dspEditable ? "" : "disabled"}>RESET</button>
              <button class="mini-pill-btn green-active" id="btnCompOn" ${dspEditable ? "" : "disabled"}>COMP</button>
            </div>
          </div>

          <div class="comp-transfer-oled">
            <svg class="comp-transfer-svg" id="pCompSvg" viewBox="0 0 280 116" preserveAspectRatio="none">
              <defs>
                <linearGradient id="pCompFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="rgba(45, 212, 191, 0.24)" />
                  <stop offset="100%" stop-color="rgba(45, 212, 191, 0.01)" />
                </linearGradient>
              </defs>
              <line x1="70" y1="0" x2="70" y2="116" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="140" y1="0" x2="140" y2="116" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="210" y1="0" x2="210" y2="116" class="eq-grid-v" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="29" x2="280" y2="29" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="58" x2="280" y2="58" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="0" y1="87" x2="280" y2="87" class="eq-grid-h" vector-effect="non-scaling-stroke" />
              <line x1="10" y1="108" x2="270" y2="8" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
              <path id="pCompFill" fill="url(#pCompFillGrad)" />
              <path id="pCompCurve" fill="none" stroke="#e4e4e4" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            </svg>
            <span class="eq-axis-lbl" style="left:6px;bottom:4px;">-60</span>
            <span class="eq-axis-lbl" style="left:48%;bottom:4px;">-30</span>
            <span class="eq-axis-lbl" style="right:6px;bottom:4px;">0dB</span>
            <div class="eq-nodes-layer">
              <div id="pCompKnee" class="comp-knee-dot" title="Drag to set Threshold"></div>
            </div>
            <span class="comp-oled-readout" id="pCompReadout"></span>
            ${dspEditable ? "" : `<div class="dsp-oled-lock">LOCKED AT ${srLabel}</div>`}
          </div>

          <div class="preamp-comp-gr">
            <div class="preamp-comp-gr-top">
              <span class="micro-label">GAIN REDUCTION</span>
              <span class="comp-gr-readout" id="compGrVal">0.0 dB</span>
            </div>
            <div class="comp-gr-track"><div class="comp-gr-bar" id="compGrBar"></div></div>
            <div class="comp-gr-ticks">
              <span>20</span><span>15</span><span>10</span><span>6</span><span>3</span><span>0</span>
            </div>
          </div>

          <div class="preamp-comp-knobs-grid" id="compParamsGrid"></div>
        </div>
      </div>
    `;

    grBarEl = dspPanel.querySelector("#compGrBar");
    grValEl = dspPanel.querySelector("#compGrVal");

    const dspChSelect = dspPanel.querySelector("#dspChSelect");
    dspChSelect?.addEventListener("change", () => {
      selectedDspCh = Number(dspChSelect.value);
      buildDspSection();
    });

    const orderBtns = Array.from(dspPanel.querySelectorAll("#dspOrderSeg .seg-btn"));
    const syncOrder = () => {
      const v = store.getVal(orderPath, 0);
      orderBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
    };
    orderBtns.forEach((b) => {
      b.disabled = !dspEditable;
      b.addEventListener("click", () => dspEditable && store.setParam(orderPath, Number(b.dataset.val)));
    });
    bindDsp(orderPath, syncOrder);
    syncOrder();

    // --- 4-BAND PARAMETRIC EQ LOGIC ---
    const curBand = () => bandRefs[selectedEqBand] || bandRefs[0];
    const isEqActive = () => dspEditable && !store.getVal(eqBypsPath, 1);
    const ensureEqEngaged = () => {
      if (dspEditable && eqBypsPath && store.getVal(eqBypsPath, 1)) {
        store.setParam(eqBypsPath, 0);
      }
    };

    const btnEqOn = dspPanel.querySelector("#btnEqOn");
    const btnEqAb = dspPanel.querySelector("#btnEqAb");
    const btnEqReset = dspPanel.querySelector("#btnEqReset");
    const selEqType = dspPanel.querySelector("#pEqType");
    const bandTiles = Array.from(dspPanel.querySelectorAll("#pEqBandTiles .preamp-eq-band-tile"));
    const eqSvg = dspPanel.querySelector("#pEqSvg");
    const eqBandFills = dspPanel.querySelector("#pEqBandFills");
    const eqFillPath = dspPanel.querySelector("#pEqFillPath");
    const eqCurvePath = dspPanel.querySelector("#pEqCurvePath");
    const eqNodesGroup = dspPanel.querySelector("#pEqNodes");
    const eqReadout = dspPanel.querySelector("#pEqReadout");

    const freqToX = (f) => (Math.log(Math.max(20, Math.min(20000, f)) / 20) / Math.log(1000)) * 520;
    const xToFreq = (x) => 20 * Math.pow(1000, Math.max(0, Math.min(1, x / 520)));
    const dbToY = (db) => 75 - (Math.max(-14, Math.min(14, db)) / 14) * 64;
    const yToDb = (y) => Math.max(-12, Math.min(12, ((75 - y) / 64) * 14));

    const EQ_GRID = [];
    for (let x = 0; x <= 520; x += 4) {
      EQ_GRID.push({ x, freq: xToFreq(x) });
    }
    if (EQ_GRID[EQ_GRID.length - 1].x !== 520) {
      EQ_GRID.push({ x: 520, freq: 20000 });
    }

    const bandFillEls = bandRefs.map((_, idx) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("fill", EQ_BAND_COLORS[idx % 4]);
      eqBandFills.appendChild(p);
      return p;
    });

    let rafEqId = null;
    let draggingEqIdx = -1;
    function scheduleDrawEq() {
      if (rafEqId !== null) return;
      rafEqId = requestAnimationFrame(() => {
        rafEqId = null;
        drawEqGraph();
      });
    }

    const kEqFreq = createKnob(dspPanel.querySelector("#pEqFreq"), {
      min: 20, max: 20000, muteAtMin: false, compact: true, logScale: true,
      defaultValue: curBand() ? store.getVal(curBand().f, 1000) : 1000,
      formatValue: fmtFreqShort,
      onChange: (v) => {
        const b = curBand();
        if (b && dspEditable) {
          ensureEqEngaged();
          store.setParam(b.f, Math.round(v), { silent: true });
          scheduleDrawEq();
        }
      },
    });
    const kEqGain = createKnob(dspPanel.querySelector("#pEqGain"), {
      min: -12, max: 12, centerZero: true, muteAtMin: false, compact: true,
      roundOnSettle: false, decimals: 1, wheelStep: 1, fineWheelStep: 0.1,
      defaultValue: curBand() ? store.getVal(curBand().g, 0) : 0,
      formatValue: (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
      onChange: (v) => {
        const b = curBand();
        if (b && dspEditable) {
          ensureEqEngaged();
          store.setParam(b.g, Math.round(v * 10) / 10, { silent: true });
          scheduleDrawEq();
        }
      },
    });
    const kEqQ = createKnob(dspPanel.querySelector("#pEqQ"), {
      min: 0.5, max: 12, muteAtMin: false, compact: true, logScale: true,
      roundOnSettle: false, decimals: 1, wheelStep: 0.2, fineWheelStep: 0.1,
      defaultValue: curBand() ? store.getVal(curBand().q, 1) : 1,
      onChange: (v) => {
        const b = curBand();
        if (b && dspEditable) {
          ensureEqEngaged();
          store.setParam(b.q, Math.round(v * 10) / 10, { silent: true });
          scheduleDrawEq();
        }
      },
    });

    const nodeEls = bandRefs.map((b, idx) => {
      const g = document.createElement("button");
      g.type = "button";
      g.className = "eq-dot";
      const col = EQ_BAND_COLORS[idx % 4];
      g.style.setProperty("--dot-col", col);
      g.textContent = String(idx + 1);
      eqNodesGroup.appendChild(g);

      let dragRect = null;
      g.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        selectEqBand(idx);
        if (!dspEditable) return;
        ensureEqEngaged();
        draggingEqIdx = idx;
        dragRect = eqSvg.getBoundingClientRect();
        g.setPointerCapture(e.pointerId);
      });
      g.addEventListener("pointermove", (e) => {
        if (draggingEqIdx !== idx || !dspEditable || !dragRect) return;
        const sx = ((e.clientX - dragRect.left) / dragRect.width) * 520;
        const sy = ((e.clientY - dragRect.top) / dragRect.height) * 150;
        const nf = Math.round(xToFreq(sx));
        const ng = Math.round(yToDb(sy) * 10) / 10;
        store.setParam(b.f, nf, { silent: true });
        store.setParam(b.g, ng, { silent: true });
        kEqFreq.setValue(nf);
        kEqGain.setValue(ng);
        scheduleDrawEq();
      });
      const endDrag = (e) => {
        if (draggingEqIdx !== idx) return;
        draggingEqIdx = -1;
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
          selectEqBand(idx);
          ensureEqEngaged();
          const curQ = Number(store.getVal(b.q, 1));
          const nextQ = Math.max(0.5, Math.min(12, Math.round((curQ + (e.deltaY < 0 ? 0.3 : -0.3)) * 10) / 10));
          store.setParam(b.q, nextQ, { silent: true });
          kEqQ.setValue(nextQ);
          scheduleDrawEq();
        },
        { passive: false }
      );
      return g;
    });

    function drawEqGraph() {
      const active = isEqActive();
      const bStates = bandRefs.map((b) => ({
        type: Number(store.getVal(b.t, 11)),
        freq: Number(store.getVal(b.f, 1000)),
        gain: Number(store.getVal(b.g, 0)),
        q: Number(store.getVal(b.q, 1)),
      }));

      // Individual band shaded ribbons + composite curve
      const compPts = new Array(EQ_GRID.length);
      const bandPts = bStates.map(() => new Array(EQ_GRID.length));

      for (let i = 0; i < EQ_GRID.length; i++) {
        const { x, freq } = EQ_GRID[i];
        let totalDb = 0;
        for (let j = 0; j < bStates.length; j++) {
          const bdb = dspEditable ? evalBandDb(freq, bStates[j]) : 0;
          totalDb += bdb;
          bandPts[j][i] = `${i === 0 ? "M" : "L"}${x} ${dbToY(bdb).toFixed(1)}`;
        }
        compPts[i] = `${i === 0 ? "M" : "L"}${x} ${dbToY(totalDb).toFixed(1)}`;
      }

      bandFillEls.forEach((el, j) => {
        const bs = bStates[j];
        const show = active && bs.type !== 11 && (Math.abs(bs.gain) > 0.05 || bs.type === 3 || bs.type === 1);
        el.setAttribute("d", `${bandPts[j].join(" ")} L520 75 L0 75 Z`);
        el.setAttribute("fill-opacity", show ? (j === selectedEqBand ? "0.18" : "0.07") : "0");
      });

      const dStr = compPts.join(" ");
      eqCurvePath.setAttribute("d", dStr);
      eqCurvePath.setAttribute("opacity", active ? "1" : "0.35");
      eqFillPath.setAttribute("d", `${dStr} L520 75 L0 75 Z`);
      eqFillPath.setAttribute("opacity", active ? "1" : "0");

      nodeEls.forEach((g, i) => {
        const bs = bStates[i];
        const nx = freqToX(bs.freq);
        const ny = bs.type === 3 || bs.type === 1 || bs.type === 11 ? 75 : dbToY(bs.gain);
        g.style.left = `${((nx / 520) * 100).toFixed(2)}%`;
        g.style.top = `${((ny / 150) * 100).toFixed(2)}%`;
        g.classList.toggle("selected", i === selectedEqBand);
        g.classList.toggle("bypassed", !active || bs.type === 11);

        const metaEl = dspPanel.querySelector(`#peqTileMeta${i}`);
        if (metaEl) {
          const gStr = bs.gain > 0 ? `+${bs.gain.toFixed(1)}` : bs.gain.toFixed(1);
          metaEl.textContent = bs.type === 11 ? "OFF" : `${fmtFreqShort(bs.freq)} · ${gStr}`;
        }
      });

      const sb = bStates[selectedEqBand];
      if (sb) {
        const gStr = sb.gain > 0 ? `+${sb.gain.toFixed(1)}` : sb.gain.toFixed(1);
        eqReadout.textContent = `B${selectedEqBand + 1} · ${fmtFreqShort(sb.freq)}Hz · ${gStr}dB · Q${sb.q.toFixed(1)}`;
      }
    }

    function syncSelectedEqBand() {
      const b = curBand();
      bandTiles.forEach((p) => p.classList.toggle("active", Number(p.dataset.band) === selectedEqBand));
      if (!b) return;
      const tv = Number(store.getVal(b.t, 11));
      selEqType.value = String(tv);
      selEqType.disabled = !dspEditable;
      kEqFreq.setValue(Number(store.getVal(b.f, 1000)));
      kEqGain.setValue(Number(store.getVal(b.g, 0)));
      kEqQ.setValue(Number(store.getVal(b.q, 1)));
      const bandOff = !dspEditable || tv === 11;
      kEqFreq.setDisabled(bandOff);
      kEqGain.setDisabled(bandOff || tv === 3 || tv === 1);
      kEqQ.setDisabled(bandOff);
      drawEqGraph();
    }

    function selectEqBand(idx) {
      selectedEqBand = idx;
      syncSelectedEqBand();
    }

    bandTiles.forEach((p) => p.addEventListener("click", () => selectEqBand(Number(p.dataset.band))));

    selEqType.addEventListener("change", () => {
      const b = curBand();
      if (b && dspEditable) {
        ensureEqEngaged();
        store.setParam(b.t, Number(selEqType.value));
        syncSelectedEqBand();
      }
    });

    btnEqReset.addEventListener("click", () => {
      if (!dspEditable) return;
      bandRefs.forEach((b, idx) => {
        const def = EQ_DEFAULT_BANDS[idx] || EQ_DEFAULT_BANDS[1];
        if (b.t) store.setParam(b.t, def.t);
        if (b.f) store.setParam(b.f, def.f);
        if (b.g) store.setParam(b.g, def.g);
        if (b.q) store.setParam(b.q, def.q);
      });
      syncSelectedEqBand();
    });

    const syncEqOn = () => {
      const on = isEqActive();
      btnEqOn.classList.toggle("active", on);
      btnEqReset.disabled = !dspEditable;
      const faded = !on;
      btnEqAb?.classList.toggle("is-bypassed", faded);
      btnEqReset?.classList.toggle("is-bypassed", faded);
      dspPanel.querySelector(".eq-card .preamp-eq-oled")?.classList.toggle("is-bypassed", faded);
      dspPanel.querySelector(".eq-card .preamp-eq-deck")?.classList.toggle("is-bypassed", faded);
      syncSelectedEqBand();
    };
    btnEqOn.addEventListener("click", () => dspEditable && store.toggleParam(eqBypsPath));
    bindDsp(eqBypsPath, syncEqOn);
    bandRefs.forEach((b) => [b.t, b.f, b.g, b.q].forEach((p) => bindDsp(p, syncSelectedEqBand)));
    syncEqOn();

    // --- FLAGSHIP COMPRESSOR LOGIC + TRANSFER CURVE OLED ---
    const btnCompOn = dspPanel.querySelector("#btnCompOn");
    const btnCompReset = dspPanel.querySelector("#btnCompReset");
    const compSvg = dspPanel.querySelector("#pCompSvg");
    const compCurve = dspPanel.querySelector("#pCompCurve");
    const compFill = dspPanel.querySelector("#pCompFill");
    const compKnee = dspPanel.querySelector("#pCompKnee");
    const compReadout = dspPanel.querySelector("#pCompReadout");
    const compGrid = dspPanel.querySelector("#compParamsGrid");

    const isCompActive = () => dspEditable && !store.getVal(compBypsPath, 1);
    const ensureCompEngaged = () => {
      if (dspEditable && compBypsPath && store.getVal(compBypsPath, 1)) {
        store.setParam(compBypsPath, 0);
      }
    };

    const threshPath = compPath ? store.findParamPath(compPath, "Threshold") : null;
    const ratioPath = compPath ? store.findParamPath(compPath, "Ratio") : null;
    const makeupPath = compPath ? store.findParamPath(compPath, "Makeup") : null;

    const dbToCX = (db) => 10 + ((Math.max(-60, Math.min(0, db)) + 60) / 60) * 260;
    const cxToDb = (x) => Math.max(-60, Math.min(0, ((x - 10) / 260) * 60 - 60));
    const dbToCY = (db) => 108 - ((Math.max(-60, Math.min(0, db)) + 60) / 60) * 100;

    function drawCompTransfer() {
      const active = isCompActive();
      const th = Number(store.getVal(threshPath, 0));
      const rat = Math.max(1, Number(store.getVal(ratioPath, 2)));
      const mk = Number(store.getVal(makeupPath, 0));

      const outAt = (inp) => {
        const compressed = inp > th ? th + (inp - th) / rat : inp;
        return Math.max(-60, Math.min(0, compressed + mk));
      };

      const x0 = dbToCX(-60);
      const y0 = dbToCY(outAt(-60));
      const xk = dbToCX(th);
      const yk = dbToCY(outAt(th));
      const x1 = dbToCX(0);
      const y1 = dbToCY(outAt(0));

      const d = `M${x0.toFixed(1)} ${y0.toFixed(1)} L${xk.toFixed(1)} ${yk.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}`;
      compCurve.setAttribute("d", d);
      compCurve.setAttribute("opacity", active ? "1" : "0.35");
      compFill.setAttribute("d", `${d} L${x1.toFixed(1)} 108 L${x0.toFixed(1)} 108 Z`);
      compFill.setAttribute("opacity", active ? "1" : "0");
      compKnee.style.left = `${((xk / 280) * 100).toFixed(2)}%`;
      compKnee.style.top = `${((yk / 116) * 100).toFixed(2)}%`;
      compKnee.classList.toggle("bypassed", !active);

      const rStr = String(Math.round(rat));
      compReadout.textContent = `THRESH ${Math.round(th)}dB · ${rStr}:1 · +${mk.toFixed(1)}dB`;
    }

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

    const compKnobMap = new Map();
    const compKnobs = [];
    compKnobSpecs.forEach((sp) => {
      const p = compPath ? store.findParamPath(compPath, sp.name) : null;
      const unit = document.createElement("div");
      unit.className = "insp-knob-unit";
      unit.innerHTML = `
        <span class="micro-label">${sp.label}</span>
        <div class="preamp-comp-knob" id="pck"></div>
        <span class="knob-sub-unit">${sp.sub}</span>
      `;
      compGrid.appendChild(unit);

      const rawInit = p ? Number(store.getVal(p, sp.defaultVal / (sp.scale || 1))) : sp.defaultVal / (sp.scale || 1);
      const knob = createKnob(unit.querySelector("#pck"), {
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
          store.setParam(p, sp.scale ? v / sp.scale : v, { silent: true });
          drawCompTransfer();
        },
      });
      compKnobs.push(knob);
      compKnobMap.set(sp.name, { path: p, knob, scale: sp.scale || 1 });

      if (p) {
        bindDsp(p, (val) => {
          if (typeof val === "number") knob.setValue(sp.scale ? val * sp.scale : val);
          drawCompTransfer();
        });
      }
    });

    // Draggable Threshold knee point on the transfer curve OLED
    let draggingKnee = false;
    let kneeRect = null;
    compKnee.addEventListener("pointerdown", (e) => {
      if (!dspEditable || !threshPath) return;
      e.stopPropagation();
      ensureCompEngaged();
      draggingKnee = true;
      kneeRect = compSvg.getBoundingClientRect();
      compKnee.setPointerCapture(e.pointerId);
    });
    compKnee.addEventListener("pointermove", (e) => {
      if (!draggingKnee || !kneeRect || !threshPath) return;
      const sx = ((e.clientX - kneeRect.left) / kneeRect.width) * 280;
      const nextTh = Math.round(cxToDb(sx));
      store.setParam(threshPath, nextTh, { silent: true });
      compKnobMap.get("Threshold")?.knob.setValue(nextTh);
      drawCompTransfer();
    });
    const endKnee = (e) => {
      if (!draggingKnee) return;
      draggingKnee = false;
      kneeRect = null;
      if (compKnee.hasPointerCapture(e.pointerId)) compKnee.releasePointerCapture(e.pointerId);
    };
    compKnee.addEventListener("pointerup", endKnee);
    compKnee.addEventListener("pointercancel", endKnee);

    btnCompReset.addEventListener("click", () => {
      if (!dspEditable) return;
      for (const [name, defVal] of Object.entries(COMP_DEFAULTS)) {
        const entry = compKnobMap.get(name);
        if (entry?.path) {
          store.setParam(entry.path, defVal);
          entry.knob.setValue(entry.scale !== 1 ? Math.round(defVal * entry.scale) : defVal);
        }
      }
      drawCompTransfer();
    });

    // --- EQ A/B Compare ---
    if (!eqAbMemory.has(selectedDspCh)) eqAbMemory.set(selectedDspCh, { slot: "A", A: null, B: null });
    const eqAb = eqAbMemory.get(selectedDspCh);
    const syncEqAbBtn = () => {
      btnEqAb.textContent = eqAb.slot === "A" ? "A · b" : "a · B";
      btnEqAb.classList.toggle("active", eqAb.slot === "B");
    };
    syncEqAbBtn();
    btnEqAb.addEventListener("click", () => {
      if (!dspEditable) return;
      const curState = bandRefs.map((b) => ({
        t: Number(store.getVal(b.t, 8)),
        f: Number(store.getVal(b.f, 1000)),
        g: Number(store.getVal(b.g, 0)),
        q: Number(store.getVal(b.q, 1)),
      }));
      eqAb[eqAb.slot] = curState;
      const nextSlot = eqAb.slot === "A" ? "B" : "A";
      if (!eqAb[nextSlot]) eqAb[nextSlot] = curState.map((x) => ({ ...x }));
      eqAb.slot = nextSlot;
      eqAb[nextSlot].forEach((bVal, i) => {
        const ref = bandRefs[i];
        if (!ref) return;
        if (ref.t) store.setParam(ref.t, bVal.t);
        if (ref.f) store.setParam(ref.f, bVal.f);
        if (ref.g) store.setParam(ref.g, bVal.g);
        if (ref.q) store.setParam(ref.q, bVal.q);
      });
      syncEqAbBtn();
      syncEqDeck();
      drawEqGraph();
    });

    // --- Compressor A/B Compare ---
    const btnCompAb = dspPanel.querySelector("#btnCompAb");
    if (!compAbMemory.has(selectedDspCh)) compAbMemory.set(selectedDspCh, { slot: "A", A: null, B: null });
    const compAb = compAbMemory.get(selectedDspCh);
    const syncCompAbBtn = () => {
      btnCompAb.textContent = compAb.slot === "A" ? "A · b" : "a · B";
      btnCompAb.classList.toggle("active", compAb.slot === "B");
    };
    syncCompAbBtn();
    btnCompAb.addEventListener("click", () => {
      if (!dspEditable) return;
      const curState = {};
      for (const [name, entry] of compKnobMap.entries()) {
        curState[name] = entry.path ? Number(store.getVal(entry.path, COMP_DEFAULTS[name])) : COMP_DEFAULTS[name];
      }
      compAb[compAb.slot] = curState;
      const nextSlot = compAb.slot === "A" ? "B" : "A";
      if (!compAb[nextSlot]) compAb[nextSlot] = { ...curState };
      compAb.slot = nextSlot;
      for (const [name, val] of Object.entries(compAb[nextSlot])) {
        const entry = compKnobMap.get(name);
        if (entry?.path) {
          store.setParam(entry.path, val);
          entry.knob.setValue(entry.scale !== 1 ? Math.round(val * entry.scale) : val);
        }
      }
      syncCompAbBtn();
      drawCompTransfer();
    });

    const syncCompOn = () => {
      const on = isCompActive();
      btnCompOn.classList.toggle("active", on);
      btnCompReset.disabled = !dspEditable;
      compKnobs.forEach((k) => k.setDisabled(!dspEditable));
      const faded = !on;
      btnCompAb?.classList.toggle("is-bypassed", faded);
      btnCompReset?.classList.toggle("is-bypassed", faded);
      dspPanel.querySelector(".comp-card .comp-transfer-oled")?.classList.toggle("is-bypassed", faded);
      dspPanel.querySelector(".comp-card .preamp-comp-gr")?.classList.toggle("is-bypassed", faded);
      dspPanel.querySelector(".comp-card .preamp-comp-knobs-grid")?.classList.toggle("is-bypassed", faded);
      drawCompTransfer();
    };
    btnCompOn.addEventListener("click", () => dspEditable && store.toggleParam(compBypsPath));
    bindDsp(compBypsPath, syncCompOn);
    syncCompOn();
  }

  function rebuild() {
    cleanup();
    preampGrid.innerHTML = "";
    if (!store.paths.inputs) return;

    buildSmartGain();
    const topo = store.getDeviceTopology();
    const analogChs = topo.inputChannels.filter((c) => c.isAnalog);
    for (const ch of analogChs) {
      const card = buildAnalogCard(ch.index, ch.longLabel);
      if (card) preampGrid.appendChild(card);
    }

    buildDspSection();
  }

  let dspRebuildTimer = null;
  store.onSnapshot(rebuild);
  store.onParam((changedPath, prop, value) => {
    const k = pathKey(changedPath);
    const trimToggle = store.paths.inputs ? store.findParamPath(store.paths.inputs, "Trim") : null;
    if (trimToggle && pathKey(trimToggle) === k) {
      rebuild();
      return;
    }
    if (prop === "editable" || (store.paths.sampleRate && pathKey(store.paths.sampleRate) === k)) {
      clearTimeout(dspRebuildTimer);
      dspRebuildTimer = setTimeout(() => buildDspSection(), 40);
    }
    const cbs = paramBindings.get(k);
    if (cbs) cbs.forEach((fn) => fn(value));
    const dcbs = dspBindings.get(k);
    if (dcbs) dcbs.forEach((fn) => fn(value));
  });

  store.onMeters((mf) => {
    for (let i = 0; i < inputMeters.length; i++) {
      if (inputMeters[i]) inputMeters[i].setLevel(mf.analogue?.[i] ?? -128);
    }
    if (grBarEl && grValEl) {
      const gr = mf.comp_gr?.[selectedDspCh] ?? 0;
      const pct = Math.min(100, (Math.abs(gr) / 20) * 100);
      grBarEl.style.width = `${pct.toFixed(1)}%`;
      grValEl.textContent = `${gr.toFixed(1)} dB`;
    }
  });

  rebuild();
}
