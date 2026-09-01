# Redpen Session UX Functional Design

관련 PRD: `docs/RedpenSessionUx PRD.md`

## 1. 연결 재시도

`apps/cli/src/browser/manager.ts`의 `BrowserManager.gotoWithRetry(page, url, attempts = 5, delayMs = 500)`:

- `page.goto(url, { waitUntil: 'load' })`를 시도.
- 에러 메시지에 `ERR_CONNECTION_REFUSED` 또는 `ECONNREFUSED`가 포함되면 `delayMs` 대기 후 재시도.
- 그 외 에러는 즉시 throw (재시도하지 않음).
- `attempts`회 모두 실패하면 마지막 에러를 throw — 호출부(`RedpenApplicationService.openSession`)의 기존 catch가 세션을 `error` 상태로 표시하는 동작은 그대로 유지된다.
- `openPage`/`openAnnotatorTab` 양쪽 다 이 헬퍼를 통해 이동한다.

## 2. Freeze 오버레이

### 주입 방식

`FREEZE_OVERLAY_SCRIPT_SOURCE`(문자열 상수, `apps/cli/src/browser/manager.ts`)는 `(function(origin) { ... })` 형태의 순수 JS IIFE 소스다. **함수 값이 아니라 문자열로 정의한 이유**:

- esbuild/tsx가 TS 파일을 컴파일할 때 named function에 `__name(fn, "fn")` 헬퍼 호출을 주입한다. `page.addInitScript(fn, arg)`처럼 함수를 넘기면 Playwright가 `fn.toString()`으로 소스를 추출해 브라우저 컨텍스트에서 단독 평가하는데, 그 컨텍스트에는 `__name` 헬퍼가 없어 `ReferenceError: __name is not defined`가 발생하고 오버레이 설치 자체가 조용히 실패한다. 이 문제는 이전 Phase 0 capture spike에서도 동일하게 발견되어 `docs/IMPLEMENTATION_PLAN.md`에 기록되어 있었다.
- 순수 문자열로 작성하면 tsx/esbuild의 변환 대상이 아니므로 이 문제가 원천적으로 발생하지 않는다.

`openPage`에서의 주입:

```ts
await page.addInitScript(`(${FREEZE_OVERLAY_SCRIPT_SOURCE})(${JSON.stringify(overlayOrigin)});`);
```

- Playwright의 문자열 폼 `addInitScript(script)`는 `script` 하나만 받고 별도 `arg` 파라미터를 지원하지 않는다(`addInitScript(script, arg)`를 문자열과 함께 쓰면 "Cannot evaluate a string with arguments" 예외). 그래서 `origin`(daemon 포트/토큰)을 `JSON.stringify`로 직렬화해 소스 문자열에 직접 인라인하고, 즉시실행 호출부까지 하나의 문자열로 합쳐서 넘긴다.
- `addInitScript`는 매 네비게이션/리로드마다 다시 실행되므로 페이지가 새로고침돼도 버튼이 다시 나타난다.

### 오버레이 동작

- `install()`: `document.readyState`가 `loading`이면 `DOMContentLoaded`까지 대기 후 버튼/스타일 삽입. 중복 설치 방지(`getElementById` 가드).
- 버튼 클릭 또는 `keydown`에서 `event.key === 'F9'`: `triggerFreeze()` 호출.
- `triggerFreeze()`: `sessionId`가 아직 설정 안 됐으면(=주입 스크립트가 페이지 로드보다 먼저 실행돼 `openPage`의 `__redpenSetSessionId` 호출이 아직 안 왔으면) 에러 토스트. 아니면 버튼을 비활성화하고 `fetch(.../sessions/:id/freeze?token=...)` POST, 응답에 따라 토스트 표시, 성공 시 `pollForSubmission()` 시작.
- `pollForSubmission()`: 1.5초 간격 `setInterval`로 `GET /sessions/:id?token=...`를 호출해 `session.state`를 확인. `submitted`가 되면 인터벌을 멈추고 taskId를 포함한 성공 토스트를 표시. `annotating`이 아닌 다른 상태(예: `cancelled`)로 바뀌어도 폴링을 멈춘다.
- `sessionId`는 `window.__redpenSetSessionId(id)`로 외부에서 주입된다. `openPage`가 `gotoWithRetry` 완료 직후 `page.evaluate`로 이 함수를 호출한다.

### daemon 서버 쪽 CORS/인증 확장 (`apps/cli/src/daemon/server.ts`)

- 오버레이는 타겟 페이지의 origin(예: `http://127.0.0.1:5173`)에서 daemon 자신의 origin(별도 랜덤 포트)으로 요청을 보낸다. `Authorization` 헤더를 크로스 오리진 `<script>`/`fetch` 컨텍스트에서 자유롭게 붙일 수는 있으나, 프리플라이트 없는 simple request로 유지하기 위해 헤더 대신 쿼리 파라미터 토큰(`?token=...`)을 인증 수단으로 허용한다.
- 새로 쿼리 토큰을 받는 라우트: `POST /sessions/:id/freeze`(`isOverlayFreezeRoute`), `GET /sessions/:id`(`isOverlayStatusRoute`). 기존 annotator 탭 라우트(`isBrowserTabRoute`)와 동일한 신뢰 모델(loopback-only daemon, 토큰 필수)을 공유한다.
- 이 두 라우트의 응답에 `Access-Control-Allow-Origin: *`를 설정한다. 다른 라우트는 변경 없음(Authorization 헤더만 허용).

## 3. 캡처 화질

`BrowserManager.ensureContext()`의 `launchPersistentContext` 옵션에 `deviceScaleFactor: 2` 추가. `viewport`는 CSS 픽셀 기준(1280×900)으로 그대로 유지되며, 실제 캡처되는 PNG는 내부적으로 2배 픽셀로 렌더링된다. daemon이 세션/task에 기록하는 `viewport.deviceScaleFactor`는 `domIndex.viewport.deviceScaleFactor`(Playwright가 `window.devicePixelRatio`로 읽은 값)를 그대로 쓰므로 별도 수정 불필요 — Playwright가 이미 2를 반영해서 보고한다.

## 4. 제출 피드백 + 자동 탭 닫힘

### 어노테이션 UI (`apps/annotator/public/session.html`)

- `#submit-overlay`: `position: fixed; inset: 0` 반투명 배경 위의 Win 3.1 모달 대화상자(`.dialog`) — 체크마크 아이콘 + "제출 완료" + sunken 필드의 taskId + 안내 문구. 기본 `hidden`, `hidden` 해제로 표시(§10).
- 제출 버튼 핸들러가 `app.submit()` 성공 후 `showSubmitOverlayAndClose(result.taskId)` 호출.
- `showSubmitOverlayAndClose`: 오버레이에 taskId 채우고 `hidden`을 해제, 1.6초 후 `window.close()`. 스크립트가 열지 않은 탭에서 `window.close()`가 브라우저 정책상 no-op이 될 수 있음을 인지하고 있으나, Redpen이 여는 탭은 `context.newPage()` + `page.goto()`로 스크립트가 직접 연 탭이므로 이 경로에서는 정상 동작.

### 타겟 페이지 쪽 (`pollForSubmission`, 위 2번 참고)

어노테이션 탭이 자동으로 닫힌 뒤에도 사용자가 보고 있던 원래 페이지에 완료 토스트가 남아, "제출은 됐는데 탭만 사라지고 아무 신호가 없다"는 상황을 방지한다.

## 5. 에이전트 워크플로 (코드 변경 없음)

기존에 이미 존재하는 `redpen wait <session-id> --timeout <N>` / MCP `redpen_wait_for_submission`을 세션을 연 직후, freeze 안내와 동시에 선제적으로 호출해 둔다. 사용자의 "제출했다"는 보고를 기다리지 않고 `wait`가 resolve되는 즉시 `taskId`를 받아 `redpen task <taskId>`로 조회 → 계획 제시로 이어간다. 이건 순전히 호출 순서 문제였고 새 기능이 아니다.

### 의도 확인 게이트

제출은 시각 지시 전달 완료일 뿐 구현 승인으로 취급하지 않는다. 에이전트는
task bundle을 읽은 직후 각 Instruction Group을 “제가 이해한 변경은 …” 형식으로
요약하고 사용자 확인을 기다린다. 확인 전에는 `claim`/`working` 전환과 제품 코드
수정을 금지한다. 사용자가 확인하거나 해석을 정정하면 그때 한 번만 `claim`하고
구현한다.

제출 직후에는 어노테이션 탭만 닫고 타겟 페이지를 유지한다. 구현 완료 후
`review-ready` 처리 시 `BrowserManager.reloadPage(sessionId)`가 기존 타겟 페이지를
새로고침하고 앞으로 가져온다. 따라서 사용자는 구현 중에도 원본 페이지를 볼 수
있고, 리뷰 시작 순간 별도 조작 없이 최신 결과를 확인한다.

### 모달 열린 상태의 freeze와 grounding

native `<dialog>.showModal()`은 브라우저 top layer에 올라가므로 일반 fixed
요소는 최대 `z-index`를 사용해도 그 위에 표시되지 않는다. 주입 스크립트는
`dialog[open]:modal` 또는 `[aria-modal="true"]`를 감지해 freeze 버튼과 토스트를
해당 모달의 자식으로 이동한다. `MutationObserver`가 모달의 open/close를 감시하며,
닫히면 요소를 다시 `document.documentElement`로 복귀시킨다.

DOM collector도 같은 활성 모달을 기준으로 후보를 제한한다. 모달 자신과 자식은
수집하지만 backdrop에 가려진 페이지 요소는 후보에서 제외하므로, 동일 좌표의
배경 테이블 행 등이 modal input보다 함께 grounding되는 오류를 방지한다.

## 6. 검증

- `REDPEN_HEADLESS=1`로 `lifecycle-check.ts`, `review-loop-check.ts`, `daemon-lifecycle-check.ts`, `ui-e2e-check.ts` 4종 전부 재실행, ALL CHECKS PASSED.
- 별도 스크립트로 headed 모드에서 실제 페이지에 "Freeze screen (F9)" 버튼이 렌더링되는 것을 Playwright 스크린샷으로 확인.
- `.redpen/tasks/<id>/frames/frame-001/source.png`의 PNG IHDR 픽셀 크기를 직접 읽어 2530×2438(2x)임을 확인.

## 7. 어노테이션 탭 자동 닫힘 버그 수정 (사후 발견)

### 증상

실사용 중 `session.html`의 "제출 완료" 오버레이는 뜨지만 탭이 영원히 닫히지 않는 현상이 재현됨.

### 근본 원인

`showSubmitOverlayAndClose()`(`apps/annotator/public/session.html`)가 `window.close()`를 호출하지만, 이 탭은 daemon이 Playwright `context.newPage()` + `page.goto()`로 연 탭이라 브라우저가 "스크립트가 연 탭"으로 인식하지 않는다. 대부분의 브라우저는 스크립트가 열지 않은 탭에서의 `window.close()`를 조용히 no-op 처리한다 — 원래 코드 주석에도 이 위험이 명시돼 있었지만 실사용에서 실제로 발생했다.

### 수정

클라이언트 JS의 `window.close()`에 의존하는 대신, daemon이 서버사이드에서 Playwright API로 탭을 직접 닫도록 변경했다.

- `BrowserManager.closeAnnotatorPage(sessionId)` (`apps/cli/src/browser/manager.ts`): 세션의 어노테이터 탭만 `page.close()`로 닫고 내부 map에서 제거. 대상 페이지(target page)와 그 freeze 오버레이는 건드리지 않는다.
- `RedpenApplicationService.closeAnnotatorTab(sessionId)` (`apps/cli/src/application/service.ts`): 위 메서드로 위임하는 얇은 서비스 메서드. `submit()` 내부에서 직접 호출하지 않는다 — 이유는 아래 "타이밍 함정" 참고.
- daemon 라우트 두 곳에서 이 메서드를 호출한다(`apps/cli/src/daemon/server.ts`):
  - `POST /sessions/:id/submit` (CLI/MCP가 호출하는 라우트): 호출자가 어노테이션 탭 자신이 아니므로 응답 전송 직후 동기적으로 `closeAnnotatorTab`을 호출해도 안전하다.
  - `POST /api/sessions/:id/annotator/submit` (어노테이션 탭 자신의 `app.submit()`이 호출하는 라우트): 이 라우트가 바로 문제의 근원이다. 아래 참고.

### 타이밍 함정: 응답 전송 전에 탭을 닫으면 안 되는 이유

최초 수정 시도는 `RedpenApplicationService.submit()` 안에서 task 저장 직후 곧바로 `closeAnnotatorPage`를 호출했다. 이 상태로 `ui-e2e-check.ts`를 재실행하자 `#submit-status`에 "제출 완료"가 절대 나타나지 않고 5초 타임아웃으로 실패했다.

원인: `/api/sessions/:id/annotator/submit` 요청을 보내는 주체가 바로 그 어노테이션 탭 자신의 `fetch()`다. `submit()` 안에서 응답을 만들기도 전에 `page.close()`를 호출하면, 그 fetch가 실행 중이던 탭 자체(및 그 안의 JS 실행 컨텍스트, 네트워크 스택)가 파괴되어 응답을 절대 받을 수 없게 되고 `app.submit()` 프라미스가 영원히 pending 상태로 남는다. 즉 탭을 살리려던 수정이 오히려 제출 자체를 깨뜨렸다.

해결: 데몬의 `POST /api/sessions/:id/annotator/submit` 핸들러에서 `send(200, ...)`으로 응답을 큐에 넣은 **다음**, `setTimeout(() => service.closeAnnotatorTab(sessionId), 300)`으로 탭 닫기를 다음 매크로태스크로 지연시켰다. 300ms는 `res.end()`가 실제로 소켓에 flush될 시간을 확보하기 위한 여유다. `POST /sessions/:id/submit`(CLI 경로)은 호출자가 다른 프로세스이므로 이 함정이 없어 동기 호출을 유지한다.

### 검증

- 기존 4종 자동 체크(`lifecycle-check`, `review-loop-check`, `daemon-lifecycle-check`, `ui-e2e-check`) 전부 재실행, ALL CHECKS PASSED — 특히 `ui-e2e-check`의 `real-ui-submit-button-completes-and-shows-task-id`가 회귀 없이 통과함을 확인(수정 전 버전으로는 이 체크가 5초 타임아웃으로 실패했었음).
- 별도의 임시 검증 스크립트(`startDaemon()`을 in-process로 구동)로 실제 daemon+Playwright 경로를 재현: open → freeze → mark 추가 → `POST /api/sessions/:id/annotator/submit` 호출 결과, (1) 호출자가 `200`과 `taskId`를 정상 수신했고(=응답이 hang되지 않음), (2) 그 직후 해당 세션의 annotator `Page.isClosed()`가 `true`로 바뀜을 실측 확인. 검증 스크립트와 확인용 디버그 로그는 커밋 전 제거했다.

## 8. 과거 설계: 픽셀 편집 마크 (crop+move, 캔버스 이미지)

> 이 절의 `image` 마크/드롭다운/캔버스 배치 설계는 §9로 대체되었다.
> `patch` 설계와 로컬 reference 저장소 설명만 현재 유효하다.

관련 PRD: `docs/RedpenSessionUx PRD.md` §8.

### 스키마 (`packages/protocol/src/schema.ts`)

`markBaseSchema`(`id`, `frameId`, `groupId`, `bounds`, `normalizedBounds`)를 그대로 확장한 두 신규 타입을 `markSchema`의 discriminated union에 추가했다(6종 → 8종):

```ts
export const patchMarkSchema = markBaseSchema.extend({
  type: z.literal('patch'),
  sourceRect: rectSchema, // 원본에서 잘라올 영역. bounds/normalizedBounds는 목적지(destRect)로 재사용한다.
});

export const imageMarkSchema = markBaseSchema.extend({
  type: z.literal('image'),
  assetRef: z.string().min(1), // .redpen/references/index.json에 등록된 레퍼런스 id
});
```

새 `destRect` 필드를 만들지 않고 기존 `bounds`를 목적지로 재사용한 이유: 모든 마크 타입이 이미 `bounds`를 "이 마크가 화면에서 차지하는 영역"으로 취급하므로, DOM grounding(`packages/grounding/src/ground.ts`)이나 badge 클러스터링(`packages/annotator-core/src/store.ts`)처럼 `bounds`에만 의존하는 기존 로직을 patch/image에도 그대로 재사용할 수 있다.

### DOM grounding (`packages/grounding/src/ground.ts`)

`scoreCandidatesForMark`의 스위치문에 `patch`/`image`를 `rectangle`/`ellipse`/`mask`와 같은 그룹으로 추가했다 — 전부 `scoreByOverlap(mark.bounds, ...)`로 목적지 사각형과 DOM 후보의 bbox 교집합을 채점한다.

### 픽셀 합성 (`packages/annotator-core/src/composite.ts`, 신규)

`compositeMarksOntoScreenshot(screenshotPng, marks, assetImages)`:

- `pngjs`로 스크린샷 PNG를 디코드하고, 마크를 배열 순서대로 순회하며 픽셀을 직접 조작한다.
- `patch`: `sourceRect` 영역을 nearest-neighbor 샘플링으로 `bounds`(목적지) 크기에 맞춰 복사한다. 자기 자신의 출력 영역과 소스 영역이 겹칠 수 있으므로(예: 살짝 옆으로 옮기는 patch), 쓰기 전에 원본 픽셀을 별도 버퍼로 스냅샷해서 읽기가 이미 쓴 픽셀을 다시 읽는 오염을 방지한다.
- `image`: `assetImages` 맵(`assetRef` → PNG 버퍼)에서 조회한 이미지를 `bounds` 위치/크기로 복사한다. 맵에 없는 `assetRef`(레퍼런스가 삭제된 경우 등)는 조용히 스킵한다 — throw하지 않는다.
- 이 함수는 **디바이스 픽셀 좌표**를 받는다. 마크는 CSS 픽셀로 저장되므로, 호출자(`RedpenApplicationService.compositeAnnotatedScreenshot`)가 `deviceScaleFactor`를 곱해 스케일링한 뒤 넘긴다.
- `pngjs`가 Node 빌트인(`zlib`/`stream`/`util`/`buffer`/`assert`)에 의존하므로, `packages/annotator-core/src/index.ts` 배럴에서 `composite.ts`를 재-export하지 않고 `@redpen/annotator-core/composite` subpath export로만 노출한다 — 그렇지 않으면 브라우저 번들(`apps/annotator/src/client.ts`가 배럴을 통째로 import)이 esbuild 빌드 시 이 Node 빌트인들을 해석하지 못해 깨진다. `apps/cli`(daemon, Node 환경)만 이 subpath를 사용한다.

### 제출 시 합성 연결 (`apps/cli/src/application/service.ts`)

`submit()`이 `writeTaskBundle`을 호출하기 전에 `compositeAnnotatedScreenshot(workspaceRoot, capture.screenshot, deviceScaleFactor, marks)`를 호출해 `annotated.png`용 버퍼를 만든다:

- `patch`/`image` 마크가 하나도 없으면 원본 스크린샷을 그대로 반환한다(불필요한 디코드/인코드 스킵).
- 있으면 모든 마크의 `bounds`(및 `patch`의 `sourceRect`)를 `deviceScaleFactor`로 스케일링해 디바이스 픽셀로 변환한다.
- `image` 마크가 참조하는 모든 `assetRef`에 대해 `readReferenceImage(workspaceRoot, ref)`로 실제 PNG 바이트를 미리 로드한다. 로드 실패(파일 삭제됨 등)는 조용히 무시하고 그 자산은 합성에서 스킵된다.
- 결과 버퍼가 `frames/frame-001/annotated.png`로 저장된다. `source.png`는 항상 원본 그대로 유지된다 — "before/after" 비교가 가능하다.

### 레퍼런스 이미지 라이브러리 (`packages/protocol/src/references.ts`, 신규)

DB 없이 워크스페이스 폴더에 영구 저장한다:

- `<workspaceRoot>/.redpen/references/<id>.png` — 원본 PNG 바이트.
- `<workspaceRoot>/.redpen/references/index.json` — `ReferenceImageMeta[]`(`id`, `fileName`, `width`, `height`, `createdAt`, 선택적 `label`) 배열. 매 저장마다 전체를 읽어 append 후 다시 쓴다(단일 사용자 로컬 도구라 원자적 쓰기 불필요).
- `saveReferenceImage`/`listReferenceImages`/`readReferenceImage` 세 함수만 노출. id는 `generateReferenceId()`(`ref_` + ULID, `packages/protocol/src/ids.ts`)로 생성하고 `assertSafeIdSegment`로 경로 트래버설을 방어한다.

### daemon API (`apps/cli/src/daemon/server.ts`)

`/api/sessions/:id/annotator/*` 하위에 3개 라우트 추가, 기존 라우트들과 동일한 Bearer 토큰 인증을 그대로 따른다(쿼리 토큰 예외 없음 — 이 라우트들은 브라우저 탭의 최상위 네비게이션이 아니라 그 탭 자신의 `fetch()`가 호출하므로 Authorization 헤더를 정상적으로 붙일 수 있다):

- `POST .../references` — body `{ pngBase64, label? }`. `RedpenApplicationService.saveReferenceImage`가 base64를 디코드하고 `pngjs`로 width/height를 읽어 `references.ts`에 위임 저장한다.
- `GET .../references` — 세션의 workspaceRoot 기준 레퍼런스 목록 반환.
- `GET .../references/:refId` — 해당 레퍼런스의 원본 PNG 바이트를 `image/png`로 반환.

### 어노테이션 UI (`apps/annotator/src/session-client.ts`, `apps/annotator/public/session.html`)

`V` Select/Move를 기본 도구로 사용한다. `patch`는 task schema의 픽셀 이동
마크로 계속 유지하지만 전용 툴과 `C` 단축키는 제거했다.

**Select/Move 통합 patch 흐름**:

1. 빈 스크린샷 영역을 드래그했는데 활성 그룹 mark와 겹치지 않으면 서버에
   저장하지 않는 영역 selection을 만든다.
2. 그 영역을 드래그하면 `sourceRect`를 원본으로, 이동된 bounds를 목적지로 하는
   `patch` 마크를 한 번에 커밋한다.
3. 생성된 patch는 자동 선택되며 일반 mark처럼 이동, 모서리 resize, Delete,
   undo/redo가 가능하다. 기존 patch의 이동/resize는 목적지 bounds만 바꾸며
   `sourceRect`는 바꾸지 않는다.
4. Shift+resize는 기존 목적지 비율을 유지한다. selection과 resize handle은
   UI 상태이며 task schema에는 저장하지 않는다.

일반 mark도 같은 Select/Move에서 click, Shift+click, marquee, multi-move,
corner resize, batch Delete와 그룹 재지정을 지원한다. 한 gesture는 완전한 mark
배열을 원자적으로 갱신하며 undo history 한 항목만 만든다.

레퍼런스 이미지는 canvas mark가 아니다. 붙여넣기/drag-drop한 이미지는 현재
Instruction Group의 `referenceIds`에 즉시 귀속되고 sidebar thumbnail로만 보인다.

### overlay.svg (`packages/annotator-core/src/export-svg.ts`)

- `patch`: 목적지 사각형(`<rect>`) + 원본 중심점에서 목적지 중심점으로 향하는 점선 화살표(`stroke-dasharray`) — 실제 픽셀이 아니라 "어디서 어디로 옮겼는지"를 벡터로 요약하는 참고용 표시.
- `mask`: mark별 `opacity` 값을 `fill-opacity`로 내보낸다.

### 검증

- `store.test.ts`는 batch update/reassign/delete, immutable undo snapshot, 빈 그룹
  삭제와 단조 증가 그룹 번호, mask opacity를 검증한다.
- `ui-e2e-check.ts`는 실제 browser/API에서 Select/Move, modifier, text, pen,
  mask, 그룹 focus와 retro chrome을 검증한다.
- `patch-reference-e2e-check.ts`는 빈 영역 selection → patch 이동과 그룹별
  reference 제출, task bundle PNG/SVG 결과를 함께 검증한다.

## 9. 현재 설계: 그룹 레퍼런스, 직선, 영역 텍스트

### 그룹 레퍼런스

- `InstructionGroup.referenceIds`는 중복 없는 최대 3개의 reference ID를 가진다.
- 각 그룹 카드의 reference zone은 활성 그룹의 이미지 붙여넣기와 해당 카드로의
  다중 drag/drop을 받는다. 이미지는 썸네일로만 표시하며 캔버스에는 그리지 않는다.
- 업로드는 `POST .../groups/:groupId/references`, 제거는
  `DELETE .../groups/:groupId/references/:referenceId`를 사용한다.
- 제출 시 연결된 이미지만 task의 `references/`에 복사하고
  `VisualTask.references`에 metadata/path를 기록한다. 따라서 task bundle만으로
  그룹의 그림, 설명, 레퍼런스를 함께 읽을 수 있다.

### 직선과 영역 텍스트

- `line` 마크는 arrow와 같은 `from`/`to` 좌표를 사용하지만 화살촉 없이 그룹
  색상의 직선으로 렌더링한다.
- text 도구는 prompt를 사용하지 않는다. 캔버스를 드래그해 bounds를 만들면
  같은 위치에 textarea가 열리고, Ctrl/Cmd+Enter 또는 blur로 커밋하며 Escape로
  취소한다.
- text는 그룹 색상을 사용하고 bounds 내부에서 줄바꿈·클리핑한다. canvas와
  `overlay.svg` 모두 같은 영역 의미를 보존한다.

### 검증

- `patch-reference-e2e-check.ts`: patch 이동, 클립보드 1장, 다중 drop 2장,
  그룹 3장 제한, self-contained task reference 파일을 검증한다.
- `ui-e2e-check.ts`: line mark와 bounded/group-colored text 입력을 실제
  pointer/keyboard 이벤트로 검증한다.

## 10. 현재 설계: 세션 UI 셸 (Win 3.1 Paintbrush 크롬)

디자인 레퍼런스는 Windows 3.1 Paintbrush 창이다. 이전 구현은 모던 CSS 위에
레트로 오버라이드를 덧칠한 2층 구조라, 회색 면 위의 회색 텍스트(`#a1a1aa`),
회색 입력 필드(`#808080` textarea), 캔버스를 덮는 부유 툴바가 남아 가독성이
나빴다. 크롬을 한 겹으로 다시 세우고 대비·배치를 레퍼런스 쪽으로 정렬했다.

### 베벨/색 토큰 (`session.html`)

- `--face #c0c0c0`, `--face-lt #dfdfdf`, `--hi #fff`, `--sh #808080`,
  `--dsh #000`, `--field #fff`, `--navy #000080`, `--desktop #6e6e6e`.
- raised = `border: 2px outset` + `inset 1px 1px 0 #fff, inset -1px -1px 0 #808080`,
  sunken = `border: 2px inset` + `inset 1px 1px 0 #000, inset -1px -1px 0 #dfdfdf`.
  `outset`/`inset` 키워드를 유지하는 이유는 `ui-e2e-check.ts`의 retro-chrome
  검증이 `#toolbar`의 `border-style`을 실제로 읽기 때문이다.
- 사용자가 글을 넣는 표면(그룹 노트, 전체 설명, reference zone)은 전부 흰
  sunken 필드 + 검은 글자다. 비활성 텍스트는 Win 방식대로 `#808080` +
  `text-shadow: 1px 1px 0 #fff`로 새긴다.
- 크롬은 `-webkit-font-smoothing: none`(비트맵 느낌), `textarea/input/select`는
  `antialiased` — 12px 한글이 안티앨리어싱 없이는 읽기 어렵다.

### 레이아웃

`#app`(세로 flex) = 타이틀바 → 메뉴바 → `#workspace`(툴박스 · 캔버스 · 사이드바)
→ `#paint-statusbar`(`position: absolute; bottom: 0`).

- 툴박스는 캔버스 **옆에 도킹**한다. 이전에는 `position: absolute`로 캔버스
  좌상단을 덮어 검토 대상 화면의 헤더/로고를 가리고, 좌상단을 향한 포인터
  이벤트를 삼켰다(그 때문에 e2e가 좌표를 우회하고 있었다).
- 캔버스는 `fitToViewport()`에서 가운데 정렬한다(`panX`/`panY`). 예전에는 좌상단에
  붙어 오른쪽에 죽은 회색 띠가 남았다. 렌더 시 스크린샷 둘레에 1px 검은 테두리를
  그려 "책상 위의 문서"로 읽히게 한다.
- 사이드바 폭 322px, 그룹/전체 설명은 `<fieldset class="panel">` groove 그룹박스.

### 메뉴바 (신규)

`MENUS` 테이블(File/Edit/View/Help)로 팝업을 생성한다. 항목마다 `enabled`를 열 때
계산하므로 비활성 상태가 툴바 버튼과 항상 일치한다.

- File: 새 지시(N), 지시 제출(Ctrl+Enter)
- Edit: 되돌리기, 다시 실행, 선택 삭제(Del)
- View: 확대(+), 축소(-), 창에 맞추기(0)
- Help: 단축키 대화상자(F1)

`SessionAnnotatorApp`에 `zoomBy(factor)`, `fitToView()`, `hasSelection()`,
`deleteSelection()`을 추가했다. 줌은 이전까지 휠 전용이라 100%로 되돌릴 방법이
아예 없었다. 언어 전환은 메뉴바 오른쪽 끝의 `[data-locale]` 버튼 두 개로 옮겨
사이드바 상단 공간을 비웠다.

### 상태바

`[도구 · 활성 그룹] [그룹 색상 팔레트] [줌]`. 팔레트는 장식용 `<i>` 스와치가
아니라 실제 그룹 스와치 버튼이다 — 클릭하면 그 그룹으로 focus하고, hover하면
캔버스 하이라이트가 동기화된다. 줌 표시는 클릭하면 창에 맞춘다.
뮤테이션이 끝나면 `setIdleStatus()`가 "저장 중..."을 도구·그룹 표시로 되돌린다.

### 그룹 카드

카드 자체가 작은 Win 창이다. 헤더 바가 활성일 때 `--navy`, 비활성일 때 `--sh`라
어느 그룹이 활성인지 색만 봐도 구분된다. 헤더에 색 칩·번호·마크 수·빈 그룹 삭제
버튼, 본문에 흰 노트 필드와 reference zone이 들어간다.

### 입력 보존 (버그 수정)

- `renderSidebar()`가 카드를 매번 새로 그리므로, 입력 중이던 노트의 캐럿과
  아직 저장되지 않은 글자가 사라졌다. `captureNoteFocus()`/`restoreNoteFocus()`로
  포커스·선택 범위·현재 값을 복원한다.
- `#global-note`는 제출 시점에만 저장돼서, 노트를 쓴 뒤 마크를 하나 그리면
  다음 렌더에서 통째로 지워졌다. 제출 전까지 DOM 값을 유지하도록 렌더는
  **서버 값이 실제로 바뀐 경우에만** textarea에 써 넣고, 제출 핸들러가
  `setGlobalNote()` 후 `submit()`을 순서대로 호출한다.
- 그룹 노트/reference zone 클릭은 여전히 `focusGroup()` 팬을 막지만
  `setActiveGroup()`은 호출한다. 붙여넣기는 활성 그룹에 붙으므로, 클릭한 카드가
  활성이 되지 않으면 레퍼런스가 엉뚱한 그룹에 붙었다.
- `selectTool()`은 `app.tool`이 실제로 바뀐 경우에만 활성 표시를 갱신한다
  (저장 중에는 `setTool()`이 거부되므로 표시만 바뀌는 불일치가 있었다).

### 검증

- `ui-e2e-check.ts`, `patch-reference-e2e-check.ts`, `lifecycle-check.ts`,
  `review-loop-check.ts`, `daemon-lifecycle-check.ts` 전부 ALL CHECKS PASSED.
- `patch-reference-e2e-check.ts`의 마지막 사각형 제스처 좌표를 캔버스 안쪽으로
  옮겼다. 툴박스 도킹으로 캔버스가 좁아져 예전 좌표(`box.x + 900`)는 사이드바에
  떨어져 아무것도 그리지 않았고, 그 사실을 검증이 잡아내지 못하고 있었다.
