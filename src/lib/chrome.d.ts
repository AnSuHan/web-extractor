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
  /** 다른 확장(= 우리 확장)에게 보내는 형태. 배포된 웹페이지에서 쓰는 통로다. */
  sendMessage(
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ): void;
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
