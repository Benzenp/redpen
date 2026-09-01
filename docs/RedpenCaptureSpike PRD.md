# Redpen Capture Spike PRD

## 배경

`docs/PRODUCT_INTENT.md`와 `docs/ARCHITECTURE.md`는 Redpen의 핵심 가정으로 "같은 시점에 screenshot과 visible DOM 좌표를 함께 얻고, 이를 별도 annotation UI로 넘길 수 있는가"를 지목한다. `docs/IMPLEMENTATION_PLAN.md` §3 (Phase 0)은 이 가정을 제품 UI 없이 최소 코드로 먼저 검증하도록 지정한다. 이 PRD는 Phase 0 spike의 요구사항과 완료 기준을 정의한다.

## 목표

- Playwright persistent Chromium이 localhost/파일 기준 페이지를 열고 재사용 가능한 프로필로 세션을 유지할 수음을 증명한다.
- 페이지에 삽입하는 floating control이 host 페이지의 스타일/동작에 간섭하지 않음을 증명한다 (Shadow DOM 격리).
- "화면 고정" 동작 한 번으로 screenshot과 visible DOM index가 동일 시점에서 생성됨을 증명한다.
- screenshot 좌표를 클릭했을 때 원래 DOM element로 정확히 역매핑됨을(스크롤 전/후 모두) 증명한다.
- 민감 정보(password value 등)가 DOM index에 저장되지 않음을 증명한다.

## 비목표

- annotation UI, tldraw 통합, task bundle 저장, CLI 명령, MCP adapter는 이 spike의 범위가 아니다 (각각 Phase 1 이후).
- 실제 localhost dev server 대상 검증(HTTP)은 이 spike 범위가 아니다. `file://` fixture로 동일한 캡처 원리를 검증한다.
- 여러 OS 교차 검증은 이 spike 범위가 아니다. 현재 개발 워크스테이션(Windows)에서만 확인한다.

## 요구사항

1. `fixtures/frontend/index.html`은 다음을 포함하는 결정론적 fixture여야 한다: 스크롤 가능한 긴 페이지, `data-testid`가 있는 상호작용 요소, `display:none` 요소, 뷰포트 밖(5000px) 요소, password `<input>`.
2. capture 로직은 Shadow DOM host에 격리된 "Mark this screen" 버튼을 주입해야 하며, host 외부 CSS에 영향을 주지 않아야 한다.
3. 버튼 클릭과 동일한 실행 tick에서 screenshot과 visible DOM index를 생성해야 한다.
4. DOM index는 `display:none`, `visibility:hidden`, zero-size, 뷰포트 밖 요소를 제외해야 한다.
5. DOM index는 password/input value, script/style 내용을 수집하지 않아야 한다.
6. 캡처된 rect를 이용해 임의의 screenshot-space 좌표를 가장 작은 면적의 겹치는 DOM candidate로 역매핑할 수 있어야 한다.
7. 스크롤 후 재캡처에서도 동일한 역매핑 정확도가 유지되어야 한다.
8. 결과는 자동 검증 가능한 report(pass/fail 목록)로 남아야 한다.

## 성공 기준

- 위 요구사항에 대응하는 자동 assertion이 모두 통과한다.
- 산출물(`screenshot-*.png`, `dom-index-*.json`, `report.json`)이 사람이 직접 확인 가능한 형태로 저장된다.
- `docs/IMPLEMENTATION_PLAN.md`에 결과, 발견한 제약, tldraw 판단 근거가 기록된다.

## 현재 상태

구현 완료. `apps/cli/src/spike/capture-spike.ts` 실행 결과 10/10 자동 검증 통과. 상세 내역은 `docs/RedpenCaptureSpike FunctionalDesign.md`와 `taskhistory/2026-09-01 14-35-00 Task.md` 참고.
