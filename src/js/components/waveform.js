// Audient-style scrolling live audio history waveform visualizer
// Smoothly scrolls incoming stereo/mono dB levels right-to-left with
// Audient's teal -> green -> yellow -> amber -> red vertical gradient
// and a soft left-edge fade.

import { dbToMeterNorm } from "./meter.js";

const activeWaves = new Set();
let rafId = null;
let lastTick = performance.now();

function tickAllWaves(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  for (const w of activeWaves) {
    if (!w.canvas.isConnected) {
      activeWaves.delete(w);
      continue;
    }
    w._tick(dt);
  }

  if (activeWaves.size > 0) {
    rafId = requestAnimationFrame(tickAllWaves);
  } else {
    rafId = null;
  }
}

function ensureWaveRaf() {
  if (rafId == null) {
    lastTick = performance.now();
    rafId = requestAnimationFrame(tickAllWaves);
  }
}

export function createMixWaveform(container, opts = {}) {
  const faded = opts.faded ?? false;
  const sampleInterval = opts.sampleInterval ?? 0.042; // ~24 samples/sec scroll speed
  const maxSamples = opts.maxSamples ?? 110;

  const canvas = document.createElement("canvas");
  canvas.className = faded ? "mix-wave-canvas mix-wave-faded" : "mix-wave-canvas";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const history = new Float32Array(maxSamples);
  let head = 0;
  let accum = 0;
  let targetDb = -128.0;
  let heldPeakDb = -128.0;
  let dispNorm = 0;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    ctx.clearRect(0, 0, cw, ch);

    const padTop = Math.max(2, Math.round(2 * dpr));
    const usableH = Math.max(2, ch - padTop);
    const stepX = cw / (maxSamples - 1);

    // Theme-aware vertical level gradient
    const theme = document.documentElement.dataset.theme || "obsidian";
    const fillAlpha = faded ? 0.28 : 0.42;
    const lineAlpha = faded ? 0.52 : 0.78;

    const fillGrad = ctx.createLinearGradient(0, ch, 0, padTop);
    const strokeGrad = ctx.createLinearGradient(0, ch, 0, padTop);
    if (theme === "mono") {
      fillGrad.addColorStop(0.0, `rgba(180, 182, 192, ${fillAlpha * 0.55})`);
      fillGrad.addColorStop(1.0, `rgba(245, 245, 250, ${fillAlpha + 0.06})`);
      strokeGrad.addColorStop(0.0, `rgba(210, 212, 220, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(255, 255, 255, ${lineAlpha})`);
    } else if (theme === "prism") {
      fillGrad.addColorStop(0.0, `rgba(6, 182, 212, ${fillAlpha})`);
      fillGrad.addColorStop(0.55, `rgba(168, 85, 247, ${fillAlpha})`);
      fillGrad.addColorStop(1.0, `rgba(244, 63, 142, ${fillAlpha + 0.08})`);
      strokeGrad.addColorStop(0.0, `rgba(34, 211, 238, ${lineAlpha})`);
      strokeGrad.addColorStop(0.55, `rgba(192, 132, 252, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(244, 114, 182, ${lineAlpha})`);
    } else if (theme === "vintage") {
      fillGrad.addColorStop(0.0, `rgba(122, 181, 146, ${fillAlpha})`);
      fillGrad.addColorStop(0.6, `rgba(229, 160, 75, ${fillAlpha})`);
      fillGrad.addColorStop(1.0, `rgba(217, 83, 79, ${fillAlpha + 0.08})`);
      strokeGrad.addColorStop(0.0, `rgba(122, 181, 146, ${lineAlpha})`);
      strokeGrad.addColorStop(0.6, `rgba(234, 176, 98, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(224, 82, 70, ${lineAlpha})`);
    } else if (theme === "carbon") {
      fillGrad.addColorStop(0.0, `rgba(200, 206, 218, ${fillAlpha * 0.7})`);
      fillGrad.addColorStop(0.65, `rgba(249, 115, 22, ${fillAlpha})`);
      fillGrad.addColorStop(1.0, `rgba(239, 68, 68, ${fillAlpha + 0.08})`);
      strokeGrad.addColorStop(0.0, `rgba(226, 232, 240, ${lineAlpha})`);
      strokeGrad.addColorStop(0.65, `rgba(251, 146, 60, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(248, 113, 113, ${lineAlpha})`);
    } else if (theme === "brushed") {
      fillGrad.addColorStop(0.0, `rgba(14, 165, 233, ${fillAlpha})`);
      fillGrad.addColorStop(0.65, `rgba(56, 189, 248, ${fillAlpha + 0.04})`);
      fillGrad.addColorStop(1.0, `rgba(125, 211, 252, ${fillAlpha + 0.08})`);
      strokeGrad.addColorStop(0.0, `rgba(56, 189, 248, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(186, 230, 253, ${lineAlpha})`);
    } else if (theme === "daylight") {
      fillGrad.addColorStop(0.0, `rgba(13, 148, 136, ${fillAlpha * 0.85})`);
      fillGrad.addColorStop(0.45, `rgba(22, 163, 74, ${fillAlpha * 0.9})`);
      fillGrad.addColorStop(0.76, `rgba(217, 119, 6, ${fillAlpha})`);
      fillGrad.addColorStop(1.0, `rgba(225, 29, 72, ${fillAlpha + 0.08})`);
      strokeGrad.addColorStop(0.0, `rgba(15, 118, 110, ${lineAlpha})`);
      strokeGrad.addColorStop(0.45, `rgba(21, 128, 61, ${lineAlpha})`);
      strokeGrad.addColorStop(0.76, `rgba(180, 83, 9, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(190, 18, 60, ${lineAlpha})`);
    } else {
      fillGrad.addColorStop(0.0, `rgba(32, 201, 151, ${fillAlpha})`);
      fillGrad.addColorStop(0.42, `rgba(62, 224, 127, ${fillAlpha})`);
      fillGrad.addColorStop(0.68, `rgba(200, 230, 76, ${fillAlpha + 0.06})`);
      fillGrad.addColorStop(0.86, `rgba(245, 184, 61, ${fillAlpha + 0.08})`);
      fillGrad.addColorStop(1.0, `rgba(255, 90, 82, ${fillAlpha + 0.1})`);
      strokeGrad.addColorStop(0.0, `rgba(32, 201, 151, ${lineAlpha})`);
      strokeGrad.addColorStop(0.42, `rgba(62, 224, 127, ${lineAlpha})`);
      strokeGrad.addColorStop(0.68, `rgba(200, 230, 76, ${lineAlpha})`);
      strokeGrad.addColorStop(0.86, `rgba(245, 184, 61, ${lineAlpha})`);
      strokeGrad.addColorStop(1.0, `rgba(255, 90, 82, ${lineAlpha})`);
    }

    // Subtle baseline floor
    ctx.fillStyle = theme === "daylight" ? "rgba(21, 23, 29, 0.08)" : "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, ch - Math.max(1, Math.round(dpr)), cw, Math.max(1, Math.round(dpr)));

    // Build smooth silhouette path oldest (left) -> newest (right)
    ctx.beginPath();
    ctx.moveTo(0, ch);
    for (let i = 0; i < maxSamples; i++) {
      const idx = (head + i) % maxSamples;
      const n = history[idx];
      const x = i * stepX;
      const y = ch - Math.max(0, n * usableH);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Crisp crest line along the top of the wave
    ctx.beginPath();
    for (let i = 0; i < maxSamples; i++) {
      const idx = (head + i) % maxSamples;
      const n = history[idx];
      const x = i * stepX;
      const y = ch - Math.max(0, n * usableH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = strokeGrad;
    ctx.lineWidth = Math.max(1, 1.2 * dpr);
    ctx.lineJoin = "round";
    ctx.stroke();

    // Soft fade-out along the left edge so old audio dissolves seamlessly
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    const maskGrad = ctx.createLinearGradient(0, 0, cw, 0);
    maskGrad.addColorStop(0.0, "rgba(0, 0, 0, 0)");
    maskGrad.addColorStop(0.18, "rgba(0, 0, 0, 1)");
    maskGrad.addColorStop(1.0, "rgba(0, 0, 0, 1)");
    ctx.fillStyle = maskGrad;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  const instance = {
    canvas,
    pushLevel(lDb, rDb = -128.0) {
      const peak = Math.max(
        Number.isFinite(lDb) ? lDb : -128.0,
        Number.isFinite(rDb) ? rDb : -128.0
      );
      targetDb = peak;
      if (peak > heldPeakDb) heldPeakDb = peak;
    },
    clear() {
      history.fill(0);
      targetDb = -128.0;
      heldPeakDb = -128.0;
      dispNorm = 0;
    },
    _tick(dt) {
      accum += dt;
      while (accum >= sampleInterval) {
        accum -= sampleInterval;
        const sampleNorm = dbToMeterNorm(Math.max(targetDb, heldPeakDb));
        dispNorm = sampleNorm >= dispNorm ? sampleNorm : Math.max(sampleNorm, dispNorm * 0.72);
        history[head] = dispNorm;
        head = (head + 1) % maxSamples;
        heldPeakDb = targetDb;
      }
      draw();
    },
    destroy() {
      activeWaves.delete(instance);
      canvas.remove();
    },
  };

  activeWaves.add(instance);
  ensureWaveRaf();
  return instance;
}
