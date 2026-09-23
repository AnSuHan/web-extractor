// 서버(에그호스팅)에서 직접 도는 klata.or.kr 수집기.
// - 자격증명은 환경변수(KL_ID/KL_PW)에서만 읽는다 (코드/저장소에 남기지 않음).
// - 인증 세션으로 순회하며 HTML+정적리소스를 로컬로 저장, 링크를 오프라인 상대경로로 재작성.
// - 개인정보는 목업 값으로 치환.
// 브라우저 확장 없이 fetch 만으로 돈다(서버 환경이므로). 예의: 접속마다 1~3초 랜덤 대기.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ORIGIN = 'https://www.klata.or.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const SEEDS = [
  '/', '/main', '/test', '/test/info', '/test/area', '/test/pds', '/test/schedule',
  '/test/price', '/test/convenience',
  '/testing_accept', '/testing_accept/mypage', '/testing_accept/moktest', '/testing_accept_doc',
  '/testing_license', '/testing_license_issue', '/testing_license_renewal', '/testing_license_confirm',
  '/testing_result_qna', '/license', '/company', '/cs', '/person_consulting', '/user/login_page',
];

// 세션을 바꾸거나 실제 페이지가 아닌 것은 순회하지 않는다
const SKIP_URL = /(logoutProcess|loginProcess|\/user\/logout|\/user\/login\b|cloud_file\/|\/download|\/pdf\/|\/excel|\/print\b)/i;

export async function runCrawl({ outDir, maxPages = 120, creds, onProgress = () => {} }) {
  const state = { phase: 'login', visited: 0, discovered: 0, assets: 0, failed: 0, maxPages, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  const report = (extra) => { Object.assign(state, extra); onProgress({ ...state }); };

  // --- PII → 목업 치환 ---
  const SUBS = [
    [/안수한/g, '홍길동'],
    [/glorygem195@gmail\.com/gi, 'user@example.com'],
    [/glorygem195/gi, 'testuser'],
    [/010-?5054-?9894/g, '010-1234-5678'],
    [/1999-07-12/g, '2000-01-01'],
    [/1999\.07\.12/g, '2000.01.01'],
    [/337210/g, '200001'],
    [/331100/g, '100001'],
  ];
  const mock = (s) => { for (const [re, to] of SUBS) s = s.replace(re, to); return s; };

  // --- 쿠키(세션) 관리 ---
  let cookie = '';
  function absorb(res) {
    const sc = res.headers.get('set-cookie');
    if (!sc) return;
    const m = sc.match(/PHPSESSID=([^;]+)/i);
    if (m) cookie = `PHPSESSID=${m[1]}`;
  }
  async function req(url, opts = {}) {
    const res = await fetch(url, {
      redirect: opts.redirect || 'follow',
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, 'Referer': ORIGIN + '/', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
      body: opts.body,
    });
    absorb(res);
    return res;
  }

  // --- 로그인 ---
  await req(`${ORIGIN}/user/login_page?returnUrl=%2F`); // 세션 발급
  const form = new URLSearchParams();
  form.set('response', 'logined'); form.set('args', '');
  form.set('id', creds.id); form.set('passwd', creds.pw); form.set('saveId', '1');
  const loginRes = await req(`${ORIGIN}/User/loginProcess`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  let loginJson = {};
  try { loginJson = JSON.parse(await loginRes.text()); } catch {}
  if (!loginJson.result) { report({ phase: 'error', error: 'login failed', finishedAt: new Date().toISOString() }); throw new Error('klata login failed'); }
  report({ phase: 'crawl' });

  // --- url/path helpers ---
  const seen = new Set(); const pageMap = new Map(); const assetMap = new Map();
  const queue = []; const visited = []; const failed = []; const discovered = new Set();
  const sameOrigin = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };
  const stripHash = (u) => { const x = new URL(u); x.hash = ''; return x.toString(); };
  const tryResolve = (href, base) => { try { return stripHash(new URL(href, base).toString()); } catch { return null; } };
  const canonAsset = (u) => { try { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (/^(ver|version|v|_|t|ts|rnd|r|cb|date|d)$/i.test(k)) x.searchParams.delete(k); x.hash = ''; return x.toString(); } catch { return u; } };

  function pageLocalPath(u) {
    const url = new URL(u); let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index'; p = p.replace(/^\/+/, ''); if (!p) p = 'index';
    let q = '';
    if (url.search) { const kv = [...url.searchParams.entries()].filter(([k]) => !/^(ver|v|_|t|rnd|cb)$/i.test(k)).map(([k, v]) => `${k}-${v}`).join('_'); if (kv) q = '__' + kv; }
    return ((p + q).replace(/[^a-zA-Z0-9._\/-]/g, '_')) + '.html';
  }
  function assetLocalPath(u, kind) {
    if (assetMap.has(u)) return assetMap.get(u);
    const url = new URL(u); let base = decodeURIComponent(path.posix.basename(url.pathname)) || 'asset';
    base = base.split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!path.posix.extname(base)) base += (kind === 'css' ? '.css' : kind === 'js' ? '.js' : kind === 'font' ? '.woff2' : '');
    const dir = kind === 'css' ? 'css' : kind === 'js' ? 'js' : kind === 'font' ? 'fonts' : 'img';
    let rel = `static/${dir}/${base}`; const taken = new Set([...assetMap.values()]);
    let cand = rel; let n = 0; while (taken.has(cand)) { n++; const e = path.posix.extname(rel); cand = rel.slice(0, -e.length) + '-' + n + e; }
    assetMap.set(u, cand); return cand;
  }
  const relFromPage = (pageRel, targetRel) => { const from = path.posix.dirname('/' + pageRel); return path.posix.relative(from, '/' + targetRel) || path.posix.basename(targetRel); };
  function write(rel, data) { const abs = path.join(outDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data); }

  async function fetchBin(u) { const res = await req(u); const buf = Buffer.from(await res.arrayBuffer()); return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') || '', buf }; }

  async function rewriteCss(css, cssUrl, cssRel) {
    for (const m of css.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g)) { const abs = tryResolve(m[1], cssUrl); if (abs && sameOrigin(abs)) { const r = await downloadAsset(abs, 'css'); if (r) css = css.split(m[1]).join(relFromPage(cssRel, r)); } }
    for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) { const raw = m[1]; if (raw.startsWith('data:')) continue; const abs = tryResolve(raw, cssUrl); if (abs && sameOrigin(abs)) { const kind = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(abs) ? 'font' : 'img'; const r = await downloadAsset(abs, kind); if (r) css = css.split(raw).join(relFromPage(cssRel, r)); } }
    return css;
  }
  async function downloadAsset(absUrl, kind) {
    absUrl = canonAsset(absUrl);
    if (assetMap.has(absUrl) && fs.existsSync(path.join(outDir, assetMap.get(absUrl)))) return assetMap.get(absUrl);
    if (!sameOrigin(absUrl)) return null;
    const rel = assetLocalPath(absUrl, kind);
    try { const { ok, buf, ct } = await fetchBin(absUrl); if (!ok) { failed.push(absUrl); return null; }
      if (kind === 'css' || /css/.test(ct)) { write(rel, mock(await rewriteCss(buf.toString('utf8'), absUrl, rel))); } else { write(rel, buf); }
      return rel;
    } catch { failed.push(absUrl); return null; }
  }

  function extractLinks(html, pageUrl) {
    const out = [];
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi)) {
      const raw = m[1]; if (/^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
      const abs = tryResolve(raw, pageUrl); if (!abs || !sameOrigin(abs)) continue;
      if (SKIP_URL.test(abs)) continue;
      if (/\.(zip|pdf|hwp|hwpx|xlsx?|docx?|pptx?|jpg|jpeg|png|gif|mp4|hml)(\?|$)/i.test(abs)) continue;
      out.push(abs);
    }
    return out;
  }

  async function processHtml(html, pageUrl, pageRel) {
    html = html.replace(/<base\b[^>]*>/gi, '');
    const rewrites = [];
    html = html.replace(/<(link|script|img|source)\b([^>]*)>/gi, (tag, el, attrs) => {
      const name = tag.match(/<(\w+)/)[1];
      const handle = (attrName, kindGuess) => {
        const mm = attrs.match(new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i')); if (!mm) return; const raw = mm[1]; if (raw.startsWith('data:')) return;
        if (attrName === 'srcset') { for (const part of raw.split(',')) { const u = part.trim().split(/\s+/, 1)[0]; const abs = tryResolve(u, pageUrl); if (abs && sameOrigin(abs)) rewrites.push([u, abs, 'img']); } return; }
        const abs = tryResolve(raw, pageUrl); if (!abs) return; let kind = kindGuess;
        if (/rel\s*=\s*["'][^"']*stylesheet/i.test(el) || /\.css(\?|$)/i.test(abs)) kind = 'css';
        if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(abs)) kind = 'font';
        if (sameOrigin(abs)) rewrites.push([raw, abs, kind]);
      };
      if (/^link$/i.test(name)) handle('href', 'css'); else if (/^script$/i.test(name)) handle('src', 'js'); else { handle('src', 'img'); handle('srcset', 'img'); }
      return `<${name}${attrs}>`;
    });
    const uniq = new Map(); for (const [, abs, kind] of rewrites) { const c = canonAsset(abs); if (!uniq.has(c)) uniq.set(c, kind); }
    for (const [abs, kind] of uniq) { await downloadAsset(abs, kind); }
    for (const [raw, abs] of rewrites) { const rel = assetMap.get(canonAsset(abs)); if (rel && fs.existsSync(path.join(outDir, rel))) html = html.split(raw).join(relFromPage(pageRel, rel)); }
    html = html.replace(/(<a\b[^>]*?href\s*=\s*["'])([^"']+)(["'])/gi, (full, pre, href, post) => {
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return full; const abs = tryResolve(href, pageUrl); if (!abs) return full;
      if (pageMap.has(abs)) return pre + relFromPage(pageRel, pageMap.get(abs)) + post; return full;
    });
    return html;
  }

  // --- crawl loop ---
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of SEEDS) { const u = ORIGIN + s; if (!seen.has(u)) { seen.add(u); queue.push(u); pageMap.set(u, pageLocalPath(u)); } }
  while (queue.length && visited.length < maxPages) {
    const u = queue.shift(); let rel = pageMap.get(u) || pageLocalPath(u); pageMap.set(u, rel);
    try {
      const { ok, ct, buf } = await fetchBin(u);
      if (ok && /text\/html/.test(ct)) {
        let html = buf.toString('utf8');
        for (const l of extractLinks(html, u)) { discovered.add(l); if (!seen.has(l) && seen.size < maxPages * 4) { seen.add(l); pageMap.set(l, pageLocalPath(l)); queue.push(l); } }
        write(rel, mock(await processHtml(html, u, rel))); visited.push(u);
      } else { failed.push(`${u} [${ct}]`); }
    } catch (e) { failed.push(`${u} [${e.message}]`); }
    report({ visited: visited.length, discovered: discovered.size, assets: [...assetMap.values()].length, failed: failed.length });
    await sleep(1000 + Math.random() * 2000); // 예의: 접속마다 랜덤 대기
  }

  const readme = [
    '# klata.or.kr — 정적 캡처 (목업)', '', `- 수집: ${new Date().toISOString()} (에그호스팅 서버에서 수행)`,
    `- Origin: ${ORIGIN}`, `- 방문 페이지: ${visited.length}`, `- 발견 링크(동일 출처): ${discovered.size}`,
    `- 저장 리소스: ${[...assetMap.values()].length}`, `- 실패/건너뜀: ${failed.length}`, '',
    '개인정보(이름/이메일/전화/생년월일/회원ID)는 목업 값으로 치환됨. 이 캡처는 참고·확인용이며 원 기관 사이트가 아님.', '',
    '## 방문', ...visited.map((u) => '- ' + u),
  ].join('\n');
  write('README.md', mock(readme));
  report({ phase: 'done', finishedAt: new Date().toISOString(), visited: visited.length, discovered: discovered.size, assets: [...assetMap.values()].length, failed: failed.length });
  return { ...state };
}
