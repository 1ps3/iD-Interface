// Monitor Settings & Device Settings View
// Matches iD Control Settings: Sample Rate, Clock Source, Buffer Size,
// Ref/Dim Levels, Volume Recall, Talkback Source, Mono Mode, Function Button,
// Optical Input (ADAT/SPDIF), Global Mute, Show Preamp Trim, Front Panel Meter

import { createKnob } from "../components/knob.js";
import { THEMES, COMPACT_LED_MODES, applyThemeToDocument, getVisibleThemes } from "../themes.js";
import { checkForGithubUpdate } from "../updater.js";
import { pathKey } from "../store.js";

function fillSelect(sel, store, path, fallback) {
  const vm = store.getVm(path);
  const opts = vm?.options?.length ? vm.options : fallback;
  const cur = store.getVal(path);
  sel.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.name;
    if (o.value === cur) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function createSettingsView(container, store, callbacks = {}) {
  let paramBindings = new Map();
  let unsubFnMode = null;
  let bootMsgState = null; // { msg, expiresAt }
  let memBtnState = new Map(); // btnId -> { restLabel, feedbackLabel, ok, expiresAt, pulse }
  let bootMsgTimer = null;
  let isMacOS = /Mac|Macintosh|MacIntel/i.test(navigator.platform || navigator.userAgent || "");
  let appVersion = "0.1.0";
  let activeEngine = isMacOS ? "adm" : "direct_usb";
  let lastUpdateCheck = null;

  const getClosePrefKey = () => (isMacOS ? "closeActionMac" : "closeActionWin");
  const getSavedCloseAction = () => {
    const v = store.getUiPref(getClosePrefKey(), null);
    if (v === "tray" || v === "quit") return v;
    if (!isMacOS) {
      const legacy = store.getUiPref("closeAction", null);
      if (legacy === "tray" || legacy === "quit") return legacy;
    }
    return null;
  };

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2 class="view-title">SETTINGS</h2>
        <p class="view-subtitle">Global Audio Engine, Studio Themes, Monitor Preferences &amp; Hardware Configuration</p>
      </div>
    </div>

    <div class="settings-top-strip" id="settingsTopStrip"></div>

    <div class="settings-theme-card" id="settingsThemeCard"></div>

    <div class="settings-columns">
      <div class="settings-col" id="monSettingsCol"></div>
      <div class="settings-col" id="devSettingsCol"></div>
    </div>
  `;

  const topStrip = container.querySelector("#settingsTopStrip");
  const themeCard = container.querySelector("#settingsThemeCard");
  const monCol = container.querySelector("#monSettingsCol");
  const devCol = container.querySelector("#devSettingsCol");

  function renderThemeStudio() {
    const curTheme = store.getUiPref("theme", "obsidian");
    const curCompactLed = store.getUiPref("compactTheme", "white");
    const rmsOn = store.getUiPref("rmsMeters", true) !== false;
    const hotkeysOn = store.getUiPref("hotkeysEnabled", true) !== false;
    const compactWaveOn = store.getUiPref("compactWave", true) !== false;

    const visibleThemes = getVisibleThemes(isMacOS);

    themeCard.innerHTML = `
      <div class="theme-card-head">
        <div>
          <div class="dock-title">APPEARANCE &amp; STUDIO WORKFLOW</div>
          <div class="set-row-desc">Console theme, compact LED palette, metering, and studio hotkeys</div>
        </div>
        <div class="theme-card-controls">
          <div class="theme-sub-ctrl">
            <span class="micro-label">THEME</span>
            <select class="dock-select set-select" id="setThemeSelect">
              ${visibleThemes
                .map(
                  (t) =>
                    `<option value="${t.id}" ${t.id === curTheme ? "selected" : ""}>${t.name}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="theme-sub-ctrl">
            <span class="micro-label">COMPACT LEDS</span>
            <div class="seg-group" id="setCompactLedSeg">
              ${COMPACT_LED_MODES.map(
                (m) => `<button type="button" class="seg-btn ${m.id === curCompactLed ? "active" : ""}" data-led="${m.id}">${m.label}</button>`
              ).join("")}
            </div>
          </div>
        </div>
      </div>

      <div class="theme-workflow-row">
        <div class="theme-wf-item">
          <div>
            <div class="set-row-title">DUAL PEAK + RMS METERS</div>
            <div class="set-row-desc">Inner RMS loudness density + click peak pills to clear latched clips</div>
          </div>
          <button type="button" class="switch-toggle ${rmsOn ? "on" : ""}" id="togRmsMeters"></button>
        </div>

        <div class="theme-wf-item">
          <div>
            <div class="set-row-title">COMPACT WAVEFORM</div>
            <div class="set-row-desc">Subtle faded audio history waveform along the bottom of Compact Mode</div>
          </div>
          <button type="button" class="switch-toggle ${compactWaveOn ? "on" : ""}" id="togCompactWave"></button>
        </div>

        <div class="theme-wf-item">
          <div>
            <div class="set-row-title">STUDIO HOTKEYS</div>
            <div class="set-row-desc">M Mute · D Dim · O Mono · T Talk · C Compact · ${isMacOS ? "⌥1–4" : "Alt+1–4"} Scenes</div>
          </div>
          <button type="button" class="switch-toggle ${hotkeysOn ? "on" : ""}" id="togHotkeys"></button>
        </div>
      </div>
    `;

    const selTheme = themeCard.querySelector("#setThemeSelect");
    selTheme?.addEventListener("change", () => {
      const id = selTheme.value;
      applyThemeToDocument(id);
      store.saveUiPref("theme", id);
      if (callbacks.onThemeChange) callbacks.onThemeChange(id);
    });

    themeCard.querySelectorAll("#setCompactLedSeg .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.led;
        store.saveUiPref("compactTheme", mode);
        if (callbacks.onCompactLedChange) callbacks.onCompactLedChange(mode);
        renderThemeStudio();
      });
    });

    themeCard.querySelector("#togRmsMeters").addEventListener("click", () => {
      const next = !(store.getUiPref("rmsMeters", true) !== false);
      store.saveUiPref("rmsMeters", next);
      document.documentElement.dataset.rms = next ? "on" : "off";
      renderThemeStudio();
    });

    themeCard.querySelector("#togCompactWave").addEventListener("click", () => {
      const next = !(store.getUiPref("compactWave", true) !== false);
      store.saveUiPref("compactWave", next);
      if (callbacks.onCompactWaveChange) callbacks.onCompactWaveChange(next);
      renderThemeStudio();
    });

    themeCard.querySelector("#togHotkeys").addEventListener("click", () => {
      const next = !(store.getUiPref("hotkeysEnabled", true) !== false);
      store.saveUiPref("hotkeysEnabled", next);
      renderThemeStudio();
    });
  }

  renderThemeStudio();

  function bind(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!paramBindings.has(k)) paramBindings.set(k, []);
    paramBindings.get(k).push(fn);
  }

  function rebuild() {
    paramBindings.clear();
    topStrip.innerHTML = "";
    monCol.innerHTML = "";
    devCol.innerHTML = "";

    const p = store.paths;
    if (!p.system || !p.monitorControl) {
      topStrip.innerHTML = `<div class="phase-placeholder"><span class="phase-tag">SETTINGS</span><h3>Connecting to device…</h3></div>`;
      return;
    }

    // --- Top Audio Engine Bar (Hardware Engine, Sample Rate, Clock Source, Buffer Size) ---
    topStrip.innerHTML = `
      <div class="setting-pill-card">
        <span class="micro-label">HARDWARE ENGINE</span>
        <select class="dock-select" id="setEngine">
          <option value="direct_usb">Direct USB (No ADM)</option>
          <option value="adm">Audient Device Manager</option>
        </select>
      </div>
      <div class="setting-pill-card">
        <span class="micro-label">SAMPLE RATE</span>
        <select class="dock-select" id="setSr"></select>
      </div>
      <div class="setting-pill-card">
        <span class="micro-label">CLOCK SOURCE</span>
        <select class="dock-select" id="setClk"></select>
      </div>
      <div class="setting-pill-card">
        <span class="micro-label">BUFFER SIZE</span>
        <select class="dock-select" id="setBuf"></select>
      </div>
    `;

    const selEngine = topStrip.querySelector("#setEngine");
    const selSr = topStrip.querySelector("#setSr");
    const selClk = topStrip.querySelector("#setClk");
    const selBuf = topStrip.querySelector("#setBuf");

    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke && selEngine) {
      invoke("get_backend_info")
        .then((info) => {
          if (info?.platform) isMacOS = info.platform === "macos";
          if (info?.appVersion) appVersion = info.appVersion;
          if (info?.activeEngine) activeEngine = info.activeEngine;
          if (info?.mode) selEngine.value = info.mode;
          if (info && !info.directAvailable) {
            const directOpt = selEngine.querySelector('option[value="direct_usb"]');
            if (directOpt) {
              directOpt.disabled = true;
              directOpt.textContent = "Direct USB (Unavailable)";
            }
          }
          syncPlatformSettingsUi();
        })
        .catch(() => {});
      selEngine.addEventListener("change", () => {
        invoke("set_backend_mode", { mode: selEngine.value }).catch(() => {});
      });
    }

    const syncTop = () => {
      fillSelect(selSr, store, p.sampleRate, [
        { value: 44100, name: "44.1kHz" },
        { value: 48000, name: "48kHz" },
        { value: 88200, name: "88.2kHz" },
        { value: 96000, name: "96kHz" },
        { value: 176400, name: "176.4kHz" },
        { value: 192000, name: "192kHz" },
      ]);
      fillSelect(selClk, store, p.clockSource, [
        { value: 0, name: "INTERNAL" },
        { value: 1, name: "DIGITAL 1" },
      ]);
      fillSelect(selBuf, store, p.bufferSize, [
        { value: 16, name: "16 Samples" },
        { value: 32, name: "32 Samples" },
        { value: 64, name: "64 Samples" },
        { value: 128, name: "128 Samples" },
        { value: 256, name: "256 Samples" },
        { value: 512, name: "512 Samples" },
        { value: 1024, name: "1024 Samples" },
        { value: 2048, name: "2048 Samples" },
      ]);
    };

    selSr.addEventListener("change", () => store.setParam(p.sampleRate, Number(selSr.value)));
    selClk.addEventListener("change", () => store.setParam(p.clockSource, Number(selClk.value)));
    selBuf.addEventListener("change", () => store.setParam(p.bufferSize, Number(selBuf.value)));
    bind(p.sampleRate, syncTop);
    bind(p.clockSource, syncTop);
    bind(p.bufferSize, syncTop);
    syncTop();

    // --- Left Column: Monitor Settings ---
    monCol.innerHTML = `
      <div class="dock-title">MONITOR SETTINGS</div>

      <div class="settings-knob-pair">
        <div class="settings-card-row knob-card">
          <div>
            <div class="set-row-title">DIM DEPTH</div>
            <div class="set-row-desc">Attenuation applied when Dim is active</div>
          </div>
          <div class="set-knob-host" id="dimDepthKnob"></div>
        </div>
        <div class="settings-card-row knob-card">
          <div>
            <div class="set-row-title">REF LEVEL</div>
            <div class="set-row-desc">Target dB when recalling Reference Level</div>
          </div>
          <div class="set-knob-host" id="refVolKnob"></div>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">VOLUME RECALL</div>
          <div class="set-row-desc">Restore last monitor level on power-up</div>
        </div>
        <button class="switch-toggle" id="togVolRecall"></button>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">TALKBACK SOURCE</div>
          <div class="set-row-desc">Input channel routed to Cue mixes when Talk is active</div>
        </div>
        <select class="dock-select set-select" id="selTalkSrc"></select>
      </div>

      <div class="settings-card-col">
        <div class="set-row-title">MONO MODE</div>
        <div class="seg-group full-width" id="monoModeSeg">
          <button class="seg-btn" data-val="0">LEFT</button>
          <button class="seg-btn" data-val="1">CENTRE</button>
          <button class="seg-btn" data-val="2">RIGHT</button>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">FUNCTION BUTTON</div>
          <div class="set-row-desc" id="fnKeyDesc">Action assigned to the physical iD function key</div>
        </div>
        <select class="dock-select set-select" id="selFnKey"></select>
      </div>
    `;

    const refKnob = createKnob(monCol.querySelector("#refVolKnob"), {
      min: -128,
      max: 0,
      muteAtMin: false,
      unit: "dB",
      compact: true,
      formatValue: (v) => (v <= -128 ? "-∞" : String(Math.round(v))),
      defaultValue: store.getVal(p.refVol, -21),
      onChange: (v) => store.setParam(p.refVol, Math.round(v)),
    });
    bind(p.refVol, (v) => refKnob.setValue(v));

    const dimKnob = createKnob(monCol.querySelector("#dimDepthKnob"), {
      min: -128,
      max: 0,
      muteAtMin: false,
      unit: "dB",
      compact: true,
      formatValue: (v) => (v <= -128 ? "-∞" : String(Math.round(v))),
      defaultValue: store.getVal(p.dimAtten, -15),
      onChange: (v) => store.setParam(p.dimAtten, Math.round(v)),
    });
    bind(p.dimAtten, (v) => dimKnob.setValue(v));

    const togRecall = monCol.querySelector("#togVolRecall");
    const syncRecall = () => togRecall.classList.toggle("on", Boolean(store.getVal(p.volRecall, 0)));
    togRecall.addEventListener("click", () => store.toggleParam(p.volRecall));
    bind(p.volRecall, syncRecall);
    syncRecall();

    const selTalk = monCol.querySelector("#selTalkSrc");
    const syncTalk = () =>
      fillSelect(selTalk, store, p.talkbackSrc, [{ value: -1, name: "None" }]);
    selTalk.addEventListener("change", () => store.setParam(p.talkbackSrc, Number(selTalk.value)));
    bind(p.talkbackSrc, syncTalk);
    syncTalk();

    const monoBtns = Array.from(monCol.querySelectorAll("#monoModeSeg .seg-btn"));
    const syncMonoMode = () => {
      const v = store.getVal(p.monoChnl, 1);
      monoBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
    };
    monoBtns.forEach((b) => b.addEventListener("click", () => store.setParam(p.monoChnl, Number(b.dataset.val))));
    bind(p.monoChnl, syncMonoMode);
    syncMonoMode();

    const selFn = monCol.querySelector("#selFnKey");
    const fnKeyDesc = monCol.querySelector("#fnKeyDesc");
    const CUSTOM_FN_OPTIONS = [
      { value: "custom:mute_mics", name: "Mute Mics (1 + 2)", desc: "Toggle hardware preamp mute on Mic 1 & Mic 2 (cough button)" },
      { value: "custom:mute_mic1", name: "Mute Mic 1", desc: "Toggle hardware preamp mute on Mic 1" },
      { value: "custom:mute_mic2", name: "Mute Mic 2", desc: "Toggle hardware preamp mute on Mic 2" },
      { value: "custom:mute_headphones", name: "Mute Headphones", desc: "Toggle Headphones (HP 1) mute to prevent room bleed" },
      { value: "custom:swap_spk_hp", name: "Speakers / Headphones Swap", desc: "Alternate between Main Speakers and Headphones (mutes one, unmutes the other)" },
      { value: "custom:mid_side", name: "Mid / Side Check", desc: "Toggle Monitor Mid/Side difference check for stereo width & phase" },
      { value: "custom:ref_level", name: "Reference Level Recall", desc: "Jump Main Monitor to calibrated Ref Level and toggle back to previous volume" },
      { value: "custom:global_mute", name: "Global Mute (All Outputs)", desc: "Mute or unmute all physical outputs (Speakers, Alt & Headphones) together" },
      { value: "custom:bypass_dsp", name: "Bypass Input DSP (A/B)", desc: "Bypass Mic 1 & 2 EQ + Compressor together for instant wet/dry comparison" },
      { value: "custom:toggle_scene1", name: "Toggle Scene 1", desc: "Switch between Saved Scene 1 and your Live Working Scene from the hardware button" },
    ];
    const syncFn = () => {
      const vm = store.getVm(p.fnKeyMode);
      const hwOpts = vm?.options?.length ? vm.options : [{ value: 0, name: "Off" }];
      const curHw = store.getVal(p.fnKeyMode, 0);
      const custom = store.customFnMode || "none";

      selFn.innerHTML = "";
      const hwGroup = document.createElement("optgroup");
      hwGroup.label = "Hardware";
      for (const o of hwOpts) {
        const opt = document.createElement("option");
        opt.value = String(o.value);
        opt.textContent = o.name;
        if (custom === "none" && o.value === curHw) opt.selected = true;
        hwGroup.appendChild(opt);
      }
      selFn.appendChild(hwGroup);

      const customGroup = document.createElement("optgroup");
      customGroup.label = "Custom Studio Actions";
      for (const o of CUSTOM_FN_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.name;
        if (custom !== "none" && o.value === `custom:${custom}`) opt.selected = true;
        customGroup.appendChild(opt);
      }
      selFn.appendChild(customGroup);

      const matchedCustom = custom !== "none" ? CUSTOM_FN_OPTIONS.find((o) => o.value === `custom:${custom}`) : null;
      fnKeyDesc.textContent = matchedCustom
        ? matchedCustom.desc
        : "Action assigned to the physical iD function key";
    };
    selFn.addEventListener("change", async () => {
      const v = selFn.value;
      if (v.startsWith("custom:")) {
        await store.setCustomFnMode(v.slice("custom:".length));
      } else {
        await store.setCustomFnMode("none");
        await store.setParam(p.fnKeyMode, Number(v));
      }
      syncFn();
    });
    bind(p.fnKeyMode, syncFn);
    if (unsubFnMode) unsubFnMode();
    unsubFnMode = store.onCustomFnMode(syncFn);
    syncFn();

    // --- Right Column: Device Settings ---
    const digInput0 = p.digitalInputs ? store.findChildPath(p.digitalInputs, (c) => c.tag === "DigitalInput") : null;
    const optModePath = digInput0 ? store.findParamPath(digInput0, "OptMode") : null;
    const showTrimPath = p.inputs ? store.findParamPath(p.inputs, "Trim") : null;

    devCol.innerHTML = `
      <div class="dock-title">DEVICE SETTINGS</div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">OPTICAL INPUT</div>
          <div class="set-row-desc">Switch digital optical input between ADAT &amp; S/PDIF</div>
        </div>
        <div class="seg-group" id="optModeSeg">
          <button class="seg-btn" data-val="0">ADAT</button>
          <button class="seg-btn" data-val="1">SPDIF</button>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">GLOBAL MUTE</div>
          <div class="set-row-desc">Mute all outputs together (Speakers, Main &amp; Alt)</div>
        </div>
        <button class="switch-toggle" id="togGlobalMute"></button>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">SHOW PREAMP TRIM</div>
          <div class="set-row-desc">Display digital Trim (0–15 dB) alongside preamp Gain</div>
        </div>
        <button class="switch-toggle" id="togPreampTrim"></button>
      </div>

      <div class="settings-card-row" id="rowOnboardMemory">
        <div>
          <div class="set-row-title">ONBOARD MEMORY</div>
          <div class="set-row-desc single-line-desc" id="hwBootDesc">Save or reload running desk state on hardware flash</div>
        </div>
        <div class="rt-toggles" id="hwMemBtns">
          <button type="button" class="mini-pill-btn hw-mem-btn" id="btnLoadBoot" title="Reload saved Boot State from hardware flash">RELOAD</button>
          <button type="button" class="mini-pill-btn hw-mem-btn" id="btnSaveBoot" title="Save current live state to iD2 onboard flash">SAVE</button>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">COMPACT POSITION</div>
          <div class="set-row-desc single-line-desc">Collapse to window top-right or remember last spot</div>
        </div>
        <div class="seg-group" id="compactPosSeg">
          <button type="button" class="seg-btn" data-val="anchor_right">TOP-RIGHT</button>
          <button type="button" class="seg-btn" data-val="remember">REMEMBER</button>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">CLOSE BUTTON (×)</div>
          <div class="set-row-desc" id="closeActionDesc">${
            isMacOS
              ? "Choose whether pressing × hides to the top menu bar or quits the app"
              : "Choose whether pressing × minimizes to the system tray or quits the app"
          }</div>
        </div>
        <div class="seg-group" id="closeActionSeg">
          <button type="button" class="seg-btn" data-val="tray" id="btnCloseOptTray">${isMacOS ? "MENU BAR" : "TRAY"}</button>
          <button type="button" class="seg-btn" data-val="quit">QUIT</button>
        </div>
      </div>

      <div class="settings-card-row">
        <div>
          <div class="set-row-title">SOFTWARE UPDATES</div>
          <div class="set-row-desc single-line-desc" id="updateStatusDesc">${
            lastUpdateCheck?.message || `iD Interface v${appVersion} · Checks GitHub Releases`
          }</div>
        </div>
        <div class="rt-toggles">
          <button type="button" class="mini-pill-btn hw-mem-btn" id="btnCheckUpdates" title="Check GitHub Releases for a newer version">${
            lastUpdateCheck?.status === "available" ? "DOWNLOAD" : "CHECK"
          }</button>
        </div>
      </div>
    `;

    const optBtns = Array.from(devCol.querySelectorAll("#optModeSeg .seg-btn"));
    const syncOpt = () => {
      const v = store.getVal(optModePath, 0);
      optBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === v));
    };
    optBtns.forEach((b) => b.addEventListener("click", () => optModePath && store.setParam(optModePath, Number(b.dataset.val))));
    bind(optModePath, syncOpt);
    syncOpt();

    const togGM = devCol.querySelector("#togGlobalMute");
    const syncGM = () => togGM.classList.toggle("on", Boolean(store.getVal(p.globalMute, 0)));
    togGM.addEventListener("click", () => store.toggleParam(p.globalMute));
    bind(p.globalMute, syncGM);
    syncGM();

    const togTrim = devCol.querySelector("#togPreampTrim");
    const syncTrim = () => togTrim.classList.toggle("on", Boolean(store.getVal(showTrimPath, 0)));
    togTrim.addEventListener("click", () => showTrimPath && store.toggleParam(showTrimPath));
    bind(showTrimPath, syncTrim);
    syncTrim();

    const btnSaveBoot = devCol.querySelector("#btnSaveBoot");
    const btnLoadBoot = devCol.querySelector("#btnLoadBoot");
    const hwBootDesc = devCol.querySelector("#hwBootDesc");
    const DEFAULT_BOOT_DESC = "Save or reload running desk state on hardware flash";

    const applyBootDesc = () => {
      if (!hwBootDesc) return;
      if (bootMsgState && bootMsgState.expiresAt > Date.now()) {
        hwBootDesc.textContent = bootMsgState.msg;
        clearTimeout(bootMsgTimer);
        bootMsgTimer = setTimeout(() => {
          bootMsgState = null;
          if (hwBootDesc.isConnected) hwBootDesc.textContent = DEFAULT_BOOT_DESC;
        }, Math.max(50, bootMsgState.expiresAt - Date.now()));
      } else {
        bootMsgState = null;
        hwBootDesc.textContent = DEFAULT_BOOT_DESC;
      }
    };

    const flashBootMsg = (msg) => {
      bootMsgState = { msg, expiresAt: Date.now() + 2400 };
      applyBootDesc();
    };

    const applyMemBtnState = (btn, withPulse = false) => {
      if (!btn) return;
      const st = memBtnState.get(btn.id);
      clearTimeout(btn._animTimer);
      if (st && st.expiresAt > Date.now()) {
        btn.classList.remove("is-confirmed", "is-error", "is-pulsing");
        if (withPulse) void btn.offsetWidth;
        btn.textContent = st.feedbackLabel;
        btn.classList.add(st.ok ? "is-confirmed" : "is-error");
        if (withPulse) btn.classList.add("is-pulsing");
        btn._animTimer = setTimeout(() => {
          memBtnState.delete(btn.id);
          if (!btn.isConnected) return;
          btn.classList.remove("is-confirmed", "is-error", "is-pulsing");
          btn.textContent = st.restLabel;
        }, Math.max(50, st.expiresAt - Date.now()));
      }
    };

    const animateMemBtn = (btn, restLabel, feedbackLabel, ok) => {
      if (!btn) return;
      memBtnState.set(btn.id, {
        restLabel,
        feedbackLabel,
        ok,
        expiresAt: Date.now() + 1350,
      });
      applyMemBtnState(btn, true);
    };

    applyBootDesc();
    applyMemBtnState(btnSaveBoot, false);
    applyMemBtnState(btnLoadBoot, false);

    btnSaveBoot?.addEventListener("click", async () => {
      if (!invoke) return;
      try {
        await invoke("save_hardware_boot_state");
        animateMemBtn(btnSaveBoot, "SAVE", "SAVED ✓", true);
        flashBootMsg("Saved current running state to onboard hardware flash");
      } catch {
        animateMemBtn(btnSaveBoot, "SAVE", "FAILED", false);
        flashBootMsg("Hardware save unavailable in current mode");
      }
    });
    btnLoadBoot?.addEventListener("click", async () => {
      if (!invoke) return;
      try {
        await invoke("load_hardware_boot_state");
        animateMemBtn(btnLoadBoot, "RELOAD", "LOADED ✓", true);
        flashBootMsg("Reloaded saved Boot State from hardware flash");
      } catch {
        animateMemBtn(btnLoadBoot, "RELOAD", "FAILED", false);
        flashBootMsg("Hardware reload unavailable in current mode");
      }
    });

    const compactPosBtns = Array.from(devCol.querySelectorAll("#compactPosSeg .seg-btn"));
    const syncCompactPos = () => {
      const cur = store.getUiPref("compactPositionMode", "anchor_right") === "remember" ? "remember" : "anchor_right";
      compactPosBtns.forEach((b) => b.classList.toggle("active", b.dataset.val === cur));
    };
    compactPosBtns.forEach((b) => {
      b.addEventListener("click", () => {
        const next = b.dataset.val === "remember" ? "remember" : "anchor_right";
        store.saveUiPref("compactPositionMode", next);
        syncCompactPos();
      });
    });
    syncCompactPos();

    const closeActionBtns = Array.from(devCol.querySelectorAll("#closeActionSeg .seg-btn"));
    const closeActionDesc = devCol.querySelector("#closeActionDesc");
    const btnCloseOptTray = devCol.querySelector("#btnCloseOptTray");
    const rowOnboardMemory = devCol.querySelector("#rowOnboardMemory");
    const updateStatusDesc = devCol.querySelector("#updateStatusDesc");
    const btnCheckUpdates = devCol.querySelector("#btnCheckUpdates");

    const syncCloseAction = () => {
      const cur = getSavedCloseAction();
      closeActionBtns.forEach((b) => b.classList.toggle("active", b.dataset.val === cur));
    };

    const syncPlatformSettingsUi = () => {
      if (btnCloseOptTray) btnCloseOptTray.textContent = isMacOS ? "MENU BAR" : "TRAY";
      if (closeActionDesc) {
        closeActionDesc.textContent = isMacOS
          ? "Choose whether pressing × hides to the top menu bar or quits the app"
          : "Choose whether pressing × minimizes to the system tray or quits the app";
      }
      if (rowOnboardMemory) {
        rowOnboardMemory.style.display = activeEngine === "direct_usb" ? "" : "none";
      }
      if (updateStatusDesc && !lastUpdateCheck) {
        updateStatusDesc.textContent = `iD Interface v${appVersion} · Checks GitHub Releases`;
      }
      syncCloseAction();
    };

    closeActionBtns.forEach((b) =>
      b.addEventListener("click", () => {
        store.saveUiPref(getClosePrefKey(), b.dataset.val);
        syncCloseAction();
        window.dispatchEvent(new CustomEvent("close-action-changed", { detail: b.dataset.val }));
      })
    );

    btnCheckUpdates?.addEventListener("click", async () => {
      if (lastUpdateCheck?.status === "available" && lastUpdateCheck.downloadUrl && invoke) {
        if (isMacOS) {
          invoke("open_external_url", { url: lastUpdateCheck.downloadUrl }).catch(() => {});
          return;
        }
        btnCheckUpdates.disabled = true;
        btnCheckUpdates.textContent = "UPDATING…";
        if (updateStatusDesc) updateStatusDesc.textContent = `Downloading v${lastUpdateCheck.latestVersion} & restarting…`;
        try {
          await invoke("install_app_update", {
            portableUrl: lastUpdateCheck.portableUrl || "",
            setupUrl: lastUpdateCheck.setupUrl || "",
            fallbackUrl: lastUpdateCheck.downloadUrl || lastUpdateCheck.releaseUrl || "",
          });
        } catch {
          btnCheckUpdates.disabled = false;
          btnCheckUpdates.textContent = "UPDATE";
          invoke("open_external_url", { url: lastUpdateCheck.downloadUrl }).catch(() => {});
        }
        return;
      }
      btnCheckUpdates.textContent = "CHECKING…";
      const res = await checkForGithubUpdate(appVersion, isMacOS);
      lastUpdateCheck = res;
      if (updateStatusDesc) updateStatusDesc.textContent = res.message;
      if (res.status === "available") {
        btnCheckUpdates.textContent = isMacOS ? "DOWNLOAD" : "UPDATE";
        btnCheckUpdates.classList.add("is-confirmed", "is-pulsing");
      } else if (res.status === "up_to_date") {
        animateMemBtn(btnCheckUpdates, "CHECK", "LATEST ✓", true);
      } else if (res.status === "unconfigured") {
        animateMemBtn(btnCheckUpdates, "CHECK", "NO REPO", false);
      } else {
        animateMemBtn(btnCheckUpdates, "CHECK", "OFFLINE", false);
      }
    });

    syncPlatformSettingsUi();
  }

  window.addEventListener("close-action-changed", (e) => {
    const cur = e.detail ?? getSavedCloseAction();
    devCol.querySelectorAll("#closeActionSeg .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === cur);
    });
  });

  store.onUiPrefs(() => {
    renderThemeStudio();
    const cur = getSavedCloseAction();
    devCol.querySelectorAll("#closeActionSeg .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === cur);
    });
    const curPos = store.getUiPref("compactPositionMode", "anchor_right") === "remember" ? "remember" : "anchor_right";
    devCol.querySelectorAll("#compactPosSeg .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === curPos);
    });
  });

  store.onSnapshot(rebuild);
  store.onParam((changedPath, prop, value) => {
    const cbs = paramBindings.get(pathKey(changedPath));
    if (cbs) cbs.forEach((fn) => fn(value));
  });

  rebuild();
}
