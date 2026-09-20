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
  visited: number;
  queued: number;
  pages: number;
  net: number;
  skipped: number;
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
  maxPages: number;
  maxDepth: number;
  delayMs: number;
  sameOriginOnly: boolean;
  respectRobots: boolean;
  maskSecrets: boolean;
  captureHtml: boolean;
}

export type CollectorMode = "extension" | "bridge" | "none";

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

export function detectMode(): { mode: CollectorMode; version: string | null } {
  if (isExtensionPage()) {
    return { mode: "extension", version: chrome!.runtime.getManifest().version };
  }
  const v = bridgeVersion();
  return v ? { mode: "bridge", version: v } : { mode: "none", version: null };
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
    delayMs: form.delayMs,
    sameOriginOnly: form.sameOriginOnly,
    respectRobots: form.respectRobots,
    maskSecrets: form.maskSecrets,
    captureHtml: form.captureHtml,
  };
}

export const collector = {
  /** 설정을 저장해 둔다. 팝업을 열면 이미 채워져 있다. */
  async prefill(form: CollectorForm): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.storage.local.set({ form });
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
  async start(form: CollectorForm): Promise<{ started: boolean; reason?: string }> {
    if (!isExtensionPage()) {
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
    const tab = await chrome!.tabs.create({ url: "about:blank", active: true });
    const res = (await chrome!.runtime.sendMessage({
      type: "start",
      config,
      tabId: tab.id,
    })) as { ok?: boolean } | undefined;

    return res?.ok ? { started: true } : { started: false, reason: "확장이 시작하지 못했습니다." };
  },

  async stop(): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.runtime.sendMessage({ type: "stop" });
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
    const res = await bridgeCall<{ status: CollectorStatus | null }>("status");
    return res.status;
  },

  async reset(): Promise<void> {
    if (isExtensionPage()) {
      await chrome!.runtime.sendMessage({ type: "reset" });
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
    const res = await bridgeCall<{ bundle: unknown }>("export", {}, 20000);
    return res.bundle;
  },
};
