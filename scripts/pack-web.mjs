/**
 * 배포용 묶음 만들기.
 *
 * 에그호스팅 MCP 로는 파일 **내용을 텍스트로 넘겨서** 올린다. 그래서 500KB 짜리 번들을
 * 그대로 보내면 한 번에 실어 나르기 어렵다. 여기서는
 *
 *   1. 빌드 결과(js/css)를 gzip 으로 줄이고
 *   2. base64 로 바꿔 텍스트로 만들고
 *   3. 일정 크기로 잘라 여러 조각 파일로 둔다
 *
 * 서버는 조각을 이어 붙여 gzip 바이트를 복원하고 `Content-Encoding: gzip` 으로 그대로
 * 내보낸다 — 풀지 않으므로 메모리도 적게 쓰고 브라우저가 알아서 푼다.
 *
 * 결과물: deploy/ (이 폴더가 곧 배포 단위)
 */

import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "deploy");
/** 조각 하나의 최대 길이. 한 번에 옮기기 부담스럽지 않을 만큼만. */
const PART_CHARS = 40_000;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "assets"), { recursive: true });

/* 1. 자산을 gzip → base64 → 조각으로 ------------------------------------ */

const manifest = [];
for (const name of readdirSync(path.join(DIST, "assets"))) {
  const raw = readFileSync(path.join(DIST, "assets", name));
  const base64 = gzipSync(raw, { level: 9 }).toString("base64");
  const parts = [];
  for (let i = 0; i < base64.length; i += PART_CHARS) {
    const partName = `${name}.gz.b64.${String(parts.length).padStart(3, "0")}`;
    writeFileSync(path.join(OUT, "assets", partName), base64.slice(i, i + PART_CHARS));
    parts.push(`assets/${partName}`);
  }
  manifest.push({ serve: `assets/${name}`, parts, bytes: raw.length, packed: base64.length });
}

writeFileSync(path.join(OUT, "assets-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

/* 2. index.html 은 그대로 (자산 이름이 같다) ----------------------------- */

writeFileSync(path.join(OUT, "index.html"), readFileSync(path.join(DIST, "index.html")));
writeFileSync(path.join(OUT, "package.json"), readFileSync(path.join(DIST, "package.json")));

/* 3. 조각을 이어 붙여 내보내는 서버 -------------------------------------- */

writeFileSync(path.join(OUT, "server.mjs"), readFileSync(path.join(ROOT, "scripts", "deploy-server.mjs")));

/* 4. 요약 ---------------------------------------------------------------- */

const totalRaw = manifest.reduce((sum, m) => sum + m.bytes, 0);
const totalPacked = manifest.reduce((sum, m) => sum + m.packed, 0);
const partCount = manifest.reduce((sum, m) => sum + m.parts.length, 0);

console.log(`\n배포 묶음 완료 — ${path.relative(ROOT, OUT)}`);
for (const m of manifest) {
  console.log(
    `  ${m.serve}  ${(m.bytes / 1024).toFixed(0)}KB → ${(m.packed / 1024).toFixed(0)}KB (조각 ${m.parts.length})`,
  );
}
console.log(
  `  합계 ${(totalRaw / 1024).toFixed(0)}KB → ${(totalPacked / 1024).toFixed(0)}KB, 조각 ${partCount}개`,
);
