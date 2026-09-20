import { useEffect, useMemo } from "react";
import { buildNavPrompt } from "../lib/prompts";
import type { NavOptions } from "../lib/types";
import { usePersisted } from "../lib/storage";
import { Card, Field, Segmented, TextArea, TextInput, Toggle } from "./ui";
import { PromptPanel } from "./PromptPanel";
import { RunPanel } from "./RunPanel";

export const DEFAULT_NAV_OPTIONS: NavOptions = {
  url: "",
  scope: "",
  credentials: "",
  maxDepth: 3,
  driver: "playwright-mcp",
  extra: "",
  focus: {
    dialogs: true,
    forms: true,
    validation: true,
    dynamic: true,
    errors: true,
    permissions: false,
    emptyStates: true,
    pagination: true,
    network: false,
  },
  deliverables: {
    spec: true,
    flowchart: true,
    screenshots: true,
    playwrightTests: false,
    stateMatrix: true,
  },
};

const FOCUS_LABELS: Record<keyof NavOptions["focus"], [string, string]> = {
  dialogs: ["다이얼로그·모달 전수 조사", "트리거 / 필드 / 버튼 / 닫을 때의 영향"],
  forms: ["폼 필드 명세", "라벨·타입·기본값·필수·길이 제한"],
  validation: ["유효성 검증 유발", "빈값·초과·형식오류·경계값을 실제로 넣어보기"],
  dynamic: ["연동 동작 추적", "A 를 고르면 B 가 바뀌는 커플링 — 정적 분석이 놓치는 부분"],
  errors: ["실패 경로 유발", "중복 제출·세션 만료·권한 거부·네트워크 끊김"],
  permissions: ["권한별 차이", "역할마다 같은 화면을 다시 순회"],
  emptyStates: ["빈 상태 / 로딩 / 채워진 상태", "목록·테이블·차트 3종 상태"],
  pagination: ["페이지네이션·정렬·필터·검색", "조합 가능 여부, 이동 후 유지 여부"],
  network: ["네트워크 패널 관찰", "어떤 동작이 어떤 요청을 쏘는지"],
};

const DELIVERABLE_LABELS: Record<keyof NavOptions["deliverables"], [string, string]> = {
  spec: ["SPEC.md — 기능 명세", "화면당 1개 섹션. 소스 없이 재구현 가능한 수준"],
  flowchart: ["FLOWS.md — 클릭 경로 플로차트", "Mermaid. 실패 경로 간선 포함"],
  screenshots: ["screenshots/ — 상태별 스크린샷", "명세에서 참조"],
  stateMatrix: ["STATES.md — 상태 매트릭스", "상태 × 화면 영역 표"],
  playwrightTests: ["tests/ — Playwright 테스트", "명세의 각 줄에 대응하는 단언"],
};

export function NavTab({
  onSave,
  seedHint,
}: {
  onSave: (title: string, prompt: string) => void;
  seedHint?: string;
}) {
  const [opts, setOpts, patch] = usePersisted<NavOptions>(
    "navOptions",
    DEFAULT_NAV_OPTIONS,
  );

  // 수집 탭에서 캡처를 연결했고 URL 이 아직 비어 있으면 한 번만 채워 준다.
  // 사용자가 직접 입력한 값은 절대 덮어쓰지 않는다.
  useEffect(() => {
    if (seedHint && !opts.url.trim()) patch({ url: seedHint });
  }, [seedHint, opts.url, patch]);

  const prompt = useMemo(() => buildNavPrompt(opts), [opts]);

  const focusKeys = Object.keys(FOCUS_LABELS) as (keyof NavOptions["focus"])[];
  const deliverableKeys = Object.keys(
    DELIVERABLE_LABELS,
  ) as (keyof NavOptions["deliverables"])[];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card
          title="대상"
          subtitle="에이전트가 실제로 브라우저를 조작하며 기능 명세를 뽑습니다."
        >
          <div className="space-y-4">
            <Field label="진입 URL">
              <TextInput
                value={opts.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://staging.example.com/app"
                spellCheck={false}
              />
            </Field>
            <Field label="조사 범위" hint="비우면 진입 URL 에서 도달 가능한 전체">
              <TextArea
                rows={2}
                value={opts.scope}
                onChange={(e) => patch({ scope: e.target.value })}
                placeholder="예: /orders 와 /customers 하위만. 설정 화면 제외."
              />
            </Field>
            <Field
              label="계정 / 사전 준비"
              hint="실제 비밀번호 대신 '테스트 계정은 1Password 의 X' 처럼 적는 편이 안전합니다."
            >
              <TextArea
                rows={2}
                value={opts.credentials}
                onChange={(e) => patch({ credentials: e.target.value })}
                placeholder="예: 스테이징 계정 tester@example.com / 비밀번호는 운영자에게 요청"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="탐색 깊이">
                <TextInput
                  type="number"
                  min={1}
                  max={10}
                  value={opts.maxDepth}
                  onChange={(e) =>
                    patch({
                      maxDepth: Math.min(10, Math.max(1, Number(e.target.value) || 3)),
                    })
                  }
                />
              </Field>
              <Field label="구동 방식">
                <Segmented
                  value={opts.driver}
                  onChange={(driver) => patch({ driver })}
                  options={[
                    { value: "playwright-mcp", label: "Playwright" },
                    { value: "chrome-devtools-mcp", label: "DevTools" },
                    { value: "manual", label: "수동" },
                  ]}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="무엇을 파헤칠까" subtitle="Pass 3 — 실제로 눌러보는 단계">
          {focusKeys.map((k) => (
            <Toggle
              key={k}
              checked={opts.focus[k]}
              onChange={(v) => setOpts({ ...opts, focus: { ...opts.focus, [k]: v } })}
              label={FOCUS_LABELS[k][0]}
              hint={FOCUS_LABELS[k][1]}
            />
          ))}
        </Card>

        <Card title="산출물">
          {deliverableKeys.map((k) => (
            <Toggle
              key={k}
              checked={opts.deliverables[k]}
              onChange={(v) =>
                setOpts({ ...opts, deliverables: { ...opts.deliverables, [k]: v } })
              }
              label={DELIVERABLE_LABELS[k][0]}
              hint={DELIVERABLE_LABELS[k][1]}
            />
          ))}
          <div className="mt-3">
            <Field label="추가 요구사항">
              <TextArea
                rows={3}
                value={opts.extra}
                onChange={(e) => patch({ extra: e.target.value })}
                placeholder="예: 한국어로 작성. 결제 흐름은 확인 다이얼로그까지만."
              />
            </Field>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-xs leading-relaxed text-ink-300">
          <strong className="text-ink-100">왜 이런 구조인가.</strong> 소스 없이 UI 만
          보고 명세를 복원한 사례(Thoughtworks 의 Odoo CRM 재구성)에서 보고된 가장 큰
          한계는 <em>에이전트가 지나치게 단순한 해피패스만 찾아낸다</em>는 점이었습니다.
          그래서 이 프롬프트는 4-pass 절차와 화면당 실패·분기 <em>할당량</em>을 강제하고,
          관찰하지 못한 것은 <code className="text-accent-300">## Unverified</code> 로
          분리하게 합니다.
        </div>

        <PromptPanel
          prompt={prompt}
          filename="navigation-spec-prompt.md"
          onSave={() => onSave(opts.url || "네비게이팅 테스트", prompt)}
        />
        <RunPanel
          prompt={prompt}
          images={[]}
          disabledReason="이 프롬프트는 브라우저 조작 도구가 붙은 에이전트에게 주는 것입니다. 복사해서 Playwright MCP 가 연결된 세션에 붙여넣으세요."
        />
      </div>
    </div>
  );
}
