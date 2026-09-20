/**
 * 캡처에서 백엔드 구조를 되짚는다. 전부 결정적 계산이다 — 모델 호출도, API 키도 없다.
 *
 * 관찰한 것과 추론한 것을 항상 구분해서 표시한다. 추론은 증거와 함께 남긴다.
 */

import type { HarEndpoint } from "./types";

/* ------------------------------------------------------------------ */
/* 스키마 추론                                                          */
/* ------------------------------------------------------------------ */

export type JsonKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "unknown";

export interface FieldShape {
  name: string;
  kinds: Set<JsonKind>;
  /** 이 키가 실제로 존재했던 객체 수. 부모의 count 보다 적으면 선택적 필드다. */
  present: number;
  /** 값이 null 이 아니었던 횟수 */
  nonNull: number;
  children?: ShapeNode;
  /** 문자열일 때 관찰된 형식 힌트 (iso-date, uuid, email, url …) */
  formats: Set<string>;
  samples: string[];
}

/** 한 단계의 객체 묶음. count 는 이 단계에서 합쳐진 객체 수다. */
export interface ShapeNode {
  count: number;
  fields: Map<string, FieldShape>;
}

const newNode = (): ShapeNode => ({ count: 0, fields: new Map() });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URLISH = /^https?:\/\//i;

function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function formatOf(s: string): string | null {
  if (ISO_DATE.test(s)) return "date-time";
  if (UUID.test(s)) return "uuid";
  if (EMAIL.test(s)) return "email";
  if (URLISH.test(s)) return "url";
  if (/^<redacted:\d+chars>$/.test(s)) return "redacted";
  return null;
}

function newField(name: string): FieldShape {
  return { name, kinds: new Set(), present: 0, nonNull: 0, formats: new Set(), samples: [] };
}

/** 여러 샘플 객체를 하나의 필드 트리로 합친다. */
function mergeInto(node: ShapeNode, obj: Record<string, unknown>, depth: number) {
  node.count++;
  for (const [key, value] of Object.entries(obj)) {
    let field = node.fields.get(key);
    if (!field) {
      field = newField(key);
      node.fields.set(key, field);
    }
    field.present++;
    const kind = kindOf(value);
    field.kinds.add(kind);
    if (value !== null && value !== undefined) field.nonNull++;

    if (kind === "string") {
      const f = formatOf(value as string);
      if (f) field.formats.add(f);
      if (field.samples.length < 3 && f !== "redacted") {
        const s = value as string;
        field.samples.push(s.length > 40 ? s.slice(0, 40) + "…" : s);
      }
    } else if (kind === "number" && field.samples.length < 3) {
      field.samples.push(String(value));
    }

    if (depth < 4) {
      if (kind === "object") {
        field.children ??= newNode();
        mergeInto(field.children, value as Record<string, unknown>, depth + 1);
      } else if (kind === "array") {
        const arr = value as unknown[];
        const objects = arr.filter((x) => kindOf(x) === "object").slice(0, 5);
        if (objects.length) {
          field.children ??= newNode();
          for (const o of objects) {
            mergeInto(field.children, o as Record<string, unknown>, depth + 1);
          }
        }
      }
    }
  }
}

/** 응답 본문이 목록이면 그 원소를, 아니면 본문 자체를 모델 후보로 본다. */
function modelCandidates(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((x) => kindOf(x) === "object").slice(0, 20) as Record<string, unknown>[];
  }
  if (kindOf(parsed) !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  // { data: [...] } / { items: [...] } / { results: [...] } 같은 래퍼를 벗긴다.
  for (const key of ["data", "items", "results", "content", "records", "list", "rows"]) {
    const inner = obj[key];
    if (Array.isArray(inner)) {
      const objs = inner.filter((x) => kindOf(x) === "object").slice(0, 20);
      if (objs.length) return objs as Record<string, unknown>[];
    }
  }
  return [obj];
}

export interface InferredModel {
  name: string;
  endpoints: string[];
  shape: ShapeNode;
  sampleCount: number;
  /** 목록 응답에서 발견된 페이지네이션 키 */
  pagination: string[];
}

const PAGINATION_KEYS = [
  "page", "pageSize", "per_page", "perPage", "limit", "offset", "cursor",
  "next", "nextCursor", "next_cursor", "total", "totalCount", "total_count",
  "totalPages", "total_pages", "hasNext", "has_next", "size", "number",
];

/* ------------------------------------------------------------------ */
/* 백엔드 지문                                                          */
/* ------------------------------------------------------------------ */

export interface Evidence {
  claim: string;
  evidence: string;
}

const SERVER_HINTS: { pattern: RegExp; claim: string }[] = [
  { pattern: /express/i, claim: "Node.js / Express" },
  { pattern: /nginx/i, claim: "nginx (리버스 프록시일 가능성)" },
  { pattern: /apache/i, claim: "Apache" },
  { pattern: /gunicorn|uvicorn|hypercorn/i, claim: "Python ASGI/WSGI (Django·FastAPI 계열)" },
  { pattern: /werkzeug/i, claim: "Python Flask" },
  { pattern: /\b(puma|unicorn|phusion)\b/i, claim: "Ruby on Rails" },
  { pattern: /kestrel/i, claim: "ASP.NET Core" },
  { pattern: /tomcat|jetty|undertow|coyote/i, claim: "Java (Spring 계열 가능성)" },
  { pattern: /openresty/i, claim: "OpenResty" },
  { pattern: /cloudflare/i, claim: "Cloudflare 앞단" },
  { pattern: /vercel/i, claim: "Vercel" },
  { pattern: /netlify/i, claim: "Netlify" },
  { pattern: /amazons3|awselb|cloudfront/i, claim: "AWS (S3 / ELB / CloudFront)" },
];

const COOKIE_HINTS: { pattern: RegExp; claim: string }[] = [
  { pattern: /^JSESSIONID$/i, claim: "Java 서블릿 컨테이너 (Spring / Jakarta EE)" },
  { pattern: /^connect\.sid$/i, claim: "Node.js express-session" },
  { pattern: /^sessionid$/i, claim: "Django" },
  { pattern: /^csrftoken$/i, claim: "Django CSRF" },
  { pattern: /^_.*_session$/i, claim: "Ruby on Rails 세션" },
  { pattern: /^laravel_session$/i, claim: "Laravel" },
  { pattern: /^PHPSESSID$/i, claim: "PHP" },
  { pattern: /^\.AspNet/i, claim: "ASP.NET" },
  { pattern: /^next-auth/i, claim: "NextAuth.js" },
  { pattern: /^__Secure-|^__Host-/, claim: "쿠키 접두사 보안 규칙 사용" },
];

const HEADER_HINTS: { name: RegExp; claim: string }[] = [
  { name: /^x-powered-by$/i, claim: "X-Powered-By 노출" },
  { name: /^x-request-id$|^x-correlation-id$|^traceparent$/i, claim: "분산 추적 ID 사용" },
  { name: /^x-ratelimit-/i, claim: "레이트 리밋 적용" },
  { name: /^x-drupal|^x-generator$/i, claim: "CMS 헤더 노출" },
  { name: /^etag$/i, claim: "ETag 캐싱" },
  { name: /^x-frame-options$|^content-security-policy$/i, claim: "보안 헤더 설정됨" },
];

/* ------------------------------------------------------------------ */
/* API 스타일 판정                                                      */
/* ------------------------------------------------------------------ */

export type ApiStyle = "REST" | "GraphQL" | "RPC 스타일" | "혼합" | "판별 불가";

function detectStyle(endpoints: HarEndpoint[]): { style: ApiStyle; evidence: string } {
  const graphql = endpoints.filter((e) => /\/graphql|\/gql/i.test(e.path));
  if (graphql.length && graphql.length >= endpoints.length * 0.5) {
    return { style: "GraphQL", evidence: `${graphql.length}개 엔드포인트가 /graphql 경로` };
  }
  const rpc = endpoints.filter((e) =>
    /\/(rpc|api)\/[a-z]+[._-](get|list|create|update|delete|search|fetch)/i.test(e.path),
  );
  const restish = endpoints.filter((e) => /\{id\}|\{uuid\}/.test(e.path));

  if (graphql.length && restish.length) {
    return { style: "혼합", evidence: `GraphQL ${graphql.length}개 + 리소스형 경로 ${restish.length}개` };
  }
  if (rpc.length > restish.length && rpc.length > 0) {
    return { style: "RPC 스타일", evidence: `동사형 경로 ${rpc.length}개` };
  }
  if (restish.length > 0) {
    return { style: "REST", evidence: `리소스/{id} 형태 경로 ${restish.length}개` };
  }
  return { style: "판별 불가", evidence: "경로 패턴이 충분하지 않음" };
}

/* ------------------------------------------------------------------ */
/* 메인                                                                */
/* ------------------------------------------------------------------ */

export interface BackendInference {
  style: ApiStyle;
  styleEvidence: string;
  apiHosts: { host: string; count: number }[];
  apiPrefixes: { prefix: string; count: number }[];
  models: InferredModel[];
  stack: Evidence[];
  auth: Evidence[];
  statusCodes: { status: number; count: number }[];
  notes: string[];
}

export function inferBackend(
  endpoints: HarEndpoint[],
  extra: {
    responseHeaders?: { name: string; value: string }[];
    cookieNames?: string[];
    frontend?: string[];
  } = {},
): BackendInference {
  const notes: string[] = [];

  /* --- 호스트·접두사 --- */
  const hostCount = new Map<string, number>();
  const prefixCount = new Map<string, number>();
  const statusCount = new Map<number, number>();

  for (const e of endpoints) {
    hostCount.set(e.host, (hostCount.get(e.host) ?? 0) + e.count);
    statusCount.set(e.status, (statusCount.get(e.status) ?? 0) + e.count);
    const segments = e.path.split("/").filter(Boolean);
    if (segments.length) {
      // /api/v1/orders → /api/v1 를 접두사로 본다.
      const depth = segments[0] === "api" && segments.length > 1 && /^v\d+$/.test(segments[1]) ? 2 : 1;
      const prefix = "/" + segments.slice(0, depth).join("/");
      prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + e.count);
    }
  }

  /* --- 모델 --- */
  const byResource = new Map<string, { endpoints: string[]; objects: Record<string, unknown>[]; pagination: Set<string> }>();

  for (const e of endpoints) {
    if (!e.responseBodySample) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.responseBodySample);
    } catch {
      continue;
    }

    // 리소스 이름: 경로에서 파라미터가 아닌 마지막 세그먼트
    const segments = e.path.split("/").filter((s) => s && !/^\{.*\}$/.test(s));
    const resource = segments[segments.length - 1] ?? "root";

    let bucket = byResource.get(resource);
    if (!bucket) {
      bucket = { endpoints: [], objects: [], pagination: new Set() };
      byResource.set(resource, bucket);
    }
    bucket.endpoints.push(`${e.method} ${e.path}`);
    bucket.objects.push(...modelCandidates(parsed));

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed as object)) {
        if (PAGINATION_KEYS.includes(key)) bucket.pagination.add(key);
      }
    }
    for (const key of e.queryKeys) {
      if (PAGINATION_KEYS.includes(key)) bucket.pagination.add(key);
    }
  }

  const models: InferredModel[] = [];
  for (const [name, bucket] of byResource) {
    if (!bucket.objects.length) continue;
    const shape = newNode();
    for (const obj of bucket.objects.slice(0, 40)) mergeInto(shape, obj, 0);
    if (shape.fields.size === 0) continue;
    models.push({
      name,
      endpoints: [...new Set(bucket.endpoints)],
      shape,
      sampleCount: bucket.objects.length,
      pagination: [...bucket.pagination],
    });
  }
  models.sort((a, b) => b.shape.fields.size - a.shape.fields.size);

  /* --- 스택 지문 --- */
  const stack: Evidence[] = [];
  const headers = extra.responseHeaders ?? [];
  const seenClaims = new Set<string>();

  const push = (claim: string, evidence: string) => {
    const key = `${claim}|${evidence}`;
    if (seenClaims.has(key)) return;
    seenClaims.add(key);
    stack.push({ claim, evidence });
  };

  for (const h of headers) {
    if (/^(server|x-powered-by|x-aspnet-version|x-generator)$/i.test(h.name)) {
      for (const hint of SERVER_HINTS) {
        if (hint.pattern.test(h.value)) push(hint.claim, `${h.name}: ${h.value}`);
      }
      if (!SERVER_HINTS.some((s) => s.pattern.test(h.value))) {
        push(`서버 헤더: ${h.value}`, `${h.name}: ${h.value}`);
      }
    }
    for (const hint of HEADER_HINTS) {
      if (hint.name.test(h.name)) push(hint.claim, `${h.name}: ${h.value}`);
    }
  }

  for (const cookie of extra.cookieNames ?? []) {
    for (const hint of COOKIE_HINTS) {
      if (hint.pattern.test(cookie)) push(hint.claim, `쿠키 ${cookie}`);
    }
  }

  for (const fw of extra.frontend ?? []) {
    push(`프런트엔드: ${fw}`, "페이지 전역 객체·DOM 마커");
    if (fw === "Next.js") push("Next.js 서버(Node) 또는 Vercel 호스팅 가능성", "__NEXT_DATA__ 존재");
    if (fw === "Nuxt") push("Nitro/Node 서버 가능성", "__NUXT__ 존재");
    if (fw.startsWith("Angular")) push("정적 SPA + 별도 API 서버 구조 가능성", "ng-version 속성");
    if (fw === "Livewire") push("Laravel (PHP) 백엔드", "Livewire 마커");
    if (fw === "Hotwire/Turbo") push("Ruby on Rails 가능성", "Turbo 마커");
  }

  /* --- 인증 --- */
  const auth: Evidence[] = [];
  const authHeaderNames = new Set<string>();
  for (const e of endpoints) for (const h of e.authHeaders) authHeaderNames.add(h.toLowerCase());

  if (authHeaderNames.has("authorization")) {
    auth.push({ claim: "Authorization 헤더 기반 (Bearer 토큰 추정)", evidence: "요청에 Authorization 헤더 존재" });
  }
  if (authHeaderNames.has("cookie")) {
    auth.push({ claim: "쿠키 세션 기반", evidence: "요청에 Cookie 헤더 존재" });
  }
  if (authHeaderNames.has("x-api-key") || authHeaderNames.has("api-key")) {
    auth.push({ claim: "API 키 헤더", evidence: "X-API-Key 헤더 존재" });
  }
  if (authHeaderNames.has("x-csrf-token") || authHeaderNames.has("x-xsrf-token")) {
    auth.push({ claim: "CSRF 토큰 사용 — 쿠키 세션과 함께 쓰이는 패턴", evidence: "X-CSRF-Token 헤더 존재" });
  }
  if (auth.length === 0) {
    auth.push({ claim: "인증 단서 없음", evidence: "캡처된 요청에 인증 헤더가 없습니다 (비로그인 상태였거나 쿠키가 자동 전송됨)" });
    notes.push(
      "브라우저가 자동으로 붙이는 쿠키는 fetch 후킹에서 보이지 않습니다. 인증이 쿠키 기반이어도 여기엔 안 잡힐 수 있습니다.",
    );
  }

  const { style, evidence: styleEvidence } = detectStyle(endpoints);

  if (endpoints.some((e) => e.status === 0)) {
    notes.push("상태 코드 0 인 항목은 요청이 실패했거나 응답을 읽지 못한 것입니다.");
  }
  notes.push(
    "교차 출처 응답의 헤더는 CORS 로 일부만 노출됩니다. 같은 오리진 API 가 아니면 서버 지문이 비어 있을 수 있습니다.",
  );

  return {
    style,
    styleEvidence,
    apiHosts: [...hostCount.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count),
    apiPrefixes: [...prefixCount.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    models: models.slice(0, 30),
    stack,
    auth,
    statusCodes: [...statusCount.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => a.status - b.status),
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* 타입 출력                                                            */
/* ------------------------------------------------------------------ */

function tsName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  // 복수형 리소스명을 단수 타입명으로.
  return pascal.replace(/ies$/, "y").replace(/sses$/, "ss").replace(/([^s])s$/, "$1");
}

function kindsToTs(field: FieldShape, indent: string): string {
  const kinds = [...field.kinds].filter((k) => k !== "null");
  const nullable = field.kinds.has("null");

  let base: string;
  if (field.children?.fields.size && (kinds.includes("object") || kinds.includes("array"))) {
    const child = field.children;
    const inner = [...child.fields.values()]
      .map((c) => fieldToTs(c, child, indent + "  "))
      .join("\n");
    const obj = `{\n${inner}\n${indent}}`;
    base = kinds.includes("array") ? `${obj}[]` : obj;
  } else if (kinds.length === 0) {
    // 모든 샘플이 null 이었다 — 실제 타입을 알 수 없으므로 unknown 하나로 둔다.
    return "unknown";
  } else {
    base = kinds
      .map((k) => {
        if (k === "array") return "unknown[]";
        if (k === "object") return "Record<string, unknown>";
        if (k === "unknown") return "unknown";
        return k;
      })
      .join(" | ");
  }
  return nullable ? `${base} | null` : base;
}

function fieldToTs(field: FieldShape, parent: ShapeNode, indent: string): string {
  // 키가 아예 없던 객체가 있을 때만 선택적이다. 값이 null 인 것은 nullable 이지 optional 이 아니다.
  const optional = field.present < parent.count ? "?" : "";
  const comments: string[] = [];
  if (field.formats.size) comments.push([...field.formats].join("/"));
  if (field.samples.length) comments.push(`예: ${field.samples.slice(0, 2).join(", ")}`);
  if (field.kinds.size === 1 && field.kinds.has("null")) comments.push("모든 샘플이 null — 실제 타입 미상");
  const comment = comments.length ? ` // ${comments.join(" · ")}` : "";
  const safeName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name) ? field.name : JSON.stringify(field.name);
  return `${indent}${safeName}${optional}: ${kindsToTs(field, indent)};${comment}`;
}

/** 추론한 모델을 TypeScript 인터페이스로 뽑는다. 붙여넣어 바로 쓸 수 있는 형태. */
export function modelsToTypeScript(models: InferredModel[]): string {
  if (!models.length) return "// 추론할 JSON 응답이 없습니다.";
  return models
    .map((m) => {
      const header = [
        `/** ${m.name} — 샘플 ${m.sampleCount}건에서 추론`,
        " *   `?` = 관찰된 응답 중 일부에만 있던 키 (생성 응답처럼 축약된 형태가 섞이면 늘어난다)",
        ...m.endpoints.slice(0, 6).map((e) => ` *   ${e}`),
        m.pagination.length ? ` *   페이지네이션: ${m.pagination.join(", ")}` : null,
        " */",
      ]
        .filter(Boolean)
        .join("\n");
      const body = [...m.shape.fields.values()]
        .map((f) => fieldToTs(f, m.shape, "  "))
        .join("\n");
      return `${header}\nexport interface ${tsName(m.name)} {\n${body}\n}`;
    })
    .join("\n\n");
}

/** 사람이 읽는 백엔드 구조 보고서. */
export function inferenceToMarkdown(inf: BackendInference): string {
  const lines: string[] = ["# 백엔드 구조 추론", ""];

  lines.push("> 관찰한 트래픽만으로 되짚은 것입니다. `추론`은 증거와 함께 적었습니다.", "");

  lines.push(`## API 스타일`, "", `**${inf.style}** — ${inf.styleEvidence}`, "");

  if (inf.apiHosts.length) {
    lines.push("## 호스트", "");
    for (const h of inf.apiHosts) lines.push(`- \`${h.host}\` — 요청 ${h.count}건`);
    lines.push("");
  }

  if (inf.apiPrefixes.length) {
    lines.push("## 경로 접두사", "");
    for (const p of inf.apiPrefixes) lines.push(`- \`${p.prefix}\` — ${p.count}건`);
    lines.push("");
  }

  lines.push("## 인증", "");
  for (const a of inf.auth) lines.push(`- **${a.claim}** — ${a.evidence}`);
  lines.push("");

  if (inf.stack.length) {
    lines.push("## 스택 지문", "");
    for (const s of inf.stack) lines.push(`- **${s.claim}** — ${s.evidence}`);
    lines.push("");
  }

  if (inf.statusCodes.length) {
    lines.push("## 관찰된 상태 코드", "");
    lines.push(inf.statusCodes.map((s) => `\`${s.status}\` ×${s.count}`).join(" · "), "");
  }

  if (inf.models.length) {
    lines.push("## 데이터 모델", "");
    for (const m of inf.models) {
      lines.push(`### ${m.name}`, "");
      lines.push(`샘플 ${m.sampleCount}건 · 필드 ${m.shape.fields.size}개`);
      if (m.pagination.length) lines.push(`페이지네이션 키: ${m.pagination.join(", ")}`);
      lines.push("");
      for (const e of m.endpoints.slice(0, 8)) lines.push(`- \`${e}\``);
      lines.push("");
    }
  }

  if (inf.notes.length) {
    lines.push("## 한계", "");
    for (const n of inf.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n");
}
