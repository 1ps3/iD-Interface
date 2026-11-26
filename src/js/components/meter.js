// Reusable Audient-style vertical squircle stereo & mono meter components
// Renders bars, 1px recessed trough gaps, and rectangular peak ticks on a
// device-pixel-snapped <canvas> so left/right gaps and red/teal widths are
// mathematically identical at every Windows DPI scale (100%, 125%, 150%, 200%).

const METER_FLOOR_DB = -72.0;

const INF_SVG = `<svg class="inf-icon" viewBox="0 0 18 10" aria-hidden="true"><path d="M5.1 1.7C3.1 1.7 1.7 3.1 1.7 5s1.4 3.3 3.4 3.3c2.1 0 3.2-2 3.9-3.3.7-1.3 1.8-3.3 3.9-3.3 2 0 3.4 1.4 3.4 3.3s-1.4 3.3-3.4 3.3c-2.1 0-3.2-2-3.9-3.3C8.3 3.7 7.2 1.7 5.1 1.7Z" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const SCALE_POINTS = [
  { db: 0, label: "0" },
  { db: -3, label: "3" },
  { db: -6, label: "6" },
  { db: -9, label: "9" },
  { db: -12, label: "12" },
  { db: -15, label: "15" },
  { db: -18, label: "18" },
  { db: -21, label: "21" },
  { db: -27, label: "27" },
  { db: -36, label: "36" },
  { db: -48, label: "48" },
  { db: METER_FLOOR_DB, label: INF_SVG, isInf: true },
];

const SEG_COUNT = SCALE_POINTS.length - 1;
const activeMeters = new Set();
let rafRunning = false;
let lastFrameTime = performance.now();

export function dbToMeterNorm(db) {
  if (db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  for (let i = 0; i < SEG_COUNT; i++) {
    const hi = SCALE_POINTS[i].db;
    const lo = SCALE_POINTS[i + 1].db;
    if (db <= hi && db >= lo) {
      const frac = (db - lo) / (hi - lo);
      const normLo = 1 - (i + 1) / SEG_COUNT;
      const normHi = 1 - i / SEG_COUNT;
      return normLo + frac * (normHi - normLo);
    }
  }
  return 0;
}

function updateChannel(disp, target, peak, holdUntil, rms, dt, now) {
  let nextDisp = target >= disp ? target : Math.max(target, disp - 28.0 * dt);
  if (nextDisp < METER_FLOOR_DB) nextDisp = -128.0;

  // Smooth ~300ms RMS loudness envelope (slower attack & release than transient peak)
  const clampedTarget = target < METER_FLOOR_DB ? METER_FLOOR_DB : target;
  const baseRms = rms < METER_FLOOR_DB ? METER_FLOOR_DB : rms;
  const alpha = Math.min(1, dt * (clampedTarget > baseRms ? 4.2 : 2.6));
  let nextRms = baseRms + (clampedTarget - baseRms) * alpha;
  if (nextRms <= METER_FLOOR_DB + 0.1) nextRms = -128.0;

  let nextPeak = peak;
  let nextHold = holdUntil;
  if (nextDisp >= peak) {
    nextPeak = nextDisp;
    nextHold = now + 900;
  } else if (now > holdUntil) {
    nextPeak = Math.max(nextDisp, peak - 20.0 * dt);
    if (nextPeak < METER_FLOOR_DB) nextPeak = -128.0;
  }
  return [nextDisp, nextPeak, nextHold, nextRms];
}

function tickAllMeters(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
  lastFrameTime = now;

  for (const m of activeMeters) {
    if (!m.el.isConnected) {
      activeMeters.delete(m);
      continue;
    }
    m._tick(dt, now);
  }

  if (activeMeters.size > 0) {
    requestAnimationFrame(tickAllMeters);
  } else {
    rafRunning = false;
  }
}

function ensureRaf() {
  if (!rafRunning) {
    rafRunning = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(tickAllMeters);
  }
}

function buildScale(scaleEl) {
  SCALE_POINTS.forEach((pt, idx) => {
    const topPct = (idx / SEG_COUNT) * 100;
    const row = document.createElement("div");
    row.className = "am-tick-major";
    row.style.top = `${topPct.toFixed(2)}%`;
    row.innerHTML = `<span class="am-tick-line"></span><span class="am-tick-label">${pt.label}</span>`;
    scaleEl.appendChild(row);

    if (idx < SEG_COUNT) {
      const midPct = ((idx + 0.5) / SEG_COUNT) * 100;
      const minor = document.createElement("div");
      minor.className = "am-tick-minor";
      minor.style.top = `${midPct.toFixed(2)}%`;
      scaleEl.appendChild(minor);
    }
  });
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, rad);
  } else {
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
}

function drawBarsCanvas(canvas, ctx, channels) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 8) return;

  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(rect.width * dpr));
  const ch = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  ctx.clearRect(0, 0, cw, ch);

  const count = channels.length;
  const border = Math.max(1, Math.round(1 * dpr));
  const gap = Math.max(2, Math.round(2 * dpr));
  const between = count > 1 ? Math.max(3, Math.round(4 * dpr)) : 0;

  // Exact mockup capsule proportions: 10px trough = 1px border + 2px gap + 4px fill + 2px gap + 1px border
  const availPerTrough = Math.floor((cw - between * (count - 1)) / count);
  const barW = Math.max(2, availPerTrough - 2 * (border + gap));
  const troughW = barW + 2 * (border + gap);
  const totalW = troughW * count + between * (count - 1);
  const startX = Math.floor((cw - totalW) / 2);

  const troughY = 0;
  const troughH = ch;
  const barTop = border + gap;
  const barH = Math.max(1, ch - 2 * (border + gap));
  const peakH = Math.max(2, Math.round(2 * dpr));
  const troughR = troughW / 2;
  const innerBarR = barW / 2;

  // Theme-aware meter trough & vertical gradient
  const theme = document.documentElement.dataset.theme || "obsidian";
  const isLight = document.documentElement.dataset.lightUi === "true";
  const isGlass = theme === "liquidglass";
  const showRms = document.documentElement.dataset.rms !== "off";
  const troughBorderCol = isGlass
    ? isLight
      ? "rgba(25, 35, 55, 0.14)"
      : "rgba(255, 255, 255, 0.16)"
    : isLight
      ? "#cbd0dc"
      : "#262626";
  const troughInnerCol = isGlass
    ? isLight
      ? "rgba(20, 30, 50, 0.15)"
      : "rgba(255, 255, 255, 0.11)"
    : isLight
      ? "#e5e8ef"
      : "#121212";
  const peakTickCol = theme === "mono" ? "#ffffff" : theme === "prism" ? "#ff3d77" : "#ff5a52";

  const grad = ctx.createLinearGradient(0, barTop + barH, 0, barTop);
  if (theme === "mono") {
    grad.addColorStop(0.0, "#6e6e78");
    grad.addColorStop(0.55, "#bcbcc6");
    grad.addColorStop(1.0, "#ffffff");
  } else if (theme === "prism") {
    grad.addColorStop(0.0, "#06b6d4");
    grad.addColorStop(0.42, "#22d3ee");
    grad.addColorStop(0.72, "#a855f7");
    grad.addColorStop(1.0, "#f43f8e");
  } else if (theme === "vintage") {
    grad.addColorStop(0.0, "#55a474");
    grad.addColorStop(0.55, "#86c17b");
    grad.addColorStop(0.84, "#e5a04b");
    grad.addColorStop(1.0, "#e05246");
  } else if (theme === "carbon") {
    grad.addColorStop(0.0, "#94a3b8");
    grad.addColorStop(0.55, "#e2e8f0");
    grad.addColorStop(0.82, "#f97316");
    grad.addColorStop(1.0, "#ef4444");
  } else {
    grad.addColorStop(0.0, "#20c997");
    grad.addColorStop(0.45, "#3ee07f");
    grad.addColorStop(0.7, "#c8e64c");
    grad.addColorStop(0.86, "#f5b83d");
    grad.addColorStop(1.0, "#ff5a52");
  }

  for (let i = 0; i < count; i++) {
    const tx = startX + i * (troughW + between);
    const bx = tx + border + gap;
    const halfB = border / 2;

    // 1. Clean CSS-identical full-pill capsule trough (smooth fill + half-pixel-aligned 1px stroke)
    roundedRectPath(ctx, tx + halfB, troughY + halfB, troughW - border, troughH - border, troughR - halfB);
    ctx.fillStyle = troughInnerCol;
    ctx.fill();
    ctx.lineWidth = border;
    ctx.strokeStyle = troughBorderCol;
    ctx.stroke();

    // 2. Active full-pill rounded gradient bar: Dual Peak + RMS (no double-clip corner artifacts)
    const { dispDb, peakDb, rmsDb } = channels[i];
    const norm = dbToMeterNorm(dispDb);
    const fillH = Math.round(norm * barH);
    if (fillH > 0) {
      const clampedFillH = Math.min(barH, fillH);
      const fillY = barTop + barH - clampedFillH;
      if (showRms) {
        ctx.save();
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = grad;
        roundedRectPath(ctx, bx, fillY, barW, clampedFillH, innerBarR);
        ctx.fill();
        const rmsNorm = dbToMeterNorm(rmsDb ?? dispDb);
        const rmsH = Math.round(Math.min(norm, rmsNorm) * barH);
        if (rmsH > 0) {
          ctx.globalAlpha = 1.0;
          roundedRectPath(ctx, bx, barTop + barH - rmsH, barW, rmsH, innerBarR);
          ctx.fill();
        }
        ctx.restore();
      } else {
        ctx.fillStyle = grad;
        roundedRectPath(ctx, bx, fillY, barW, clampedFillH, innerBarR);
        ctx.fill();
      }
    }

    // 3. Sleek 2px peak-hold tick matching exact inner bar width
    const pNorm = dbToMeterNorm(peakDb);
    if (pNorm > 0.005) {
      const rawPeakY = Math.round(barTop + (1 - pNorm) * barH - peakH / 2);
      const peakY = Math.max(barTop, Math.min(barTop + barH - peakH, rawPeakY));
      ctx.fillStyle = peakTickCol;
      roundedRectPath(ctx, bx, peakY, barW, peakH, Math.max(0.5, 0.7 * dpr));
      ctx.fill();
    }
  }
}

export function createStereoMeter(container) {
  const root = document.createElement("div");
  root.className = "audient-meter am-stereo";
  root.innerHTML = `
    <button type="button" class="am-peak-pill is-inf" title="Click to reset peak"></button>
    <div class="am-body">
      <div class="am-bars am-bars-stereo">
        <canvas class="am-bars-canvas"></canvas>
      </div>
      <div class="am-scale"></div>
    </div>
  `;
  container.appendChild(root);

  const peakPill = root.querySelector(".am-peak-pill");
  const canvas = root.querySelector(".am-bars-canvas");
  const ctx = canvas.getContext("2d");
  buildScale(root.querySelector(".am-scale"));

  const st = {
    targetL: -128.0,
    targetR: -128.0,
    dispL: -128.0,
    dispR: -128.0,
    rmsL: -128.0,
    rmsR: -128.0,
    peakL: -128.0,
    peakR: -128.0,
    holdL: 0,
    holdR: 0,
    readoutPeak: -128.0,
    readoutHold: 0,
    clipped: false,
  };

  function resetPeak() {
    st.peakL = st.dispL;
    st.peakR = st.dispR;
    st.holdL = 0;
    st.holdR = 0;
    st.readoutPeak = Math.max(st.dispL, st.dispR);
    st.readoutHold = 0;
    st.clipped = false;
    peakPill.classList.remove("clip", "clip-latched");
  }

  peakPill.addEventListener("mousedown", (e) => e.stopPropagation());
  peakPill.addEventListener("click", (e) => {
    e.stopPropagation();
    resetPeak();
  });

  const instance = {
    el: root,
    setLevels(lDb, rDb) {
      st.targetL = Number.isFinite(lDb) ? lDb : -128.0;
      st.targetR = Number.isFinite(rDb) ? rDb : -128.0;
      if (st.targetL >= -0.2 || st.targetR >= -0.2) st.clipped = true;
    },
    resetPeak,
    _tick(dt, now) {
      [st.dispL, st.peakL, st.holdL, st.rmsL] = updateChannel(st.dispL, st.targetL, st.peakL, st.holdL, st.rmsL, dt, now);
      [st.dispR, st.peakR, st.holdR, st.rmsR] = updateChannel(st.dispR, st.targetR, st.peakR, st.holdR, st.rmsR, dt, now);

      drawBarsCanvas(canvas, ctx, [
        { dispDb: st.dispL, peakDb: st.peakL, rmsDb: st.rmsL },
        { dispDb: st.dispR, peakDb: st.peakR, rmsDb: st.rmsR },
      ]);

      const curMax = Math.max(st.dispL, st.dispR);
      if (curMax >= st.readoutPeak || now > st.readoutHold) {
        st.readoutPeak = curMax;
        st.readoutHold = now + 1200;
      }

      if (st.clipped) {
        peakPill.classList.remove("is-inf");
        peakPill.classList.add("clip", "clip-latched");
        peakPill.textContent = "CLIP";
        peakPill.title = "Clip latched — click to clear";
      } else if (st.readoutPeak <= METER_FLOOR_DB) {
        if (!peakPill.classList.contains("is-inf")) {
          peakPill.textContent = "";
          peakPill.classList.add("is-inf");
        }
        peakPill.classList.remove("clip", "clip-latched");
        peakPill.title = "Click to reset peak";
      } else {
        const rounded = Math.round(st.readoutPeak);
        const val = rounded === 0 ? 0 : rounded;
        peakPill.classList.remove("is-inf", "clip-latched");
        peakPill.textContent = `${val}dB`;
        peakPill.classList.toggle("clip", st.readoutPeak >= -0.5);
        peakPill.title = "Click to reset peak";
      }
    },
    destroy() {
      activeMeters.delete(instance);
    },
  };

  activeMeters.add(instance);
  ensureRaf();
  return instance;
}

export function createMonoMeter(container, opts = {}) {
  const scaleSide = opts.scaleSide === "left" ? "left" : "right";
  const peakHost = opts.peakContainer || null;
  const frameless = Boolean(opts.frameless);

  const root = document.createElement("div");
  root.className = `audient-meter am-mono${scaleSide === "left" ? " am-scale-left" : ""}${peakHost ? " am-inline" : ""}${frameless ? " am-frameless" : ""}`;

  const peakBtn = document.createElement("button");
  peakBtn.type = "button";
  peakBtn.className = "am-peak-pill is-inf";
  peakBtn.title = "Click to reset peak";

  const body = document.createElement("div");
  body.className = "am-body";
  const barsHtml = `<div class="am-bars am-bars-mono"><canvas class="am-bars-canvas"></canvas></div>`;
  const scaleHtml = `<div class="am-scale"></div>`;
  body.innerHTML = scaleSide === "left" ? `${scaleHtml}${barsHtml}` : `${barsHtml}${scaleHtml}`;

  if (peakHost) {
    peakHost.innerHTML = "";
    peakHost.appendChild(peakBtn);
  } else {
    root.appendChild(peakBtn);
  }
  root.appendChild(body);
  container.appendChild(root);

  const peakPill = peakBtn;
  const canvas = root.querySelector(".am-bars-canvas");
  const ctx = canvas.getContext("2d");
  buildScale(root.querySelector(".am-scale"));

  const st = {
    target: -128.0,
    disp: -128.0,
    rms: -128.0,
    peak: -128.0,
    hold: 0,
    readoutPeak: -128.0,
    readoutHold: 0,
    clipped: false,
  };

  function resetPeak() {
    st.peak = st.disp;
    st.hold = 0;
    st.readoutPeak = st.disp;
    st.readoutHold = 0;
    st.clipped = false;
    peakPill.classList.remove("clip", "clip-latched");
  }

  peakPill.addEventListener("mousedown", (e) => e.stopPropagation());
  peakPill.addEventListener("click", (e) => {
    e.stopPropagation();
    resetPeak();
  });

  const instance = {
    el: root,
    setLevel(db) {
      st.target = Number.isFinite(db) ? db : -128.0;
      if (st.target >= -0.2) st.clipped = true;
    },
    resetPeak,
    _tick(dt, now) {
      [st.disp, st.peak, st.hold, st.rms] = updateChannel(st.disp, st.target, st.peak, st.hold, st.rms, dt, now);

      drawBarsCanvas(canvas, ctx, [{ dispDb: st.disp, peakDb: st.peak, rmsDb: st.rms }]);

      if (st.disp >= st.readoutPeak || now > st.readoutHold) {
        st.readoutPeak = st.disp;
        st.readoutHold = now + 1200;
      }

      if (st.clipped) {
        peakPill.classList.remove("is-inf");
        peakPill.classList.add("clip", "clip-latched");
        peakPill.textContent = "CLIP";
        peakPill.title = "Clip latched — click to clear";
      } else if (st.readoutPeak <= METER_FLOOR_DB) {
        if (!peakPill.classList.contains("is-inf")) {
          peakPill.textContent = "";
          peakPill.classList.add("is-inf");
        }
        peakPill.classList.remove("clip", "clip-latched");
        peakPill.title = "Click to reset peak";
      } else {
        const rounded = Math.round(st.readoutPeak);
        const val = rounded === 0 ? 0 : rounded;
        peakPill.classList.remove("is-inf", "clip-latched");
        peakPill.textContent = `${val}dB`;
        peakPill.classList.toggle("clip", st.readoutPeak >= -0.5);
        peakPill.title = "Click to reset peak";
      }
    },
    destroy() {
      activeMeters.delete(instance);
    },
  };

  activeMeters.add(instance);
  ensureRaf();
  return instance;
}
