export type TabId = "collect" | "ui" | "nav" | "api";

export type Framework = "react-ts" | "react-js" | "vue-ts" | "svelte" | "html";
export type StyleSystem = "tailwind" | "css-modules" | "styled-components" | "plain-css";
export type OutputShape = "single-file" | "split-components";
export type Strictness = "pixel" | "high" | "balanced";

export interface UiOptions {
  framework: Framework;
  style: StyleSystem;
  output: OutputShape;
  strictness: Strictness;
  responsive: boolean;
  a11y: boolean;
  interactionStates: boolean;
  darkMode: boolean;
  svgIcons: boolean;
  noPlaceholder: boolean;
  designTokens: boolean;
  koreanComments: boolean;
  targetName: string;
  extra: string;
}

export interface NavOptions {
  url: string;
  scope: string;
  credentials: string;
  maxDepth: number;
  driver: "playwright-mcp" | "chrome-devtools-mcp" | "manual";
  focus: Record<NavFocusKey, boolean>;
  deliverables: Record<NavDeliverableKey, boolean>;
  extra: string;
}

export type NavFocusKey =
  | "dialogs"
  | "forms"
  | "validation"
  | "dynamic"
  | "errors"
  | "permissions"
  | "emptyStates"
  | "pagination"
  | "network";

export type NavDeliverableKey =
  | "spec"
  | "flowchart"
  | "screenshots"
  | "playwrightTests"
  | "stateMatrix";

export interface ApiOptions {
  baseUrl: string;
  lang: "typescript" | "python" | "go" | "curl";
  auth: "auto" | "bearer" | "cookie" | "apikey" | "none";
  includeTypes: boolean;
  includeRetry: boolean;
  redactSecrets: boolean;
  extra: string;
}

/** HAR 파일에서 뽑아낸 엔드포인트 한 건. */
export interface HarEndpoint {
  method: string;
  url: string;
  path: string;
  host: string;
  status: number;
  mimeType: string;
  queryKeys: string[];
  requestBodySample: string | null;
  responseBodySample: string | null;
  authHeaders: string[];
  count: number;
}

export interface ImageAsset {
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** base64, data: 접두사 없음 */
  data: string;
  /** 미리보기용 data URL */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}
