import { useRef, useState } from "react";
import { EFFORTS, MODELS, describeError, runExtraction } from "../lib/claude";
import type { Effort, ModelId } from "../lib/claude";
import type { ImageAsset } from "../lib/types";
import { usePersisted } from "../lib/storage";
import { Button, Card, Field, Segmented, Select, TextInput } from "./ui";
import { ResultPanel } from "./PromptPanel";

interface RunSettings {
  model: ModelId;
  effort: Effort;
  maxTokens: number;
}

export function RunPanel({
  prompt,
  images,
  disabledReason,
}: {
  prompt: string;
  images: ImageAsset[];
  disabledReason?: string;
}) {
  const [apiKey, setApiKey] = usePersisted<string>("apiKey", "");
  const [settings, , patchSettings] = usePersisted<RunSettings>("runSettings", {
    model: "claude-opus-5",
    effort: "high",
    maxTokens: 32000,
  });
  const [open, setOpen] = usePersisted<boolean>("runPanelOpen", false);
  const [showKey, setShowKey] = useState(false);

  const [text, setText] = useState("");
  const [thinking, setThinking] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    setText("");
    setThinking("");
    setError(null);
    setUsage(null);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runExtraction({
        apiKey: apiKey.trim(),
        model: settings.model,
        effort: settings.effort,
        prompt,
        images,
        maxTokens: settings.maxTokens,
        signal: controller.signal,
        onText: (c) => setText((t) => t + c),
        onThinking: (c) => setThinking((t) => t + c),
      });
      setUsage({ input: result.inputTokens, output: result.outputTokens });
      if (result.stopReason === "max_tokens") {
        setError(
          "출력이 max_tokens 한도에서 잘렸습니다. 한도를 올리거나 화면을 나눠서 다시 시도해 주세요.",
        );
      } else if (result.stopReason === "refusal") {
        setError("Claude 가 이 요청을 거절했습니다.");
      }
    } catch (err) {
      if (controller.signal.aborted) setError("중단했습니다.");
      else setError(describeError(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const blocked = disabledReason ?? (!apiKey.trim() ? "API 키를 입력해 주세요." : null);

  return (
    <div className="space-y-4">
      <Card
        title="Claude 로 바로 실행 (선택)"
        subtitle="프롬프트를 복사해 다른 곳에 붙여넣어도 되고, 여기서 바로 돌려도 됩니다."
        right={
          <Button variant="ghost" onClick={() => setOpen(!open)}>
            {open ? "접기" : "펼치기"}
          </Button>
        }
      >
        {!open ? (
          <p className="text-xs text-ink-400">
            API 키를 넣으면 브라우저에서 Claude API 를 직접 호출해 결과까지 받습니다.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-900 bg-amber-950/50 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              키는 이 브라우저의 localStorage 에만 저장되고 서버로 전송되지 않습니다
              (이 앱에는 백엔드가 없습니다). 다만 브라우저에서 직접 호출하는 방식이라
              이 페이지의 스크립트가 키를 읽을 수 있습니다. 공용 PC 에서는 사용 후
              키를 지워 주세요.
            </div>

            <Field
              label="Anthropic API 키"
              hint="console.anthropic.com 에서 발급합니다."
            >
              <div className="flex gap-2">
                <TextInput
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="ghost" onClick={() => setShowKey((s) => !s)}>
                  {showKey ? "숨기기" : "보기"}
                </Button>
                <Button variant="ghost" onClick={() => setApiKey("")}>
                  지우기
                </Button>
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="모델">
                <Select
                  value={settings.model}
                  onChange={(model) => patchSettings({ model })}
                  options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
                />
              </Field>
              <Field label="추론 강도 (effort)" hint="높을수록 정확·비쌈">
                <Segmented
                  value={settings.effort}
                  onChange={(effort) => patchSettings({ effort })}
                  options={EFFORTS.map((e) => ({ value: e, label: e }))}
                />
              </Field>
              <Field label="최대 출력 토큰">
                <TextInput
                  type="number"
                  min={1024}
                  max={128000}
                  step={1000}
                  value={settings.maxTokens}
                  onChange={(e) =>
                    patchSettings({
                      maxTokens: Math.min(
                        128000,
                        Math.max(1024, Number(e.target.value) || 32000),
                      ),
                    })
                  }
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={running || blocked !== null}
                onClick={() => void run()}
                className="px-5 py-2 text-sm"
              >
                {running ? "실행 중…" : "실행"}
              </Button>
              {blocked && <span className="text-xs text-ink-400">{blocked}</span>}
              {!blocked && images.length > 0 && (
                <span className="text-xs text-ink-400">
                  이미지 {images.length}장을 함께 보냅니다.
                </span>
              )}
            </div>
          </div>
        )}
      </Card>

      <ResultPanel
        text={text}
        thinking={thinking}
        running={running}
        error={error}
        usage={usage}
        onStop={() => abortRef.current?.abort()}
      />
    </div>
  );
}
