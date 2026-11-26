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

function syncGlassColorScheme() {
  const isLight = Boolean(colorSchemeQuery && colorSchemeQuery.matches);
  document.documentElement.dataset.glassScheme = isLight ? "light" : "dark";
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

export function getVisibleThemes(isMacOS = false) {
  return THEMES.filter((t) => !t.macosOnly || isMacOS);
}

export function applyThemeToDocument(themeId) {
  const valid = THEMES.some((t) => t.id === themeId) ? themeId : "obsidian";
  document.documentElement.dataset.theme = valid;
  if (valid === "liquidglass") {
    syncGlassColorScheme();
  }
  return valid;
}
