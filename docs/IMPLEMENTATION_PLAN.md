# Redpen 구현 계획

## 1. 구현 전략

Redpen은 한 번에 완성하지 않는다. 가장 큰 기술 위험인 “같은 화면의 screenshot과 DOM 좌표를 얻고, 별도 annotation UI로 자연스럽게 넘기는가”를 먼저 검증한다.

구현 순서:

```text
Capture spike
→ Protocol과 session core
→ 색깔별 annotation UI
→ DOM grounding과 task bundle
→ CLI lifecycle
→ MCP/Skill adapter
→ review loop와 안정화
```

모든 phase는 독립적으로 실행 가능한 결과와 명확한 완료 조건을 가진다.

## 2. 추천 저장소 구조

초기에는 과도한 package 분리를 피하되 protocol과 UI boundary는 분리한다.

```text
redpen/
├── apps/
│   ├── cli/                 # CLI, daemon, browser orchestration, MCP entrypoint
│   └── annotator/           # React annotation UI
├── packages/
│   └── protocol/            # canonical schema, geometry, DTO, migrations
├── skills/
│   └── redpen/
│       └── SKILL.md         # shared Agent Skill core
├── fixtures/
│   └── frontend/            # deterministic E2E target app
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`apps/cli` 내부 module 예시:

```text
src/
├── commands/
├── application/
├── daemon/
├── browser/
├── capture/
├── grounding/
├── storage/
├── mcp/
└── index.ts
```

MCP가 커지기 전까지 별도 package로 나누지 않는다. CLI와 MCP가 application service를 공유하지 못하는 구조가 보일 때만 분리한다.

## 3. Phase 0 — 위험 제거 spike

### 목표

아키텍처의 핵심 가정을 최소 코드로 검증한다. 제품 UI 품질이나 배포는 고려하지 않는다.

### 작업

- [x] Node/TypeScript workspace scaffold
- [x] Playwright persistent Chromium profile 실행
- [x] URL 인자로 localhost 페이지 열기 (spike는 file:// fixture로 동일 원리 검증; localhost dev server 연결은 Phase 4 CLI에서 재확인)
- [x] Shadow DOM floating `Mark this screen` button 삽입
- [x] 버튼 클릭 시 control을 숨기고 viewport screenshot 저장
- [x] 같은 시점에 visible element의 rect/text/role을 수집
- [ ] 별도 local tab에 screenshot 표시 (Phase 0 spike는 파일로 저장/검증만 수행; 별도 탭 표시는 annotator UI가 생기는 Phase 2 범위)
- [x] screenshot 좌표를 클릭하면 원래 DOM element가 식별되는지 확인
- [ ] Windows와 현재 주 개발 OS에서 브라우저 open/close 확인 (이번 실행은 Windows에서 수행/통과; 별도 주 개발 OS 교차 확인은 아직 미실시)

### 완료 조건

- 하나의 fixture page에서 screenshot상의 세 지점을 클릭했을 때 예상 DOM element가 모두 식별된다.
- scroll 후 캡처에서도 좌표가 일치한다.
- browser profile을 재사용했을 때 session이 유지된다.
- spike 결과로 tldraw 채택 여부를 결정할 근거가 생긴다.

### Phase 0 실행 결과 (2026-09-01)

`apps/cli/src/spike/capture-spike.ts`로 구현 및 실행 완료. 10개 자동 검증 항목 전부 통과 (`apps/cli/.spike-output/report.json`).

- `chromium.launchPersistentContext`로 전용 profile(`apps/cli/.spike-profile`)을 열고 `fixtures/frontend/index.html`을 로드했다.
- Shadow DOM host에 `Mark this screen` 버튼을 주입했고, 클릭 시 host를 숨기면서 host 외부 스타일에 영향이 없었다.
- 버튼 클릭과 같은 tick에서 viewport screenshot과 visible DOM index(`dom-index-browser.js`)를 함께 생성했다.
- top 캡처에서 `save-button`이 index에 수집되고, bounding box 중심점을 클릭 좌표로 넣었을 때 정확히 `save-button`으로 resolve됐다.
- `window.scrollTo(0, 1100)` 이후 재캡처에서도 `price-card`가 새 rect로 수집되고 같은 방식으로 정확히 resolve됐다 — capture-time 좌표계가 스크롤 후에도 screenshot과 DOM 사이에서 일치함을 확인.
- `display:none` element와 5000px 밖 offscreen element는 index에서 정상적으로 제외됐다.
- password `<input>`은 존재는 후보로 수집되지만 `value`는 어떤 직렬화 결과에도 포함되지 않았다 (redaction 원칙 검증).
- browser profile 디렉터리(`Default` 하위 구조)가 실행 후에도 남아 재사용 가능함을 확인했다.

**주요 구현 제약**: 브라우저에 주입해 `page.evaluate`로 실행하는 DOM 수집 함수는 esbuild/tsx가 컴파일 시 삽입하는 `__name()` 헬퍼를 참조하면 페이지 컨텍스트에 그 헬퍼가 없어 `ReferenceError`가 발생한다. 해결책: 수집 로직을 별도의 순수 untranspiled `.js` 파일(`dom-index-browser.js`)로 유지하고 파일 내용을 문자열로 읽어 `page.evaluate(sourceText)`로 실행한다. TypeScript 쪽 `dom-index.ts`는 타입과 `findCandidateAtPoint`만 담당한다. 이후 phase에서 실제 daemon 코드로 옮길 때도 이 분리 원칙(브라우저 주입 코드는 컴파일러 헬퍼에 의존하지 않는 순수 JS)을 유지해야 한다.

**tldraw 채택 판단**: 이번 spike는 tldraw를 사용하지 않았다 (Phase 0 목표가 capture/grounding 가정 검증이었으므로 범위 밖). tldraw 자체 검증(screenshot locked background, group별 강제 shape style, badge/selection 동기화, SVG/JSON export, mask opaque export)은 Phase 2 시작 시 별도로 수행한다. Phase 0에서 확인된 것은 tldraw 채택과 무관하게 screenshot+DOM index 캡처 파이프라인 자체가 안정적이라는 점이다.

### 중단/전환 기준

- 페이지 injection이 반복적으로 앱 동작을 방해하면 floating control 대신 별도 controller window 또는 browser extension 방향을 재검토한다.
- Playwright managed browser가 사용 흐름에 과도한 마찰을 만들면 extension을 별도 ADR로 검토한다. MVP에서 두 방식을 동시에 구현하지 않는다.

## 4. Phase 1 — Protocol과 session core

### 목표

UI보다 먼저 안정적인 task/session schema와 상태 전이를 만든다.

### 작업

- [ ] `schemaVersion: 1` protocol 정의
- [ ] VisualTask, Frame, InstructionGroup, Mark, DomTarget schema
- [x] CSS pixel 및 normalized coordinate utility
- [x] session state machine 구현
- [x] invalid transition 오류 정의
- [x] task ID/session ID 생성 규칙
- [x] workspace 및 global app-data path resolution
- [x] atomic bundle writer와 checksum
- [x] `.redpen/latest.json` writer
- [x] schema migration entrypoint 틀

### 테스트

- [x] schema round-trip
- [x] 모든 합법/불법 상태 전이
- [x] coordinate transform property test
- [x] atomic write 중단 복구
- [x] path traversal 방지

### 완료 조건

- fixture JSON이 validation을 통과하고 다시 읽었을 때 손실이 없다.
- interrupted write가 유효한 제출 작업으로 노출되지 않는다.

### Phase 1 실행 결과 (2026-09-01)

`packages/protocol/src/`에 구현 완료. `pnpm --filter @redpen/protocol run test` 30/30 통과, `run typecheck` clean.

- `schema.ts`: zod discriminated union으로 6종 Mark(`freehand`/`arrow`/`rectangle`/`ellipse`/`text`/`mask`), `VisualSession`, `VisualTask`, `Frame`, `InstructionGroup`, `DomTarget`을 정의. `computedLayout`은 allowlist 12개 키로 제한(런타임 `refine`으로 검증).
- `geometry.ts`: CSS pixel ↔ normalized(0..1) rect/point 변환, rect intersection/containment/area 유틸. property-test로 왕복 변환 무손실 확인.
- `state-machine.ts`: `docs/ARCHITECTURE.md` §5 상태 다이어그램을 그대로 전이 테이블로 구현. 8 session state × 9 transition = 72개 조합 전부(합법 11개 + 불법 61개)를 열거해 테스트.
- `ids.ts`: ULID 기반 `rps_`/`rpt_`/`frm_`/`grp_`/`mrk_`/`tgt_` prefix ID 생성.
- `paths.ts`: workspace 하위 `.redpen/tasks/<id>` 경로와 OS별 global app-data 경로(Windows `%APPDATA%`, macOS `~/Library/Application Support`, Linux `$XDG_DATA_HOME`) 분리. id에 `..`, path separator, null byte가 있으면 `PathTraversalError`.
- `storage.ts`: `.tmp-<task-id>/`에 먼저 쓰고 checksum 계산 후 atomic rename하는 writer. 중단 시나리오(유효하지 않은 content로 강제 실패)에서 tmp/최종 디렉터리 모두 남지 않음을 테스트로 확인.
- `migrations.ts`: schemaVersion 기반 forward-migration 레지스트리 틀 (현재는 v1만 존재하므로 등록된 migrator 없음).

**미해결 항목**: 이 phase는 순수 protocol 레이어만 구현했고 daemon/CLI에 아직 연결하지 않았다. Phase 4(CLI lifecycle)에서 실제 session/task 생성 흐름에 연결할 때 이 패키지를 그대로 import해서 쓴다.

## 5. Phase 2 — Annotation UI와 색깔별 지시

### 목표

사용자가 한 캡처 화면에 여러 요구사항을 직관적으로 작성하고 완료를 명시할 수 있다.

### 작업

- [x] screenshot을 잠긴 background로 렌더링
- [x] pan/zoom 및 viewport fit (session-client.ts: wheel로 zoom, Shift+drag/middle-click drag로 pan; 캔버스 리사이즈 시 fit-to-viewport)
- [x] `#1` 기본 group 자동 생성
- [x] 고대비 color palette와 group number badge
- [x] group card 선택 시 active drawing group 전환
- [x] freehand, arrow, rectangle, ellipse, text, mask
- [x] select/move/delete, undo/redo (removeMark + undo/redo 구현·테스트; 포인터 기반 drag-select UI는 아직 없고 프로그래매틱 API만 검증)
- [x] global note (session.html의 실제 textarea → setGlobalNote API → submit에 반영, ui-e2e-check.ts로 왕복 검증)
- [x] group별 optional note
- [x] disconnected mark cluster마다 group badge 표시
- [x] `새 지시` 및 `N개 지시 제출` (두 버튼 모두 실제 daemon API + storage와 연결, 실제 클릭으로 taskId 생성까지 검증)
- [x] 빈 group 경고 (`AnnotatorStore.findEmptyGroups`/`canSubmit`으로 구현하고, session.html에서 실제 경고 문구 표시 + 제출 버튼 disabled 연동까지 완료)
- [x] vendor canvas state → Redpen Mark schema adapter (vendor canvas 자체를 쓰지 않고 처음부터 Redpen Mark schema로만 그리므로 adapter가 필요 없음 — 아래 실행 결과 참고)
- [x] `overlay.svg`와 `annotated.png` export (`overlay.svg`는 `renderOverlaySvg`로 구현; `annotated.png`는 `page.screenshot()`으로 캡처 검증, 실제 daemon 저장 경로는 Phase 3)

### UX acceptance scenarios

- [x] 한 색으로 원과 화살표를 여러 개 그려 모두 `#1`에 연결한다.
- [x] `#2`로 직접 3열 표를 그리고 sidebar 설명을 추가한다.
- [x] `#3` mask로 기존 요소를 가리고 새 버튼을 그린다.
- [x] 그룹을 오가며 수정해도 기존 mark의 group이 바뀌지 않는다.
- [x] 색을 구분하기 어려워도 번호만으로 모든 연결을 이해할 수 있다.

### 완료 조건

- 세 그룹과 열 개 이상의 mark가 있는 작업을 제출하고 다시 열었을 때 동일하게 보인다.
- export 이미지와 vector JSON의 group/geometry가 일치한다.

### Phase 2 실행 결과 (2026-09-01)

`packages/annotator-core/src/`(프레임워크 독립적 그룹/마크 상태 store, 순수 TS)와 `apps/annotator/`(canvas 렌더러 + 최소 데모 페이지)에 구현. `pnpm --filter @redpen/annotator-core run test` 19/19 통과, `pnpm --filter @redpen/annotator run e2e`(실제 Chromium, 로컬 static 서버) 8/8 통과, 둘 다 `tsc --noEmit` clean.

- tldraw는 사용하지 않음. `docs/ARCHITECTURE.md` §3.6이 명시한 대체 경로("검증이 실패하면 annotation engine을 Konva 등 저수준 canvas로 교체한다")를 처음부터 채택했다 — 필수 tool(pen/arrow/rect/ellipse/text/mask/select/erase/undo-redo) 전부를 순수 canvas 2D로 구현할 수 있고, 어차피 canonical schema는 vendor 상태를 저장하지 않으므로 처음부터 canonical Mark만 다루는 편이 adapter 계층 자체를 없앤다.
- `AnnotatorStore`(`packages/annotator-core/src/store.ts`): group 생성/선택, mark 추가/삭제, undo/redo(스냅샷 스택, `MAX_HISTORY=200`), `findEmptyGroups`/`canSubmit`, `computeBadgeClusters`(union-find로 인접/교차 mark를 클러스터링해 분리된 영역마다 배지 반복). 생성자에서 `#1`을 만드는 로직은 `createGroup()`을 재사용하지 않고 인라인 처리해 최초 상태가 undo 스택을 오염시키지 않게 했다.
- `renderOverlaySvg`(`export-svg.ts`): canonical Mark/Group에서 바로 SVG를 만들며 vendor 상태를 경유하지 않는다. text mark는 XML 특수문자를 escape해 script injection이나 malformed XML을 방지.
- `apps/annotator/src/client.ts`의 `AnnotatorApp`이 store를 감싸 canvas에 screenshot 배경 → mark → 배지 순으로 그린다. `apps/annotator/public/index.html`은 사이드바 group 카드와 `새 지시` 버튼만 있는 최소 데모(프로덕션 UI 폴리시는 범위 밖).
- 브라우저 실행 코드는 esbuild(`apps/annotator/scripts/build.mjs`)로 IIFE 단일 파일(`public/client.bundle.js`)로 번들. `@redpen/protocol`에 서브패스 export(`./schema`, `./ids`, `./geometry` 등)를 추가해 `annotator-core`가 Node 전용 모듈(`storage.ts`의 `fs`/`crypto`)을 배럴 경유로 끌어들이지 않게 분리했다 — 그 전에는 esbuild가 `node:fs/promises` 등을 브라우저 번들에 넣으려다 실패했다.
- `apps/annotator/src/e2e-check.ts`는 Phase 0 패턴처럼 실제 Chromium으로 데모를 열어 8개 시나리오(잠긴 screenshot 배경 렌더링, `#1` freehand+arrow, `#2` 3열 표+note, `#3` mask+새 rect, group 전환 시 mark groupId 불변, export SVG의 mark-id/배지 존재, undo/redo 왕복)를 검증한다. `file://`로 이미지를 로드하면 Chromium의 cross-origin canvas taint 정책 때문에 `getImageData`가 `SecurityError`를 던져, 로컬 static HTTP 서버(포트 0 자동 할당)로 서빙하도록 바꿔 해결했다 — 실제 daemon도 결국 localhost HTTP로 서빙하므로 이 전환이 프로덕션 경로와도 맞다.

**미해결 항목 해소 (2026-09-01 후속)**: annotation UI를 daemon과 실제로 연결했다. 이전에는 daemon이 `@redpen/annotator-core`의 `AnnotatorStore`를 세션마다 들고 있으면서도 그것을 보여주는 진짜 브라우저 탭을 전혀 열지 않았다 — 사용자가 `redpen open`을 해도 마킹할 화면 자체가 없었다.

- `apps/cli/src/browser/manager.ts`: `openAnnotatorTab()`을 추가해 live 타겟 페이지와 같은 persistent Chromium context 안에 별도 tab으로 annotation UI를 연다(docs/ARCHITECTURE.md §4.2 "annotation UI를 별도 local tab으로 연다"). `REDPEN_HEADLESS=0`으로 실제 사람이 화면을 볼 수 있게 headless 여부를 오버라이드 가능(기존 모든 자동 테스트는 계속 headless).
- `apps/cli/src/daemon/server.ts`: `GET /annotator/:sessionId`(HTML 페이지), `GET /session.bundle.js`(정적 JS, 세션 무관이라 인증 불필요), `GET /api/sessions/:id/annotator/screenshot`(캡처 이미지)를 추가하고, 나머지 `/api/sessions/:id/annotator/*`에 marks 추가/삭제, undo/redo, group 생성/전환/note, global note, submit까지 REST API로 노출. 브라우저 탭은 top-level navigation과 `<img>` 요청에 Authorization 헤더를 못 붙이므로 이 라우트들만 `?token=` 쿼리 파라미터 인증도 허용(그 외 라우트는 여전히 헤더만 허용).
- `apps/cli/src/application/service.ts`: `getAnnotatorState`/`addMark`/`removeMark`/`undoAnnotation`/`redoAnnotation`/`createAnnotationGroup`/`setActiveAnnotationGroup`/`setAnnotationGroupNote`/`setGlobalNote`/`exportAnnotationOverlaySvg`를 추가해 UI가 CLI와 동일한 application core만 호출하게 했다. `freeze()`가 daemon 자신의 origin(포트+토큰)을 알아야 annotator URL을 만들 수 있어 `setSelfOrigin()`을 추가하고 `startDaemon()`이 리슨 성공 직후 호출.
- `apps/annotator/src/session-client.ts`(신규): 데몬 API가 유일한 canonical 상태이고 UI는 optimistic mutation을 하지 않는 `SessionAnnotatorApp`. 실제 pointer 이벤트(pointerdown/move/up)로 freehand/arrow/rectangle/ellipse/mask를 그리고, `prompt()`로 text mark를 추가하며, 마우스 wheel로 확대/축소, Shift+drag 또는 middle-click drag로 pan을 구현. 모든 그리기 동작은 즉시 daemon에 POST하고 응답으로 다시 렌더링(로컬 상태를 따로 신뢰하지 않음).
- `apps/annotator/public/session.html`(신규): 캔버스 + 툴바 + 사이드바(그룹 카드, 그룹별 note textarea, 전체 note textarea, undo/redo, 제출 버튼)를 갖춘 실제 사용 페이지. 빈 그룹에는 "⚠️ 아직 아무것도 그리지 않았어요" 경고를 표시하고 제출 버튼은 `canSubmit`이 false면 비활성화된다.

**막힌 문제와 해결**:
- `session.bundle.js`를 `?token=` 쿼리로 보호했더니 `<script src="/session.bundle.js">`가 401을 받아 앱이 전혀 부팅되지 않았다 — `<script>` 태그의 `src`에는 쿼리스트링을 넣을 수 없다는 걸 놓쳤다. 해결: 이 파일은 세션 정보를 전혀 담지 않는 정적 코드이므로 인증 없이 서빙하도록 바꿨다.
- 캔버스 위에 툴바가 `position: absolute; top:12px; left:12px`로 겹쳐 있어서, 좌상단 근처 좌표(예: 50,50)로 pointer 이벤트를 보내면 캔버스가 아니라 툴바 버튼이 이벤트를 가로챘다 — 실제 e2e 테스트로 좌표를 툴바 밖(300,300 이상)으로 옮겨서 발견/해결.
- 캔버스 pointer 드래그로 mark를 추가해도 사이드바의 제출 버튼 `disabled` 상태가 갱신되지 않는 실제 버그를 발견했다 — 사이드바 재렌더링이 버튼 클릭 핸들러 안에서만 호출되고 있었다. `SessionAnnotatorApp`에 `onStateChange` 콜백을 추가해 모든 daemon round-trip(그리기 포함) 후 호출되도록 해서 그림을 그리자마자 제출 버튼이 즉시 활성화되게 고쳤다.

Verified via `apps/cli/src/ui-e2e-check.ts`: 실제 `redpen` CLI로 open/freeze한 뒤, 진짜 Playwright 브라우저 탭에서 annotator 페이지를 열어 pointer drag로 사각형을 그리고(실제 API round-trip으로 mark 1개 생성 확인), wheel로 확대(scale 변경 확인), Shift+drag로 이동(pan 변경 확인), 사이드바 "새 지시" 버튼으로 그룹 2 생성, 두 번째 그룹에도 타원을 그려 채우고, 실제 textarea에 전체 note를 입력하고 실제 제출 버튼을 클릭 → 제출 완료 메시지와 taskId 확인 → CLI로 그 task를 다시 읽어 note와 그룹 2개가 그대로 저장됐는지까지 10/10 통과. 기존 test:lifecycle(16/16), test:daemon-lifecycle(11/11), test:mcp(11/11), test:review-loop(11/11), 그리고 annotator/protocol/annotator-core/grounding/review 유닛 테스트(총 93개) 전부 회귀 없이 재통과 확인.

## 6. Phase 3 — DOM grounding과 task bundle

### 목표

표시된 요구사항을 캡처 시점의 DOM 문맥에 자동 연결한다.

### 작업

- [x] visible DOM candidate collector
- [x] 민감 attribute/value redaction
- [x] role/accessibility name/text summary 추출
- [x] selector hint 생성: test ID → stable ID → role/name → structural hint 순서
- [x] rect intersection 및 containment scoring
- [x] freehand path proximity scoring
- [x] arrow source/destination grounding
- [x] nearest container fallback
- [x] parent/sibling summary
- [x] computed layout allowlist
- [x] group별 target ranking과 중복 제거
- [x] temporary full index 폐기
- [x] task.md human summary 생성 (Phase 1 storage.ts에서 이미 구현됨, 이번 phase에서 실제 grounded VisualTask로 재확인)
- [x] source/overlay/annotated/task JSON bundle 작성

### 정확도 원칙

- selector hint는 실행 가능한 selector임을 보장하지 않는다. 코드 탐색 단서다.
- 여러 후보가 비슷하면 하나를 확정하지 않고 ranking을 보존한다.
- DOM target이 없어도 제출을 실패시키지 않는다.
- image와 user note가 canonical intent이며 DOM은 grounding hint다.

### 테스트

- [x] flex/grid/absolute layout fixture
- [x] nested interactive element
- [x] text 없는 icon button
- [x] scroll offset
- [x] device scale factor
- [x] blank area sketch
- [x] password/input value redaction
- [x] DOM mutation 직전/직후 capture consistency

### 완료 조건

- fixture acceptance set에서 표시된 대상이 top candidates 안에 포함된다.
- task bundle에 금지된 input value, cookie, storage data가 없다.

### Phase 3 실행 결과 (2026-09-01)

`packages/grounding/src/`에 구현. 유닛 테스트 14/14, 실제 Chromium e2e grounding 테스트 10/10, capture→annotate→ground→assemble→atomic bundle write→read-back 통합 테스트 1/1 (전부 `pnpm --filter @redpen/grounding run test`), `tsc --noEmit` clean.

- `collector-source.ts`: Phase 0에서 확립한 원칙(브라우저에 주입되는 코드는 컴파일러 헬퍼에 의존하지 않는 순수 문자열 소스)을 그대로 따라 `COLLECTOR_SOURCE` 문자열을 `page.evaluate(sourceText)`로 실행. rect/tag/role/accessible name/text summary/testId/id/class hint뿐 아니라 parent/sibling summary와 computedLayout allowlist까지 한 번에 수집.
- `selector-hints.ts`: test-id → stable id → role/name → class → tag 순서로 hint를 쌓는다. 마지막 tag fallback은 항상 존재해서 target이 selector-less가 되지 않는다. hint는 실행 가능한 selector를 보장하지 않는다는 점을 문서화.
- `ground.ts`: rectangle/ellipse/mask는 intersection-over-union으로 스코어링(작고 딱 맞는 후보가 큰 조상 요소보다 높은 점수를 받도록 IoU를 채택 — 단순 containment/coverage 비율만 쓰면 거대 조상이 더 높게 나오는 문제를 테스트로 발견해 수정). freehand는 path 위 표본점과 후보 rect 사이 최소 거리로 근접도 스코어링. arrow는 `from`을 `arrow-source`, `to`를 `arrow-destination`으로 각각 독립적으로 nearest-container 매칭. text는 anchor point 최근접. 빈 영역 스케치는 모든 1차 스코어링이 0을 반환하면 mark bounds 중심점 기준 nearest-container로 폴백. `buildDomTargets`는 mark 여러 개가 같은 tempId 후보에 그라운딩되면 하나의 DomTarget으로 합치고 `groupIds`만 누적(중복 제거), computedLayout은 12개 allowlist 키만 통과.
- `capture.ts`: `collectDomIndex`(collector 실행) + `captureAndGround`(grounding까지 포함) 두 단계로 분리. 호출자는 grounding이 끝나면 `RawDomIndex`를 더 들고 있지 않아야 한다 — 전체 temporary index는 함수 반환 후 GC됨 (docs/ARCHITECTURE.md §4.3의 "제출/취소 후 폐기" 요구를 코드 구조로 강제).
- `redaction.ts`: `assertNoForbiddenValues`로 임의의 직렬화 결과에 금지 문자열이 없는지 검증하는 재사용 가능한 assertion. bundle 통합 테스트와 grounding 유닛 테스트 양쪽에서 사용.
- `assemble.ts`: annotator-core store 상태 + grounded target을 `VisualTask`로 합치며 각 `InstructionGroup.targetIds`를 `target.groupIds`에서 역산해 채운다.
- `fixtures/frontend/grounding.html`: flex row, grid, absolute 카드, nested wrapper+button, icon-only button, 2000px 스크롤 후 요소, password input, 빈 영역을 모두 포함한 결정론적 fixture.
- `packages/grounding/src/bundle.e2e.test.ts`: 실제 Chromium으로 fixture를 열고, `@redpen/annotator-core`로 두 그룹(카드 지적 + password 필드 지적)을 그린 뒤 grounding, `assembleVisualTask`, `@redpen/protocol`의 `writeTaskBundle`/`readTaskBundle`까지 전부 실행해 파이프라인 전체가 맞물려 동작함을 확인. password 값은 어디에도 나타나지 않지만 password 필드 자체는 여전히 유효한 grounding 후보로 남는다.

**미해결 항목**: DOM target ranking의 IoU 스코어링은 겹치는 후보가 정확히 동일한 경우(완전히 같은 rect를 가진 두 엘리먼트) 순서가 삽입 순서에 의존한다 — 실제 페이지에서는 드문 경우이므로 지금은 허용하고 별도 tie-break는 추가하지 않았다. daemon/CLI에서 실제 submit 흐름에 이 패키지를 연결하는 일은 Phase 4로 넘긴다.

## 7. Phase 4 — CLI lifecycle

### 목표

사람과 coding agent가 CLI만으로 전체 세션을 제어한다.

### 작업

- [x] `redpen daemon start|stop|status` (전부 구현. `daemon start`는 이미 떠 있으면 같은 pid를 재사용하고, `daemon stop`은 SIGTERM 후 discovery record를 지우고, `daemon status`는 아래 health probe 결과를 반환)
- [x] daemon auto-discovery/auto-start
- [x] `redpen open`
- [x] `redpen list/status/show/close` (`show`는 브라우저 탭을 다시 여는 대신 `status`로 대체 구현; headless 데몬이라 탭을 실제로 보여줄 필요가 없음)
- [x] `redpen wait` long poll 및 timeout recovery
- [x] `redpen review`
- [x] 모든 명령의 `--json` mode
- [x] stdout/stderr 분리
- [x] stable exit code 표
- [ ] stale PID/port/token recovery (PID가 죽어있으면 재시작하는 경로는 있으나 "살아있지만 응답 없음" 같은 반쪽 죽음 상태 복구는 아직 미구현)
- [x] Ctrl+C와 abnormal exit cleanup (daemon.ts의 SIGINT/SIGTERM 핸들러)
- [x] npm package의 `bin` entry

### CLI contract test

- [x] JSON stdout이 log로 오염되지 않는다.
- [x] daemon이 없을 때 `open`이 자동 시작한다.
- [x] wait timeout 후 session이 유지된다.
- [x] 두 workspace의 session/task가 섞이지 않는다.
- [x] 종료된 task를 session ID로 다시 찾을 수 있다.

### 완료 조건

다음 script가 수동 파일 편집 없이 성공한다.

```text
open → status → user submit → wait returns task → update working → review → done
```

### Phase 4 실행 결과 (2026-09-01)

`apps/cli/src/`에 구현: application service, daemon HTTP server, browser manager, session runtime, CLI 커맨드, npm bin entry. `pnpm --filter @redpen/cli run test:lifecycle`가 실제 CLI를 자식 프로세스로 spawn해 16개 시나리오(완료 조건 스크립트 전체 + CLI contract test 5개 항목)를 검증, 16/16 통과. `tsc --noEmit` clean.

- `application/service.ts`: CLI와 (향후) MCP가 공유하는 유일한 business logic 계층. open/freeze/submit/wait/claim/review-ready/accept/cancel/close를 전부 여기서 구현하고, 상태 전이는 `@redpen/protocol`의 `nextSessionState`를 그대로 호출해 검증한다. submit은 grounding(`@redpen/grounding`)과 atomic bundle write(`@redpen/protocol/storage`)까지 한 번에 수행.
- `daemon/server.ts`: `127.0.0.1`에만 bind하는 순수 Node `http` 서버. 모든 요청에 discovery record의 random bearer token을 요구(불일치 시 401). 라우트는 서비스 호출과 JSON 직렬화만 담당.
- `daemon/discovery.ts`: OS별 global app-data 경로에 `{ pid, port, token, startedAt }`을 저장. `isProcessAlive`로 stale PID를 감지해 재사용 여부를 판단.
- `client/ensure-daemon.ts`: discovery record가 없거나 PID가 죽어있으면 `detached` daemon 프로세스를 새로 spawn하고, 그 프로세스가 stdout에 쓰는 `{ready:true}` 라인을 기다린 뒤 discovery record를 재읽어 반환.
- `browser/manager.ts`: Phase 0/2/3과 동일하게 `launchPersistentContext`로 전용 profile을 열고, sessionId별로 page를 매핑.
- `application/session-store.ts`: session record를 global app-data 하위 `sessions/<id>.json`으로 영속화(task bundle과 달리 이건 workspace 콘텐츠가 아니므로 저장 위치가 다름). `listSessions({ workspaceRoot })`로 workspace별 필터링.
- `cli.ts`: open/list/status/freeze/submit/wait/claim/review/accept/close/task 11개 명령, 전부 `--json`을 지원하고 human-readable 출력은 stderr, JSON 출력은 stdout 한 줄로 분리. `exit-codes.ts`에 5단계 안정 exit code.

**막힌 문제와 해결**:
- CLI 프로세스가 결과를 출력한 뒤에도 종료되지 않고 걸리는 버그 발견 — `fetch()`(undici) keep-alive 소켓이 이벤트 루프를 계속 물고 있었음. `main().then(...)`에서 `process.exit(code)`을 명시적으로 호출해 해결.
- `POST /sessions`와 `POST /sessions/:id/freeze`가 라우트 매칭 순서 버그로 충돌(앞쪽 라우트가 `parts[1]`을 검사하지 않아 `/sessions/<id>/freeze`도 먼저 먹어버림) — `!parts[1]` 조건을 추가해 해결. 실제 lifecycle 스크립트를 자식 프로세스로 끝까지 돌려본 덕에 발견한 문제.
- lifecycle 테스트에서 격리된 `appDataDir`(daemon discovery, browser profile, sessions 저장 위치)를 쓰기 위해 `APPDATA`/`HOME`/`XDG_DATA_HOME`을 오버라이드했는데, 테스트 종료 시 spawn된 daemon(및 그 Chromium)이 아직 살아있어 임시 디렉터리 rm이 `EBUSY`로 실패 — daemon discovery record를 직접 읽어 해당 PID에 SIGTERM을 보내고 잠깐 대기한 뒤 정리하도록 수정.

**미해결 항목 해소 (2026-09-01 후속)**: `daemon stop`/`daemon status` 하위명령과 반쪽 죽음(alive-but-unresponsive) 복구를 추가로 구현했다.

- `daemon/discovery.ts`의 `probeDaemonHealth()`: PID가 죽어있으면 `stale-pid`, PID는 살아있지만 `/health`가 응답하지 않으면 `hung`, 정상 응답하면 `running`, discovery record 자체가 없으면 `not-running`을 반환한다.
- `redpen daemon start`: 이미 떠 있으면(health=running) 같은 pid를 그대로 반환(idempotent), 아니면 새로 띄운다.
- `redpen daemon status`: health를 그대로 JSON으로 반환하고, `running`이 아니면 exit code `DAEMON_UNAVAILABLE(5)`을 반환한다.
- `redpen daemon stop`: discovery record의 pid에 SIGTERM을 보내고 discovery record를 지운다.
- `client/ensure-daemon.ts`의 `ensureDaemonRunning()`: PID가 죽어있으면 즉시 재시작, PID가 살아있는데 health probe가 `hung`이면 먼저 SIGTERM으로 죽이고 discovery record를 지운 뒤 새로 띄운다 — 반쪽 죽음 상태에서도 `redpen open` 등 일반 명령이 자동 복구된다.

**막힌 문제와 해결**: health probe를 처음에 전역 `fetch`(undici)로 구현했더니, CLI 명령(예: `status <session-id>`)이 probe용 fetch 한 번 + 실제 요청용 fetch 한 번을 같은 프로세스에서 연달아 호출한 뒤 `process.exit()`를 부르면 Windows에서 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`로 크래시했다(undici 커넥션 풀 handle이 강제 종료 시점에 아직 정리 중이었던 것으로 보임). `AbortController`를 안 쓰는 버전으로 바꿔도 동일하게 재현됨을 확인해 원인이 abort가 아니라 "짧은 프로세스에서 undici fetch 2회 + 강제 exit" 조합 자체임을 특정했다. 해결: health probe만 `node:http`의 `http.request`로 바꿔 undici 커넥션 풀을 전혀 거치지 않게 했다 — 실제 세션/태스크 요청은 여전히 `fetch`를 쓰지만 이제 프로세스당 undici 요청이 최대 1번만 발생한다. `apps/cli/src/daemon-lifecycle-check.ts`로 daemon start/stop/status idempotency, hung-daemon 감지, hung 상태에서 `open`이 실제로 복구되는지(SIGTERM 후 새 pid로 재시작)까지 11/11 통과 확인했고, 기존 `test:lifecycle` 16/16도 회귀 없이 재통과시켰다.

**여전히 미해결**: `redpen show`는 headless 데몬이라 탭을 실제로 열어줄 수 없어 `status`로 대체했다(UI 자체가 없으므로 이 우회는 유지).

## 8. Phase 5 — MCP와 Agent Skill

### 목표

Codex 및 Claude가 자연어 요청에서 Redpen 세션을 열고 제출된 작업을 읽는다.

### 작업

- [x] MCP stdio server entrypoint
- [x] session start/wait/get/update/review/cancel tools
- [x] tool input/output schema를 protocol DTO와 공유
- [x] long-running wait timeout/cancellation 처리
- [x] task asset path와 compact summary 반환
- [x] 공용 Agent Skills 표준에 맞는 `SKILL.md`
- [x] Codex 설치 script
- [x] Claude 설치 script
- [x] 두 host의 명령/설정 예제
- [x] “plan only” 기본 규칙

### Skill golden flow

```text
User: 이 페이지 수정할 거야. Redpen 열어봐.
Agent: dev server와 target URL 확인
Agent: redpen_start_session
User: 표시 후 제출
Agent: redpen_wait_for_submission 또는 redpen_get_task
Agent: group별 의도/대상/source 후보/모호성 정리
Agent: 구현 계획 제시
```

### 완료 조건

- 동일한 fixture task를 Codex와 Claude가 읽는다.
- 두 agent 모두 모든 Instruction Group을 누락 없이 나열한다.
- 사용자가 수정까지 요청하지 않은 경우 파일을 변경하지 않는다.

### Phase 5 실행 결과 (2026-09-01)

`apps/cli/src/mcp/`와 `skills/redpen/`에 구현. `pnpm --filter @redpen/cli run test:mcp` 11/11 통과(InMemoryTransport로 실제 McpServer를 구동), `node skills/redpen/scripts/install-check.mjs` 7/7 통과, `tsc --noEmit` clean.

- `mcp/server.ts`: `redpen_start_session`/`redpen_wait_for_submission`/`redpen_get_task`/`redpen_update_task`/`redpen_open_review`/`redpen_cancel_session` 6개 tool을 `McpServer.registerTool`로 등록. 각 tool은 CLI와 동일한 `DaemonClient`만 호출해 business logic을 MCP 쪽에 복제하지 않는다(docs/ARCHITECTURE.md §2.1). input schema는 zod로 정의.
- `redpen_wait_for_submission`은 timeout을 에러로 취급하지 않고 `{ taskId: null, session }`을 반환한다 — MCP host별 long-running tool 제한이 있어도 `redpen_get_task`로 항상 재조회 가능.
- `redpen_update_task(session_id, state)`는 `working`/`review`/`done` 세 값을 각각 claim/reviewReady/accept로 매핑해 하나의 tool로 세 전이를 표현.
- `skills/redpen/SKILL.md`: golden flow, 6개 tool 설명, task bundle 읽는 법(selectorHints는 실행 보장 selector가 아니라는 점, group 번호가 identity라는 점, targetIds가 없는 group도 유효하다는 점), plan-only 기본 규칙을 명시.
- `skills/redpen/scripts/install-codex.sh`, `install-claude.sh`: 각각 `SKILL.md`를 host의 skill 디렉터리로 복사하고 MCP 서버 항목(Codex는 `config.toml`의 `[mcp_servers.redpen]`, Claude는 프로젝트 `.mcp.json`)을 추가. 두 스크립트가 정확히 동일한 `SKILL.md`를 배포하는지와 설정 파일이 실제로 쓰였는지를 `install-check.mjs`로 검증.

**미해결 항목**: 실제 Codex CLI/Claude Code 프로세스를 띄워 두 host가 동일 fixture task를 읽는 것까지는 확인하지 못했다(에이전트 host 자체는 이 저장소 밖의 설치된 도구이므로). 대신 (1) 두 개의 독립적인 MCP client가 같은 task를 호출해 바이트 단위로 동일한 결과를 받는지, (2) 두 install script가 바이트 단위로 동일한 `SKILL.md`를 배포하는지로 "Codex와 Claude가 동일한 task를 읽는다"는 요구를 양쪽에서 근접 검증했다.

## 9. Phase 6 — Review loop와 안정화

### 목표

구현 후 같은 작업을 검토하고 추가 revision을 만들 수 있다.

### 작업

- [x] 기존 task에서 review session 열기
- [x] 구현 후 screenshot 캡처
- [x] before/after view (annotator-core store가 마련해두는 before(원본 frame)와 after(revision frame)를 각각 독립 frame으로 저장; 별도 UI 컴포넌트는 아직 없음)
- [x] review에서 새 annotation revision 생성
- [x] revision history와 parent task 연결
- [x] accept/done 흐름
- [x] 동일 환경 screenshot diff 옵션
- [x] task 삭제 및 retention 정책
- [x] 진단 bundle과 debug log redaction

### 완료 조건

- 하나의 task가 implementation → review → revision → done을 거친다.
- 이전 이미지와 지시는 변경되지 않고 보존된다.

### Phase 6 실행 결과 (2026-09-01)

`packages/review/src/`(screenshot diff, revision, retention, diagnostics)와 `apps/cli/src/application/service.ts`의 revision-aware submit에 구현. `pnpm --filter @redpen/review run test` 19/19 통과, `pnpm --filter @redpen/cli run test:review-loop`(실제 CLI 자식 프로세스로 전체 완료 조건 스크립트 실행) 11/11 통과, `tsc --noEmit` clean.

- `@redpen/protocol`의 `VisualTask`에 `parentTaskId?: string`을 추가(하위 호환 optional 필드) — revision이 원본 task를 가리키는 연결.
- `review/revision.ts`: `createRevision()`은 parent task를 절대 mutate하지 않고 완전히 새로운 `VisualTask`(revision 번호 +1, `parentTaskId`=parent.id, 새 frame)를 만든다. `resolveRevisionChain()`은 parentTaskId를 따라가며 oldest-first로 revision history를 복원, 중간에 삭제된 parent를 만나면 조용히 멈춘다.
- `application/service.ts`의 `submit()`: session에 이미 `activeTaskId`가 있으면(= review 상태에서 다시 freeze한 뒤 제출하는 것) `createRevision`으로 revision bundle을 쓰고, 없으면 기존처럼 `assembleVisualTask`로 최초 task를 만든다. `freeze()`는 세션이 `review` 상태일 때 `annotate-revision` 전이를, 그 외에는 기존 `freeze` 전이를 선택한다.
- `review/screenshot-diff.ts`: `pixelmatch`+`pngjs`로 동일 크기 PNG 두 장을 비교해 `diffPixelCount`/`diffRatio`/diff PNG를 반환. 크기가 다르면 pixelmatch의 불명확한 예외 대신 `DimensionMismatchError`를 명시적으로 던진다. docs/ARCHITECTURE.md §11이 지적한 "동일 환경에서만 의미있다"는 제약을 그대로 문서화.
- `review/retention.ts`: `done`/`cancelled` 상태이고 `maxAgeMs`보다 오래된 task만 삭제 후보. 어떤 task가 다른 task의 `parentTaskId`로 여전히 참조되고 있으면(= revision chain의 조상) 나이와 무관하게 삭제 대상에서 제외.
- `review/diagnostics.ts`: `password`/`token`/`secret`/`cookie`/`authorization`/`apiKey` 계열 키를 재귀적으로(중첩 객체 포함) `[REDACTED]`로 치환하는 진단 bundle 빌더.
- 완료 조건 검증(`review-loop-check.ts`, 실제 `redpen` CLI 자식 프로세스 구동): open→freeze→submit(v0, revision 0)→claim(working)→review→freeze(annotate-revision, review→annotating)→submit(v1, revision 1, parentTaskId=v0)→claim→review→accept(done) 전체 스크립트가 성공하고, v1 제출 및 accept 이후에도 v0 task.json이 **바이트 단위로 동일**함을 직접 비교해 확인 — "이전 이미지와 지시는 변경되지 않고 보존된다"는 완료 조건을 가장 엄격한 형태로 검증했다.

**미해결 항목**: before/after를 나란히 보여주는 실제 UI 컴포넌트, screenshot diff를 daemon/CLI 명령으로 노출하는 것(`redpen diff` 같은 명령), retention 정책의 실제 스케줄러(cron 등)는 구현하지 않았다 — 이번 phase는 각 기능의 핵심 로직과 데이터 모델을 완성하고 CLI를 통해 전체 lifecycle을 증명하는 데 집중했다.

## 10. 테스트 전략

### Unit

- protocol validation
- state transition
- geometry와 intersection
- color/group allocation
- redaction
- path resolution
- atomic storage

### Integration

- daemon API와 session store
- Playwright screenshot + DOM index
- canvas export adapter
- CLI JSON contract
- MCP tool → application core

### E2E

결정론적 fixture frontend를 사용한다.

- static layout
- scroll page
- modal/dropdown state
- flex/grid/absolute layout
- form input과 password
- icon-only buttons
- responsive viewport

Golden E2E:

1. CLI로 fixture URL을 연다.
2. 화면을 고정한다.
3. synthetic 또는 실제 UI event로 세 instruction group을 작성한다.
4. 제출한다.
5. bundle을 검증한다.
6. MCP로 같은 task를 읽는다.
7. review revision을 만든다.

### Manual usability

- 문서를 보지 않은 사용자가 3분 안에 첫 task 제출
- “버튼 이동”, “요소 삭제”, “새 표 sketch” 세 시나리오
- 사용자에게 selector나 CSS 값을 묻지 않는지 관찰

## 11. 주요 위험과 대응

| 위험 | 영향 | 초기 대응 |
|---|---|---|
| Managed browser 사용 마찰 | 기존 browser와 session 분리 | 전용 persistent profile, extension은 후속 ADR |
| Page injection 충돌 | 앱 UI/shortcut 방해 | Shadow DOM, 최소 control, 별도 annotation tab |
| Screenshot/DOM 좌표 불일치 | 잘못된 target | 같은 capture transaction, CSS/normalized 좌표 이중 저장 |
| tldraw schema 종속 | task format lock-in | adapter와 자체 Mark schema |
| 색 구분 실패 | 그룹 혼동 | 번호 badge를 canonical visual key로 병행 |
| DOM metadata 과수집 | 민감정보 저장 | memory index 후 selected target만 persist, input redaction |
| MCP host timeout | agent 흐름 중단 | wait와 get 분리, session persistence |
| Remote agent localhost 차이 | 페이지를 사용자에게 못 보여줌 | MVP local-only 명시, tunnel/extension 후속 |
| 자유 그림 해석 모호성 | 잘못된 구현 | group note, text tool, DOM target, ambiguity reporting |

## 12. 우선순위와 예상 작업 단위

구현 agent는 한 turn/PR에 하나의 vertical slice를 완료한다.

1. `spike/browser-capture`
2. `protocol/session-core`
3. `annotator/group-model`
4. `annotator/tools-export`
5. `grounding/visible-dom`
6. `storage/task-bundle`
7. `cli/session-lifecycle`
8. `mcp/adapter`
9. `skills/codex-claude`
10. `review/revisions`

각 slice는 test와 문서 갱신을 포함하며, 다음 slice가 이전 slice의 내부 구현을 직접 우회하지 않는다.

## 13. 구현 시작 전 확정할 항목

다음 항목은 Phase 0에서 확인하며 전체 계획을 막지 않는다.

- package manager와 최소 Node version
- tldraw 최종 채택 여부
- daemon notification에 WebSocket과 SSE 중 무엇을 사용할지
- OS application data path library
- default viewport와 palette
- `redpen` npm package/binary 이름 사용 가능 여부

## 14. 첫 구현 요청 예시

Codex CLI 또는 Claude Code에 다음처럼 시작할 수 있다.

```text
README.md와 docs/PRODUCT_INTENT.md, docs/ARCHITECTURE.md,
docs/IMPLEMENTATION_PLAN.md를 전부 읽어라.

아직 제품 기능을 넓게 구현하지 말고 Phase 0 capture spike만 수행하라.
완료 조건을 테스트로 검증하고, 발견한 제약과 tldraw 채택 판단을
docs/IMPLEMENTATION_PLAN.md에 기록하라.
```

