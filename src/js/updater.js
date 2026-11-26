// Lightweight GitHub Releases update checker (cross-platform Windows & macOS)
// Tag releases as v0.1.1, v0.2.0, etc. — GitHub Actions builds & attaches installers automatically.

export const GITHUB_REPO = "1ps3/iD-Interface";

function parseSemver(v) {
  const clean = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
  const parts = clean.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

export function isNewerVersion(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function pickAssetUrls(release, isMac) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const releaseUrl = release?.html_url || "";
  if (isMac) {
    const dmg = assets.find((a) => /\.dmg$/i.test(a.name || ""));
    return {
      downloadUrl: dmg?.browser_download_url || releaseUrl,
      portableUrl: "",
      setupUrl: "",
    };
  }
  const isLinux = /linux/i.test(navigator?.platform || navigator?.userAgent || "");
  if (isLinux) {
    const appimage = assets.find((a) => /\.AppImage$/i.test(a.name || ""));
    const deb = assets.find((a) => /\.deb$/i.test(a.name || ""));
    return {
      downloadUrl: appimage?.browser_download_url || deb?.browser_download_url || releaseUrl,
      portableUrl: "",
      setupUrl: "",
    };
  }
  const setup = assets.find((a) => /setup\.exe$/i.test(a.name || ""));
  const portable = assets.find(
    (a) => /\.exe$/i.test(a.name || "") && !/setup\.exe$/i.test(a.name || "")
  );
  return {
    downloadUrl: setup?.browser_download_url || portable?.browser_download_url || releaseUrl,
    portableUrl: portable?.browser_download_url || "",
    setupUrl: setup?.browser_download_url || "",
  };
}

export async function checkForGithubUpdate(currentVersion, isMac = false, repoOverride = "") {
  const repo = (repoOverride || GITHUB_REPO || "").trim();
  if (!repo || !repo.includes("/")) {
    return {
      status: "unconfigured",
      currentVersion,
      message: `v${currentVersion} · Set GITHUB_REPO in updater.js after publishing to GitHub`,
    };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (res.status === 404) {
      return {
        status: "up_to_date",
        currentVersion,
        latestVersion: currentVersion,
        message: `v${currentVersion} · No GitHub releases published yet`,
      };
    }
    if (!res.ok) {
      return {
        status: "error",
        currentVersion,
        message: `Update check failed (HTTP ${res.status})`,
      };
    }
    const rel = await res.json();
    const tag = String(rel.tag_name || "").replace(/^v/i, "");
    const { downloadUrl, portableUrl, setupUrl } = pickAssetUrls(rel, isMac);
    const releaseUrl = rel.html_url || `https://github.com/${repo}/releases/latest`;
    if (tag && isNewerVersion(tag, currentVersion)) {
      return {
        status: "available",
        currentVersion,
        latestVersion: tag,
        downloadUrl: downloadUrl || releaseUrl,
        portableUrl,
        setupUrl,
        releaseUrl,
        notes: rel.name || `v${tag}`,
        message: `Update available: v${tag} (current v${currentVersion})`,
      };
    }
    return {
      status: "up_to_date",
      currentVersion,
      latestVersion: tag || currentVersion,
      releaseUrl,
      message: `Up to date (v${currentVersion})`,
    };
  } catch {
    return {
      status: "error",
      currentVersion,
      message: "Offline or unable to reach GitHub Releases",
    };
  }
}
