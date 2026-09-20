import { parseHar } from "./har";
import type { HarParseResult } from "./har";
import type { ImageAsset } from "./types";

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
  /** 그 화면을 찍은 JPEG data URL. 캡처를 껐거나 탭이 비활성이면 없다. */
  screenshot?: string | null;
}

/** 순회가 끝난 뒤 확장이 따로 받아 둔 정적 리소스 한 건. */
export interface CaptureAsset {
  url: string;
  kind: "css" | "js" | "font" | "image" | "text" | "other";
  status: number;
  contentType: string;
  bytes: number;
  encoding: "text" | "base64";
  body: string;
  /** 어디서 받았는지 — "page" 는 수집 탭 안(페이지와 같은 인증 조건), "worker" 는 확장에서. */
  via?: "page" | "worker";
}

export interface CaptureBundle {
  format: string;
  createdAt: string;
  seed: string;
  config: Record<string, unknown>;
  stats: {
    pages: number;
    requests: number;
    visited: number;
    skipped: number;
    durationMs: number;
    assets?: number;
    screenshots?: number;
  };
  /** 얼마나 훑었는지. 구버전 캡처에는 없다. */
  coverage?: {
    discovered: number;
    visited: number;
    unvisited: number;
    unvisitedSample: string[];
    stoppedAtLimit: boolean;
    manual: boolean;
  };
  assets?: CaptureAsset[];
  assetSkipped?: { url: string; reason: string }[];
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
  /** 화면 캡처가 있는 페이지들 */
  screenshots: { url: string; title: string; dataUrl: string }[];
  assets: CaptureAsset[];
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

  const screenshots = bundle.pages
    .filter((p) => !!p.screenshot)
    .map((p) => ({ url: p.url, title: p.title, dataUrl: p.screenshot as string }));

  return {
    bundle,
    har,
    responseHeaders,
    cookieNames,
    frontend,
    screenshots,
    assets: bundle.assets ?? [],
  };
}

/** 화면 캡처를 UI 재구성 탭이 쓰는 이미지로 바꾼다. */
export async function screenshotToImage(shot: {
  url: string;
  title: string;
  dataUrl: string;
}): Promise<ImageAsset> {
  const base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1);
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = shot.dataUrl;
  });
  let name = shot.title || shot.url;
  try {
    name = `${new URL(shot.url).pathname || "/"} — ${shot.title}`.slice(0, 80);
  } catch {
    /* URL 이 아니면 제목만 쓴다 */
  }
  return {
    id: crypto.randomUUID(),
    name,
    mediaType: "image/jpeg",
    data: base64,
    dataUrl: shot.dataUrl,
    width,
    height,
    // base64 는 원본보다 약 4/3 크다.
    bytes: Math.round((base64.length * 3) / 4),
  };
}

/** 정적 리소스를 종류별로 묶고 용량을 더한다. */
export function summarizeAssets(assets: CaptureAsset[]) {
  const byKind = new Map<string, { count: number; bytes: number }>();
  for (const a of assets) {
    const cur = byKind.get(a.kind) ?? { count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += a.bytes;
    byKind.set(a.kind, cur);
  }
  return {
    total: assets.length,
    bytes: assets.reduce((sum, a) => sum + a.bytes, 0),
    byKind: [...byKind.entries()].sort((a, b) => b[1].bytes - a[1].bytes),
  };
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
