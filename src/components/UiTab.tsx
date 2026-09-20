import { useMemo } from "react";
import { buildUiPrompt } from "../lib/prompts";
import type { ImageAsset, UiOptions } from "../lib/types";
import { usePersisted } from "../lib/storage";
import { Card, Field, Segmented, Select, TextArea, TextInput, Toggle } from "./ui";
import { ImageDrop } from "./ImageDrop";
import { PromptPanel } from "./PromptPanel";
import { RunPanel } from "./RunPanel";

export const DEFAULT_UI_OPTIONS: UiOptions = {
  framework: "react-ts",
  style: "tailwind",
  output: "split-components",
  strictness: "pixel",
  responsive: true,
  a11y: true,
  interactionStates: true,
  darkMode: false,
  svgIcons: true,
  noPlaceholder: true,
  designTokens: false,
  koreanComments: false,
  targetName: "",
  extra: "",
};

export function UiTab({
  images,
  setImages,
  onSave,
}: {
  images: ImageAsset[];
  setImages: (next: ImageAsset[]) => void;
  onSave: (title: string, prompt: string) => void;
}) {
  const [opts, , patch] = usePersisted<UiOptions>("uiOptions", DEFAULT_UI_OPTIONS);
  const prompt = useMemo(() => buildUiPrompt(opts, images.length), [opts, images.length]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card
          title="스크린샷"
          subtitle="재현할 화면. 여러 장이면 같은 화면의 다른 상태로 간주합니다."
        >
          <ImageDrop images={images} onChange={setImages} />
        </Card>

        <Card title="재현 옵션">
          <div className="space-y-4">
            <Field label="화면 이름" hint="프롬프트에 포함됩니다. 비워둬도 됩니다.">
              <TextInput
                value={opts.targetName}
                onChange={(e) => patch({ targetName: e.target.value })}
                placeholder="예: 주문 상세 페이지"
              />
            </Field>

            <Field label="프레임워크">
              <Select
                value={opts.framework}
                onChange={(framework) => patch({ framework })}
                options={[
                  { value: "react-ts", label: "React + TypeScript" },
                  { value: "react-js", label: "React (JavaScript)" },
                  { value: "vue-ts", label: "Vue 3 + TypeScript" },
                  { value: "svelte", label: "Svelte 5" },
                  { value: "html", label: "순수 HTML" },
                ]}
              />
            </Field>

            <Field label="스타일링">
              <Select
                value={opts.style}
                onChange={(style) => patch({ style })}
                options={[
                  { value: "tailwind", label: "TailwindCSS" },
                  { value: "css-modules", label: "CSS Modules" },
                  { value: "styled-components", label: "styled-components" },
                  { value: "plain-css", label: "순수 CSS (BEM)" },
                ]}
              />
            </Field>

            <Field
              label="충실도"
              hint={
                opts.strictness === "pixel"
                  ? "31px 를 32px 로 바꾸는 것조차 금지합니다."
                  : opts.strictness === "high"
                    ? "1px 단위 반올림까지만 허용합니다."
                    : "2px 미만 편차는 4px 스케일로 정규화하되, 전부 주석으로 남깁니다."
              }
            >
              <Segmented
                value={opts.strictness}
                onChange={(strictness) => patch({ strictness })}
                options={[
                  { value: "pixel", label: "픽셀 퍼펙트" },
                  { value: "high", label: "높음" },
                  { value: "balanced", label: "균형" },
                ]}
              />
            </Field>

            <Field label="출력 형태">
              <Segmented
                value={opts.output}
                onChange={(output) => patch({ output })}
                options={[
                  { value: "split-components", label: "컴포넌트 분리" },
                  { value: "single-file", label: "단일 파일" },
                ]}
              />
            </Field>

            <div className="border-t border-ink-700 pt-3">
              <p className="mb-1 px-2 text-xs font-medium text-ink-300">추가 지시</p>
              <Toggle
                checked={opts.responsive}
                onChange={(responsive) => patch({ responsive })}
                label="반응형 동작 포함"
                hint="데스크톱 모습은 그대로 두고 축소 동작만 추가"
              />
              <Toggle
                checked={opts.interactionStates}
                onChange={(interactionStates) => patch({ interactionStates })}
                label="인터랙션 상태 구현"
                hint="hover / focus / disabled / loading / error"
              />
              <Toggle
                checked={opts.a11y}
                onChange={(a11y) => patch({ a11y })}
                label="시맨틱 HTML · 접근성"
                hint="겉모습은 바뀌지 않는 선에서"
              />
              <Toggle
                checked={opts.svgIcons}
                onChange={(svgIcons) => patch({ svgIcons })}
                label="아이콘을 인라인 SVG 로 재현"
                hint="비슷한 아이콘으로 대체 금지"
              />
              <Toggle
                checked={opts.noPlaceholder}
                onChange={(noPlaceholder) => patch({ noPlaceholder })}
                label="플레이스홀더·가짜 콘텐츠 금지"
                hint="끄면 누락 에셋을 같은 크기 블록으로 대체"
              />
              <Toggle
                checked={opts.designTokens}
                onChange={(designTokens) => patch({ designTokens })}
                label="디자인 토큰 먼저 추출"
                hint="측정한 값을 토큰으로 선언 후 참조"
              />
              <Toggle
                checked={opts.darkMode}
                onChange={(darkMode) => patch({ darkMode })}
                label="반대 테마도 함께 생성"
                hint="스크린샷 테마는 그대로 유지"
              />
              <Toggle
                checked={opts.koreanComments}
                onChange={(koreanComments) => patch({ koreanComments })}
                label="코드 주석을 한국어로"
              />
            </div>

            <Field label="추가 요구사항" hint="자유롭게. 프롬프트 끝에 붙습니다.">
              <TextArea
                rows={3}
                value={opts.extra}
                onChange={(e) => patch({ extra: e.target.value })}
                placeholder="예: 폰트는 Pretendard 로 고정. 테이블은 가상 스크롤 없이."
              />
            </Field>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <PromptPanel
          prompt={prompt}
          filename="ui-reconstruction-prompt.md"
          onSave={() => onSave(opts.targetName || "UI 재구성", prompt)}
        />
        <RunPanel
          prompt={prompt}
          images={images}
          disabledReason={
            images.length === 0 ? "스크린샷을 최소 1장 올려 주세요." : undefined
          }
        />
      </div>
    </div>
  );
}
