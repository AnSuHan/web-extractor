/**
 * MAIN world. document_start 에 주입된다.
 *
 * 페이지 자신의 fetch / XMLHttpRequest 를 감싸서 요청·응답을 기록한다.
 * 페이지 안에서 도는 코드이므로 CORS 가 응답 본문을 가리지 않는다 —
 * 이게 브라우저에서 교차 출처 API 응답을 볼 수 있는 유일한 위치다.
 *
 * 절대 규칙: 무슨 일이 있어도 원래 동작을 바꾸지 않는다.
 * 모든 후킹은 try/catch 로 감싸고, 실패하면 조용히 원본을 그대로 돌려준다.
 */
(() => {
  if (window.__webExtractorHooked) return;
  window.__webExtractorHooked = true;

  const CHANNEL = "__web_extractor_record__";
  const MAX_BODY = 256 * 1024; // 본문당 256KB. 넘으면 잘라서 표시한다.

  /** 값이 자격증명처럼 보이는 헤더·필드는 이름만 남기고 값을 가린다. */
  const SECRET_HEADER = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|proxy-authorization)$/i;

  let maskSecrets = true;
  window.addEventListener("__web_extractor_config__", (e) => {
    try {
      maskSecrets = JSON.parse(e.detail).maskSecrets !== false;
    } catch {
      /* 기본값 유지 */
    }
  });

  function maskHeaderValue(name, value) {
    if (!maskSecrets) return value;
    if (!SECRET_HEADER.test(name)) return value;
    return `<redacted:${String(value).length}chars>`;
  }

  /** 본문이 텍스트로 읽을 가치가 있는 타입인지. 바이너리는 크기만 남긴다. */
  function isTextual(contentType) {
    if (!contentType) return true; // 모르면 일단 시도해 본다.
    return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json)|application\/vnd\.[^;]*\+json)/i.test(
      contentType,
    );
  }

  function clip(text) {
    if (typeof text !== "string") return null;
    if (text.length <= MAX_BODY) return { text, truncated: false };
    return { text: text.slice(0, MAX_BODY), truncated: true, fullLength: text.length };
  }

  function emit(record) {
    try {
      window.dispatchEvent(
        new CustomEvent(CHANNEL, { detail: JSON.stringify(record) }),
      );
    } catch {
      /* 직렬화 실패한 레코드는 버린다 — 페이지를 막는 것보다 낫다. */
    }
  }

  function headersToPairs(headers) {
    const out = [];
    try {
      if (!headers) return out;
      if (typeof headers.forEach === "function" && headers instanceof Headers) {
        headers.forEach((v, k) => out.push({ name: k, value: maskHeaderValue(k, v) }));
        return out;
      }
      if (Array.isArray(headers)) {
        for (const [k, v] of headers) out.push({ name: k, value: maskHeaderValue(k, v) });
        return out;
      }
      for (const [k, v] of Object.entries(headers)) {
        out.push({ name: k, value: maskHeaderValue(k, String(v)) });
      }
    } catch {
      /* 헤더를 못 읽으면 빈 배열 */
    }
    return out;
  }

  function rawHeaderStringToPairs(raw) {
    const out = [];
    if (!raw) return out;
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      out.push({ name, value: maskHeaderValue(name, value) });
    }
    return out;
  }

  async function requestBodyText(body) {
    try {
      if (body == null) return null;
      if (typeof body === "string") return clip(body);
      if (body instanceof URLSearchParams) return clip(body.toString());
      if (body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body.entries()) {
          obj[k] = v instanceof File ? `<file:${v.name}:${v.size}bytes>` : String(v);
        }
        return clip(JSON.stringify(obj));
      }
      if (body instanceof Blob) return { text: null, note: `<blob:${body.size}bytes>` };
      if (body instanceof ArrayBuffer) return { text: null, note: `<binary:${body.byteLength}bytes>` };
      return clip(String(body));
    } catch {
      return null;
    }
  }

  /* ------------------------------ fetch ------------------------------ */

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const started = Date.now();
      let url = "";
      let method = "GET";
      let reqHeaders = [];
      let reqBodyPromise = Promise.resolve(null);

      try {
        const [input, init] = args;
        if (input instanceof Request) {
          url = input.url;
          method = (init?.method || input.method || "GET").toUpperCase();
          reqHeaders = headersToPairs(init?.headers || input.headers);
          // Request 본문은 한 번만 읽을 수 있으므로 복제본에서 읽는다.
          if (init?.body != null) reqBodyPromise = requestBodyText(init.body);
          else {
            try {
              reqBodyPromise = input
                .clone()
                .text()
                .then(clip)
                .catch(() => null);
            } catch {
              reqBodyPromise = Promise.resolve(null);
            }
          }
        } else {
          url = String(input);
          method = (init?.method || "GET").toUpperCase();
          reqHeaders = headersToPairs(init?.headers);
          reqBodyPromise = requestBodyText(init?.body);
        }
        url = new URL(url, location.href).href;
      } catch {
        /* URL 파싱 실패해도 원본 호출은 그대로 진행한다. */
      }

      const promise = origFetch.apply(this, args);

      promise
        .then(async (response) => {
          try {
            const contentType = response.headers.get("content-type") || "";
            let body = null;
            if (isTextual(contentType)) {
              // 반드시 복제본에서 읽는다. 원본을 소비하면 페이지가 깨진다.
              body = await response
                .clone()
                .text()
                .then(clip)
                .catch(() => null);
            } else {
              body = { text: null, note: `<non-text:${contentType}>` };
            }
            emit({
              kind: "net",
              source: "fetch",
              startedAt: started,
              durationMs: Date.now() - started,
              pageUrl: location.href,
              request: { method, url, headers: reqHeaders, body: await reqBodyPromise },
              response: {
                status: response.status,
                statusText: response.statusText,
                headers: headersToPairs(response.headers),
                contentType,
                body,
              },
            });
          } catch {
            /* 기록 실패는 무시 */
          }
          return response;
        })
        .catch((error) => {
          emit({
            kind: "net",
            source: "fetch",
            startedAt: started,
            durationMs: Date.now() - started,
            pageUrl: location.href,
            request: { method, url, headers: reqHeaders, body: null },
            response: null,
            error: String(error && error.message ? error.message : error),
          });
        });

      return promise;
    };
  }

  /* --------------------------- XMLHttpRequest --------------------------- */

  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__wx = {
          method: String(method || "GET").toUpperCase(),
          url: new URL(String(url), location.href).href,
          headers: [],
        };
      } catch {
        this.__wx = { method: String(method || "GET").toUpperCase(), url: String(url), headers: [] };
      }
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__wx) this.__wx.headers.push({ name, value: maskHeaderValue(name, value) });
      } catch {
        /* 무시 */
      }
      return origSetHeader.call(this, name, value);
    };

    XHR.prototype.send = function (body) {
      const meta = this.__wx;
      if (meta) {
        meta.startedAt = Date.now();
        const finish = async () => {
          try {
            const contentType = this.getResponseHeader("content-type") || "";
            let responseBody = null;
            // responseText 는 responseType 이 '' 또는 'text' 일 때만 접근 가능하다.
            if (this.responseType === "" || this.responseType === "text") {
              responseBody = clip(this.responseText);
            } else if (this.responseType === "json") {
              try {
                responseBody = clip(JSON.stringify(this.response));
              } catch {
                responseBody = null;
              }
            } else {
              responseBody = { text: null, note: `<responseType:${this.responseType}>` };
            }
            emit({
              kind: "net",
              source: "xhr",
              startedAt: meta.startedAt,
              durationMs: Date.now() - meta.startedAt,
              pageUrl: location.href,
              request: {
                method: meta.method,
                url: meta.url,
                headers: meta.headers,
                body: await requestBodyText(body),
              },
              response: {
                status: this.status,
                statusText: this.statusText,
                headers: rawHeaderStringToPairs(this.getAllResponseHeaders()),
                contentType,
                body: responseBody,
              },
            });
          } catch {
            /* 무시 */
          }
        };
        this.addEventListener("load", finish);
        this.addEventListener("error", () => {
          emit({
            kind: "net",
            source: "xhr",
            startedAt: meta.startedAt,
            durationMs: Date.now() - meta.startedAt,
            pageUrl: location.href,
            request: { method: meta.method, url: meta.url, headers: meta.headers, body: null },
            response: null,
            error: "network error",
          });
        });
      }
      return origSend.call(this, body);
    };
  }

  /* ------------------------- SPA 라우트 변경 감지 ------------------------- */

  // history API 를 갈아끼우면 SPA 의 화면 전환도 '페이지'로 잡을 수 있다.
  for (const name of ["pushState", "replaceState"]) {
    const orig = history[name];
    if (typeof orig !== "function") continue;
    history[name] = function (...args) {
      const result = orig.apply(this, args);
      try {
        window.dispatchEvent(new CustomEvent("__web_extractor_route__"));
      } catch {
        /* 무시 */
      }
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    try {
      window.dispatchEvent(new CustomEvent("__web_extractor_route__"));
    } catch {
      /* 무시 */
    }
  });
})();
