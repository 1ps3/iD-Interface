# iD Interface — Open-Source Audient iD1, iD2, iD2+ & iD4+ (MK3) Software & Mixer

A fast, lightweight, open-source replacement mixer, DSP studio console, and floating desktop volume controller built specifically for the **Audient iD MK3 series** (**iD1**, **iD2**, **iD2+**, and **iD4+**) on **Windows & macOS** — powered by **Rust + Tauri v2** with zero-bloat native WebView rendering.

> **Supported Hardware:** Designed exclusively for the 4 **Audient iD MK3** audio interfaces: **iD1**, **iD2**, **iD2+**, and **iD4+**. *(Legacy MK1/MK2 models such as iD4, iD14, iD24, and iD44 are not targeted.)*

<p align="center">
  <img src="docs/preview-themes.png" alt="iD Interface — 9 Studio Themes" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/1ps3/iD-Interface/releases/latest"><b>⬇ Download the latest release (Windows &amp; macOS)</b></a>
</p>

---

## Download & Install

Grab the latest build from **[Releases](https://github.com/1ps3/iD-Interface/releases/latest)**:

| Platform | File | Notes |
| --- | --- | --- |
| **Windows 10/11** | `iD Interface_x.y.z_x64-setup.exe` | Recommended installer |
| **Windows (portable)** | `id-interface.exe` | No install — just run it |
| **macOS (Apple Silicon + Intel)** | `iD Interface_x.y.z_universal.dmg` | Drag to Applications |

* **Updates:** Built-in **1-click self-updater** (Windows & macOS) — checks GitHub Releases on launch, shows an **`UPDATE vX.Y.Z`** badge in the top bar (or **Settings → CHECK**), and downloads, installs, and restarts automatically.
* **macOS first launch:** Builds are not notarized yet, so run `xattr -cr "/Applications/iD Interface.app"` once (or right-click → Open).
* **Windows SmartScreen:** Builds are not code-signed yet — click **More info → Run anyway**.

---

## Compact Floating Mode

Collapse the full console into a resizable, always-on-top hardware faceplate for instant monitor volume, headphone level, preamp gain, 48V, mute, dim, HPF, and live metering — with a single click (`C`) back to the full desk.

<p align="center">
  <img src="docs/preview-compact.png" alt="iD Interface — Compact Floating Mode" width="380" />
</p>

---

## What's New & Key Features

### Standalone Direct USB on Windows & macOS — No ADM Required
* **Direct USB Engine (Windows & macOS — Zero Audient Software Needed):** Talks directly to your **iD1 / iD2 / iD2+ / iD4+** over USB (TUSBAudio driver on Windows, native IOKit on macOS alongside CoreAudio) with live two-way hardware sync, 30fps metering, real hardware compressor gain reduction, and full DSP — zero background `AudientDeviceManager` or Bonjour needed. You can still toggle back to ADM mode anytime in Settings.
* **macOS Native Experience (Apple Silicon & Intel Universal):** Includes an adaptive **Liquid Glass** theme (auto-syncs with macOS Light/Dark mode) and hides cleanly into the **top Menu Bar** (removing itself from the Dock until reopened).
* **System Tray & First-Close Prompt:** The first time you press `×`, choose whether to minimize to the **System Tray** (Windows) / **Top Menu Bar** (macOS) or quit — and toggle anytime in Settings.

### Full Studio Console & Hardware DSP
* **4-Bus Mixer (`Main Mix`, `Mix A`, `Mix B`, `Reverb`)** with Dual Peak + RMS metering, custom channel scribble strips, and instant `STEREO`/`MONO` pairing.
* **Zero-Scroll Channel Strip & DSP Deck:** Preamp Gain, 48V, Mute, V-HPF, V-Phase, Tone (`Glow` / `HMX` / `Lift` / `Orbit`), 4-band Parametric EQ with live SVG response curve, Compressor with hardware GR meter and discrete `2:1 / 4:1 / 8:1 / 16:1` ratios, DSP Order, Record FX, and Reverb Send — all unlocked up to **96 kHz** and cleanly faded until engaged.
* **4 Saved Scenes + Auto-Saving Working Scene:** Recall up to 4 desk setups (`Alt+1–4` / `⌥1–4`), click an active scene to toggle back to your continuously saved live mix, and commit your running desk directly to **iD2 onboard hardware flash** (`SAVE` / `RELOAD` in Settings, plus auto-save on close).
* **Preamps + SmartGain**, **3D RoomTune Monitoring Soundstage**, and **Output & Loopback Routing Matrix** (with Virtual Thru loud-output guard).
* **9 Built-in Studio Themes:** Pure Monochrome, Tactile Carbon, Warm Vintage, Brushed Gunmetal, Studio Daylight, Powdercoat Slate, Audient iD MK3, Prism Studio, and Stealth Obsidian.
* **Built-in Update Checker:** Polls GitHub Releases and surfaces a one-click update badge in the top bar and Settings.

### Desktop Integration
* **Native Windows Window Frame:** Full Console uses the native Windows DWM frame (theme-aware border, corners & shadow, Aero Snap, `Win+↑/↓`, double-click title bar) plus `F11` true fullscreen.
* **Themed Tray Menu:** Right-click the tray icon for a menu that matches your current theme — open/focus, switch Compact ↔ Full, Mute Main, or Quit.
* **Remembers Your Setup:** Restores Compact vs Full mode, your selected compact channel, and window monitor/position on next launch. Compact Mode collapses to the top-right of the console by default (or remembers its own spot — toggle in Settings).
* **Rebindable Hardware Function Button:** Change what the physical **Function button** on your iD MK3 does — map it to **Mute Mics (1 + 2)**, **Mute Mic 1**, **Mute Mic 2**, **Mute Headphones**, **Speakers / Headphones Swap**, **Mid / Side Check**, **Reference Level Recall**, **Global Mute (All Outputs)**, **Bypass Input DSP (A/B)**, or **Toggle Scene 1** (plus all standard Audient hardware functions).
* **Instant Scene Recall:** Only changed parameters are sent to the hardware, so scene swaps are near-instant.

---

## Keyboard Shortcuts
| Shortcut | Action |
| --- | --- |
| `M` | Main Mute |
| `D` | Dim |
| `O` | Mono |
| `T` | Talkback |
| `C` | Toggle Compact / Full Console |
| `Alt+1–4` / `⌥1–4` | Recall / Toggle Saved Scenes 1–4 |
| `Shift + Drag / Scroll` | Fine trim adjustment |

---

## Building From Source

### Prerequisites
* [Rust](https://rustup.rs/) (`stable`)
* Tauri CLI v2: `cargo install tauri-cli --version "^2.0"`

### Windows (PowerShell)
```powershell
.\build-windows.ps1
```
Outputs standalone `id-interface.exe` and NSIS installer in `src-tauri\target\release\`.

### macOS (Apple Silicon & Intel Universal)
```bash
chmod +x build-macos.sh
./build-macos.sh --universal
```
Outputs a Universal `.app` and `.dmg` in `src-tauri/target/universal-apple-darwin/release/bundle/`.
*(First launch on unsigned macOS builds: `xattr -cr "/Applications/iD Interface.app"`)*

---

## Releasing a New Version (maintainers)
1. Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit, then tag and push: `git tag v0.1.1 && git push origin main --tags`
3. GitHub Actions builds Windows + macOS, publishes the Release, and existing users get the update badge automatically.

---

## License & Disclaimer
[MIT](LICENSE). Independent community project — not affiliated with or endorsed by Audient Ltd.

---

## FAQ

**Does iD Interface replace Audient iD Control / Audient Device Manager (ADM)?**
Yes — on both **Windows** and **macOS**, iD Interface runs completely standalone over **Direct USB** without needing `AudientDeviceManager`, `iD Control`, or Apple Bonjour running in the background. (You can still switch to ADM mode in Settings if you prefer.)

**Which Audient audio interfaces are supported?**
iD Interface is built specifically for the 4 **Audient iD MK3** models: **Audient iD1**, **Audient iD2**, **Audient iD2+**, and **Audient iD4+**. Legacy MK1/MK2 models (iD4, iD14, iD24, iD44) use an older protocol and are not supported.

**How do updates work?**
iD Interface checks GitHub Releases automatically and shows an **`UPDATE`** badge when a new version is out. Clicking it downloads, installs, and restarts the app automatically on both Windows and macOS.
