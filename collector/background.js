/**
 * 서비스 워커. 수집 상태를 들고 있으면서 탭을 한 칸씩 이동시킨다.
 *
 * 순회 규칙 (안전상 중요):
 *   - <a href> 로 발견한 URL 만 방문한다. GET 뿐이다.
 *   - 버튼을 누르거나 폼을 제출하지 않는다. 따라서 삭제·결제 같은
 *     되돌릴 수 없는 동작을 우발적으로 실행할 수 없다.
 *   - 한 번에 한 페이지만, 설정한 간격을 지켜서 이동한다.
 */

const DEFAULTS = {
  seed: "",
  include: [],
  exclude: [],
  sameOriginOnly: true,
  // 40 은 너무 얕았다 — 중간 규모 사이트도 4분의 1만 훑고 끝났다.
  maxPages: 200,
  maxDepth: 3,
  delayMs: 1500,
  maskSecrets: true,
  captureHtml: true,
  respectRobots: true,
  /** CSS·JS·폰트 본문까지 받아 온다. 이게 없으면 재현해도 겉모습이 전혀 달라진다. */
  captureAssets: true,
  /** 이미지까지 받는다. 용량이 크게 늘어 기본은 꺼 둔다. */
  captureImages: false,
  /** 페이지마다 보이는 화면을 JPEG 으로 한 장 찍는다 (UI 재구성의 시각 기준). */
  captureScreenshots: true,
};

/** @type {null | object} */
let state = null;
let saveTimer = null;
/** 조각으로 내보내는 중인 결과. 다 보내면 버린다. */
let exportCache = null;

/* ------------------------------ 저장 ------------------------------ */

async function loadState() {
  if (state) return state;
  const stored = await chrome.storage.local.get("state");
  state = stored.state ?? null;
  return state;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (state) await chrome.storage.local.set({ state });
  }, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (state) await chrome.storage.local.set({ state });
}

/* ---------------------------- 범위 판정 ---------------------------- */

/** `*` 와 `**` 를 지원하는 최소 글롭. 그 외 정규식 메타문자는 이스케이프한다. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  // `**` 는 경로 구분자를 넘어서 매칭하고, `*` 는 한 세그먼트 안에서만 매칭한다.
  const body = escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${body}$`);
}

function inScope(url, cfg) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  if (cfg.sameOriginOnly) {
    try {
      if (parsed.origin !== new URL(cfg.seed).origin) return false;
    } catch {
      return false;
    }
  }
  for (const pattern of cfg.exclude) {
    if (!pattern.trim()) continue;
    if (globToRegExp(pattern.trim()).test(url)) return false;
  }
  if (cfg.include.length === 0) return true;
  return cfg.include.some((p) => p.trim() && globToRegExp(p.trim()).test(url));
}

/* ---------------------------- robots.txt ---------------------------- */

/**
 * 우리 순회는 사용자의 브라우저에서 사용자 속도로 도는 것이지만,
 * 사이트 운영자가 명시적으로 막아둔 경로는 존중한다.
 */
async function fetchRobots(origin) {
  try {
    const res = await fetch(`${origin}/robots.txt`, { credentials: "omit" });
    if (!res.ok) return { rules: [], crawlDelay: null, fetched: false };
    return parseRobots(await res.text());
  } catch {
    return { rules: [], crawlDelay: null, fetched: false };
  }
}

function parseRobots(text) {
  const rules = [];
  let crawlDelay = null;
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      applies = value === "*";
    } else if (applies && (field === "allow" || field === "disallow")) {
      if (value) rules.push({ allow: field === "allow", path: value });
    } else if (applies && field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) crawlDelay = n * 1000;
    }
  }
  return { rules, crawlDelay, fetched: true };
}

function robotsAllows(robots, url) {
  if (!robots?.fetched || !robots.rules.length) return true;
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  // 가장 긴 매칭 규칙이 이긴다 (표준 동작).
  let best = null;
  for (const rule of robots.rules) {
    const prefix = rule.path.replace(/\*$/, "");
    if (path.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

/* ---------------------------- 수집 시작 ---------------------------- */

async function start(config, tabId, manual = false) {
  const cfg = { ...DEFAULTS, ...config };
  const robots = cfg.respectRobots ? await fetchRobots(new URL(cfg.seed).origin) : null;
  if (robots?.crawlDelay && robots.crawlDelay > cfg.delayMs) {
    cfg.delayMs = robots.crawlDelay; // 사이트가 요구한 간격이 더 느리면 그걸 따른다.
  }

  state = {
    running: true,
    manual,
    // "crawl" → "assets" → 완료. UI 가 지금 무엇을 하는 중인지 보여준다.
    phase: "crawl",
    startedAt: Date.now(),
    finishedAt: null,
    config: cfg,
    robots,
    tabId,
    queue: manual ? [] : [{ url: cfg.seed, depth: 0 }],
    visited: [],
    pending: null,
    pages: [],
    net: [],
    skipped: [],
    assets: [],
    assetSkipped: [],
    debuggerTabId: null,
    log: [],
  };

  await registerScripts(cfg.seed);
  await saveNow();

  if (manual) {
    // 자동으로 이동하지 않는다. 사용자가 직접 눌러 다니는 화면을 그대로 받아 적는다.
    note("수동 탐색 모드 — 직접 클릭하며 돌아다니세요. 보이는 화면과 요청을 모두 기록합니다.");
    try {
      await chrome.tabs.update(tabId, { url: cfg.seed });
    } catch {
      note("시작 URL 을 여는 데 실패했습니다 — 직접 주소를 입력해 주세요.");
    }
    return;
  }

  await step();
}

/** 범위에 해당하는 오리진에만 스크립트를 등록한다. 전역 주입은 하지 않는다. */
async function registerScripts(seed) {
  const origin = `${new URL(seed).origin}/*`;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["wx-hook", "wx-bridge"] });
  } catch {
    /* 등록된 게 없으면 무시 */
  }
  await chrome.scripting.registerContentScripts([
    {
      id: "wx-hook",
      matches: [origin],
      js: ["hook.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
    },
    {
      id: "wx-bridge",
      matches: [origin],
      js: ["bridge.js"],
      runAt: "document_start",
      world: "ISOLATED",
      allFrames: false,
    },
  ]);
}

async function unregisterScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["wx-hook", "wx-bridge"] });
  } catch {
    /* 무시 */
  }
}

/** 링크로 발견한 범위 안 URL 의 개수 — 방문 수와 비교하면 커버리지가 보인다. */
function discoveredCount() {
  if (!state) return 0;
  const found = new Set(state.visited);
  for (const page of state.pages) {
    for (const link of page.links ?? []) {
      if (inScope(link.url, state.config)) found.add(link.url);
    }
  }
  return found.size;
}

function note(message) {
  if (!state) return;
  state.log.push({ at: Date.now(), message });
  if (state.log.length > 300) state.log.shift();
}

/* ---------------------------- 한 칸 이동 ---------------------------- */

async function step() {
  if (!state?.running) return;
  const { config: cfg } = state;

  if (state.visited.length >= cfg.maxPages) {
    note(`최대 페이지 수(${cfg.maxPages}) 도달 — 종료합니다.`);
    return finish();
  }

  let next = null;
  while (state.queue.length) {
    const candidate = state.queue.shift();
    if (state.visited.includes(candidate.url)) continue;
    if (!inScope(candidate.url, cfg)) {
      state.skipped.push({ url: candidate.url, reason: "범위 밖" });
      continue;
    }
    if (state.robots && !robotsAllows(state.robots, candidate.url)) {
      state.skipped.push({ url: candidate.url, reason: "robots.txt 차단" });
      continue;
    }
    next = candidate;
    break;
  }

  if (!next) {
    note("더 방문할 URL 이 없습니다 — 종료합니다.");
    return finish();
  }

  state.pending = next;
  state.visited.push(next.url);
  note(`이동: ${next.url} (깊이 ${next.depth})`);
  scheduleSave();

  try {
    await chrome.tabs.update(state.tabId, { url: next.url });
  } catch {
    note("탭을 찾을 수 없습니다 — 종료합니다.");
    return finish();
  }

  // 페이지가 스냅샷을 못 보내고 멈추는 경우를 대비한 안전장치.
  clearTimeout(globalThis.__wxWatchdog);
  globalThis.__wxWatchdog = setTimeout(() => {
    if (state?.running && state.pending?.url === next.url) {
      note(`응답 없음, 건너뜀: ${next.url}`);
      state.pending = null;
      setTimeout(step, state.config.delayMs);
    }
  }, 25000);
}

async function finish() {
  if (!state || state.finishing) return;
  state.finishing = true;
  state.pending = null;
  clearTimeout(globalThis.__wxWatchdog);
  await unregisterScripts();
  await detachDebugger();

  // 순회가 끝난 뒤에 정적 리소스를 받는다 — 페이지 이동 속도를 건드리지 않기 위해.
  if (state.config.captureAssets || state.config.captureImages) {
    state.phase = "assets";
    await saveNow();
    await harvestAssets();
  }

  if (!state) return;
  state.phase = "done";
  state.running = false;
  state.finishing = false;
  state.finishedAt = Date.now();
  await saveNow();
}

/* ------------------------ 정적 리소스 본문 받기 ------------------------ */

/**
 * HTML 만으로는 화면을 되살릴 수 없다. `<link>`·`<img>`·폰트는 페이지가 직접 받기 때문에
 * fetch/XHR 후킹에 걸리지 않아서, 캡처에 스타일이 통째로 빠져 있었다.
 * 그래서 순회가 끝난 뒤 수집한 리소스 URL 을 확장이 다시 한 번 받아 둔다.
 *
 * 권한이 있는 오리진(=수집한 사이트)만 받는다. 외부 CDN 은 권한 밖이라 URL 만 남긴다.
 */
const ASSET_LIMITS = {
  maxCount: 600,
  maxBytesEach: 2 * 1024 * 1024,
  maxBytesTotal: 40 * 1024 * 1024,
  concurrency: 2,
  gapMs: 120,
};

function assetKind(url, contentType) {
  const ct = (contentType || "").toLowerCase();
  const path = String(url).split("?")[0].toLowerCase();
  if (ct.includes("css") || path.endsWith(".css")) return "css";
  if (ct.includes("javascript") || path.endsWith(".js") || path.endsWith(".mjs")) return "js";
  if (ct.startsWith("font/") || /\.(woff2?|ttf|otf|eot)$/.test(path)) return "font";
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp|ico|avif)$/.test(path)) return "image";
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) return "text";
  return "other";
}

function wantsAsset(kind, cfg) {
  if (kind === "image" || kind === "font") return !!cfg.captureImages || kind === "font";
  return kind === "css" || kind === "js" || kind === "text";
}

/** 바이너리를 base64 로. 큰 배열을 한 번에 넘기면 스택이 넘치므로 나눠서 돌린다. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** `?v=20260920` 같은 캐시버스터만 다른 URL 은 같은 파일이다. 세 번 받지 않는다. */
const BUSTER_KEYS = new Set(["v", "ver", "version", "t", "ts", "_", "rev", "r", "hash", "cb"]);

function assetKey(url) {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()];
    if (keys.length > 0 && keys.every((k) => BUSTER_KEYS.has(k.toLowerCase()))) {
      return u.origin + u.pathname;
    }
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

/** 이 오리진을 받아올 권한이 있는가. 같은 판정을 반복하지 않도록 캐시한다. */
const originPermission = new Map();
async function canFetchOrigin(origin) {
  if (originPermission.has(origin)) return originPermission.get(origin);
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    allowed = false;
  }
  originPermission.set(origin, allowed);
  return allowed;
}

async function harvestAssets() {
  const cfg = state.config;

  // 방문한 페이지들이 실제로 불러온 리소스 목록. 캐시버스터만 다른 것은 하나로 접는다.
  const already = new Set(state.assets.map((a) => assetKey(a.url)));
  const wanted = new Map();
  for (const page of state.pages) {
    for (const res of page.resources ?? []) {
      const url = res.url;
      if (!url) continue;
      const key = assetKey(url);
      if (already.has(key) || wanted.has(key)) continue;
      const kind = assetKind(url, "");
      if (!wantsAsset(kind, cfg)) continue;
      wanted.set(key, url);
    }
  }

  // 권한이 있는 오리진만 받는다. 나머지는 URL 과 이유만 남긴다.
  state.assetSkipped = [];
  const list = [];
  for (const url of wanted.values()) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    if (await canFetchOrigin(origin)) list.push(url);
    else state.assetSkipped.push({ url, reason: "권한 밖 오리진 (URL 만 기록)" });
  }

  const capped = list.slice(0, ASSET_LIMITS.maxCount);
  if (list.length > capped.length) {
    note(`정적 리소스 ${list.length}개 중 상한 ${ASSET_LIMITS.maxCount}개만 받습니다.`);
  }
  if (capped.length === 0) return;

  note(`정적 리소스 ${capped.length}개를 받습니다…`);
  let total = state.assets.reduce((sum, a) => sum + a.bytes, 0);
  let index = 0;

  const worker = async () => {
    while (index < capped.length) {
      const url = capped[index++];
      if (!state?.running || state.cancelAssets) return;
      if (total >= ASSET_LIMITS.maxBytesTotal) {
        state.assetSkipped.push({ url, reason: "전체 용량 상한 초과" });
        continue;
      }
      try {
        const res = await fetch(url, { credentials: "include" });
        const contentType = res.headers.get("content-type") ?? "";
        const kind = assetKind(url, contentType);
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > ASSET_LIMITS.maxBytesEach) {
          state.assetSkipped.push({ url, reason: `파일이 너무 큼 (${buffer.byteLength}B)` });
          continue;
        }
        total += buffer.byteLength;
        const isText = kind === "css" || kind === "js" || kind === "text";
        state.assets.push({
          url,
          kind,
          status: res.status,
          contentType,
          bytes: buffer.byteLength,
          encoding: isText ? "text" : "base64",
          body: isText ? new TextDecoder().decode(buffer) : toBase64(buffer),
        });
      } catch (err) {
        state.assetSkipped.push({ url, reason: String(err?.message ?? err) });
      }
      if (state.assets.length % 25 === 0) {
        note(`정적 리소스 ${state.assets.length}/${capped.length}`);
        scheduleSave();
      }
      await new Promise((r) => setTimeout(r, ASSET_LIMITS.gapMs));
    }
  };

  await Promise.all(Array.from({ length: ASSET_LIMITS.concurrency }, worker));
  note(
    `정적 리소스 완료 — 받음 ${state.assets.length}개 / 건너뜀 ${state.assetSkipped.length}개 ` +
      `(${(total / 1024 / 1024).toFixed(1)}MB)`,
  );
  await saveNow();
}

/* ------------------------------ 스크린샷 ------------------------------ */

/**
 * 화면을 찍는다. HTML 구조만으로는 "같은 화면인지" 판정할 기준이 없어서, UI 재구성
 * 프롬프트에 넣을 시각 기준이 필요하다.
 *
 * `chrome.tabs.captureVisibleTab` 은 <all_urls> 권한을 요구한다 — 이 확장이 오리진 단위
 * 권한만 받는다는 원칙과 맞지 않는다. 그래서 디버거 프로토콜로 찍는다. 덤으로
 * **접힌 부분까지 페이지 전체**가 나오고, 활성 탭이 아니어도 찍힌다.
 *
 * 대신 수집 탭 위에 "디버깅하고 있습니다" 알림 바가 뜬다. 숨길 수 없고, 숨겨서도 안 된다.
 */
const DEBUGGER_VERSION = "1.3";
/** 세로로 긴 페이지를 통째로 찍으면 수십 MB 가 된다. 이 높이에서 자른다. */
const MAX_SHOT_HEIGHT = 8000;

async function attachDebugger(tabId) {
  if (!state?.config.captureScreenshots) return false;
  if (state.debuggerTabId === tabId) return true;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    state.debuggerTabId = tabId;
    return true;
  } catch (err) {
    const message = String(err?.message ?? err);
    // 이미 붙어 있으면 그대로 쓴다.
    if (message.includes("Another debugger") || message.includes("already attached")) {
      state.debuggerTabId = tabId;
      return true;
    }
    note(`화면 캡처를 붙이지 못했습니다: ${message}`);
    state.config.captureScreenshots = false;
    return false;
  }
}

async function detachDebugger() {
  const tabId = state?.debuggerTabId;
  if (!tabId) return;
  state.debuggerTabId = null;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 탭이 이미 닫혔을 수 있다 */
  }
}

async function captureScreen(tabId) {
  if (!state?.config.captureScreenshots) return null;
  if (!(await attachDebugger(tabId))) return null;
  try {
    const metrics = await chrome.debugger.sendCommand(
      { tabId },
      "Page.getLayoutMetrics",
      {},
    );
    const size = metrics?.cssContentSize ?? metrics?.contentSize ?? null;
    const clip = size
      ? {
          x: 0,
          y: 0,
          width: Math.min(Math.round(size.width), 2000),
          height: Math.min(Math.round(size.height), MAX_SHOT_HEIGHT),
          scale: 1,
        }
      : undefined;

    const shot = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    });
    return shot?.data ? `data:image/jpeg;base64,${shot.data}` : null;
  } catch (err) {
    note(`화면 캡처 실패: ${String(err?.message ?? err)}`);
    return null;
  }
}

/* ---------------------------- 메시지 처리 ---------------------------- */

/** 확장 내부(앱 페이지·팝업·콘텐츠 스크립트)에서 온 메시지를 처리한다. */
async function handleMessage(msg, sender, sendResponse) {
  {
    await loadState();

    switch (msg?.type) {
      case "start": {
        await start(msg.config, msg.tabId, !!msg.manual);
        sendResponse({ ok: true });
        return;
      }
      case "stop": {
        if (state) {
          if (state.phase === "assets") {
            state.cancelAssets = true;
            note("정적 리소스 받기를 중단했습니다.");
          } else {
            note("사용자가 중단했습니다.");
            // 정적 리소스 받기가 길어질 수 있으므로 응답을 붙잡지 않는다.
            void finish();
          }
        }
        sendResponse({ ok: true });
        return;
      }
      case "status": {
        sendResponse({
          ok: true,
          status: state
            ? {
                running: state.running,
                manual: !!state.manual,
                phase: state.phase ?? "crawl",
                visited: state.visited.length,
                queued: state.queue.length,
                discovered: discoveredCount(),
                pages: state.pages.length,
                net: state.net.length,
                skipped: state.skipped.length,
                assets: state.assets?.length ?? 0,
                shots: state.pages.filter((p) => p.screenshot).length,
                maxPages: state.config.maxPages,
                seed: state.config.seed,
                startedAt: state.startedAt,
                finishedAt: state.finishedAt,
                log: state.log.slice(-12),
              }
            : null,
        });
        return;
      }
      case "assets-more": {
        // 사용자가 외부 CDN 오리진 권한을 새로 허용한 뒤 호출한다.
        if (!state) {
          sendResponse({ ok: false, reason: "수집 기록이 없습니다." });
          return;
        }
        if (state.phase === "assets") {
          sendResponse({ ok: false, reason: "이미 받는 중입니다." });
          return;
        }
        originPermission.clear();
        state.phase = "assets";
        state.running = true;
        state.cancelAssets = false;
        void (async () => {
          await harvestAssets();
          if (!state) return;
          state.phase = "done";
          state.running = false;
          state.finishedAt = Date.now();
          await saveNow();
        })();
        sendResponse({ ok: true });
        return;
      }
      case "export": {
        sendResponse({ ok: true, bundle: state ? buildBundle(state) : null });
        return;
      }
      case "export-begin": {
        // 배포된 앱은 메시지 하나로 수십 MB 를 받기 어렵다 — 만들어 두고 조각으로 준다.
        if (!state) {
          sendResponse({ ok: false, error: "수집 기록이 없습니다." });
          return;
        }
        const json = JSON.stringify(buildBundle(state));
        exportCache = { id: `x${Date.now()}`, json };
        sendResponse({ ok: true, id: exportCache.id, length: json.length });
        return;
      }
      case "export-chunk": {
        if (!exportCache || exportCache.id !== msg.id) {
          sendResponse({ ok: false, error: "전송이 만료됐습니다. 다시 가져와 주세요." });
          return;
        }
        const start = Number(msg.start) || 0;
        const size = Number(msg.size) || 1_000_000;
        sendResponse({ ok: true, text: exportCache.json.slice(start, start + size) });
        return;
      }
      case "export-end": {
        exportCache = null;
        sendResponse({ ok: true });
        return;
      }
      case "reset": {
        await detachDebugger();
        state = null;
        await chrome.storage.local.remove("state");
        await unregisterScripts();
        sendResponse({ ok: true });
        return;
      }
      case "ready": {
        // 새 문서가 뜨면 마스킹 설정을 내려준다.
        // 수동 탐색 모드에서는 사용자가 아무 탭에서나 돌아다니므로 탭을 가리지 않는다.
        if (state && (state.manual || sender.tab?.id === state.tabId)) {
          chrome.tabs
            .sendMessage(sender.tab.id, {
              type: "config",
              config: { maskSecrets: state.config.maskSecrets },
            })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        return;
      }
      case "net-batch": {
        if (state?.running) {
          for (const record of msg.records) state.net.push(record);
          scheduleSave();
        }
        sendResponse({ ok: true });
        return;
      }
      case "page": {
        if (state?.running) {
          const page = { ...msg };
          delete page.type;
          if (!state.config.captureHtml) {
            page.html = null;
          }
          page.depth = state.pending?.depth ?? 0;
          state.pages.push(page);

          if (state.manual) {
            // 사용자가 직접 연 화면이다. 큐에 넣지 않고 방문 기록에만 남긴다.
            if (!state.visited.includes(page.url)) state.visited.push(page.url);
            note(`기록: ${page.url}`);
          } else {
            // 발견한 링크를 큐에 넣는다. 깊이 제한을 넘으면 넣지 않는다.
            const depth = page.depth + 1;
            if (depth <= state.config.maxDepth) {
              for (const link of page.links ?? []) {
                if (state.visited.includes(link.url)) continue;
                if (state.queue.some((q) => q.url === link.url)) continue;
                if (!inScope(link.url, state.config)) continue;
                state.queue.push({ url: link.url, depth });
              }
            }
          }
          scheduleSave();
        }
        sendResponse({ ok: true });
        return;
      }
      case "page-done": {
        if (state?.running) {
          const tabId = sender.tab?.id ?? state.tabId;
          const shot = await captureScreen(tabId);
          if (shot) {
            // 마지막으로 들어온 같은 URL 의 스냅샷에 붙인다.
            for (let i = state.pages.length - 1; i >= 0; i--) {
              if (state.pages[i].url === msg.url) {
                state.pages[i].screenshot = shot;
                break;
              }
            }
            scheduleSave();
          }

          if (state.manual) {
            sendResponse({ ok: true });
            return;
          }
          if (state.pending) {
            clearTimeout(globalThis.__wxWatchdog);
            state.pending = null;
            note(`수집 완료: ${msg.url}`);
            setTimeout(step, state.config.delayMs);
          }
        }
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: "알 수 없는 메시지" });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void handleMessage(msg, sender, sendResponse);
  return true; // 비동기 응답
});

/* ---------------------------- 결과 내보내기 ---------------------------- */

/** 캡처를 HAR 1.2 + 페이지 스냅샷으로 묶는다. HAR 부분은 표준이라 다른 도구도 읽는다. */
function buildBundle(s) {
  const entries = s.net
    .filter((r) => r.response)
    .map((r) => ({
      startedDateTime: new Date(r.startedAt).toISOString(),
      time: r.durationMs ?? 0,
      request: {
        method: r.request.method,
        url: r.request.url,
        httpVersion: "HTTP/1.1",
        headers: r.request.headers ?? [],
        queryString: queryOf(r.request.url),
        cookies: [],
        headersSize: -1,
        bodySize: r.request.body?.text ? r.request.body.text.length : 0,
        ...(r.request.body?.text
          ? { postData: { mimeType: contentTypeOf(r.request.headers), text: r.request.body.text } }
          : {}),
      },
      response: {
        status: r.response.status,
        statusText: r.response.statusText ?? "",
        httpVersion: "HTTP/1.1",
        headers: r.response.headers ?? [],
        cookies: [],
        content: {
          size: r.response.body?.text ? r.response.body.text.length : 0,
          mimeType: r.response.contentType ?? "",
          text: r.response.body?.text ?? "",
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 },
      pageref: r.pageUrl,
      _source: r.source,
    }));

  const discovered = new Set(s.visited);
  for (const page of s.pages) {
    for (const link of page.links ?? []) {
      if (inScope(link.url, s.config)) discovered.add(link.url);
    }
  }
  const unvisited = [...discovered].filter((u) => !s.visited.includes(u));

  return {
    format: "web-extractor-capture/2",
    createdAt: new Date().toISOString(),
    seed: s.config.seed,
    config: s.config,
    stats: {
      pages: s.pages.length,
      requests: entries.length,
      visited: s.visited.length,
      skipped: s.skipped.length,
      assets: s.assets?.length ?? 0,
      screenshots: s.pages.filter((p) => p.screenshot).length,
      durationMs: (s.finishedAt ?? Date.now()) - s.startedAt,
    },
    // 얼마나 훑었는지 숨기지 않는다 — 남은 것이 있으면 그대로 적는다.
    coverage: {
      discovered: discovered.size,
      visited: s.visited.length,
      unvisited: unvisited.length,
      unvisitedSample: unvisited.slice(0, 50),
      stoppedAtLimit: s.visited.length >= s.config.maxPages,
      manual: !!s.manual,
    },
    // CSS·JS·폰트(옵션에 따라 이미지) 본문. 이것이 있어야 화면을 되살릴 수 있다.
    assets: s.assets ?? [],
    assetSkipped: s.assetSkipped ?? [],
    robots: s.robots,
    skipped: s.skipped,
    log: s.log,
    pages: s.pages,
    // 표준 HAR — 이 키 하나만 떼어내도 다른 HAR 도구에서 열린다.
    log_har: { version: "1.2", creator: { name: "web-extractor", version: "1.0.0" }, entries },
  };
}

function queryOf(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function contentTypeOf(headers) {
  const h = (headers ?? []).find((x) => /^content-type$/i.test(x.name));
  return h ? h.value : "";
}

/* ------------------------ 배포된 웹앱에서 온 메시지 ------------------------ */

/**
 * `externally_connectable` 로 허용된 오리진(= 배포한 앱)이 보내오는 메시지.
 *
 * 내부 메시지와 **의도적으로 다르게** 다룬다.
 *   - 읽기(상태·결과)와 설정 저장, 중단·비우기는 그대로 허용한다.
 *   - 수집 **시작은 여기서 실행하지 않는다.** 사이트 접근 권한은 확장 컨텍스트 안의
 *     사용자 제스처를 요구하므로(그리고 웹페이지가 조용히 수집을 켜게 두면 안 되므로),
 *     설정만 받아 두고 확장 안의 앱 페이지를 열어 사용자가 직접 승인하게 한다.
 *   - 페이지 스냅샷·네트워크 기록(`page`, `net-batch`, `page-done`, `ready`)은
 *     **절대 받지 않는다.** 받으면 웹페이지가 가짜 수집 결과를 밀어 넣을 수 있다.
 */
const EXTERNAL_ALLOWED = new Set([
  "ping",
  "status",
  "export",
  "export-begin",
  "export-chunk",
  "export-end",
  "prefill",
  "stop",
  "reset",
  "assets-more",
]);

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;

    if (type === "ping") {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return;
    }

    if (type === "open-app") {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`app/index.html${msg.query ?? ""}`) });
      sendResponse({ ok: true });
      return;
    }

    if (type === "start-request") {
      // 설정만 넘겨받고, 승인은 확장 안의 앱에서 받는다.
      await chrome.storage.local.set({ form: msg.form ?? null, handoff: { at: Date.now(), from: sender.origin ?? null } });
      await chrome.tabs.create({ url: chrome.runtime.getURL("app/index.html?start=1") });
      sendResponse({ ok: true, handoff: true });
      return;
    }

    if (!EXTERNAL_ALLOWED.has(type)) {
      sendResponse({ ok: false, error: "외부에서 허용되지 않는 요청입니다." });
      return;
    }

    // 나머지는 내부와 같은 처리기를 탄다. (서비스 워커에서 sendMessage 를 다시 부르면
    // 자기 자신에게는 닿지 않으므로, 처리 함수를 직접 호출한다.)
    await handleMessage(msg, { origin: sender.origin }, sendResponse);
  })();
  return true;
});

chrome.runtime.onStartup.addListener(() => void loadState());
chrome.runtime.onInstalled.addListener(() => void loadState());
