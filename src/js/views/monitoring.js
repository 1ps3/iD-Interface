// Monitoring View: 3D Spatial RoomTune™ Soundstage (scales dynamically 2.0 -> 9.1.6)
// + Clean Full-Height Main Out & HP1 Output Meters

import { createStereoMeter } from "../components/meter.js";
import { pathKey } from "../store.js";

// Standard ITU / Dolby Atmos speaker positions (normalized room coordinates:
// x: -1..+1 left-right, y: -1..+1 front-back, z: 0=ear, 1=overhead, role: ear|sub|height)
const SPEAKER_MAP = {
  L: { x: -0.68, y: -0.66, z: 0, role: "ear", full: "LEFT SPEAKER" },
  R: { x: 0.68, y: -0.66, z: 0, role: "ear", full: "RIGHT SPEAKER" },
  C: { x: 0.0, y: -0.78, z: 0, role: "ear", full: "CENTER" },
  LFE: { x: -0.32, y: -0.72, z: 0, role: "sub", full: "SUBWOOFER (LFE)" },
  SUB: { x: -0.32, y: -0.72, z: 0, role: "sub", full: "SUBWOOFER" },
  LFE1: { x: -0.32, y: -0.72, z: 0, role: "sub", full: "LFE 1" },
  LFE2: { x: 0.32, y: -0.72, z: 0, role: "sub", full: "LFE 2" },
  LW: { x: -0.84, y: -0.26, z: 0, role: "ear", full: "LEFT WIDE" },
  RW: { x: 0.84, y: -0.26, z: 0, role: "ear", full: "RIGHT WIDE" },
  LS: { x: -0.86, y: 0.16, z: 0, role: "ear", full: "LEFT SURROUND" },
  RS: { x: 0.86, y: 0.16, z: 0, role: "ear", full: "RIGHT SURROUND" },
  LSS: { x: -0.86, y: 0.16, z: 0, role: "ear", full: "LEFT SIDE SURROUND" },
  RSS: { x: 0.86, y: 0.16, z: 0, role: "ear", full: "RIGHT SIDE SURROUND" },
  LRS: { x: -0.58, y: 0.74, z: 0, role: "ear", full: "LEFT REAR SURROUND" },
  RRS: { x: 0.58, y: 0.74, z: 0, role: "ear", full: "RIGHT REAR SURROUND" },
  LB: { x: -0.58, y: 0.74, z: 0, role: "ear", full: "LEFT BACK" },
  RB: { x: 0.58, y: 0.74, z: 0, role: "ear", full: "RIGHT BACK" },
  CS: { x: 0.0, y: 0.8, z: 0, role: "ear", full: "CENTER SURROUND" },
  CB: { x: 0.0, y: 0.8, z: 0, role: "ear", full: "CENTER BACK" },
  LTF: { x: -0.44, y: -0.42, z: 1, role: "height", full: "LEFT TOP FRONT" },
  RTF: { x: 0.44, y: -0.42, z: 1, role: "height", full: "RIGHT TOP FRONT" },
  LTM: { x: -0.52, y: 0.04, z: 1, role: "height", full: "LEFT TOP MIDDLE" },
  RTM: { x: 0.52, y: 0.04, z: 1, role: "height", full: "RIGHT TOP MIDDLE" },
  LTR: { x: -0.44, y: 0.48, z: 1, role: "height", full: "LEFT TOP REAR" },
  RTR: { x: 0.44, y: 0.48, z: 1, role: "height", full: "RIGHT TOP REAR" },
};

const SPK_WAVE_SVG = `<svg class="rt-spk-wave" viewBox="0 0 24 24" aria-hidden="true">
  <line x1="5" y1="9" x2="5" y2="15" />
  <line x1="8.5" y1="6.5" x2="8.5" y2="17.5" />
  <line x1="12" y1="8.5" x2="12" y2="15.5" />
  <line x1="15.5" y1="5.5" x2="15.5" y2="18.5" />
  <line x1="19" y1="9" x2="19" y2="15" />
</svg>`;

function classifySpeaker(code, idx, total) {
  const key = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (SPEAKER_MAP[key]) {
    return { ...SPEAKER_MAP[key], code: code.toUpperCase() };
  }
  const angle = -Math.PI * 0.78 + (total > 1 ? (idx / (total - 1)) * Math.PI * 1.56 : 0);
  return {
    x: Math.sin(angle) * 0.74,
    y: -Math.cos(angle) * 0.68,
    z: 0,
    role: "ear",
    full: `SPEAKER ${code.toUpperCase()}`,
    code: code.toUpperCase(),
  };
}

function computeLayoutLabel(speakers) {
  let ear = 0;
  let sub = 0;
  let height = 0;
  for (const s of speakers) {
    if (s.role === "sub") sub += 1;
    else if (s.role === "height") height += 1;
    else ear += 1;
  }
  if (height > 0) return `${ear}.${sub}.${height}`;
  return `${ear}.${sub}`;
}

// Project normalized 3D room coordinates (x, y, z) onto a clean perspective soundstage (%)
function projectToStage(x, y, z, hasRear) {
  const userX = 50;
  const userY = hasRear ? 54 : 66;

  // Gentle 3D room perspective foreshortening toward the front wall
  const depthFactor = 0.88 + (y + 1) * 0.085; // narrower at front wall, wider near rear
  const halfSpanX = hasRear ? 41 : 39;
  const halfSpanY = hasRear ? 37 : 42;

  const baseX = 50 + x * halfSpanX * depthFactor;
  const baseY = (hasRear ? 53 : 56) + y * halfSpanY;
  // Overhead height speakers lift visually upward with a vertical tether to their floor shadow
  const liftY = z > 0 ? -6.5 : 0;

  return {
    xPct: Math.max(8, Math.min(92, baseX)),
    yPct: Math.max(12, Math.min(88, baseY + liftY)),
    shadowYPct: Math.max(12, Math.min(88, baseY)),
    userX,
    userY,
  };
}

export function createMonitoringView(container, store) {
  let mainMeter = null;
  let hp1Meter = null;
  let paramBindings = new Map();
  let selectedSpkIdx = 0;
  let speakerNodeEls = [];
  let stageResizeObs = null;

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2 class="view-title">MONITORING</h2>
        <p class="view-subtitle">3D Spatial RoomTune™ Soundstage &amp; Output Metering</p>
      </div>
    </div>

    <div class="monitoring-layout">
      <!-- Left: 3D Spatial RoomTune Soundstage -->
      <div class="roomtune-stage" id="roomtuneStage"></div>

      <!-- Right: Clean Full-Height Output Meters Card -->
      <div class="monitoring-meters-card">
        <div class="mon-meters-head">
          <span class="dock-title">OUTPUT METERS</span>
          <button class="mini-pill-btn" id="btnResetMonPeaks" title="Clear Peak Hold &amp; Latched Clips">RESET</button>
        </div>
        <div class="mon-meters-row">
          <div class="mon-meter-bay">
            <div class="mon-meter-bay-head">
              <span class="meter-col-label">MAIN OUT</span>
              <span class="meter-col-sub">1–2</span>
            </div>
            <div class="meter-tall-slot" id="monMainMeter"></div>
          </div>
          <div class="mon-meter-bay">
            <div class="mon-meter-bay-head">
              <span class="meter-col-label">PHONES</span>
              <span class="meter-col-sub">HP 1</span>
            </div>
            <div class="meter-tall-slot" id="monHpMeter"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const stageEl = container.querySelector("#roomtuneStage");
  mainMeter = createStereoMeter(container.querySelector("#monMainMeter"), { frameless: true });
  hp1Meter = createStereoMeter(container.querySelector("#monHpMeter"), { frameless: true });

  container.querySelector("#btnResetMonPeaks").addEventListener("click", () => {
    mainMeter.resetPeak();
    hp1Meter.resetPeak();
  });

  function bind(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!paramBindings.has(k)) paramBindings.set(k, []);
    paramBindings.get(k).push(fn);
  }

  function rebuildRoomTune() {
    if (stageResizeObs) {
      stageResizeObs.disconnect();
      stageResizeObs = null;
    }
    paramBindings.clear();
    speakerNodeEls = [];
    stageEl.innerHTML = "";

    const rcPath = store.paths.roomCorr;
    if (!rcPath) {
      stageEl.innerHTML = `<div class="phase-placeholder"><span class="phase-tag">ROOMTUNE</span><h3>Connecting to device…</h3></div>`;
      return;
    }

    const rcNode = store.getNode(rcPath);
    const bypsPath = store.findParamPath(rcPath, "byps");
    const mainBypsPath = store.findParamPath(rcPath, "MainByps");
    const altBypsPath = store.findParamPath(rcPath, "AltByps");
    const curProfPath = store.findParamPath(rcPath, "CurProfile");
    const profTrimPath = store.findParamPath(rcPath, "ProfTrim");

    // Dynamically discover all RoomCorrection speaker channels (scales 2.0 -> 9.1.6)
    const rawChannels = [];
    rcNode?.children?.forEach((c, idx) => {
      if (c.tag === "Channel") {
        rawChannels.push({
          rawIdx: idx,
          code: (c.props?.name || `CH${rawChannels.length + 1}`).trim(),
          path: [...rcPath, idx],
        });
      }
    });

    const speakers = rawChannels.map((ch, idx) => {
      const meta = classifySpeaker(ch.code, idx, rawChannels.length);
      return {
        ...meta,
        idx,
        path: ch.path,
        trimP: store.findParamPath(ch.path, "SpkTrim"),
        dlyP: store.findParamPath(ch.path, "Dly"),
        dlyOnP: store.findParamPath(ch.path, "DlyOn"),
        muteP: store.findParamPath(ch.path, "Mute"),
        soloP: store.findParamPath(ch.path, "Solo"),
      };
    });

    if (selectedSpkIdx >= speakers.length) selectedSpkIdx = 0;

    const layoutLabel = computeLayoutLabel(speakers);
    const hasRear = speakers.some((s) => s.y > 0.05);
    const hasSub = speakers.some((s) => s.role === "sub");
    const hasHeight = speakers.some((s) => s.z > 0);
    const projected = speakers.map((s) => ({
      ...s,
      pos: projectToStage(s.x, s.y, s.z, hasRear),
    }));
    const userX = 50;
    const userY = hasRear ? 54 : 66;

    stageEl.innerHTML = `
      <div class="rt-top-bar">
        <div class="rt-title-row">
          <span class="dock-title">ROOM</span>
          <span class="telemetry-pill" id="rtProfileBadge">MAIN</span>
          <div class="rt-layout-group">
            <span class="micro-label">SPEAKER LAYOUT:</span>
            <span class="rt-layout-badge">${layoutLabel}</span>
          </div>
        </div>
        <div class="rt-toggles">
          <button class="mini-pill-btn green-active" id="btnRtGlobal">BYPASSED</button>
          <button class="mini-pill-btn" id="btnRtMain">MAIN</button>
          <button class="mini-pill-btn" id="btnRtAlt">ALT</button>
        </div>
      </div>

      <!-- Clean 2.5D Elevation-Coded Acoustic Soundstage -->
      <div class="rt-stage-3d" id="rtStage3d">
        <div class="rt-front-bar" aria-hidden="true"><span>FRONT</span></div>

        <svg class="rt-stage-svg" id="rtStageSvg" viewBox="0 0 640 440" aria-hidden="true">
          <!-- Subtle acoustic listening axes centered dead-on LISTENER -->
          <line id="rtAxisV" class="rt-room-axis" />
          <line id="rtAxisH" class="rt-room-axis" />
          <!-- True 1:1 circular polar distance rings centered on LISTENER -->
          <circle id="rtRingInner" class="rt-room-arc" />
          <circle id="rtRingOuter" class="rt-room-arc" />
          ${hasHeight ? `<circle id="rtRingHeight" class="rt-room-arc-height" />` : ""}
          <!-- Exact center-to-center elevation-colored sightlines -->
          ${projected
            .map((s) => {
              const roleCls = s.role === "height" ? "beam-height" : s.role === "sub" ? "beam-sub" : "beam-ear";
              return `
            ${
              s.z > 0
                ? `<line class="rt-height-tether" data-tether-idx="${s.idx}" />
                   <ellipse class="rt-height-shadow" data-shadow-idx="${s.idx}" rx="10" ry="5" />`
                : ""
            }
            <line class="rt-beam ${roleCls}" data-beam-idx="${s.idx}" />`;
            })
            .join("")}
        </svg>

        <!-- Dynamic Speaker Nodes (2.0 up to 9.1.6) -->
        <div class="rt-nodes-layer" id="rtNodesLayer">
          ${projected
            .map(
              (s) => `
            <button
              type="button"
              class="rt-spk-node ${s.role === "height" ? "is-height" : ""} ${s.role === "sub" ? "is-sub" : ""} ${s.idx === selectedSpkIdx ? "selected" : ""}"
              data-spk-idx="${s.idx}"
              style="left:${s.pos.xPct.toFixed(2)}%;top:${s.pos.yPct.toFixed(2)}%;"
              title="${s.full} — Click to adjust Trim, Delay, Mute & Solo"
            >
              <span class="rt-spk-orb">
                <span class="rt-spk-pulse"></span>
                ${SPK_WAVE_SVG}
                <span class="rt-spk-flag" data-flag-idx="${s.idx}"></span>
              </span>
              <span class="rt-spk-code">${s.code}</span>
              <span class="rt-spk-meta" data-meta-idx="${s.idx}"></span>
            </button>`
            )
            .join("")}
        </div>

        <!-- Minimal Studio Listener Sweet-Spot Medallion (USER) -->
        <div class="rt-user-node" style="left:${userX}%;top:${userY}%;">
          <span class="rt-user-arrow" aria-hidden="true"></span>
          <span class="rt-user-head" aria-hidden="true">
            <svg class="rt-user-svg" viewBox="0 0 24 24">
              <path d="M5.5 13.5v-1a6.5 6.5 0 0 1 13 0v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <rect x="4" y="12.5" width="3" height="5.2" rx="1.4" fill="currentColor"/>
              <rect x="17" y="12.5" width="3" height="5.2" rx="1.4" fill="currentColor"/>
              <circle cx="12" cy="12" r="2.2" fill="currentColor" opacity="0.85"/>
            </svg>
          </span>
          <span class="rt-user-label">LISTENER</span>
        </div>

        <!-- Elevation Color Legend -->
        <div class="rt-elev-legend" aria-label="Speaker Elevation Key">
          <span class="rt-leg-item is-present"><span class="rt-leg-dot dot-ear"></span>EAR LEVEL</span>
          <span class="rt-leg-item ${hasSub ? "is-present" : ""}"><span class="rt-leg-dot dot-sub"></span>SUB / LFE</span>
          <span class="rt-leg-item ${hasHeight ? "is-present" : ""}"><span class="rt-leg-dot dot-height"></span>OVERHEAD</span>
        </div>
      </div>

      <!-- Compact Bottom Inspector Strip: Selected Speaker Controls + Profile Trim -->
      <div class="rt-bottom-dock">
        <div class="rt-spk-inspector" id="rtSpkInspector"></div>
        <div class="rt-prof-trim-inline">
          <span class="micro-label">PROFILE TRIM</span>
          <input type="range" class="mini-slider" id="rtProfTrim" min="-12" max="12" step="0.1" />
          <span class="comp-val" id="rtProfTrimVal">+0.0 dB</span>
        </div>
      </div>
    `;

    const profBadge = stageEl.querySelector("#rtProfileBadge");
    const btnGlobal = stageEl.querySelector("#btnRtGlobal");
    const btnMain = stageEl.querySelector("#btnRtMain");
    const btnAlt = stageEl.querySelector("#btnRtAlt");
    const trimSlider = stageEl.querySelector("#rtProfTrim");
    const trimVal = stageEl.querySelector("#rtProfTrimVal");
    const spkInspector = stageEl.querySelector("#rtSpkInspector");

    const rtStage3d = stageEl.querySelector("#rtStage3d");
    const rtStageSvg = stageEl.querySelector("#rtStageSvg");
    const syncStageGeometry = () => {
      if (!rtStage3d || !rtStageSvg) return;
      const w = rtStage3d.clientWidth || 640;
      const h = rtStage3d.clientHeight || 440;
      if (w < 10 || h < 10) return;

      rtStageSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const ux = (userX / 100) * w;
      const uy = (userY / 100) * h;
      const minDim = Math.min(w, h);

      const axV = rtStageSvg.querySelector("#rtAxisV");
      const axH = rtStageSvg.querySelector("#rtAxisH");
      if (axV) {
        axV.setAttribute("x1", ux.toFixed(1));
        axV.setAttribute("y1", (h * 0.08).toFixed(1));
        axV.setAttribute("x2", ux.toFixed(1));
        axV.setAttribute("y2", (h * 0.94).toFixed(1));
      }
      if (axH) {
        axH.setAttribute("x1", (w * 0.05).toFixed(1));
        axH.setAttribute("y1", uy.toFixed(1));
        axH.setAttribute("x2", (w * 0.95).toFixed(1));
        axH.setAttribute("y2", uy.toFixed(1));
      }

      const setRing = (id, r) => {
        const el = rtStageSvg.querySelector(id);
        if (!el) return;
        el.setAttribute("cx", ux.toFixed(1));
        el.setAttribute("cy", uy.toFixed(1));
        el.setAttribute("r", r.toFixed(1));
      };
      // True 1:1 pixel circles regardless of window width/height ratio!
      setRing("#rtRingInner", minDim * 0.24);
      setRing("#rtRingOuter", minDim * 0.46);
      setRing("#rtRingHeight", minDim * 0.35);

      for (const s of projected) {
        const sx = (s.pos.xPct / 100) * w;
        const sy = (s.pos.yPct / 100) * h;
        const shy = (s.pos.shadowYPct / 100) * h;
        const beam = rtStageSvg.querySelector(`[data-beam-idx="${s.idx}"]`);
        if (beam) {
          beam.setAttribute("x1", sx.toFixed(1));
          beam.setAttribute("y1", sy.toFixed(1));
          beam.setAttribute("x2", ux.toFixed(1));
          beam.setAttribute("y2", uy.toFixed(1));
        }
        const tether = rtStageSvg.querySelector(`[data-tether-idx="${s.idx}"]`);
        if (tether) {
          tether.setAttribute("x1", sx.toFixed(1));
          tether.setAttribute("y1", sy.toFixed(1));
          tether.setAttribute("x2", sx.toFixed(1));
          tether.setAttribute("y2", shy.toFixed(1));
        }
        const shadow = rtStageSvg.querySelector(`[data-shadow-idx="${s.idx}"]`);
        if (shadow) {
          shadow.setAttribute("cx", sx.toFixed(1));
          shadow.setAttribute("cy", shy.toFixed(1));
        }
      }
    };

    if (rtStage3d && typeof ResizeObserver !== "undefined") {
      stageResizeObs = new ResizeObserver(syncStageGeometry);
      stageResizeObs.observe(rtStage3d);
    }
    syncStageGeometry();
    requestAnimationFrame(syncStageGeometry);

    const nodeButtons = Array.from(stageEl.querySelectorAll(".rt-spk-node"));
    const beamLines = Array.from(stageEl.querySelectorAll(".rt-beam"));
    speakerNodeEls = nodeButtons;

    const syncTop = () => {
      profBadge.textContent = store.getOptionLabel(curProfPath, "Main").toUpperCase();
      const globalOn = !store.getVal(bypsPath, 1);
      const mainOn = !store.getVal(mainBypsPath, 1);
      const altOn = !store.getVal(altBypsPath, 1);
      btnGlobal.classList.toggle("active", globalOn);
      btnGlobal.textContent = globalOn ? "ENABLED" : "BYPASSED";
      btnMain.classList.toggle("active", mainOn);
      btnAlt.classList.toggle("active", altOn);

      const tv = Number(store.getVal(profTrimPath, 0));
      trimSlider.value = String(tv);
      trimVal.textContent = `${tv >= 0 ? "+" : ""}${tv.toFixed(1)} dB`;
    };

    btnGlobal.addEventListener("click", () => store.toggleParam(bypsPath));
    btnMain.addEventListener("click", () => store.toggleParam(mainBypsPath));
    btnAlt.addEventListener("click", () => store.toggleParam(altBypsPath));
    trimSlider.addEventListener("input", () => {
      const v = Number(trimSlider.value);
      trimVal.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;
      store.setParam(profTrimPath, v);
    });

    bind(curProfPath, syncTop);
    bind(bypsPath, syncTop);
    bind(mainBypsPath, syncTop);
    bind(altBypsPath, syncTop);
    bind(profTrimPath, syncTop);
    syncTop();

    function syncSpeakerNodeVisual(s) {
      const btn = nodeButtons[s.idx];
      const beam = beamLines[s.idx];
      if (!btn) return;
      const muted = Boolean(store.getVal(s.muteP, 0));
      const soloed = Boolean(store.getVal(s.soloP, 0));
      const t = Number(store.getVal(s.trimP, 0));
      const dlyOn = Boolean(store.getVal(s.dlyOnP, 0));
      const d = Number(store.getVal(s.dlyP, 0));

      btn.classList.toggle("selected", s.idx === selectedSpkIdx);
      btn.classList.toggle("is-muted", muted);
      btn.classList.toggle("is-soloed", soloed);
      if (beam) {
        beam.classList.toggle("selected", s.idx === selectedSpkIdx);
        beam.classList.toggle("muted", muted);
      }

      const flagEl = btn.querySelector(`[data-flag-idx="${s.idx}"]`);
      if (flagEl) {
        if (muted) {
          flagEl.textContent = "M";
          flagEl.className = "rt-spk-flag flag-mute";
        } else if (soloed) {
          flagEl.textContent = "S";
          flagEl.className = "rt-spk-flag flag-solo";
        } else {
          flagEl.textContent = "";
          flagEl.className = "rt-spk-flag";
        }
      }

      const metaEl = btn.querySelector(`[data-meta-idx="${s.idx}"]`);
      if (metaEl) {
        const parts = [];
        if (Math.abs(t) >= 0.05) parts.push(`${t > 0 ? "+" : ""}${t.toFixed(1)}dB`);
        if (dlyOn && d >= 0.01) parts.push(`${d.toFixed(2)}ms`);
        metaEl.textContent = parts.join(" · ");
      }
    }

    function renderSelectedSpeakerInspector() {
      const s = speakers[selectedSpkIdx];
      if (!s) {
        spkInspector.innerHTML = "";
        return;
      }

      spkInspector.innerHTML = `
        <div class="rt-insp-id">
          <span class="rt-spk-icon">${s.code}</span>
          <span class="rt-spk-name">${s.full}</span>
          <div class="rt-spk-ms">
            <button class="ms-btn mute-btn" id="rtSelMute">M</button>
            <button class="ms-btn solo-btn" id="rtSelSolo">S</button>
          </div>
        </div>
        <div class="rt-insp-ctrl">
          <span class="micro-label">TRIM</span>
          <input type="range" class="mini-slider" id="rtSelTrim" min="-12" max="12" step="0.1" />
          <span class="comp-val" id="rtSelTrimV">+0.0 dB</span>
        </div>
        <div class="rt-insp-ctrl">
          <button class="mini-pill-btn green-active" id="rtSelDlyOn">DLY</button>
          <input type="range" class="mini-slider" id="rtSelDly" min="0" max="10" step="0.01" />
          <span class="comp-val" id="rtSelDlyV">0.00 ms</span>
        </div>
      `;

      const btnM = spkInspector.querySelector("#rtSelMute");
      const btnS = spkInspector.querySelector("#rtSelSolo");
      const slTrim = spkInspector.querySelector("#rtSelTrim");
      const vTrim = spkInspector.querySelector("#rtSelTrimV");
      const btnDly = spkInspector.querySelector("#rtSelDlyOn");
      const slDly = spkInspector.querySelector("#rtSelDly");
      const vDly = spkInspector.querySelector("#rtSelDlyV");

      const syncSel = () => {
        btnM.classList.toggle("active", Boolean(store.getVal(s.muteP, 0)));
        btnS.classList.toggle("active", Boolean(store.getVal(s.soloP, 0)));
        const t = Number(store.getVal(s.trimP, 0));
        slTrim.value = String(t);
        vTrim.textContent = `${t >= 0 ? "+" : ""}${t.toFixed(1)} dB`;

        const dlyOn = Boolean(store.getVal(s.dlyOnP, 0));
        btnDly.classList.toggle("active", dlyOn);
        slDly.disabled = !dlyOn;
        vDly.style.opacity = dlyOn ? "1" : "0.4";
        const d = Number(store.getVal(s.dlyP, 0));
        slDly.value = String(d);
        vDly.textContent = `${d.toFixed(2)} ms`;
      };

      btnM.addEventListener("click", () => store.toggleParam(s.muteP));
      btnS.addEventListener("click", () => store.toggleParam(s.soloP));
      btnDly.addEventListener("click", () => store.toggleParam(s.dlyOnP));
      slTrim.addEventListener("input", () => {
        const v = Number(slTrim.value);
        vTrim.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;
        store.setParam(s.trimP, v);
      });
      slDly.addEventListener("input", () => {
        const v = Number(slDly.value);
        vDly.textContent = `${v.toFixed(2)} ms`;
        store.setParam(s.dlyP, v);
      });

      syncSel();
      spkInspector._syncCurrent = syncSel;
    }

    nodeButtons.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        selectedSpkIdx = idx;
        speakers.forEach(syncSpeakerNodeVisual);
        renderSelectedSpeakerInspector();
      });
    });

    speakers.forEach((s) => {
      const onSpkChange = () => {
        syncSpeakerNodeVisual(s);
        if (s.idx === selectedSpkIdx && spkInspector._syncCurrent) {
          spkInspector._syncCurrent();
        }
      };
      [s.muteP, s.soloP, s.trimP, s.dlyOnP, s.dlyP].forEach((p) => bind(p, onSpkChange));
      syncSpeakerNodeVisual(s);
    });

    renderSelectedSpeakerInspector();
  }

  store.onSnapshot(rebuildRoomTune);
  store.onParam((changedPath, prop, value) => {
    const cbs = paramBindings.get(pathKey(changedPath));
    if (cbs) cbs.forEach((fn) => fn(value));
  });

  store.onMeters((mf) => {
    const room = mf.room || [];
    mainMeter.setLevels(room[0] ?? -128, room[1] ?? -128);
    hp1Meter.setLevels(room[4] ?? room[0] ?? -128, room[5] ?? room[1] ?? -128);

    // Subtle live acoustic glow pulse on active speakers in the 3D soundstage
    for (let i = 0; i < speakerNodeEls.length; i++) {
      const db = room[i] ?? -128;
      const energy = Math.max(0, Math.min(1, (db + 54) / 54));
      speakerNodeEls[i].style.setProperty("--spk-energy", energy.toFixed(3));
    }
  });

  rebuildRoomTune();
}
