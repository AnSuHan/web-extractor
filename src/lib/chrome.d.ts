/**
 * 이 앱이 실제로 쓰는 확장 API 만 최소로 선언한다.
 * @types/chrome 전체를 끌어오지 않기 위한 것이다.
 */
interface ChromeTab {
  id?: number;
  url?: string;
}

interface ChromeRuntime {
  id?: string;
  getManifest(): { version: string; name: string };
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  lastError?: { message?: string };
}

interface ChromeApi {
  runtime: ChromeRuntime;
  permissions: {
    request(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    contains(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  tabs: {
    create(p: { url: string; active?: boolean }): Promise<ChromeTab>;
  };
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

declare const chrome: ChromeApi | undefined;
