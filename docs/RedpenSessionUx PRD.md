# Redpen Session UX PRD

## 배경

`docs/IMPLEMENTATION_PLAN.md` Phase 0-6 구현이 완료된 뒤, 실사용자가 데모 페이지(`fixtures/demo-app/index.html`)를 대상으로 `redpen open` → 마킹 → 제출 흐름을 실제로 사용해보고 4가지 UX 결함을 지적했다. 이 PRD는 그 결함들과 개선 요구사항을 정의한다.

## 문제

0. **(사후 발견) 어노테이션 탭이 제출 후 절대 닫히지 않음**: 요구사항 5("짧은 지연 후 탭을 자동으로 닫아야 한다")를 `window.close()`로 구현했으나, 이 탭은 Playwright가 `context.newPage()` + `page.goto()`로 연 탭이라 브라우저가 "스크립트가 연 탭"으로 인식하지 않는다. 그 결과 `window.close()`가 항상 no-op이 되어 "제출 완료" 오버레이만 뜬 채 탭이 영원히 남아 있었다.
1. **연결 실패에 취약함**: `redpen open <url>`이 dev 서버가 아직 포트를 바인딩 중인 흔한 경합 상황에서 즉시 `error` 상태로 빠짐. 재시도 로직이 전혀 없었음.
2. **freeze를 트리거할 화면상의 방법이 없음**: `freeze`는 CLI/MCP 호출로만 존재했다. 브라우저에서 페이지를 보고 있는 사용자에게는 "화면을 고정해서 마킹을 시작하라"는 어떤 시각적 신호나 조작 수단도 없었다.
3. **캡처 화질이 낮음**: Playwright 기본 `deviceScaleFactor`(1x)로 스크린샷을 찍어 어노테이션 UI와 최종 task 이미지가 흐릿했다.
4. **제출 후 피드백이 약하고 에이전트가 완료를 자동으로 못 감지함**: 제출 성공 시 사이드바 하단의 작은 텍스트 한 줄만 바뀌고 탭은 계속 열려 있었다. 에이전트 쪽에서도 세션을 연 뒤 `wait`를 걸어두지 않고 사용자의 "제출했다"는 보고에 의존했다.

## 목표

- `redpen open`이 일시적 연결 실패를 자동으로 흡수해서 사용자가 재시도 명령을 직접 칠 필요가 없게 한다.
- 브라우저에서 페이지를 보는 사용자가 별도 터미널 없이 화면 안에서 freeze를 트리거할 수 있게 한다(클릭 및 키보드 단축키).
- 어노테이션 화면과 최종 저장되는 스크린샷의 해상도를 개선한다.
- 제출 완료를 사용자와 에이전트 양쪽에 명확하게 알린다: 어노테이션 탭은 성공을 크게 보여주고 자동으로 닫히며, 원래 페이지에도 완료 신호가 남는다.
- 에이전트 워크플로: 세션을 열고 freeze 안내를 한 직후, 사용자의 제출 보고를 기다리지 않고 `wait`를 선제적으로 걸어 제출 순간을 스스로 캐치한다.

## 비목표

- annotation UI의 그림 도구(펜/화살표/사각형 등) 자체의 기능 확장은 범위 밖 (§8에서 확장됨).
- 외부(non-loopback) URL 지원은 범위 밖 (`docs/ARCHITECTURE.md` §9의 향후 과제로 유지).
- 다중 프레임/다중 스크린샷 캡처는 범위 밖.

## 요구사항

1. `page.goto`가 `ERR_CONNECTION_REFUSED`/`ECONNREFUSED`로 실패하면 지수적이지 않은 고정 간격(500ms)으로 최대 5회까지 재시도해야 한다. 다른 종류의 실패는 즉시 전파해야 한다.
2. 타겟 페이지 로드 시 좌하단에 "Freeze screen (F9)" 버튼이 주입되어야 하며, 클릭 또는 F9 키 입력으로 daemon의 freeze 엔드포인트를 호출해야 한다. 버튼은 페이지 새로고침/재탐색 후에도 유지되어야 한다(`addInitScript`).
3. freeze 성공/실패는 화면 우하단 토스트로 사용자에게 즉시 알려야 한다.
4. 브라우저 컨텍스트의 `deviceScaleFactor`는 2로 설정되어야 한다.
5. 어노테이션 UI 제출 성공 시 전체화면 오버레이(체크마크 + taskId)를 표시하고, 짧은 지연 후 탭을 자동으로 닫아야 한다.
6. freeze 오버레이는 freeze 이후 세션 상태를 폴링하여 제출 완료 시 원래 타겟 페이지에도 토스트를 표시해야 한다.
7. daemon은 타겟 페이지 origin에서의 크로스 오리진 freeze/status 요청을 쿼리 토큰 인증으로 허용해야 한다(로컬 전용 daemon의 보안 모델은 유지).
8. 어노테이션 탭 닫기는 클라이언트(`window.close()`)가 아니라 daemon이 Playwright API(`page.close()`)로 서버사이드에서 수행해야 한다. 단, 어노테이션 탭 자신의 `fetch('.../annotator/submit')` 요청이 완료·전달된 뒤에만 닫아야 한다 — 응답 전송 전에 탭을 닫으면 그 fetch가 실행 중이던 탭 자체가 파괴되어 `app.submit()` 프라미스가 영원히 hang된다.
9. 제출은 구현 승인과 분리한다. 에이전트는 제출을 감지한 뒤 그룹별 의도를 자연어로 요약해 사용자에게 확인받고, 명시적 확인 전에는 task를 `working`으로 전환하거나 제품 코드를 수정하지 않는다.
10. 제출 후 어노테이션 탭만 닫고 타겟 페이지는 유지한다. 구현 완료로 `review` 상태에 진입할 때 daemon이 기존 타겟 페이지를 새로고침하고 앞으로 가져와 최신 코드를 보여준다.
11. native `<dialog>` 또는 `aria-modal="true"` 모달이 열려 있으면 freeze 버튼과 토스트를 활성 모달의 top layer 안으로 이동해 가려지지 않게 한다. 같은 시점의 DOM grounding은 활성 모달과 그 자식만 후보로 수집하고, backdrop 뒤의 배경 DOM은 제외한다.

## 성공 기준

- 위 요구사항 1-8에 대응하는 동작이 실제 headed 브라우저에서 확인된다.
- 기존 자동 체크(`lifecycle-check`, `review-loop-check`, `daemon-lifecycle-check`, `ui-e2e-check`) 전부가 회귀 없이 통과한다.
- 캡처된 PNG의 픽셀 크기가 이전(1x) 대비 약 2배임을 실측으로 확인한다.
- 실제 daemon+Playwright 경로로 (open → freeze → mark 추가 → annotator-UI submit 라우트 호출) 시나리오를 재현했을 때, submit 응답이 호출자(탭)에게 정상 전달되고 그 직후 해당 Playwright Page의 `isClosed()`가 `true`가 됨을 확인한다.

## 8. 확장: 픽셀 편집 마크 (crop+move, 레퍼런스 이미지)

기존 annotation UI는 전부 벡터 마크(펜/화살표/사각형/원/텍스트/마스크)뿐이라, "이 영역을 저기로 옮겨줘"처럼 화면상의 실제 위치 이동을 지시할 때 마크가 목적지를 가리키는 벡터 힌트에 그쳐 에이전트가 정확한 목적지를 오인하는 사례가 나왔다(사용자가 카드 내부 delta 값을 카드 밖 헤더로 옮기는 것으로 잘못 해석됨). 이를 줄이기 위해 실제 픽셀을 조작하는 두 가지 마크 타입을 추가한다.

### 문제

- 벡터 마크(사각형+화살표 조합 등)만으로는 "이 영역을 정확히 여기로 옮겨줘" 같은 지시가 여전히 해석의 여지를 남긴다.
- 사용자가 참고할 외부 이미지(디자인 목업, 스크린샷 등)를 화면 위에 직접 얹어 비교하거나 배치 위치를 지시할 방법이 없었다.

### 목표

- 스크린샷의 한 영역을 실제로 잘라서 다른 위치에 픽셀 단위로 복사하는 `patch` 마크를 추가한다("포토샵의 자르기+이동"과 동일한 체감).
- 레퍼런스 이미지는 캔버스 픽셀로 배치하지 않고 각 Instruction Group에 참고자료로 최대 3장 첨부한다.
- DB 없이 워크스페이스 폴더(`<workspaceRoot>/.redpen/references/`) 안에 파일 + JSON 인덱스로 레퍼런스 이미지를 저장한다.
- 직선 도구와, 드래그한 영역 안에서 직접 입력하는 텍스트 도구를 제공한다.

### 비목표

- 이미지 회전/반전/필터나 캔버스 이미지 배치는 범위 밖이다.
- 레퍼런스 라이브러리의 태그/검색/폴더 구조는 범위 밖이다.
- 다중 사용자 간 레퍼런스 공유(클라우드 동기화)는 범위 밖 — 워크스페이스 로컬 저장이 전부다.

### 요구사항

1. `Mark` 스키마는 `patch`와 `line`을 지원하고 obsolete `image` 마크는 제거한다.
2. 별도 patch 도구 없이 기본 `V` Select/Move에서 빈 영역 marquee를 만들고,
   그 영역을 드래그해 목적지에 놓을 때 `patch`를 커밋한다. 생성 후에는 일반
   mark와 같은 이동/resize/Delete/undo를 제공하되 `sourceRect`는 유지한다.
3. 우측 Instruction Group 카드마다 붙여넣기와 다중 drag/drop을 받는 레퍼런스 존을 두고 최대 3장까지 썸네일·삭제를 지원한다.
4. 첨부 이미지는 daemon을 통해 `<workspaceRoot>/.redpen/references/`에 저장하고 제출 task의 `references/`에도 복사한다. `group.referenceIds`와 `task.references`가 연결 관계와 경로를 보존해야 한다.
5. 레퍼런스는 캔버스나 `annotated.png`에 합성하지 않는다. 에이전트가 그룹별 시각 지시와 함께 열어보는 참고자료다.
6. 직선은 그룹 색상의 시작점→끝점 선으로 저장·렌더링하며 화살촉이 없어야 한다.
7. 텍스트는 클릭 즉시 기본 편집 영역을 열고, drag 시 bounded 영역을 만든다.
   Select/Move에서 double-click 또는 Enter로 기존 text를 ID 변경 없이 편집한다.
8. Select/Move는 click/Shift+click/marquee, batch move/delete, corner resize,
   Shift 제약, Space pan, 숫자 그룹 전환을 지원한다.
9. mask는 0.1~1 opacity를 저장하고 canvas와 `overlay.svg`에서 동일하게 표시한다.
10. pen은 별도 설정 UI 없이 pointer coalescing, endpoint 보존 smoothing,
    dot/짧은 stroke 보존을 기본 적용한다.

### 성공 기준

- `line`/group reference/task reference 스키마와 최대 3장 불변식 테스트가 통과한다.
- 실제 headless 브라우저로 patch, 붙여넣기 1장, 다중 drop 2장, bounded text, line, submit을 재현하고 task bundle의 세 reference PNG를 확인한다.
- 기존 자동 체크 4종(`lifecycle-check`, `review-loop-check`, `daemon-lifecycle-check`, `ui-e2e-check`) 전부가 회귀 없이 통과한다.

## 현재 상태

구현 완료. 현재 그룹 레퍼런스·직선·영역 텍스트 설계는
`docs/RedpenSessionUx FunctionalDesign.md` §9를 기준으로 한다. §8의 image 마크
설계는 과거 기록이며 더 이상 제품 동작이 아니다.
