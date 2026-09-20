/**
 * 확장을 로드한 채로 띄울 수 있는 브라우저를 찾고, 없으면 받아온다.
 *
 * 배경: Chrome 136 부터 `--load-extension` 이 기본 차단됐고, 153 에서는 우회 플래그
 * (`DisableLoadExtensionCommandLineSwitch`) 마저 사라져 아예 먹히지 않는다.
 * Edge 는 아직 허용하고, Chrome for Testing 도 허용한다. 그래서 순서는
 *
 *   이미 받아둔 Chrome for Testing → Edge → Chrome → Chromium
 *
 * 이고, 실제로 로드됐는지는 프로필을 읽어 확인한다. 확인에 실패하면
 * Chrome for Testing 을 받아서 다시 시도한다.
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const CFT_VERSIONS_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

function cftPlatform() {
  if (process.platform === "win32") return process.arch === "ia32" ? "win32" : "win64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "linux") return "linux64";
  return null;
}

/* ------------------------------------------------------------------ */
/* 설치된 브라우저 찾기                                                  */
/* ------------------------------------------------------------------ */

export function findInstalledBrowsers(toolsDir) {
  const found = [];

  // 이미 받아둔 Chrome for Testing 이 있으면 최우선.
  const cft = cftBinary(toolsDir);
  if (cft && existsSync(cft)) {
    found.push({ name: "Chrome for Testing", bin: cft, supportsExtension: true });
  }

  if (process.platform === "win32") {
    const roots = [
      process.env["PROGRAMFILES(X86)"],
      process.env["PROGRAMFILES"],
      process.env["LOCALAPPDATA"],
    ].filter(Boolean);
    for (const root of roots) {
      push(found, "Edge", path.join(root, "Microsoft/Edge/Application/msedge.exe"), true);
    }
    for (const root of roots) {
      push(found, "Chrome", path.join(root, "Google/Chrome/Application/chrome.exe"), false);
    }
  } else if (process.platform === "darwin") {
    push(found, "Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", true);
    push(found, "Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium", true);
    push(found, "Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", false);
  } else {
    for (const [name, bin, ok] of [
      ["Edge", "microsoft-edge", true],
      ["Chromium", "chromium", true],
      ["Chromium", "chromium-browser", true],
      ["Chrome", "google-chrome", false],
      ["Chrome", "google-chrome-stable", false],
    ]) {
      const which = spawnSync("which", [bin], { encoding: "utf8" });
      if (which.status === 0) {
        found.push({ name, bin: which.stdout.trim(), supportsExtension: ok });
      }
    }
  }

  return found;
}

function push(list, name, bin, supportsExtension) {
  if (existsSync(bin) && !list.some((b) => b.bin === bin)) {
    list.push({ name, bin, supportsExtension });
  }
}

/* ------------------------------------------------------------------ */
/* Chrome for Testing 내려받기                                          */
/* ------------------------------------------------------------------ */

function cftDir(toolsDir) {
  const platform = cftPlatform();
  return platform ? path.join(toolsDir, "chrome-for-testing", platform) : null;
}

function cftBinary(toolsDir) {
  const dir = cftDir(toolsDir);
  if (!dir) return null;
  const platform = cftPlatform();
  const base = path.join(dir, `chrome-${platform}`);
  if (process.platform === "win32") return path.join(base, "chrome.exe");
  if (process.platform === "darwin") {
    return path.join(base, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  }
  return path.join(base, "chrome");
}

function unzip(zipPath, destDir) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: "ignore" },
    );
    return result.status === 0;
  }
  // macOS·Linux 는 unzip 이 대개 있고, 없으면 bsdtar 가 zip 을 읽는다.
  let result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: "ignore" });
  if (result.status === 0) return true;
  result = spawnSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "ignore" });
  return result.status === 0;
}

/** Chrome for Testing 을 .tools 안에 받는다. 시스템에는 설치하지 않는다. */
export async function downloadChromeForTesting(toolsDir, log = () => {}) {
  const platform = cftPlatform();
  if (!platform) throw new Error(`지원하지 않는 플랫폼입니다: ${process.platform}/${process.arch}`);

  const existing = cftBinary(toolsDir);
  if (existing && existsSync(existing)) return existing;

  log("버전 목록 확인 중…");
  const res = await fetch(CFT_VERSIONS_URL);
  if (!res.ok) throw new Error(`버전 목록을 받지 못했습니다 (HTTP ${res.status})`);
  const data = await res.json();

  const stable = data?.channels?.Stable;
  const entry = stable?.downloads?.chrome?.find((d) => d.platform === platform);
  if (!entry) throw new Error(`${platform} 용 빌드를 찾지 못했습니다.`);

  const dir = cftDir(toolsDir);
  await mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, "chrome.zip");

  log(`Chrome for Testing ${stable.version} 내려받는 중… (약 150MB, 처음 한 번)`);
  const download = await fetch(entry.url);
  if (!download.ok || !download.body) {
    throw new Error(`내려받기 실패 (HTTP ${download.status})`);
  }
  await pipeline(Readable.fromWeb(download.body), createWriteStream(zipPath));

  log("압축 푸는 중…");
  if (!unzip(zipPath, dir)) throw new Error("압축을 풀지 못했습니다.");
  rmSync(zipPath, { force: true });

  const bin = cftBinary(toolsDir);
  if (!bin || !existsSync(bin)) throw new Error(`실행 파일을 찾지 못했습니다: ${bin}`);
  if (process.platform !== "win32") spawnSync("chmod", ["+x", bin], { stdio: "ignore" });
  return bin;
}

/* ------------------------------------------------------------------ */
/* 실행 & 검증                                                          */
/* ------------------------------------------------------------------ */

export function launch(browserBin, { profileDir, extensionDir, url }) {
  const args = [
    // 전용 프로필. 기존 창과 충돌하지 않고, 로그인 세션은 다음 실행에도 남는다.
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    // 구버전 Chrome/Edge 에서 차단을 푸는 플래그. 모르는 빌드에서는 무시된다.
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // url 을 주지 않으면 새 탭 페이지로 뜬다. 같은 프로필로 다시 호출하면
    // 이미 떠 있는 창에 탭만 하나 더 열린다 — 확장 ID 를 확인한 뒤 앱을 여는 데 쓴다.
    ...(url ? [url] : []),
  ];
  const child = spawn(browserBin, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

/**
 * 확장이 실제로 등록됐는지 프로필을 읽어 확인한다.
 * 플래그를 받아들이는 척하고 무시하는 빌드가 있어서, 띄운 것만으로는 알 수 없다.
 */
export async function verifyExtensionLoaded(profileDir, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const files = [
    path.join(profileDir, "Default", "Secure Preferences"),
    path.join(profileDir, "Default", "Preferences"),
  ];

  while (Date.now() < deadline) {
    for (const file of files) {
      if (!existsSync(file)) continue;
      try {
        const prefs = JSON.parse(readFileSync(file, "utf8"));
        const settings = prefs?.extensions?.settings ?? {};
        for (const [id, value] of Object.entries(settings)) {
          const fromPath = String(value?.path ?? "");
          const name = String(value?.manifest?.name ?? "");
          // location 8 = COMMAND_LINE (명령줄로 로드된 언팩 확장)
          if (fromPath.includes("collector") || name.includes("web-extractor") || value?.location === 8) {
            if (value?.location === 8 || fromPath.includes("collector")) return { loaded: true, id };
          }
        }
      } catch {
        /* Chrome 이 쓰는 도중이면 파싱이 깨질 수 있다 — 다시 시도한다. */
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { loaded: false, id: null };
}
