// web-extractor 앱(+klata) 부트스트랩. 실제 코드(wx-server.mjs, crawler.mjs)를 GitHub raw 에서 받아 실행.
// 기존 web-extractor SPA 서빙은 wx-server.mjs 가 그대로 수행하고, /klata 하위만 추가된다.
// 자격증명은 .env 로 별도 주입(GitHub 에 없음).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = process.env.CODE_REF || 'main';
const BASE = `https://raw.githubusercontent.com/AnSuHan/web-extractor/${BRANCH}/egg-crawler/`;

async function grab(remote, local) {
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(BASE + remote, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fs.writeFileSync(path.join(ROOT, local), Buffer.from(await res.arrayBuffer()));
      console.log('fetched', remote, '->', local);
      return;
    } catch (e) {
      console.error('fetch fail', remote, String(e.message || e), '(try ' + i + ')');
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, i * 1500));
    }
  }
}

await grab('crawler.mjs', 'crawler.mjs');
await grab('wx-server.mjs', 'server.mjs');
await import('./server.mjs');
