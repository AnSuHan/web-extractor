import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 확장 안에서 chrome-extension://<id>/app/ 으로 열리므로 상대 경로여야 한다.
  base: "./",
  build: {
    // 빌드 결과를 확장 안에 넣는다 — 앱이 확장 페이지로 열리면
    // chrome.* 를 직접 쓸 수 있어 개발 서버가 필요 없어진다.
    outDir: "collector/app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: false,
    watch: {
      // Chrome 이 전용 프로필에 끊임없이 쓰기 때문에, 감시 대상에 두면
      // 앱이 무한히 리로드된다. 런처가 만드는 디렉터리는 전부 제외한다.
      ignored: ["**/.browser-profile/**", "**/.tools/**", "**/collector/app/**"],
    },
  },
});
