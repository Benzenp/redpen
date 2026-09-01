# Redpen

> 말로 설명하기 어려운 UI 수정 사항을 화면에 직접 그려 코딩 에이전트에 전달하는 로컬 우선 비주얼 지시 도구.

현재 저장소 상태는 **구현 전 설계 문서**다. 이 문서는 Codex CLI 또는 Claude Code에 넘겨 단계적으로 구현하기 위한 기준선이다.

## 제품 한 줄 정의

에이전트가 수정할 로컬 페이지를 열어주면, 사용자는 실제 화면을 캡처해 색깔별 지시를 그리고 설명을 덧붙인다. Redpen은 표시와 연결된 DOM 문맥을 구조화해 Codex나 Claude 같은 네이티브 코딩 에이전트에 반환한다.

## 목표 경험

```text
사용자: "이 설정 페이지 수정할 거야. Redpen 열어봐."
에이전트: localhost 페이지로 Redpen 세션 시작
사용자: 원하는 상태로 이동 → 화면 고정 → #1, #2, #3 표시 → 제출
에이전트: 이미지, 지시 그룹, DOM 문맥 확인 → 구현 계획 또는 수정
```

사용자가 알아야 하는 것은 페이지, 색깔, 번호, 설명, 제출뿐이다. DOM selector, CSS 값, 파일 경로는 제품 표면에 기본 노출하지 않는다.

## 핵심 결정

- 로컬 전용 Node.js/TypeScript CLI로 시작한다.
- 모든 기능은 공용 application core를 통해 제공한다.
- CLI가 기준 인터페이스이며 MCP는 같은 core를 호출하는 얇은 어댑터다.
- Playwright가 전용 persistent Chromium을 관리한다.
- 캡처 이미지와 같은 시점의 visible DOM index를 만든다.
- 한 Visual Task 안에 여러 Instruction Group을 둘 수 있다.
- 지시 그룹은 색으로 구분하지만 영구 식별자는 번호/ID다.
- Redpen 자체에는 LLM이나 AI API를 넣지 않는다.
- 저장 포맷은 Codex, Claude 및 다른 에이전트가 읽을 수 있도록 모델 독립적으로 유지한다.
- MVP는 `localhost`와 `127.0.0.1`만 허용한다.

## 예상 CLI

```bash
redpen open http://localhost:5173/settings
redpen list
redpen status rp_01J... --json
redpen wait rp_01J... --json
redpen show rp_01J...
redpen review rp_01J...
redpen close rp_01J...
redpen mcp
```

명령 이름과 옵션은 구현 중 변경할 수 있지만, CLI-first 원칙과 JSON 출력 계약은 유지한다.

## 문서

- [제품 의도](docs/PRODUCT_INTENT.md)
- [아키텍처](docs/ARCHITECTURE.md)
- [구현 계획](docs/IMPLEMENTATION_PLAN.md)

## MVP 완료 조건

1. 에이전트 또는 사용자가 CLI로 localhost URL의 Redpen 세션을 연다.
2. 사용자가 실제 페이지를 탐색한 뒤 현재 viewport를 고정한다.
3. 세 가지 이상의 색깔별 지시 그룹을 만들고, 각 그룹에 여러 표시와 선택적 설명을 연결한다.
4. 제출 시 원본 이미지, 합성 이미지, 벡터 표시, 지시 그룹, 관련 DOM 문맥이 하나의 작업 번들로 저장된다.
5. CLI와 MCP 모두 같은 작업을 조회할 수 있다.
6. Codex와 Claude가 번들을 읽고 표시별 구현 계획을 만들 수 있다.

