import { useCallback, useState } from "react";
import type { ImageAsset, TabId } from "./lib/types";
import type { LoadedCapture } from "./lib/capture";
import { loadHistory, saveHistory, usePersisted } from "./lib/storage";
import type { HistoryItem } from "./lib/storage";
import { CollectTab } from "./components/CollectTab";
import { UiTab } from "./components/UiTab";
import { NavTab } from "./components/NavTab";
import { ApiTab } from "./components/ApiTab";
import { Button } from "./components/ui";

const TABS: { id: TabId; label: string; desc: string }[] = [
  { id: "collect", label: "수집", desc: "URL·범위 지정 → 돌면서 API·HTML·백엔드 단서 수집" },
  { id: "ui", label: "UI 재구성", desc: "이미지 → 완벽한 프론트 구현 프롬프트" },
  { id: "nav", label: "네비게이팅 테스트", desc: "브라우저를 돌며 기능 명세 추출" },
  { id: "api", label: "API 역설계", desc: "HAR → API 클라이언트" },
];

export default function App() {
  const [tab, setTab] = usePersisted<TabId>("tab", "collect");
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [capture, setCapture] = useState<LoadedCapture | null>(null);
  // 수집 탭에서 불러온 캡처. 탭을 옮겨도 분석 결과가 날아가지 않도록 여기에 둔다.
  const [loadedCapture, setLoadedCapture] = useState<{
    capture: LoadedCapture;
    name: string;
  } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2400);
  }, []);

  const save = useCallback(
    (title: string, prompt: string) => {
      const item: HistoryItem = {
        id: crypto.randomUUID(),
        tab,
        title: title.trim() || "제목 없음",
        prompt,
        createdAt: Date.now(),
      };
      const next = [item, ...history].slice(0, 30);
      setHistory(next);
      saveHistory(next);
      flash("보관함에 저장했습니다.");
    },
    [history, tab, flash],
  );

  // 캡처한 화면을 UI 재구성 탭의 입력 이미지로 넘긴다.
  const useImages = useCallback(
    (next: ImageAsset[]) => {
      if (next.length === 0) return;
      setImages(next);
      setTab("ui");
      flash(`화면 ${next.length}장을 UI 재구성 탭으로 보냈습니다.`);
    },
    [setTab, flash],
  );

  const useCapture = useCallback(
    (loaded: LoadedCapture) => {
      setCapture(loaded);
      setTab("api");
      flash(
        `캡처를 연결했습니다 — 엔드포인트 ${loaded.har.endpoints.length}개가 API 역설계 탭에 들어갔습니다.`,
      );
    },
    [setTab, flash],
  );

  const remove = (id: string) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    saveHistory(next);
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <h1 className="text-sm font-semibold tracking-tight text-ink-100">
            web<span className="text-accent-400">-</span>extractor
          </h1>
          <p className="hidden text-xs text-ink-400 sm:block">
            화면과 동작에서 구현 사양을 뽑아내는 작업대
          </p>
          <div className="ml-auto flex items-center gap-2">
            {capture && (
              <span
                className="rounded-full border border-emerald-800 bg-emerald-950 px-2.5 py-0.5 text-[11px] text-emerald-300"
                title={capture.bundle.seed}
              >
                캡처 연결됨 · 엔드포인트 {capture.har.endpoints.length}
              </span>
            )}
            <Button variant="ghost" onClick={() => setShowHistory((s) => !s)}>
              보관함 {history.length > 0 && `(${history.length})`}
            </Button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-[110rem] gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={`rounded-lg px-3 py-2 text-left whitespace-nowrap transition-colors ${
                  active
                    ? "bg-ink-800 text-ink-100"
                    : "text-ink-400 hover:bg-ink-900 hover:text-ink-200"
                }`}
              >
                <span className="block text-xs font-semibold">{t.label}</span>
                <span className="block text-[11px] text-ink-400">{t.desc}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {showHistory && (
        <div className="mx-auto max-w-[110rem] px-4 pt-4 sm:px-6">
          <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">보관함</h2>
              <Button variant="ghost" onClick={() => setShowHistory(false)}>
                닫기
              </Button>
            </div>
            {history.length === 0 ? (
              <p className="text-xs text-ink-400">
                저장한 프롬프트가 없습니다. 프롬프트 패널의 &ldquo;보관함에 저장&rdquo;을
                눌러 보세요. (이 브라우저에만 저장됩니다.)
              </p>
            ) : (
              <ul className="divide-y divide-ink-800">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink-200">{h.title}</p>
                      <p className="text-[11px] text-ink-400">
                        {TABS.find((t) => t.id === h.tab)?.label ?? h.tab} ·{" "}
                        {new Date(h.createdAt).toLocaleString("ko-KR")} ·{" "}
                        {h.prompt.length.toLocaleString()}자
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => void navigator.clipboard.writeText(h.prompt)}
                    >
                      복사
                    </Button>
                    <Button variant="ghost" onClick={() => remove(h.id)}>
                      삭제
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[110rem] px-4 py-4 sm:px-6">
        {tab === "collect" && <CollectTab
              loaded={loadedCapture}
              onLoaded={setLoadedCapture}
              onUseCapture={useCapture}
              onUseImages={useImages}
            />}
        {tab === "ui" && <UiTab images={images} setImages={setImages} onSave={save} />}
        {tab === "nav" && <NavTab onSave={save} seedHint={capture?.bundle.seed} />}
        {tab === "api" && <ApiTab onSave={save} capture={capture} />}
      </main>

      <footer className="mx-auto max-w-[110rem] px-4 py-8 text-[11px] text-ink-400 sm:px-6">
        모든 처리는 브라우저 안에서 일어납니다. 캡처·이미지·HAR 은 서버로 전송되지 않습니다.
      </footer>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full border border-ink-600 bg-ink-800 px-4 py-2 text-xs text-ink-100 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
