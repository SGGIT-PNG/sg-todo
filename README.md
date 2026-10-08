# sg-todo
SG솔루션 할 일 프로그램 — 쓰기 창구(Cloudflare Worker)와 할 일 웹 화면.

- 쓰기 창구: `worker/` → https://sg-todo.sgsolution.workers.dev
- 데이터: SGCRM Firestore `todos` (+ 변동 기록 `activity`)
- 작업 지침: [CLAUDE.md](CLAUDE.md)

```bash
cd worker
npm test        # 모의 시험 (실제 Firestore 접속 없음)
npm run check   # 문법 검사
```
