/**
 * 캡처를 **그대로 쓸 수 있는 결과물**로 조립한다.
 *
 *   정적 사이트 (.zip) — 페이지 HTML + CSS·JS·폰트를 폴더로 풀어내고, 참조 경로를
 *     로컬 상대 경로로 바꾼다. 압축을 풀고 index.html 을 열면 그 화면이 뜬다.
 *
 *   백엔드 구현 명세 (.md) — 엔드포인트별 요청·응답 스키마와 샘플, 데이터 모델,
 *     인증·스택 추론, 폼 입력, 그리고 **관찰하지 못한 것**까지 적은 문서.
 *
 * 둘 다 브라우저 안에서만 만든다. 서버로 나가는 것은 없다.
 */

import type { CaptureAsset, CapturePage, LoadedCapture } from "./capture";
import { inferBackend, modelsToTypeScript } from "./infer";
import type { HarEndpoint } from "./types";

/* ------------------------------------------------------------------ */
/* ZIP (저장 전용 — 압축하지 않는다)                                      */
/* ------------------------------------------------------------------ */

export interface ZipEntry {
  path: string;
  // Blob 에 그대로 넣으려면 버퍼 종류까지 좁혀야 한다 (SharedArrayBuffer 는 못 들어간다).
  data: Uint8Array<ArrayBuffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 의존성 없이 ZIP 을 만든다. 압축(deflate)은 하지 않는다 — 텍스트가 크게 줄지 않는 대신
 * 구현이 단순하고 어떤 압축 해제 도구에서도 열린다.
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  // ZIP 은 MS-DOS 시각을 쓴다. 지금 시각을 그 형식으로 눌러 담는다.
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 로컬 헤더 서명
    lv.setUint16(4, 20, true); // 필요한 버전
    lv.setUint16(6, 0x0800, true); // 이름은 UTF-8
    lv.setUint16(8, 0, true); // 압축 없음
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); // 중앙 디렉터리 서명
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, dosTime, true);
    dv.setUint16(14, dosDate, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD 서명
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------------ */
/* 경로 매핑                                                            */
/* ------------------------------------------------------------------ */

/** 캐시버스터만 다른 URL 은 같은 파일로 본다 (수집기와 같은 규칙). */
const BUSTER_KEYS = new Set(["v", "ver", "version", "t", "ts", "_", "rev", "r", "hash", "cb"]);

export function assetKey(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()];
    if (keys.length > 0 && keys.every((k) => BUSTER_KEYS.has(k.toLowerCase()))) {
      return u.origin + u.pathname;
    }
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

/** 파일 시스템이 싫어하는 문자를 지운다 (윈도에서 특히). */
function safeSegment(segment: string): string {
  return (
    decodeURIComponent(segment)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 80) || "_"
  );
}

function localPath(url: string, seedOrigin: string, kind: "page" | "asset"): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `_unknown/${safeSegment(url)}`;
  }

  const external = u.origin !== seedOrigin;
  const segments = u.pathname.split("/").filter(Boolean).map(safeSegment);
  let name = segments.pop() ?? "";

  if (kind === "page") {
    // 쿼리가 다르면 다른 화면이다 — 파일 이름에 녹여 둔다.
    const query = u.search ? `__${safeSegment(u.search.slice(1))}` : "";
    if (!name) name = "index";
    name = /\.html?$/i.test(name) ? name.replace(/\.html?$/i, "") : name;
    name = `${name}${query}.html`;
  } else if (!name) {
    name = "index";
  }

  const dir = [...(external ? ["_external", safeSegment(u.host)] : []), ...segments];
  return [...dir, name].join("/");
}

/** from 파일에서 to 파일로 가는 상대 경로. */
function relativePath(from: string, to: string): string {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  const file = toParts.pop() as string;
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => "..");
  const down = toParts.slice(i);
  const path = [...up, ...down, file].join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/* ------------------------------------------------------------------ */
/* 정적 사이트로 내보내기                                                 */
/* ------------------------------------------------------------------ */

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** CSS 안의 `url(...)` 과 `@import` 를 로컬 경로로 바꾼다. */
function rewriteCss(
  css: string,
  cssUrl: string,
  resolve: (absolute: string) => string | null,
  selfPath: string,
): string {
  const map = (raw: string): string => {
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) return raw;
    let absolute: string;
    try {
      absolute = new URL(trimmed, cssUrl).href;
    } catch {
      return raw;
    }
    const local = resolve(absolute);
    return local ? relativePath(selfPath, local) : absolute;
  };

  return css
    .replace(/url\(\s*([^)]+?)\s*\)/gi, (_m, inner: string) => `url("${map(inner)}")`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q: string, href: string) => `@import ${q}${map(href)}${q}`);
}

const URL_ATTRS = ["src", "href", "poster", "data-src"] as const;

export interface StaticSiteResult {
  blob: Blob;
  pages: number;
  assets: number;
  /** 로컬에 없어 절대 URL 로 남긴 참조 수 */
  external: number;
}

/**
 * 캡처를 압축 풀면 바로 열리는 정적 사이트로 만든다.
 *
 * 받아 둔 자산은 폴더로 풀고 참조를 상대 경로로 바꾼다. 받지 못한 것(외부 CDN·이미지를
 * 끄고 수집한 경우)은 **원래 절대 URL 그대로 남긴다** — 온라인이면 그대로 뜨고,
 * 오프라인이면 그 부분만 비는 것이 조용히 깨지는 것보다 낫다.
 */
export function buildStaticSite(capture: LoadedCapture): StaticSiteResult {
  const { bundle } = capture;
  let seedOrigin = "";
  try {
    seedOrigin = new URL(bundle.seed).origin;
  } catch {
    seedOrigin = "";
  }

  // 자산 인덱스 — 캐시버스터를 접은 키로 찾는다.
  const assetPaths = new Map<string, string>();
  for (const asset of capture.assets) {
    assetPaths.set(assetKey(asset.url), localPath(asset.url, seedOrigin, "asset"));
  }
  // 페이지 인덱스 — 링크를 로컬 HTML 로 잇는다.
  const pagePaths = new Map<string, string>();
  for (const page of bundle.pages) {
    pagePaths.set(page.url, localPath(page.url, seedOrigin, "page"));
  }

  let external = 0;
  const resolve = (absolute: string): string | null => {
    const asset = assetPaths.get(assetKey(absolute));
    if (asset) return asset;
    const page = pagePaths.get(absolute) ?? pagePaths.get(absolute.replace(/#.*$/, ""));
    if (page) return page;
    external++;
    return null;
  };

  const entries: ZipEntry[] = [];
  const encoder = new TextEncoder();

  // 1) 자산
  for (const asset of capture.assets) {
    const path = assetPaths.get(assetKey(asset.url)) as string;
    if (asset.encoding === "text") {
      const text =
        asset.kind === "css" ? rewriteCss(asset.body, asset.url, resolve, path) : asset.body;
      entries.push({ path, data: encoder.encode(text) });
    } else {
      entries.push({ path, data: base64ToBytes(asset.body) });
    }
  }

  // 2) 페이지
  let pageCount = 0;
  for (const page of bundle.pages) {
    if (!page.html) continue;
    const path = pagePaths.get(page.url) as string;
    entries.push({ path, data: encoder.encode(rewritePage(page, path, resolve)) });
    pageCount++;
  }

  // 3) 화면 캡처 — 재현 결과를 눈으로 대조할 기준
  for (const shot of capture.screenshots) {
    const base = localPath(shot.url, seedOrigin, "page").replace(/\.html$/, "");
    entries.push({
      path: `_screenshots/${base}.jpg`,
      data: base64ToBytes(shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1)),
    });
  }

  // 4) 안내문 — 무엇이 들어 있고 무엇이 없는지
  entries.push({
    path: "README.md",
    data: encoder.encode(siteReadme(capture, pageCount, external)),
  });

  return { blob: buildZip(entries), pages: pageCount, assets: capture.assets.length, external };
}

function rewritePage(
  page: CapturePage,
  selfPath: string,
  resolve: (absolute: string) => string | null,
): string {
  const doc = new DOMParser().parseFromString(page.html ?? "", "text/html");

  // <base> 가 남아 있으면 상대 경로가 전부 원래 사이트로 끌려간다.
  doc.querySelectorAll("base").forEach((el) => el.remove());

  const toLocal = (value: string): string | null => {
    if (!value || value.startsWith("data:") || value.startsWith("#")) return null;
    if (/^(javascript|mailto|tel):/i.test(value)) return null;
    let absolute: string;
    try {
      absolute = new URL(value, page.url).href;
    } catch {
      return null;
    }
    const local = resolve(absolute);
    return local ? relativePath(selfPath, local) : absolute;
  };

  for (const attr of URL_ATTRS) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      const next = toLocal(el.getAttribute(attr) ?? "");
      if (next) el.setAttribute(attr, next);
    });
  }

  // srcset 은 "url 기술자, url 기술자" 목록이다.
  doc.querySelectorAll("[srcset]").forEach((el) => {
    const rewritten = (el.getAttribute("srcset") ?? "")
      .split(",")
      .map((part) => {
        const [url, ...rest] = part.trim().split(/\s+/);
        const next = toLocal(url);
        return [next ?? url, ...rest].join(" ");
      })
      .join(", ");
    el.setAttribute("srcset", rewritten);
  });

  doc.querySelectorAll("style").forEach((el) => {
    el.textContent = rewriteCss(el.textContent ?? "", page.url, resolve, selfPath);
  });
  doc.querySelectorAll("[style]").forEach((el) => {
    const value = el.getAttribute("style") ?? "";
    if (value.includes("url(")) {
      el.setAttribute("style", rewriteCss(value, page.url, resolve, selfPath));
    }
  });

  const banner = doc.createComment(
    ` web-extractor 로 ${new Date(page.collectedAt).toISOString()} 에 캡처한 ${page.url} — ` +
      `받지 못한 리소스는 원래 절대 URL 로 남아 있습니다. `,
  );
  doc.documentElement.insertBefore(banner, doc.documentElement.firstChild);

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function siteReadme(capture: LoadedCapture, pages: number, external: number): string {
  const { bundle } = capture;
  const cov = bundle.coverage;
  const kinds = new Map<string, number>();
  for (const a of capture.assets) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);

  return [
    `# ${bundle.seed} 정적 캡처`,
    "",
    `web-extractor 가 ${new Date(bundle.createdAt).toLocaleString("ko-KR")} 에 만든 것입니다.`,
    "",
    "## 열어 보기",
    "",
    "압축을 풀고 `index.html` 을 브라우저로 여세요. 상대 경로로만 이어져 있어 서버가 필요 없습니다.",
    "",
    "## 들어 있는 것",
    "",
    `- 페이지 HTML ${pages}개`,
    `- 정적 리소스 ${capture.assets.length}개 (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "없음"})`,
    `- 화면 캡처 ${capture.screenshots.length}장 — \`_screenshots/\` (재현 결과를 눈으로 대조할 기준)`,
    "",
    "## 들어 있지 **않은** 것",
    "",
    `- 로컬에 없어 절대 URL 로 남긴 참조 ${external}건 — 외부 CDN, 그리고 이미지 수집을 껐다면 이미지 전부.`,
    "  오프라인에서는 그 부분이 비어 보입니다.",
    ...(cov && cov.unvisited > 0
      ? [
          `- 링크로 발견했지만 방문하지 못한 화면 ${cov.unvisited}개` +
            (cov.stoppedAtLimit ? " (최대 페이지 수에 걸려 멈췄습니다)" : ""),
        ]
      : []),
    "- 로그인 이후 화면·모달처럼 링크로 갈 수 없는 곳은 수동 탐색 모드로 따로 담아야 합니다.",
    "- 서버 동작(폼 제출 결과, 인증)은 없습니다. 그쪽은 `backend-spec.md` 를 보세요.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 백엔드 구현 명세                                                      */
/* ------------------------------------------------------------------ */

function codeBlock(lang: string, body: string): string[] {
  return ["```" + lang, body, "```", ""];
}

function prettyJson(text: string | null): string | null {
  if (!text) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 관찰한 트래픽에서 **구현에 필요한 것만** 뽑아 한 문서로 만든다.
 *
 * 추론에는 근거를 붙이고, 확인하지 못한 것은 지우지 않고 "관찰하지 못한 것"에 남긴다 —
 * 읽는 쪽이 빈 곳을 모르고 지어내는 것이 가장 나쁘다.
 */
export function buildBackendSpec(capture: LoadedCapture): string {
  const { bundle, har } = capture;
  const own = har.endpoints.filter((e) => e.host === hostOf(bundle.seed));
  const third = har.endpoints.length - own.length;

  // 추론도 자기 오리진만 놓고 다시 한다 — 광고·분석 호출이 섞이면 경로 접두사부터
  // 엉뚱해진다(`/collect`, `/rmkt` 가 이 사이트의 API 인 것처럼 보인다).
  const inf = inferBackend(own, {
    responseHeaders: capture.responseHeaders,
    cookieNames: capture.cookieNames,
    frontend: capture.frontend,
  });
  const lines: string[] = [];

  lines.push(
    `# 백엔드 구현 명세 — ${hostOf(bundle.seed)}`,
    "",
    "> web-extractor 가 브라우저에서 관찰한 요청·응답만으로 쓴 문서입니다.",
    "> 소스를 본 것이 아니므로 **추론에는 근거를 함께 적었고**, 확인하지 못한 것은",
    "> 마지막 절에 그대로 남겼습니다. 지어내지 마세요.",
    "",
    "## 0. 수집 범위",
    "",
    `- 시작 URL: \`${bundle.seed}\``,
    `- 수집 시각: ${new Date(bundle.createdAt).toLocaleString("ko-KR")}`,
    `- 방문한 화면 ${bundle.stats.pages}개 · 잡은 요청 ${bundle.stats.requests}건`,
    `- 자기 오리진 엔드포인트 ${own.length}개 · 외부(광고·분석 등) ${third}개 — 아래는 자기 오리진만 다룹니다`,
  );
  if (bundle.coverage) {
    lines.push(
      `- 커버리지: 링크로 발견 ${bundle.coverage.discovered}개 중 ${bundle.coverage.visited}개 방문` +
        (bundle.coverage.stoppedAtLimit ? " — **상한에 걸려 멈췄습니다**" : ""),
    );
  }
  lines.push("");

  lines.push("## 1. API 스타일", "", `**${inf.style}** — ${inf.styleEvidence}`, "");
  if (inf.apiPrefixes.length) {
    lines.push("경로 접두사:", "");
    for (const p of inf.apiPrefixes) lines.push(`- \`${p.prefix}\` — ${p.count}건`);
    lines.push("");
  }

  lines.push("## 2. 인증", "");
  if (inf.auth.length) for (const a of inf.auth) lines.push(`- **${a.claim}** — ${a.evidence}`);
  else lines.push("- 관찰된 인증 헤더가 없습니다. 쿠키 세션일 가능성이 큽니다(후킹에는 보이지 않습니다).");
  if (capture.cookieNames.length) {
    lines.push("", `관찰된 쿠키 이름: ${capture.cookieNames.map((c) => `\`${c}\``).join(", ")}`);
  }
  lines.push("");

  lines.push("## 3. 스택 지문", "");
  if (inf.stack.length) {
    for (const s of inf.stack) lines.push(`- **${s.claim}** — ${s.evidence}`);
  } else {
    lines.push(
      "- 헤더에서 드러난 지문이 없습니다. 교차 출처 응답은 CORS 가 헤더를 가리므로",
      "  `server`·`x-powered-by` 가 안 보이는 경우가 많습니다.",
    );
  }
  lines.push("");

  lines.push("## 4. 엔드포인트 목록", "", "| 메서드 | 경로 | 상태 | 응답 형식 | 횟수 |", "|---|---|---|---|---|");
  for (const e of own) {
    lines.push(
      `| \`${e.method}\` | \`${e.path}\` | ${e.status} | ${e.mimeType || "–"} | ${e.count} |`,
    );
  }
  lines.push("");

  lines.push("## 5. 엔드포인트 상세", "");
  for (const e of own) {
    lines.push(`### \`${e.method} ${e.path}\``, "");
    lines.push(`- 상태 코드 ${e.status} · 관찰 ${e.count}회 · 응답 형식 \`${e.mimeType || "–"}\``);
    if (e.queryKeys.length) lines.push(`- 쿼리 키: ${e.queryKeys.map((q) => `\`${q}\``).join(", ")}`);
    if (e.authHeaders.length) lines.push(`- 인증 헤더: ${e.authHeaders.map((h) => `\`${h}\``).join(", ")}`);
    lines.push("");
    const req = prettyJson(e.requestBodySample);
    if (req) {
      lines.push("요청 본문 (관찰된 샘플):", "");
      lines.push(...codeBlock(e.requestBodySample?.trim().startsWith("{") ? "json" : "text", clamp(req)));
    }
    const res = prettyJson(e.responseBodySample);
    if (res) {
      lines.push("응답 본문 (관찰된 샘플):", "");
      lines.push(...codeBlock(/json/i.test(e.mimeType) ? "json" : "html", clamp(res)));
    } else {
      lines.push("> 응답 본문을 확보하지 못했습니다 (교차 출처이거나 본문이 비어 있었습니다).", "");
    }
  }

  if (inf.models.length) {
    lines.push("## 6. 데이터 모델", "");
    lines.push(
      "응답 JSON 에서 되짚은 것입니다. `?` 는 일부 응답에만 있던 필드, `| null` 은 값이 null 이던 필드입니다.",
      "",
    );
    lines.push(...codeBlock("typescript", modelsToTypeScript(inf.models)));
    const paged = inf.models.filter((m) => m.pagination.length);
    if (paged.length) {
      lines.push("페이지네이션 규약:", "");
      for (const m of paged) lines.push(`- \`${m.name}\` — ${m.pagination.join(", ")}`);
      lines.push("");
    }
  }

  const forms = bundle.pages.flatMap((p) =>
    p.forms.map((f) => ({ page: p.url, ...f })),
  );
  if (forms.length) {
    lines.push("## 7. 폼 — 서버가 받아야 하는 입력", "");
    lines.push("값은 수집하지 않았습니다. 이름·타입·제약만 관찰한 것입니다.", "");
    for (const form of forms.slice(0, 40)) {
      lines.push(
        `- \`${form.method} ${form.action ?? "(action 없음)"}\` — ${form.page}`,
        ...form.fields.map(
          (f) =>
            `  - \`${f.name || "(이름 없음)"}\` ${f.type ?? f.tag}` +
            `${f.required ? " · 필수" : ""}${f.maxLength ? ` · 최대 ${f.maxLength}자` : ""}` +
            `${f.options ? ` · 선택지 ${f.options.length}개` : ""}`,
        ),
      );
    }
    lines.push("");
  }

  lines.push("## 8. 구현 순서 제안", "");
  lines.push(
    "1. 위 **데이터 모델**을 그대로 두고 저장소 스키마를 만든다 (필드 선택성·null 구분을 지킬 것).",
    "2. **엔드포인트 목록**의 경로·메서드·상태 코드를 그대로 재현한다. 응답 본문 모양이 다르면 프런트가 깨진다.",
    "3. **인증**을 붙인다 — 위 근거가 쿠키 세션을 가리키면 세션 쿠키로, 헤더가 관찰됐다면 그 헤더로.",
    "4. **폼** 항목을 입력 검증 규칙으로 옮긴다 (필수·최대 길이·선택지).",
    "5. 마지막으로 아래 **관찰하지 못한 것**을 확인해 빈 곳을 메운다.",
    "",
  );

  lines.push("## 9. 관찰하지 못한 것", "");
  const unknowns = [
    ...inf.notes,
    "쓰기 동작(POST/PUT/DELETE)은 순회가 GET 만 하므로 대부분 관찰되지 않았습니다. 수동 탐색 모드로 직접 눌러 담아야 합니다.",
    "오류 응답(4xx/5xx)의 본문 형식은 관찰된 것만 적혀 있습니다.",
    "쿠키 값은 수집하지 않으므로 세션 구조(서명·만료)는 알 수 없습니다.",
    "WebSocket·SSE·서비스 워커 내부 요청은 잡히지 않습니다.",
  ];
  if (bundle.coverage?.unvisited) {
    unknowns.push(
      `링크로 발견했지만 방문하지 못한 화면 ${bundle.coverage.unvisited}개가 있습니다 — 그 화면들이 쓰는 엔드포인트는 여기에 없습니다.`,
    );
  }
  for (const n of unknowns) lines.push(`- ${n}`);
  lines.push("");

  return lines.join("\n");
}

function clamp(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type { HarEndpoint, CaptureAsset };
