import { useMemo, useRef, useState } from "react";
import { buildApiPrompt } from "../lib/prompts";
import { parseHar } from "../lib/har";
import type { HarParseResult } from "../lib/har";
import type { ApiOptions } from "../lib/types";
import type { LoadedCapture } from "../lib/capture";
import { usePersisted } from "../lib/storage";
import { Badge, Button, Card, Field, Segmented, Select, TextArea, TextInput, Toggle } from "./ui";
import { PromptPanel } from "./PromptPanel";
import { RunPanel } from "./RunPanel";

export const DEFAULT_API_OPTIONS: ApiOptions = {
  baseUrl: "",
  lang: "typescript",
  auth: "auto",
  includeTypes: true,
  includeRetry: true,
  redactSecrets: true,
  extra: "",
};

export function ApiTab({
  onSave,
  capture,
}: {
  onSave: (title: string, prompt: string) => void;
  capture?: LoadedCapture | null;
}) {
  const [opts, , patch] = usePersisted<ApiOptions>("apiOptions", DEFAULT_API_OPTIONS);
  const [har, setHar] = useState<HarParseResult | null>(null);
  const [harName, setHarName] = useState("");
  const [includeAssets, setIncludeAssets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadHar = async (file: File | undefined, assets = includeAssets) => {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setHar(parseHar(text, assets));
      setHarName(file.name);
    } catch (err) {
      setHar(null);
      setHarName("");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 직접 올린 HAR 이 있으면 그걸 쓰고, 없으면 '수집' 탭에서 연결한 캡처를 쓴다.
  const endpoints = har?.endpoints ?? capture?.har.endpoints ?? [];
  const prompt = useMemo(() => buildApiPrompt(opts, endpoints), [opts, endpoints]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        {capture && !har && (
          <div className="rounded-xl border border-emerald-900 bg-emerald-950/40 px-4 py-3 text-xs leading-relaxed text-emerald-200">
            <strong className="text-emerald-100">수집 탭의 캡처를 쓰고 있습니다.</strong>{" "}
            <span className="font-mono">{capture.bundle.seed}</span> — 엔드포인트{" "}
            {capture.har.endpoints.length}개. 아래에 HAR 을 직접 올리면 그쪽이 우선합니다.
          </div>
        )}
        <Card
          title="HAR 캡처"
          subtitle="DevTools → Network → 우클릭 → Save all as HAR with content"
          right={
            har && (
              <Button
                variant="ghost"
                onClick={() => {
                  setHar(null);
                  setHarName("");
                }}
              >
                비우기
              </Button>
            )
          }
        >
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void loadHar(e.dataTransfer.files[0]);
            }}
            onClick={() => inputRef.current?.click()}
            className="cursor-pointer rounded-xl border-2 border-dashed border-ink-700 bg-ink-850 px-4 py-6 text-center hover:border-ink-600"
          >
            <p className="text-sm text-ink-200">
              {harName || ".har 파일을 끌어다 놓거나 클릭해 선택"}
            </p>
            <p className="mt-1 text-xs text-ink-400">
              파일은 브라우저 안에서만 파싱됩니다. 어디에도 업로드되지 않습니다.
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".har,application/json"
              hidden
              onChange={(e) => {
                void loadHar(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          {error && (
            <p className="mt-2 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {har && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="good">엔드포인트 {har.endpoints.length}</Badge>
                <Badge>전체 요청 {har.totalEntries}</Badge>
                {har.skippedAssets > 0 && (
                  <Badge>정적 자산 {har.skippedAssets} 제외</Badge>
                )}
                {har.credentialWarning && (
                  <Badge tone="warn">인증 헤더 포함 — 아래 마스킹 확인</Badge>
                )}
              </div>

              <Toggle
                checked={includeAssets}
                onChange={(v) => {
                  setIncludeAssets(v);
                  // 같은 파일을 새 설정으로 다시 읽어야 하므로 재선택을 안내한다.
                  setHar(null);
                  setHarName("");
                }}
                label="이미지·CSS·JS 등 정적 자산도 포함"
                hint="켜면 HAR 를 다시 선택해 주세요."
              />

              {har.hosts.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-300">호스트</p>
                  <div className="flex flex-wrap gap-1.5">
                    {har.hosts.map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => patch({ baseUrl: `https://${h}` })}
                        className="rounded-md border border-ink-600 bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-ink-200 hover:border-accent-500"
                        title="base URL 로 설정"
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="max-h-64 overflow-auto rounded-lg border border-ink-700 bg-ink-950">
                <table className="w-full text-left font-mono text-[11px]">
                  <tbody>
                    {har.endpoints.map((e) => (
                      <tr key={`${e.method} ${e.host}${e.path}`} className="border-b border-ink-800 last:border-0">
                        <td className="px-2 py-1 text-accent-300 align-top">{e.method}</td>
                        <td className="px-2 py-1 break-all text-ink-200">{e.path}</td>
                        <td className="px-2 py-1 text-right align-top text-ink-400">
                          {e.status}
                          {e.count > 1 && ` ×${e.count}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>

        <Card title="생성 옵션">
          <div className="space-y-4">
            <Field label="Base URL" hint="비우면 캡처에서 추론하게 합니다.">
              <TextInput
                value={opts.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://api.example.com"
                spellCheck={false}
              />
            </Field>
            <Field label="클라이언트 언어">
              <Select
                value={opts.lang}
                onChange={(lang) => patch({ lang })}
                options={[
                  { value: "typescript", label: "TypeScript (fetch)" },
                  { value: "python", label: "Python (httpx)" },
                  { value: "go", label: "Go (net/http)" },
                  { value: "curl", label: "curl 명령" },
                ]}
              />
            </Field>
            <Field label="인증 방식">
              <Segmented
                value={opts.auth}
                onChange={(auth) => patch({ auth })}
                options={[
                  { value: "auto", label: "자동 판별" },
                  { value: "bearer", label: "Bearer" },
                  { value: "cookie", label: "쿠키" },
                  { value: "apikey", label: "API 키" },
                  { value: "none", label: "없음" },
                ]}
              />
            </Field>
            <div className="border-t border-ink-700 pt-2">
              <Toggle
                checked={opts.includeTypes}
                onChange={(includeTypes) => patch({ includeTypes })}
                label="요청·응답 타입 생성"
              />
              <Toggle
                checked={opts.includeRetry}
                onChange={(includeRetry) => patch({ includeRetry })}
                label="에러 처리·재시도 포함"
                hint="429 / 5xx 지수 백오프, Retry-After 존중"
              />
              <Toggle
                checked={opts.redactSecrets}
                onChange={(redactSecrets) => patch({ redactSecrets })}
                label="캡처된 토큰·쿠키를 코드에 넣지 않기"
                hint="끄면 생성 코드에 실제 자격증명이 들어갑니다."
              />
            </div>
            <Field label="추가 요구사항">
              <TextArea
                rows={3}
                value={opts.extra}
                onChange={(e) => patch({ extra: e.target.value })}
                placeholder="예: 페이지네이션은 async generator 로 감싸줘."
              />
            </Field>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <PromptPanel
          prompt={prompt}
          filename="api-reverse-prompt.md"
          onSave={() => onSave(opts.baseUrl || harName || "API 역설계", prompt)}
        />
        <RunPanel prompt={prompt} images={[]} />
      </div>
    </div>
  );
}
