import type { HarEndpoint } from "./types";

/** 정적 자산 — API 역설계에는 잡음이므로 기본 제외. */
const ASSET_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|mp3|wasm)(\?|$)/i;

const AUTH_HEADER =
  /^(authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|cookie|api-key)$/i;

const SECRETISH = /(token|secret|password|passwd|authorization|api[-_]?key|session|credential|bearer)/i;

/** 값이 비밀로 보이면 길이만 남기고 가린다. */
function redactValue(key: string, value: string): string {
  if (!SECRETISH.test(key)) return value;
  return `<redacted:${value.length}chars>`;
}

/** 경로의 숫자/UUID 세그먼트를 파라미터로 일반화해 같은 엔드포인트끼리 묶는다. */
function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return "{id}";
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
      )
        return "{uuid}";
      if (/^[0-9a-f]{24,}$/i.test(seg)) return "{hash}";
      return seg;
    })
    .join("/");
}

/** 큰 JSON 본문을 프롬프트에 넣기 좋은 크기로 줄인다. 구조는 보존, 배열은 앞 2개만. */
function shrink(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) {
    return value.slice(0, 2).map((v) => shrink(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = typeof v === "string" ? shrink(redactValue(k, v), depth + 1) : shrink(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 200) {
    return value.slice(0, 200) + `…(+${value.length - 200})`;
  }
  return value;
}

function sampleBody(text: string | undefined, mimeType: string | undefined): string | null {
  if (!text) return null;
  const isJson = (mimeType ?? "").includes("json") || /^\s*[[{]/.test(text);
  if (!isJson) {
    return text.length > 400 ? text.slice(0, 400) + "…" : text;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(shrink(parsed), null, 2);
  } catch {
    return text.slice(0, 400);
  }
}

interface RawHeader {
  name?: string;
  value?: string;
}
interface RawEntry {
  request?: {
    method?: string;
    url?: string;
    headers?: RawHeader[];
    queryString?: RawHeader[];
    postData?: { text?: string; mimeType?: string };
  };
  response?: {
    status?: number;
    content?: { text?: string; mimeType?: string };
  };
}

export interface HarParseResult {
  endpoints: HarEndpoint[];
  totalEntries: number;
  skippedAssets: number;
  hosts: string[];
  credentialWarning: boolean;
}

export function parseHar(json: string, includeAssets = false): HarParseResult {
  const parsed = JSON.parse(json) as { log?: { entries?: RawEntry[] } };
  const entries = parsed.log?.entries ?? [];
  if (!Array.isArray(entries)) {
    throw new Error("HAR 형식이 아닙니다 (log.entries 없음).");
  }

  const map = new Map<string, HarEndpoint>();
  const hosts = new Set<string>();
  let skippedAssets = 0;
  let credentialWarning = false;

  for (const entry of entries) {
    const rawUrl = entry.request?.url;
    if (!rawUrl) continue;

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }

    if (!includeAssets && ASSET_EXT.test(url.pathname + url.search)) {
      skippedAssets++;
      continue;
    }

    hosts.add(url.host);

    const method = (entry.request?.method ?? "GET").toUpperCase();
    const path = templatePath(url.pathname);
    const key = `${method} ${url.host}${path}`;

    const authHeaders = (entry.request?.headers ?? [])
      .map((h) => h.name ?? "")
      .filter((n) => AUTH_HEADER.test(n));
    if (authHeaders.length) credentialWarning = true;

    const existing = map.get(key);
    if (existing) {
      existing.count++;
      // 첫 샘플이 비어 있었다면 채워준다.
      existing.requestBodySample ??= sampleBody(
        entry.request?.postData?.text,
        entry.request?.postData?.mimeType,
      );
      existing.responseBodySample ??= sampleBody(
        entry.response?.content?.text,
        entry.response?.content?.mimeType,
      );
      for (const q of entry.request?.queryString ?? []) {
        if (q.name && !existing.queryKeys.includes(q.name)) existing.queryKeys.push(q.name);
      }
      continue;
    }

    map.set(key, {
      method,
      url: rawUrl,
      path,
      host: url.host,
      status: entry.response?.status ?? 0,
      mimeType: entry.response?.content?.mimeType ?? "",
      queryKeys: (entry.request?.queryString ?? [])
        .map((q) => q.name ?? "")
        .filter(Boolean),
      requestBodySample: sampleBody(
        entry.request?.postData?.text,
        entry.request?.postData?.mimeType,
      ),
      responseBodySample: sampleBody(
        entry.response?.content?.text,
        entry.response?.content?.mimeType,
      ),
      authHeaders: [...new Set(authHeaders)],
      count: 1,
    });
  }

  const endpoints = [...map.values()].sort(
    (a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  return {
    endpoints,
    totalEntries: entries.length,
    skippedAssets,
    hosts: [...hosts].sort(),
    credentialWarning,
  };
}
