// 모의 시험: node --test worker/test/   (실제 Firestore·Cloudflare에 접속하지 않는다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import * as core from '../src/core.js';
import { createTodo, updateTodo, completeTodo, deleteTodo, restoreTodo, listTodos, getTodo, changesSince } from '../src/todos.js';
import { handle } from '../src/index.js';
import { _resetJwksCache } from '../src/auth.js';

const NOW = Date.parse('2026-10-08T03:00:00Z');   // 한국 시간 2026-10-08 12:00
const DAY = 86400000;
const COMPANIES = {
  'companies/111-11-11111': { name: '㈜하이퍼다인', active: 'Y' },
  'companies/222-22-22222': { name: '청림테크', active: 'Y' },
  'companies/333-33-33333': { name: '청림식품', active: 'Y' },
  'companies/TEMP-001': { name: '예비창업 김대표', active: 'Y' },
};
const seed = (extra = {}) => fakeDb(Object.assign({}, COMPANIES, extra));
const ctxOf = (db, name = '정석진', via = 'web', nowMs = NOW) => ({ db, actor: { name, via, email: 'sgceo@sgsolutionss.com' }, nowMs });
const acts = (db) => [...db.store.entries()].filter(([p]) => p.startsWith('activity/')).map(([, d]) => d);

// ── core ──
test('날짜 말 알아듣기', () => {
  assert.equal(core.parseDue('내일', NOW), '2026-10-09');
  assert.equal(core.parseDue('10/20', NOW), '2026-10-20');
  assert.equal(core.parseDue('10월 20일', NOW), '2026-10-20');
  assert.equal(core.parseDue('2026.11.3', NOW), '2026-11-03');
  assert.equal(core.parseDue('+7', NOW), '2026-10-15');
  assert.equal(core.parseDue('10/1', NOW), '2026-10-01');         // 조금 지난 날짜는 올해 그대로(놓친 일로 보임)
  assert.equal(core.parseDue('3/1', NOW), '2027-03-01');          // 한참 지난 월/일 → 내년
  assert.equal(core.parseDue('', NOW), '');
  assert.throws(() => core.parseDue('다음주쯤', NOW), core.RuleError);
  assert.throws(() => core.parseDue('2026-02-30', NOW), core.RuleError);
});

test('반복 다음 날짜 — 말일·요일', () => {
  assert.equal(core.nextRepeatDate('2026-01-31', { every: 'month', n: 1 }), '2026-02-28');
  assert.equal(core.nextRepeatDate('2026-10-08', { every: 'month', n: 1, day: 25 }), '2026-11-25');
  assert.equal(core.nextRepeatDate('2026-10-08', { every: 'week', n: 1, day: 1 }), '2026-10-19');   // 목 → 다음 주 이후 첫 월요일
  assert.equal(core.nextRepeatDate('2026-03-01', { every: 'year', n: 1 }), '2027-03-01');
});

test('세 칸 계산 — 시작일만 보고, 나머지는 꼬리표', () => {
  const b = (t) => core.bucket(Object.assign({ createdAt: NOW - DAY, statusAt: NOW - DAY, status: 'wait' }, t), core.RULES_DEFAULT, NOW);
  assert.equal(b({ startDate: '2026-10-08' }).col, 'ing');
  assert.equal(b({ startDate: '2026-10-08' }).reason, '오늘 시작');
  assert.equal(b({ startDate: '2026-10-06' }).reason, '+2일');
  assert.equal(b({ startDate: '2026-10-09' }).col, 'todo');
  assert.equal(b({ startDate: '2026-10-09' }).reason, '-1일');
  assert.equal(b({ startDate: '2026-10-13' }).reason, '-5일');
  assert.equal(b({}).col, 'ing');                                          // 시작일 없으면 등록한 날(어제) → 2일째
  assert.equal(b({}).reason, '+1일');
  // 마감은 꼬리표 — 지나면 빨강, 3일 안이면 주황
  const late = b({ startDate: '2026-10-01', dueDate: '2026-10-05' });
  assert.equal(late.col, 'ing'); assert.equal(late.alert, true); assert.deepEqual(late.tags, [{ t: '마감 3일 지남', tone: 'red' }]);
  assert.equal(b({ startDate: '2026-10-08', dueDate: '2026-10-10' }).tags[0].tone, 'amber');
  assert.equal(b({ startDate: '2026-10-20', dueDate: '2026-10-25' }).col, 'todo');   // 마감이 있어도 시작 전이면 예정 업무
  // 오래 끈 일 (14일째부터 빨강)
  assert.equal(b({ startDate: '2026-09-26' }).alert, false);               // 13일째
  assert.equal(b({ startDate: '2026-09-25' }).alert, true);                // 14일째
  // 긴급·기다림 꼬리표
  const w = b({ startDate: '2026-10-07', status: 'waiting', waitingFor: '고객 서류 회신', priority: 'high' });
  assert.equal(w.col, 'ing'); assert.deepEqual(w.tags.map(x => x.t), ['긴급', '⏳ 고객 서류 회신']);
  assert.equal(b({ status: 'done', doneAt: NOW }).col, 'done');
  assert.equal(b({ status: 'cancel' }).col, 'done');
  assert.equal(b({ deletedAt: NOW }).col, 'trash');
});

test('완료한 날 말 알아듣기', () => {
  assert.equal(core.parseDoneDate('', NOW), '2026-10-08');
  assert.equal(core.parseDoneDate('어제', NOW), '2026-10-07');
  assert.equal(core.parseDoneDate('그저께', NOW), '2026-10-06');
  assert.equal(core.parseDoneDate('3일 전', NOW), '2026-10-05');
  assert.equal(core.parseDoneDate('10/2', NOW), '2026-10-02');
  assert.equal(core.parseDoneDate('12/30', NOW), '2025-12-30');          // 앞날 월/일 → 작년
  assert.throws(() => core.parseDoneDate('내일', NOW), /앞날/);
  assert.throws(() => core.parseDoneDate('언젠가', NOW), core.RuleError);
  assert.throws(() => core.parseDoneDate('2026-10-09', NOW), /앞날/);
});

test('시작일 — 추가·미루기·지금 시작·완료한 날', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: '오늘 할 일' });
  await createTodo(ctxOf(db), { text: '다음 주 일', start: '10/13' });
  assert.equal(db.store.get('todos/T-0001').startDate, '2026-10-08');
  assert.equal(db.store.get('todos/T-0002').startDate, '2026-10-13');
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', start: '언젠가' }), /날짜/);
  // 미루기 → 예정 업무로, 「지금 시작」(ing) → 시작일 오늘로 당김
  await updateTodo(ctxOf(db), 'T-0001', { start: '+3' });
  assert.equal((await listTodos(db, { view: 'todo' }, NOW)).total, 2);
  await updateTodo(ctxOf(db), 'T-0002', { status: 'ing' });
  assert.equal(db.store.get('todos/T-0002').startDate, '2026-10-08');
  // 완료한 날 넣기 — 지난 날이면 그날 정오, 다시 열면 지움
  await completeTodo(ctxOf(db), 'T-0002', '', '10/6');
  let t = db.store.get('todos/T-0002');
  assert.equal(t.status, 'done'); assert.equal(t.doneAt, Date.parse('2026-10-06T12:00:00+09:00'));
  await assert.rejects(updateTodo(ctxOf(db), 'T-0002', { status: 'ing', doneDate: '어제' }), /일 때만/);
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', doneDate: '어제' }), /완료/);
  await updateTodo(ctxOf(db), 'T-0002', { status: 'wait' });
  assert.equal(db.store.get('todos/T-0002').doneAt, null);
  const done = await completeTodo(ctxOf(db), 'T-0002');                 // 날짜 없으면 지금
  assert.equal(done.todo.doneAt, NOW);
});

test('시작일 채우기 — 미리보기·적용·두 번 돌려도 안전', async () => {
  const { migrateStartPreview, migrateStartApply } = await import('../src/todos.js');
  const db = seed({
    'todos/T-0001': { no: 1, text: '옛 할 일', status: 'wait', createdAt: Date.parse('2026-09-01T01:00:00Z'), dueDate: '2026-12-01' },
    'todos/T-0002': { no: 2, text: '밤에 넣은 일', status: 'ing', createdAt: Date.parse('2026-10-07T16:00:00Z') },   // 한국 10/8 01시
    'todos/T-0003': { no: 3, text: '이미 있음', status: 'wait', startDate: '2026-10-20', createdAt: 1 },
    'todos/T-0004': { no: 4, text: '제안거리', status: 'idea', createdAt: 1 },   // 제안 업무는 날짜를 채우지 않는다
  });
  const pv = await migrateStartPreview(db, NOW);
  assert.equal(pv.count, 2); assert.equal(pv.already, 2);
  assert.deepEqual(pv.items.map(i => [i.label, i.startDate, i.col]), [['T-0001', '2026-09-01', 'ing'], ['T-0002', '2026-10-08', 'ing']]);
  assert.equal(pv.items[0].reason, '+37일 · 마감 D-54');
  assert.equal(db.store.get('todos/T-0001').startDate, undefined);       // 미리보기는 쓰지 않음
  const r = await migrateStartApply(ctxOf(db));
  assert.equal(r.applied, 2);
  assert.equal(db.store.get('todos/T-0001').startDate, '2026-09-01');
  assert.equal(db.store.get('todos/T-0003').startDate, '2026-10-20');
  assert.equal(db.store.get('todos/T-0004').startDate, undefined);
  assert.equal((await migrateStartApply(ctxOf(db))).applied, 0);
});

test('기업 찾기 — 이름·번호·여러 곳', () => {
  const list = Object.entries(COMPANIES).map(([p, d]) => ({ id: p.split('/')[1], ...d }));
  assert.equal(core.resolveCompany('하이퍼다인', list).company.id, '111-11-11111');
  assert.equal(core.resolveCompany('1111111111', list).company.id, '111-11-11111');
  assert.equal(core.resolveCompany('temp-001', list).company.id, 'TEMP-001');
  assert.equal(core.resolveCompany('청림', list).candidates.length, 2);
  assert.ok(core.resolveCompany('없는회사', list).none);
});

// ── 쓰기 ──
test('추가 — 번호 발급, 작성자, 기록, 글 속 기업 자동 연결', async () => {
  const db = seed({ 'app_state/todo_seq': { last: 122 } });
  const r = await createTodo(ctxOf(db), { text: '하이퍼다인 벤처 서류 독촉', due: '10/20' }, { source: 'chat', checkRecentDup: true });
  assert.equal(r.label, 'T-0123');
  const t = db.store.get('todos/T-0123');
  assert.equal(t.no, 123); assert.equal(t.status, 'wait'); assert.equal(t.dueDate, '2026-10-20');
  assert.equal(t.bizno, '111-11-11111'); assert.equal(t.companyName, '㈜하이퍼다인');
  assert.equal(t.createdBy, '정석진'); assert.equal(t.source, 'chat'); assert.equal(t.createdAt, NOW);
  assert.equal(db.store.get('app_state/todo_seq').last, 123);
  assert.equal(acts(db).length, 1); assert.equal(acts(db)[0].ref, 'T-0123'); assert.equal(acts(db)[0].action, 'create');
  // 채팅 재시도 — 2분 안에 같은 내용이면 새로 만들지 않음
  const again = await createTodo(ctxOf(db), { text: '하이퍼다인 벤처 서류 독촉', due: '10/20' }, { source: 'chat', checkRecentDup: true });
  assert.equal(again.created, false); assert.equal(again.label, 'T-0123');
});

test('추가 — 카운터 없으면 가장 큰 번호 다음, 같은 출처는 한 번만', async () => {
  const db = seed({ 'todos/old1': { no: 7, text: '옛 할 일', status: 'wait' } });
  const a = await createTodo(ctxOf(db, '자동', 'cron'), { text: '[청림테크] 벤처 갱신 준비', company: '222-22-22222', due: '2026-12-01' }, { source: 'cert', sourceRef: 'cert123' });
  assert.equal(a.label, 'T-0008');
  const b = await createTodo(ctxOf(db, '자동', 'cron'), { text: '[청림테크] 벤처 갱신 준비', company: '222-22-22222' }, { source: 'cert', sourceRef: 'cert123' });
  assert.equal(b.created, false); assert.equal(b.label, 'T-0008');
  assert.equal(db.store.get('todos/T-0008').dedupeKey, 'cert:cert123');
});

test('추가 — 거절되는 경우', async () => {
  const db = seed();
  await assert.rejects(createTodo(ctxOf(db), { text: '  ' }), /비어/);
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', status: 'done' }), /완료/);
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', status: 'pause' }), /상태는/);
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', no: 5 }), /바꿀 수 없는/);
  const e = await createTodo(ctxOf(db), { text: '서류', company: '청림' }).catch(x => x);
  assert.equal(e.extra.candidates.length, 2);                      // 여럿이면 저장하지 않고 후보
  assert.equal(db.store.size, Object.keys(COMPANIES).length);      // 아무것도 안 생김
});

test('완료 → 완료일, 다시 열기 → 완료일 지움, 손댄 시각', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: '노무사 소개', status: 'ing' });
  const later = NOW + 3 * DAY;
  await completeTodo(ctxOf(db, '김학미', 'web', later), 'T-0001', '소개 완료');
  let t = db.store.get('todos/T-0001');
  assert.equal(t.status, 'done'); assert.equal(t.doneAt, later); assert.equal(t.statusAt, later); assert.equal(t.updatedBy, '김학미');
  assert.match(t.memo, /완료: 소개 완료/);
  await updateTodo(ctxOf(db, '정석진', 'web', later + DAY), '1', { status: 'wait' });
  t = db.store.get('todos/T-0001');
  assert.equal(t.doneAt, null); assert.equal(t.status, 'wait');
  // 기업만 바꾸면 손댄 시각(statusAt)은 그대로
  await updateTodo(ctxOf(db, '정석진', 'web', later + 2 * DAY), 'T-1', { company: '하이퍼다인' });
  assert.equal(db.store.get('todos/T-0001').statusAt, later + DAY);
  const r = await updateTodo(ctxOf(db), 'T-0001', { company: '하이퍼다인' });   // 바뀐 것 없음
  assert.equal(r.changed, false);
  assert.equal(acts(db).filter(a => a.ref === 'T-0001').length, 4);
});

test('반복 — 완료하면 다음 회차 한 건', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: '월말 정산', due: '2026-10-31', repeat: { every: 'month', n: 1 } });
  const r = await completeTodo(ctxOf(db), 'T-0001');
  assert.equal(r.next.label, 'T-0002'); assert.equal(r.next.dueDate, '2026-11-30');
  const n = db.store.get('todos/T-0002');
  assert.equal(n.source, 'repeat'); assert.equal(n.seriesId, 'T-0001'); assert.deepEqual(n.repeat, { every: 'month', n: 1 });
  // 다시 열고 또 완료해도 같은 회차는 또 안 생김
  await updateTodo(ctxOf(db), 'T-0001', { status: 'wait' });
  const r2 = await completeTodo(ctxOf(db), 'T-0001');
  assert.equal(r2.next, null);
  assert.equal([...db.store.keys()].filter(k => k.startsWith('todos/')).length, 2);
});

test('삭제(휴지통) · 되살리기', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: '잘못 넣은 할 일' });
  const d = await deleteTodo(ctxOf(db), 'T-0001', '중복');
  assert.equal(d.purgeAfter, '2026-11-07');
  assert.equal(db.store.get('todos/T-0001').deletedBy, '정석진');
  await assert.rejects(updateTodo(ctxOf(db), 'T-0001', { status: 'ing' }), /휴지통/);
  assert.equal((await listTodos(db, { view: 'open' }, NOW)).total, 0);
  assert.equal((await listTodos(db, { view: 'trash' }, NOW)).total, 1);
  await restoreTodo(ctxOf(db), 'T-0001');
  assert.equal(db.store.get('todos/T-0001').deletedAt, null);
  assert.equal((await listTodos(db, { view: 'open' }, NOW)).total, 1);
  await assert.rejects(updateTodo(ctxOf(db), 'T-0099', { status: 'ing' }), /없는 할 일/);
});

test('조회 · 상세 · 변동', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: '하이퍼다인 서류 요청', due: '2026-10-01' });          // 놓침
  await createTodo(ctxOf(db), { text: '심사원 회신', status: 'waiting', waitingFor: '심사원', due: '2026-10-15' });
  await createTodo(ctxOf(db), { text: '연간신고', due: '2027-04-30' });                     // 앞으로
  await createTodo(ctxOf(db), { text: '다음 달 일', start: '11/2' });                          // 예정 업무
  const today = await listTodos(db, { view: 'today' }, NOW);                                 // 예전 이름 today = open
  assert.deepEqual(today.items.map(i => i.label), ['T-0001', 'T-0002', 'T-0003', 'T-0004']);  // 빨간 표시(마감 지남) 먼저, 예정 업무는 뒤
  assert.equal(today.items[0].alert, true); assert.equal(today.items[3].col, 'todo');
  assert.equal((await listTodos(db, { view: 'missed' }, NOW)).total, 1);
  assert.equal((await listTodos(db, { view: 'open', company: '하이퍼다인' }, NOW)).total, 1);
  assert.equal((await listTodos(db, { view: 'week' }, NOW)).total, 2);
  await completeTodo(ctxOf(db, '김학미', 'web', NOW + 60000), 'T-0001');
  const g = await getTodo(db, 'T-0001', NOW);
  assert.equal(g.status, 'done'); assert.equal(g.history.length, 2);
  const ch = await changesSince(db, { since: NOW - 1000 }, NOW + 60000);
  assert.equal(ch.total, 5); assert.match(ch.items[0].summary, /김학미 · T-0001 .* 완료/);
});

// ── HTTP + 로그인 토큰 ──
async function makeAuth() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = Object.assign(await crypto.subtle.exportKey('jwk', kp.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (payload) => {
    const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64(payload);
    const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return h + '.' + p + '.' + Buffer.from(s).toString('base64url');
  };
  const fetchFn = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });
  return { sign, fetchFn };
}
const ENV = { FIREBASE_PROJECT: 'sg-crm-f9adc', ALLOWED_EMAILS: 'sgceo@sgsolutionss.com', ALLOWED_ORIGINS: 'https://sggit-png.github.io', INGEST_KEY: 'k-test' };
const idPayload = (o = {}) => Object.assign({ aud: 'sg-crm-f9adc', iss: 'https://securetoken.google.com/sg-crm-f9adc', sub: 'u1', email: 'sgceo@sgsolutionss.com', email_verified: true, iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 3000 }, o);

test('HTTP — 로그인·작성자·CORS·스크립트 키', async () => {
  _resetJwksCache();
  const { sign, fetchFn } = await makeAuth();
  const db = seed();
  const call = (method, path, { token, user, body, key, origin } = {}) => handle(new Request('https://sg-todo.sgsolution.workers.dev' + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}, user ? { 'x-sg-user': encodeURIComponent(user) } : {},
      key ? { 'x-api-key': key } : {}, origin ? { origin } : {}),
  }), ENV, { db, fetchFn, nowMs: NOW });

  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/api/todos')).status, 401);                                           // 로그인 없음
  assert.equal((await call('GET', '/api/todos', { token: await sign(idPayload({ email: 'x@gmail.com' })) })).status, 403);
  assert.equal((await call('GET', '/api/todos', { token: await sign(idPayload({ exp: Math.floor(NOW / 1000) - 600 })) })).status, 401);
  assert.equal((await call('GET', '/api/todos', { token: await sign(idPayload({ aud: 'other' })) })).status, 401);
  const tok = await sign(idPayload());
  const forged = tok.slice(0, -4) + (tok.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.equal((await call('GET', '/api/todos', { token: forged })).status, 401);                        // 서명 위조
  assert.equal((await call('GET', '/api/todos', { token: tok })).status, 200);
  const noUser = await call('POST', '/api/todos', { token: tok, body: { text: '테스트' } });
  assert.equal(noUser.status, 400);                                                                       // 작성자 없음
  const ok = await call('POST', '/api/todos', { token: tok, user: '김학미', body: { text: '테스트', due: '내일' }, origin: 'https://sggit-png.github.io' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://sggit-png.github.io');
  const j = await ok.json(); assert.equal(j.label, 'T-0001'); assert.equal(j.todo.createdBy, '김학미');
  const bad = await call('PATCH', '/api/todos/T-0001', { token: tok, user: '김학미', body: { status: 'nope' } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /상태는/);
  assert.equal((await call('POST', '/api/todos/T-0001/complete', { token: tok, user: '정석진', body: {} })).status, 200);
  assert.equal((await call('GET', '/api/todos/T-0009', { token: tok })).status, 404);
  // 드라이브 스크립트 키 — ingest만, 같은 sourceRef는 한 번만
  assert.equal((await call('POST', '/api/ingest', { key: 'wrong', body: {} })).status, 403);
  const ing = await call('POST', '/api/ingest', { key: 'k-test', body: { text: '청림테크 전화', source: 'voice', sourceRef: 'task:abc' } });
  assert.equal(ing.status, 200);
  const ij = await ing.json(); assert.equal(ij.todo.createdBy, '음성'); assert.equal(ij.todo.bizno, '222-22-22222');
  assert.equal((await (await call('POST', '/api/ingest', { key: 'k-test', body: { text: '청림테크 전화', source: 'voice', sourceRef: 'task:abc' } })).json()).created, false);
  assert.equal((await call('POST', '/api/todos', { key: 'k-test', body: { text: 'x' } })).status, 403);   // 키로 일반 쓰기 불가
  const pre = await call('OPTIONS', '/api/todos', { origin: 'https://evil.example' });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('연결 확인 주소 — 내용 없이 연결 여부만', async () => {
  const okRes = await handle(new Request('https://x/health?check=firestore'), ENV, { db: seed({ 'app_state/config': { secret: 'x' } }), nowMs: NOW });
  const j = await okRes.json();
  assert.equal(okRes.status, 200); assert.equal(j.firestore, '연결됨'); assert.equal(JSON.stringify(j).includes('secret'), false);
  const bad = await handle(new Request('https://x/health?check=firestore'), Object.assign({}, ENV, { GCP_SA_KEY: '' }), { nowMs: NOW });
  assert.equal(bad.status, 503); assert.match((await bad.json()).firestore, /GCP_SA_KEY/);
});

test('기존 할 일 번호 붙이기 — 미리보기·적용·두 번 돌려도 안전', async () => {
  const { migratePreview, migrateApply } = await import('../src/todos.js');
  const db = seed({
    'todos/abc': { text: '김종지 대표 연락', status: 'wait', createdAt: 3000 },
    'todos/old': { text: '하이퍼다인 벤처인증', status: 'ing', createdAt: 1000 },
    'todos/cert1': { text: '[청림테크] 벤처 갱신 준비', status: 'done', certTaskId: 'C9', createdAt: 2000, updatedAt: 2500 },
    'todos/voice_x': { text: '주식 확인하기', status: 'wait', source: 'voice', sourceRef: 'task:T1', createdAt: 4000 },
  });
  const pv = await migratePreview(db);
  assert.equal(pv.count, 4);
  assert.deepEqual(pv.items.map(i => i.docId), ['old', 'cert1', 'abc', 'voice_x']);   // 오래된 순
  assert.equal(db.store.get('todos/old').no, undefined);                               // 미리보기는 쓰지 않음
  const r = await migrateApply(ctxOf(db));
  assert.equal(r.applied, 4); assert.equal(r.first, 'T-0001'); assert.equal(r.last, 'T-0004');
  assert.equal(db.store.get('todos/old').no, 1);
  const c = db.store.get('todos/cert1');
  assert.equal(c.source, 'cert'); assert.equal(c.dedupeKey, 'cert:C9'); assert.equal(c.doneAt, 2500);
  assert.equal(db.store.get('todos/voice_x').dedupeKey, 'voice:task:T1');
  assert.equal(db.store.get('todos/abc').source, 'manual');
  assert.equal(db.store.get('app_state/todo_seq').last, 4);
  assert.equal((await migrateApply(ctxOf(db))).applied, 0);                             // 두 번째는 할 것 없음
  // 그 뒤 새 할 일은 T-0005, 번호로 고칠 수 있음
  assert.equal((await createTodo(ctxOf(db), { text: '새 할 일' })).label, 'T-0005');
  await completeTodo(ctxOf(db), 'T-0002');
  assert.equal(db.store.get('todos/old').status, 'ing');
  assert.equal(db.store.get('todos/cert1').status, 'done');
});

test('드라이브 스크립트 ingest — 채팅 출처·작성자 이름', async () => {
  const db = seed();
  const r = await handle(new Request('https://x/api/ingest', { method: 'POST', headers: { 'x-api-key': 'k-test', 'content-type': 'application/json' },
    body: JSON.stringify({ text: '하이퍼다인 전화', source: 'chat', sourceRef: 'task:Z1', author: '김학미', due: '2026-10-20', memo: '채팅 할 일' }) }), ENV, { db, nowMs: NOW });
  assert.equal(r.status, 200);
  const t = db.store.get('todos/T-0001');
  assert.equal(t.source, 'chat'); assert.equal(t.createdBy, '김학미'); assert.equal(t.dedupeKey, 'chat:task:Z1'); assert.equal(t.bizno, '111-11-11111');
  const chk = await handle(new Request('https://x/api/ingest', { method: 'POST', headers: { 'x-api-key': 'k-test' }, body: JSON.stringify({ source: 'voice' }) }), ENV, { db, nowMs: NOW });
  assert.equal(chk.status, 400); assert.match((await chk.json()).error, /sourceRef/);
});

test('제안 업무 — 날짜는 사람이 넣을 때만, 와도 제안 칸에 머묾, 맡으면 하고 있는·예정 업무로 (A안)', async () => {
  const db = seed();
  // 날짜 없이 넣으면 비어 있다(등록한 날로 채우지 않음)
  await createTodo(ctxOf(db), { text: 'ISO 인증 제안', company: '하이퍼다인', status: 'idea' });
  let t = db.store.get('todos/T-0001');
  assert.equal(t.status, 'idea'); assert.equal(t.startDate, ''); assert.equal(t.dueDate, '');
  const later = NOW + 20 * DAY;
  let b = core.bucket(t, core.RULES_DEFAULT, later);
  assert.equal(b.col, 'idea'); assert.equal(b.alert, false); assert.equal(b.reason, '등록 20일 전');
  assert.equal(core.startOf(t, later), '');
  // 사람이 날짜를 넣으면 저장·표시만 — 시작일이 와도 제안 칸, 종료일이 지나도 빨간 표시 없이 회색
  await updateTodo(ctxOf(db), 'T-0001', { start: '10/20', due: '11/5' });
  t = db.store.get('todos/T-0001');
  assert.equal(t.startDate, '2026-10-20'); assert.equal(t.dueDate, '2026-11-05');
  b = core.bucket(t, core.RULES_DEFAULT, NOW);
  assert.equal(b.col, 'idea'); assert.deepEqual(b.tags, [{ t: '시작 10/20', tone: 'plain' }, { t: '종료 11/05', tone: 'plain' }]);
  b = core.bucket(t, core.RULES_DEFAULT, later);                       // 10/28 — 시작일 지남
  assert.equal(b.col, 'idea'); assert.equal(b.alert, false);
  b = core.bucket(t, core.RULES_DEFAULT, NOW + 30 * DAY);              // 11/7 — 종료일 지남
  assert.equal(b.col, 'idea'); assert.equal(b.alert, false); assert.deepEqual(b.tags[1], { t: '종료일 지남', tone: 'mute' });
  assert.equal((await listTodos(db, { view: 'open' }, later)).total, 0);
  assert.equal((await listTodos(db, { view: 'idea' }, later)).total, 1);
  assert.equal((await listTodos(db, { view: 'all', company: '하이퍼다인' }, later)).total, 1);
  // 날짜를 다시 비울 수도 있다
  await updateTodo(ctxOf(db), 'T-0001', { start: '', due: '' });
  t = db.store.get('todos/T-0001');
  assert.equal(t.startDate, ''); assert.equal(t.dueDate, '');
  // 맡게 됨(지금 시작) → 시작일 = 그날
  const r = await updateTodo(ctxOf(db, '정석진', 'web', later), 'T-0001', { status: 'ing' });
  t = db.store.get('todos/T-0001');
  assert.equal(t.startDate, '2026-10-28');
  b = core.bucket(t, core.RULES_DEFAULT, later);
  assert.equal(b.col, 'ing'); assert.equal(b.days, 1);
  assert.match(acts(db).at(-1).summary, /제안 → 진행/); assert.ok(r.changes.startDate);
  // 날짜를 정해 맡기 → 예정 업무
  await createTodo(ctxOf(db), { text: '연구소 설립 제안', status: 'idea' });
  await updateTodo(ctxOf(db), 'T-0002', { status: 'wait', start: '10/20' });
  assert.equal(core.bucket(db.store.get('todos/T-0002'), core.RULES_DEFAULT, NOW).col, 'todo');
  // 제안에 적어 둔 시작일이 있으면 start 없이 맡아도 그 날부터
  await createTodo(ctxOf(db), { text: '벤처 제안', status: 'idea', start: '10/15', due: '10/30' });
  assert.equal(db.store.get('todos/T-0003').startDate, '2026-10-15');
  await updateTodo(ctxOf(db), 'T-0003', { status: 'wait' });
  assert.equal(db.store.get('todos/T-0003').startDate, '2026-10-15');
  assert.equal(core.bucket(db.store.get('todos/T-0003'), core.RULES_DEFAULT, NOW).col, 'todo');
  // 보통 할 일을 제안으로 돌리면 저절로 들어간 시작일은 비우고, 마감은 둔다
  await createTodo(ctxOf(db), { text: '특허 제안', due: '10/30' });
  assert.equal(db.store.get('todos/T-0004').startDate, '2026-10-08');
  await updateTodo(ctxOf(db), 'T-0004', { status: 'idea' });
  const t4 = db.store.get('todos/T-0004');
  assert.equal(t4.startDate, ''); assert.equal(t4.dueDate, '2026-10-30'); assert.equal(core.bucket(t4, core.RULES_DEFAULT, NOW).col, 'idea');
  // 보통 할 일은 시작일을 비우라고 해도 오늘
  await createTodo(ctxOf(db), { text: '보통 일', start: '10/20' });
  await updateTodo(ctxOf(db), 'T-0005', { start: '' });
  assert.equal(db.store.get('todos/T-0005').startDate, '2026-10-08');
});


test('업무 분야(중분류) — 이름으로 와도 id로', async () => {
  assert.equal(core.normCategory('정책자금'), 'policy');
  assert.equal(core.normCategory('벤처'), 'ven');
  assert.equal(core.normCategory('메인비즈'), 'ven');
  assert.equal(core.normCategory('ISO'), 'iso');
  assert.equal(core.normCategory('기타'), 'etc');
  assert.equal(core.normCategory('fin'), 'fin');
  assert.equal(core.normCategory('우리만의분야'), '우리만의분야');   // 모르는 말은 그대로
  const db = seed();
  await createTodo(ctxOf(db), { text: '중진공 서류', category: '정책자금' });
  assert.equal(db.store.get('todos/T-0001').category, 'policy');
});

test('제안을 취소·완료했다가 다시 열면 제안으로 돌아감 · 옛 분야 값(「ISO」)도 제 분야로', async () => {
  const db = seed();
  await createTodo(ctxOf(db), { text: 'ISO 인증 제안', status: 'idea' });
  await updateTodo(ctxOf(db), 'T-0001', { status: 'cancel' });
  assert.equal(db.store.get('todos/T-0001').fromIdea, true);
  const r = await updateTodo(ctxOf(db), 'T-0001', { status: 'wait' });   // 웹 「다시 열기」
  assert.equal(r.todo.status, 'idea'); assert.equal(db.store.get('todos/T-0001').fromIdea, null);
  assert.equal(core.bucket(db.store.get('todos/T-0001'), core.RULES_DEFAULT, NOW).col, 'idea');
  // 제안을 맡았다가(진행) 완료 → 다시 열면 보통 할 일
  await updateTodo(ctxOf(db), 'T-0001', { status: 'ing' });
  await completeTodo(ctxOf(db), 'T-0001');
  assert.ok(!db.store.get('todos/T-0001').fromIdea);
  assert.equal((await updateTodo(ctxOf(db), 'T-0001', { status: 'wait' })).todo.status, 'wait');
  assert.equal(core.normCategory('ISO'), 'iso');
});

test('📞 통화 — 시각 말 알아듣기 · 통화 칸 · 놓친 통화 · 업무 칸에서 빠짐', async () => {
  assert.equal(core.parseCallTime('14:00'), '14:00');
  assert.equal(core.parseCallTime('오후 2시'), '14:00');
  assert.equal(core.parseCallTime('2시 반'), '14:30');          // 오전/오후 없이 1~7시는 오후
  assert.equal(core.parseCallTime('오전 10시 30분'), '10:30');
  assert.equal(core.parseCallTime('9시'), '09:00');
  assert.equal(core.parseCallTime('1430'), '14:30');
  assert.equal(core.parseCallTime(''), '');
  assert.throws(() => core.parseCallTime('점심 때'), core.RuleError);
  const db = seed();
  // 시각을 넣으면 통화(kind call)로
  await createTodo(ctxOf(db), { text: '김태후 대표 통화 — 중진공 서류', company: '청림테크', start: '내일', time: '오후 2시' });
  let t = db.store.get('todos/T-0001');
  assert.equal(t.kind, 'call'); assert.equal(t.callTime, '14:00'); assert.equal(t.startDate, '2026-10-09');
  let b = core.bucket(t, core.RULES_DEFAULT, NOW);
  assert.equal(b.col, 'call'); assert.equal(b.reason, '내일 14:00'); assert.equal(b.alert, false);
  // 시각 없는 통화
  await createTodo(ctxOf(db), { text: '베베볼 서류 요청 전화', kind: 'call' });
  assert.equal(core.bucket(db.store.get('todos/T-0002'), core.RULES_DEFAULT, NOW).reason, '오늘 시간 미정');
  // 날짜가 지나면 놓친 통화
  b = core.bucket(t, core.RULES_DEFAULT, NOW + 3 * DAY);
  assert.equal(b.col, 'call'); assert.equal(b.alert, true); assert.match(b.reason, /놓친 통화/);
  // 업무 칸(open)에는 안 나오고 통화 보기에만, 날짜·시각 순
  await createTodo(ctxOf(db), { text: '일반 업무' });
  await createTodo(ctxOf(db), { text: '아침 통화', start: '내일', time: '9시' });
  assert.deepEqual((await listTodos(db, { view: 'open' }, NOW)).items.map(i => i.label), ['T-0003']);
  assert.deepEqual((await listTodos(db, { view: 'call' }, NOW)).items.map(i => i.label), ['T-0002', 'T-0004', 'T-0001']);
  // 시각 바꾸기 · 통화했으면 완료
  await updateTodo(ctxOf(db), 'T-0001', { time: '16:30' });
  assert.equal(db.store.get('todos/T-0001').callTime, '16:30');
  await completeTodo(ctxOf(db), 'T-0001', '서류 다음 주 보내기로');
  assert.equal(core.bucket(db.store.get('todos/T-0001'), core.RULES_DEFAULT, NOW).col, 'done');
});

test('⏸ 장기 대기 — 넘기면 장기 대기 칸·빨간 표시 없음, 다시 진행하면 오늘부터', async () => {
  const db = seed();
  const old = NOW - 40 * DAY;
  await createTodo(ctxOf(db, '정석진', 'web', old), { text: '오래 기다리는 일', company: '청림테크', due: '2026-09-20' });
  let t = (await listTodos(db, { view: 'ing' }, NOW)).items[0];
  assert.equal(t.col, 'ing'); assert.equal(t.alert, true);   // 오래 끈 일 + 마감 지남 → 빨강
  // 장기 대기로 넘김(무엇을 기다리는지 함께)
  await updateTodo(ctxOf(db), 'T-1', { status: 'hold', waitingFor: '정부 공고' });
  assert.equal((await listTodos(db, { view: 'ing' }, NOW)).total, 0);
  t = (await listTodos(db, { view: 'hold' }, NOW)).items[0];
  assert.equal(t.col, 'hold'); assert.equal(t.alert, false);
  assert.match(t.reason, /오늘 대기 시작/); assert.match(t.reason, /정부 공고/); assert.match(t.reason, /마감 지남/);
  assert.match(acts(db).at(-1).summary, /장기 대기/);
  // 열흘 뒤 메모를 고쳐도 「대기 N일째」는 대기 시작한 날 기준
  await updateTodo(ctxOf(db, '정석진', 'web', NOW + 10 * DAY), 'T-1', { memo: '공고 다음 달' });
  t = (await listTodos(db, { view: 'hold' }, NOW + 10 * DAY)).items[0];
  assert.match(t.reason, /대기 10일째/);
  assert.equal((await listTodos(db, { view: 'all' }, NOW + 10 * DAY)).total, 1);   // 기업별 보기에는 들어감
  assert.equal((await listTodos(db, { view: 'open' }, NOW + 10 * DAY)).total, 0);  // 진행·예정 업무에는 안 들어감
  // 다시 진행 → 시작일 오늘, 진행 업무 「오늘 시작」
  const r = await updateTodo(ctxOf(db, '정석진', 'web', NOW + 12 * DAY), 'T-1', { status: 'ing' });
  assert.equal(r.todo.startDate, core.kstToday(NOW + 12 * DAY));
  t = (await listTodos(db, { view: 'ing' }, NOW + 12 * DAY)).items[0];
  assert.equal(t.col, 'ing'); assert.match(t.reason, /오늘 시작/);
  assert.equal(db.store.get('todos/T-0001').holdAt, null);
});

test('화면 글 — 업무 먼저, 회사 이름은 칩으로(글 앞의 회사 이름 떼기)', () => {
  const tt = (text, companyName) => core.taskText({ text, companyName });
  assert.equal(tt('하이퍼다인 ISO 인증 제안', '주식회사 하이퍼다인'), 'ISO 인증 제안');
  assert.equal(tt('더퍼스트 남윤환 대표 법인신용등급 요청 확인', '더 퍼스트 주식회사 농업회사법인'), '남윤환 대표 법인신용등급 요청 확인');
  assert.equal(tt('[청림테크] ISO 차기심사 준비', '청림테크'), 'ISO 차기심사 준비');
  assert.equal(tt('(주)청림테크 — 견적 보내기', '주식회사 청림테크'), '견적 보내기');
  assert.equal(tt('세웅바이오 심사보고서 제출', '(유)세웅바이오'), '심사보고서 제출');
  assert.equal(tt('하이퍼다인에 연락', '주식회사 하이퍼다인'), '하이퍼다인에 연락');   // 낱말이 이어지면 그대로
  assert.equal(tt('청림테크', '청림테크'), '청림테크');                                // 다 떼면 남는 게 없으니 그대로
  assert.equal(tt('동우이엔지 · 반석 대신 자금조달', ''), '동우이엔지 · 반석 대신 자금조달');   // 회사 연결 없으면 그대로
});
