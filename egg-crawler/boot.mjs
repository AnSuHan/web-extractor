// 에그호스팅용 부트스트랩. 실제 코드(server.mjs, crawler.mjs)를 GitHub raw 에서 받아 실행한다.
// 이유: deploy 는 파일을 인라인으로 받는데 정규식/템플릿이 많은 큰 파일을 인라인하면 깨지기 쉬움.
// 공개 저장소의 코드만 받는다(자격증명은 .env 로 별도 주입, GitHub 에 없음).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = process.env.CODE_REF || 'main';
const BASE = `https://raw.githubusercontent.com/AnSuHan/web-extractor/${BRANCH}/egg-crawler/`;

async function grab(name) {
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(BASE + name, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(await res.arrayBuffer()));
      console.log('fetched', name);
      return;
    } catch (e) {
      console.error('fetch fail', name, String(e.message || e), '(try ' + i + ')');
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, i * 1500));
    }
  }
}

await grab('crawler.mjs');
await grab('server.mjs');
await import('./server.mjs');
