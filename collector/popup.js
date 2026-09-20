/**
 * 팝업은 이제 "설정·시작" 화면이 아니다.
 *
 * 앱이 확장 페이지(chrome-extension://<id>/app/)로 열리면 권한 요청까지 앱 안에서
 * 되므로, 설정과 시작은 전부 앱이 맡는다. 팝업에 남는 것은 어디서나 한 번에
 * 닿아야 하는 것들 — 앱 열기, 파일로 저장, 중단, 기록 비우기 — 뿐이다.
 */

const $ = (id) => document.getElementById(id);

const APP_URL = chrome.runtime.getURL("app/index.html");

/* ------------------------------ 앱 열기 ------------------------------ */

/** 빌드되지 않은 상태로 열면 오류 페이지만 보게 되므로 먼저 확인한다. */
async function appExists() {
  try {
    const res = await fetch(APP_URL, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

$("open").addEventListener("click", async () => {
  if (!(await appExists())) {
    alert("앱이 아직 빌드되지 않았습니다.\n\nrun.bat (Windows) 또는 ./run.sh 로 실행하면 자동으로 빌드됩니다.");
    return;
  }
  // 이미 열려 있으면 그 탭으로 간다 — 앱 탭이 여러 개 쌓이지 않게.
  const open = await chrome.tabs.query({ url: `${APP_URL}*` });
  if (open.length > 0) {
    await chrome.tabs.update(open[0].id, { active: true });
    await chrome.windows.update(open[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
  window.close();
});

/* ------------------------------ 동작 ------------------------------ */

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  void poll();
});

$("reset").addEventListener("click", async () => {
  if (!confirm("수집한 데이터를 모두 지웁니다. 계속할까요?")) return;
  await chrome.runtime.sendMessage({ type: "reset" });
  void poll();
});

$("export").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "export" }).catch(() => null);
  if (!res?.bundle) {
    alert("내보낼 데이터가 없습니다.");
    return;
  }
  const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  let host = "capture";
  try {
    host = new URL(res.bundle.seed).host.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    /* 기본값 */
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = `web-extractor-${host}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

/* ------------------------------ 상태 ------------------------------ */

let pollTimer = null;

async function poll() {
  const res = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  const status = res?.status;

  clearTimeout(pollTimer);

  if (!status) {
    $("status").classList.add("hidden");
    $("stop").classList.add("hidden");
    $("export").disabled = true;
    return;
  }

  $("status").classList.remove("hidden");
  $("s-state").textContent = !status.running
    ? status.finishedAt
      ? "완료"
      : "대기"
    : status.phase === "assets"
      ? `정적 리소스 ${status.assets ?? 0}개`
      : status.manual
        ? `수동 탐색 중 (${status.pages})`
        : status.maxPages > 0
          ? `수집 중 (${status.visited}/${status.maxPages})`
          : `수집 중 (${status.visited})`;
  $("s-pages").textContent = status.pages;
  $("s-queued").textContent = status.queued;
  $("s-net").textContent = status.net;

  $("stop").classList.toggle("hidden", !status.running);
  $("export").disabled = status.pages === 0 && status.net === 0;

  if (status.running) pollTimer = setTimeout(poll, 800);
}

void poll();
