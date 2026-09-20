/**
 * 앱 ↔ collector 확장 클라이언트.
 *
 * 두 가지 모드로 돈다.
 *
 *   확장 페이지 모드 — 앱이 chrome-extension://<id>/app/ 으로 열린 경우.
 *     chrome.* 를 직접 호출한다. 권한 요청도 여기서 되므로 수집 시작까지
 *     앱 안에서 끝난다. 개발 서버가 필요 없다.
 *
 *   개발 서버 모드 — 앱이 http://localhost:5173 로 열린 경우.
 *     announce.js 가 중계하는 postMessage 다리를 쓴다. 권한 요청은
 *     확장 UI 안에서만 가능하므로 시작 버튼은 팝업에 남는다.
 */

export interface CollectorStatus {
  running: boolean;
  /** 수동 탐색 모드 — 자동으로 이동하지 않고 사용자가 여는 화면만 기록한다. */
  manual: boolean;
  /** "crawl" 순회 중 · "assets" 정적 리소스 받는 중 · "done" 끝 */
  phase: "crawl" | "assets" | "done";
  visited: number;
  queued: number;
  /** 링크로 발견한 범위 안 URL 수. 방문 수와 비교하면 얼마나 훑었는지 보인다. */
  discovered: number;
  pages: number;
  net: number;
  skipped: number;
  assets: number;
  shots: number;
  maxPages: number;
  seed: string;
  startedAt: number;
  finishedAt: number | null;
  log: { at: number; message: string }[];
}

export interface CollectorForm {
  seed: string;
  include: string;
  exclude: string;
  /** 0 이면 제한 없음 — 큐가 빌 때까지 돈다. */
  maxPages: number;
  maxDepth: number;
  /** 다음 접속까지 쉬는 시간의 범위. 매번 이 사이에서 새로 뽑는다. */
  delayMinMs: number;
  delayMaxMs: number;
  sameOriginOnly: boolean;
  respectRobots: boolean;
  maskSecrets: boolean;
  captureHtml: boolean;
  /** CSS·JS·폰트 본문까지 받는다 — 이것이 없으면 재현해도 겉모습이 달라진다. */
  captureAssets: boolean;
  /** 이미지까지 받는다. 용량이 크게 늘어난다. */
  captureImages: boolean;
  /** 페이지마다 보이는 화면을 한 장 찍는다. */
  captureScreenshots: boolean;
}

export type CollectorMode = "extension" | "external" | "bridge" | "none";

/**
 * 고정된 확장 ID.
 *
 * 압축 해제 확장의 ID 는 보통 폴더 경로에서 파생되어 PC 마다 달라지지만,
 * `manifest.json` 에 공개키(`key`)를 박아 두면 어디서나 같은 값이 된다.
 * 배포된 웹앱이 확장을 지목해 말을 걸려면 이 값이 고정이어야 한다.
 */
export const EXTENSION_ID = "akldinhfgcdpmmalofipenaidkcpmjcb";

/** 한 번에 옮길 결과 조각 크기. 큰 캡처를 메시지 하나로 밀어 넣지 않기 위한 것이다. */
const CHUNK_CHARS = 4_000_000;

/** 앱 자신이 확장 페이지로 열렸는가. 이 경우 chrome.* 를 직접 쓸 수 있다. */
export function isExtensionPage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome?.runtime?.id &&
    location.protocol === "chrome-extension:"
  );
}

/** 확장이 페이지에 심어 둔 표식 (개발 서버 모드). */
function bridgeVersion(): string | null {
  return document.documentElement.getAttribute("data-web-extractor-collector");
}

/** 이 페이지가 확장에 말을 걸 수 있는가 (externally_connectable 로 허용된 오리진). */
export function canReachExtension(): boolean {
  return typeof chrome !== "undefined" && typeof chrome?.runtime?.sendMessage === "function";
}

export function detectMode(): { mode: CollectorMode; version: string | null } {
  if (isExtensionPage()) {
    return { mode: "extension", version: chrome!.runtime.getManifest().version };
  }
  const v = bridgeVersion();
  return v ? { mode: "bridge", version: v } : { mode: "none", version: null };
}

/**
 * 배포된 사이트에서 확장에 닿는지 확인한다.
 *
 * 확장이 설치돼 있고 이 오리진이 `externally_connectable` 에 등록돼 있어야 응답이 온다.
 * 둘 중 하나라도 아니면 조용히 실패하므로, 실패를 "확장 없음" 으로 다룬다.
 */
export async function probeExternal(): Promise<{ ok: boolean; version: string | null }> {
  if (!canReachExtension()) return { ok: false, version: null };
  try {
    const res = await external<{ ok?: boolean; version?: string }>({ type: "ping" }, 2000);
    return res?.ok ? { ok: true, version: res.version ?? null } : { ok: false, version: null };
  } catch {
    return { ok: false, version: null };
  }
}

/* ------------------------------------------------------------------ */
/* 배포 사이트 모드 — 확장에 직접 메시지                                   */
/* ------------------------------------------------------------------ */

function external<T>(message: unknown, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!canReachExtension()) {
      reject(new Error("이 페이지에서는 확장에 연결할 수 없습니다."));
      return;
    }
    const timer = setTimeout(() => reject(new Error("확장이 응답하지 않습니다.")), timeoutMs);
    try {
      chrome!.runtime.sendMessage(EXTENSION_ID, message, (res: unknown) => {
        clearTimeout(timer);
        const err = chrome!.runtime.lastError;
        if (err) {
          reject(new Error(err.message ?? "확장에 닿지 못했습니다."));
          return;
        }
        resolve(res as T);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/* ------------------------------------------------------------------ */
/* 개발 서버 모드 — postMessage 다리                                     */
/* ------------------------------------------------------------------ */

let nextId = 0;

function bridgeCall<T>(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `wx-${nextId++}`;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; id?: string } | null;
      if (!data || data.source !== "web-extractor-collector" || data.id !== id) return;
      cleanup();
      resolve(data as T);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("확장이 응답하지 않습니다."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "web-extractor-app", id, type, ...payload }, "*");
  });
}

/* ------------------------------------------------------------------ */
/* 공통 API                                                            */
/* ------------------------------------------------------------------ */

/** 확장 설정 폼을 background 가 쓰는 모양으로 바꾼다. */
function toConfig(form: CollectorForm) {
  const lines = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    seed: form.seed.trim(),
    include: lines(form.include),
    exclude: lines(form.exclude),
    maxPages: form.maxPages,
    maxDepth: form.maxDepth,
    delayMinMs: form.delayMinMs,
    delayMaxMs: form.delayMaxMs,
    sameOriginOnly: form.sameOriginOnly,
    respectRobots: form.respectRobots,
    maskSecrets: form.maskSecrets,
    captureHtml: form.captureHtml,
    captureAssets: form.captureAssets,
    captureImages: form.captureImages,
    captureScreenshots: form.captureScreenshots,
  };
}

export const collector = {
  /** 설정을 저장해 둔다. 팝업을 열면 이미 채워져 있다. */
  async prefill(form: CollectorForm): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.storage.local.set({ form });
      return;
    }
    if (canReachExtension()) {
      await external({ type: "prefill", form });
      return;
    }
    await bridgeCall("prefill", { form });
  },

  /**
   * 수집을 시작한다. 확장 페이지 모드에서만 가능하다.
   *
   * 대상 사이트 권한은 Chrome 이 "확장 컨텍스트 안의 사용자 제스처" 를 요구하므로,
   * 이 함수는 반드시 버튼 클릭 핸들러에서 직접 호출되어야 한다.
   * await 를 먼저 걸면 제스처가 소모되어 권한 창이 뜨지 않는다.
   */
  async start(
    form: CollectorForm,
    options: { manual?: boolean } = {},
  ): Promise<{ started: boolean; handoff?: boolean; reason?: string }> {
    if (!isExtensionPage()) {
      // 배포된 사이트에서는 여기서 시작할 수 없다 — 사이트 접근 권한 요청이
      // 확장 컨텍스트의 사용자 제스처를 요구한다. 설정을 넘기고 확장 창에서 승인받는다.
      if (canReachExtension()) {
        try {
          await external({ type: "start-request", form, manual: !!options.manual });
          return {
            started: false,
            handoff: true,
            reason: "확장이 새 창을 열었습니다. 거기서 설정을 확인하고 시작을 눌러 주세요.",
          };
        } catch (err) {
          return { started: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }
      return { started: false, reason: "확장 페이지에서만 시작할 수 있습니다." };
    }
    const config = toConfig(form);

    let origin: string;
    try {
      origin = new URL(config.seed).origin;
    } catch {
      return { started: false, reason: "시작 URL 이 올바르지 않습니다." };
    }

    const granted = await chrome!.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      return { started: false, reason: "해당 사이트 권한이 없으면 수집할 수 없습니다." };
    }

    await chrome!.storage.local.set({ form });
    // 수집은 전용 탭에서 돈다 — 이 앱 탭은 그대로 두고 진행 상황을 본다.
    // 수동 탐색 모드에서는 그 탭이 사용자가 직접 돌아다니는 탭이 된다.
    const tab = await chrome!.tabs.create({ url: "about:blank", active: true });
    const res = (await chrome!.runtime.sendMessage({
      type: "start",
      config,
      tabId: tab.id,
      manual: !!options.manual,
    })) as { ok?: boolean } | undefined;

    return res?.ok ? { started: true } : { started: false, reason: "확장이 시작하지 못했습니다." };
  },

  /**
   * 권한 밖이라 받지 못한 리소스를 마저 받는다.
   *
   * 외부 CDN(jsdelivr 등)에서 오는 CSS·폰트는 수집 시점에 권한이 없어 건너뛴다.
   * 이 함수는 그 오리진들의 권한을 한 번 물어본 뒤 남은 것을 받아 온다.
   * 권한 창은 사용자 제스처에서만 뜨므로 클릭 핸들러에서 직접 불러야 한다.
   */
  async fetchMoreAssets(
    origins: string[],
  ): Promise<{ started: boolean; handoff?: boolean; reason?: string }> {
    if (!isExtensionPage()) {
      return { started: false, reason: "확장 페이지에서만 받을 수 있습니다." };
    }
    if (origins.length === 0) return { started: false, reason: "받을 리소스가 없습니다." };

    const granted = await chrome!.permissions.request({
      origins: origins.map((o) => `${o}/*`),
    });
    if (!granted) return { started: false, reason: "권한을 허용해야 받을 수 있습니다." };

    const res = (await chrome!.runtime.sendMessage({ type: "assets-more" })) as
      | { ok?: boolean; reason?: string }
      | undefined;
    return res?.ok ? { started: true } : { started: false, reason: res?.reason ?? "시작하지 못했습니다." };
  },

  /** 확장 안의 앱 페이지를 연다 (권한 승인이 필요한 동작을 거기서 이어서 하게). */
  async openExtensionApp(query = ""): Promise<boolean> {
    try {
      const res = await external<{ ok?: boolean }>({ type: "open-app", query }, 5000);
      return !!res?.ok;
    } catch {
      return false;
    }
  },

  /** 배포 사이트에서 남은 리소스를 마저 받게 한다 (권한 요청은 확장 창에서). */
  async fetchMoreAssetsExternal(): Promise<{ started: boolean; reason?: string }> {
    try {
      const res = await external<{ ok?: boolean; reason?: string }>({ type: "assets-more" });
      return res?.ok ? { started: true } : { started: false, reason: res?.reason };
    } catch (err) {
      return { started: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  async stop(): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.runtime.sendMessage({ type: "stop" });
      return;
    }
    if (canReachExtension()) {
      await external({ type: "stop" });
      return;
    }
    await bridgeCall("stop");
  },

  async status(): Promise<CollectorStatus | null> {
    if (isExtensionPage()) {
      const res = (await chrome!.runtime.sendMessage({ type: "status" })) as
        | { status?: CollectorStatus | null }
        | undefined;
      return res?.status ?? null;
    }
    if (canReachExtension()) {
      const res = await external<{ status?: CollectorStatus | null }>({ type: "status" }, 5000);
      return res?.status ?? null;
    }
    const res = await bridgeCall<{ status: CollectorStatus | null }>("status");
    return res.status;
  },

  async reset(): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.runtime.sendMessage({ type: "reset" });
      return;
    }
    if (canReachExtension()) {
      await external({ type: "reset" });
      return;
    }
    await bridgeCall("reset");
  },

  /** 수집 결과를 파일 저장 없이 바로 가져온다. */
  async exportBundle(): Promise<unknown> {
    if (isExtensionPage()) {
      const res = (await chrome!.runtime.sendMessage({ type: "export" })) as
        | { bundle?: unknown }
        | undefined;
      return res?.bundle ?? null;
    }
    if (canReachExtension()) {
      return await exportInChunks();
    }
    const res = await bridgeCall<{ bundle: unknown }>("export", {}, 20000);
    return res.bundle;
  },
};

/**
 * 캡처는 수십 MB 가 되기도 한다. 메시지 하나에 통째로 실으면 직렬화 비용도 크고
 * 한도에 걸릴 수 있어, 조각으로 나눠 받아 다시 잇는다.
 */
async function exportInChunks(): Promise<unknown> {
  const begin = await external<{ ok?: boolean; id?: string; length?: number; error?: string }>(
    { type: "export-begin" },
    60000,
  );
  if (!begin?.ok || !begin.id || !begin.length) {
    if (begin?.error) throw new Error(begin.error);
    return null;
  }

  let json = "";
  for (let start = 0; start < begin.length; start += CHUNK_CHARS) {
    const piece = await external<{ ok?: boolean; text?: string }>(
      { type: "export-chunk", id: begin.id, start, size: CHUNK_CHARS },
      60000,
    );
    if (!piece?.ok || typeof piece.text !== "string") {
      throw new Error("결과를 옮기는 중 끊겼습니다.");
    }
    json += piece.text;
  }
  await external({ type: "export-end", id: begin.id }, 10000).catch(() => undefined);
  return JSON.parse(json);
}
