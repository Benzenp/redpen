# Redpen Capture Spike Functional Design

`docs/RedpenCaptureSpike PRD.md`의 요구사항을 구현한 방식을 기술한다. 대상 코드는 `apps/cli/src/spike/`.

## 구성 요소

```text
apps/cli/src/spike/
├── capture-spike.ts       # 엔트리포인트: 브라우저 실행, 시나리오 오케스트레이션, assertion, report 작성
├── dom-index.ts            # Node 측 타입(DomIndexResult, DomCandidate)과 findCandidateAtPoint
└── dom-index-browser.js    # 브라우저 컨텍스트에서 그대로 evaluate되는 순수 JS DOM collector
```

## 실행 흐름

1. `chromium.launchPersistentContext(profileDir, { headless: true, viewport: 1280x900 })`로 전용 프로필을 연다. `profileDir`은 `apps/cli/.spike-profile`이며 재실행 시 재사용된다.
2. `fixtures/frontend/index.html`을 `file://` URL로 로드한다.
3. `injectShadowControl(page)`가 `page.evaluate`로 다음을 수행한다:
   - `#redpen-spike-control-host` div를 `document.body`에 추가 (fixed, top-right).
   - `host.attachShadow({ mode: 'open' })`로 shadow root를 만들고, 그 안에 `<style>`과 `<button>`을 넣는다. shadow 내부 스타일은 host 바깥으로 leak되지 않는다.
   - 버튼 클릭 리스너는 host를 `display: none`으로 바꾸고 `window.__redpenControlHidden = true`를 설정한다 (테스트 가시성용 플래그, 실제 제품 코드에는 없음).
4. `captureAtCurrentScroll(page, label, domIndexBrowserScript)`가 한 번의 "화면 고정" 캡처를 수행한다:
   - `clickShadowMarkButton`으로 shadow DOM 내부 버튼을 프로그래밍적으로 클릭한다.
   - `__redpenControlHidden` 플래그를 읽어 hide 성공을 확인한다.
   - `page.evaluate(domIndexBrowserScript)`로 `dom-index-browser.js`의 소스 텍스트를 그대로 실행해 `DomIndexResult`를 받는다.
   - `page.screenshot({ path })`로 같은 시점의 viewport screenshot을 저장한다.
   - 다음 캡처를 위해 control을 다시 보인다.
5. top(스크롤 0)과 scrolled(`window.scrollTo(0, 1100)`) 두 시점에서 각각 캡처를 수행한다.
6. 각 캡처에 대해 assertion을 실행하고 `checks: CheckResult[]`에 축적한다.
7. 모든 결과를 `dom-index-top.json`, `dom-index-scrolled.json`, `report.json`으로 `apps/cli/.spike-output/`에 쓴다.
8. 하나라도 실패하면 `process.exitCode = 1`로 종료한다.

## DOM index 수집 로직 (`dom-index-browser.js`)

`document.body`부터 재귀적으로 자식을 순회하며 각 element에 대해:

- `isVisible(el)`: `getComputedStyle`로 `display`/`visibility`/`opacity`를 확인하고, `getBoundingClientRect()`로 zero-size 및 뷰포트 교차 여부를 확인한다. 이 두 조건을 모두 만족해야 후보로 채택한다.
- `SCRIPT`/`STYLE` 태그는 순회에서 완전히 제외한다.
- `INPUT`/`TEXTAREA`의 `textSummary`는 항상 `null`이다 (value를 절대 읽지 않음). `password-value-not-collected` 검증은 결과 JSON 전체를 문자열화해 리터럴 `super-secret-value`가 존재하지 않는지 확인한다.
- 각 candidate는 `tempId`, `tag`, `role`, `accessibleName`, `textSummary`, `testIdHint`, `idHint`, `classHint`, `rect`를 갖는다. 이는 `docs/ARCHITECTURE.md` §4.3의 후보 수집 규칙과 §9 보안 제한(민감 값 미저장)을 그대로 반영한다.

이 파일이 **컴파일되지 않은 순수 JS**로 분리된 이유: 초기 구현은 TypeScript 함수를 `Function.prototype.toString()`으로 직렬화해 `page.evaluate`에 넘겼는데, esbuild/tsx가 컴파일 시 함수 본문에 삽입하는 `__name()` 헬퍼 호출이 브라우저 페이지 컨텍스트에는 존재하지 않아 `ReferenceError: __name is not defined`가 발생했다. 대신 이 파일의 raw 소스 텍스트를 `readFile`로 읽어 `page.evaluate(sourceText)`로 그대로 실행하는 방식으로 우회했다. 향후 실제 daemon 구현에서도 브라우저에 주입되는 코드는 컴파일러 헬퍼에 의존하지 않는 순수 JS로 유지해야 한다.

## 좌표 역매핑 (`dom-index.ts`)

`findCandidateAtPoint(index, point)`는 point가 rect 안에 포함되는 모든 candidate 중 면적이 가장 작은 것을 반환한다. 최소 면적을 우선하는 이유는 큰 컨테이너(예: body 전체)보다 실제로 클릭한 leaf element(버튼, 카드)를 우선 식별하기 위함이다.

## 검증 시나리오와 대응 assertion

| 시나리오 | assertion 이름 | 확인 내용 |
|---|---|---|
| Shadow control이 클릭 후 사라짐 | `shadow-control-hides-on-click` | `__redpenControlHidden === true` |
| top 캡처에서 save 버튼 수집 | `save-button-collected-at-top` | `testIdHint === 'save-button'` candidate 존재 |
| display:none 제외 | `display-none-excluded` | `hidden-element` candidate 없음 |
| 뷰포트 밖 제외 | `offscreen-excluded-at-top` | `offscreen-element` candidate 없음 |
| 좌표→DOM 역매핑 (top) | `click-resolves-to-save-button` | rect 중심점으로 `findCandidateAtPoint` 호출 시 `save-button` 반환 |
| 스크롤 후 재수집 | `price-card-collected-after-scroll` | 스크롤 후 `price-card` candidate가 새 rect로 존재 |
| 스크롤 후 역매핑 | `click-resolves-to-price-card-after-scroll` | 새 rect 기준 좌표가 `price-card`로 resolve |
| 스크롤 메타데이터 | `scroll-offset-recorded` | `domIndex.scroll.y === 1100` |
| password 값 미수집 | `password-value-not-collected` | 직렬화된 index에 시크릿 문자열 없음 |
| password 요소 존재 인식 | `password-input-still-detected-as-candidate` | candidate 자체는 존재 (완전 누락 방지) |

## 알려진 한계

- 실제 HTTP localhost dev server가 아닌 `file://` fixture로 검증했다. Phase 4 CLI 구현 시 실제 `redpen open <url>`이 HTTP 대상에서도 동일하게 동작하는지 별도로 확인해야 한다.
- macOS/Linux 크로스 플랫폼 확인은 아직 수행하지 않았다.
- tldraw 자체는 검증하지 않았다. Phase 2에서 `docs/ARCHITECTURE.md` §3.6이 명시한 tldraw spike 항목(locked background, group별 강제 shape style, badge/selection 동기화, SVG/JSON export, mask opaque export)을 별도로 수행해야 한다.
