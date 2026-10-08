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

test('칸 계산 — 기존 CRM 규칙 + 기다리는 중', () => {
  const b = (t) => core.bucket(Object.assign({ createdAt: NOW - DAY, statusAt: NOW - DAY }, t), core.RULES_DEFAULT, NOW);
  assert.equal(b({ status: 'wait', dueDate: '2026-10-05' }).col, 'miss');
  assert.match(b({ status: 'wait', dueDate: '2026-10-05' }).reason, /3일 지남/);
  assert.equal(b({ status: 'wait', dueDate: '2026-10-10' }).col, 'miss');        // 3일 이내 + 시작 안 함
  assert.equal(b({ status: 'ing', statusAt: NOW - 20 * DAY }).col, 'miss');      // 20일째 그대로
  assert.equal(b({ status: 'ing', dueDate: '2026-10-30' }).col, 'ing');
  assert.equal(b({ status: 'wait', dueDate: '2026-10-30' }).col, 'todo');
  assert.equal(b({ status: 'wait', dueDate: '2026-12-30' }).col, 'later');
  assert.equal(b({ status: 'wait' }).col, 'todo');
  assert.equal(b({ status: 'waiting', waitingFor: '서류 회신', dueDate: '2026-10-12' }).col, 'waiting');
  assert.equal(b({ status: 'waiting', dueDate: '2026-10-07' }).col, 'miss');
  assert.equal(b({ status: 'cancel' }).col, 'done');
  assert.equal(b({ status: 'wait', deletedAt: NOW }).col, 'trash');
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
  await assert.rejects(createTodo(ctxOf(db), { text: 'x', status: 'hold' }), /상태는/);
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
  const today = await listTodos(db, { view: 'today' }, NOW);
  assert.deepEqual(today.items.map(i => i.label), ['T-0001', 'T-0002']);
  assert.equal(today.items[0].col, 'miss');
  assert.equal((await listTodos(db, { view: 'open', company: '하이퍼다인' }, NOW)).total, 1);
  assert.equal((await listTodos(db, { view: 'week' }, NOW)).total, 2);
  await completeTodo(ctxOf(db, '김학미', 'web', NOW + 60000), 'T-0001');
  const g = await getTodo(db, 'T-0001', NOW);
  assert.equal(g.status, 'done'); assert.equal(g.history.length, 2);
  const ch = await changesSince(db, { since: NOW - 1000 }, NOW + 60000);
  assert.equal(ch.total, 4); assert.match(ch.items[0].summary, /김학미 · T-0001 .* 완료/);
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
