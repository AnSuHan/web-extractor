import type { ApiOptions, HarEndpoint, NavOptions, UiOptions } from "./types";

/* ------------------------------------------------------------------ */
/* 공통 헬퍼                                                            */
/* ------------------------------------------------------------------ */

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const section = (title: string, body: string) => `# ${title}\n\n${body}`;
const join = (parts: (string | null | undefined | false)[]) =>
  parts.filter(Boolean).join("\n\n---\n\n");

/* ------------------------------------------------------------------ */
/* 1) 이미지 → 프론트 구현 프롬프트                                      */
/* ------------------------------------------------------------------ */

const FRAMEWORK_RULES: Record<UiOptions["framework"], string> = {
  "react-ts": [
    "Use React functional components.",
    "Use TypeScript.",
    "Keep components reusable.",
    "Do not over-abstract.",
  ].join("\n\n"),
  "react-js": [
    "Use React functional components.",
    "Use modern JavaScript (ES2022), no TypeScript.",
    "Keep components reusable.",
    "Do not over-abstract.",
  ].join("\n\n"),
  "vue-ts": [
    'Use Vue 3 Single File Components with `<script setup lang="ts">`.',
    "Use TypeScript.",
    "Keep components reusable.",
    "Do not over-abstract.",
  ].join("\n\n"),
  svelte: [
    "Use Svelte 5 components with runes.",
    "Use TypeScript.",
    "Keep components reusable.",
    "Do not over-abstract.",
  ].join("\n\n"),
  html: [
    "Use a single static HTML document.",
    "No framework, no build step.",
    "Use plain semantic HTML elements.",
  ].join("\n\n"),
};

const STYLE_RULES: Record<UiOptions["style"], string> = {
  tailwind: [
    "Use TailwindCSS.",
    "Avoid inline styles unless absolutely necessary.",
    "When a Tailwind scale step does not match the measured value, use an arbitrary value (e.g. `p-[31px]`), never the nearest step.",
  ].join("\n\n"),
  "css-modules": [
    "Use CSS Modules (one `.module.css` per component).",
    "Avoid inline styles unless absolutely necessary.",
    "Write exact pixel values. Never round.",
  ].join("\n\n"),
  "styled-components": [
    "Use styled-components.",
    "Declare one styled component per visual element.",
    "Write exact pixel values. Never round.",
  ].join("\n\n"),
  "plain-css": [
    "Use a single plain CSS stylesheet with BEM-style class names.",
    "Avoid inline styles unless absolutely necessary.",
    "Write exact pixel values. Never round.",
  ].join("\n\n"),
};

const STRICTNESS_RULES: Record<UiOptions["strictness"], string> = {
  pixel: [
    "Pixel-perfect reproduction is the highest priority.",
    "Never sacrifice visual accuracy for cleaner code.",
    "Never approximate values.",
    "If the screenshot shows 31px, do not change it to 32px.",
  ].join("\n\n"),
  high: [
    "Visual fidelity is the highest priority.",
    "Measured values may be snapped to the nearest 1px, never further.",
    "Preserve every visual relationship (alignment, grouping, hierarchy) exactly.",
  ].join("\n\n"),
  balanced: [
    "Visual fidelity comes first, but values may be normalized onto a consistent 4px spacing scale when the deviation is under 2px.",
    "Document every normalization you make in a trailing comment block.",
    "Layout, hierarchy, and color must still match exactly.",
  ].join("\n\n"),
};

const FORBIDDEN = [
  "Never redesign.",
  "Never modernize.",
  "Never normalize spacing.",
  "Never improve typography.",
  "Never simplify hierarchy.",
  "Never merge components.",
  "Never split components.",
  "Never replace components.",
  "Never change DOM hierarchy.",
  "Never replace icons.",
  "Never replace images.",
  "Never change color palette.",
  "Never add animations.",
  "Never remove empty spacing.",
  "Never infer better UX.",
  "Never use placeholders.",
  "Never generate fake content.",
  "Never omit small UI details.",
  "Never optimize the layout.",
];

export function buildUiPrompt(o: UiOptions, imageCount: number): string {
  const forbidden = o.noPlaceholder
    ? FORBIDDEN
    : FORBIDDEN.filter(
        (f) => !f.includes("placeholders") && !f.includes("fake content"),
      );

  const optional: string[] = [];
  if (o.responsive) {
    optional.push(
      section(
        "Responsive Behavior",
        [
          "The screenshot defines the desktop breakpoint. Reproduce it exactly at that width.",
          "Additionally provide mobile and tablet behavior by collapsing containers along their existing flex/grid axes.",
          "Do not invent new layouts for smaller breakpoints. Only reflow what already exists.",
          "Never change desktop appearance while adding responsive rules.",
        ].join("\n\n"),
      ),
    );
  }
  if (o.interactionStates) {
    optional.push(
      section(
        "Interaction States",
        [
          "Implement hover, focus, active, disabled, selected, loading, and error states for every interactive element.",
          "If a state is not visible in the screenshot, derive it from the element's own base colors (e.g. a measurable darkening of the background) and mark it with a `// INFERRED STATE` comment.",
          "Never let an inferred state change the element's default appearance.",
        ].join("\n\n"),
      ),
    );
  }
  if (o.darkMode) {
    optional.push(
      section(
        "Dark Mode",
        [
          "Treat the screenshot as the source of truth for exactly one theme. Detect which one it is.",
          "Produce the opposite theme by inverting lightness while preserving hue and saturation relationships.",
          "The theme shown in the screenshot must render byte-identical to the single-theme output.",
          "Mark every derived color with a `// DERIVED` comment.",
        ].join("\n\n"),
      ),
    );
  }
  if (o.designTokens) {
    optional.push(
      section(
        "Design Tokens",
        [
          "Before writing components, emit a token block containing every distinct color, font size, font weight, line height, radius, shadow, and spacing value you measured.",
          "Tokens are a naming layer only. They must not merge two values that differ, even by 1px or one hex digit.",
          "Reference tokens from components. Do not re-declare raw values inline once a token exists.",
        ].join("\n\n"),
      ),
    );
  }

  const outputRules =
    o.output === "single-file"
      ? [
          "Return one self-contained file that renders the entire screen.",
          "Declare sub-components in the same file, above the default export.",
        ].join("\n\n")
      : [
          "Return one file per component.",
          "Prefix each file with a `// FILE: <path>` comment line so the files can be split apart mechanically.",
          "Include an entry file that composes the screen.",
        ].join("\n\n");

  const imageLine =
    imageCount === 0
      ? "The UI screenshot will be provided alongside this prompt."
      : imageCount === 1
        ? "One UI screenshot is provided with this prompt."
        : `${imageCount} UI screenshots are provided with this prompt. They are different states or regions of the SAME interface. Reconcile them into one component tree — do not produce ${imageCount} independent results.`;

  return join([
    section(
      "Role",
      [
        "You are a senior frontend architect and UI reconstruction engine.",
        "Your only objective is to reproduce the uploaded UI with the highest possible visual fidelity.",
        "You are NOT allowed to redesign, simplify, modernize, optimize, or improve anything.",
        "Your responsibility is to faithfully reconstruct the interface exactly as shown.",
        "The output must be production-ready frontend code.",
      ].join("\n\n"),
    ),
    section(
      "Input",
      [imageLine, o.targetName ? `The screen is called: ${o.targetName}` : null]
        .filter(Boolean)
        .join("\n\n"),
    ),
    section(
      "Absolute Objective",
      [
        "Generate frontend code that is visually indistinguishable from the provided screenshot.",
        STRICTNESS_RULES[o.strictness],
      ].join("\n\n"),
    ),
    section(
      "Architecture",
      [
        "Treat this task as a reconstruction pipeline.",
        "Image\n↓\nUI Analysis\n↓\nLayout Tree\n↓\nComponent Tree\n↓\nSemantic Analysis\n↓\nConstraint Validation\n↓\nFrontend Code",
        "Do NOT skip any reasoning step.",
      ].join("\n\n"),
    ),
    section(
      "Analysis Order",
      [
        "Always analyze the image in the following order.",
        [
          "1. Overall Page Structure",
          "2. Sections",
          "3. Layout Containers",
          "4. Component Hierarchy",
          "5. Typography",
          "6. Colors",
          "7. Spacing",
          "8. Borders",
          "9. Radius",
          "10. Shadows",
          "11. Icons",
          "12. Images",
          "13. Alignment",
          "14. Interaction States",
          "15. Responsive Behavior",
        ].join("\n"),
        "Only after all analysis is complete may you generate code.",
      ].join("\n\n"),
    ),
    section(
      "UI Reconstruction Rules",
      [
        "Preserve exactly",
        bullets([
          "layout",
          "spacing",
          "alignment",
          "typography",
          "colors",
          "shadows",
          "borders",
          "border radius",
          "icon positions",
          "image positions",
          "text hierarchy",
          "padding",
          "margin",
          "gaps",
        ]),
      ].join("\n\n"),
    ),
    section("Forbidden", forbidden.join("\n\n")),
    section(
      "Layout Rules",
      [
        "Preserve",
        [
          "exact width",
          "exact height",
          "exact position",
          "exact alignment",
          "exact nesting",
          "exact visual grouping",
        ].join("\n\n"),
        "Container hierarchy must remain identical.",
      ].join("\n\n"),
    ),
    section(
      "Component Rules",
      [
        "Detect every UI component individually.",
        "Supported components include",
        [
          "Button",
          "Input",
          "Textarea",
          "Checkbox",
          "Radio",
          "Switch",
          "Select",
          "Dropdown",
          "Tabs",
          "Table",
          "Card",
          "Avatar",
          "Badge",
          "Chip",
          "Dialog",
          "Modal",
          "Navbar",
          "Sidebar",
          "Pagination",
          "Tooltip",
          "Toast",
          "Divider",
          "Image",
          "Icon",
        ].join("\n\n"),
        "Each component must remain independent.",
      ].join("\n\n"),
    ),
    section(
      "Typography Rules",
      [
        "Preserve",
        [
          "font hierarchy",
          "font size",
          "font weight",
          "line height",
          "letter spacing",
          "text alignment",
          "text color",
          "text casing",
        ].join("\n\n"),
        "Never substitute fonts unless the original font cannot be identified.",
      ].join("\n\n"),
    ),
    section(
      "Color Rules",
      [
        "Extract exact HEX colors.",
        "Do not approximate.",
        "Preserve",
        [
          "background",
          "foreground",
          "border",
          "text",
          "icon",
          "shadow colors",
          "gradient colors",
        ].join("\n\n"),
      ].join("\n\n"),
    ),
    section(
      "Spacing Rules",
      [
        "Spacing is critical.",
        "Preserve",
        [
          "margin",
          "padding",
          "gap",
          "flex spacing",
          "grid spacing",
          "white space",
        ].join("\n\n"),
        o.strictness === "balanced"
          ? "Normalization is permitted only under the tolerance stated in Absolute Objective, and must be documented."
          : "Do not normalize spacing.",
      ].join("\n\n"),
    ),
    section(
      "Border Rules",
      [
        "Preserve",
        [
          "border width",
          "border color",
          "border style",
          "border radius",
          "shadow",
          "elevation",
        ].join("\n\n"),
      ].join("\n\n"),
    ),
    section(
      "Images",
      [
        "Preserve",
        ["aspect ratio", "crop", "alignment", "size"].join("\n\n"),
        o.noPlaceholder
          ? "Do not replace images with placeholders."
          : "Where the original asset is unavailable, use a neutral solid-color block of the exact same dimensions and mark it `/* ASSET PLACEHOLDER */`.",
      ].join("\n\n"),
    ),
    section(
      "Icons",
      o.svgIcons
        ? [
            "Do not replace icons with similar icons.",
            "If the icon library is unknown,",
            "recreate the icon using inline SVG with an exact viewBox and path data that matches the drawn shape.",
          ].join("\n\n")
        : [
            "Do not replace icons with similar icons.",
            "Identify the icon library if possible and import the exact icon by name.",
            "If the library cannot be identified, recreate the icon using inline SVG.",
          ].join("\n\n"),
    ),
    o.a11y
      ? section(
          "Accessibility",
          [
            "Generate semantic HTML.",
            "Use",
            [
              "main",
              "nav",
              "header",
              "section",
              "article",
              "footer",
              "button",
              "input",
              "label",
            ].join("\n\n"),
            "when appropriate.",
            "Accessibility must not change the visual appearance.",
          ].join("\n\n"),
        )
      : null,
    section(
      "CSS Rules",
      [
        STYLE_RULES[o.style],
        "Visual accuracy is more important than code elegance.",
      ].join("\n\n"),
    ),
    section(
      o.framework.startsWith("react") ? "React Rules" : "Framework Rules",
      FRAMEWORK_RULES[o.framework],
    ),
    ...optional,
    section(
      "Output Structure",
      [
        outputRules,
        "Return only production-ready code.",
        "Do not explain.",
        "Do not describe.",
        "Do not apologize.",
        "Do not include markdown explanations.",
        "Only output source code.",
        o.koreanComments
          ? "Code comments must be written in Korean. Everything else stays in code."
          : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
    section(
      "Validation Checklist",
      [
        "Before generating code verify internally",
        [
          "✓ Layout identical",
          "✓ Component count identical",
          "✓ Typography identical",
          "✓ Colors identical",
          "✓ Borders identical",
          "✓ Radius identical",
          "✓ Shadows identical",
          "✓ Padding identical",
          "✓ Margin identical",
          "✓ DOM hierarchy preserved",
          "✓ Visual grouping preserved",
          "✓ No redesign",
          "✓ No simplification",
          "✓ No optimization",
          o.responsive ? "✓ Desktop appearance unchanged by responsive rules" : null,
          o.a11y ? "✓ Semantics added without visual change" : null,
          o.darkMode ? "✓ Screenshot theme renders identically" : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
        "If any check fails,\n\nrevise your internal result before producing the final code.",
      ].join("\n\n"),
    ),
    o.extra.trim() ? section("Additional Requirements", o.extra.trim()) : null,
    section(
      "Final Objective",
      [
        "The generated frontend should be visually indistinguishable from the original screenshot.",
        "If there is any conflict between clean code and visual accuracy,",
        "always choose visual accuracy.",
      ].join("\n\n"),
    ),
  ]);
}

/* ------------------------------------------------------------------ */
/* 2) 네비게이팅 테스트 (기능·동작 명세 추출)                            */
/* ------------------------------------------------------------------ */

const FOCUS_TEXT: Record<keyof NavOptions["focus"], string> = {
  dialogs:
    "Open every dialog, modal, drawer, and popover. For each, record its trigger, title, every field, every button, and what closing it does to the underlying screen.",
  forms:
    "For every form, record each field's label, type, placeholder, default value, required-ness, max length, and input mask.",
  validation:
    "Deliberately submit invalid input to each field (empty, too long, wrong format, boundary values) and record the exact error message and where it renders.",
  dynamic:
    "Hunt for dependent behavior: selecting X changes the options of Y, checking A reveals field B, a value auto-fills another field. These couplings are the part a static reading misses — probe for them explicitly.",
  errors:
    "Provoke failure paths: duplicate submission, expired session, denied permission, network failure (offline the page), missing record (navigate to a bad id). Record what the UI does in each case.",
  permissions:
    "If more than one role or permission level exists, walk the same screens per role and record what appears, disappears, or becomes read-only.",
  emptyStates:
    "Record the empty state, the loading/skeleton state, and the populated state of every list, table, and chart.",
  pagination:
    "Record pagination, sorting, filtering, and search behavior: page size, sort keys, whether filters combine, whether state survives navigation.",
  network:
    "Watch the network panel while interacting. Note which action fires which request, and whether the UI is optimistic or waits for the response.",
};

const DELIVERABLE_TEXT: Record<keyof NavOptions["deliverables"], string> = {
  spec: "**`SPEC.md` — functional specification.** One section per screen. Each section contains: purpose, entry points, every UI element with its behavior, every state the screen can be in, and every transition out of it. Write it so that a developer with no access to the original product could rebuild the behavior.",
  flowchart:
    '**`FLOWS.md` — click-path flowcharts** in Mermaid `flowchart TD`. One diagram per user journey. Nodes are screens or dialogs; edges are labeled with the exact control that causes the transition (e.g. `-- "저장" 버튼 -->`). Include failure edges, not just the happy path.',
  screenshots:
    "**`screenshots/`** — one screenshot per distinct state, named `<screen>--<state>.png`, referenced from SPEC.md at the point it documents.",
  playwrightTests:
    "**`tests/`** — runnable Playwright specs that assert the documented behavior. One file per screen. Use role-based locators. Every assertion must correspond to a line in SPEC.md.",
  stateMatrix:
    "**`STATES.md`** — a state matrix table per screen: rows are states (empty / loading / populated / error / no-permission / ...), columns are what each UI region shows in that state.",
};

export function buildNavPrompt(o: NavOptions): string {
  const focusItems = (Object.keys(o.focus) as (keyof NavOptions["focus"])[])
    .filter((k) => o.focus[k])
    .map((k) => FOCUS_TEXT[k]);

  const deliverableItems = (
    Object.keys(o.deliverables) as (keyof NavOptions["deliverables"])[]
  )
    .filter((k) => o.deliverables[k])
    .map((k) => DELIVERABLE_TEXT[k]);

  const driverText: Record<NavOptions["driver"], string> = {
    "playwright-mcp":
      "You have Playwright MCP attached. Drive the real browser: navigate, click, type, submit, screenshot, and read the accessibility tree. Never guess what a control does — click it and observe.",
    "chrome-devtools-mcp":
      "You have Chrome DevTools MCP attached. Drive the real browser and additionally inspect the network panel, console, and the live DOM. Never guess what a control does — click it and observe.",
    manual:
      "You do not have browser automation. Ask the operator to perform each step and paste back the resulting screenshot or DOM. Never guess what a control does — request evidence.",
  };

  return join([
    section(
      "Role",
      [
        "You are a black-box reverse engineer producing a behavioral specification of a web application you have no source code for.",
        "Your knowledge of this application comes exclusively from operating it. Every statement in your output must be traceable to something you actually observed.",
        "You are not designing, improving, or critiquing the application. You are documenting what it does.",
      ].join("\n\n"),
    ),
    section(
      "Target",
      [
        `Entry URL: ${o.url || "<to be supplied>"}`,
        o.scope.trim()
          ? `Scope:\n${o.scope.trim()}`
          : "Scope: the entire application reachable from the entry URL.",
        o.credentials.trim()
          ? `Credentials / setup:\n${o.credentials.trim()}`
          : "Credentials: none supplied. If a login wall blocks you, stop and report exactly what is needed.",
        `Maximum navigation depth from the entry URL: ${o.maxDepth}`,
      ].join("\n\n"),
    ),
    section("Tooling", driverText[o.driver]),
    section(
      "Method",
      [
        "Work in four passes. Do not start a pass before finishing the previous one.",
        [
          "**Pass 1 — Map.** Walk the application breadth-first and build an inventory of every reachable screen, its URL, and how you got there. Do not interact with controls yet beyond navigation.",
          "**Pass 2 — Surface.** For each screen, enumerate every interactive element from the accessibility tree, not from the rendered pixels. An element that is present but off-screen or collapsed still counts.",
          "**Pass 3 — Probe.** Operate every element you enumerated. This is where the real specification comes from.",
          "**Pass 4 — Write.** Produce the deliverables. Anything you could not verify goes in an explicit `## Unverified` section — never silently omitted, never guessed.",
        ].join("\n\n"),
      ].join("\n\n"),
    ),
    focusItems.length
      ? section(
          "What to probe in Pass 3",
          focusItems.map((t, i) => `${i + 1}. ${t}`).join("\n\n"),
        )
      : null,
    section(
      "Anti-happy-path mandate",
      [
        "The known failure mode of this task is producing a thin, optimistic document that only describes the successful path. Treat that as a failed run.",
        "Before you write anything, satisfy this quota per screen:",
        bullets([
          "at least one branch where the user does something invalid",
          "at least one branch where the backend or permission layer refuses",
          "at least one control whose effect is NOT obvious from its label, probed and documented",
          "at least one piece of coupled behavior (one control changing another)",
        ]),
        "If a screen genuinely has none of these, say so explicitly and state what you tried.",
        "Do not describe a control as 'standard', 'typical', or 'as expected'. Describe what it did.",
      ].join("\n\n"),
    ),
    section(
      "Evidence rules",
      bullets([
        "Every documented behavior names the exact control that produces it (its accessible name and role).",
        "Quote UI text verbatim, in its original language. Do not translate, paraphrase, or tidy it.",
        "Record exact URLs, including path params and query strings.",
        "Where you inferred rather than observed, prefix the line with `INFERRED:` and say what evidence led there.",
        "Never invent field names, error messages, endpoints, or status codes.",
      ]),
    ),
    deliverableItems.length
      ? section(
          "Deliverables",
          deliverableItems.map((t, i) => `${i + 1}. ${t}`).join("\n\n"),
        )
      : null,
    section(
      "Safety rules while operating the target",
      bullets([
        "Only operate systems you are authorized to test.",
        "Prefer a staging or test account. Do not exercise destructive actions (delete, payment, irreversible state changes) against production data.",
        "When a control looks destructive, document its confirmation dialog and stop there rather than confirming.",
        "Do not attempt to bypass authentication, rate limits, or access controls. A wall you cannot pass is a finding, not an obstacle.",
        "Never record real personal data, real credentials, or real tokens in the deliverables — redact them.",
      ]),
    ),
    o.extra.trim() ? section("Additional Requirements", o.extra.trim()) : null,
    section(
      "Done criteria",
      [
        "You are done when every screen in your Pass 1 map has a section in the specification, every section satisfies the anti-happy-path quota or explains why it cannot, and the `## Unverified` section lists everything you could not reach.",
        "Report your coverage as a count: screens mapped / screens documented / controls probed.",
      ].join("\n\n"),
    ),
  ]);
}

/* ------------------------------------------------------------------ */
/* 3) HAR → API 클라이언트 역설계                                        */
/* ------------------------------------------------------------------ */

const LANG_TEXT: Record<ApiOptions["lang"], string> = {
  typescript:
    "TypeScript, using the built-in `fetch`. Export one function per endpoint plus a typed client factory.",
  python:
    "Python 3.11+, using `httpx`. Export one method per endpoint on a single client class, with dataclass models.",
  go: "Go 1.22+, using `net/http`. One method per endpoint on a `Client` struct, with struct types for bodies.",
  curl: "Plain `curl` commands, one per endpoint, with placeholders for variables. No client library.",
};

const AUTH_TEXT: Record<ApiOptions["auth"], string> = {
  auto: "Determine the authentication scheme from the captured headers and cookies. State which scheme you concluded and what evidence supports it.",
  bearer:
    "Authentication is a bearer token in the `Authorization` header. Accept the token via constructor/argument, never hardcode it.",
  cookie:
    "Authentication is cookie-based. Preserve the cookie jar across calls and document which cookie carries the session.",
  apikey:
    "Authentication is an API key header. Accept the key via constructor/argument, never hardcode it.",
  none: "The API is unauthenticated. Do not add auth handling.",
};

export function buildApiPrompt(o: ApiOptions, endpoints: HarEndpoint[]): string {
  const inventory = endpoints.length
    ? endpoints
        .map(
          (e) =>
            `- \`${e.method} ${e.path}\` → ${e.status} ${e.mimeType || ""}` +
            (e.queryKeys.length ? `\n  - query: ${e.queryKeys.join(", ")}` : "") +
            (e.authHeaders.length
              ? `\n  - auth headers: ${e.authHeaders.join(", ")}`
              : "") +
            (e.count > 1 ? `\n  - observed ${e.count}×` : ""),
        )
        .join("\n")
    : "_No HAR loaded. The capture will be provided alongside this prompt._";

  const samples = endpoints
    .filter((e) => e.requestBodySample || e.responseBodySample)
    .slice(0, 20)
    .map((e) => {
      const parts = [`### ${e.method} ${e.path}`];
      if (e.requestBodySample)
        parts.push("Request body:\n```json\n" + e.requestBodySample + "\n```");
      if (e.responseBodySample)
        parts.push("Response body:\n```json\n" + e.responseBodySample + "\n```");
      return parts.join("\n\n");
    })
    .join("\n\n");

  return join([
    section(
      "Role",
      [
        "You are an API reverse engineer. You are given a network capture of a web application and must produce a working client library for the API behind it.",
        "You have no API documentation. The capture is your only source of truth.",
        "Do not invent endpoints, parameters, or fields that the capture does not show.",
      ].join("\n\n"),
    ),
    section(
      "Target",
      [
        o.baseUrl.trim()
          ? `Base URL: ${o.baseUrl.trim()}`
          : "Derive the base URL from the capture.",
        AUTH_TEXT[o.auth],
      ].join("\n\n"),
    ),
    section("Observed endpoints", inventory),
    samples ? section("Observed payloads", samples) : null,
    section(
      "Method",
      [
        "**1. Group.** Collapse the capture into distinct endpoints. Two requests differing only in a path id or query value are one endpoint with a parameter — identify the parameter and name it.",
        "**2. Type.** Derive request and response types from the observed payloads. Where a field appears in some responses and not others, mark it optional. Where a field is `null` in every sample, type it as unknown and say so.",
        "**3. Sequence.** Determine call order dependencies: which response supplies an id or token that a later request consumes. Document these as a required sequence.",
        "**4. Generate.** Write the client.",
        "**5. Report gaps.** List every endpoint whose semantics you could not determine from the capture alone, and say what additional capture would resolve it.",
      ].join("\n\n"),
    ),
    section(
      "Output",
      [
        `Language and shape: ${LANG_TEXT[o.lang]}`,
        o.includeTypes
          ? "Emit explicit types/models for every request and response body. Do not use a permissive `any`/`dict`/`interface{}` escape hatch except where step 2 concluded the type is genuinely unknown."
          : "Types are optional; keep the surface minimal.",
        o.includeRetry
          ? "Include error handling: raise/return a typed error carrying status code and response body, and retry idempotent requests on 429 and 5xx with exponential backoff, honoring `Retry-After`."
          : "Keep error handling minimal — surface the status code and body to the caller.",
        "Preserve the exact header set the application sends, minus hop-by-hop headers. Header order and casing that the capture shows should be reproduced where the language allows it.",
        "Include a short usage example at the end.",
      ].join("\n\n"),
    ),
    section(
      "Secrets",
      o.redactSecrets
        ? [
            "The capture may contain live tokens, cookies, and personal data.",
            "Never write a captured token, cookie value, password, or personal identifier into the generated code, comments, or examples. Replace each with a named parameter or an environment variable reference.",
            "If you notice a credential in the capture, say so once so the operator can rotate it — but do not reproduce its value.",
          ].join("\n\n")
        : "Use the captured values directly as defaults. (Not recommended — the output will contain live credentials.)",
    ),
    section(
      "Authorization",
      "Only build clients for APIs you are authorized to use. Respect the target's terms of service and rate limits; the generated client must not be designed to evade them.",
    ),
    o.extra.trim() ? section("Additional Requirements", o.extra.trim()) : null,
  ]);
}
