/**
 * 앱(localhost)에만 주입되는 작은 다리.
 *
 * 두 가지만 한다.
 *   1. 확장이 로드되어 있다는 사실을 DOM 속성으로 알린다 → 앱이 설치 안내 대신 "연결됨"을 보여준다.
 *   2. 앱이 입력한 수집 설정을 확장으로 넘기고, 진행 상태를 앱으로 돌려준다.
 *
 * 앱에서 수집을 '시작'시키지는 않는다. 대상 사이트 권한 요청은 확장 UI 안의
 * 실제 클릭이 있어야 하므로, 시작 버튼은 팝업에 남겨 둔다.
 */
(() => {
  const VERSION = chrome.runtime.getManifest().version;

  // 앱이 querySelector 로 바로 확인할 수 있게 표시해 둔다.
  const mark = () => {
    document.documentElement.setAttribute("data-web-extractor-collector", VERSION);
  };
  mark();
  // SPA 가 html 속성을 갈아끼우는 경우를 대비해 한 번 더.
  document.addEventListener("DOMContentLoaded", mark);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "web-extractor-app") return;

    const reply = (payload) =>
      window.postMessage({ source: "web-extractor-collector", id: msg.id, ...payload }, "*");

    switch (msg.type) {
      case "ping":
        reply({ ok: true, version: VERSION });
        return;

      case "prefill":
        // 팝업이 읽는 것과 같은 저장소 키에 써 둔다 — 팝업을 열면 이미 채워져 있다.
        chrome.storage.local.set({ form: msg.form }).then(
          () => reply({ ok: true }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;

      case "status":
        chrome.runtime.sendMessage({ type: "status" }).then(
          (res) => reply({ ok: true, status: res?.status ?? null }),
          () => reply({ ok: false, status: null }),
        );
        return;

      case "export":
        chrome.runtime.sendMessage({ type: "export" }).then(
          (res) => reply({ ok: true, bundle: res?.bundle ?? null }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;

      case "reset":
        chrome.runtime.sendMessage({ type: "reset" }).then(
          () => reply({ ok: true }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;

      case "stop":
        chrome.runtime.sendMessage({ type: "stop" }).then(
          () => reply({ ok: true }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;

      default:
        reply({ ok: false, error: "알 수 없는 요청" });
    }
  });
})();
