// ── SG솔루션 할 일 쓰기 창구 (Cloudflare Worker) ──
// 할 일 웹 화면·Claude 채팅(MCP, 다음 단계)·드라이브 스크립트가 모두 여기로 쓴다. 읽기는 화면이 Firestore를 직접 구독.
// 설계: sgcrm/TODO_ARCHITECTURE.md
//
//   GET    /health
//   GET    /api/todos?view=today|missed|waiting|week|open|recent_done|trash&company=&category=&q=&limit=
//   GET    /api/todos/T-0123
//   GET    /api/changes?since=<ms>&company=
//   POST   /api/todos                     {text, company?, due?, status?, kind?, category?, priority?, memo?, waitingFor?, repeat?}
//   PATCH  /api/todos/T-0123              바꿀 항목만 (status·due·memoAppend 포함)
//   POST   /api/todos/T-0123/complete     {note?}
//   POST   /api/todos/T-0123/delete       {reason?}
//   POST   /api/todos/T-0123/restore
//   GET    /api/admin/migrate             기존 할 일 번호 붙이기 미리보기 (쓰지 않음)
//   POST   /api/admin/migrate             적용 (번호 없는 것만, 여러 번 돌려도 안전)
//   GET    /api/admin/auto                자동 생성 미리보기(인증 갱신·ISO·연간신고) / POST 지금 실행 (매일 06:00 예약 작업과 같음)
//   POST   /api/admin/rebizno             {from, to} 사업자번호 변경 — 그 기업 할 일을 옮김 (SGCRM이 부름)
//   POST   /api/ingest                    (드라이브 스크립트·비서, X-Api-Key) {text, source, sourceRef, company?, due?, memo?}
//
// 쓰기 요청에는 X-SG-User: 정석진|김학미|공동 (URL 인코딩) 헤더가 필요하다 — 공용 계정이라 사람을 따로 받는다.

import { restDb } from './firestore.js';
import { authenticate, requireAuthor, AuthError } from './auth.js';
import { RuleError } from './core.js';
import {
  createTodo, updateTodo, completeTodo, deleteTodo, restoreTodo, listTodos, getTodo, changesSince, NotFoundError,
  migratePreview, migrateApply, rebizno,
} from './todos.js';
import { previewAuto, runAuto } from './auto.js';

const INGEST_SOURCES = ['voice', 'chat', 'secretary', 'card', 'lead'];   // chat = 드라이브 스크립트가 옮기는 채팅 「할일」 일정(MCP 전까지)

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-sg-user',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}
function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors) });
}

export async function handle(request, env, deps = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const nowMs = deps.nowMs || Date.now();
  try {
    if (path === '/health') {
      const out = { ok: true, service: 'sg-todo', time: new Date(nowMs).toISOString() };
      // ?check=firestore — 서비스 계정 키로 Firestore에 읽기 한 번(내용은 돌려주지 않고 연결 여부만)
      if (url.searchParams.get('check') === 'firestore') {
        try {
          const db = deps.db || restDb({ projectId: env.FIREBASE_PROJECT, saKey: env.GCP_SA_KEY });
          await db.get('app_state/config');
          out.firestore = '연결됨';
        } catch (e) {
          out.ok = false;
          out.firestore = '실패: ' + String(e && e.message || e).slice(0, 160);
        }
      }
      return json(out, out.ok ? 200 : 503, cors);
    }
    if (!path.startsWith('/api/')) return json({ ok: false, error: '없는 주소입니다' }, 404, cors);

    const actor = await authenticate(request, env, { fetchFn: deps.fetchFn, nowMs });
    const db = deps.db || restDb({ projectId: env.FIREBASE_PROJECT, saKey: env.GCP_SA_KEY });
    const ctx = { db, actor, nowMs };
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.json().catch(() => { throw new RuleError('요청 본문(JSON)이 올바르지 않습니다'); }) : {};
    const m = path.match(/^\/api\/todos\/([^/]+)(?:\/(complete|delete|restore))?$/);

    // ── 읽기 ──
    if (request.method === 'GET' && path === '/api/todos') {
      const q = url.searchParams;
      return json(Object.assign({ ok: true }, await listTodos(db, { view: q.get('view') || 'today', company: q.get('company') || '', category: q.get('category') || '', query: q.get('q') || '', limit: Number(q.get('limit')) || 50 }, nowMs)), 200, cors);
    }
    if (request.method === 'GET' && m && !m[2]) return json({ ok: true, todo: await getTodo(db, decodeURIComponent(m[1]), nowMs) }, 200, cors);
    if (request.method === 'GET' && path === '/api/admin/migrate') {
      if (actor.via !== 'web') throw new AuthError('웹 화면 로그인으로만 할 수 있습니다', 403);
      return json(Object.assign({ ok: true }, await migratePreview(db)), 200, cors);
    }
    if (request.method === 'GET' && path === '/api/admin/auto') {
      if (actor.via !== 'web') throw new AuthError('웹 화면 로그인으로만 할 수 있습니다', 403);
      return json(Object.assign({ ok: true }, await previewAuto(db, nowMs)), 200, cors);
    }
    if (request.method === 'GET' && path === '/api/changes') {
      const q = url.searchParams;
      return json(Object.assign({ ok: true }, await changesSince(db, { since: q.get('since'), company: q.get('company') || '' }, nowMs)), 200, cors);
    }

    // ── 쓰기 ── (사람 이름 필수)
    if (actor.via === 'script') {
      if (request.method === 'POST' && path === '/api/ingest') {
        if (!INGEST_SOURCES.includes(body.source)) throw new RuleError('ingest 출처는 ' + INGEST_SOURCES.join('·') + ' 중 하나입니다');
        if (!body.sourceRef) throw new RuleError('sourceRef가 필요합니다(중복 방지)');
        actor.name = body.author || (body.source === 'voice' ? '음성' : body.source === 'secretary' ? '비서' : '공동');
        const { source, sourceRef, author, ...fields } = body;
        return json(Object.assign({ ok: true }, await createTodo(ctx, fields, { source, sourceRef })), 200, cors);
      }
      throw new AuthError('이 키로는 할 수 없는 요청입니다', 403);
    }
    requireAuthor(actor);
    if (request.method === 'POST' && path === '/api/admin/migrate') return json(Object.assign({ ok: true }, await migrateApply(ctx)), 200, cors);
    if (request.method === 'POST' && path === '/api/admin/auto') return json(Object.assign({ ok: true }, await runAuto(db, nowMs)), 200, cors);
    if (request.method === 'POST' && path === '/api/admin/rebizno') return json(Object.assign({ ok: true }, await rebizno(ctx, body.from, body.to)), 200, cors);
    if (request.method === 'POST' && path === '/api/todos') {
      const { source, sourceRef, ...fields } = body;
      const src = ['manual', 'lead', 'card'].includes(source) ? source : 'manual';
      return json(Object.assign({ ok: true }, await createTodo(ctx, fields, { source: src, sourceRef: src === 'manual' ? undefined : sourceRef })), 200, cors);
    }
    if (request.method === 'PATCH' && m && !m[2]) return json(Object.assign({ ok: true }, await updateTodo(ctx, decodeURIComponent(m[1]), body)), 200, cors);
    if (request.method === 'POST' && m && m[2] === 'complete') return json(Object.assign({ ok: true }, await completeTodo(ctx, decodeURIComponent(m[1]), body.note)), 200, cors);
    if (request.method === 'POST' && m && m[2] === 'delete') return json(Object.assign({ ok: true }, await deleteTodo(ctx, decodeURIComponent(m[1]), body.reason)), 200, cors);
    if (request.method === 'POST' && m && m[2] === 'restore') return json(Object.assign({ ok: true }, await restoreTodo(ctx, decodeURIComponent(m[1]))), 200, cors);
    return json({ ok: false, error: '없는 주소입니다' }, 404, cors);
  } catch (e) {
    if (e instanceof RuleError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, 400, cors);
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status, cors);
    if (e instanceof NotFoundError) return json({ ok: false, error: e.message }, 404, cors);
    console.error('[sg-todo] 처리 오류', e && e.stack || e);
    return json({ ok: false, error: '처리 중 오류가 났습니다: ' + String(e && e.message || e).slice(0, 200) }, 500, cors);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  // 매일 06:00(한국) — 자동 생성 + 휴지통 정리 (wrangler.toml [triggers])
  scheduled: (event, env, ctx) => ctx.waitUntil(
    runAuto(restDb({ projectId: env.FIREBASE_PROJECT, saKey: env.GCP_SA_KEY })).catch(e => console.error('[sg-todo 자동] 실패', e && e.stack || e))),
};
