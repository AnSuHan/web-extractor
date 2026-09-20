import { useMemo, useRef, useState } from "react";
import { loadCapture, buildSiteTree, collectForms } from "../lib/capture";
import type { LoadedCapture, SiteNode } from "../lib/capture";
import { inferBackend, inferenceToMarkdown, modelsToTypeScript } from "../lib/infer";
import { Badge, Button, Card, Toggle } from "./ui";
import { CollectorPanel } from "./CollectorPanel";
import { download } from "./PromptPanel";

type View = "overview" | "sitemap" | "endpoints" | "models" | "backend" | "forms" | "setup";

export function CollectTab({
  onUseCapture,
}: {
  onUseCapture: (capture: LoadedCapture) => void;
}) {
  const [capture, setCapture] = useState<LoadedCapture | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [includeAssets, setIncludeAssets] = useState(false);
  const [view, setView] = useState<View>("setup");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadJson = (json: string, name: string, assets = includeAssets) => {
    setError(null);
    try {
      setCapture(loadCapture(json, assets));
      setFileName(name);
      setView("overview");
    } catch (err) {
      setCapture(null);
      setFileName("");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const load = async (file: File | undefined, assets = includeAssets) => {
    if (!file) return;
    loadJson(await file.text(), file.name, assets);
  };

  const inference = useMemo(() => {
    if (!capture) return null;
    return inferBackend(capture.har.endpoints, {
      responseHeaders: capture.responseHeaders,
      cookieNames: capture.cookieNames,
      frontend: capture.frontend,
    });
  }, [capture]);

  const tree = useMemo(
    () => (capture ? buildSiteTree(capture.bundle.pages) : null),
    [capture],
  );

  const VIEWS: { id: View; label: string }[] = [
    { id: "setup", label: "수집기" },
    ...(capture
      ? ([
          { id: "overview", label: "개요" },
          { id: "sitemap", label: "사이트맵" },
          { id: "endpoints", label: "엔드포인트" },
          { id: "models", label: "데이터 모델" },
          { id: "backend", label: "백엔드 추론" },
          { id: "forms", label: "폼·컨트롤" },
        ] as { id: View; label: string }[])
      : []),
  ];

  return (
    <div className="space-y-4">
      <CollectorPanel onBundle={(json, name) => loadJson(json, name)} />

      <Card
        title="캡처 불러오기"
        subtitle="collector 확장의 '결과 저장'으로 만든 .json"
        right={
          capture && (
            <>
              <Badge tone="good">
                페이지 {capture.bundle.stats.pages} · 요청 {capture.har.endpoints.length}
              </Badge>
              <Button
                variant="primary"
                onClick={() => onUseCapture(capture)}
                title="이 캡처를 다른 탭들의 입력으로 씁니다"
              >
                이 캡처로 프롬프트 만들기
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCapture(null);
                  setFileName("");
                  setView("setup");
                }}
              >
                비우기
              </Button>
            </>
          )
        }
      >
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void load(e.dataTransfer.files[0]);
          }}
          onClick={() => inputRef.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-ink-700 bg-ink-850 px-4 py-6 text-center hover:border-ink-600"
        >
          <p className="text-sm text-ink-200">
            {fileName || "캡처 .json 을 끌어다 놓거나 클릭해 선택"}
          </p>
          <p className="mt-1 text-xs text-ink-400">
            브라우저 안에서만 파싱됩니다. 어디에도 업로드되지 않습니다.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              void load(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {error && (
          <p className="mt-2 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
        {capture && (
          <div className="mt-3">
            <Toggle
              checked={includeAssets}
              onChange={(v) => {
                setIncludeAssets(v);
                setCapture(null);
                setFileName("");
                setView("setup");
              }}
              label="이미지·CSS·JS 등 정적 자산도 엔드포인트로 집계"
              hint="켜면 캡처 파일을 다시 선택해 주세요."
            />
          </div>
        )}
      </Card>

      <nav className="flex flex-wrap gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === v.id
                ? "bg-accent-500 text-ink-950"
                : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            }`}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {view === "setup" && <SetupGuide />}
      {capture && inference && (
        <>
          {view === "overview" && <Overview capture={capture} />}
          {view === "sitemap" && tree && <Sitemap node={tree} />}
          {view === "endpoints" && <Endpoints capture={capture} />}
          {view === "models" && <Models inference={inference} />}
          {view === "backend" && <Backend inference={inference} />}
          {view === "forms" && <Forms capture={capture} />}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SetupGuide() {
  const steps: [string, React.ReactNode][] = [
    [
      "런처로 실행",
      <>
        <code className="text-accent-300">시작.bat</code> (Windows) 또는{" "}
        <code className="text-accent-300">./start.sh</code> (macOS·Linux) 를 실행하면 끝입니다.
        의존성 설치, 서버 기동, <b>확장이 로드된 브라우저 실행</b>까지 한 번에 처리합니다.
        Node 가 없으면 이 폴더 안에 받아서 씁니다 — 시스템에는 아무것도 설치하지 않습니다.
      </>,
    ],
    [
      "대상 사이트에 로그인",
      <>
        열린 브라우저에서 대상 앱에 <b>평소처럼 직접 로그인</b>합니다. 전용 프로필이라 다음
        실행에도 세션이 유지됩니다. 수집은 이 세션을 그대로 쓰므로 탐지할 봇이 없습니다.
      </>,
    ],
    [
      "범위 입력 후 확장으로 보내기",
      <>
        위 <b>수집기</b> 패널에 시작 URL·범위를 넣고 <b>확장으로 보내기</b> → 확장 아이콘을 눌러
        권한 확인 체크 후 <b>수집 시작</b>. 새 탭이 한 페이지씩 이동합니다.
      </>,
    ],
    [
      "결과 가져오기",
      <>
        패널의 <b>결과 바로 가져오기</b> 를 누르면 파일 저장 없이 분석됩니다. 확장 팝업의{" "}
        <b>결과 저장</b> 으로 <code className="text-accent-300">.json</code> 을 받아 보관해도 됩니다.
      </>,
    ],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="실행 순서">
        <ol className="space-y-3">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-500 text-[11px] font-bold text-ink-950">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-100">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="space-y-4">
        <Card title="왜 이 방식이 차단되지 않는가">
          <ul className="space-y-2 text-xs leading-relaxed text-ink-300">
            <li>
              <b className="text-ink-100">진짜 브라우저, 진짜 세션.</b> Headless 지문도,
              자동화 플래그도, 위조한 User-Agent 도 없습니다. 서버 입장에서는 로그인한 사용자가
              페이지를 넘기는 것과 구분되지 않습니다.
            </li>
            <li>
              <b className="text-ink-100">페이지 안에서 가로챕니다.</b> 앱 자신의{" "}
              <code>fetch</code>/<code>XHR</code> 을 감싸므로 CORS 가 응답 본문을 가리지
              않습니다. 프록시도, 인증서 설치도 필요 없습니다.
            </li>
            <li>
              <b className="text-ink-100">정중하게 돕니다.</b> 동시 요청 1개, 페이지 간 간격
              기본 1.5초, robots.txt 의 <code>Crawl-delay</code> 가 더 느리면 그쪽을 따릅니다.
              레이트 리밋에 걸릴 속도가 아닙니다.
            </li>
          </ul>
        </Card>

        <Card title="안전 설계">
          <ul className="space-y-2 text-xs leading-relaxed text-ink-300">
            <li>
              <b className="text-ink-100">버튼을 누르지 않습니다.</b> 순회는{" "}
              <code>&lt;a href&gt;</code> 로 발견한 URL 만 GET 으로 방문합니다. 삭제·결제·상태
              변경 같은 되돌릴 수 없는 동작을 우발적으로 실행할 수 없는 구조입니다.
            </li>
            <li>
              <b className="text-ink-100">권한은 오리진 단위.</b> 확장은{" "}
              <code>&lt;all_urls&gt;</code> 를 요구하지 않습니다. 시작할 때 그 사이트에
              대해서만 권한을 요청하고, 끝나면 스크립트 등록을 해제합니다.
            </li>
            <li>
              <b className="text-ink-100">토큰은 값을 가립니다.</b> Authorization·Cookie 류
              헤더는 이름만 남고 값은{" "}
              <code className="text-accent-300">&lt;redacted:N chars&gt;</code> 가 됩니다.
              저장 파일에 실토큰이 남지 않습니다.
            </li>
            <li>
              <b className="text-ink-100">폼 입력값은 수집하지 않습니다.</b> 필드의 이름·타입·
              제약만 가져옵니다.
            </li>
          </ul>
        </Card>

        <Card title="한계 — 미리 알아두면 좋은 것">
          <ul className="space-y-2 text-xs leading-relaxed text-ink-300">
            <li>
              브라우저가 자동으로 붙이는 <b>쿠키는 후킹에 보이지 않습니다.</b> 쿠키 세션 방식이면
              인증 헤더가 비어 보일 수 있습니다.
            </li>
            <li>
              <b>교차 출처</b> 응답 헤더는 CORS 가 일부만 노출합니다. API 가 다른 도메인이면
              서버 지문이 얇게 나옵니다.
            </li>
            <li>
              WebSocket·Server-Sent Events·서비스 워커 내부 요청은 잡히지 않습니다.
            </li>
            <li>
              링크로 도달할 수 없는 화면(버튼으로만 열리는 모달 등)은 자동 순회가 못 갑니다.
              그 부분은 직접 클릭하며 돌면 그대로 수집됩니다 — 확장은 계속 듣고 있습니다.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Overview({ capture }: { capture: LoadedCapture }) {
  const { bundle, har } = capture;
  const stats: [string, string][] = [
    ["방문한 페이지", String(bundle.stats.pages)],
    ["고유 엔드포인트", String(har.endpoints.length)],
    ["전체 요청", String(bundle.stats.requests)],
    ["건너뛴 URL", String(bundle.stats.skipped)],
    ["소요 시간", `${Math.round(bundle.stats.durationMs / 1000)}초`],
    ["호스트", har.hosts.join(", ") || "–"],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="수집 요약" subtitle={bundle.seed}>
        <dl className="grid grid-cols-2 gap-3">
          {stats.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              <dt className="text-[11px] text-ink-400">{k}</dt>
              <dd className="mt-0.5 truncate text-sm font-medium text-ink-100" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        {capture.frontend.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium text-ink-300">프런트엔드 지문</p>
            <div className="flex flex-wrap gap-1.5">
              {capture.frontend.map((f) => (
                <Badge key={f} tone="good">
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="진행 로그"
        subtitle={bundle.skipped.length ? `건너뛴 URL ${bundle.skipped.length}건 포함` : undefined}
      >
        <pre className="max-h-64 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] whitespace-pre-wrap text-ink-400">
          {bundle.log.map((l) => `${new Date(l.at).toLocaleTimeString("ko-KR")} ${l.message}`).join("\n")}
        </pre>
        {bundle.skipped.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-ink-400 hover:text-ink-200">
              건너뛴 URL 보기
            </summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[10px] text-ink-400">
              {bundle.skipped.slice(0, 200).map((s, i) => (
                <li key={i} className="break-all">
                  <span className="text-ink-500">[{s.reason}]</span> {s.url}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Sitemap({ node }: { node: SiteNode }) {
  return (
    <Card title="사이트맵" subtitle="방문한 URL 을 경로 트리로 접은 것">
      <div className="max-h-[32rem] overflow-auto font-mono text-xs">
        <TreeNode node={node} depth={0} />
      </div>
    </Card>
  );
}

function TreeNode({ node, depth }: { node: SiteNode; depth: number }) {
  const children = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  return (
    <div>
      <div
        className="flex items-baseline gap-2 py-0.5"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <span className={node.pages.length ? "text-ink-100" : "text-ink-400"}>
          /{node.segment === "/" ? "" : node.segment}
        </span>
        {node.pages.length > 0 && (
          <span className="text-[10px] text-accent-400">
            {node.pages.length}개 화면
          </span>
        )}
        {node.pages[0]?.title && (
          <span className="truncate text-[10px] text-ink-400">{node.pages[0].title}</span>
        )}
      </div>
      {children.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Endpoints({ capture }: { capture: LoadedCapture }) {
  const [selected, setSelected] = useState(0);
  const endpoints = capture.har.endpoints;
  const current = endpoints[selected];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <Card title={`엔드포인트 ${endpoints.length}개`}>
        <div className="max-h-[32rem] overflow-auto">
          {endpoints.map((e, i) => (
            <button
              key={`${e.method} ${e.host}${e.path}`}
              type="button"
              onClick={() => setSelected(i)}
              className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] ${
                i === selected ? "bg-ink-800" : "hover:bg-ink-850"
              }`}
            >
              <span className="w-12 shrink-0 text-accent-300">{e.method}</span>
              <span className="min-w-0 flex-1 break-all text-ink-200">{e.path}</span>
              <span className="shrink-0 text-ink-400">{e.status}</span>
            </button>
          ))}
        </div>
      </Card>

      {current && (
        <Card title={`${current.method} ${current.path}`} subtitle={current.host}>
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <Badge>{current.status}</Badge>
              {current.mimeType && <Badge>{current.mimeType.split(";")[0]}</Badge>}
              {current.count > 1 && <Badge>관측 {current.count}회</Badge>}
              {current.authHeaders.map((h) => (
                <Badge key={h} tone="warn">
                  {h}
                </Badge>
              ))}
            </div>
            {current.queryKeys.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-ink-300">쿼리 파라미터</p>
                <p className="font-mono text-ink-200">{current.queryKeys.join(", ")}</p>
              </div>
            )}
            {current.requestBodySample && (
              <div>
                <p className="mb-1 font-medium text-ink-300">요청 본문</p>
                <pre className="max-h-48 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] text-ink-200">
                  {current.requestBodySample}
                </pre>
              </div>
            )}
            {current.responseBodySample && (
              <div>
                <p className="mb-1 font-medium text-ink-300">응답 본문</p>
                <pre className="max-h-80 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] text-ink-200">
                  {current.responseBodySample}
                </pre>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Models({ inference }: { inference: ReturnType<typeof inferBackend> }) {
  const ts = useMemo(() => modelsToTypeScript(inference.models), [inference]);
  return (
    <Card
      title={`데이터 모델 ${inference.models.length}개`}
      subtitle="응답 본문에서 되짚은 타입. 선택적 필드·형식 힌트까지 표시합니다."
      right={
        <>
          <Button onClick={() => download("inferred-models.ts", ts)}>.ts 저장</Button>
          <Button variant="primary" onClick={() => void navigator.clipboard.writeText(ts)}>
            복사
          </Button>
        </>
      }
    >
      <pre className="max-h-[36rem] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-[12px] leading-relaxed text-ink-200">
        {ts}
      </pre>
    </Card>
  );
}

function Backend({ inference }: { inference: ReturnType<typeof inferBackend> }) {
  const md = useMemo(() => inferenceToMarkdown(inference), [inference]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card title="API 스타일">
          <p className="text-lg font-semibold text-ink-100">{inference.style}</p>
          <p className="mt-1 text-xs text-ink-400">{inference.styleEvidence}</p>
        </Card>
        <Card title="인증">
          <ul className="space-y-2">
            {inference.auth.map((a, i) => (
              <li key={i} className="text-xs">
                <span className="text-ink-100">{a.claim}</span>
                <span className="block text-ink-400">{a.evidence}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="스택 지문" subtitle="헤더·쿠키·DOM 마커에서">
          {inference.stack.length === 0 ? (
            <p className="text-xs text-ink-400">
              단서가 없습니다. 서버가 헤더를 숨기고 있거나, API 가 교차 출처라 헤더가 가려진
              경우입니다.
            </p>
          ) : (
            <ul className="space-y-2">
              {inference.stack.map((s, i) => (
                <li key={i} className="text-xs">
                  <span className="text-ink-100">{s.claim}</span>
                  <span className="block font-mono text-[10px] text-ink-400">{s.evidence}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="보고서"
        right={
          <>
            <Button onClick={() => download("backend-inference.md", md)}>.md 저장</Button>
            <Button variant="primary" onClick={() => void navigator.clipboard.writeText(md)}>
              복사
            </Button>
          </>
        }
      >
        <pre className="max-h-[36rem] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-[12px] whitespace-pre-wrap text-ink-200">
          {md}
        </pre>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Forms({ capture }: { capture: LoadedCapture }) {
  const forms = useMemo(() => collectForms(capture.bundle.pages), [capture]);
  const controls = capture.bundle.pages.flatMap((p) =>
    p.controls.map((c) => ({ ...c, pageUrl: p.url })),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`폼 ${forms.length}개`} subtitle="값은 수집하지 않습니다 — 이름·타입·제약만">
        <div className="max-h-[32rem] space-y-3 overflow-auto">
          {forms.length === 0 && <p className="text-xs text-ink-400">수집된 폼이 없습니다.</p>}
          {forms.map((f, i) => (
            <div key={i} className="rounded-lg border border-ink-700 bg-ink-850 p-3">
              <p className="font-mono text-[11px] text-accent-300">
                {f.method} {f.action ?? "(action 없음)"}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-ink-400">{f.pageUrl}</p>
              <ul className="mt-2 space-y-0.5">
                {f.fields.map((field, j) => (
                  <li key={j} className="font-mono text-[11px] text-ink-200">
                    {field.name}
                    <span className="text-ink-400">
                      : {field.type ?? field.tag}
                      {field.required && " *필수"}
                      {field.maxLength && ` max=${field.maxLength}`}
                      {field.options && ` (${field.options.length}개 옵션)`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card title={`컨트롤 ${controls.length}개`} subtitle="버튼·탭·메뉴 — 누르지는 않았습니다">
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <tbody>
              {controls.slice(0, 400).map((c, i) => (
                <tr key={i} className="border-b border-ink-800 last:border-0">
                  <td className="px-2 py-1 text-ink-200">{c.name}</td>
                  <td className="px-2 py-1 text-right text-ink-400">{c.role ?? c.tag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
