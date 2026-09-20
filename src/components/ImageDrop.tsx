import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageAsset } from "../lib/types";
import { Badge, Button } from "./ui";

const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type Accepted = (typeof ACCEPTED)[number];

/** Claude 의 이미지 입력 한도에 여유를 둔 값. 초과하면 업로드를 막고 이유를 말한다. */
const MAX_BYTES = 5 * 1024 * 1024;

function isAccepted(t: string): t is Accepted {
  return (ACCEPTED as readonly string[]).includes(t);
}

async function toAsset(file: File): Promise<ImageAsset> {
  if (!isAccepted(file.type)) {
    throw new Error(`${file.name}: 지원하지 않는 형식입니다 (${file.type || "알 수 없음"}).`);
  }
  if (file.size > MAX_BYTES) {
    throw new Error(
      `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB 로 너무 큽니다 (최대 5MB).`,
    );
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`${file.name}: 읽기 실패`));
    reader.readAsDataURL(file);
  });

  const { width, height } = await new Promise<{ width: number; height: number }>(
    (resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataUrl;
    },
  );

  return {
    id: crypto.randomUUID(),
    name: file.name || "pasted.png",
    mediaType: file.type,
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    dataUrl,
    width,
    height,
    bytes: file.size,
  };
}

export function ImageDrop({
  images,
  onChange,
}: {
  images: ImageAsset[];
  onChange: (next: ImageAsset[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files) return;
      setError(null);
      const results = await Promise.allSettled([...files].map(toAsset));
      const ok = results
        .filter((r): r is PromiseFulfilledResult<ImageAsset> => r.status === "fulfilled")
        .map((r) => r.value);
      const failed = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as Error).message);
      if (failed.length) setError(failed.join("\n"));
      if (ok.length) onChange([...images, ...ok]);
    },
    [images, onChange],
  );

  // 화면 어디서든 Ctrl+V 로 스크린샷을 붙여넣을 수 있게 한다.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length) {
        e.preventDefault();
        void add(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  const totalBytes = images.reduce((s, i) => s + i.bytes, 0);

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void add(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging
            ? "border-accent-500 bg-accent-500/10"
            : "border-ink-700 bg-ink-850 hover:border-ink-600"
        }`}
      >
        <p className="text-sm text-ink-200">
          스크린샷을 여기에 끌어다 놓거나 클릭해 선택
        </p>
        <p className="mt-1 text-xs text-ink-400">
          어디서든 <kbd className="rounded border border-ink-600 px-1">Ctrl</kbd>+
          <kbd className="rounded border border-ink-600 px-1">V</kbd> 로 붙여넣기 ·
          PNG / JPEG / GIF / WebP · 장당 최대 5MB
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          multiple
          hidden
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <p className="mt-2 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs whitespace-pre-line text-red-300">
          {error}
        </p>
      )}

      {images.length > 0 && (
        <>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge>{images.length}장</Badge>
              <Badge tone={totalBytes > 15 * 1024 * 1024 ? "warn" : "neutral"}>
                {(totalBytes / 1024 / 1024).toFixed(2)}MB
              </Badge>
            </div>
            <Button variant="ghost" onClick={() => onChange([])}>
              전체 비우기
            </Button>
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {images.map((img) => (
              <li
                key={img.id}
                className="group relative overflow-hidden rounded-lg border border-ink-700 bg-ink-850"
              >
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-28 w-full object-cover object-top"
                />
                <div className="px-2 py-1.5">
                  <p className="truncate text-[11px] text-ink-300" title={img.name}>
                    {img.name}
                  </p>
                  <p className="text-[10px] text-ink-400">
                    {img.width}×{img.height} · {(img.bytes / 1024).toFixed(0)}KB
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`${img.name} 제거`}
                  onClick={() => onChange(images.filter((i) => i.id !== img.id))}
                  className="absolute top-1.5 right-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-xs text-ink-200 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-300"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
