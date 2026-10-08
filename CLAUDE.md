# sg-todo — Claude Code 작업 지침

SG솔루션 **할 일 프로그램**. 데이터는 SGCRM Firebase(`sg-crm-f9adc`) Firestore `todos` 하나를 쓴다(새 DB 없음).
전체 설계는 SGCRM 저장소 `TODO_ARCHITECTURE.md`, 보안은 `SECURITY_PLAN.md`.

## 규칙 (사장님 지시 — SGCRM과 같음)
- 응답·코드 주석·커밋 메시지는 **한국어**
- **push는 사장님이 「올려줘」라고 할 때만.** 커밋도 지시 없으면 하지 않고 결과만 보고
- `main`에 올라가면 Cloudflare가 쓰기 창구를 **자동 배포**한다 (연결 후)
- 수정 후 `cd worker && npm test && npm run check` 전부 통과해야 다음 단계
- **비밀값(서비스 계정 키 JSON, INGEST_KEY)은 절대 저장소·채팅에 넣지 않는다.** Cloudflare 대시보드 Secret에만
- Firestore 실데이터를 시험 삼아 바꾸지 않는다. 시험은 `test/fakeDb.js`(메모리 DB)로

## 구성
| 경로 | 내용 |
|---|---|
| `worker/` | 쓰기 창구 (Cloudflare Worker `sg-todo` → `https://sg-todo.sgsolution.workers.dev`) |
| `worker/src/core.js` | 상태 규칙·칸 계산·날짜·반복·기업 찾기 (순수 함수, 웹 화면과 공용 예정) |
| `worker/src/todos.js` | 추가·수정·완료·삭제(휴지통)·되살리기·조회·변동 — 모두 트랜잭션 + `activity` 기록 |
| `worker/src/firestore.js` | Firestore REST + 서비스 계정 토큰 |
| `worker/src/auth.js` | Firebase 로그인 토큰 확인(허용 메일) · 스크립트 키 · 작성자(X-SG-User) |
| `web/` | 할 일 웹 화면 (다음 단계) |

## 데이터 규칙 요약
- 번호 `no`(정수) → 표시 `T-0123`. 다음 번호는 `app_state/todo_seq.last` (트랜잭션)
- 상태 `wait`·`ing`·`waiting`·`done`·`cancel`. 완료 시 `doneAt`, 다시 열면 지움. 상태·마감·메모·기다리는 대상이 바뀌면 `statusAt`
- 작성자: 공용 계정이라 **화면/채팅이 고른 이름**(정석진·김학미·공동)을 `X-SG-User`로 받는다. 비면 쓰기 거절
- 삭제 = 휴지통(`deletedAt`), 30일 뒤 완전 삭제(예약 작업 — 다음 단계)
- 모든 쓰기는 `activity` 컬렉션에 한 줄 기록 → SGCRM 통합제어 화면·에이전트가 「바뀐 것」을 본다
