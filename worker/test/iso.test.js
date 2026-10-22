// 🏅 ISO 소식 우편함(iso_inbox) 시험 — 메모리 DB만. 실제 Firestore·iso-one에 접속하지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { normCerts, normAtype, normDayRange, buildInbox, sendIsoUpdate, isoInboxStatus, inboxId, normProfile, buildProfileInbox, sendIsoProfile } from '../src/iso.js';
import { callTool } from '../src/mcp.js';

const NOW = Date.parse('2026-10-14T01:00:00Z');   // 한국 2026-10-14 10:00
const actor = { name: '정석진', via: 'mcp' };
const db0 = (extra = {}) => fakeDb(Object.assign({
  'companies/123-45-67890': { name: '주식회사 태성아이앤티', active: 'Y' },
  'companies/222-22-22222': { name: '태성전자', active: 'Y' },
  'companies/333-33-33333': { name: '하이퍼다인', active: 'Y' },
}, extra));
const inbox = (db) => [...db.store.entries()].filter(([p]) => p.startsWith('iso_inbox/')).map(([p, d]) => Object.assign({ id: p.split('/')[1] }, d));

test('말 알아듣기 — 규격·심사 유형·날짜 범위', () => {
  assert.deepEqual(normCerts('ISO 14001 · 9001,45001'), ['iso_9001', 'iso_14001', 'iso_45001']);
  assert.deepEqual(normCerts(['iso_9001', '9001']), ['iso_9001']);
  assert.throws(() => normCerts('1234'), /ISO 규격/);
  assert.equal(normAtype('사후1차'), '사후심사(1차)');
  assert.equal(normAtype('2차 사후심사'), '사후심사(2차)');
  assert.equal(normAtype('갱신'), '갱신심사');
  assert.equal(normAtype('최초심사'), '최초심사');
  assert.equal(normDayRange('2027-09-14~15', NOW), '2027-09-14~2027-09-15');
  assert.equal(normDayRange('2027-09-14~2027-09-15', NOW), '2027-09-14~2027-09-15');
  assert.equal(normDayRange('2027-09-14', NOW), '2027-09-14');
  assert.throws(() => normDayRange('2027-09-15~14', NOW), /범위/);
});

test('우편함 문서 — 말한 것만, 빈 값 없음, 같은 내용은 같은 ID', async () => {
  const db = db0();
  const ctx = { db, actor, nowMs: NOW };
  const d = await buildInbox(ctx, { company: '123-45-67890', status: 'certified', issuedAt: '2026-10-20' });
  assert.deepEqual(d, { bizno: '123-45-67890', companyName: '주식회사 태성아이앤티', status: 'certified', issuedAt: '2026-10-20', source: 'sg-todo', createdAt: NOW, state: 'pending', by: '정석진' });
  assert.equal(inboxId(d, NOW), inboxId(Object.assign({}, d, { createdAt: NOW + 5 }), NOW + 5));
  assert.match(inboxId(d, NOW), /^sg-todo__chat-\w+__20261014$/);
  assert.equal(inboxId(Object.assign({}, d, { sourceRef: 'T-0123' }), NOW), 'sg-todo__T-0123__20261014');
  await assert.rejects(() => buildInbox(ctx, { company: '태성', status: 'certified' }), /여러 곳/);
  await assert.rejects(() => buildInbox(ctx, { company: '없는회사', status: 'certified' }), /찾지 못했습니다/);
  await assert.rejects(() => buildInbox(ctx, { company: '하이퍼다인' }), /하나 이상/);
  await assert.rejects(() => buildInbox(ctx, { company: '하이퍼다인', status: 'ok' }), /status는/);
});

test('심사 확정 → 끝남(발급 확인 할 일) → 발급(할 일 자동 완료)', async () => {
  const db = db0();
  const ctx = { db, actor, nowMs: NOW };
  // ① 사후1차 일정 확정
  let r = await sendIsoUpdate(ctx, { company: '태성아이앤티', status: 'in_progress', atype: '사후1차', s2Date: '2027-09-14~15' });
  assert.equal(r.doc.atype, '사후심사(1차)'); assert.equal(r.doc.s2Date, '2027-09-14~2027-09-15'); assert.deepEqual(r.todo, {});
  // ② 심사 끝남 → 「인증서 발급 확인」 할 일
  r = await sendIsoUpdate(ctx, { company: '태성아이앤티', atype: '사후심사(1차)', s2Date: '2027-09-14~2027-09-15', auditDone: true });
  assert.equal(r.todo.made, 'T-0001');
  const t = db.store.get('todos/T-0001');
  assert.equal(t.text, '[주식회사 태성아이앤티] 인증서 발급 확인'); assert.equal(t.category, 'iso'); assert.equal(t.dedupeKey, 'iso:issue:123-45-67890'); assert.equal(t.bizno, '123-45-67890');
  // 같은 말 또 → 할 일 하나
  r = await sendIsoUpdate(ctx, { company: '태성아이앤티', status: 'certified' });
  assert.equal(r.todo.exists, 'T-0001');
  // ③ 발급(앞날 10/20) → 할 일 완료, 완료일은 오늘(앞날은 못 넣음)
  r = await sendIsoUpdate(ctx, { company: '태성아이앤티', status: 'certified', issuedAt: '10/20' });
  assert.equal(r.todo.done, 'T-0001');
  const t2 = db.store.get('todos/T-0001');
  assert.equal(t2.status, 'done'); assert.equal(t2.dedupeKey, 'iso:issue:123-45-67890:2026-10-20');
  assert.match(t2.memo, /인증서 발급 2026-10-20/);
  // 다음 심사가 끝나면 새 「발급 확인」을 다시 만들 수 있음
  r = await sendIsoUpdate(ctx, { company: '태성아이앤티', atype: '사후심사(2차)', auditDone: true });
  assert.equal(r.todo.made, 'T-0002');
  // 우편함 줄 4개(①②, 같은 말은 다른 내용이라 별도, ③, ④)
  const rows = inbox(db);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(d => d.state === 'pending' && d.source === 'sg-todo' && d.by === '정석진'));
  assert.ok(rows.every(d => !Object.values(d).some(v => v === '' || v === 0)));
});

test('규격 추가 — 연동 기록(cert_status)을 바탕으로, 이미 반영된 같은 소식은 다시 안 씀', async () => {
  const db = db0({
    'cert_status/123-45-67890__iso_9001': { bizno: '123-45-67890', cert: 'iso_9001', status: 'certified' },
    'cert_status/123-45-67890__iso_14001': { bizno: '123-45-67890', cert: 'iso_14001', status: 'certified' },
  });
  const ctx = { db, actor, nowMs: NOW };
  const r = await sendIsoUpdate(ctx, { company: '태성아이앤티', addCerts: '45001' });
  assert.deepEqual(r.doc.certs, ['iso_9001', 'iso_14001', 'iso_45001']);
  await assert.rejects(() => sendIsoUpdate(ctx, { company: '하이퍼다인', addCerts: '45001' }), /전체 규격/);
  // iso-one이 반영했다고 치고 같은 말을 다시 → 덮어쓰지 않음
  db.store.get('iso_inbox/' + r.id).state = 'applied'; db.store.get('iso_inbox/' + r.id).result = '반영 · 규격 3개';
  const again = await sendIsoUpdate(ctx, { company: '태성아이앤티', addCerts: '45001' });
  assert.equal(again.same, true); assert.equal(db.store.get('iso_inbox/' + r.id).state, 'applied');
});

test('반영 결과 조회 — 오래 대기·못 함 안내 · Claude 도구', async () => {
  const db = db0({
    'iso_inbox/a': { bizno: '123-45-67890', companyName: '주식회사 태성아이앤티', status: 'certified', issuedAt: '2026-10-20', source: 'sg-todo', createdAt: NOW - 2 * 3600000, state: 'pending', by: '정석진' },
    'iso_inbox/b': { bizno: '333-33-33333', companyName: '하이퍼다인', status: 'failed', source: 'sg-todo', createdAt: NOW - 60000, state: 'applied', result: '반영 · 불합격 처리' },
    'iso_inbox/c': { bizno: '333-33-33333', companyName: '하이퍼다인', status: 'certified', source: 'other', createdAt: NOW, state: 'pending' },
  });
  const rows = await isoInboxStatus(db, {}, NOW);
  assert.deepEqual(rows.map(r => r.id), ['b', 'a']);
  assert.match(rows[1].hint, /iso-one을 열면 반영됩니다/);
  const deps = { db, email: 'x', nowMs: NOW };
  let out = await callTool('iso_update_status', { company: '하이퍼다인' }, deps);
  assert.match(out, /✅ 반영 · 하이퍼다인 · 불합격\n   결과: 반영 · 불합격 처리/);
  await assert.rejects(() => callTool('iso_update', { company: '하이퍼다인', status: 'failed' }, deps), /author/);
  out = await callTool('iso_update', { company: '하이퍼다인', status: 'failed', note: '2단계 부적합 2건', author: '김학미' }, deps);
  assert.match(out, /iso-one 우편함에 보냄 — 하이퍼다인 · 불합격 · 메모: 2단계 부적합 2건/);
  const acts = [...db.store.entries()].filter(([p]) => p.startsWith('activity/')).map(([, d]) => d.summary);
  assert.ok(acts.some(s => /ISO 소식 → iso-one 우편함: 하이퍼다인 · 불합격/.test(s)));
});

// ── 🏢 업체 정보(profile) — iso-one ISO_INBOX_SPEC v2 §6 ──
const YS = {
  name: '주식회사 영심', ceo: '서봉진', addr: '전북특별자치도 전주시 덕진구 기린대로 945-6, 2층 211호', founding_date: '2026-09-08',
  ind: '식품업', scope: '천연 및 혼합 조제 조미료 제조', fax: '0504-032-2778', mgr: '서봉진', safety_mgr: '서봉진',
  emp_total: '3명', iaf: '03', iaf_sub: '1083', mgno_q: '0614', mgno_e: '0614', mgno_s: '0614', ncr_action_date: '2026-10-15',
};
const dbYS = () => db0({ 'companies/216-86-03926': { name: '(주)영심', active: 'Y' } });

test('업체 정보 정리 — 칸 검사·숫자·날짜·목록', () => {
  const p = normProfile(YS, NOW);
  assert.equal(p.emp_total, '3'); assert.equal(p.founding_date, '2026-09-08'); assert.equal(p.ind, '식품업'); assert.equal(p.mgno_q, '0614');
  assert.deepEqual(normProfile({ ceo: '  홍길동 ', addr: '', mgr: null }, NOW), { ceo: '홍길동' });
  assert.throws(() => normProfile({ ceo: 'a', foo: 1 }, NOW), /모르는 칸 「foo」/);
  assert.throws(() => normProfile({ ind: '우주업' }, NOW), /업종 값은/);
  assert.throws(() => normProfile({ founding_date: '2026-13-45' }, NOW), /설립일 날짜/);
  assert.throws(() => normProfile({ emp_total: '미정' }, NOW), /총 인원 숫자/);
  assert.throws(() => normProfile({ shift: '주간' }, NOW), /근무형태 값은/);
  assert.throws(() => normProfile({}, NOW), /하나 이상/);
  assert.throws(() => normProfile('대표 서봉진', NOW), /묶음/);
});

test('업체 정보 문서 — 영심 3규격 최초, 없으면 새로 등록', async () => {
  const db = dbYS();
  const ctx = { db, actor, nowMs: NOW };
  const d = await buildProfileInbox(ctx, { company: '영심', certs: '9001·14001·45001', atype: '최초', s1Date: '2026-10-01', s2Date: '2026-10-08', profile: YS, assignee: 'SGCEO@sgsolutionss.com' });
  assert.equal(d.bizno, '216-86-03926'); assert.equal(d.kind, 'profile'); assert.deepEqual(d.certs, ['iso_9001', 'iso_14001', 'iso_45001']);
  assert.equal(d.atype, '최초심사'); assert.equal(d.s2Date, '2026-10-08'); assert.equal(d.createIfMissing, true); assert.equal(d.assignee, 'sgceo@sgsolutionss.com');
  assert.equal(d.profile.emp_total, '3'); assert.equal(d.source, 'sg-todo'); assert.equal(d.state, 'pending');
  assert.equal((await buildProfileInbox(ctx, { company: '영심', profile: { ceo: '서봉진' }, createIfMissing: false })).createIfMissing, false);
  await assert.rejects(() => buildProfileInbox(ctx, { company: '없는회사', profile: YS }), /찾지 못했습니다/);
  await assert.rejects(() => buildProfileInbox(ctx, { company: '영심', profile: YS, assignee: '서봉진' }), /이메일/);
});

test('업체 정보 보내기 — 우편함 한 줄·같은 내용 한 건·반영 뒤 다시 안 씀·주말 경고·Claude 도구', async () => {
  const db = dbYS();
  const ctx = { db, actor, nowMs: NOW };
  let r = await sendIsoProfile(ctx, { company: '216-86-03926', certs: '9001,14001,45001', atype: '최초심사', s1Date: '2026-10-01', s2Date: '2026-10-08', profile: YS });
  assert.equal(r.same, false); assert.deepEqual(r.warnings, []);
  assert.match(r.id, /^sg-todo__profile-2168603926-\w+__20261014$/);
  await sendIsoProfile(ctx, { company: '216-86-03926', certs: '9001,14001,45001', atype: '최초심사', s1Date: '2026-10-01', s2Date: '2026-10-08', profile: YS });
  assert.equal(inbox(db).length, 1);
  db.store.get('iso_inbox/' + r.id).state = 'applied';
  db.store.get('iso_inbox/' + r.id).result = '반영 · 업체 새로 등록';
  r = await sendIsoProfile(ctx, { company: '216-86-03926', certs: '9001,14001,45001', atype: '최초심사', s1Date: '2026-10-01', s2Date: '2026-10-08', profile: YS });
  assert.equal(r.same, true); assert.equal(db.store.get('iso_inbox/' + r.id).state, 'applied');
  // 10/10(토)~11(일) 포함 → 경고
  r = await sendIsoProfile(ctx, { company: '영심', s2Date: '2026-10-09~11', profile: { ceo: '서봉진' } });
  assert.match(r.warnings[0], /2단계 심사일에 주말 포함: 2026-10-10, 2026-10-11/);
  // Claude 도구
  const deps = { db, email: 'x', nowMs: NOW };
  await assert.rejects(() => callTool('iso_profile', { company: '영심', profile: YS }, deps), /author/);
  const out = await callTool('iso_profile', { company: '영심', profile: { ceo: '서봉진', fax: '0504-032-2778' }, author: '정석진', ref: 'drive:004_업체카드_(주)영심' }, deps);
  assert.match(out, /🏢 iso-one 우편함에 보냄 — \(주\)영심 · 업체 정보 2칸\(대표자, 팩스\) · 없으면 새로 등록/);
  const st = await callTool('iso_update_status', { company: '영심' }, deps);
  assert.match(st, /업체 정보 2칸/);
  // iso-one이 반영 뒤 적어 준 빈 칸이 보인다
  const row = inbox(db).find(d => d.kind === 'profile' && d.profile.fax);
  Object.assign(db.store.get('iso_inbox/' + row.id), { state: 'applied', result: '반영 · 채움: 대표자, 팩스 · 빈 필수 칸: IAF 코드',
    missing: [{ key: 'iaf', label: 'IAF 코드' }], missingOptional: [{ key: 'tel', label: '전화' }, { key: 's1Date', label: '1단계 심사일' }] });
  const st2 = await callTool('iso_update_status', { company: '영심' }, deps);
  assert.match(st2, /빈 필수 칸: IAF 코드\(iaf\)/);
  assert.match(st2, /빈 권장 칸: 전화\(tel\), 1단계 심사일\(s1Date\)/);
  // from이 붙으면 SG가 정할 칸 / 기업 요청으로 나눠 보여 준다
  Object.assign(db.store.get('iso_inbox/' + row.id), { missing: [{ key: 'mgno_q', label: '관리번호(품질)', from: 'sg' }, { key: 'scope', label: '인증범위', from: 'client' }],
    missingOptional: [{ key: 'dept_names', label: '부서명', from: 'client' }] });
  const st3 = await callTool('iso_update_status', { company: '영심' }, deps);
  assert.match(st3, /SG가 정할 칸: 관리번호\(품질\)\(mgno_q\)/);
  assert.match(st3, /기업 요청\(필수\): 인증범위\(scope\)/);
  assert.match(st3, /기업 요청\(권장\): 부서명\(dept_names\)/);
  const acts = [...db.store.entries()].filter(([p]) => p.startsWith('activity/')).map(([, d]) => d.summary);
  assert.ok(acts.some(s => /🏢 업체 정보 → iso-one 우편함: \(주\)영심/.test(s)));
});
