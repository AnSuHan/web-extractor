/**
 * 배포된 앱을 띄우는 정적 서버. 의존성이 없다.
 *
 * 자산(js/css)은 gzip 을 base64 로 바꿔 여러 조각으로 올라와 있다 (pack-web.mjs 참고).
 * 시작할 때 조각을 이어 붙여 gzip 바이트로 되돌리고, 그대로 `Content-Encoding: gzip` 으로
 * 내보낸다 — 서버가 풀지 않으니 빠르고, 브라우저가 알아서 푼다.
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
};

/* ------------------------- 조각난 자산 되살리기 ------------------------- */

/** 서빙 경로 → { body: gzip 바이트, type } */
const packed = new Map();

async function loadPackedAssets() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(ROOT, "assets-manifest.json"), "utf8"));
  } catch {
    return; // 조각 없이 올라간 경우 — 평범한 정적 서버로 동작한다.
  }

  for (const entry of manifest) {
    try {
      let base64 = "";
      for (const part of entry.parts) {
        base64 += await readFile(path.join(ROOT, part), "utf8");
      }
      const body = Buffer.from(base64, "base64");
      packed.set(entry.serve, {
        body,
        type: TYPES[path.extname(entry.serve).toLowerCase()] ?? "application/octet-stream",
      });
      console.log(`asset ready: ${entry.serve} (${(body.length / 1024).toFixed(0)}KB gzip)`);
    } catch (err) {
      console.error(`asset failed: ${entry.serve} — ${err?.message ?? err}`);
    }
  }
}

/* ------------------------------- 서버 --------------------------------- */

/** 요청 경로를 이 폴더 안으로 가둔다 — 상위로 빠져나가지 못하게. */
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean).join("/");
  const target = path.resolve(ROOT, clean || "index.html");
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

async function exists(file) {
  try {
    const info = await stat(file);
    return info.isDirectory() ? path.join(file, "index.html") : file;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end("method not allowed");
    return;
  }

  const url = req.url ?? "/";
  const head = req.method === "HEAD";

  // 1) 조각으로 올라온 자산
  for (const key of candidates(url)) {
    const hit = packed.get(key);
    if (!hit) continue;
    res.writeHead(200, {
      "content-type": hit.type,
      "content-encoding": "gzip",
      "content-length": hit.body.length,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(head ? undefined : hit.body);
    return;
  }

  // 2) 평범한 파일
  for (const key of candidates(url).concat("index.html")) {
    const target = resolveSafe(`/${key}`);
    if (!target) continue;
    const file = await exists(target);
    if (!file) continue;
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
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

await loadPackedAssets();
server.listen(PORT, () => console.log(`web-extractor listening on ${PORT}`));
