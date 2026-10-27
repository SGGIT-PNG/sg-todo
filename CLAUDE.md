# sg-todo — Claude Code 작업 지침

SG솔루션 **할 일 프로그램**. 데이터는 SGCRM Firebase(`sg-crm-f9adc`) Firestore `todos` 하나를 쓴다(새 DB 없음).
전체 설계는 SGCRM 저장소 `TODO_ARCHITECTURE.md`, 보안은 `SECURITY_PLAN.md`.

## 규칙 (사장님 지시 — SGCRM과 같음)
- 응답·코드 주석·커밋 메시지는 **한국어**
- **push는 사장님이 「올려줘」라고 할 때만.** 커밋도 지시 없으면 하지 않고 결과만 보고
- `main`에 올라가면 Cloudflare가 쓰기 창구를 **자동 배포**한다 (연결 후)
- 수정 후 `cd worker && npm test && npm run check` 전부 통과해야 다음 단계. `index.html`은 모듈 스크립트 `node --check` + 인라인 onclick 함수가 `Object.assign(window,…)`에 있는지 확인
- **비밀값(서비스 계정 키 JSON, INGEST_KEY, META_TOKEN)은 절대 저장소·채팅에 넣지 않는다.** Cloudflare 대시보드 Secret에만
- Firestore 실데이터를 시험 삼아 바꾸지 않는다. 시험은 `test/fakeDb.js`(메모리 DB)로

## 구성
| 경로 | 내용 |
|---|---|
| `worker/` | 쓰기 창구 (Cloudflare Worker `sg-todo` → `https://sg-todo.sgsolution.workers.dev`) |
| `worker/src/core.js` | 상태 규칙·칸 계산·날짜·반복·기업 찾기 (순수 함수, 웹 화면과 공용 예정) |
| `worker/src/todos.js` | 추가·수정·완료·삭제(휴지통)·되살리기·조회·변동 — 모두 트랜잭션 + `activity` 기록 |
| `worker/src/firestore.js` | Firestore REST + 서비스 계정 토큰 |
| `worker/src/auth.js` | Firebase 로그인 토큰 확인(허용 메일) · 스크립트 키 · 작성자(X-SG-User) |
| `index.html` | **할 일 웹 화면** (GitHub Pages → https://sggit-png.github.io/sg-todo/). 읽기 = Firestore 실시간 구독, 쓰기 = 쓰기 창구 API. `worker/src/core.js`를 그대로 import (규칙 한 곳) |
| `worker/src/auto.js` | 자동 생성(인증 갱신 D-90·ISO 차기심사 D-90·연구소 연간신고 3/1~기한 — SGCRM 규칙 그대로 + **인증 연동 `cert_status`**(SGCRM `CERT_STATUS_SPEC.md` v1 §5 — nextDue 우선, 없으면 certified 만료 D-90, dedupeKey `cert:cs:…`, 연동된 기업·인증은 수기 기록·iso_audits로 안 만듦)) + 휴지통 30일 정리. **매일 06:00 KST cron**(wrangler.toml) · 관리 탭 「지금 실행」 |
| `worker/src/mcp.js` · `oauth.js` | **Claude 커넥터** `POST /mcp`(도구 17개: todo_add·complete·update·list·get·changes·delete·restore, company_find, lead_list·lead_update·lead_history·lead_sync·lead_reset, iso_update·iso_profile·iso_update_status) + 로그인 `/oauth/*`(구글 로그인 → 서명 출입증 1시간·갱신증 90일, KV 없음). 쓰기 도구는 `author` 필수, 기록 `via:'mcp'`. claude.ai 커스텀 커넥터 주소 = `https://sg-todo.sgsolution.workers.dev/mcp` |
| `worker/src/leads.js` | **📣 광고 DB**(Meta 리드 광고 ISO·벤처·기업인증·ESG) — Firestore `leads/D-0001`, 번호 `app_state/lead_seq`. **5분마다 cron**이 Meta Graph API에서 가져옴(`syncMeta` — Secret `META_TOKEN`(**2026-10-19부터 Meta 비즈니스 「시스템 사용자 sgtodo-ads」 만료 없는 토큰** — 사람 계정 토큰이 잠금·인증 때마다 끊겨서. 매번 `/{page}?fields=access_token`으로 페이지 토큰으로 바꿔 씀, 페이지 토큰을 넣어도 됨) + `wrangler.toml` `META_PAGE_ID`, 없으면 아무것도 안 함, 상태 `app_state/lead_sync`). 예비: 웹 「엑셀 올리기」(`/api/leads/import`). 중복 = Meta 리드 ID 또는 같은 광고+같은 전화번호. 상태 new→noans(부재, 다음 영업일 재통화, **3번째 = unreach**)→talk→meet(🤝 미팅 예정, `meetDate`·`meetTime`)→won(할 일 생성)/lost. **📒 통화 이력 `calls`**(들어와서 미팅까지 — 전화 결과·메모마다 `{at,by,action,what}` 한 줄, 최근 100줄, 2026-10-14) · 지난 기록은 5분 가져오기 때 한 번 activity에서 옮겨 채움(`backfillLeadCalls`, `lead_sync.callsBackfilledAt`). 웹은 이름을 누르면 이력. 웹 「📣 광고 DB」 탭, MCP `lead_list`·`lead_update`·`lead_sync`·`lead_reset`(비우고 기준일 `lead_sync.startFrom`부터 다시, confirm=초기화), CRM TV 통화 카드. 연결 안내 `META_SETUP.md` |
| `worker/src/iso.js` | **🏅 ISO 소식 우편함** — iso-one `docs/ISO_INBOX_SPEC.md` v1(원본 SGGIT-PNG/ims-project). 업무창에서 말한 인증·심사 소식을 Firestore `iso_inbox`에 한 줄(`state:'pending'`, `source:'sg-todo'`, ID `sg-todo__{ref 또는 chat-내용해시}__{YYYYMMDD}` — 같은 내용은 덮어씀, 이미 applied면 안 씀). iso-one이 반영(applying→applied/rejected, `result`) → cert_status로 CRM. **업무창은 iso-one 데이터를 직접 고치지 않는다.** 할 일: 심사 끝남(auditDone·certified)+취득일 없음 → 「[기업] 인증서 발급 확인」(dedupeKey `iso:issue:{사업자번호}`), 취득일 오면 자동 완료(앞날이면 오늘, 키는 `…:{취득일}`로 비켜 다음 심사 때 다시 생성). MCP `iso_update`·`iso_update_status`. **🏢 업체 정보 `iso_profile`**(2026-10-19, 명세 v2 §6 — ISO one 에이전트가 구글 드라이브 업체카드·사업자등록증으로 iso-one 「정보입력」을 채움): `kind:'profile'` + `profile`{칸 58개 + 그 밖의 칸, `PROFILE_FIELDS` = iso-one `INBOX_CO_FIELDS`+`INBOX_AUDIT_FIELDS`의 한글 이름} + `certs`·`atype`·`s1Date`·`s2Date` + `createIfMissing`(기본 true, iso-one에 없으면 새 등록)·`assignee`(새 등록 계정 이메일). `normProfile`이 틀린 값(업종 12종·근무형태·설계·실존 날짜·인원 숫자)을 **보내기 전에 거절**. **목록에 없는 칸은 이름 모양(영문 소문자·숫자·_)만 맞으면 그대로 넘긴다**(2026-10-23 — iso-one이 칸을 늘려도 여기 고칠 필요 없게, 값 검사는 iso-one, 한글 이름은 `profileLabel` = 없으면 key). 정보요청서 칸 16개(복수 사업장·추가 사업장·외주·인허가·환경 허가신고·입지조건·심사경험·전환 이전 기관 정보) 한글 이름 등록, `sites`·`permits` 등 긴 칸은 2000자. `iso_update_status`는 선택 칸에 `[예/아니오]`(iso-one `choices`)를 붙여 보여 줌. ID `sg-todo__profile-{사업자번호숫자}-{내용해시}__{YYYYMMDD}`(같은 내용 한 건, 이미 applied면 안 씀). 심사일 주말이면 답에 경고(공휴일은 iso-one이 경고). iso-one은 빈 칸만 채우고 다른 값은 result에 「차이」, 반영 뒤 `missing`·`missingOptional`(빈 필수·권장 칸 `[{key,label}]`)을 적어 줌 → `iso_update_status`가 빈 칸을 표시(iso-one이 `from`을 붙이면 「SG가 정할 칸 / 기업 요청(필수)·(권장)」으로 나눔 — `missBlock`, 2026-10-22). 할 일 연동 없음. 스킬 `skills/iso-one-agent/SKILL.md`(2026-10-22 재작성 — 「혼자 끝까지」: 드라이브 읽기 → 확인 없이 `iso_profile` → 기업만 아는 칸은 **정보요청서** Google 문서를 업체 폴더에 생성, 회신본이 오면 다시 읽어 전송 → 사람에게는 관리번호(인증원)·2단계 심사일만. 2단계가 오면 iso-one이 나머지 일정 자동) |
| `worker/src/apply.js` | **🏅 ISO 인증심사 온라인 접수**(2026-10-27) — 업체가 iso-one.web.app/apply(ims-project `apply.html`)에서 제출. **로그인 없는 공개 창구** `GET /api/apply/config`·`POST /api/apply`(multipart: data JSON + 첨부 f_biz·f_ins·f_perm·f_cert·f_org·f_proc). 사업자번호 체크섬·필수칸(45001이면 안전보건 관리 담당자)·숨은 칸(website)·하루 한도(같은 사업자번호 3·같은 접속 주소 10, `ipHash`) 검사 → 한 트랜잭션: `iso_inbox/apply__{숫자}__{접수번호}`(kind profile·source apply·createIfMissing·assignee=`APPLY_ASSIGNEE`, **CRM 기업 등록 없이** — companies 안 찾음) + `iso_apply/{ISO-YYMMDD-NNNN}`(접수 원본·추후 요청 목록·첨부) + activity → 할 일 「[업체] ISO 심사 접수 확인」(분야 iso, source iso, sourceRef `apply:{접수번호}`, 메모에 연락처·희망 시기·추후 요청). 첨부는 `APPLY_DRIVE_FOLDER`(공유 드라이브 폴더 ID, 서비스 계정을 구성원으로 + GCP 「Google Drive API」 사용)가 있으면 드라이브 `{접수번호}_{상호}` 폴더에(토큰 범위 drive — `accessToken(…, scope)`), 없으면 접수 화면이 첨부 칸을 숨기고 「메일로 요청」. CORS `ALLOWED_ORIGINS`에 iso-one 주소 추가. **접수서**(2026-10-27 후속): 업체가 쓴 그대로를 구글 문서 「접수서_{접수번호}_{상호}」로 접수 폴더에(`applyDocHtml`→`driveDoc`, HTML을 드라이브가 문서로 변환, 첨부가 없어도 폴더·접수서 생성, 실패해도 접수는 진행), 링크는 `iso_apply.doc`·할 일 메모·우편함 `applyDoc`/`applyFolder`(iso-one 정보입력 바로가기). 공유 드라이브 「ISO접수신청 › 온라인 접수」. 시험 `test/apply.test.js` |
| `/api/ingest` · `/api/admin/rebizno` | 드라이브 스크립트 v7(음성·채팅, X-Api-Key=INGEST_KEY) · SGCRM 사업자번호 변경 |
| `worker/src/todos.js` 번호 붙이기 | `GET/POST /api/admin/migrate` — 기존 할 일 번호 부여(미리보기 → 적용, 여러 번 안전). 웹 「관리」 탭 |

## 데이터 규칙 요약
- 번호 `no`(정수) → 표시 `T-0123`. 다음 번호는 `app_state/todo_seq.last` (트랜잭션)
- 상태 `wait`·`ing`·`waiting`·`idea`·`done`·`cancel`. `idea`(제안 업무)는 우리 아이디어 목록 — **시작일·종료일(마감)은 사람이 넣을 때만 저장·표시**(등록한 날로 채우지 않음, 시작일이 와도 제안 칸에 머묾, 종료일 지나도 빨간 표시 없이 회색 「종료일 지남」 — 2026-10-12 A안). 완료 시 `doneAt`, 다시 열면 지움. 상태·마감·메모·기다리는 대상이 바뀌면 `statusAt`
- 📞 통화 = `kind: call` + 날짜 `startDate` + 시각 `callTime`(HH:MM, 빈 값 = 시간 미정 · 창구는 `time`으로 「오후 2시」도 받음). `col: call` — 진행·예정 칸에서 빠지고 통화 칸에만, 날짜 지나면 「놓친 통화」(2026-10-12)
- 업무 분야 `category`(중분류) = `core.js` `CATEGORIES`(SGCRM `DEFAULT_CAT_META`와 같은 id). 웹·CRM·TV가 칸 안을 분야별로 묶는다(긴급 묶음 → 빨간 표시 묶음 → 분야 순서). 이름으로 와도(옛 값 「ISO」 포함) `normCategory`가 id로. 제안을 완료·취소하면 `fromIdea`를 남겨 「다시 열기」 때 제안으로 돌아간다
- 작성자: 공용 계정이라 **화면/채팅이 고른 이름**(정석진·김학미·공동)을 `X-SG-User`로 받는다. 비면 쓰기 거절
- 삭제 = 휴지통(`deletedAt`), 30일 뒤 완전 삭제(매일 06:00 예약 작업)
- ⚠️ Cloudflare 무료 요금제 = 요청당 외부 호출 **50번** 제한 → 여러 건 쓰기는 트랜잭션 하나로 묶는다(`createMany`). MCP 여러 번호(complete·delete)는 한 번에 **12개까지**(10/13 20개 삭제 때 한도 걸림)
- 모든 쓰기는 `activity` 컬렉션에 한 줄 기록 → SGCRM 통합제어 화면·에이전트가 「바뀐 것」을 본다
