/**
 * 배포된 앱을 띄우는 정적 서버. 의존성이 없다.
 *
 * 자산(js/css)은 두 가지 방법 중 하나로 들어온다.
 *
 *   1. 같이 복사되어 `assets/` 에 이미 있는 경우 — 그대로 서빙한다.
 *   2. 없는 경우 — `assets-source.json` 이 가리키는 곳(GitHub 릴리스)에서 **부팅할 때
 *      한 번 받아** `assets/` 에 넣는다. 호스팅이 파일을 인라인으로만 받는 탓에 500KB 짜리
 *      번들을 밀어 넣기 어려울 때 쓰는 길이다. 한 번 받으면 디스크에 남아 다시 받지 않는다.
 *
 * 호스팅이 주는 PORT 를 쓰고, 없으면 8080 을 쓴다.
 */
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
};

/* ------------------------- 자산 확보 (필요할 때만) ------------------------- */

async function fileExists(file) {
  try {
    const info = await stat(file);
    return info.isDirectory() ? path.join(file, "index.html") : file;
  } catch {
    return null;
  }
}

async function ensureAssets() {
  let source;
  try {
    source = JSON.parse(await readFile(path.join(ROOT, "assets-source.json"), "utf8"));
  } catch {
    return; // 자산이 함께 복사된 경우 — 받아올 것이 없다.
  }

  await mkdir(path.join(ROOT, "assets"), { recursive: true });

  for (const name of source.files ?? []) {
    const target = path.join(ROOT, "assets", name);
    if (await fileExists(target)) continue;

    const url = `${source.baseUrl}/${name}`;
    // 네트워크가 잠깐 흔들릴 수 있으니 몇 번 다시 시도한다.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        await writeFile(target, body);
        console.log(`asset fetched: ${name} (${(body.length / 1024).toFixed(0)}KB)`);
        break;
      } catch (err) {
        const message = err?.message ?? err;
        if (attempt === 3) {
          console.error(`asset FAILED: ${name} — ${message} (${url})`);
        } else {
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
    }
  }
}

/* ------------------------------- 서버 --------------------------------- */

/** 요청 경로를 이 폴더 안으로 가둔다 — 상위로 빠져나가지 못하게. */
function resolveSafe(relative) {
  const target = path.resolve(ROOT, relative || "index.html");
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

/**
 * 하위 경로(/web-extractor/…)로 프록시될 때, 앞 조각이 붙은 채 들어오기도 하고
 * 벗겨진 채 들어오기도 한다. 두 경우 모두에서 같은 파일을 찾아낸다.
 */
function candidates(urlPath) {
  const parts = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean);
  const list = [parts.join("/")];
  if (parts.length > 1) list.push(parts.slice(1).join("/"));
  return list.filter(Boolean);
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end("method not allowed");
    return;
  }

  const head = req.method === "HEAD";
  const urlPath = (req.url ?? "/").split("?")[0];

  // 하위 경로(/web-extractor)에 슬래시 없이 들어오면 상대 경로가 한 칸 위로 잡혀
  // 자산을 루트(/assets/…)에서 찾게 된다. 슬래시를 붙여 다시 보낸다.
  if (!urlPath.endsWith("/") && !path.extname(urlPath)) {
    res.writeHead(301, { location: `${urlPath}/` });
    res.end();
    return;
  }

  // 없는 경로는 첫 화면으로 보낸다 — 라우터가 없는 앱이다.
  for (const key of [...candidates(req.url ?? "/"), "index.html"]) {
    const target = resolveSafe(key);
    if (!target) continue;
    const file = await fileExists(target);
    if (!file) continue;
    try {
      const data = await readFile(file);
      const isAsset = file.includes(`${path.sep}assets${path.sep}`);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        // 자산 이름에 해시가 붙으므로 오래 캐시해도 안전하다. HTML 은 그러면 안 된다.
        "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(head ? undefined : data);
      return;
    } catch {
      /* 다음 후보 */
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

await ensureAssets();
server.listen(PORT, () => console.log(`web-extractor listening on ${PORT}`));
