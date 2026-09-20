/**
 * 한 번에 실행하는 런처.
 *
 *   1. 의존성이 없으면 설치한다
 *   2. 앱을 확장 안(collector/app)으로 빌드한다
 *   3. collector 확장을 로드한 브라우저를 띄우고, 앱을 확장 페이지로 연다
 *
 * 앱이 chrome-extension://<id>/app/ 으로 열리기 때문에 chrome.* 를 직접 쓸 수 있고,
 * 대상 사이트 권한 요청도 앱 안에서 처리된다 — 수집 시작까지 앱 한 곳에서 끝난다.
 * 그래서 평소 실행에는 개발 서버가 필요 없다. (확장을 로드할 수 있는 브라우저가
 * 하나도 없을 때만 개발 서버로 물러나 분석 기능이라도 쓸 수 있게 한다.)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadChromeForTesting,
  findInstalledBrowsers,
  launch,
  verifyExtensionLoaded,
} from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = path.join(ROOT, "collector");
const APP_DIR = path.join(EXTENSION_DIR, "app");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const TOOLS_DIR = path.join(ROOT, ".tools");
/** 확장을 실제로 로드해 준 브라우저를 기억해 둔다 — 다음 실행에 프로필을 지키기 위해. */
const CHOICE_FILE = path.join(TOOLS_DIR, "browser.json");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const step = (n, msg) => console.log(`${C.cyan(`[${n}/3]`)} ${msg}`);
const ok = (msg) => console.log(`      ${C.green("✓")} ${msg}`);
const warn = (msg) => console.log(`      ${C.yellow("!")} ${msg}`);

const viteBin = () => path.join(ROOT, "node_modules", "vite", "bin", "vite.js");

/* ------------------------------------------------------------------ */
/* 1. 의존성                                                            */
/* ------------------------------------------------------------------ */

function needsInstall() {
  const modules = path.join(ROOT, "node_modules");
  if (!existsSync(modules)) return true;
  try {
    const marker = path.join(modules, ".package-lock.json");
    if (!existsSync(marker)) return true;
    return statSync(path.join(ROOT, "package.json")).mtimeMs > statSync(marker).mtimeMs;
  } catch {
    return true;
  }
}

function installDeps() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(C.red("\n의존성 설치에 실패했습니다. 위 오류를 확인해 주세요."));
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 앱 빌드 (확장 안으로)                                              */
/* ------------------------------------------------------------------ */

/** 디렉터리(또는 파일) 안에서 가장 최근에 바뀐 시각. 없으면 0. */
function newestMtime(target) {
  try {
    const stat = statSync(target);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let newest = stat.mtimeMs;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
    }
    return newest;
  } catch {
    return 0;
  }
}

/** 소스가 빌드 결과보다 새로우면 다시 빌드한다. 아니면 그냥 쓴다. */
function appIsStale() {
  const built = path.join(APP_DIR, "index.html");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  return [
    path.join(ROOT, "src"),
    path.join(ROOT, "index.html"),
    path.join(ROOT, "vite.config.ts"),
    path.join(ROOT, "package.json"),
  ].some((source) => newestMtime(source) > builtAt);
}

function buildApp() {
  if (!existsSync(viteBin())) {
    console.error(C.red("      vite 를 찾지 못했습니다. 의존성 설치가 끝났는지 확인해 주세요."));
    process.exit(1);
  }
  // 빌드 로그는 성공하면 보여줄 이유가 없다 — 실패했을 때만 그대로 내보낸다.
  const result = spawnSync(process.execPath, [viteBin(), "build"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(C.red("\n앱을 빌드하지 못했습니다:\n"));
    process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}\n`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 브라우저                                                          */
/* ------------------------------------------------------------------ */

const appUrl = (extensionId) => `chrome-extension://${extensionId}/app/index.html`;

/**
 * 확장 등록은 프로필에 바로 쓰이지 않는다 — Edge 는 새 프로필 첫 실행에서
 * 9초쯤 걸렸다. 넉넉히 기다린다. 성공하면 대개 훨씬 빨리 끝난다.
 */
const VERIFY_MS = 30_000;

function readChoice() {
  try {
    const choice = JSON.parse(readFileSync(CHOICE_FILE, "utf8"));
    return choice?.bin && choice?.extensionId ? choice : null;
  } catch {
    return null;
  }
}

function saveChoice(choice) {
  try {
    writeFileSync(CHOICE_FILE, `${JSON.stringify(choice, null, 2)}\n`);
  } catch {
    /* 기억해 두지 못해도 동작에는 지장이 없다 — 다음에 다시 찾으면 된다. */
  }
}

function forgetChoice() {
  rmSync(CHOICE_FILE, { force: true });
}

/**
 * 우리가 띄운 브라우저만 닫는다.
 *
 * 이미지 이름(msedge.exe 등)으로 죽이면 사용자가 열어 둔 창까지 같이 닫힌다 —
 * 후보를 훑는 도중에 그런 일이 벌어지면 안 되므로 spawn 한 프로세스 트리만 끊는다.
 */
function killBrowser(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* 이미 종료됨 */
  }
}

/** 브라우저가 프로필 파일을 놓을 때까지 잠깐 기다렸다 지운다 (Windows 는 잠금이 남는다). */
async function resetProfile() {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await mkdir(PROFILE_DIR, { recursive: true });
}

/**
 * 확장을 로드할 수 있는지 확인하고, 되면 앱 페이지를 연다.
 *
 * 확장 ID 는 미리 알 수 없으므로(언팩 확장은 경로에서 파생된다) 순서가 이렇다.
 *   URL 없이 띄운다 → 프로필을 읽어 등록 여부와 ID 를 확인한다 →
 *   같은 프로필로 한 번 더 호출해 앱 탭을 연다 (이미 떠 있는 창에 탭만 붙는다).
 *
 * 한 번 통과한 브라우저는 기억해 둔다. 다음 실행부터는 프로필을 지우지 않고
 * 곧장 앱 URL 로 띄우므로, 대상 사이트 로그인 세션이 그대로 남는다.
 */
async function openApp() {
  const version = JSON.parse(
    readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"),
  ).version;

  // (a) 지난번에 통과한 브라우저 — 프로필을 지키며 바로 앱을 연다.
  const cached = readChoice();
  if (cached && existsSync(cached.bin)) {
    await mkdir(PROFILE_DIR, { recursive: true });
    const child = launch(cached.bin, {
      profileDir: PROFILE_DIR,
      extensionDir: EXTENSION_DIR,
      url: appUrl(cached.extensionId),
    });
    const result = await verifyExtensionLoaded(PROFILE_DIR, { timeoutMs: VERIFY_MS });
    if (result.loaded) {
      ok(`${cached.name} — collector v${version}`);
      console.log(`      ${C.dim(appUrl(result.id))}`);
      console.log(
        `\n      ${C.dim("지난 실행의 프로필을 그대로 씁니다 — 대상 사이트 로그인이 남아 있습니다.")}`,
      );
      return true;
    }
    warn(`${cached.name} 이 이번에는 확장을 로드하지 못했습니다 — 다시 찾아봅니다.`);
    killBrowser(child);
    forgetChoice();
  }

  // (b) 처음이거나 기억해 둔 브라우저가 실패한 경우 — 후보를 훑는다.
  const candidates = findInstalledBrowsers(TOOLS_DIR);
  candidates.sort((a, b) => Number(b.supportsExtension) - Number(a.supportsExtension));

  for (const browser of candidates) {
    // 확장 등록 여부를 프로필에서 읽어 판정하므로, 후보를 바꿀 때는 새 프로필이어야 한다.
    await resetProfile();
    const child = launch(browser.bin, { profileDir: PROFILE_DIR, extensionDir: EXTENSION_DIR });
    const result = await verifyExtensionLoaded(PROFILE_DIR, { timeoutMs: VERIFY_MS });
    if (result.loaded) {
      saveChoice({ name: browser.name, bin: browser.bin, extensionId: result.id });
      launch(browser.bin, {
        profileDir: PROFILE_DIR,
        extensionDir: EXTENSION_DIR,
        url: appUrl(result.id),
      });
      ok(`${browser.name} — collector v${version} 로드 확인됨`);
      console.log(`      ${C.dim(appUrl(result.id))}`);
      console.log(
        `\n      ${C.dim("전용 프로필입니다. 대상 사이트에 로그인해 두면 다음 실행에도 유지됩니다.")}`,
      );
      return true;
    }
    warn(`${browser.name} 은 확장을 로드하지 않았습니다 (최신 Chrome 은 이 기능을 막았습니다).`);
    killBrowser(child);
  }

  // (c) 하나도 없으면 확장을 확실히 지원하는 Chrome for Testing 을 받아서 쓴다.
  warn("확장을 로드할 수 있는 브라우저가 없어 Chrome for Testing 을 받아옵니다.");
  try {
    const bin = await downloadChromeForTesting(TOOLS_DIR, (m) => console.log(`      ${C.dim(m)}`));
    await resetProfile();
    launch(bin, { profileDir: PROFILE_DIR, extensionDir: EXTENSION_DIR });
    const result = await verifyExtensionLoaded(PROFILE_DIR, { timeoutMs: VERIFY_MS + 15000 });
    if (result.loaded) {
      saveChoice({ name: "Chrome for Testing", bin, extensionId: result.id });
      launch(bin, {
        profileDir: PROFILE_DIR,
        extensionDir: EXTENSION_DIR,
        url: appUrl(result.id),
      });
      ok(`Chrome for Testing — collector v${version} 로드 확인됨`);
      console.log(`      ${C.dim(appUrl(result.id))}`);
      return true;
    }
    warn("Chrome for Testing 에서도 확인하지 못했습니다.");
  } catch (err) {
    warn(`Chrome for Testing 준비 실패: ${err.message}`);
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* 물러나기 — 확장 없이 개발 서버로                                        */
/* ------------------------------------------------------------------ */

/** vite 는 출력에 ANSI 색상 코드를 섞는다. URL 을 읽기 전에 반드시 걷어내야 한다. */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function startServer() {
  // npm 을 거치지 않고 vite 를 직접 띄운다 — 셸이 필요 없어 종료 제어가 확실하다.
  if (!existsSync(viteBin())) {
    return Promise.reject(new Error("vite 를 찾지 못했습니다."));
  }

  const child = spawn(process.execPath, [viteBin()], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      resolve({ child, url });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error("개발 서버가 60초 안에 뜨지 않았습니다.")),
      60_000,
    );

    const scan = (chunk) => {
      buffer += stripAnsi(chunk.toString());
      const match = buffer.match(/Local:\s*(https?:\/\/[^\s/]+)/);
      if (match) finish(match[1]);
    };

    // 출력 형식이 바뀌어도 멈추지 않도록 기본 포트도 함께 두드려 본다.
    const poller = setInterval(() => {
      void probe("http://localhost:5173/").then((up) => {
        if (up) finish("http://localhost:5173");
      });
    }, 1000);

    child.stdout.on("data", scan);
    child.stderr.on("data", (c) => {
      scan(c);
      process.stderr.write(C.dim(c.toString()));
    });
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`개발 서버가 코드 ${code} 로 종료됐습니다.`)));
  });
}

/**
 * 확장을 아무 브라우저도 로드해 주지 않은 경우. 개발 서버로 앱만이라도 띄운다.
 * 수집기는 못 쓰지만 나머지 분석·프롬프트 기능은 전부 그대로 동작한다.
 */
async function fallbackToDevServer() {
  let server;
  try {
    server = await startServer();
  } catch (err) {
    console.error(C.red(`      개발 서버도 띄우지 못했습니다: ${err.message}`));
    process.exit(1);
  }

  const [browser] = findInstalledBrowsers(TOOLS_DIR);
  if (browser) {
    await mkdir(PROFILE_DIR, { recursive: true });
    launch(browser.bin, {
      profileDir: PROFILE_DIR,
      extensionDir: EXTENSION_DIR,
      url: server.url,
    });
  }

  console.log(
    `\n      ${C.bold(server.url)} 을 열었습니다. 수집기 없이도 분석 기능은 모두 씁니다.` +
      `\n      수집기가 필요하면 브라우저의 확장 관리 페이지 → 개발자 모드 →` +
      `\n      "압축해제된 확장 프로그램을 로드" → ${C.dim(EXTENSION_DIR)}` +
      `\n      로드한 뒤 확장 팝업의 "앱 열기" 를 누르면 확장 안의 앱으로 넘어갑니다.\n`,
  );
  console.log(`${C.green("준비 완료.")} ${C.dim("이 창을 닫거나 Ctrl+C 를 누르면 서버가 멈춥니다.")}\n`);

  const shutdown = () => {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        server.child.kill("SIGTERM");
      }
    } catch {
      /* 이미 종료됨 */
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.child.on("exit", () => process.exit(0));
  server.child.stdout.on("data", (c) => process.stdout.write(C.dim(c.toString())));
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`\n${C.bold("web-extractor")} ${C.dim("실행 준비")}\n`);

  step(1, "의존성 확인");
  if (needsInstall()) {
    warn("패키지를 설치합니다. 처음 한 번은 1~2분 걸립니다…");
    installDeps();
    ok("설치 완료");
  } else {
    ok("이미 설치되어 있습니다");
  }

  step(2, "앱 빌드 (확장 안으로)");
  if (appIsStale()) {
    warn("바뀐 소스가 있어 다시 빌드합니다…");
    buildApp();
    ok(path.relative(ROOT, APP_DIR));
  } else {
    ok("이미 최신입니다");
  }

  step(3, "확장을 로드한 브라우저 실행");
  if (await openApp()) {
    console.log(
      `\n${C.green("준비 완료.")} ` +
        `${C.dim("앱은 브라우저에서 계속 돕니다 — 이 창은 닫아도 됩니다.")}\n`,
    );
    return;
  }

  await fallbackToDevServer();
}

main().catch((err) => {
  console.error(C.red(`\n예상치 못한 오류: ${err.stack ?? err}`));
  process.exit(1);
});
