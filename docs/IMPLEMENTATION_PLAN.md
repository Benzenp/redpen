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

- [ ] screenshot을 잠긴 background로 렌더링
- [ ] pan/zoom 및 viewport fit
- [ ] `#1` 기본 group 자동 생성
- [ ] 고대비 color palette와 group number badge
- [ ] group card 선택 시 active drawing group 전환
- [ ] freehand, arrow, rectangle, ellipse, text, mask
- [ ] select/move/delete, undo/redo
- [ ] global note
- [ ] group별 optional note
- [ ] disconnected mark cluster마다 group badge 표시
- [ ] `새 지시` 및 `N개 지시 제출`
- [ ] 빈 group 경고
- [ ] vendor canvas state → Redpen Mark schema adapter
- [ ] `overlay.svg`와 `annotated.png` export

### UX acceptance scenarios

- [ ] 한 색으로 원과 화살표를 여러 개 그려 모두 `#1`에 연결한다.
- [ ] `#2`로 직접 3열 표를 그리고 sidebar 설명을 추가한다.
- [ ] `#3` mask로 기존 요소를 가리고 새 버튼을 그린다.
- [ ] 그룹을 오가며 수정해도 기존 mark의 group이 바뀌지 않는다.
- [ ] 색을 구분하기 어려워도 번호만으로 모든 연결을 이해할 수 있다.

### 완료 조건

- 세 그룹과 열 개 이상의 mark가 있는 작업을 제출하고 다시 열었을 때 동일하게 보인다.
- export 이미지와 vector JSON의 group/geometry가 일치한다.

## 6. Phase 3 — DOM grounding과 task bundle

### 목표

표시된 요구사항을 캡처 시점의 DOM 문맥에 자동 연결한다.

### 작업

- [ ] visible DOM candidate collector
- [ ] 민감 attribute/value redaction
- [ ] role/accessibility name/text summary 추출
- [ ] selector hint 생성: test ID → stable ID → role/name → structural hint 순서
- [ ] rect intersection 및 containment scoring
- [ ] freehand path proximity scoring
- [ ] arrow source/destination grounding
- [ ] nearest container fallback
- [ ] parent/sibling summary
- [ ] computed layout allowlist
- [ ] group별 target ranking과 중복 제거
- [ ] temporary full index 폐기
- [ ] task.md human summary 생성
- [ ] source/overlay/annotated/task JSON bundle 작성

### 정확도 원칙

- selector hint는 실행 가능한 selector임을 보장하지 않는다. 코드 탐색 단서다.
- 여러 후보가 비슷하면 하나를 확정하지 않고 ranking을 보존한다.
- DOM target이 없어도 제출을 실패시키지 않는다.
- image와 user note가 canonical intent이며 DOM은 grounding hint다.

### 테스트

- [ ] flex/grid/absolute layout fixture
- [ ] nested interactive element
- [ ] text 없는 icon button
- [ ] scroll offset
- [ ] device scale factor
- [ ] blank area sketch
- [ ] password/input value redaction
- [ ] DOM mutation 직전/직후 capture consistency

### 완료 조건

- fixture acceptance set에서 표시된 대상이 top candidates 안에 포함된다.
- task bundle에 금지된 input value, cookie, storage data가 없다.

## 7. Phase 4 — CLI lifecycle

### 목표

사람과 coding agent가 CLI만으로 전체 세션을 제어한다.

### 작업

- [ ] `redpen daemon start|stop|status`
- [ ] daemon auto-discovery/auto-start
- [ ] `redpen open`
- [ ] `redpen list/status/show/close`
- [ ] `redpen wait` long poll 및 timeout recovery
- [ ] `redpen review`
- [ ] 모든 명령의 `--json` mode
- [ ] stdout/stderr 분리
- [ ] stable exit code 표
- [ ] stale PID/port/token recovery
- [ ] Ctrl+C와 abnormal exit cleanup
- [ ] npm package의 `bin` entry

### CLI contract test

- [ ] JSON stdout이 log로 오염되지 않는다.
- [ ] daemon이 없을 때 `open`이 자동 시작한다.
- [ ] wait timeout 후 session이 유지된다.
- [ ] 두 workspace의 session/task가 섞이지 않는다.
- [ ] 종료된 task를 session ID로 다시 찾을 수 있다.

### 완료 조건

다음 script가 수동 파일 편집 없이 성공한다.

```text
open → status → user submit → wait returns task → update working → review → done
```

## 8. Phase 5 — MCP와 Agent Skill

### 목표

Codex 및 Claude가 자연어 요청에서 Redpen 세션을 열고 제출된 작업을 읽는다.

### 작업

- [ ] MCP stdio server entrypoint
- [ ] session start/wait/get/update/review/cancel tools
- [ ] tool input/output schema를 protocol DTO와 공유
- [ ] long-running wait timeout/cancellation 처리
- [ ] task asset path와 compact summary 반환
- [ ] 공용 Agent Skills 표준에 맞는 `SKILL.md`
- [ ] Codex 설치 script
- [ ] Claude 설치 script
- [ ] 두 host의 명령/설정 예제
- [ ] “plan only” 기본 규칙

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

## 9. Phase 6 — Review loop와 안정화

### 목표

구현 후 같은 작업을 검토하고 추가 revision을 만들 수 있다.

### 작업

- [ ] 기존 task에서 review session 열기
- [ ] 구현 후 screenshot 캡처
- [ ] before/after view
- [ ] review에서 새 annotation revision 생성
- [ ] revision history와 parent task 연결
- [ ] accept/done 흐름
- [ ] 동일 환경 screenshot diff 옵션
- [ ] task 삭제 및 retention 정책
- [ ] 진단 bundle과 debug log redaction

### 완료 조건

- 하나의 task가 implementation → review → revision → done을 거친다.
- 이전 이미지와 지시는 변경되지 않고 보존된다.

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

