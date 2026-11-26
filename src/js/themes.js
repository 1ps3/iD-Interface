// Studio Theme & Surface Registry (9 Themes + Compact Hardware LED Palettes)

export const THEMES = [
  {
    id: "obsidian",
    name: "Stealth Obsidian",
    tag: "DEFAULT",
    swatches: ["#0c0c0e", "#161618", "#ec2f8c", "#2dd4bf"],
  },
  {
    id: "daylight",
    name: "Studio Daylight",
    tag: "WHITE",
    swatches: ["#e7e9ee", "#ffffff", "#181a20", "#0d9488"],
  },
  {
    id: "mono",
    name: "Pure Monochrome",
    tag: "NO COLOR",
    swatches: ["#080809", "#17171a", "#9898a0", "#ffffff"],
  },
  {
    id: "prism",
    name: "Prism Studio",
    tag: "HIGH COLOR",
    swatches: ["#0a0b14", "#f43f8e", "#a855f7", "#06b6d4"],
  },
  {
    id: "audient",
    name: "Audient iD",
    tag: "OFFICIAL MK3",
    swatches: ["#23252b", "#a381f5", "#e0348c", "#4fd8be"],
  },
  {
    id: "vintage",
    name: "Warm Vintage",
    tag: "ANALOGUE",
    swatches: ["#110f0d", "#1c1916", "#e5a04b", "#7ab592"],
  },
  {
    id: "brushed",
    name: "Brushed Gunmetal",
    tag: "TEXTURED",
    swatches: ["#252830", "#494e5a", "#38bdf8", "#a78bfa"],
  },
  {
    id: "carbon",
    name: "Tactile Carbon",
    tag: "TEXTURED",
    swatches: ["#0c0d10", "#1d1f26", "#ef4444", "#e2e8f0"],
  },
  {
    id: "powdercoat",
    name: "Powdercoat Slate",
    tag: "TEXTURED",
    swatches: ["#272a30", "#3a3e46", "#2dd4bf", "#ec4899"],
  },
  {
    id: "liquidglass",
    name: "Liquid Glass",
    tag: "MACOS AUTO",
    macosOnly: true,
    swatches: ["#e9eef8", "#242834", "#0a84ff", "#64d2ff"],
  },
];

export const COMPACT_LED_MODES = [
  { id: "white", label: "HARDWARE WHITE" },
  { id: "tinted", label: "MUTED TINT" },
  { id: "mono", label: "PURE MONO" },
];

const colorSchemeQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

const MAC_ACCENT_PALETTE = {
  [-1]: { light: "#8e8e93", dark: "#98989d", fg: "#ffffff" }, // Graphite
  0: { light: "#ff3b30", dark: "#ff453a", fg: "#ffffff" },    // Red
  1: { light: "#ff9500", dark: "#ff9f0a", fg: "#ffffff" },    // Orange
  2: { light: "#ffcc00", dark: "#ffd60a", fg: "#141821" },    // Yellow
  3: { light: "#28cd41", dark: "#30d158", fg: "#ffffff" },    // Green
  4: { light: "#007aff", dark: "#0a84ff", fg: "#ffffff" },    // Blue
  5: { light: "#af52de", dark: "#bf5af2", fg: "#ffffff" },    // Purple
  6: { light: "#ff2d55", dark: "#ff375f", fg: "#ffffff" },    // Pink
};

let currentMacAccentCode = null;

function applyMacAccentVars() {
  const isLight = document.documentElement.dataset.glassScheme === "light";
  const entry = MAC_ACCENT_PALETTE[currentMacAccentCode] || MAC_ACCENT_PALETTE[4];
  const color = isLight ? entry.light : entry.dark;
  document.documentElement.style.setProperty("--mac-accent", color);
  document.documentElement.style.setProperty("--mac-accent-fg", entry.fg);
}

export async function refreshSystemAccent() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    const code = await invoke("get_system_accent");
    currentMacAccentCode = typeof code === "number" ? code : null;
    applyMacAccentVars();
  } catch {}
}

function syncGlassColorScheme() {
  const isLight = Boolean(colorSchemeQuery && colorSchemeQuery.matches);
  document.documentElement.dataset.glassScheme = isLight ? "light" : "dark";
  const theme = document.documentElement.dataset.theme;
  document.documentElement.dataset.lightUi =
    theme === "daylight" || (theme === "liquidglass" && isLight) ? "true" : "false";
  applyMacAccentVars();
}

if (colorSchemeQuery) {
  syncGlassColorScheme();
  const onSchemeChange = () => {
    syncGlassColorScheme();
    if (document.documentElement.dataset.theme === "liquidglass") {
      window.dispatchEvent(new CustomEvent("system-color-scheme-changed"));
    }
  };
  if (colorSchemeQuery.addEventListener) {
    colorSchemeQuery.addEventListener("change", onSchemeChange);
  } else if (colorSchemeQuery.addListener) {
    colorSchemeQuery.addListener(onSchemeChange);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (document.documentElement.dataset.platform === "macos") {
      refreshSystemAccent();
    }
  });
}

export function getVisibleThemes(isMacOS = false) {
  return THEMES.filter((t) => !t.macosOnly || isMacOS);
}

export function applyThemeToDocument(themeId) {
  const valid = THEMES.some((t) => t.id === themeId) ? themeId : "obsidian";
  document.documentElement.dataset.theme = valid;
  syncGlassColorScheme();
  if (valid === "liquidglass") {
    refreshSystemAccent();
  }
  return valid;
}
