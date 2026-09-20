/**
 * 빌드된 자산을 GitHub 릴리스에 올리고, 배포 서버가 받아갈 주소를 적어 둔다.
 *
 * 왜 이런 단계가 있나: 호스팅에 따라 **파일 내용을 인라인으로만** 올릴 수 있어서,
 * 500KB 짜리 번들을 그대로 밀어 넣기 어렵다. 그래서 자산은 공개 릴리스에 두고,
 * 배포된 서버가 부팅할 때 한 번 받아 디스크에 캐시한다 (deploy-server.mjs 참고).
 *
 *   node scripts/release-web.mjs            # 현재 origin 저장소의 web-assets 태그에 올린다
 *
 * 토큰은 git 자격증명 저장소에서 꺼내 쓰고 **출력하지 않는다.** 저장소가 비공개면
 * 받는 쪽에서 인증이 필요해지므로 공개 저장소에서만 쓴다.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const TAG = process.env.WX_RELEASE_TAG || "web-assets";

/* ----------------------------- 저장소·토큰 ----------------------------- */

function repoSlug() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  if (!match) throw new Error(`origin 이 GitHub 저장소가 아닙니다: ${url}`);
  return match[1];
}

function githubToken() {
  const out = execFileSync("git", ["credential", "fill"], {
    cwd: ROOT,
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  const line = out.split("\n").find((l) => l.startsWith("password="));
  if (!line) throw new Error("GitHub 자격증명을 찾지 못했습니다. 먼저 한 번 push 해 주세요.");
  return line.slice("password=".length).trim();
}

/* ------------------------------- API ---------------------------------- */

const REPO = repoSlug();
const TOKEN = githubToken();
const HEADERS = {
  authorization: `token ${TOKEN}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "web-extractor-release",
};

async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/* ------------------------------- 실행 ---------------------------------- */

let release = await api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
if (release.status === 404) {
  release = await api(`https://api.github.com/repos/${REPO}/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tag_name: TAG,
      name: "web build assets",
      body: "`npm run build:web` 의 결과입니다. 배포된 서버가 부팅할 때 여기서 받아 갑니다.",
    }),
  });
}
if (release.status >= 300) {
  throw new Error(`릴리스를 준비하지 못했습니다 (HTTP ${release.status}) ${JSON.stringify(release.body).slice(0, 200)}`);
}

// 같은 이름이 있으면 지우고 다시 올린다 — 해시가 바뀌면 이름도 바뀌지만, 같은 빌드를 다시
// 올리는 경우를 위해.
for (const asset of release.body.assets ?? []) {
  await api(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { method: "DELETE" });
}

const names = [];
for (const name of readdirSync(path.join(DIST, "assets"))) {
  const data = readFileSync(path.join(DIST, "assets", name));
  const res = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${release.body.id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...HEADERS, "content-type": "application/octet-stream" }, body: data },
  );
  if (!res.ok) throw new Error(`${name} 업로드 실패 (HTTP ${res.status})`);
  console.log(`  올림: ${name} (${(data.length / 1024).toFixed(0)}KB)`);
  names.push(name);
}

const source = {
  baseUrl: `https://github.com/${REPO}/releases/download/${TAG}`,
  files: names,
};
writeFileSync(path.join(DIST, "assets-source.json"), `${JSON.stringify(source, null, 2)}\n`);

console.log(`\n릴리스 완료 — ${source.baseUrl}`);
console.log("  dist/assets-source.json 을 함께 배포하면 서버가 부팅할 때 받아 갑니다.");
