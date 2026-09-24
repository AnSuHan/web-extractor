/**
 * klata.or.kr 정적 캡처(목업) 전용 뷰어 서버. 의존성 없음.
 * 에그호스팅에서 기존 앱과 별개의 새 앱/새 경로(예: /klata)로 배포된다.
 *
 * 자산은 기존에 돌고 있는 klata 수집 앱의 결과물(tar.gz)을 부팅 때 한 번 받아
 * site/ 로 풀어서 서빙한다(바이너리를 배포 페이로드에 넣지 않기 위함).
 * 프록시가 접두사(/klata)를 떼든 안 떼든 동작하도록 'klata' 조각 이후만 서빙한다.
 */
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "site");
const PORT = Number(process.env.PORT) || 8080;
// 컨테이너 내부에서는 공개 도메인이 헤어핀 NAT 로 안 잡히므로, 같은 호스트에서
// web-extractor 앱(klata 다운로드 제공)이 도는 로컬 포트를 먼저 시도한다.
const SRCS = (process.env.KLATA_TARGZ
  ? [process.env.KLATA_TARGZ]
  : [
      "http://127.0.0.1:3100/web-extractor/klata/download.tar.gz",
      "http://127.0.0.1:3101/web-extractor/klata/download.tar.gz",
      "http://127.0.0.1:3100/klata/download.tar.gz",
      "http://127.0.0.1:3101/klata/download.tar.gz",
      "https://web-hosting.egghosting.com/web-extractor/klata/download.tar.gz",
    ]);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

// --- tar 추출(ustar, 의존성 없음). 아카이브 내 'klata-capture/' 접두사는 벗겨 site/ 로 푼다. ---
async function extractTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break; // 종료 블록
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const type = header[156];
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (!name || type === 53 /* '5' dir */ || name.endsWith("/")) continue;
    if (type !== 0 && type !== 48 /* '0' file */) continue;
    const relName = name.replace(/^klata-capture\//, "");
    const dest = path.join(SITE, relName);
    if (dest !== SITE && !dest.startsWith(SITE + path.sep)) continue; // path traversal 방어
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
}

async function ensureSite() {
  if (fs.existsSync(path.join(SITE, "index.html"))) return;
  for (let attempt = 1; attempt <= 8; attempt++) {
    for (const src of SRCS) {
      try {
        const res = await fetch(src, { redirect: "follow" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await mkdir(SITE, { recursive: true });
        await extractTarGz(Buffer.from(await res.arrayBuffer()));
        console.log("site extracted from", src);
        return;
      } catch (e) {
        console.error("site fetch/extract fail (try " + attempt + ") " + src + ":", String(e?.message || e));
      }
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

function rel(urlPath) {
  const parts = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean);
  const i = parts.indexOf("klata");
  return (i === -1 ? parts : parts.slice(i + 1)).join("/");
}
function safe(relative) {
  const target = path.resolve(SITE, relative || "index.html");
  return (target === SITE || target.startsWith(SITE + path.sep)) ? target : null;
}
async function resolveFile(relative) {
  const base = safe(relative);
  if (!base) return null;
  try {
    const s = await stat(base);
    if (s.isFile()) return base;
    if (s.isDirectory()) { const i = path.join(base, "index.html"); if ((await stat(i)).isFile()) return i; }
  } catch {}
  if (!path.extname(base)) { try { const h = base + ".html"; if ((await stat(h)).isFile()) return h; } catch {} }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end("method not allowed"); return; }
  const head = req.method === "HEAD";
  if (!fs.existsSync(path.join(SITE, "index.html"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><meta charset="utf-8"><title>준비 중</title><p style="font:16px system-ui;margin:8vh auto;max-width:640px;padding:0 16px">캡처 자산을 불러오는 중입니다. 잠시 후 새로고침해 주세요.</p><script>setTimeout(()=>location.reload(),4000)</script>');
    return;
  }
  const file = (await resolveFile(rel(req.url ?? "/"))) || (await resolveFile("index.html"));
  if (!file) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
  try {
    const data = await readFile(file);
    const isStatic = /[\\/]static[\\/]/.test(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": isStatic ? "public, max-age=86400" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(head ? undefined : data);
  } catch { res.writeHead(500); res.end("read error"); }
});

server.listen(PORT, () => {
  console.log(`klata-capture (static mockup) listening on ${PORT}`);
  ensureSite();
});
