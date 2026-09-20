import { useCallback, useEffect, useRef, useState } from "react";
import { collector, detectMode } from "../lib/collector";
import type { CollectorForm, CollectorStatus } from "../lib/collector";
import { usePersisted } from "../lib/storage";
import { Badge, Button, Card, Field, TextArea, TextInput, Toggle } from "./ui";

const DEFAULT_FORM: CollectorForm = {
  seed: "",
  include: "",
  exclude: "**/logout**\n**/delete/**\n**/sign-out**",
  maxPages: 200,
  maxDepth: 3,
  delayMs: 1500,
  sameOriginOnly: true,
  respectRobots: true,
  maskSecrets: true,
  captureHtml: true,
  captureAssets: true,
  captureImages: false,
  captureScreenshots: true,
};

export function CollectorPanel({
  onBundle,
}: {
  onBundle: (json: string, name: string) => void;
}) {
  const [{ mode, version }, setDetected] = useState(() => detectMode());
  const [form, , patch] = usePersisted<CollectorForm>("collectorForm", DEFAULT_FORM);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 수집할 권한이 있다는 확인. 일부러 저장하지 않는다 — 실행할 때마다 다시 체크하게 한다.
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // 확장이 표식을 심는 타이밍이 어긋날 수 있어 잠깐 더 확인한다.
  useEffect(() => {
    if (mode !== "none") return;
    let tries = 0;
    const timer = setInterval(() => {
      const next = detectMode();
      if (next.mode !== "none" || ++tries > 10) {
        clearInterval(timer);
        if (next.mode !== "none") setDetected(next);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [mode]);

  const poll = useCallback(async () => {
    if (mode === "none") return;
    try {
      const s = await collector.status();
      setStatus(s);
      if (s?.running) pollRef.current = window.setTimeout(() => void poll(), 1000);
    } catch {
      /* 서비스 워커가 잠들었을 수 있다 — 다음 동작 때 다시 시도한다. */
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "none") void poll();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [mode, poll]);

  const validate = (): string | null => {
    if (!form.seed.trim()) return "시작 URL 을 입력해 주세요.";
    try {
      new URL(form.seed);
    } catch {
      return "시작 URL 이 올바르지 않습니다. https:// 로 시작하는 전체 주소를 넣어 주세요.";
    }
    return null;
  };

  // 권한 창은 사용자 제스처에서만 뜬다. 클릭 핸들러가 끝나기 전에 호출해야 한다.
  const start = (manual = false) => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setNotice(null);
    void collector
      .start(form, { manual })
      .then((res) => {
        if (res.started) {
          setNotice(
            manual
              ? "수동 탐색을 시작했습니다. 새 탭에서 직접 클릭하며 돌아다니세요 — 보이는 화면과 요청을 모두 기록합니다. 끝나면 '중단' 을 누르세요."
              : "수집을 시작했습니다. 새 탭이 한 페이지씩 이동합니다.",
          );
          void poll();
        } else {
          setError(res.reason ?? "시작하지 못했습니다.");
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const sendConfig = async () => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      await collector.prefill(form);
      setNotice(
        "설정을 확장에 보냈습니다. 확장 팝업의 “앱 열기” 를 눌러 확장 안의 앱에서 시작하세요 — 설정은 그대로 채워져 있습니다.",
      );
      void poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pull = async () => {
    setError(null);
    try {
      const bundle = await collector.exportBundle();
      if (!bundle) {
        setError("확장에 아직 수집된 데이터가 없습니다.");
        return;
      }
      const seed = (bundle as { seed?: string }).seed ?? "capture";
      onBundle(JSON.stringify(bundle), `${seed} (확장에서 직접)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (mode === "none") return <NotConnected />;

  const running = status?.running ?? false;
  const hasData = !!status && (status.pages > 0 || status.net > 0);

  return (
    <Card
      title="수집기"
      subtitle={
        mode === "extension"
          ? `collector v${version} · 이 앱이 확장 안에서 돌고 있어 여기서 바로 시작할 수 있습니다`
          : `collector v${version} · 개발 서버 모드 — 시작은 확장 팝업에서 합니다`
      }
      right={
        <>
          <Badge tone="good">{mode === "extension" ? "확장 내장" : "연결됨"}</Badge>
          {hasData && (
            <Button variant="primary" onClick={() => void pull()}>
              결과 가져오기
            </Button>
          )}
          {running && (
            <Button variant="danger" onClick={() => void collector.stop().then(poll)}>
              중단
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="시작 URL">
            <TextInput
              value={form.seed}
              onChange={(e) => patch({ seed: e.target.value })}
              placeholder="https://app.example.com/dashboard"
              spellCheck={false}
            />
          </Field>
          <Field label="포함 패턴" hint="줄바꿈으로 구분. 비우면 같은 오리진 전체.">
            <TextArea
              rows={2}
              value={form.include}
              onChange={(e) => patch({ include: e.target.value })}
              placeholder={"https://app.example.com/orders/**\nhttps://app.example.com/customers/**"}
              className="font-mono text-[11px]"
            />
          </Field>
          <Field label="제외 패턴" hint="되돌릴 수 없는 경로는 여기에 넣어 두세요.">
            <TextArea
              rows={2}
              value={form.exclude}
              onChange={(e) => patch({ exclude: e.target.value })}
              className="font-mono text-[11px]"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="최대 페이지">
              <TextInput
                type="number"
                min={1}
                max={500}
                value={form.maxPages}
                onChange={(e) => patch({ maxPages: Number(e.target.value) || 40 })}
              />
            </Field>
            <Field label="최대 깊이">
              <TextInput
                type="number"
                min={1}
                max={10}
                value={form.maxDepth}
                onChange={(e) => patch({ maxDepth: Number(e.target.value) || 3 })}
              />
            </Field>
            <Field label="간격 (ms)">
              <TextInput
                type="number"
                min={0}
                step={250}
                value={form.delayMs}
                onChange={(e) => patch({ delayMs: Number(e.target.value) || 1500 })}
              />
            </Field>
          </div>
          <div>
            <Toggle
              checked={form.sameOriginOnly}
              onChange={(sameOriginOnly) => patch({ sameOriginOnly })}
              label="같은 오리진만"
            />
            <Toggle
              checked={form.respectRobots}
              onChange={(respectRobots) => patch({ respectRobots })}
              label="robots.txt 존중"
            />
            <Toggle
              checked={form.maskSecrets}
              onChange={(maskSecrets) => patch({ maskSecrets })}
              label="토큰·쿠키 값 가리기"
            />
            <Toggle
              checked={form.captureHtml}
              onChange={(captureHtml) => patch({ captureHtml })}
              label="HTML 전문 저장"
            />
            <Toggle
              checked={form.captureAssets}
              onChange={(captureAssets) => patch({ captureAssets })}
              label="CSS·JS·폰트 본문도 받기"
            />
            <Toggle
              checked={form.captureImages}
              onChange={(captureImages) => patch({ captureImages })}
              label="이미지까지 받기 (용량 큼)"
            />
            <Toggle
              checked={form.captureScreenshots}
              onChange={(captureScreenshots) => patch({ captureScreenshots })}
              label="페이지마다 화면 캡처"
            />
          </div>
          <p className="text-[11px] text-ink-400">
            HTML 만으로는 화면을 되살릴 수 없습니다 — <b className="text-ink-300">CSS·JS·폰트</b>는
            페이지가 직접 받는 것이라 요청 후킹에 잡히지 않아, 순회가 끝난 뒤 따로 받아 둡니다.
            화면 캡처는 UI 재구성의 시각 기준이 됩니다.
          </p>

          {mode === "extension" ? (
            <>
              <Toggle
                checked={authorized}
                onChange={setAuthorized}
                label="이 사이트를 수집할 권한이 있습니다"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => start(false)}
                  disabled={running || !authorized}
                  className="flex-1 py-2 text-sm"
                >
                  {running ? "수집 중…" : "수집 시작"}
                </Button>
                <Button
                  onClick={() => start(true)}
                  disabled={running || !authorized}
                  className="flex-1 py-2 text-sm"
                  title="자동으로 이동하지 않고, 내가 직접 클릭하며 여는 화면만 기록합니다"
                >
                  수동 탐색 모드
                </Button>
              </div>
              <p className="text-[11px] text-ink-400">
                처음 시작할 때 해당 사이트 접근 권한을 한 번 묻습니다. 대상 사이트에 미리
                로그인해 두세요.{" "}
                <b className="text-ink-300">수동 탐색 모드</b>는 링크로 갈 수 없는 화면(로그인 후
                화면, 버튼으로만 열리는 모달)을 직접 돌며 담을 때 씁니다.
              </p>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={() => void sendConfig()} className="w-full py-2 text-sm">
                이 설정을 확장으로 보내기
              </Button>
              <p className="text-[11px] text-ink-400">
                개발 서버로 열린 페이지에서는 Chrome 이 권한 창을 띄워주지 않습니다.{" "}
                <b className="text-ink-300">확장 안의 앱</b>으로 열면 여기서 바로 시작할 수
                있습니다 — 확장 팝업의 &ldquo;앱 열기&rdquo;를 눌러 보세요.
              </p>
            </>
          )}

          {notice && (
            <p className="rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
              {notice}
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">진행 상황</p>
          {!status ? (
            <p className="text-xs text-ink-400">아직 수집을 시작하지 않았습니다.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    [
                      "상태",
                      !running
                        ? status.finishedAt
                          ? "완료"
                          : "대기"
                        : status.phase === "assets"
                          ? `정적 리소스 ${status.assets}개`
                          : status.manual
                            ? `수동 탐색 중 (${status.pages})`
                            : `수집 중 ${status.visited}/${status.maxPages}`,
                    ],
                    ["페이지", String(status.pages)],
                    [
                      "발견 / 미방문",
                      `${status.discovered ?? status.visited} / ${Math.max(
                        (status.discovered ?? status.visited) - status.visited,
                        0,
                      )}`,
                    ],
                    ["잡은 요청", String(status.net)],
                    ["정적 리소스", String(status.assets ?? 0)],
                    ["화면 캡처", String(status.shots ?? 0)],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                    <p className="text-[11px] text-ink-400">{k}</p>
                    <p className="mt-0.5 text-sm font-medium text-ink-100">{v}</p>
                  </div>
                ))}
              </div>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[10px] whitespace-pre-wrap text-ink-400">
                {status.log
                  .map((l) => `${new Date(l.at).toLocaleTimeString("ko-KR")} ${l.message}`)
                  .join("\n")}
              </pre>
              {!running && status.finishedAt && (
                <Button
                  variant="ghost"
                  className="mt-2"
                  onClick={() => void collector.reset().then(() => setStatus(null))}
                >
                  수집 기록 비우기
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function NotConnected() {
  return (
    <Card title="수집기 확장이 연결되지 않았습니다">
      <p className="text-xs leading-relaxed text-ink-300">
        <code className="text-accent-300">run.bat</code> (Windows) 또는{" "}
        <code className="text-accent-300">./run.sh</code> (macOS·Linux) 로 실행하면 확장이 로드된
        브라우저가 자동으로 열립니다. 지금 창이 그렇게 열린 창이 아니라면 그 런처로 다시 실행해
        주세요.
      </p>
      <p className="mt-2 text-[11px] text-ink-400">
        확장 없이도 이 탭에서 캡처 파일을 열어 분석할 수 있고, 나머지 세 탭은 그대로 동작합니다.
      </p>
    </Card>
  );
}
