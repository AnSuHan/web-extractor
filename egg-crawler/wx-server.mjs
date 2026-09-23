/**
 * web-extractor 앱 + klata 서버사이드 수집기(뷰어/다운로드/재수집) 통합 서버.
 * 의존성 없음. 기존 web-extractor(React SPA) 서빙은 그대로 두고, `/klata` 하위만 추가한다.
 *
 * SPA 자산(js/css)은 assets-source.json 이 가리키는 GitHub 릴리스에서 부팅 때 한 번 받는다.
 * klata 코드(crawler.mjs)는 boot.mjs 가 GitHub 에서 받아 둔다. 자격증명은 .env 에서만 읽는다.
 *
 * klata 엔드포인트(프록시가 /web-extractor 를 떼든 안 떼든 'klata' 조각으로 인식):
 *   …/klata                수집 끝났으면 사이트, 아니면 진행 상태 페이지
 *   …/klata/status         JSON 진행 상태
 *   …/klata/download.tar.gz  수집 결과물 전체
 *   …/klata/recrawl?key=…  재수집(RECRAWL_KEY 필요)
 */
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile, readdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const KLATA_SITE = path.join(ROOT, "klata-site");
const MAX_PAGES = Number(process.env.MAX_PAGES || 120);

// --- .env 로더 ---
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
})();

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

/* ------------------------- SPA 자산 확보 (기존과 동일) ------------------------- */
async function fileExists(file) { try { const info = await stat(file); return info.isDirectory() ? path.join(file, "index.html") : file; } catch { return null; } }
async function ensureAssets() {
  let source; try { source = JSON.parse(await readFile(path.join(ROOT, "assets-source.json"), "utf8")); } catch { return; }
  await mkdir(path.join(ROOT, "assets"), { recursive: true });
  for (const name of source.files ?? []) {
    const target = path.join(ROOT, "assets", name); if (await fileExists(target)) continue;
    const url = `${source.baseUrl}/${name}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { const res = await fetch(url, { redirect: "follow" }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer()); await writeFile(target, body);
        console.log(`asset fetched: ${name} (${(body.length / 1024).toFixed(0)}KB)`); break;
      } catch (err) { if (attempt === 3) console.error(`asset FAILED: ${name} — ${err?.message ?? err}`); else await new Promise((r) => setTimeout(r, attempt * 1000)); }
    }
  }
}

/* ------------------------------- klata 수집 ------------------------------- */
let klata = { phase: "idle", visited: 0, discovered: 0, assets: 0, failed: 0, maxPages: MAX_PAGES, startedAt: null, finishedAt: null, error: null };
let crawling = false;
async function startKlataCrawl(reason) {
  if (crawling) return false;
  const id = process.env.KL_ID, pw = process.env.KL_PW;
  if (!id || !pw) { klata = { ...klata, phase: "error", error: "KL_ID/KL_PW 미설정(.env 필요)" }; return false; }
  let runCrawl;
  try { ({ runCrawl } = await import("./crawler.mjs")); } catch (e) { klata = { ...klata, phase: "error", error: "crawler.mjs 로드 실패: " + (e?.message ?? e) }; return false; }
  crawling = true;
  klata = { ...klata, phase: "login", error: null, startedAt: new Date().toISOString(), finishedAt: null, reason };
  const tmp = path.join(ROOT, "klata-site.tmp"); fs.rmSync(tmp, { recursive: true, force: true });
  runCrawl({ outDir: tmp, maxPages: MAX_PAGES, creds: { id, pw }, onProgress: (s) => { klata = { ...klata, ...s }; } })
    .then(() => { fs.rmSync(KLATA_SITE, { recursive: true, force: true }); fs.renameSync(tmp, KLATA_SITE); })
    .catch((e) => { klata = { ...klata, phase: "error", error: String(e && e.message || e) }; })
    .finally(() => { crawling = false; });
  return true;
}

function klataSafe(rel) { const t = path.resolve(KLATA_SITE, rel || "index.html"); return (t === KLATA_SITE || t.startsWith(KLATA_SITE + path.sep)) ? t : null; }
async function klataResolve(rel) {
  const base = klataSafe(rel); if (!base) return null;
  try { const s = await stat(base); if (s.isFile()) return base; if (s.isDirectory()) { const i = path.join(base, "index.html"); if ((await stat(i)).isFile()) return i; } } catch {}
  if (!path.extname(base)) { try { const h = base + ".html"; if ((await stat(h)).isFile()) return h; } catch {} }
  return null;
}

async function listFiles(dir, prefix = "") {
  const out = []; let ents = []; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const rel = prefix ? prefix + "/" + e.name : e.name; if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel)); else out.push(rel); }
  return out;
}
function tarHeader(name, size, mtime) {
  const buf = Buffer.alloc(512); let nm = name, prefix = "";
  if (Buffer.byteLength(name) > 100) { const idx = name.lastIndexOf("/", 100); if (idx > 0) { prefix = name.slice(0, idx); nm = name.slice(idx + 1); } else nm = name.slice(0, 100); }
  buf.write(nm.slice(0, 100), 0); buf.write("0000644\0", 100); buf.write("0000000\0", 108); buf.write("0000000\0", 116);
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124); buf.write(Math.floor(mtime / 1000).toString(8).padStart(11, "0") + "\0", 136);
  buf.write("        ", 148); buf.write("0", 156); buf.write("ustar\0", 257); buf.write("00", 263);
  if (prefix) buf.write(prefix.slice(0, 155), 345);
  let sum = 0; for (let i = 0; i < 512; i++) sum += buf[i]; buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buf;
}
async function buildTarGz(dir) {
  const files = await listFiles(dir); const chunks = [];
  for (const rel of files) { const abs = path.join(dir, rel); const data = await readFile(abs); const st = await stat(abs);
    chunks.push(tarHeader("klata-capture/" + rel, data.length, st.mtimeMs)); chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512; if (pad) chunks.push(Buffer.alloc(pad)); }
  chunks.push(Buffer.alloc(1024)); return zlib.gzipSync(Buffer.concat(chunks));
}
function klataStatusPage(basePrefix) {
  const s = klata; const pct = s.maxPages ? Math.min(100, Math.round((s.visited / s.maxPages) * 100)) : 0;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>klata 캡처 — 상태</title><style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 16px}
.bar{height:12px;background:#8883;border-radius:6px;overflow:hidden}.bar>i{display:block;height:100%;width:${pct}%;background:#6c8cff}.muted{opacity:.7}</style>
<h1>klata.or.kr 캡처 (목업)</h1><p>상태: <b>${s.phase}</b>${s.error ? ` — <span style="color:#e66">${s.error}</span>` : ""}</p>
<div class="bar"><i></i></div><p>${s.visited} / ${s.maxPages} 페이지 · 리소스 ${s.assets} · 실패 ${s.failed}</p>
<p class="muted">수집이 끝나면 이 페이지가 자동으로 사이트로 바뀝니다.</p>
<ul><li><a href="status">status</a> (JSON)</li><li><a href="download.tar.gz">download.tar.gz</a> (완료 후)</li></ul>
<p class="muted">개인정보는 목업 값으로 치환됨 · 원 기관 사이트 아님 · 참고용</p><script>setTimeout(()=>location.reload(),5000)</script></html>`;
}

async function handleKlata(sub, req, res) {
  if (sub === "status") { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(klata, null, 2)); return; }
  if (sub === "recrawl") {
    const key = new URL(req.url, "http://x").searchParams.get("key");
    if (!process.env.RECRAWL_KEY || key !== process.env.RECRAWL_KEY) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("forbidden"); return; }
    const ok = await startKlataCrawl("manual"); res.writeHead(ok ? 202 : 409, { "content-type": "text/plain; charset=utf-8" }); res.end(ok ? "재수집 시작" : "이미 수집 중"); return;
  }
  if (sub === "download.tar.gz") {
    if (!fs.existsSync(KLATA_SITE)) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("아직 결과물이 없습니다(수집 진행 중)"); return; }
    try { const gz = await buildTarGz(KLATA_SITE); res.writeHead(200, { "content-type": "application/gzip", "content-disposition": 'attachment; filename="klata-capture.tar.gz"', "content-length": gz.length }); res.end(gz); }
    catch (e) { res.writeHead(500); res.end("archive error: " + e.message); } return;
  }
  // 사이트가 아직 없으면 상태 페이지
  if (!fs.existsSync(path.join(KLATA_SITE, "index.html"))) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(klataStatusPage()); return; }
  const file = await klataResolve(sub);
  if (file) { try { const data = await readFile(file); res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": /[\\/]static[\\/]/.test(file) ? "public, max-age=86400" : "no-cache", "x-content-type-options": "nosniff" }); res.end(req.method === "HEAD" ? undefined : data); return; } catch {} }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("not found"); return;
}

/* --------------------------- 기존 SPA 서빙 --------------------------- */
function resolveSafe(relative) { const target = path.resolve(ROOT, relative || "index.html"); if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null; return target; }
function candidates(urlPath) { const parts = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean); const list = [parts.join("/")]; if (parts.length > 1) list.push(parts.slice(1).join("/")); return list.filter(Boolean); }
function klataSub(urlPath) { const parts = decodeURIComponent(urlPath.split("?")[0]).split("/").filter(Boolean); const i = parts.indexOf("klata"); return i === -1 ? null : parts.slice(i + 1).join("/"); }

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end("method not allowed"); return; }
  const head = req.method === "HEAD";
  const urlPath = (req.url ?? "/").split("?")[0];

  // --- klata 하위는 SPA 로직보다 먼저 처리 ---
  const sub = klataSub(urlPath);
  if (sub !== null) { try { await handleKlata(sub, req, res); } catch (e) { res.writeHead(500); res.end("klata error: " + e.message); } return; }

  // 하위 경로에 슬래시 없이 들어오면 슬래시를 붙여 다시 보낸다.
  if (!urlPath.endsWith("/") && !path.extname(urlPath)) { res.writeHead(301, { location: `${urlPath}/` }); res.end(); return; }

  for (const key of [...candidates(req.url ?? "/"), "index.html"]) {
    const target = resolveSafe(key); if (!target) continue;
    const file = await fileExists(target); if (!file) continue;
    try {
      const data = await readFile(file); const isAsset = file.includes(`${path.sep}assets${path.sep}`);
      res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" });
      res.end(head ? undefined : data); return;
    } catch {}
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("not found");
});

await ensureAssets();
server.listen(PORT, () => {
  console.log(`web-extractor(+klata) listening on ${PORT}`);
  if (!fs.existsSync(path.join(KLATA_SITE, "index.html")) && process.env.AUTO_CRAWL !== "0") startKlataCrawl("boot");
});
