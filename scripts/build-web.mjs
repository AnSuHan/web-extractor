/**
 * 웹 호스팅용 빌드.
 *
 * 평소 빌드(`npm run build`)는 확장 안(`collector/app`)으로 들어간다 — 수집을 하려면
 * 앱이 확장 페이지여야 하기 때문이다. 이 스크립트는 같은 앱을 **아무 데나 올릴 수 있는
 * 정적 사이트**로 따로 빌드하고, 그 폴더 자체를 실행 가능한 앱으로 만든다.
 *
 *   dist/
 *   ├── index.html, assets/…   # 빌드된 앱 (참조는 전부 상대 경로)
 *   ├── server.mjs             # 의존성 없는 정적 서버 (PORT 환경변수)
 *   └── package.json           # start 스크립트 — 호스팅이 이걸 보고 띄운다
 *
 * 그래서 `dist` 를 그대로 배포하면 된다. 수집 기능은 확장 안에서만 동작하므로,
 * 올라간 사이트는 **캡처 파일을 올려 분석하고 프롬프트를 만드는 쪽**을 맡는다.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");

const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const build = spawnSync(
  process.execPath,
  [vite, "build", "--outDir", "dist", "--emptyOutDir"],
  { cwd: ROOT, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

/* ------------------------------------------------------------------ */
/* 배포 폴더를 그대로 띄울 수 있게 만든다                                   */
/* ------------------------------------------------------------------ */

const SERVER = `/**
 * 의존성 없는 정적 서버. 이 폴더를 그대로 띄우기 위한 것이다.
 *
 * 호스팅이 주는 PORT 를 쓰고, 없으면 8080 을 쓴다.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** 요청 경로를 이 폴더 안으로 가둔다 — \`..\` 로 밖을 읽지 못하게. */
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\\/+/, "");
  const target = path.resolve(ROOT, clean || "index.html");
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

async function exists(file) {
  try {
    const info = await stat(file);
    return info.isDirectory() ? path.join(file, "index.html") : file;
  } catch {
    return null;
  }
}

/**
 * 파일을 찾는다.
 *
 * 하위 경로(/web-extractor/…)로 프록시되는 경우, 앞 조각이 붙은 채로 들어오기도 하고
 * 벗겨진 채로 들어오기도 한다. 어느 쪽이든 열리도록 한 번 더 시도한다.
 * 못 찾으면 null 을 돌려주고, 호출한 쪽이 첫 화면으로 보낸다.
 */
async function locate(file, urlPath) {
  const direct = await exists(file);
  if (direct) return direct;

  const parts = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean);
  if (parts.length > 1) {
    const stripped = resolveSafe("/" + parts.slice(1).join("/"));
    if (stripped) return await exists(stripped);
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end("method not allowed");
    return;
  }

  let file = resolveSafe(req.url ?? "/");
  if (!file) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }

  const found = await locate(file, req.url ?? "/");
  file = found ?? path.join(ROOT, "index.html");

  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const immutable = file.includes(\`\${path.sep}assets\${path.sep}\`);
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      // 자산 파일 이름에 해시가 붙으므로 오래 캐시해도 안전하다. HTML 은 그러면 안 된다.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(PORT, () => console.log(\`web-extractor listening on \${PORT}\`));
`;

const PACKAGE = {
  name: "web-extractor-web",
  private: true,
  // 앱 버전은 루트 package.json 을 따라간다.
  version: JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  type: "module",
  scripts: { start: "node server.mjs" },
  engines: { node: ">=20" },
};

writeFileSync(path.join(OUT, "server.mjs"), SERVER);
writeFileSync(path.join(OUT, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);

console.log(`\n웹 배포용 빌드 완료 — ${path.relative(ROOT, OUT)}`);
console.log("  이 폴더를 그대로 배포하면 됩니다 (start: node server.mjs).");
