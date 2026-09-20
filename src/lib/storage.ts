import { useCallback, useEffect, useState } from "react";

const PREFIX = "web-extractor:";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** localStorage 를 읽는 useState. 시크릿 창·차단된 사이트 데이터에서도 죽지 않는다. */
export function usePersisted<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read(key, initial));

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* 저장 불가 — 이번 세션에서만 유지된다. */
    }
  }, [key, value]);

  const patch = useCallback(
    (partial: Partial<T>) => setValue((prev) => ({ ...prev, ...partial })),
    [],
  );

  return [value, setValue, patch] as const;
}

export interface HistoryItem {
  id: string;
  tab: string;
  title: string;
  prompt: string;
  createdAt: number;
}

const HISTORY_KEY = "history";
const HISTORY_MAX = 30;

export function loadHistory(): HistoryItem[] {
  return read<HistoryItem[]>(HISTORY_KEY, []);
}

export function saveHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(PREFIX + HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch {
    /* 무시 */
  }
}
