// 📣 광고 DB 시험 — 메모리 DB·가짜 Meta로만. 실제 Firestore·Meta에 접속하지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import {
  classifyProduct, normPhone, mapFields, fromMetaLead, fromSheetRow, leadState, applyLeadAction, nextBizDay,
  importLeads, actLead, listLeads, leadStats, syncMeta, leadLabel, parseLeadNo, SYNC_PATH,
} from '../src/leads.js';
import { callTool } from '../src/mcp.js';

const NOW = Date.parse('2026-10-13T01:00:00Z');   // 한국 2026-10-13(화) 10:00
const H = 3600000;
const actor = { name: '정석진', via: 'web' };
const db0 = () => fakeDb({ 'companies/111-11-11111': { name: '㈜하이퍼다인', active: 'Y' } });
const metaLead = (id, phone, hoursAgo, extra = []) => ({
  id, created_time: new Date(NOW - hoursAgo * H).toISOString().replace('.000Z', '+0000'),
  field_data: [{ name: 'full_name', values: ['홍길동' + id] }, { name: 'phone_number', values: [phone] }, { name: '회사명', values: ['길동산업'] }, ...extra],
  ad_name: '', campaign_name: '', form_id: 'f1',
});

test('광고 종류·전화번호·질문 알아듣기', () => {
  assert.equal(classifyProduct('ISO 9001 무료 진단 양식'), 'iso');
  assert.equal(classifyProduct('벤처기업 인증 상담'), 'venture');
  assert.equal(classifyProduct('ESG 경영 인증'), 'esg');
  assert.equal(classifyProduct('기업인증 패키지'), 'cert');
  assert.equal(classifyProduct('이벤트'), 'etc');
  assert.deepEqual(normPhone('+821012345678'), { display: '010-1234-5678', key: '01012345678' });
  assert.deepEqual(normPhone('p:010 1234 5678'), { display: '010-1234-5678', key: '01012345678' });
  assert.equal(normPhone('1012345678').display, '010-1234-5678');   // 엑셀이 앞 0을 지움
  assert.equal(normPhone('0212345678').display, '02-1234-5678');
  const f = mapFields([['full_name', '김철수'], ['phone_number', '01011112222'], ['회사명', '철수전자'], ['인증 희망 시기', '연내'], ['id', 'l:1']]);
  assert.equal(f.name, '김철수'); assert.equal(f.phone, '01011112222'); assert.equal(f.company, '철수전자');
  assert.deepEqual(f.extras, [['인증 희망 시기', '연내']]);
  const m = fromMetaLead(metaLead('9', '+821099998888', 2), { id: 'f1', name: 'ESG 인증 상담' });
  assert.equal(m.product, 'esg'); assert.equal(m.metaId, '9'); assert.equal(m.receivedAt, NOW - 2 * H);
  const r = fromSheetRow({ id: 'l:777', created_time: '2026-10-12T09:00:00+0900', form_name: '', full_name: '이영희', phone_number: 'p:+821033334444' }, '벤처');
  assert.equal(r.metaId, '777'); assert.equal(r.product, 'venture'); assert.equal(r.phone, 'p:+821033334444');
  assert.equal(r.receivedAt, Date.parse('2026-10-12T00:00:00Z'));
  assert.equal(leadLabel(12), 'D-0012'); assert.equal(parseLeadNo('d-12'), 12); assert.equal(parseLeadNo('D-0012'), 12);
});

test('칸 계산 — 새 DB 24시간 지나면 빨강, 재통화 날짜', () => {
  assert.deepEqual([leadState({ status: 'new', receivedAt: NOW - 3 * H }, NOW).col, leadState({ status: 'new', receivedAt: NOW - 3 * H }, NOW).alert], ['new', false]);
  assert.equal(leadState({ status: 'new', receivedAt: NOW - 25 * H }, NOW).alert, true);
  assert.equal(leadState({ status: 'noans', tries: 1, nextCallDate: '2026-10-13' }, NOW).col, 'call');
  assert.equal(leadState({ status: 'noans', tries: 1, nextCallDate: '2026-10-12' }, NOW).alert, true);
  assert.equal(leadState({ status: 'noans', tries: 1, nextCallDate: '2026-10-14' }, NOW).col, 'later');
  assert.equal(leadState({ status: 'talk', nextCallDate: '' }, NOW).col, 'later');
  assert.equal(leadState({ status: 'won' }, NOW).col, 'closed');
  assert.equal(nextBizDay('2026-10-16'), '2026-10-19');   // 금 → 월
  assert.equal(nextBizDay('2026-10-13'), '2026-10-14');
});

test('부재 3번이면 연락 안 됨 · 상담 · 약속 · 다시 열기', () => {
  let l = { no: 1, status: 'new', tries: 0 };
  let r = applyLeadAction(l, 'noans', {}, NOW); l = { ...l, ...r.write };
  assert.equal(l.status, 'noans'); assert.equal(l.tries, 1); assert.equal(l.nextCallDate, '2026-10-14');
  r = applyLeadAction(l, 'noans', {}, NOW); l = { ...l, ...r.write };
  assert.equal(l.tries, 2);
  r = applyLeadAction(l, 'noans', {}, NOW); l = { ...l, ...r.write };
  assert.equal(l.status, 'unreach'); assert.match(r.what, /연락 안 됨/);
  assert.throws(() => applyLeadAction(l, 'noans', {}, NOW), /이미 끝났습니다/);
  r = applyLeadAction(l, 'reopen', {}, NOW); l = { ...l, ...r.write };
  assert.equal(l.status, 'noans'); assert.equal(l.tries, 2); assert.equal(l.nextCallDate, '2026-10-13');
  r = applyLeadAction({ no: 2, status: 'new' }, 'talk', { date: '모레', time: '오후 3시', memo: '견적 원함' }, NOW);
  assert.deepEqual([r.write.status, r.write.nextCallDate, r.write.nextCallTime], ['talk', '2026-10-15', '15:00']);
  assert.match(r.write.memo, /10\/13 견적 원함/);
  assert.throws(() => applyLeadAction({ status: 'new' }, 'schedule', {}, NOW), /date/);
  assert.throws(() => applyLeadAction({ status: 'new' }, 'fly', {}, NOW), /동작은/);
});

test('넣기 — 번호·중복(같은 Meta ID, 같은 광고+같은 번호)·기록', async () => {
  const db = db0();
  const ctx = { db, actor, nowMs: NOW };
  const items = [
    fromMetaLead(metaLead('a1', '01011112222', 5), { name: 'ISO 심사 상담' }),
    fromMetaLead(metaLead('a2', '01033334444', 3), { name: 'ESG 인증' }),
  ];
  let r = await importLeads(ctx, items);
  assert.deepEqual(r.created.map(c => c.label), ['D-0001', 'D-0002']);
  assert.equal(db.store.get('leads/D-0001').status, 'new');
  assert.equal(db.store.get('leads/D-0001').assignee, '정석진');
  assert.equal(db.store.get('leads/D-0001').phone, '010-1111-2222');
  // 같은 Meta ID 다시 → 건너뜀, 같은 번호지만 다른 광고 → 새로
  r = await importLeads(ctx, [items[0], fromMetaLead(metaLead('a3', '010-1111-2222', 1), { name: '벤처 인증' }), fromSheetRow({ full_name: 'x', phone_number: '01011112222' }, 'ISO')]);
  assert.deepEqual(r.created.map(c => c.label), ['D-0003']); assert.equal(r.skipped, 2);
  assert.equal(db.store.get('app_state/lead_seq').last, 3);
  const acts = [...db.store.entries()].filter(([p]) => p.startsWith('activity/')).map(([, d]) => d.summary);
  assert.ok(acts.some(s => /광고 DB 2건 들어옴 \(ISO심사 1·ESG인증 1\)/.test(s)), acts.join('|'));
});

test('전화 결과 → 고객 전환이면 할 일 생김 · 목록·성과', async () => {
  const db = db0();
  const ctx = { db, actor, nowMs: NOW };
  await importLeads(ctx, [fromMetaLead(metaLead('b1', '01055556666', 30), { name: 'ISO' }), fromMetaLead(metaLead('b2', '01077778888', 2), { name: '벤처' })]);
  let l = await listLeads(db, {}, NOW);
  assert.equal(l.counts.new, 2); assert.equal(l.counts.alert, 1);
  assert.equal(l.leads[0].label, 'D-0001');   // 오래된 새 DB 먼저
  const r1 = await actLead(ctx, 'D-1', 'noans', {});
  assert.match(r1.what, /부재 1번째/);
  const r2 = await actLead(ctx, 2, 'won', { memo: '계약 진행' });
  assert.equal(r2.todo, 'T-0001');
  const t = db.store.get('todos/T-0001');
  assert.match(t.text, /\[벤처인증 광고\] 홍길동b2\(길동산업\) 상담 진행/); assert.equal(t.category, 'ven'); assert.equal(t.source, 'lead');
  l = await listLeads(db, { view: 'today' }, NOW);
  assert.equal(l.total, 0);   // D-1은 내일 재통화, D-2는 끝
  l = await listLeads(db, { view: 'later' }, NOW + 24 * H);
  assert.equal(l.total, 0);
  l = await listLeads(db, { view: 'call' }, NOW + 24 * H);
  assert.equal(l.leads[0].label, 'D-0001');
  l = await listLeads(db, { view: 'all', query: '7777-8888' }, NOW);
  assert.equal(l.leads[0].label, 'D-0002');
  const st = await leadStats(db, {}, NOW);
  assert.deepEqual(st.find(s => s.product === 'venture'), { product: 'venture', label: '벤처인증', received: 1, reached: 1, won: 1, lost: 0, unreach: 0, waiting: 0 });
  await assert.rejects(() => actLead(ctx, 'D-9', 'noans', {}), /없는 광고 DB/);
});

test('Meta에서 가져오기 — 토큰 없으면 건너뜀 · 양식별로 가져와 넣고 다음엔 이어서', async () => {
  const db = db0();
  assert.equal((await syncMeta({}, db, { nowMs: NOW })).skipped, true);
  const calls = [];
  const fetchFn = async (url, opt) => {
    calls.push(url);
    assert.equal(opt.headers.authorization, 'Bearer tok');
    if (url.includes('/leadgen_forms')) return Response.json({ data: [{ id: 'F1', name: 'ISO 심사 무료상담' }, { id: 'F2', name: 'ESG 인증 문의' }] });
    // 진짜 Meta처럼 filtering(time_created > since)을 지킨다
    const since = url.includes('filtering=') ? JSON.parse(decodeURIComponent(url.split('filtering=')[1]))[0].value * 1000 : 0;
    const after = (arr) => arr.filter(l => Date.parse(l.created_time.replace(/\+0000$/, 'Z')) > since);
    if (url.includes('/F1/leads')) return Response.json({ data: after([metaLead('m1', '01012121212', 4)]) });
    if (url.includes('/F2/leads')) return Response.json({ data: after([metaLead('m2', '01034343434', 1)]) });
    return Response.json({ error: { message: 'bad' } }, { status: 400 });
  };
  const env = { META_TOKEN: 'tok', META_PAGE_ID: 'P1' };
  let r = await syncMeta(env, db, { nowMs: NOW, fetchFn });
  assert.equal(r.ok, true); assert.equal(r.created.length, 2);
  assert.deepEqual(r.forms, ['ISO 심사 무료상담 → ISO심사', 'ESG 인증 문의 → ESG인증']);
  assert.equal(db.store.get('leads/D-0001').product, 'iso');
  assert.match(calls[1], /filtering=/);
  const since1 = JSON.parse(decodeURIComponent(calls[1].split('filtering=')[1]))[0].value;
  assert.equal(since1, Math.floor((NOW - 90 * 86400000) / 1000));   // 처음엔 90일
  calls.length = 0;
  const c0 = db.commits;
  const realTx = db.transaction; let leadReads = 0;
  db.transaction = (fn) => realTx((tx) => fn(Object.assign({}, tx, { query: (c, f, o) => { if (c === 'leads') leadReads++; return tx.query(c, f, o); } })));
  r = await syncMeta(env, db, { nowMs: NOW + 5 * 60000, fetchFn });
  db.transaction = realTx;
  assert.equal(r.fetched, 1); assert.equal(r.created.length, 0); assert.equal(r.skipped, 1);   // 10분 겹쳐 물어 다시 온 리드는 안 넣음
  assert.equal(leadReads, 0); assert.equal(db.commits, c0 + 1);    // 새 리드가 없으면 leads를 읽지 않고 lead_sync 한 번만 씀
  const since2 = JSON.parse(decodeURIComponent(calls[1].split('filtering=')[1]))[0].value;
  assert.equal(since2, Math.floor((NOW - 1 * H - 10 * 60000) / 1000));   // 가장 늦은 신청 10분 전부터
  // 토큰 만료 → 기록만 남기고 실패
  const bad = async () => Response.json({ error: { message: 'Session has expired', code: 190 } }, { status: 400 });
  r = await syncMeta(env, db, { nowMs: NOW + 10 * 60000, fetchFn: bad });
  assert.equal(r.ok, false); assert.match(r.error, /만료/);
  assert.match(db.store.get(SYNC_PATH).lastError, /만료/);
  assert.equal(db.store.get(SYNC_PATH).lastTime, NOW - 1 * H);   // 이어받을 시각은 그대로
});

test('Claude 도구 — lead_list · lead_update · stats · lead_sync', async () => {
  const db = db0();
  await importLeads({ db, actor, nowMs: NOW }, [fromMetaLead(metaLead('c1', '01090909090', 2, [{ name: 'city', values: ['경기 시흥'] }, { name: '사업자 유형', values: ['법인사업자'] }, { name: '업종', values: ['제조'] }]), { name: 'ISO' })]);
  const deps = { db, email: 'sgceo@sgsolutionss.com', nowMs: NOW };
  let out = await callTool('lead_list', {}, deps);
  assert.match(out, /새 DB 1/); assert.match(out, /D-0001 \[ISO심사 · 🆕 2시간 전 들어옴\] 홍길동c1 · 길동산업 ☎ 010-9090-9090 — 경기 시흥 · 법인사업자 · 제조 〔ISO〕/);
  await assert.rejects(() => callTool('lead_update', { no: 'D-1', action: 'noans' }, deps), /author/);
  out = await callTool('lead_update', { no: 'D-1', action: 'talk', date: '내일', time: '2시', author: '정석진' }, deps);
  assert.match(out, /상담 중 · 10\/14 14:00 다시 통화/);
  out = await callTool('lead_list', { view: 'stats' }, deps);
  assert.match(out, /ISO심사: 들어옴 1 · 통화 연결 1\(100%\)/);
  out = await callTool('lead_sync', {}, deps);
  assert.match(out, /Meta 연결 전/);
});

test('비우고 기준일부터 다시 — 전부 지우고 번호 D-0001부터, 기준일 앞 신청은 안 받음', async () => {
  const db = db0();
  const env = { META_TOKEN: 'tok', META_PAGE_ID: 'P1' };
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const since = url.includes('filtering=') ? JSON.parse(decodeURIComponent(url.split('filtering=')[1]))[0].value * 1000 : 0;
    if (url.includes('/leadgen_forms')) return Response.json({ data: [{ id: 'F1', name: 'ISO 심사' }] });
    const all = [metaLead('old', '01011110000', 72), metaLead('new', '01022220000', 2)];
    return Response.json({ data: all.filter(l => Date.parse(l.created_time.replace(/\+0000$/, 'Z')) > since) });
  };
  await syncMeta(env, db, { nowMs: NOW, fetchFn });
  assert.equal([...db.store.keys()].filter(k => k.startsWith('leads/')).length, 2);
  const deps = { db, email: 'x', nowMs: NOW };
  await assert.rejects(() => callTool('lead_reset', { since: '오늘', author: '정석진' }, deps), /초기화/);
  const out = await callTool('lead_reset', { since: '오늘', confirm: '초기화', author: '정석진' }, deps);
  assert.match(out, /2건 지움 · 번호는 D-0001부터 · 2026-10-13 이후/);
  assert.equal([...db.store.keys()].filter(k => k.startsWith('leads/')).length, 0);
  assert.equal(db.store.get(SYNC_PATH).startFrom, Date.parse('2026-10-13T00:00:00+09:00'));
  // 처음부터 다시 받아도(full) 기준일 앞으로는 안 감 → 오늘 들어온 것만, 번호는 D-0001
  const r = await syncMeta(env, db, { nowMs: NOW + 60000, fetchFn, full: true });
  assert.deepEqual(r.created.map(c => c.label), ['D-0001']);
  assert.equal(db.store.get('leads/D-0001').metaId, 'new');
});

test('한 번에 12개까지 — 넘으면 남은 번호를 알려 줌(외부 호출 한도)', async () => {
  const seed = {}; for (let i = 1; i <= 14; i++) seed['todos/T-' + String(i).padStart(4, '0')] = { no: i, text: 't' + i, status: 'wait', startDate: '2026-10-13', createdAt: NOW };
  const db = fakeDb(seed);
  const out = await callTool('todo_delete', { no: Array.from({ length: 14 }, (_, i) => i + 1), author: '정석진' }, { db, email: 'x', nowMs: NOW });
  assert.equal((out.match(/휴지통으로 옮김/g) || []).length, 12);
  assert.match(out, /남은 2개\(13, 14\)는 다시/);
});

test('📒 통화 이력 — 들어옴부터 미팅까지 한 줄씩 쌓임 · 미팅 예정 칸 · Claude lead_history', async () => {
  const db = db0();
  const ctx = { db, actor, nowMs: NOW };
  await importLeads(ctx, [fromMetaLead(metaLead('m1', '01011112222', 2), { id: 'f1', name: 'ISO인증심사' })]);
  await actLead(Object.assign({}, ctx, { nowMs: NOW + H }), 'D-1', 'noans');
  await actLead(Object.assign({}, ctx, { nowMs: NOW + 25 * H }), 'D-1', 'talk', { memo: '9001 견적 문의, 직원 30명' });
  let r = await actLead(Object.assign({}, ctx, { nowMs: NOW + 26 * H }), 'D-1', 'meeting', { date: '10/16', time: '오전 10시 30분', memo: '본사 방문' });
  assert.equal(r.lead.status, 'meet'); assert.equal(r.lead.col, 'meet'); assert.equal(r.lead.meetDate, '2026-10-16'); assert.equal(r.lead.meetTime, '10:30');
  assert.match(r.lead.reason, /🤝 미팅 10\/16 10:30/);
  const l = db.store.get('leads/D-0001');
  assert.deepEqual(l.calls.map(c => c.action), ['noans', 'talk', 'meeting']);
  assert.ok(l.calls.every(c => c.by === '정석진' && c.at));
  assert.match(l.calls[1].what, /통화됨 → 💬 상담 중 · 9001 견적 문의/);
  // 미팅 전 다시 통화해도 미팅 예정 유지 · 날짜 지나면 결과 남기라고 빨강
  r = await actLead(Object.assign({}, ctx, { nowMs: NOW + 27 * H }), 'D-1', 'memo', { memo: '자료 미리 메일 보냄' });
  assert.equal(r.lead.status, 'meet');
  assert.equal(leadState(db.store.get('leads/D-0001'), NOW + 5 * 24 * H).alert, true);
  // 목록: meet 보기 · 오늘 보기엔 지난 미팅만
  assert.equal((await listLeads(db, { view: 'meet' }, NOW + 27 * H)).total, 1);
  assert.equal((await listLeads(db, { view: 'today' }, NOW + 27 * H)).total, 0);
  assert.equal((await listLeads(db, { view: 'today' }, NOW + 5 * 24 * H)).total, 1);
  // Claude: 번호·이름으로
  const deps = { db, email: 'x', nowMs: NOW + 27 * H };
  let out = await callTool('lead_history', { no: 'D-0001' }, deps);
  assert.match(out, /📥 들어옴 — ISO심사 광고 〔ISO인증심사〕/);
  assert.match(out, /부재 1번째/); assert.match(out, /🤝 미팅 약속 10\/16 10:30 · 본사 방문 — 정석진/); assert.match(out, /자료 미리 메일 보냄/);
  out = await callTool('lead_history', { query: '01011112222' }, deps);
  assert.match(out, /D-0001/);
  await assert.rejects(() => callTool('lead_update', { no: 1, action: 'meeting', author: '정석진' }, deps), /미팅 날짜/);
});

test('📒 지난 기록 옮겨 채우기 — activity에서 시간순, 비우기 전 기록·이미 있는 이력은 건드리지 않음', async () => {
  const { backfillLeadCalls } = await import('../src/leads.js');
  const db = fakeDb({
    'leads/D-0001': { no: 1, name: '하윤수', status: 'talk' },
    'leads/D-0002': { no: 2, name: '김철수', status: 'new', calls: [{ at: 1, by: 'x', action: 'memo', what: '이미 있음' }] },
    'activity/a1': { app: 'lead', no: 1, action: 'noans', at: NOW - 5 * H, by: '정석진', summary: 'D-0001 하윤수 · 부재 1번째 → 10/14 다시 걸기 — 정석진' },
    'activity/a0': { app: 'lead', no: 1, action: 'talk', at: NOW - 9 * 24 * H, by: '정석진', summary: 'D-0001 옛사람 · 통화됨 — 정석진' },   // 비우기 전 옛 번호
    'activity/a2': { app: 'lead', no: 1, action: 'talk', at: NOW - H, by: '정석진', summary: 'D-0001 하윤수(하나산업) · 통화됨 → 💬 상담 중 · 10/15 10:30 다시 통화 · 미팅 약속 — 정석진' },
    'activity/a3': { app: 'lead', no: 0, action: 'import', at: NOW - 6 * H, summary: '📣 광고 DB 2건 들어옴' },
  });
  const r = await backfillLeadCalls(db, { sinceMs: NOW - 24 * H });
  assert.deepEqual(r, { filled: 1, lines: 2 });
  const c = db.store.get('leads/D-0001').calls;
  assert.deepEqual(c.map(x => x.what), ['부재 1번째 → 10/14 다시 걸기', '통화됨 → 💬 상담 중 · 10/15 10:30 다시 통화 · 미팅 약속']);
  assert.equal(db.store.get('leads/D-0002').calls[0].what, '이미 있음');
  assert.deepEqual(await backfillLeadCalls(db, { sinceMs: NOW - 24 * H }), { filled: 0, lines: 0 });   // 두 번 해도 그대로
});

test('📒 Meta 가져오기가 실패해도 지난 기록 옮기기는 한 번 한다', async () => {
  const db = fakeDb({
    'leads/D-0001': { no: 1, name: '하윤수', status: 'talk' },
    'activity/a1': { app: 'lead', no: 1, action: 'talk', at: NOW - H, by: '정석진', summary: 'D-0001 하윤수 · 통화됨 → 💬 상담 중 — 정석진' },
    [SYNC_PATH]: { startFrom: NOW - 24 * H },
  });
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'permission', code: 190 } }) });
  const r = await syncMeta({ META_TOKEN: 't', META_PAGE_ID: 'p' }, db, { nowMs: NOW, fetchFn: bad });
  assert.equal(r.ok, false);
  assert.equal(db.store.get('leads/D-0001').calls[0].what, '통화됨 → 💬 상담 중');
  assert.equal(db.store.get(SYNC_PATH).callsBackfilledAt, NOW);
});
