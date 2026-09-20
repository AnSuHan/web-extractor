import Anthropic from "@anthropic-ai/sdk";
import type { ImageAsset } from "./types";

export const MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 (권장)", note: "가장 정확한 재구성" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "빠르고 저렴" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "가장 저렴" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface RunOptions {
  apiKey: string;
  model: ModelId;
  effort: Effort;
  prompt: string;
  images: ImageAsset[];
  maxTokens: number;
  signal?: AbortSignal;
  onText: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
}

export interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

/**
 * 브라우저에서 Claude API를 직접 호출한다.
 *
 * 브라우저 직접 호출은 API 키가 사용자 기기에만 머무는 대신, 그 페이지의 JS가
 * 키를 읽을 수 있다는 뜻이기도 하다. 키는 localStorage 에만 저장하고 서버로는
 * 절대 보내지 않는다 (이 앱에는 백엔드가 없다).
 */
export async function runExtraction(o: RunOptions): Promise<RunResult> {
  const client = new Anthropic({
    apiKey: o.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const content: Anthropic.ContentBlockParam[] = [
    ...o.images.map(
      (img): Anthropic.ImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      }),
    ),
    { type: "text", text: o.prompt },
  ];

  const stream = client.messages.stream(
    {
      model: o.model,
      max_tokens: o.maxTokens,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: o.effort },
      messages: [{ role: "user", content }],
    },
    { signal: o.signal },
  );

  for await (const event of stream) {
    if (event.type !== "content_block_delta") continue;
    if (event.delta.type === "text_delta") o.onText(event.delta.text);
    else if (event.delta.type === "thinking_delta") o.onThinking?.(event.delta.thinking);
  }

  const message = await stream.finalMessage();
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    stopReason: message.stop_reason,
  };
}

/** 에러를 사용자에게 보여줄 한국어 문장으로 바꾼다. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError)
    return "API 키가 거부되었습니다 (401). 키를 다시 확인해 주세요.";
  if (err instanceof Anthropic.PermissionDeniedError)
    return "이 키에는 권한이 없습니다 (403).";
  if (err instanceof Anthropic.RateLimitError)
    return "요청이 너무 많습니다 (429). 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.BadRequestError)
    return `요청이 거부되었습니다 (400): ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError)
    return "Claude API에 연결하지 못했습니다. 네트워크 또는 브라우저 확장(광고 차단기)이 요청을 막고 있을 수 있습니다.";
  if (err instanceof Anthropic.APIError) return `API 오류: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
