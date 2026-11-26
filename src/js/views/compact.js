// Stealth Obsidian Hardware Compact Widget (Audient iD2 Faceplate)
// - Locked 512:344 (1.49:1) aspect ratio with bottom-right corner-only proportional resizing
// - 31 exact Audient frosted pill LED steps around a Calibrated Titanium central dial
// - Optically centered digits, dynamic interface name (e.g. iD2), active channel below logo
// - Left 2x2 context-aware hardware buttons + bottom-left target dropdown pill
// - Right 9-row segmented hardware LED meter + 3 daily-driver shortcuts (MIC / HP / MAIN)
// - Theme-ready palette architecture: "white" (default), "tinted", and "mono" preserved for Settings

import { openCustomMenu } from "../components/select.js";
import { createMixWaveform } from "../components/waveform.js";
import { pathKey } from "../store.js";

const BASE_W = 512;
const BASE_H = 344;
const ASPECT = BASE_W / BASE_H;
const MIN_W = 320;
const MAX_W = 640;
const DEFAULT_W = 440;

function buildDynamicTargets(store) {
  const topo = store.getDeviceTopology();
  const list = [
    { id: "main", label: "MAIN", kind: "main" },
    { id: "hp1", label: "HP 1", kind: "hp" },
  ];
  const analogChs = topo.inputChannels.filter((c) => c.isAnalog);
  analogChs.forEach((ch, idx) => {
    list.push({
      id: `mic${idx + 1}`,
      label: `MIC ${idx + 1}`,
      kind: "mic",
      inCh: ch.index,
      meterIdx: idx,
    });
  });
  let hostNum = 1;
  for (const pr of topo.pairs) {
    if (pr.group === "host") {
      list.push({
        id: `comp${hostNum}${hostNum + 1}`,
        label: `COMP ${hostNum}+${hostNum + 1}`,
        kind: "pair",
        pairIdx: pr.pairIdx,
        meterGroup: "host",
        meterBase: pr.base,
      });
      hostNum += 2;
    } else if (pr.isReverb) {
      list.push({
        id: "reverb",
        label: "REVERB",
        kind: "rev",
        pairIdx: pr.pairIdx,
        meterGroup: "reverb",
        meterBase: 0,
      });
    }
  }
  return list;
}

const METER_THRESHOLDS_DB = [-0.5, -3, -6, -9, -12, -18, -24, -30, -45];
const METER_LABELS = ["0", "-3", "-6", "-9", "-12", "-18", "-24", "-30", ""];

const DIAL_CX = 120;
const DIAL_CY = 120;
const DIAL_START = -138;
const DIAL_SWEEP = 276;
const DIAL_SEGMENTS = 31;

function lerpHex(hexA, hexB, t) {
  const k = Math.max(0, Math.min(1, t));
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * k);
  return `rgb(${r},${g},${bl})`;
}

function getCompactThemeColors() {
  const theme = document.documentElement.dataset.theme || "obsidian";
  if (theme === "liquidglass") {
    const isLight = document.documentElement.dataset.glassScheme === "light";
    if (isLight) {
      return {
        isLight: true,
        unlitOut: "#cdd6e6",
        unlitCore: "#c0cbe0",
        litWhiteOut: "#1a2233",
        litWhiteCore: "#0a84ff",
        valText: "#141821",
        ptrCol: "#0a84ff",
        meterOff: "rgba(20, 26, 40, 0.14)",
        meterOn: "#28cd41",
        meterWarn: "#ff9f0a",
        meterClip: "#ff3b30",
      };
    }
    return {
      isLight: false,
      unlitOut: "#252b38",
      unlitCore: "#1c212c",
      litWhiteOut: "#eef6ff",
      litWhiteCore: "#64d2ff",
      valText: "#f5f8ff",
      ptrCol: "#64d2ff",
      meterOff: "rgba(255, 255, 255, 0.10)",
      meterOn: "#30d158",
      meterWarn: "#ffd60a",
      meterClip: "#ff453a",
    };
  }
  if (theme === "daylight") {
    return {
      isLight: true,
      unlitOut: "#cfd5e0",
      unlitCore: "#c6ccd8",
      litWhiteOut: "#1f232c",
      litWhiteCore: "#14171d",
      valText: "#15171d",
      ptrCol: "#15171d",
      meterOff: "rgba(24, 28, 38, 0.14)",
      meterOn: "#16a868",
      meterWarn: "#d4901e",
      meterClip: "#dc3c3c",
    };
  }
  if (theme === "vintage") {
    return {
      isLight: false,
      unlitOut: "#24201c",
      unlitCore: "#1b1815",
      litWhiteOut: "#fae1b8",
      litWhiteCore: "#e5a04b",
      valText: "#f7efe4",
      ptrCol: "#e8a44a",
      meterOff: "rgba(255, 255, 255, 0.08)",
      meterOn: "#6ab582",
      meterWarn: "#e5a04b",
      meterClip: "#d9534f",
    };
  }
  if (theme === "prism") {
    return {
      isLight: false,
      unlitOut: "#1f2440",
      unlitCore: "#171b33",
      litWhiteOut: "#f9a8d4",
      litWhiteCore: "#ec4899",
      valText: "#ffffff",
      ptrCol: "#38bdf8",
      meterOff: "rgba(255, 255, 255, 0.08)",
      meterOn: "#22d3ee",
      meterWarn: "#c084fc",
      meterClip: "#fb7185",
    };
  }
  if (theme === "brushed") {
    return {
      isLight: false,
      unlitOut: "#22252d",
      unlitCore: "#1a1d24",
      litWhiteOut: "#e0f2fe",
      litWhiteCore: "#7dd3fc",
      valText: "#f4f7fc",
      ptrCol: "#7dd3fc",
      meterOff: "rgba(255, 255, 255, 0.08)",
      meterOn: "#34d399",
      meterWarn: "#facc15",
      meterClip: "#f43f5e",
    };
  }
  if (theme === "carbon") {
    return {
      isLight: false,
      unlitOut: "#1d1f27",
      unlitCore: "#16171e",
      litWhiteOut: "#f6f7fa",
      litWhiteCore: "#e0e2ea",
      valText: "#ffffff",
      ptrCol: "#ef4444",
      meterOff: "rgba(255, 255, 255, 0.08)",
      meterOn: "#e2e8f0",
      meterWarn: "#f97316",
      meterClip: "#ef4444",
    };
  }
  return {
    isLight: false,
    unlitOut: "#1b1c22",
    unlitCore: "#15161b",
    litWhiteOut: "#f4f5f8",
    litWhiteCore: "#dcdde3",
    valText: "#ffffff",
    ptrCol: "#ffffff",
    meterOff: "rgba(255, 255, 255, 0.08)",
    meterOn: "#3eb87e",
    meterWarn: "#cfa844",
    meterClip: "#cc524c",
  };
}

function getPalette(kind, ledMode) {
  const tc = getCompactThemeColors();
  const theme = document.documentElement.dataset.theme || "obsidian";
  if (ledMode === "mono" || theme === "mono") {
    return {
      glow: "rgba(255, 255, 255, 0.045)",
      btnAccent: tc.isLight ? "#181a20" : "#d4d6de",
      pillOuter: tc.litWhiteOut,
      pillCore: tc.litWhiteCore,
      labelCol: tc.isLight ? "#4d5360" : "rgba(220, 222, 230, 0.58)",
    };
  }

  const byKind = {
    main: {
      glow: "rgba(196, 86, 134, 0.095)",
      btnAccent: "#c26c95",
      pillOuter: "#d992b3",
      pillCore: "#be6f95",
      labelCol: "#c57a9d",
    },
    hp: {
      glow: "rgba(74, 168, 158, 0.09)",
      btnAccent: "#5ea89f",
      pillOuter: "#8fd1c8",
      pillCore: "#6eb5ac",
      labelCol: "#72b8af",
    },
    mic: {
      glow: "rgba(138, 112, 194, 0.095)",
      btnAccent: "#947bc7",
      pillOuter: "#b8a3e0",
      pillCore: "#9c84cc",
      labelCol: "#a28cd1",
    },
    pair: {
      glow: "rgba(74, 168, 158, 0.085)",
      btnAccent: "#5ea89f",
      pillOuter: "#8fd1c8",
      pillCore: "#6eb5ac",
      labelCol: "#72b8af",
    },
    rev: {
      glow: "rgba(196, 86, 134, 0.09)",
      btnAccent: "#c26c95",
      pillOuter: "#d992b3",
      pillCore: "#be6f95",
      labelCol: "#c57a9d",
    },
  };

  const p = byKind[kind] || byKind.main;
  if (ledMode === "white") {
    return {
      ...p,
      pillOuter: tc.litWhiteOut,
      pillCore: tc.litWhiteCore,
    };
  }
  return p;
}

export function createCompactWidget(rootEl, store, invoke) {
  const scalerEl = rootEl.querySelector("#compactScaler");
  const gripEl = rootEl.querySelector("#compactCornerGrip");

  const getTargets = () => buildDynamicTargets(store);
  const getTargetMeta = (id) => {
    const list = getTargets();
    return list.find((t) => t.id === id) || list[0];
  };

  let activeTarget = "main";
  let savedTarget = null;
  let lastMicTarget = "mic1";
  let lastSnapshotAt = 0;
  let ledMode = "white"; // "white" (default) | "tinted" | "mono" (saved for future Settings themes)
  let showWave = true;
  let preferredWidth = DEFAULT_W;
  let bindings = new Map();

  // Dial interaction state
  let dialCfg = {
    min: -128,
    max: 0,
    muteAtMin: true,
    defaultValue: -35,
    wheelStep: 1,
    fineWheelStep: 0.5,
    prefixPlus: false,
    onChange: () => {},
  };
  let currentVal = -35;
  let lastActiveVal = -35;
  let isMuted = false;
  let isDragging = false;
  let isScrolling = false;
  let scrollSettleTimer = null;
  let dragStartY = 0;
  let dragStartVal = -35;

  // Build static Stealth Obsidian 512x344 hardware DOM once
  let pillSvgParts = "";
  for (let i = 0; i < DIAL_SEGMENTS; i++) {
    const deg = DIAL_START + (i / (DIAL_SEGMENTS - 1)) * DIAL_SWEEP;
    pillSvgParts += `
      <g transform="rotate(${deg.toFixed(2)} ${DIAL_CX} ${DIAL_CY})">
        <rect class="hw-pill-cutout" x="${DIAL_CX - 3.3}" y="27.5" width="6.6" height="16.2" rx="3.3" style="fill:var(--hw-pill-cutout, #050507)" />
        <rect class="hw-pill-outer" data-idx="${i}" x="${DIAL_CX - 2.45}" y="28.35" width="4.9" height="14.5" rx="2.45" fill="#1b1c22" />
        <rect class="hw-pill-core" data-idx="${i}" x="${DIAL_CX - 1.55}" y="29.35" width="3.1" height="12.5" rx="1.55" fill="#15161b" />
      </g>
    `;
  }

  let meterRowsHtml = "";
  for (let i = 0; i < METER_THRESHOLDS_DB.length; i++) {
    meterRowsHtml += `
      <div class="hw-meter-row">
        <span class="hw-meter-seg" data-ml="${i}"></span>
        <span class="hw-meter-lbl">${METER_LABELS[i]}</span>
        <span class="hw-meter-seg" data-mr="${i}"></span>
      </div>
    `;
  }

  scalerEl.innerHTML = `
    <div class="compact-hw-unit" id="compactHwUnit" data-tauri-drag-region>
      <!-- Left 2x2 Context Settings + Bottom Target Dropdown Pill -->
      <div class="compact-left-col">
        <div class="compact-btn-pair">
          <div class="hw-btn-well"><button type="button" class="hw-btn hw-btn-circle" id="hwCtx0">—</button></div>
          <div class="hw-btn-well"><button type="button" class="hw-btn hw-btn-circle" id="hwCtx1">—</button></div>
        </div>
        <div class="compact-btn-pair">
          <div class="hw-btn-well"><button type="button" class="hw-btn hw-btn-circle" id="hwCtx2">—</button></div>
          <div class="hw-btn-well"><button type="button" class="hw-btn hw-btn-circle" id="hwCtx3">—</button></div>
        </div>
        <div class="hw-btn-well hw-btn-well-pill">
          <button type="button" class="hw-btn hw-btn-pill" id="hwTargetPill" title="Switch Channel / Mix">
            <span id="hwTargetPillText">MAIN</span>
            <svg class="hw-chev" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Center 232x232 Obsidian Stepped LED Dial Disc -->
      <div class="compact-dial-wrap">
        <svg viewBox="0 0 240 240" width="232" height="232" style="display:block">
          <defs>
            <linearGradient id="compactTiGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style="stop-color:var(--hw-knob-top, #303038)" />
              <stop offset="50%" style="stop-color:var(--hw-knob-mid, #1d1d23)" />
              <stop offset="100%" style="stop-color:var(--hw-knob-bot, #131317)" />
            </linearGradient>
            <linearGradient id="compactTiRim" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style="stop-color:var(--hw-knob-rim-top, rgba(255,255,255,0.22))" />
              <stop offset="50%" style="stop-color:var(--hw-knob-rim-mid, rgba(255,255,255,0.05))" />
              <stop offset="100%" style="stop-color:var(--hw-knob-rim-bot, rgba(0,0,0,0.65))" />
            </linearGradient>
          </defs>

          <!-- Outer recessed obsidian disc -->
          <circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="118" style="fill:var(--hw-disc, #09090c);stroke:var(--hw-disc-stroke, rgba(255,255,255,0.065))" stroke-width="1.4" />
          <circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="115" fill="none" style="stroke:var(--hw-disc-inner, rgba(0,0,0,0.75))" stroke-width="2" />

          <!-- 31 Exact Frosted Hardware Pill LED Steps (no halo) -->
          ${pillSvgParts}

          <!-- Recessed central shadow well + Calibrated Titanium dial -->
          <circle cx="${DIAL_CX}" cy="${DIAL_CY + 2}" r="62" style="fill:var(--hw-knob-shadow, rgba(0,0,0,0.72))" />
          <circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="60" fill="url(#compactTiGrad)" stroke="url(#compactTiRim)" stroke-width="2.4" />
          <circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="54" fill="none" style="stroke:var(--dial-bevel, rgba(255,255,255,0.10))" stroke-width="1.1" />

          <!-- Rotating pointer notch -->
          <g id="hwDialRotor" transform="rotate(-138 ${DIAL_CX} ${DIAL_CY})">
            <line id="hwDialPtr" x1="${DIAL_CX}" y1="65" x2="${DIAL_CX}" y2="76" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round" opacity="0.92" />
          </g>

          <!-- Optically centered live readout -->
          <text id="hwDialVal" x="${DIAL_CX}" y="${DIAL_CY}" dy="0.35em" text-anchor="middle" class="hw-dial-val" fill="#ffffff" font-size="27"><tspan id="hwValSign"></tspan><tspan id="hwValBody">-35</tspan><tspan id="hwValPad" fill-opacity="0" aria-hidden="true"></tspan></text>

          <!-- Dynamic interface model + active channel BELOW model -->
          <text id="hwDialModel" x="${DIAL_CX}" y="203" class="hw-dial-model">iD2</text>
          <text id="hwDialChannel" x="${DIAL_CX}" y="220" class="hw-dial-channel" fill="#c57a9d">MAIN</text>

          <!-- Circular hit target (blocks window drag) -->
          <circle id="hwDialHit" cx="${DIAL_CX}" cy="${DIAL_CY}" r="66" fill="transparent" class="hw-dial-hit" />
        </svg>
      </div>

      <!-- Right Vertical Segmented LED Meter + 3 Quick-Switch Buttons (MIC / HP / MAIN) -->
      <div class="compact-right-col">
        <div class="hw-meter-capsule">
          <div class="hw-meter-rows">${meterRowsHtml}</div>
          <div class="hw-meter-foot">
            <span class="hw-meter-tag" id="hwMeterTagMain">MAIN</span>
            <span class="hw-meter-tag" id="hwMeterTagSub">HP</span>
          </div>
        </div>

        <div class="compact-right-btns">
          <div class="hw-btn-well">
            <button type="button" class="hw-btn hw-btn-circle" id="hwQuickMic" title="Toggle Mic 1 / Mic 2">MIC</button>
          </div>
          <div class="hw-btn-well">
            <button type="button" class="hw-btn hw-btn-circle" id="hwQuickHp" title="Headphones 1">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
            </button>
          </div>
          <div class="hw-btn-well">
            <button type="button" class="hw-btn hw-btn-circle" id="hwQuickMain" title="Main Monitor">MAIN</button>
          </div>
        </div>
      </div>

      <!-- Subtle faded bottom ambient waveform (togglable in Settings) -->
      <div class="compact-hw-wave" id="compactHwWave" aria-hidden="true"></div>
    </div>
  `;

  // Cache static DOM elements
  const unitEl = scalerEl.querySelector("#compactHwUnit");
  const ctxBtns = [
    scalerEl.querySelector("#hwCtx0"),
    scalerEl.querySelector("#hwCtx1"),
    scalerEl.querySelector("#hwCtx2"),
    scalerEl.querySelector("#hwCtx3"),
  ];
  const targetPill = scalerEl.querySelector("#hwTargetPill");
  const targetPillText = scalerEl.querySelector("#hwTargetPillText");
  const quickMic = scalerEl.querySelector("#hwQuickMic");
  const quickHp = scalerEl.querySelector("#hwQuickHp");
  const quickMain = scalerEl.querySelector("#hwQuickMain");

  const dialRotor = scalerEl.querySelector("#hwDialRotor");
  const dialPtr = scalerEl.querySelector("#hwDialPtr");
  const dialValText = scalerEl.querySelector("#hwDialVal");
  const valSign = scalerEl.querySelector("#hwValSign");
  const valBody = scalerEl.querySelector("#hwValBody");
  const valPad = scalerEl.querySelector("#hwValPad");
  const dialModelEl = scalerEl.querySelector("#hwDialModel");
  const dialChannelEl = scalerEl.querySelector("#hwDialChannel");
  const dialHit = scalerEl.querySelector("#hwDialHit");

  const pillOuters = Array.from(scalerEl.querySelectorAll(".hw-pill-outer"));
  const pillCores = Array.from(scalerEl.querySelectorAll(".hw-pill-core"));
  const meterSegsL = Array.from(scalerEl.querySelectorAll("[data-ml]"));
  const meterSegsR = Array.from(scalerEl.querySelectorAll("[data-mr]"));
  const meterTagMain = scalerEl.querySelector("#hwMeterTagMain");
  const meterTagSub = scalerEl.querySelector("#hwMeterTagSub");
  const waveHost = scalerEl.querySelector("#compactHwWave");
  const compactWave = waveHost ? createMixWaveform(waveHost, { faded: true, maxSamples: 112 }) : null;

  function syncWaveVisibility() {
    if (!waveHost) return;
    waveHost.hidden = !showWave;
    if (!showWave) compactWave?.clear();
  }
  syncWaveVisibility();

  // Prevent window dragging when pressing interactive buttons
  scalerEl.querySelectorAll("button").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.stopPropagation());
  });

  let ctxHandlers = [null, null, null, null];
  ctxBtns.forEach((btn, idx) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ctxHandlers[idx]) ctxHandlers[idx]();
    });
  });

  function setCenteredVal(str, mutedStyle) {
    const s = String(str);
    const tc = getCompactThemeColors();
    dialValText.setAttribute("fill", mutedStyle ? "#d96c66" : tc.valText);
    dialValText.setAttribute("font-size", mutedStyle ? "19" : "27");
    if (!mutedStyle && s.length > 1 && (s[0] === "-" || s[0] === "+")) {
      valSign.textContent = s[0];
      valBody.textContent = s.slice(1);
      valPad.textContent = s[0];
    } else {
      valSign.textContent = "";
      valBody.textContent = s;
      valPad.textContent = "";
    }
  }

  function renderDial(val, showDecimal = false) {
    const clamped = Math.max(dialCfg.min, Math.min(dialCfg.max, val));
    const effective = showDecimal ? clamped : Math.round(clamped);
    const clean = effective === 0 ? 0 : effective;
    currentVal = clean;
    if (!dialCfg.muteAtMin || clean > dialCfg.min) {
      lastActiveVal = Math.round(clean);
    }

    const meta = getTargetMeta(activeTarget);
    const pal = getPalette(meta.kind, ledMode);
    const tc = getCompactThemeColors();
    const norm = Math.max(0, Math.min(1, (clean - dialCfg.min) / (dialCfg.max - dialCfg.min)));
    const angle = DIAL_START + norm * DIAL_SWEEP;
    const mutedNow = isMuted || (dialCfg.muteAtMin && clean <= dialCfg.min);

    const litOuter = mutedNow ? "#c95a55" : pal.pillOuter;
    const litCore = mutedNow ? "#a84641" : pal.pillCore;

    // Continuous progressive PWM illumination: each notch ramps smoothly from 0% -> 100%
    // as value increases, then hands off seamlessly to the next notch with zero binary jumps
    const exactPos = mutedNow ? 0 : norm * DIAL_SEGMENTS;
    for (let i = 0; i < DIAL_SEGMENTS; i++) {
      if (mutedNow) {
        const endLit = i === 0 || i === DIAL_SEGMENTS - 1;
        pillOuters[i].setAttribute("fill", endLit ? litOuter : tc.unlitOut);
        pillCores[i].setAttribute("fill", endLit ? litCore : tc.unlitCore);
      } else {
        const rawFill = Math.max(0, Math.min(1, exactPos - i));
        const glowT = rawFill <= 0 ? 0 : Math.pow(rawFill, 0.85);
        pillOuters[i].setAttribute("fill", lerpHex(tc.unlitOut, litOuter, glowT));
        pillCores[i].setAttribute("fill", lerpHex(tc.unlitCore, litCore, glowT));
      }
    }

    dialRotor.setAttribute("transform", `rotate(${angle.toFixed(2)} ${DIAL_CX} ${DIAL_CY})`);
    dialPtr.setAttribute("stroke", mutedNow ? "#c95a55" : tc.ptrCol);

    if (mutedNow) {
      setCenteredVal("MUTE", true);
    } else {
      let formatted = showDecimal ? clean.toFixed(1) : String(Math.round(clean));
      if (formatted.endsWith(".0")) formatted = formatted.slice(0, -2);
      const str = dialCfg.prefixPlus && clean > 0 ? `+${formatted}` : formatted;
      setCenteredVal(str, false);
    }
  }

  function pushDial(val, settle = false) {
    const clamped = Math.max(dialCfg.min, Math.min(dialCfg.max, val));
    const quant = settle ? Math.round(clamped) : Math.round(clamped * 10) / 10;
    const targetVal = quant === 0 ? 0 : quant;
    renderDial(targetVal, !settle);
    const hwVal = Math.round(clamped);
    dialCfg.onChange(hwVal === 0 ? 0 : hwVal, settle);
  }

  // Dial pointer/wheel/double-click interaction
  dialHit.addEventListener("mousedown", (e) => e.stopPropagation());
  dialHit.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
    isScrolling = false;
    isDragging = true;
    dialHit.classList.add("dragging");
    dragStartY = e.clientY;
    dragStartVal = currentVal;
    dialHit.setPointerCapture(e.pointerId);
  });
  dialHit.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const span = dialCfg.max - dialCfg.min;
    const sens = (span / 210) * (e.shiftKey ? 0.2 : 1);
    pushDial(dragStartVal + (dragStartY - e.clientY) * sens, false);
  });
  function stopDialDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    dialHit.classList.remove("dragging");
    if (dialHit.hasPointerCapture(e.pointerId)) dialHit.releasePointerCapture(e.pointerId);
    pushDial(currentVal, true);
  }
  dialHit.addEventListener("pointerup", stopDialDrag);
  dialHit.addEventListener("pointercancel", stopDialDrag);
  dialHit.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      isScrolling = true;
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = e.shiftKey ? dialCfg.fineWheelStep : dialCfg.wheelStep;
      pushDial(currentVal + dir * step, false);
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(() => {
        scrollSettleTimer = null;
        isScrolling = false;
        if (!isDragging) pushDial(currentVal, true);
      }, 240);
    },
    { passive: false }
  );
  dialHit.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
    isScrolling = false;
    if (dialCfg.muteAtMin) {
      if (currentVal <= dialCfg.min) {
        pushDial(lastActiveVal > dialCfg.min ? lastActiveVal : dialCfg.defaultValue, true);
      } else {
        pushDial(dialCfg.min, true);
      }
    } else {
      pushDial(dialCfg.defaultValue, true);
    }
  });

  // Live segmented LED meter rendering (fast direct DOM writes, 60fps)
  let smoothL = -128;
  let smoothR = -128;

  function renderMeterLevels(dbL, dbR) {
    smoothL = dbL > smoothL ? dbL : smoothL * 0.72 + dbL * 0.28;
    smoothR = dbR > smoothR ? dbR : smoothR * 0.72 + dbR * 0.28;
    const tc = getCompactThemeColors();
    const mono = ledMode === "mono" || document.documentElement.dataset.theme === "mono";

    for (let i = 0; i < METER_THRESHOLDS_DB.length; i++) {
      const thresh = METER_THRESHOLDS_DB[i];
      const isClip = i === 0;
      const isWarn = i === 1 || i === 2;
      const litL = smoothL >= thresh;
      const litR = smoothR >= thresh;

      const colorFor = (lit) => {
        if (!lit) return isClip ? "rgba(200,72,68,0.14)" : tc.meterOff;
        if (isClip) return tc.meterClip;
        if (mono) return tc.isLight ? "#1a1d25" : "#e2e4ea";
        return isWarn ? tc.meterWarn : tc.meterOn;
      };

      meterSegsL[i].style.background = colorFor(litL);
      meterSegsR[i].style.background = colorFor(litR);
    }
  }

  // Target selection helpers
  function selectTarget(id, persist = true) {
    const list = getTargets();
    if (!list.some((t) => t.id === id)) return;
    activeTarget = id;
    if (id.startsWith("mic")) lastMicTarget = id;
    if (persist) {
      savedTarget = activeTarget;
      store.saveUiPref("compactTarget", activeTarget);
    }
    smoothL = -128;
    smoothR = -128;
    renderMeterLevels(-128, -128);
    compactWave?.clear();
    rebuild();
  }

  quickMain.addEventListener("click", (e) => {
    e.stopPropagation();
    selectTarget("main", true);
  });
  quickHp.addEventListener("click", (e) => {
    e.stopPropagation();
    selectTarget("hp1", true);
  });
  quickMic.addEventListener("click", (e) => {
    e.stopPropagation();
    const mics = getTargets().filter((t) => t.kind === "mic");
    if (mics.length === 0) return;
    const curIdx = mics.findIndex((m) => m.id === activeTarget);
    if (curIdx >= 0) {
      selectTarget(mics[(curIdx + 1) % mics.length].id, true);
    } else {
      const target = mics.some((m) => m.id === lastMicTarget) ? lastMicTarget : mics[0].id;
      selectTarget(target, true);
    }
  });

  targetPill.addEventListener("click", (e) => {
    e.stopPropagation();
    const opts = getTargets().map((t) => ({ value: t.id, name: t.label }));
    openCustomMenu(targetPill, opts, activeTarget, (val) => {
      selectTarget(String(val), true);
    });
  });

  // Helper to configure one of the 4 left circular context buttons
  function setCtxButton(idx, label, onClick) {
    const btn = ctxBtns[idx];
    btn.textContent = label;
    btn.className = "hw-btn hw-btn-circle";
    btn.disabled = !onClick;
    ctxHandlers[idx] = onClick;
  }

  function setBtnTone(idx, active, tone = "is-active") {
    const btn = ctxBtns[idx];
    btn.classList.remove("is-active", "is-red", "is-purple", "is-amber", "is-green");
    if (active) {
      btn.classList.add(ledMode === "mono" ? "is-active" : tone);
    }
  }

  function bind(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!bindings.has(k)) bindings.set(k, []);
    bindings.get(k).push(fn);
  }

  function getInputChannelPath(chIdx) {
    const inputs = store.paths.inputs;
    if (!inputs) return null;
    return store.findChildPath(inputs, (c) => c.tag === "Channel" && c.props?.index === chIdx);
  }

  function getMainMixPair(pairIdx) {
    const mixerPath = store.paths.mixer;
    if (!mixerPath) return null;
    const mainMix = [...mixerPath, 0];
    const pairPath = store.findChildPath(mainMix, (c) => c.tag === "Pair" && c.props?.index === pairIdx);
    if (!pairPath) return null;
    const ch0 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 0) || [...pairPath, 1];
    const ch1 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 1) || [...pairPath, 2];
    return {
      pairPath,
      link: store.findParamPath(pairPath, "StereoLink"),
      ch0: {
        vol: store.findParamPath(ch0, "Vol"),
        mute: store.findParamPath(ch0, "Mute"),
        solo: store.findParamPath(ch0, "Solo"),
      },
      ch1: {
        vol: store.findParamPath(ch1, "Vol"),
        mute: store.findParamPath(ch1, "Mute"),
        solo: store.findParamPath(ch1, "Solo"),
      },
    };
  }

  function syncModelName() {
    const raw = (store.getDeviceName && store.getDeviceName()) || "iD2";
    // Strip trailing "MK3" or extra descriptor if present so it stays crisp like "iD2"
    const shortName = raw.replace(/\s+MK\d+$/i, "").trim() || "iD2";
    dialModelEl.textContent = shortName;
  }

  function rebuild() {
    bindings.clear();
    const meta = getTargetMeta(activeTarget);
    const pal = getPalette(meta.kind, ledMode);
    const p = store.paths;

    unitEl.style.setProperty("--unit-glow", pal.glow);
    unitEl.style.setProperty("--btn-active", pal.btnAccent);
    dialChannelEl.textContent = meta.label;
    dialChannelEl.setAttribute("fill", pal.labelCol);
    targetPillText.textContent = meta.label;
    syncModelName();

    // Right column quick-switch highlights
    const onMic = meta.kind === "mic";
    quickMic.textContent = onMic ? meta.label : "MIC";
    quickMic.classList.toggle("is-active", onMic);
    quickHp.classList.toggle("is-active", activeTarget === "hp1");
    quickMain.classList.toggle("is-active", activeTarget === "main");

    // Meter capsule footer tags
    meterTagMain.classList.toggle("lit", activeTarget === "main");
    meterTagSub.classList.remove("lit", "lit-mic");
    if (activeTarget === "hp1") {
      meterTagSub.textContent = "HP 1";
      meterTagSub.classList.add("lit");
    } else if (onMic) {
      meterTagSub.textContent = `CH ${(meta.meterIdx ?? 0) + 1}`;
      meterTagSub.classList.add("lit-mic");
    } else if (activeTarget !== "main") {
      meterTagSub.textContent = "MIX";
      meterTagSub.classList.add("lit");
    } else {
      meterTagSub.textContent = "HP 1";
    }

    // 1) MAIN MONITOR
    if (activeTarget === "main") {
      dialCfg = {
        min: -128,
        max: 0,
        muteAtMin: true,
        defaultValue: -35,
        wheelStep: 1,
        fineWheelStep: 0.5,
        prefixPlus: false,
        onChange: (val) => {
          if (p.mainVol) store.setParam(p.mainVol, val);
          else invoke("set_volume", { db: val });
        },
      };
      const syncMain = () => {
        const v = store.getVal(p.mainVol);
        isMuted = Boolean(store.getVal(p.mainMute, 0));
        if (!isDragging && !isScrolling && typeof v === "number") renderDial(v, false);
        else renderDial(currentVal, isDragging || isScrolling);
      };
      bind(p.mainVol, syncMain);
      bind(p.mainMute, syncMain);
      syncMain();

      setCtxButton(0, "MUTE", () => p.mainMute && store.toggleParam(p.mainMute));
      setCtxButton(1, "DIM", () => p.dim && store.toggleParam(p.dim));
      setCtxButton(2, "MONO", () => p.mono && store.toggleParam(p.mono));
      setCtxButton(3, "ALT", () => p.speakerSel && store.setParam(p.speakerSel, store.getVal(p.speakerSel, 0) ? 0 : 1));

      const syncBtns = () => {
        setBtnTone(0, Boolean(store.getVal(p.mainMute, 0)), "is-red");
        setBtnTone(1, Boolean(store.getVal(p.dim, 0)), "is-active");
        setBtnTone(2, Boolean(store.getVal(p.mono, 0)), "is-active");
        const isAlt = Boolean(store.getVal(p.speakerSel, 0));
        ctxBtns[3].textContent = isAlt ? "ALT" : "SPK";
        setBtnTone(3, isAlt, "is-active");
      };
      [p.mainMute, p.dim, p.mono, p.speakerSel].forEach((bp) => bind(bp, syncBtns));
      syncBtns();
      return;
    }

    // 2) HEADPHONES 1
    if (activeTarget === "hp1") {
      dialCfg = {
        min: -128,
        max: 0,
        muteAtMin: true,
        defaultValue: -35,
        wheelStep: 1,
        fineWheelStep: 0.5,
        prefixPlus: false,
        onChange: (val) => {
          if (p.hp1Vol) store.setParam(p.hp1Vol, val);
          else invoke("set_volume", { db: val });
        },
      };
      const syncHp = () => {
        const v = store.getVal(p.hp1Vol);
        isMuted = Boolean(store.getVal(p.hp1Mute, 0));
        if (!isDragging && !isScrolling && typeof v === "number") renderDial(v, false);
        else renderDial(currentVal, isDragging || isScrolling);
      };
      bind(p.hp1Vol, syncHp);
      bind(p.hp1Mute, syncHp);
      syncHp();

      setCtxButton(0, "MUTE", () => p.hp1Mute && store.toggleParam(p.hp1Mute));
      setCtxButton(1, "MAIN", () => p.hp1Src && store.setParam(p.hp1Src, 0));
      setCtxButton(2, "MIX A", () => p.hp1Src && store.setParam(p.hp1Src, 1));
      setCtxButton(3, "MIX B", () => p.hp1Src && store.setParam(p.hp1Src, 2));

      const syncHpBtns = () => {
        setBtnTone(0, Boolean(store.getVal(p.hp1Mute, 0)), "is-red");
        const src = Number(store.getVal(p.hp1Src, 0));
        setBtnTone(1, src === 0, "is-active");
        setBtnTone(2, src === 1, "is-purple");
        setBtnTone(3, src === 2, "is-active");
      };
      bind(p.hp1Mute, syncHpBtns);
      bind(p.hp1Src, syncHpBtns);
      syncHpBtns();
      return;
    }

    // 3) MIC PREAMPS (dynamic: MIC 1..N)
    if (meta.kind === "mic") {
      const chPath = getInputChannelPath(meta.inCh);
      const gainPath = chPath ? store.findParamPath(chPath, "G") : null;
      const p48Path = chPath ? store.findParamPath(chPath, "48V") : null;
      const mutePath = chPath ? store.findParamPath(chPath, "Mute") : null;
      const hpfPath = chPath ? store.findParamPath(chPath, "HpfEnable") : null;
      const hmxPath = chPath ? store.findParamPath(chPath, "HMX") : null;
      const airPath = chPath ? store.findParamPath(chPath, "AIR") : null;

      dialCfg = {
        min: 0,
        max: 75,
        muteAtMin: false,
        defaultValue: 0,
        wheelStep: 1,
        fineWheelStep: 1,
        prefixPlus: true,
        onChange: (val) => gainPath && store.setParam(gainPath, Math.round(val)),
      };
      const syncGain = () => {
        const v = store.getVal(gainPath, 0);
        isMuted = Boolean(store.getVal(mutePath, 0));
        if (!isDragging && !isScrolling && typeof v === "number") renderDial(v, false);
        else renderDial(currentVal, isDragging || isScrolling);
      };
      bind(gainPath, syncGain);
      bind(mutePath, syncGain);
      syncGain();

      setCtxButton(0, "48V", () => p48Path && store.toggleParam(p48Path));
      setCtxButton(1, "GLOW", () => {
        if (!hmxPath || !airPath) return;
        const next = store.getVal(hmxPath, 0) && store.getVal(airPath, 0) ? 0 : 1;
        store.setParam(hmxPath, next);
        store.setParam(airPath, next);
      });
      setCtxButton(2, "MUTE", () => mutePath && store.toggleParam(mutePath));
      setCtxButton(3, "HPF", () => hpfPath && store.toggleParam(hpfPath));

      const syncMicBtns = () => {
        setBtnTone(0, Boolean(store.getVal(p48Path, 0)), "is-red");
        setBtnTone(1, Boolean(store.getVal(hmxPath, 0)) && Boolean(store.getVal(airPath, 0)), "is-purple");
        setBtnTone(2, Boolean(store.getVal(mutePath, 0)), "is-red");
        setBtnTone(3, Boolean(store.getVal(hpfPath, 0)), "is-green");
      };
      [p48Path, hmxPath, airPath, mutePath, hpfPath].forEach((bp) => bind(bp, syncMicBtns));
      syncMicBtns();
      return;
    }

    // 4) COMP OUT 1+2 / 3+4 / 5+6 & REVERB (Main Mix Stereo Pairs)
    const pair = getMainMixPair(meta.pairIdx);
    dialCfg = {
      min: -128,
      max: 6,
      muteAtMin: true,
      defaultValue: 0,
      wheelStep: 1,
      fineWheelStep: 0.5,
      prefixPlus: true,
      onChange: (val) => {
        if (!pair) return;
        store.setParam(pair.ch0.vol, val);
        store.setParam(pair.ch1.vol, val);
      },
    };
    const syncPair = () => {
      const v = pair ? store.getVal(pair.ch0.vol, 0) : 0;
      isMuted = Boolean(pair && (store.getVal(pair.ch0.mute, 0) || store.getVal(pair.ch1.mute, 0)));
      if (!isDragging && !isScrolling && typeof v === "number") renderDial(v, false);
      else renderDial(currentVal, isDragging || isScrolling);
    };
    if (pair) {
      [pair.ch0.vol, pair.ch0.mute, pair.ch1.mute].forEach((bp) => bind(bp, syncPair));
    }
    syncPair();

    setCtxButton(0, "MUTE", () => {
      if (!pair) return;
      const next = store.getVal(pair.ch0.mute, 0) || store.getVal(pair.ch1.mute, 0) ? 0 : 1;
      store.setParam(pair.ch0.mute, next);
      store.setParam(pair.ch1.mute, next);
    });
    setCtxButton(1, "SOLO", () => {
      if (!pair) return;
      const next = store.getVal(pair.ch0.solo, 0) || store.getVal(pair.ch1.solo, 0) ? 0 : 1;
      store.setParam(pair.ch0.solo, next);
      store.setParam(pair.ch1.solo, next);
    });
    setCtxButton(2, "STEREO", () => {
      if (!pair) return;
      store.setParam(pair.link, store.getVal(pair.link, 0) ? 0 : 1);
    });
    setCtxButton(3, "0 dB", () => {
      if (!pair) return;
      store.setParam(pair.ch0.vol, 0);
      store.setParam(pair.ch1.vol, 0);
    });

    const syncPairBtns = () => {
      if (!pair) return;
      setBtnTone(0, Boolean(store.getVal(pair.ch0.mute, 0) || store.getVal(pair.ch1.mute, 0)), "is-red");
      setBtnTone(1, Boolean(store.getVal(pair.ch0.solo, 0) || store.getVal(pair.ch1.solo, 0)), "is-amber");
      const linked = Boolean(store.getVal(pair.link, 0));
      ctxBtns[2].textContent = linked ? "STEREO" : "MONO";
      setBtnTone(2, linked, "is-active");
      const curV = Number(store.getVal(pair.ch0.vol, -128));
      setBtnTone(3, Math.abs(curV) < 0.25, "is-active");
    };
    if (pair) {
      [pair.ch0.mute, pair.ch1.mute, pair.ch0.solo, pair.ch1.solo, pair.link, pair.ch0.vol].forEach((bp) =>
        bind(bp, syncPairBtns)
      );
    }
    syncPairBtns();
  }

  // --- Proportional Scaling & Corner-Only Window Resize ---
  function syncScale() {
    const w = rootEl.clientWidth || window.innerWidth;
    const h = rootEl.clientHeight || window.innerHeight;
    if (w < 100 || h < 100) return;
    const scale = Math.min(w / BASE_W, h / BASE_H);
    scalerEl.style.transform = `scale(${scale})`;
  }

  if (gripEl) {
    let resizing = false;
    let startScreenX = 0;
    let startScreenY = 0;
    let startWinW = DEFAULT_W;
    let pendingW = DEFAULT_W;
    let rafId = null;

    gripEl.addEventListener("mousedown", (e) => e.stopPropagation());
    gripEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      gripEl.classList.add("resizing");
      startScreenX = e.screenX;
      startScreenY = e.screenY;
      startWinW = window.innerWidth || preferredWidth;
      pendingW = startWinW;
      gripEl.setPointerCapture(e.pointerId);
    });

    gripEl.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const dx = e.screenX - startScreenX;
      const dy = e.screenY - startScreenY;
      const delta = (dx + dy * ASPECT) * 0.5;
      pendingW = Math.round(Math.max(MIN_W, Math.min(MAX_W, startWinW + delta)));
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const nextH = Math.round(pendingW / ASPECT);
          preferredWidth = pendingW;
          invoke("resize_compact_window", { width: pendingW, height: nextH }).catch(() => {});
          scalerEl.style.transform = `scale(${pendingW / BASE_W})`;
        });
      }
    });

    const stopResize = (e) => {
      if (!resizing) return;
      resizing = false;
      gripEl.classList.remove("resizing");
      if (gripEl.hasPointerCapture(e.pointerId)) gripEl.releasePointerCapture(e.pointerId);
      preferredWidth = pendingW;
      store.saveUiPref("compactWidth", preferredWidth);
      syncScale();
    };
    gripEl.addEventListener("pointerup", stopResize);
    gripEl.addEventListener("pointercancel", stopResize);
  }

  // --- Store Subscriptions ---
  store.onUiPrefs((prefs) => {
    if (typeof prefs.compactTarget === "string" && prefs.compactTarget.length > 0) {
      savedTarget = prefs.compactTarget;
      if (getTargets().some((t) => t.id === savedTarget)) {
        activeTarget = savedTarget;
        if (activeTarget.startsWith("mic")) lastMicTarget = activeTarget;
        rebuild();
      }
    }
    if (typeof prefs.compactWidth === "number" && Number.isFinite(prefs.compactWidth)) {
      preferredWidth = Math.round(Math.max(MIN_W, Math.min(MAX_W, prefs.compactWidth)));
    }
    if (prefs.compactTheme === "white" || prefs.compactTheme === "tinted" || prefs.compactTheme === "mono") {
      ledMode = prefs.compactTheme;
      rebuild();
    }
    if (typeof prefs.compactWave === "boolean") {
      showWave = prefs.compactWave;
      syncWaveVisibility();
    }
  });

  store.onSnapshot(() => {
    lastSnapshotAt = performance.now();
    if (savedTarget && getTargets().some((t) => t.id === savedTarget) && activeTarget !== savedTarget) {
      activeTarget = savedTarget;
      if (activeTarget.startsWith("mic")) lastMicTarget = activeTarget;
    }
    rebuild();
  });

  store.onParam((changedPath, prop, _val, isLocal) => {
    const ck = pathKey(changedPath);
    // Auto-follow genuine physical hardware knob turns ONLY while Compact Mode is visible
    // and after initial connect/snapshot sync has settled (never hijack on startup or Full Console edits)
    const compactVisible = rootEl.offsetParent !== null;
    const settled = performance.now() - lastSnapshotAt > 1500;
    if (prop === "value" && !isLocal && compactVisible && settled && !isDragging && !isScrolling) {
      let autoTarget = null;
      if (
        (store.paths.mainVol && ck === pathKey(store.paths.mainVol)) ||
        (store.paths.mainMute && ck === pathKey(store.paths.mainMute)) ||
        (store.paths.dim && ck === pathKey(store.paths.dim)) ||
        (store.paths.mono && ck === pathKey(store.paths.mono))
      ) {
        autoTarget = "main";
      } else if (
        (store.paths.hp1Vol && ck === pathKey(store.paths.hp1Vol)) ||
        (store.paths.hp1Mute && ck === pathKey(store.paths.hp1Mute))
      ) {
        autoTarget = "hp1";
      } else if (store.paths.inputs) {
        const targets = getTargets();
        for (const t of targets) {
          if (t.kind === "mic") {
            const chP = store.findChildPath(store.paths.inputs, (c) => c.tag === "Channel" && c.props?.index === t.inCh);
            if (!chP) continue;
            const gP = store.findParamPath(chP, "G");
            const p48 = store.findParamPath(chP, "48V");
            const mP = store.findParamPath(chP, "Mute");
            if (
              (gP && ck === pathKey(gP)) ||
              (p48 && ck === pathKey(p48)) ||
              (mP && ck === pathKey(mP))
            ) {
              autoTarget = t.id;
              break;
            }
          }
        }
      }
      if (autoTarget && autoTarget !== activeTarget) {
        selectTarget(autoTarget, false);
        return;
      }
    }

    const cbs = bindings.get(ck);
    if (cbs) cbs.forEach((fn) => fn());
  });

  store.onMeters((mf) => {
    const meta = getTargetMeta(activeTarget);
    let l = -128;
    let r = -128;

    if (activeTarget === "hp1") {
      const room = mf.room || [];
      const mixbus = mf.mixbus || [];
      const hpSrcIdx = Number(store.getVal(store.paths.hp1Src, 0));
      const hpRawL = room[4] ?? -128;
      const hpRawR = room[5] ?? -128;
      if (hpRawL > -120 || hpRawR > -120) {
        l = hpRawL;
        r = hpRawR;
      } else if (hpSrcIdx === 1) {
        l = mixbus[2] ?? -128;
        r = mixbus[3] ?? -128;
      } else if (hpSrcIdx === 2) {
        l = mixbus[4] ?? -128;
        r = mixbus[5] ?? -128;
      } else {
        l = mixbus[0] ?? room[0] ?? -128;
        r = mixbus[1] ?? room[1] ?? -128;
      }
    } else if (activeTarget === "main") {
      const room = mf.room || [];
      l = room[0] ?? -128;
      r = room[1] ?? -128;
    } else if (meta.kind === "mic") {
      const an = mf.analogue || [];
      const v = an[meta.meterIdx ?? meta.inCh ?? 0] ?? -128;
      l = v;
      r = v;
    } else if (meta.meterGroup) {
      const arr = mf[meta.meterGroup] || [];
      l = arr[meta.meterBase] ?? -128;
      r = arr[meta.meterBase + 1] ?? -128;
    }

    renderMeterLevels(l, r);
    if (showWave) compactWave?.pushLevel(l, r);
  });

  rebuild();
  syncScale();

  return {
    syncScale,
    refreshTheme() {
      rebuild();
      renderMeterLevels(smoothL, smoothR);
    },
    getPreferredWidth() {
      return preferredWidth;
    },
    setTheme(mode) {
      if (mode === "white" || mode === "tinted" || mode === "mono") {
        ledMode = mode;
        rebuild();
      }
    },
    setShowWave(enabled) {
      showWave = Boolean(enabled);
      syncWaveVisibility();
    },
    setFallbackVolume(db) {
      if (typeof db === "number" && (activeTarget === "hp1" || activeTarget === "main")) {
        renderDial(db, false);
      }
    },
  };
}
