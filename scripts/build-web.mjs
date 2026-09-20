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

const PACKAGE = {
  name: "web-extractor-web",
  private: true,
  // 앱 버전은 루트 package.json 을 따라간다.
  version: JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  type: "module",
  scripts: { start: "node server.mjs" },
  engines: { node: ">=20" },
};

// 서버는 따로 두고 복사한다 — 문자열로 품고 있으면 고칠 때마다 이스케이프에 시달린다.
writeFileSync(
  path.join(OUT, "server.mjs"),
  readFileSync(path.join(ROOT, "scripts", "deploy-server.mjs")),
);
writeFileSync(path.join(OUT, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);

console.log(`\n웹 배포용 빌드 완료 — ${path.relative(ROOT, OUT)}`);
console.log("  이 폴더를 그대로 배포하면 됩니다 (start: node server.mjs).");
console.log("  자산을 인라인으로 올리기 어려운 호스팅이면: node scripts/release-web.mjs");
