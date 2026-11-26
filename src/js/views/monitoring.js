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
  let selectedEqBandIdx = 0;
  let roomViewMode = "stage"; // "stage" | "eq"
  let linkLrEq = true;
  let selectedProfileId = "desk_fix";
  let speakerNodeEls = [];
  let stageResizeObs = null;

  const RT_EQ_BAND_META = [
    { label: "LS", activeType: 5, defF: 80, defQ: 0.71, color: "#93c5fd" },
    { label: "1", activeType: 8, defF: 250, defQ: 2.0, color: "#2dd4bf" },
    { label: "2", activeType: 8, defF: 600, defQ: 2.0, color: "#a78bfa" },
    { label: "3", activeType: 8, defF: 1500, defQ: 2.0, color: "#f5b83d" },
    { label: "4", activeType: 8, defF: 4000, defQ: 2.0, color: "#f472b6" },
    { label: "HS", activeType: 7, defF: 8000, defQ: 0.71, color: "#fb923c" },
  ];

  const BUILTIN_RT_PROFILES = [
    {
      id: "flat",
      name: "Flat (Bypass)",
      bands: [
        { t: 11, f: 80, g: 0, q: 0.71 },
        { t: 11, f: 250, g: 0, q: 2.0 },
        { t: 11, f: 600, g: 0, q: 2.0 },
        { t: 11, f: 1500, g: 0, q: 2.0 },
        { t: 11, f: 4000, g: 0, q: 2.0 },
        { t: 11, f: 8000, g: 0, q: 0.71 },
      ],
    },
    {
      id: "desk_fix",
      name: "Desk Boundary Fix",
      bands: [
        { t: 5, f: 75, g: -1.5, q: 0.71 },
        { t: 8, f: 160, g: -3.2, q: 2.2 },
        { t: 8, f: 520, g: -1.2, q: 1.8 },
        { t: 11, f: 1500, g: 0, q: 2.0 },
        { t: 11, f: 4000, g: 0, q: 2.0 },
        { t: 7, f: 9000, g: 0.8, q: 0.71 },
      ],
    },
    {
      id: "nearfield_warm",
      name: "Nearfield Warmth",
      bands: [
        { t: 5, f: 85, g: 1.8, q: 0.71 },
        { t: 8, f: 220, g: -1.4, q: 1.8 },
        { t: 11, f: 600, g: 0, q: 2.0 },
        { t: 11, f: 1500, g: 0, q: 2.0 },
        { t: 8, f: 3200, g: -1.6, q: 2.0 },
        { t: 7, f: 10000, g: -0.6, q: 0.71 },
      ],
    },
    {
      id: "bright_ref",
      name: "Bright Studio Reference",
      bands: [
        { t: 5, f: 90, g: -1.8, q: 0.71 },
        { t: 8, f: 200, g: -1.5, q: 2.0 },
        { t: 11, f: 600, g: 0, q: 2.0 },
        { t: 8, f: 2400, g: 1.0, q: 1.6 },
        { t: 11, f: 4000, g: 0, q: 2.0 },
        { t: 7, f: 8000, g: 1.8, q: 0.71 },
      ],
    },
    {
      id: "small_room",
      name: "Small Room Bass Tame",
      bands: [
        { t: 5, f: 95, g: -3.5, q: 0.71 },
        { t: 8, f: 140, g: -2.8, q: 2.6 },
        { t: 8, f: 320, g: -1.6, q: 2.0 },
        { t: 11, f: 1500, g: 0, q: 2.0 },
        { t: 11, f: 4000, g: 0, q: 2.0 },
        { t: 11, f: 8000, g: 0, q: 0.71 },
      ],
    },
    {
      id: "late_night",
      name: "Late Night Loudness",
      bands: [
        { t: 5, f: 80, g: 2.8, q: 0.71 },
        { t: 11, f: 250, g: 0, q: 2.0 },
        { t: 8, f: 1000, g: -1.2, q: 1.2 },
        { t: 11, f: 1500, g: 0, q: 2.0 },
        { t: 11, f: 4000, g: 0, q: 2.0 },
        { t: 7, f: 8500, g: 2.0, q: 0.71 },
      ],
    },
  ];

  function evalRtBandDb(freq, b) {
    if (b.t === 11 || Math.abs(b.g) < 0.01) return 0;
    const f0 = Math.max(20, b.f || 1000);
    const q = Math.max(0.3, b.q || 1.0);
    const ratio = freq / f0;
    const logDist = Math.log2(ratio);
    if (b.t === 8) {
      const bw = 1 / q;
      return b.g * Math.exp(-0.5 * Math.pow(logDist / (bw * 0.55), 2));
    }
    if (b.t === 5) return b.g / (1 + Math.pow(ratio, 2 * Math.min(2, q)));
    if (b.t === 7) return b.g / (1 + Math.pow(1 / ratio, 2 * Math.min(2, q)));
    return 0;
  }

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
      const chNode = store.getNode(ch.path);
      const eqChildIdx = chNode?.children?.findIndex((c) => c.tag === "EQ") ?? -1;
      const eqBands = [];
      if (eqChildIdx >= 0) {
        const eqPath = [...ch.path, eqChildIdx];
        const eqNode = store.getNode(eqPath);
        eqNode?.children?.forEach((bNode, bi) => {
          if (bNode.tag === "Band") {
            const bp = [...eqPath, bi];
            eqBands.push({
              idx: bi,
              tP: store.findParamPath(bp, "T"),
              fP: store.findParamPath(bp, "F"),
              gP: store.findParamPath(bp, "G"),
              qP: store.findParamPath(bp, "Q"),
            });
          }
        });
      }
      return {
        ...meta,
        idx,
        path: ch.path,
        trimP: store.findParamPath(ch.path, "SpkTrim"),
        dlyP: store.findParamPath(ch.path, "Dly"),
        dlyOnP: store.findParamPath(ch.path, "DlyOn"),
        muteP: store.findParamPath(ch.path, "Mute"),
        soloP: store.findParamPath(ch.path, "Solo"),
        eqBands,
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
          <div class="seg-group" id="rtViewModeSeg">
            <button type="button" class="seg-btn ${roomViewMode === "stage" ? "active" : ""}" data-rt-mode="stage">STAGE</button>
            <button type="button" class="seg-btn ${roomViewMode === "eq" ? "active" : ""}" data-rt-mode="eq">ROOM EQ</button>
          </div>
          <button class="mini-pill-btn green-active" id="btnRtGlobal">BYPASSED</button>
          <button class="mini-pill-btn" id="btnRtMain">MAIN</button>
          <button class="mini-pill-btn" id="btnRtAlt">ALT</button>
        </div>
      </div>

      <!-- Manual RoomTune 6-Band Speaker EQ Panel -->
      <div class="rt-eq-panel" id="rtEqPanel" style="display:${roomViewMode === "eq" ? "flex" : "none"};">
        <div class="rt-eq-head">
          <div class="rt-eq-spk-tabs" id="rtEqSpkTabs"></div>
          <div class="rt-eq-head-actions">
            <button type="button" class="mini-pill-btn ${linkLrEq ? "active" : ""}" id="btnRtEqLink" title="Link Left &amp; Right Speaker EQ edits">LINK L+R</button>
            <button type="button" class="mini-pill-btn" id="btnRtEqFlat" title="Reset all RoomTune EQ bands to flat (0 dB)">FLAT ALL</button>
          </div>
        </div>
        <div class="rt-eq-oled" id="rtEqOled">
          <svg class="eq-oled-svg" id="rtEqSvg" viewBox="0 0 520 150" preserveAspectRatio="none">
            <defs>
              <linearGradient id="rtEqFillGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(255,255,255,0.12)" />
                <stop offset="100%" stop-color="rgba(255,255,255,0.01)" />
              </linearGradient>
            </defs>
            <line x1="69" y1="0" x2="69" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="121" y1="0" x2="121" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="242" y1="0" x2="242" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="294" y1="0" x2="294" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="416" y1="0" x2="416" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="468" y1="0" x2="468" y2="150" class="eq-grid-v" vector-effect="non-scaling-stroke" />
            <line x1="0" y1="38" x2="520" y2="38" class="eq-grid-h" vector-effect="non-scaling-stroke" />
            <line x1="0" y1="75" x2="520" y2="75" class="eq-grid-zero" vector-effect="non-scaling-stroke" />
            <line x1="0" y1="112" x2="520" y2="112" class="eq-grid-h" vector-effect="non-scaling-stroke" />
            <g id="rtEqBandFills"></g>
            <path id="rtEqFillPath" fill="url(#rtEqFillGrad)" />
            <path id="rtEqCurvePath" fill="none" stroke="#f2f2f2" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </svg>
          <span class="eq-axis-lbl" style="left:6px;top:6px;">+12</span>
          <span class="eq-axis-lbl" style="left:6px;top:46%;">0</span>
          <span class="eq-axis-lbl" style="left:6px;bottom:14px;">-12</span>
          <span class="eq-axis-lbl" style="left:13.2%;bottom:3px;">50</span>
          <span class="eq-axis-lbl" style="left:23.3%;bottom:3px;">100</span>
          <span class="eq-axis-lbl" style="left:46.5%;bottom:3px;">500</span>
          <span class="eq-axis-lbl" style="left:56.5%;bottom:3px;">1k</span>
          <span class="eq-axis-lbl" style="left:80%;bottom:3px;">5k</span>
          <span class="eq-axis-lbl" style="left:90%;bottom:3px;">10k</span>
          <div class="eq-nodes-layer" id="rtEqNodes"></div>
          <div class="eq-oled-readout" id="rtEqReadout"></div>
        </div>
        <div class="rt-eq-band-bar" id="rtEqBandBar"></div>
        <div class="rt-eq-controls" id="rtEqControls"></div>
        <div class="rt-profile-bar" id="rtProfileBar">
          <span class="micro-label">EQ PROFILE</span>
          <select class="dock-select rt-profile-select" id="rtProfileSelect"></select>
          <div class="rt-profile-preview" title="Selected profile curve preview">
            <svg id="rtProfilePreviewSvg" viewBox="0 0 140 40" preserveAspectRatio="none">
              <line x1="0" y1="20" x2="140" y2="20" class="eq-grid-zero" vector-effect="non-scaling-stroke" />
              <path id="rtProfilePreviewFill" fill="rgba(167, 139, 250, 0.22)" />
              <path id="rtProfilePreviewCurve" fill="none" stroke="#f2f2f2" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            </svg>
          </div>
          <button type="button" class="mini-pill-btn green-active" id="btnRtProfApply">APPLY</button>
          <button type="button" class="mini-pill-btn" id="btnRtProfSave" title="Save current Room EQ curve into selected Custom slot">SAVE</button>
        </div>
      </div>

      <!-- Clean 2.5D Elevation-Coded Acoustic Soundstage -->
      <div class="rt-stage-3d" id="rtStage3d" style="display:${roomViewMode === "stage" ? "" : "none"};">
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

    // --- Manual RoomTune 6-Band Speaker EQ Editor (Matches Preamps EQ + Profiles) ---
    const rtEqPanel = stageEl.querySelector("#rtEqPanel");
    const rtEqSpkTabs = stageEl.querySelector("#rtEqSpkTabs");
    const rtEqSvg = stageEl.querySelector("#rtEqSvg");
    const rtEqBandFills = stageEl.querySelector("#rtEqBandFills");
    const rtEqFillPath = stageEl.querySelector("#rtEqFillPath");
    const rtEqCurvePath = stageEl.querySelector("#rtEqCurvePath");
    const rtEqNodes = stageEl.querySelector("#rtEqNodes");
    const rtEqReadout = stageEl.querySelector("#rtEqReadout");
    const rtEqBandBar = stageEl.querySelector("#rtEqBandBar");
    const rtEqControls = stageEl.querySelector("#rtEqControls");
    const btnRtEqLink = stageEl.querySelector("#btnRtEqLink");
    const btnRtEqFlat = stageEl.querySelector("#btnRtEqFlat");
    const rtProfileSelect = stageEl.querySelector("#rtProfileSelect");
    const rtProfilePreviewFill = stageEl.querySelector("#rtProfilePreviewFill");
    const rtProfilePreviewCurve = stageEl.querySelector("#rtProfilePreviewCurve");
    const btnRtProfApply = stageEl.querySelector("#btnRtProfApply");
    const btnRtProfSave = stageEl.querySelector("#btnRtProfSave");

    stageEl.querySelectorAll("#rtViewModeSeg .seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        roomViewMode = b.dataset.rtMode === "eq" ? "eq" : "stage";
        stageEl.querySelectorAll("#rtViewModeSeg .seg-btn").forEach((x) => {
          x.classList.toggle("active", x.dataset.rtMode === roomViewMode);
        });
        if (rtStage3d) rtStage3d.style.display = roomViewMode === "stage" ? "" : "none";
        if (rtEqPanel) rtEqPanel.style.display = roomViewMode === "eq" ? "flex" : "none";
        if (roomViewMode === "eq") renderRoomEq();
      });
    });

    const getTargetSpeakersForEq = () =>
      linkLrEq ? speakers.filter((sp) => sp.eqBands.length > 0) : [speakers[selectedSpkIdx]].filter(Boolean);

    const setEqBandField = (bandIdx, field, val) => {
      for (const sp of getTargetSpeakersForEq()) {
        const b = sp.eqBands[bandIdx];
        if (b && b[field]) store.setParam(b[field], val);
      }
    };

    const freqToX = (f) => (Math.log(Math.max(20, Math.min(20000, f)) / 20) / Math.log(1000)) * 520;
    const xToFreq = (x) => Math.round(20 * Math.pow(1000, Math.max(0, Math.min(1, x / 520))));
    const dbToY = (db) => 75 - (Math.max(-14, Math.min(14, db)) / 14) * 64;
    const yToDb = (y) => Math.round(Math.max(-12, Math.min(12, ((75 - y) / 64) * 14)) * 10) / 10;

    const RT_EQ_GRID = [];
    for (let x = 0; x <= 520; x += 4) RT_EQ_GRID.push({ x, freq: xToFreq(x) });
    if (RT_EQ_GRID[RT_EQ_GRID.length - 1].x !== 520) RT_EQ_GRID.push({ x: 520, freq: 20000 });

    const rtBandFillEls = RT_EQ_BAND_META.map((m) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("fill", m.color);
      rtEqBandFills?.appendChild(p);
      return p;
    });

    let draggingRtIdx = -1;
    const rtNodeEls = RT_EQ_BAND_META.map((m, idx) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "eq-dot";
      dot.style.setProperty("--dot-col", m.color);
      dot.textContent = m.label;
      rtEqNodes?.appendChild(dot);

      let dragRect = null;
      dot.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        selectedEqBandIdx = idx;
        const s = speakers[selectedSpkIdx];
        if (s?.eqBands[idx] && Number(store.getVal(s.eqBands[idx].tP, 11)) === 11) {
          setEqBandField(idx, "tP", m.activeType);
        }
        draggingRtIdx = idx;
        dragRect = rtEqSvg.getBoundingClientRect();
        dot.setPointerCapture(e.pointerId);
        renderRoomEq();
      });
      dot.addEventListener("pointermove", (e) => {
        if (draggingRtIdx !== idx || !dragRect) return;
        const sx = ((e.clientX - dragRect.left) / dragRect.width) * 520;
        const sy = ((e.clientY - dragRect.top) / dragRect.height) * 150;
        setEqBandField(idx, "fP", xToFreq(sx));
        setEqBandField(idx, "gP", yToDb(sy));
        renderRoomEq();
      });
      const endDrag = (e) => {
        if (draggingRtIdx !== idx) return;
        draggingRtIdx = -1;
        dragRect = null;
        if (dot.hasPointerCapture(e.pointerId)) dot.releasePointerCapture(e.pointerId);
      };
      dot.addEventListener("pointerup", endDrag);
      dot.addEventListener("pointercancel", endDrag);
      return dot;
    });

    function getAllRtProfiles() {
      const saved = store.getUiPref("roomEqProfiles", {}) || {};
      const customs = [1, 2, 3].map((n) => {
        const id = `custom_${n}`;
        return {
          id,
          name: `Custom Profile ${n}${saved[id] ? " ★" : ""}`,
          custom: true,
          bands: Array.isArray(saved[id]) ? saved[id] : BUILTIN_RT_PROFILES[0].bands,
        };
      });
      return [...BUILTIN_RT_PROFILES, ...customs];
    }

    function renderProfilePreview() {
      const all = getAllRtProfiles();
      const prof = all.find((p) => p.id === selectedProfileId) || all[0];
      if (!prof || !rtProfilePreviewCurve || !rtProfilePreviewFill) return;
      const pts = [];
      for (let x = 0; x <= 140; x += 3) {
        const fr = 20 * Math.pow(1000, x / 140);
        let sum = 0;
        for (const b of prof.bands) sum += evalRtBandDb(fr, b);
        const y = 20 - (Math.max(-12, Math.min(12, sum)) / 12) * 16;
        pts.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`);
      }
      const d = pts.join(" ");
      rtProfilePreviewCurve.setAttribute("d", d);
      rtProfilePreviewFill.setAttribute("d", `${d} L140 20 L0 20 Z`);
      if (btnRtProfSave) btnRtProfSave.style.display = prof.custom ? "" : "none";
    }

    function syncProfileDropdown() {
      if (!rtProfileSelect) return;
      const all = getAllRtProfiles();
      rtProfileSelect.innerHTML = all
        .map((p) => `<option value="${p.id}" ${p.id === selectedProfileId ? "selected" : ""}>${p.name}</option>`)
        .join("");
      renderProfilePreview();
    }

    rtProfileSelect?.addEventListener("change", () => {
      selectedProfileId = rtProfileSelect.value;
      renderProfilePreview();
    });

    btnRtProfApply?.addEventListener("click", () => {
      const all = getAllRtProfiles();
      const prof = all.find((p) => p.id === selectedProfileId);
      if (!prof) return;
      prof.bands.forEach((b, i) => {
        setEqBandField(i, "tP", b.t);
        setEqBandField(i, "fP", b.f);
        setEqBandField(i, "gP", b.g);
        setEqBandField(i, "qP", b.q);
      });
      renderRoomEq();
    });

    btnRtProfSave?.addEventListener("click", () => {
      const s = speakers[selectedSpkIdx];
      if (!s || !s.eqBands.length || !selectedProfileId.startsWith("custom_")) return;
      const curBands = s.eqBands.map((b, i) => {
        const meta = RT_EQ_BAND_META[i] || RT_EQ_BAND_META[1];
        return {
          t: Number(store.getVal(b.tP, 11)),
          f: Number(store.getVal(b.fP, meta.defF)),
          g: Number(store.getVal(b.gP, 0)),
          q: Number(store.getVal(b.qP, meta.defQ)),
        };
      });
      const saved = { ...(store.getUiPref("roomEqProfiles", {}) || {}), [selectedProfileId]: curBands };
      store.saveUiPref("roomEqProfiles", saved);
      syncProfileDropdown();
    });

    syncProfileDropdown();

    function renderRoomEq() {
      const s = speakers[selectedSpkIdx];
      if (!s || !s.eqBands.length) {
        if (rtEqControls) {
          rtEqControls.innerHTML = `<span class="set-row-desc">RoomTune manual EQ requires Direct USB mode.</span>`;
        }
        return;
      }

      if (rtEqSpkTabs) {
        rtEqSpkTabs.innerHTML = speakers
          .map(
            (sp) =>
              `<button type="button" class="mini-pill-btn ${sp.idx === selectedSpkIdx ? "active" : ""}" data-eq-spk="${sp.idx}">${sp.code} · ${sp.full}</button>`
          )
          .join("");
        rtEqSpkTabs.querySelectorAll("[data-eq-spk]").forEach((btn) => {
          btn.addEventListener("click", () => {
            selectedSpkIdx = Number(btn.dataset.eqSpk);
            speakers.forEach(syncSpeakerNodeVisual);
            renderSelectedSpeakerInspector();
            renderRoomEq();
          });
        });
      }

      const bandsState = s.eqBands.map((b, i) => {
        const meta = RT_EQ_BAND_META[i] || RT_EQ_BAND_META[1];
        return {
          idx: i,
          meta,
          t: Number(store.getVal(b.tP, 11)),
          f: Number(store.getVal(b.fP, meta.defF)),
          g: Number(store.getVal(b.gP, 0)),
          q: Number(store.getVal(b.qP, meta.defQ)),
        };
      });

      const compPts = new Array(RT_EQ_GRID.length);
      const bandPts = bandsState.map(() => new Array(RT_EQ_GRID.length));
      for (let i = 0; i < RT_EQ_GRID.length; i++) {
        const { x, freq } = RT_EQ_GRID[i];
        let totalDb = 0;
        for (let j = 0; j < bandsState.length; j++) {
          const bdb = evalRtBandDb(freq, bandsState[j]);
          totalDb += bdb;
          bandPts[j][i] = `${i === 0 ? "M" : "L"}${x} ${dbToY(bdb).toFixed(1)}`;
        }
        compPts[i] = `${i === 0 ? "M" : "L"}${x} ${dbToY(totalDb).toFixed(1)}`;
      }

      rtBandFillEls.forEach((el, j) => {
        const bs = bandsState[j];
        const show = bs && bs.t !== 11 && Math.abs(bs.g) > 0.05;
        el.setAttribute("d", `${bandPts[j].join(" ")} L520 75 L0 75 Z`);
        el.setAttribute("fill-opacity", show ? (j === selectedEqBandIdx ? "0.18" : "0.07") : "0");
      });

      const dStr = compPts.join(" ");
      rtEqCurvePath?.setAttribute("d", dStr);
      rtEqFillPath?.setAttribute("d", `${dStr} L520 75 L0 75 Z`);

      rtNodeEls.forEach((dot, i) => {
        const bs = bandsState[i];
        if (!bs) return;
        const nx = freqToX(bs.f);
        const ny = bs.t === 11 ? 75 : dbToY(bs.g);
        dot.style.left = `${((nx / 520) * 100).toFixed(2)}%`;
        dot.style.top = `${((ny / 150) * 100).toFixed(2)}%`;
        dot.classList.toggle("selected", i === selectedEqBandIdx);
        dot.classList.toggle("bypassed", bs.t === 11);
      });

      const sel = bandsState[selectedEqBandIdx] || bandsState[0];
      if (rtEqReadout && sel) {
        const fTxt = sel.f >= 1000 ? `${(sel.f / 1000).toFixed(2)} kHz` : `${Math.round(sel.f)} Hz`;
        rtEqReadout.textContent = `${sel.meta.label} · ${fTxt} · ${sel.g >= 0 ? "+" : ""}${sel.g.toFixed(1)} dB · Q${sel.q.toFixed(1)}`;
      }

      if (rtEqBandBar) {
        rtEqBandBar.innerHTML = bandsState
          .map(
            (b) =>
              `<button type="button" class="eq-band-pill ${b.idx === selectedEqBandIdx ? "active" : ""}" style="--band-col:${b.meta.color};" data-rt-band="${b.idx}">
                ${b.meta.label} ${b.t === 11 ? "OFF" : `${b.g >= 0 ? "+" : ""}${b.g.toFixed(1)}dB`}
              </button>`
          )
          .join("");
        rtEqBandBar.querySelectorAll("[data-rt-band]").forEach((btn) => {
          btn.addEventListener("click", () => {
            selectedEqBandIdx = Number(btn.dataset.rtBand);
            renderRoomEq();
          });
        });
      }

      if (rtEqControls && sel) {
        const isOn = sel.t !== 11;
        const fLogVal = Math.round(((Math.log10(sel.f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))) * 1000);
        rtEqControls.innerHTML = `
          <button type="button" class="mini-pill-btn green-active ${isOn ? "active" : ""}" id="rtBandToggle">${isOn ? "BAND ON" : "BYPASSED"}</button>
          <div class="rt-insp-ctrl">
            <span class="micro-label">FREQ</span>
            <input type="range" class="mini-slider" id="rtBandFreq" min="0" max="1000" step="1" value="${fLogVal}" />
            <span class="comp-val" id="rtBandFreqV">${sel.f >= 1000 ? `${(sel.f / 1000).toFixed(2)}k` : `${Math.round(sel.f)}Hz`}</span>
          </div>
          <div class="rt-insp-ctrl">
            <span class="micro-label">GAIN</span>
            <input type="range" class="mini-slider" id="rtBandGain" min="-12" max="12" step="0.1" value="${sel.g}" />
            <span class="comp-val" id="rtBandGainV">${sel.g >= 0 ? "+" : ""}${sel.g.toFixed(1)} dB</span>
          </div>
          <div class="rt-insp-ctrl">
            <span class="micro-label">Q</span>
            <input type="range" class="mini-slider" id="rtBandQ" min="0.3" max="12" step="0.05" value="${sel.q}" />
            <span class="comp-val" id="rtBandQV">${sel.q.toFixed(2)}</span>
          </div>
        `;

        rtEqControls.querySelector("#rtBandToggle")?.addEventListener("click", () => {
          setEqBandField(sel.idx, "tP", isOn ? 11 : sel.meta.activeType);
          renderRoomEq();
        });
        const slF = rtEqControls.querySelector("#rtBandFreq");
        const slG = rtEqControls.querySelector("#rtBandGain");
        const slQ = rtEqControls.querySelector("#rtBandQ");
        slF?.addEventListener("input", () => {
          const hz = Math.round(20 * Math.pow(1000, Number(slF.value) / 1000));
          if (sel.t === 11) setEqBandField(sel.idx, "tP", sel.meta.activeType);
          setEqBandField(sel.idx, "fP", hz);
          renderRoomEq();
        });
        slG?.addEventListener("input", () => {
          const db = Number(slG.value);
          if (sel.t === 11) setEqBandField(sel.idx, "tP", sel.meta.activeType);
          setEqBandField(sel.idx, "gP", db);
          renderRoomEq();
        });
        slQ?.addEventListener("input", () => {
          const q = Number(slQ.value);
          if (sel.t === 11) setEqBandField(sel.idx, "tP", sel.meta.activeType);
          setEqBandField(sel.idx, "qP", q);
          renderRoomEq();
        });
      }
    }

    btnRtEqLink?.addEventListener("click", () => {
      linkLrEq = !linkLrEq;
      btnRtEqLink.classList.toggle("active", linkLrEq);
    });

    btnRtEqFlat?.addEventListener("click", () => {
      for (const sp of getTargetSpeakersForEq()) {
        sp.eqBands.forEach((b, i) => {
          const meta = RT_EQ_BAND_META[i] || RT_EQ_BAND_META[1];
          if (b.tP) store.setParam(b.tP, 11);
          if (b.fP) store.setParam(b.fP, meta.defF);
          if (b.gP) store.setParam(b.gP, 0.0);
          if (b.qP) store.setParam(b.qP, meta.defQ);
        });
      }
      renderRoomEq();
    });

    nodeButtons.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        selectedSpkIdx = idx;
        speakers.forEach(syncSpeakerNodeVisual);
        renderSelectedSpeakerInspector();
        if (roomViewMode === "eq") renderRoomEq();
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
      s.eqBands.forEach((b) => {
        [b.tP, b.fP, b.gP, b.qP].forEach((p) =>
          bind(p, () => {
            if (roomViewMode === "eq") renderRoomEq();
          })
        );
      });
      syncSpeakerNodeVisual(s);
    });

    renderSelectedSpeakerInspector();
    if (roomViewMode === "eq") renderRoomEq();
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
