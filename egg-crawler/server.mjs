/**
 * 에그호스팅에서 도는 klata 수집기 + 뷰어 + 결과물 다운로드.
 * 의존성 없음(Node 내장만). 호스팅이 주는 PORT 사용(없으면 8080).
 *
 * 부팅하면 즉시 listen 하고(헬스체크 통과), 백그라운드로 klata 를 수집한다.
 * 자격증명은 .env(같은 폴더)나 환경변수에서만 읽는다 — 저장소엔 없다.
 *
 * 엔드포인트:
 *   /                     수집이 끝났으면 사이트, 아니면 상태 페이지
 *   /status               JSON 진행 상태
 *   /download.tar.gz      수집 결과물 전체(가장 최근 완료본)
 *   /recrawl?key=<KEY>    재수집 트리거(RECRAWL_KEY 필요)
 */
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runCrawl } from './crawler.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.PORT) || 8080;
const MAX_PAGES = Number(process.env.MAX_PAGES || 120);

// --- .env 로더 (의존성 없이) ---
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

// --- 수집 상태 ---
let status = { phase: 'idle', visited: 0, discovered: 0, assets: 0, failed: 0, maxPages: MAX_PAGES, startedAt: null, finishedAt: null, error: null };
let crawling = false;

async function startCrawl(reason) {
  if (crawling) return false;
  const id = process.env.KL_ID, pw = process.env.KL_PW;
  if (!id || !pw) { status = { ...status, phase: 'error', error: 'KL_ID/KL_PW 미설정(.env 필요)' }; return false; }
  crawling = true;
  status = { ...status, phase: 'login', error: null, startedAt: new Date().toISOString(), finishedAt: null, reason };
  // site 를 새로 만든다(임시폴더 → 완료 후 교체)
  const tmp = path.join(ROOT, 'site.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  runCrawl({ outDir: tmp, maxPages: MAX_PAGES, creds: { id, pw }, onProgress: (s) => { status = { ...status, ...s }; } })
    .then(() => { fs.rmSync(SITE, { recursive: true, force: true }); fs.renameSync(tmp, SITE); })
    .catch((e) => { status = { ...status, phase: 'error', error: String(e && e.message || e) }; })
    .finally(() => { crawling = false; });
  return true;
}

// --- 정적 서빙 ---
function safe(rel) { const t = path.resolve(SITE, rel || 'index.html'); return (t === SITE || t.startsWith(SITE + path.sep)) ? t : null; }
async function resolveFile(rel) {
  const base = safe(rel); if (!base) return null;
  try { const s = await stat(base); if (s.isFile()) return base; if (s.isDirectory()) { const i = path.join(base, 'index.html'); if ((await stat(i)).isFile()) return i; } } catch {}
  if (!path.extname(base)) { try { const h = base + '.html'; if ((await stat(h)).isFile()) return h; } catch {} }
  return null;
}
function candidates(urlPath) { const parts = decodeURIComponent(urlPath.split('?')[0]).split('/').filter(Boolean); const list = [parts.join('/')]; if (parts.length > 1) list.push(parts.slice(1).join('/')); list.push('index.html'); return [...new Set(list)]; }

// --- 의존성 없는 tar.gz ---
async function listFiles(dir, prefix = '') {
  const out = []; let ents = []; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const rel = prefix ? prefix + '/' + e.name : e.name; if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel)); else out.push(rel); }
  return out;
}
function tarHeader(name, size, mtime) {
  const buf = Buffer.alloc(512);
  let nm = name, prefix = '';
  if (Buffer.byteLength(name) > 100) { const idx = name.lastIndexOf('/', 100); if (idx > 0) { prefix = name.slice(0, idx); nm = name.slice(idx + 1); } else nm = name.slice(0, 100); }
  buf.write(nm.slice(0, 100), 0);
  buf.write('0000644\0', 100); buf.write('0000000\0', 108); buf.write('0000000\0', 116);
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124);
  buf.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  buf.write('        ', 148); // checksum placeholder(spaces)
  buf.write('0', 156); buf.write('ustar\0', 257); buf.write('00', 263);
  if (prefix) buf.write(prefix.slice(0, 155), 345);
  let sum = 0; for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return buf;
}
async function buildTarGz(dir) {
  const files = await listFiles(dir); const chunks = [];
  for (const rel of files) {
    const abs = path.join(dir, rel); const data = await readFile(abs); const st = await stat(abs);
    chunks.push(tarHeader('klata-capture/' + rel, data.length, st.mtimeMs));
    chunks.push(data); const pad = (512 - (data.length % 512)) % 512; if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // 종료 블록
  return zlib.gzipSync(Buffer.concat(chunks));
}

function statusPage() {
  const s = status;
  const pct = s.maxPages ? Math.min(100, Math.round((s.visited / s.maxPages) * 100)) : 0;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>klata 캡처 — 상태</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 16px}
.bar{height:12px;background:#8883;border-radius:6px;overflow:hidden}.bar>i{display:block;height:100%;width:${pct}%;background:#6c8cff}
code{background:#8882;padding:.1em .4em;border-radius:4px}.muted{opacity:.7}</style>
<h1>klata.or.kr 캡처 (목업)</h1>
<p>상태: <b>${s.phase}</b>${s.error ? ` — <span style="color:#e66">${s.error}</span>` : ''}</p>
<div class="bar"><i></i></div>
<p>${s.visited} / ${s.maxPages} 페이지 · 리소스 ${s.assets} · 실패 ${s.failed}</p>
<p class="muted">이 페이지는 수집이 끝나면 자동으로 사이트로 바뀝니다. 새로고침 해보세요.</p>
<ul>
<li><a href="/status">/status</a> — JSON 진행 상태</li>
<li><a href="/download.tar.gz">/download.tar.gz</a> — 수집 결과물 내려받기(완료 후)</li>
</ul>
<p class="muted">개인정보는 목업 값으로 치환됨 · 원 기관 사이트 아님 · 참고용</p>
<script>setTimeout(()=>location.reload(),5000)</script></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;

  if (p === '/status') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(status, null, 2)); return; }

  if (p === '/recrawl') {
    const key = url.searchParams.get('key');
    if (!process.env.RECRAWL_KEY || key !== process.env.RECRAWL_KEY) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('forbidden'); return; }
    const ok = await startCrawl('manual'); res.writeHead(ok ? 202 : 409, { 'content-type': 'text/plain; charset=utf-8' }); res.end(ok ? '재수집 시작' : '이미 수집 중'); return;
  }

  if (p === '/download.tar.gz') {
    if (!fs.existsSync(SITE)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('아직 결과물이 없습니다(수집 진행 중)'); return; }
    try { const gz = await buildTarGz(SITE); res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="klata-capture.tar.gz"', 'content-length': gz.length }); res.end(gz); }
    catch (e) { res.writeHead(500); res.end('archive error: ' + e.message); }
    return;
  }

  // 사이트가 아직 없으면 상태 페이지
  if (!fs.existsSync(path.join(SITE, 'index.html'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(statusPage()); return; }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }
  for (const key of candidates(p)) {
    const file = await resolveFile(key); if (!file) continue;
    try { const data = await readFile(file); res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': /[\\/]static[\\/]/.test(file) ? 'public, max-age=86400' : 'no-cache', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : data); return; } catch {}
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`klata egg-crawler listening on ${PORT}`);
  // 사이트가 없으면 자동 수집 시작(자격증명 있을 때만)
  if (!fs.existsSync(path.join(SITE, 'index.html')) && process.env.AUTO_CRAWL !== '0') startCrawl('boot');
});
