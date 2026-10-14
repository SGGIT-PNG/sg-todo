// 🏅 ISO 소식 우편함(iso_inbox) 시험 — 메모리 DB만. 실제 Firestore·iso-one에 접속하지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { normCerts, normAtype, normDayRange, buildInbox, sendIsoUpdate, isoInboxStatus, inboxId } from '../src/iso.js';
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
