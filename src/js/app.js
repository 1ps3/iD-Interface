// Main frontend orchestrator: Compact Widget <-> Full iD2 MK3 Studio Console

import { store, pathKey } from "./store.js";
import { applyThemeToDocument, applyGlassTintMode } from "./themes.js";
import { checkForGithubUpdate } from "./updater.js";
import { initCustomSelects, openCustomMenu } from "./components/select.js";
import { createCompactWidget } from "./views/compact.js";
import { createMasterDock } from "./views/master-dock.js";
import { createMixerView } from "./views/mixer.js";
import { createPreampsView } from "./views/preamps.js";
import { createMonitoringView } from "./views/monitoring.js";
import { createRoutingView } from "./views/routing.js";
import { createSettingsView } from "./views/settings.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const COMPACT_RATIO = 512 / 344;
const DEFAULT_COMPACT_W = 440;
const FULL_SIZE = { width: 1330, height: 790, minWidth: 1330, minHeight: 790 };

let isMacOS = /Mac|Macintosh|MacIntel/i.test(navigator.platform || navigator.userAgent || "");
document.documentElement.dataset.platform = isMacOS ? "macos" : "windows";
if (isMacOS) applyThemeToDocument("liquidglass");
let isFullMode = true;
let isPinnedFull = false;
let isPinnedCompact = true;
let isModeSwitching = false;

const shell = document.getElementById("appShell");
const topbarDot = document.getElementById("topbarDot");
const brandModel = document.getElementById("brandModel");
const srPill = document.getElementById("srPill");
const bufPill = document.getElementById("bufPill");
const clkPill = document.getElementById("clkPill");
const btnPin = document.getElementById("btnPin");
const btnPinCompact = document.getElementById("btnPinCompact");

initCustomSelects();

// Universal hover scroll-wheel control for all <input type="range"> sliders
// Steps by 1 whole number per wheel notch (hold Shift for native fine step, e.g. 0.1 dB / 0.05 ms)
document.addEventListener(
  "wheel",
  (e) => {
    const el = e.target?.closest?.('input[type="range"]');
    if (!el || el.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const min = el.min !== "" ? Number(el.min) : 0;
    const max = el.max !== "" ? Number(el.max) : 100;
    const nativeStep = el.step && el.step !== "any" ? Number(el.step) : 1;
    const deltaStep = e.shiftKey ? nativeStep : Math.max(1, nativeStep);
    const dir = e.deltaY < 0 ? 1 : -1;
    const cur = Number(el.value);
    let next = Math.max(min, Math.min(max, cur + dir * deltaStep));
    next = !e.shiftKey && deltaStep === 1 ? Math.round(next) : Math.round(next * 100) / 100;
    if (next !== cur) {
      el.value = String(next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  },
  { passive: false }
);

const compactWidget = createCompactWidget(document.getElementById("compactView"), store, invoke);

// --- Compact <-> Full Mode Switching (Smooth Fade + Atomic Window Resize) ---
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function setWindowMode(full) {
  if (isModeSwitching || isFullMode === full) return;
  isModeSwitching = true;
  try {
    // 1. Smoothly fade out current view before changing window geometry
    shell.classList.add("mode-fading");
    await waitMs(115);

    // 2. While hidden, swap layout & resize/position atomically in one OS frame
    isFullMode = full;
    document.documentElement.classList.toggle("is-compact-mode", !full);
    if (!full) {
      applyWindowFrameState({ maximized: false, fullscreen: false, snapped: false });
    }
    shell.classList.toggle("mode-full", full);
    const compactW = compactWidget.getPreferredWidth ? compactWidget.getPreferredWidth() : DEFAULT_COMPACT_W;
    const compactH = Math.round(compactW / COMPACT_RATIO);
    const spec = full
      ? FULL_SIZE
      : { width: compactW, height: compactH, minWidth: 320, minHeight: Math.round(320 / COMPACT_RATIO) };
    await invoke("set_window_size", {
      width: spec.width,
      height: spec.height,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      anchorRight: true,
      resizable: full,
      isFull: full,
    }).catch(() => {});
    await invoke("set_always_on_top", { onTop: full ? isPinnedFull : isPinnedCompact }).catch(() => {});

    // 3. Let WebView finish laying out at final size, then smoothly fade back in
    await nextFrame();
    if (!full) compactWidget.syncScale();
    else await syncMaximizeBtn();
    await nextFrame();
    shell.classList.remove("mode-fading");
    await waitMs(170);
  } finally {
    shell.classList.remove("mode-fading");
    isModeSwitching = false;
  }
}

document.getElementById("btnExpand").addEventListener("click", (e) => {
  e.stopPropagation();
  setWindowMode(true);
});

document.getElementById("btnCollapse").addEventListener("click", (e) => {
  e.stopPropagation();
  setWindowMode(false);
});

btnPin.addEventListener("click", async () => {
  isPinnedFull = !isPinnedFull;
  btnPin.classList.toggle("active", isPinnedFull);
  btnPin.title = isPinnedFull ? "Pinned (Always on Top)" : "Pin Always on Top";
  store.saveUiPref("pinned", isPinnedFull);
  await invoke("set_always_on_top", { onTop: isPinnedFull }).catch(() => {});
});

if (btnPinCompact) {
  btnPinCompact.addEventListener("click", async (e) => {
    e.stopPropagation();
    isPinnedCompact = !isPinnedCompact;
    btnPinCompact.classList.toggle("active", isPinnedCompact);
    btnPinCompact.title = isPinnedCompact ? "Pinned (Always on Top)" : "Pin Always on Top";
    store.saveUiPref("pinnedCompact", isPinnedCompact);
    if (!isFullMode) {
      await invoke("set_always_on_top", { onTop: isPinnedCompact }).catch(() => {});
    }
  });
}

const btnMax = document.getElementById("btnMax");

function applyWindowFrameState(state) {
  if (state && (state.mode === "compact" || state.mode === "full") && !isModeSwitching) {
    const nextFull = state.mode === "full";
    if (nextFull !== isFullMode) {
      isFullMode = nextFull;
      document.documentElement.classList.toggle("is-compact-mode", !isFullMode);
      shell.classList.toggle("mode-full", isFullMode);
      if (!isFullMode) {
        requestAnimationFrame(() => compactWidget.syncScale());
      }
    }
  }
  document.documentElement.classList.toggle("is-compact-mode", !isFullMode);
  const maximized = Boolean(isFullMode && state?.maximized);
  const fullscreen = Boolean(isFullMode && state?.fullscreen);
  const snapped = Boolean(isFullMode && state?.snapped);
  const isExpanded = maximized || fullscreen;
  const isEdgeToEdge = maximized || fullscreen || snapped;

  document.documentElement.classList.toggle("is-maximized", maximized);
  document.documentElement.classList.toggle("is-fullscreen", fullscreen);
  document.documentElement.classList.toggle("is-snapped", snapped);
  shell.classList.toggle("is-maximized", maximized);
  shell.classList.toggle("is-fullscreen", fullscreen);
  shell.classList.toggle("is-snapped", snapped);
  shell.classList.toggle("is-edge-to-edge", isEdgeToEdge);

  btnMax.classList.toggle("is-maximized", isExpanded);
  btnMax.title = fullscreen ? "Exit Fullscreen (F11)" : maximized ? "Restore Down" : "Maximize";
}

async function syncMaximizeBtn() {
  try {
    const state = await invoke("get_window_state");
    applyWindowFrameState(state);
  } catch {
    if (!isFullMode) {
      applyWindowFrameState({ maximized: false, fullscreen: false, snapped: false });
      return;
    }
    try {
      const w = getCurrentWindow();
      const [maximized, fullscreen] = await Promise.all([w.isMaximized(), w.isFullscreen()]);
      applyWindowFrameState({ maximized, fullscreen, snapped: false });
    } catch {}
  }
}

if (isMacOS) document.documentElement.dataset.platform = "macos";

const handleMinimize = () => {
  invoke("minimize_window").catch(() => getCurrentWindow().minimize());
};

const handleMaximize = async () => {
  try {
    const state = await invoke("toggle_maximize_window");
    applyWindowFrameState(state);
  } catch {
    const w = getCurrentWindow();
    await w.toggleMaximize();
    applyWindowFrameState({
      maximized: await w.isMaximized(),
      fullscreen: await w.isFullscreen(),
      snapped: false,
    });
  }
};

document.getElementById("btnMin").addEventListener("click", handleMinimize);
btnMax.addEventListener("click", handleMaximize);

window.__TAURI__?.event?.listen("window-state-changed", (e) => {
  if (e?.payload) applyWindowFrameState(e.payload);
});

window.addEventListener("resize", () => {
  if (isFullMode) syncMaximizeBtn();
  else compactWidget.syncScale();
});
syncMaximizeBtn();

let appVersion = "0.1.0";
let closeModalEl = null;

function getClosePrefKey() {
  return isMacOS ? "closeActionMac" : "closeActionWin";
}

function getSavedCloseAction() {
  const key = getClosePrefKey();
  const v = store.getUiPref(key, null);
  if (v === "tray" || v === "quit") return v;
  if (!isMacOS) {
    const legacy = store.getUiPref("closeAction", null);
    if (legacy === "tray" || legacy === "quit") return legacy;
  }
  return null;
}

function syncCloseBtnTitles(action) {
  const hideLabel = isMacOS ? "Minimize to Menu Bar" : "Minimize to Tray";
  const title = action === "tray" ? hideLabel : action === "quit" ? "Quit App" : "Close";
  for (const id of ["btnCloseCompact", "btnCloseFull", "btnMacClose"]) {
    const el = document.getElementById(id);
    if (el) el.title = title;
  }
}

async function performCloseAction(action) {
  try {
    await store.flushPendingParams();
    await mixerView?.flushWorkingScene?.();
  } catch {}
  if (action === "tray") {
    try {
      await invoke("hide_to_tray");
    } catch {}
  } else {
    try {
      await invoke("quit_app");
    } catch {
      getCurrentWindow().close();
    }
  }
}

function showFirstClosePrompt() {
  if (closeModalEl) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const targetSurface = isMacOS ? "top menu bar" : "system tray";
  const hideBtnLabel = isMacOS ? "MINIMIZE TO MENU BAR" : "MINIMIZE TO TRAY";
  const iconSvg = isMacOS
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M12 20V9"/><path d="m7 14 5-5 5 5"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>`;

  backdrop.innerHTML = `
    <div class="modal-card close-modal-card" role="dialog" aria-modal="true" aria-labelledby="closeModalTitle">
      <div class="close-modal-icon" aria-hidden="true">${iconSvg}</div>
      <h3 id="closeModalTitle">CLOSE iD INTERFACE</h3>
      <p>Would you like to minimize to the ${targetSurface} or quit the app?</p>
      <div class="close-modal-hint">You can change this anytime in Settings.</div>
      <div class="modal-actions close-modal-actions">
        <button type="button" class="action-btn accent-btn" id="btnChooseTray">${hideBtnLabel}</button>
        <button type="button" class="action-btn close-quit-btn" id="btnChooseQuit">QUIT APP</button>
      </div>
      <button type="button" class="close-modal-cancel" id="btnChooseCancel">Cancel</button>
    </div>
  `;

  const dismiss = () => {
    window.removeEventListener("keydown", onKey);
    backdrop.remove();
    closeModalEl = null;
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    }
  };
  window.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  backdrop.querySelector("#btnChooseCancel").addEventListener("click", dismiss);

  const choose = async (action) => {
    dismiss();
    syncCloseBtnTitles(action);
    await store.saveUiPref(getClosePrefKey(), action);
    window.dispatchEvent(new CustomEvent("close-action-changed", { detail: action }));
    await performCloseAction(action);
  };
  backdrop.querySelector("#btnChooseTray").addEventListener("click", () => choose("tray"));
  backdrop.querySelector("#btnChooseQuit").addEventListener("click", () => choose("quit"));

  document.body.appendChild(backdrop);
  closeModalEl = backdrop;
}

window.addEventListener("close-action-changed", (e) => {
  syncCloseBtnTitles(e.detail || null);
});

function handleCloseButton() {
  const action = getSavedCloseAction();
  if (action === "tray" || action === "quit") {
    performCloseAction(action);
  } else {
    showFirstClosePrompt();
  }
}

for (const id of ["btnCloseCompact", "btnCloseFull", "btnMacClose"]) {
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCloseButton();
  });
}

window.__TAURI__?.event?.listen("request-close-prompt", () => {
  showFirstClosePrompt();
});

window.__TAURI__?.event?.listen("fn-toggle-scene", (e) => {
  const idx = typeof e.payload === "number" ? e.payload : 0;
  mixerView?.recallScene?.(idx);
});

window.__TAURI__?.event?.listen("tray-toggle-mode", () => {
  setWindowMode(!isFullMode);
});

// --- Left Navigation Tabs ---
const navBtns = Array.from(document.querySelectorAll(".nav-item[data-tab]"));
const viewPanes = Array.from(document.querySelectorAll(".view-pane[data-pane]"));

function selectTab(tabId, persist = true) {
  const valid = navBtns.some((b) => b.dataset.tab === tabId) ? tabId : "mixer";
  navBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === valid));
  viewPanes.forEach((p) => p.classList.toggle("active", p.dataset.pane === valid));
  if (persist) store.saveUiPref("activeTab", valid);
}

navBtns.forEach((btn) => {
  btn.addEventListener("click", () => selectTab(btn.dataset.tab, true));
});

// --- Topbar Telemetry & Quick Dropdown Pills ---
const FALLBACK_SR = [
  { value: 44100, name: "44.1kHz" },
  { value: 48000, name: "48kHz" },
  { value: 88200, name: "88.2kHz" },
  { value: 96000, name: "96kHz" },
  { value: 176400, name: "176.4kHz" },
  { value: 192000, name: "192kHz" },
];
const FALLBACK_BUF = [
  { value: 16, name: "16 Samples" },
  { value: 32, name: "32 Samples" },
  { value: 64, name: "64 Samples" },
  { value: 128, name: "128 Samples" },
  { value: 256, name: "256 Samples" },
  { value: 512, name: "512 Samples" },
  { value: 1024, name: "1024 Samples" },
  { value: 2048, name: "2048 Samples" },
];
const FALLBACK_CLK = [
  { value: 0, name: "Internal" },
  { value: 1, name: "Optical" },
];

function formatTitleOption(name) {
  const s = String(name || "").trim();
  if (!s) return s;
  return s.replace(/\S+/g, (w) => {
    if (/^\d/.test(w)) return w;
    const l = w.toLowerCase();
    return l.charAt(0).toUpperCase() + l.slice(1);
  });
}

function wireTelemetryDropdown(pillEl, getPath, fallbackOpts, titleCase = false) {
  pillEl.addEventListener("mousedown", (e) => e.stopPropagation());
  pillEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = getPath();
    if (!p) return;
    const vm = store.getVm(p);
    const rawOpts = vm?.options?.length ? vm.options : fallbackOpts;
    const opts = titleCase ? rawOpts.map((o) => ({ ...o, name: formatTitleOption(o.name) })) : rawOpts;
    const cur = store.getVal(p);
    openCustomMenu(pillEl, opts, cur, (val) => {
      store.setParam(p, Number(val));
    });
  });
}

wireTelemetryDropdown(srPill, () => store.paths.sampleRate, FALLBACK_SR);
wireTelemetryDropdown(bufPill, () => store.paths.bufferSize, FALLBACK_BUF);
wireTelemetryDropdown(clkPill, () => store.paths.clockSource, FALLBACK_CLK, true);

function syncTopbar() {
  const devName = store.connected ? store.getDeviceName() : "";
  brandModel.textContent = devName || "NO DEVICE";
  const sr = store.getOptionLabel(store.paths.sampleRate, "—");
  const buf = store.getOptionLabel(store.paths.bufferSize, "—").replace(" Samples", " smp");
  const clk = store.getOptionLabel(store.paths.clockSource, "—");
  srPill.textContent = sr;
  bufPill.textContent = buf;
  clkPill.textContent = clk === "INTERNAL" ? "INT" : clk;
}

// --- Mount All Studio Console Views ---
createMasterDock(document.getElementById("masterDock"), store);
const mixerView = createMixerView(document.getElementById("paneMixer"), store);
createPreampsView(document.getElementById("panePreamps"), store);
createMonitoringView(document.getElementById("paneMonitoring"), store);
createRoutingView(document.getElementById("paneRouting"), store);
createSettingsView(document.getElementById("paneSettings"), store, {
  onThemeChange() {
    compactWidget.refreshTheme();
  },
  onCompactLedChange(mode) {
    compactWidget.setTheme(mode);
  },
  onCompactWaveChange(enabled) {
    compactWidget.setShowWave(enabled);
  },
});

// --- Studio Keyboard Hotkeys (togglable in Settings) ---
window.addEventListener("keydown", (e) => {
  // Standard macOS Cmd+Q quits cleanly after saving state
  if (isMacOS && e.metaKey && e.key.toLowerCase() === "q") {
    e.preventDefault();
    performCloseAction("quit");
    return;
  }
  // Standard F11 (Windows/Linux) or Ctrl+Cmd+F (macOS) toggles true native fullscreen in Full Mode
  if (
    isFullMode &&
    ((!isMacOS && e.key === "F11") || (isMacOS && e.metaKey && e.ctrlKey && e.key.toLowerCase() === "f"))
  ) {
    e.preventDefault();
    invoke("toggle_fullscreen_window")
      .then((state) => applyWindowFrameState(state))
      .catch(() => {});
    return;
  }
  if (store.getUiPref("hotkeysEnabled", true) === false) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
  if (e.ctrlKey || e.metaKey) return;

  // Alt+1..4 recalls saved studio scenes
  if (e.altKey && e.key >= "1" && e.key <= "4") {
    e.preventDefault();
    mixerView?.recallScene?.(Number(e.key) - 1);
    return;
  }
  if (e.altKey) return;

  const k = e.key.toLowerCase();
  if (k === "m" && store.paths.mainMute) {
    e.preventDefault();
    store.toggleParam(store.paths.mainMute);
  } else if (k === "d" && store.paths.dim) {
    e.preventDefault();
    store.toggleParam(store.paths.dim);
  } else if (k === "o" && store.paths.mono) {
    e.preventDefault();
    store.toggleParam(store.paths.mono);
  } else if (k === "t" && store.paths.talkback) {
    e.preventDefault();
    store.toggleParam(store.paths.talkback);
  } else if (k === "c") {
    e.preventDefault();
    setWindowMode(!isFullMode);
  }
});

// --- Store Subscriptions ---
let activeEngineLabel = "Direct USB (No ADM)";
window.__TAURI__?.event?.listen("backend-info", (e) => {
  const info = e.payload;
  if (!info) return;
  activeEngineLabel = info.activeEngine === "direct_usb" ? "Direct USB (No ADM)" : "Audient Device Manager";
  if (topbarDot) {
    topbarDot.title = store.connected ? `Connected via ${activeEngineLabel}` : `Waiting for ${activeEngineLabel}…`;
  }
});
function showTopbarUpdateBadge(res) {
  const rightBar = document.querySelector(".topbar-right");
  if (!rightBar || rightBar.querySelector("#btnUpdatePill")) return;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.id = "btnUpdatePill";
  pill.className = "telemetry-pill update-avail-pill";
  pill.textContent = `UPDATE v${res.latestVersion}`;
  pill.title = `Download, install & restart to iD Interface v${res.latestVersion}`;
  pill.addEventListener("click", async () => {
    if (pill.disabled) return;
    pill.disabled = true;
    pill.textContent = "UPDATING…";
    try {
      await invoke("install_app_update", {
        portableUrl: res.portableUrl || "",
        setupUrl: res.setupUrl || "",
        fallbackUrl: res.downloadUrl || res.releaseUrl || "",
      });
    } catch {
      pill.disabled = false;
      pill.textContent = `UPDATE v${res.latestVersion}`;
      invoke("open_external_url", { url: res.downloadUrl || res.releaseUrl }).catch(() => {});
    }
  });
  rightBar.prepend(pill);
}

invoke("get_backend_info")
  .then((info) => {
    if (!info) return;
    if (info.platform) isMacOS = info.platform === "macos";
    if (info.appVersion) appVersion = info.appVersion;
    document.documentElement.dataset.platform = info.platform || (isMacOS ? "macos" : "windows");
    syncCloseBtnTitles(getSavedCloseAction());
    activeEngineLabel = info.activeEngine === "direct_usb" ? "Direct USB (No ADM)" : "Audient Device Manager";
    if (topbarDot) {
      topbarDot.title = store.connected ? `Connected via ${activeEngineLabel}` : `Waiting for ${activeEngineLabel}…`;
    }
    // Silent non-blocking background update check 4s after launch
    setTimeout(async () => {
      const res = await checkForGithubUpdate(appVersion, isMacOS);
      if (res.status === "available" && res.downloadUrl) {
        showTopbarUpdateBadge(res);
      }
    }, 4000);
  })
  .catch(() => {});

store.onStatus((connected) => {
  topbarDot?.classList.toggle("connected", connected);
  if (topbarDot) {
    topbarDot.title = connected ? `Connected via ${activeEngineLabel}` : `Waiting for ${activeEngineLabel}…`;
  }
  syncTopbar();
});

store.onSnapshot(() => {
  syncTopbar();
});

store.onParam((changedPath) => {
  const k = pathKey(changedPath);
  const p = store.paths;
  if ([p.sampleRate, p.bufferSize, p.clockSource].some((wp) => wp && pathKey(wp) === k)) {
    syncTopbar();
  }
});

store.onUiPrefs((prefs) => {
  const themeId = typeof prefs.theme === "string" ? prefs.theme : isMacOS ? "liquidglass" : "obsidian";
  applyThemeToDocument(themeId);
  applyGlassTintMode(typeof prefs.glassTintMode === "string" ? prefs.glassTintMode : "auto");
  compactWidget.refreshTheme();
  if (typeof prefs.rmsMeters === "boolean") {
    document.documentElement.dataset.rms = prefs.rmsMeters ? "on" : "off";
  }
  if (typeof prefs.activeTab === "string") {
    selectTab(prefs.activeTab, false);
  }
  if (typeof prefs.pinned === "boolean") {
    isPinnedFull = prefs.pinned;
    btnPin.classList.toggle("active", isPinnedFull);
    btnPin.title = isPinnedFull ? "Pinned (Always on Top)" : "Pin Always on Top";
    if (isFullMode) {
      invoke("set_always_on_top", { onTop: isPinnedFull }).catch(() => {});
    }
  }
  if (typeof prefs.pinnedCompact === "boolean") {
    isPinnedCompact = prefs.pinnedCompact;
    if (btnPinCompact) {
      btnPinCompact.classList.toggle("active", isPinnedCompact);
      btnPinCompact.title = isPinnedCompact ? "Pinned (Always on Top)" : "Pin Always on Top";
    }
    if (!isFullMode) {
      invoke("set_always_on_top", { onTop: isPinnedCompact }).catch(() => {});
    }
  }
  syncCloseBtnTitles(getSavedCloseAction());
});

window.addEventListener("system-color-scheme-changed", () => {
  compactWidget.refreshTheme();
});

selectTab("mixer", false);

store.init().then(() => {
  if (!store.root) {
    invoke("get_volume").then((db) => compactWidget.setFallbackVolume(db)).catch(() => {});
  }
});
