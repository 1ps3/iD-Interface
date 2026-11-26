// Persistent Right-Hand Master & Headphone (HP1) Monitor Dock for Full Console Mode

import { createKnob } from "../components/knob.js";
import { createStereoMeter } from "../components/meter.js";
import { createMixWaveform } from "../components/waveform.js";
import { openCustomMenu } from "../components/select.js";
import { pathKey } from "../store.js";

const WAVE_SOURCES = [
  { id: "mix0", name: "MAIN MIX", cls: "wave-main", read: (mf) => [mf.mixbus?.[0] ?? -128, mf.mixbus?.[1] ?? -128] },
  { id: "mix1", name: "MIX A", cls: "wave-a", read: (mf) => [mf.mixbus?.[2] ?? -128, mf.mixbus?.[3] ?? -128] },
  { id: "mix2", name: "MIX B", cls: "wave-b", read: (mf) => [mf.mixbus?.[4] ?? -128, mf.mixbus?.[5] ?? -128] },
  { id: "host", name: "HOST", cls: "wave-host", read: (mf) => [mf.room?.[0] ?? -128, mf.room?.[1] ?? -128] },
  { id: "mix3", name: "REVERB", cls: "wave-rev", read: (mf) => [mf.mixbus?.[6] ?? -128, mf.mixbus?.[7] ?? -128] },
  { id: "hp1", name: "HP 1", cls: "wave-host", read: (mf) => [mf.room?.[4] ?? mf.room?.[0] ?? -128, mf.room?.[5] ?? mf.room?.[1] ?? -128] },
];

function waveIdFromMainSrc(srcVal) {
  if (srcVal === 1) return "mix1";
  if (srcVal === 2) return "mix2";
  if (srcVal === 3) return "host";
  return "mix0";
}

function populateSelect(selectEl, store, path, fallbackOptions) {
  const vm = store.getVm(path);
  const opts = vm?.options?.length ? vm.options : fallbackOptions;
  const curVal = store.getVal(path);
  selectEl.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.name;
    if (o.value === curVal) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

export function createMasterDock(container, store) {
  container.innerHTML = `
    <div class="dock-section dock-main">
      <div class="dock-header">
        <span class="dock-title">MONITOR</span>
        <div class="seg-group" id="dockSpeakerSeg">
          <button class="seg-btn" data-val="0">MAIN</button>
          <button class="seg-btn" data-val="1">ALT</button>
        </div>
      </div>

      <div class="dock-main-body">
        <div class="dock-knob-col">
          <div class="dock-knob-slot" id="dockMainKnob"></div>
          <select class="dock-select" id="dockMainSrc" title="Monitor Source"></select>
        </div>
        <div class="dock-meter-slot" id="dockMasterMeter"></div>
      </div>

      <div class="dock-btn-grid">
        <button class="mon-btn danger-active" id="btnMainMute">MUTE</button>
        <button class="mon-btn" id="btnDim">DIM</button>
        <button class="mon-btn" id="btnMono">MONO</button>
        <button class="mon-btn" id="btnMidSide">M/S</button>
        <button class="mon-btn" id="btnTalkback">TALK</button>
        <button class="mon-btn" id="btnRef">REF</button>
      </div>

      <div class="dock-guard-strip" id="dockGuardStrip"></div>
    </div>

    <div class="dock-divider"></div>

    <div class="dock-section dock-hp">
      <div class="dock-header">
        <span class="dock-title">HEADPHONES</span>
        <button class="mini-pill-btn danger-active" id="btnHp1Mute">MUTE</button>
      </div>

      <div class="dock-hp-body">
        <div class="dock-hp-knob" id="dockHp1Knob"></div>
        <div class="dock-hp-meta">
          <label class="micro-label">SOURCE</label>
          <select class="dock-select" id="dockHp1Src" title="Headphones 1 Source"></select>
        </div>
      </div>
    </div>

    <div class="dock-signal-strip" id="dockSignalStrip">MAIN → SPK</div>

    <div class="dock-wave-section wave-main" id="dockWaveSection">
      <div class="dock-wave-head">
        <span class="micro-label">MIX MONITOR</span>
        <button type="button" class="dock-wave-src dock-wave-btn" id="dockWaveSrc" title="Select Mix Waveform Source">MAIN MIX</button>
      </div>
      <div class="dock-wave-slot" id="dockMixWave"></div>
    </div>
  `;

  const mainKnob = createKnob(container.querySelector("#dockMainKnob"), {
    min: -128,
    max: 0,
    muteAtMin: true,
    unit: "dB",
    defaultValue: -35,
    onChange(val) {
      if (store.paths.mainVol) store.setParam(store.paths.mainVol, val);
    },
  });

  const hp1Knob = createKnob(container.querySelector("#dockHp1Knob"), {
    min: -128,
    max: 0,
    muteAtMin: true,
    unit: "dB",
    defaultValue: -35,
    onChange(val) {
      if (store.paths.hp1Vol) store.setParam(store.paths.hp1Vol, val);
    },
  });

  const masterMeter = createStereoMeter(container.querySelector("#dockMasterMeter"));
  const dockWaveSection = container.querySelector("#dockWaveSection");
  const dockWave = createMixWaveform(container.querySelector("#dockMixWave"), { faded: false, maxSamples: 104 });
  const dockWaveSrc = container.querySelector("#dockWaveSrc");

  let activeWaveId = "mix0";
  let lastMainSrc = null;
  function setWaveSource(id, clearTrace = true) {
    const entry = WAVE_SOURCES.find((w) => w.id === id) || WAVE_SOURCES[0];
    if (activeWaveId !== entry.id) {
      activeWaveId = entry.id;
      if (clearTrace) dockWave.clear();
    }
    dockWaveSrc.textContent = entry.name;
    dockWaveSection.classList.remove("wave-main", "wave-a", "wave-b", "wave-rev", "wave-host");
    dockWaveSection.classList.add(entry.cls);
  }

  dockWaveSrc.addEventListener("click", (e) => {
    e.stopPropagation();
    openCustomMenu(
      dockWaveSrc,
      WAVE_SOURCES.map((w) => ({ value: w.id, name: w.name })),
      activeWaveId,
      (val) => setWaveSource(val, true)
    );
  });

  const speakerBtns = Array.from(container.querySelectorAll("#dockSpeakerSeg .seg-btn"));
  const mainSrcSel = container.querySelector("#dockMainSrc");
  const hp1SrcSel = container.querySelector("#dockHp1Src");

  const btnMainMute = container.querySelector("#btnMainMute");
  const btnDim = container.querySelector("#btnDim");
  const btnMono = container.querySelector("#btnMono");
  const btnMidSide = container.querySelector("#btnMidSide");
  const btnTalkback = container.querySelector("#btnTalkback");
  const btnRef = container.querySelector("#btnRef");
  const btnHp1Mute = container.querySelector("#btnHp1Mute");
  const guardStrip = container.querySelector("#dockGuardStrip");
  const signalStrip = container.querySelector("#dockSignalStrip");

  speakerBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = Number(btn.dataset.val);
      if (store.paths.speakerSel) store.setParam(store.paths.speakerSel, val);
    });
  });

  mainSrcSel.addEventListener("change", () => {
    const v = Number(mainSrcSel.value);
    if (store.paths.mainSrc) store.setParam(store.paths.mainSrc, v);
    lastMainSrc = v;
    setWaveSource(waveIdFromMainSrc(v), true);
  });

  hp1SrcSel.addEventListener("change", () => {
    const v = Number(hp1SrcSel.value);
    if (store.paths.hp1Src) store.setParam(store.paths.hp1Src, v);
  });

  btnMainMute.addEventListener("click", () => store.toggleParam(store.paths.mainMute));
  btnDim.addEventListener("click", () => store.toggleParam(store.paths.dim));
  btnMono.addEventListener("click", () => store.toggleParam(store.paths.mono));
  btnMidSide.addEventListener("click", () => store.toggleParam(store.paths.midSide));
  btnTalkback.addEventListener("click", () => store.toggleParam(store.paths.talkback));
  btnRef.addEventListener("click", () => {
    if (store.paths.setToRef) {
      // Trigger SetToRef (and jump to RefVol if SetToRef is momentary)
      const refVal = store.getVal(store.paths.refVol);
      if (typeof refVal === "number" && store.paths.mainVol) {
        store.setParam(store.paths.mainVol, refVal);
      }
      store.setParam(store.paths.setToRef, 1);
    }
  });
  btnHp1Mute.addEventListener("click", () => store.toggleParam(store.paths.hp1Mute));

  function syncAll() {
    const p = store.paths;
    if (!p.monitorControl) return;

    const mainVol = store.getVal(p.mainVol);
    if (typeof mainVol === "number") mainKnob.setValue(mainVol);
    mainKnob.setMuted(Boolean(store.getVal(p.mainMute, 0)));

    const hp1Vol = store.getVal(p.hp1Vol);
    if (typeof hp1Vol === "number") hp1Knob.setValue(hp1Vol);
    hp1Knob.setMuted(Boolean(store.getVal(p.hp1Mute, 0)));

    const spk = store.getVal(p.speakerSel, 0);
    speakerBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === spk));

    btnMainMute.classList.toggle("active", Boolean(store.getVal(p.mainMute, 0)));
    btnDim.classList.toggle("active", Boolean(store.getVal(p.dim, 0)));
    btnMono.classList.toggle("active", Boolean(store.getVal(p.mono, 0)));
    btnMidSide.classList.toggle("active", Boolean(store.getVal(p.midSide, 0)));
    btnTalkback.classList.toggle("active", Boolean(store.getVal(p.talkback, 0)));

    const refVol = store.getVal(p.refVol);
    const isAtRef =
      typeof mainVol === "number" &&
      typeof refVol === "number" &&
      Math.abs(mainVol - refVol) < 0.25;
    btnRef.classList.toggle("active", isAtRef);
    btnRef.title = typeof refVol === "number" ? `Recall Reference Level (${Math.round(refVol)} dB)` : "Reference Level";

    // Active Monitor Guard Strip (warns immediately if MUTE/DIM/MONO/M/S/TALK is left engaged)
    const isMuted = Boolean(store.getVal(p.mainMute, 0));
    const isDim = Boolean(store.getVal(p.dim, 0));
    const isMono = Boolean(store.getVal(p.mono, 0));
    const isMs = Boolean(store.getVal(p.midSide, 0));
    const isTalk = Boolean(store.getVal(p.talkback, 0));
    const dimDepth = store.getVal(p.dimAtten, -15);
    const guards = [];
    if (isMuted) guards.push({ label: "MUTED", cls: "guard-danger", path: p.mainMute });
    if (isDim) guards.push({ label: `DIM ${Math.round(dimDepth)}dB`, cls: "guard-amber", path: p.dim });
    if (isMono) guards.push({ label: "MONO", cls: "guard-cyan", path: p.mono });
    if (isMs) guards.push({ label: "M/S DIFF", cls: "guard-purple", path: p.midSide });
    if (isTalk) guards.push({ label: "TALKBACK", cls: "guard-green", path: p.talkback });
    if (isAtRef && !isMuted) guards.push({ label: `REF ${Math.round(refVol)}dB`, cls: "guard-ref", path: null });

    if (guards.length > 0) {
      guardStrip.innerHTML = guards
        .map(
          (g, idx) =>
            `<button type="button" class="guard-badge ${g.cls}" data-gidx="${idx}" title="${g.path ? "Click to disengage" : "At Reference Level"}">${g.label}</button>`
        )
        .join("");
      guardStrip.querySelectorAll(".guard-badge").forEach((b) => {
        const g = guards[Number(b.dataset.gidx)];
        if (g?.path) b.addEventListener("click", () => store.toggleParam(g.path));
      });
    } else {
      guardStrip.innerHTML = "";
    }

    // Signal path & RoomTune readout strip
    const srcLabel = store.getOptionLabel(p.mainSrc, "MAIN").toUpperCase();
    const outLabel = spk === 1 ? "ALT OUT" : "MAIN OUT";
    const rtOn = p.roomByps ? !store.getVal(p.roomByps, 1) : false;
    signalStrip.innerHTML = `<span>${srcLabel} → ${outLabel}</span>${rtOn ? `<span class="signal-rt-tag">ROOMTUNE</span>` : ""}`;

    btnHp1Mute.classList.toggle("active", Boolean(store.getVal(p.hp1Mute, 0)));

    populateSelect(mainSrcSel, store, p.mainSrc, [
      { value: 0, name: "MAIN" },
      { value: 1, name: "MIX A" },
      { value: 2, name: "MIX B" },
      { value: 3, name: "HOST" },
    ]);
    const curMainSrc = Number(store.getVal(p.mainSrc, 0));
    container.classList.remove("mix-main", "mix-a", "mix-b", "mix-host");
    container.classList.add(
      curMainSrc === 1 ? "mix-a" : curMainSrc === 2 ? "mix-b" : curMainSrc === 3 ? "mix-host" : "mix-main"
    );
    if (lastMainSrc !== curMainSrc) {
      const clear = lastMainSrc !== null;
      lastMainSrc = curMainSrc;
      setWaveSource(waveIdFromMainSrc(curMainSrc), clear);
    }
    populateSelect(hp1SrcSel, store, p.hp1Src, [
      { value: 0, name: "MAIN" },
      { value: 1, name: "MIX A" },
      { value: 2, name: "MIX B" },
      { value: 3, name: "VIRTUAL THRU" },
    ]);
  }

  store.onSnapshot(syncAll);
  store.onParam((changedPath) => {
    const k = pathKey(changedPath);
    const p = store.paths;
    const watchList = [
      p.mainVol,
      p.mainMute,
      p.dim,
      p.mono,
      p.midSide,
      p.talkback,
      p.refVol,
      p.dimAtten,
      p.setToRef,
      p.mainSrc,
      p.speakerSel,
      p.roomByps,
      p.hp1Vol,
      p.hp1Mute,
      p.hp1Src,
    ];
    if (watchList.some((wp) => wp && pathKey(wp) === k)) {
      syncAll();
    }
  });

  store.onMeters((mf) => {
    const room = mf.room || [];
    const spk = store.paths.speakerSel ? store.getVal(store.paths.speakerSel, 0) : 0;
    const ml = spk === 1 ? (room[2] ?? room[0] ?? -128) : (room[0] ?? -128);
    const mr = spk === 1 ? (room[3] ?? room[1] ?? -128) : (room[1] ?? -128);
    masterMeter.setLevels(ml, mr);

    const wSrc = WAVE_SOURCES.find((w) => w.id === activeWaveId) || WAVE_SOURCES[0];
    const [wl, wr] = wSrc.read(mf);
    dockWave.pushLevel(wl, wr);
  });

  syncAll();
}
