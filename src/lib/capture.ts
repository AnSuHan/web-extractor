import { parseHar } from "./har";
import type { HarParseResult } from "./har";

/** collector 확장이 내보내는 번들. */
export interface CapturePage {
  url: string;
  title: string;
  reason: string;
  depth: number;
  collectedAt: number;
  html: string | null;
  htmlTruncated: boolean;
  htmlLength: number;
  outline: { tag: string; role: string | null; label: string | null; text: string | null; path: string }[];
  forms: {
    action: string | null;
    method: string;
    id: string | null;
    fields: {
      name: string;
      tag: string;
      type: string | null;
      required: boolean;
      maxLength: number | null;
      placeholder: string | null;
      options: { value: string; label: string }[] | null;
    }[];
  }[];
  links: { url: string; text: string }[];
  controls: { tag: string; role: string | null; name: string; disabled: boolean; path: string }[];
  frontend: string[];
  resources: { url: string; initiatorType: string; durationMs: number; transferSize: number }[];
  cookieNames: string[];
}

export interface CaptureBundle {
  format: string;
  createdAt: string;
  seed: string;
  config: Record<string, unknown>;
  stats: { pages: number; requests: number; visited: number; skipped: number; durationMs: number };
  robots: { rules: unknown[]; crawlDelay: number | null; fetched: boolean } | null;
  skipped: { url: string; reason: string }[];
  log: { at: number; message: string }[];
  pages: CapturePage[];
  log_har: { version: string; creator: unknown; entries: unknown[] };
}

export interface LoadedCapture {
  bundle: CaptureBundle;
  har: HarParseResult;
  /** 모든 페이지에서 모은 응답 헤더 — 백엔드 지문 추론용 */
  responseHeaders: { name: string; value: string }[];
  cookieNames: string[];
  frontend: string[];
}

function isBundle(v: unknown): v is CaptureBundle {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as CaptureBundle).format === "string" &&
    (v as CaptureBundle).format.startsWith("web-extractor-capture/")
  );
}

export function loadCapture(json: string, includeAssets = false): LoadedCapture {
  const parsed: unknown = JSON.parse(json);

  if (!isBundle(parsed)) {
    throw new Error(
      "web-extractor 캡처 파일이 아닙니다. 확장의 '결과 저장'으로 만든 .json 을 넣어 주세요. (순수 HAR 은 'API 역설계' 탭에서 읽습니다.)",
    );
  }

  const bundle = parsed;
  // HAR 부분을 기존 파서에 그대로 태운다 — 엔드포인트 그룹핑·마스킹을 재사용한다.
  const har = parseHar(JSON.stringify({ log: bundle.log_har }), includeAssets);

  const responseHeaders: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const entry of bundle.log_har.entries as {
    response?: { headers?: { name: string; value: string }[] };
  }[]) {
    for (const h of entry.response?.headers ?? []) {
      const key = `${h.name.toLowerCase()}:${h.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      responseHeaders.push(h);
    }
  }

  const cookieNames = [...new Set(bundle.pages.flatMap((p) => p.cookieNames ?? []))];
  const frontend = [...new Set(bundle.pages.flatMap((p) => p.frontend ?? []))];

  return { bundle, har, responseHeaders, cookieNames, frontend };
}

/** 사이트맵: 방문한 URL 을 경로 트리로 접는다. */
export interface SiteNode {
  segment: string;
  path: string;
  pages: CapturePage[];
  children: Map<string, SiteNode>;
}

export function buildSiteTree(pages: CapturePage[]): SiteNode {
  const root: SiteNode = { segment: "/", path: "/", pages: [], children: new Map() };
  for (const page of pages) {
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const segment of segments) {
      acc += `/${segment}`;
      let child = node.children.get(segment);
      if (!child) {
        child = { segment, path: acc, pages: [], children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.pages.push(page);
  }
  return root;
}

/** 수집된 모든 폼을 화면별로 평탄화. 기능 명세 작성에 바로 쓰인다. */
export function collectForms(pages: CapturePage[]) {
  return pages.flatMap((p) =>
    p.forms.map((f) => ({ pageUrl: p.url, pageTitle: p.title, ...f })),
  );
}
