/**
 * ISOLATED world. document_start 에 주입된다.
 *
 * MAIN world 의 hook.js 가 던지는 네트워크 레코드를 받아 background 로 넘기고,
 * 페이지가 안정되면 DOM 구조를 한 번 추출해 함께 보낸다.
 *
 * 이 스크립트는 클릭하거나 폼을 제출하지 않는다. 오직 관찰만 한다.
 * (자동 순회는 background 가 <a href> 링크로만, GET 으로만 수행한다.)
 */
(() => {
  if (window.__webExtractorBridge) return;
  window.__webExtractorBridge = true;

  const CHANNEL = "__web_extractor_record__";
  const MAX_HTML = 512 * 1024;

  let netBuffer = [];
  let flushTimer = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* 확장이 리로드되면 채널이 끊긴다 — 페이지는 그대로 둔다. */
    }
  }

  function flush() {
    flushTimer = null;
    if (!netBuffer.length) return;
    const batch = netBuffer;
    netBuffer = [];
    send({ type: "net-batch", records: batch });
  }

  window.addEventListener(CHANNEL, (e) => {
    try {
      netBuffer.push(JSON.parse(e.detail));
    } catch {
      return;
    }
    // 한 번에 몰아 보내서 메시지 폭주를 막는다.
    if (!flushTimer) flushTimer = setTimeout(flush, 400);
    if (netBuffer.length >= 40) {
      clearTimeout(flushTimer);
      flush();
    }
  });

  /* --------------------------- DOM 구조 추출 --------------------------- */

  const textOf = (el) => (el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160);

  /** 버튼·링크의 접근 가능한 이름. aria-label 우선, 없으면 텍스트. */
  function accName(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      textOf(el) ||
      el.getAttribute("name") ||
      ""
    );
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** 랜드마크 + 제목 아웃라인으로 화면 골격을 요약한다. 전체 DOM 덤프보다 읽기 쉽다. */
  function outline() {
    const out = [];
    const selector = "main,nav,header,footer,aside,section,article,form,table,dialog,h1,h2,h3,h4";
    for (const el of document.querySelectorAll(selector)) {
      if (out.length >= 400) break;
      const tag = el.tagName.toLowerCase();
      out.push({
        tag,
        role: el.getAttribute("role") || null,
        label: el.getAttribute("aria-label") || null,
        text: /^h[1-4]$/.test(tag) ? textOf(el) : null,
        path: cssPath(el),
      });
    }
    return out;
  }

  function forms() {
    return [...document.forms].slice(0, 40).map((f) => ({
      action: f.getAttribute("action") || null,
      method: (f.getAttribute("method") || "get").toUpperCase(),
      id: f.id || null,
      fields: [...f.elements]
        .filter((el) => el.name || el.id)
        .slice(0, 60)
        .map((el) => ({
          name: el.name || el.id,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          required: !!el.required,
          maxLength: el.maxLength > 0 ? el.maxLength : null,
          placeholder: el.placeholder || null,
          // 값은 수집하지 않는다 — 개인정보가 섞일 수 있다.
          options:
            el.tagName === "SELECT"
              ? [...el.options].slice(0, 30).map((o) => ({ value: o.value, label: textOf(o) }))
              : null,
        })),
    }));
  }

  function links() {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      let href;
      try {
        href = new URL(a.getAttribute("href"), location.href);
      } catch {
        continue;
      }
      if (href.protocol !== "http:" && href.protocol !== "https:") continue;
      href.hash = "";
      const key = href.href;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: key, text: accName(a) });
      if (out.length >= 500) break;
    }
    return out;
  }

  function controls() {
    const out = [];
    for (const el of document.querySelectorAll(
      'button,[role="button"],input[type="submit"],input[type="button"],[role="tab"],[role="menuitem"]',
    )) {
      const name = accName(el);
      if (!name) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || null,
        name,
        disabled: !!el.disabled,
        path: cssPath(el),
      });
      if (out.length >= 200) break;
    }
    return out;
  }

  /** 프런트엔드 프레임워크 흔적. 백엔드 추론의 보조 단서가 된다. */
  function frontendFingerprint() {
    const hits = [];
    const w = window;
    if (w.__NEXT_DATA__) hits.push("Next.js");
    if (w.__NUXT__) hits.push("Nuxt");
    if (w.__remixContext) hits.push("Remix");
    if (w.__SVELTEKIT_PAYLOAD__ || document.querySelector("[data-sveltekit-preload-data]"))
      hits.push("SvelteKit");
    if (w.Vue || document.querySelector("[data-v-app],#__nuxt")) hits.push("Vue");
    if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector("[data-reactroot],#__next"))
      hits.push("React");
    if (document.querySelector("[ng-version]")) {
      hits.push(`Angular ${document.querySelector("[ng-version]").getAttribute("ng-version")}`);
    }
    if (w.Turbo || document.querySelector("[data-turbo]")) hits.push("Hotwire/Turbo");
    if (document.querySelector("[data-livewire-id],[wire\\:id]")) hits.push("Livewire");
    if (w.htmx) hits.push("htmx");
    const generator = document.querySelector('meta[name="generator"]');
    if (generator) hits.push(`generator: ${generator.getAttribute("content")}`);
    return [...new Set(hits)];
  }

  /**
   * 브라우저가 실제로 보낸 모든 요청 목록. fetch/XHR 후킹이 놓친 것
   * (문서 자체, 이미지, 프리로드, beacon, 워커 요청)까지 URL 수준으로 잡힌다.
   */
  function resourceTimings() {
    try {
      return performance
        .getEntriesByType("resource")
        .slice(0, 600)
        .map((e) => ({
          url: e.name,
          initiatorType: e.initiatorType,
          durationMs: Math.round(e.duration),
          transferSize: e.transferSize || 0,
        }));
    } catch {
      return [];
    }
  }

  function snapshot(reason) {
    const html = document.documentElement.outerHTML || "";
    return {
      type: "page",
      reason,
      url: location.href,
      title: document.title,
      collectedAt: Date.now(),
      html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html,
      htmlTruncated: html.length > MAX_HTML,
      htmlLength: html.length,
      outline: outline(),
      forms: forms(),
      links: links(),
      controls: controls(),
      frontend: frontendFingerprint(),
      resources: resourceTimings(),
      cookieNames: (document.cookie || "")
        .split(";")
        .map((c) => c.split("=")[0].trim())
        .filter(Boolean),
    };
  }

  /** 네트워크가 잠잠해질 때까지 기다린 뒤 스냅샷을 찍는다. */
  let settleTimer = null;
  let lastNetAt = Date.now();
  window.addEventListener(CHANNEL, () => {
    lastNetAt = Date.now();
  });

  function scheduleSnapshot(reason, minQuietMs = 900, maxWaitMs = 12000) {
    clearTimeout(settleTimer);
    const deadline = Date.now() + maxWaitMs;
    const tick = () => {
      const quiet = Date.now() - lastNetAt;
      if (quiet >= minQuietMs || Date.now() >= deadline) {
        flush();
        send(snapshot(reason));
        send({ type: "page-done", url: location.href });
      } else {
        settleTimer = setTimeout(tick, 300);
      }
    };
    settleTimer = setTimeout(tick, minQuietMs);
  }

  if (document.readyState === "complete") scheduleSnapshot("load");
  else window.addEventListener("load", () => scheduleSnapshot("load"));

  // SPA 라우트 전환도 하나의 화면으로 기록한다.
  let lastRoute = location.href;
  window.addEventListener("__web_extractor_route__", () => {
    if (location.href === lastRoute) return;
    lastRoute = location.href;
    scheduleSnapshot("spa-route");
  });

  // background 가 설정을 내려주면 MAIN world 로 전달한다.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "config") {
      try {
        window.dispatchEvent(
          new CustomEvent("__web_extractor_config__", { detail: JSON.stringify(msg.config) }),
        );
      } catch {
        /* 무시 */
      }
    }
    if (msg?.type === "snapshot-now") scheduleSnapshot("manual", 200, 3000);
  });

  send({ type: "ready", url: location.href });
})();
