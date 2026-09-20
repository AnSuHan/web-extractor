import { useState } from "react";
import { Badge, Button, Card } from "./ui";

/** 대략적인 토큰 추정. 영문 ~4자/토큰, 한글은 더 촘촘하므로 가중치를 준다. */
export function estimateTokens(text: string): number {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const rest = text.length - hangul;
  return Math.ceil(rest / 4 + hangul / 1.4);
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // 문서에 붙였다 떼야 확실히 동작하고, 해제는 미뤄야 한다 —
  // click() 직후에 revoke 하면 브라우저가 파일을 다 읽기 전에 사라져 저장이 취소된다.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PromptPanel({
  prompt,
  filename,
  onSave,
}: {
  prompt: string;
  filename: string;
  onSave?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(true);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 클립보드 권한이 없는 경우 — 사용자가 직접 선택해 복사할 수 있도록 둔다.
      setCopied(false);
    }
  };

  return (
    <Card
      title="생성된 프롬프트"
      subtitle={`${prompt.length.toLocaleString()}자 · 약 ${estimateTokens(prompt).toLocaleString()} 토큰`}
      right={
        <>
          <Button variant="ghost" onClick={() => setWrap((w) => !w)}>
            {wrap ? "줄바꿈 끄기" : "줄바꿈 켜기"}
          </Button>
          {onSave && (
            <Button variant="ghost" onClick={onSave}>
              보관함에 저장
            </Button>
          )}
          <Button onClick={() => download(filename, prompt)}>.md 저장</Button>
          <Button variant="primary" onClick={() => void copy()}>
            {copied ? "복사됨 ✓" : "복사"}
          </Button>
        </>
      }
    >
      <pre
        className={`max-h-[36rem] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-[12px] leading-relaxed text-ink-200 ${
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
        }`}
      >
        {prompt}
      </pre>
    </Card>
  );
}

export function ResultPanel({
  text,
  thinking,
  running,
  error,
  usage,
  onStop,
}: {
  text: string;
  thinking: string;
  running: boolean;
  error: string | null;
  usage: { input: number; output: number } | null;
  onStop: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  if (!text && !thinking && !running && !error) return null;

  return (
    <Card
      title="Claude 실행 결과"
      subtitle={
        usage
          ? `입력 ${usage.input.toLocaleString()} · 출력 ${usage.output.toLocaleString()} 토큰`
          : running
            ? "생성 중…"
            : undefined
      }
      right={
        <>
          {thinking && (
            <Button variant="ghost" onClick={() => setShowThinking((s) => !s)}>
              {showThinking ? "추론 숨기기" : "추론 보기"}
            </Button>
          )}
          {running ? (
            <Button variant="danger" onClick={onStop}>
              중단
            </Button>
          ) : (
            text && (
              <>
                <Button onClick={() => download("extracted-output.md", text)}>
                  저장
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void navigator.clipboard.writeText(text).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    });
                  }}
                >
                  {copied ? "복사됨 ✓" : "복사"}
                </Button>
              </>
            )
          )}
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {showThinking && thinking && (
        <pre className="mb-3 max-h-56 overflow-auto rounded-lg border border-ink-700 bg-ink-850 p-3 font-mono text-[11px] whitespace-pre-wrap text-ink-400">
          {thinking}
        </pre>
      )}
      {(text || running) && (
        <pre className="max-h-[40rem] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-200">
          {text}
          {running && <span className="animate-pulse text-accent-400">▍</span>}
        </pre>
      )}
      {running && !text && !thinking && (
        <p className="text-xs text-ink-400">Claude 가 이미지를 분석하고 있습니다…</p>
      )}
    </Card>
  );
}

export { download };

export function TokenBadge({ text }: { text: string }) {
  const t = estimateTokens(text);
  return <Badge tone={t > 100_000 ? "warn" : "neutral"}>~{t.toLocaleString()} tok</Badge>;
}
