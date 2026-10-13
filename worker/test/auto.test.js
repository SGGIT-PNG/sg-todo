// 자동 생성(인증 갱신·ISO·연간신고) · 휴지통 정리 · 사업자번호 변경 시험 — 메모리 DB
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { planAuto, runAuto, previewAuto, purgeTrash } from '../src/auto.js';
import { rebizno } from '../src/todos.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-08T03:00:00Z');
const MAR = Date.parse('2027-03-05T03:00:00Z');
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const seed = (extra = {}) => fakeDb(Object.assign({
  'companies/111-11-11111': { name: '㈜하이퍼다인', active: 'Y' },
  'companies/222-22-22222': { name: '청림테크', active: 'Y' },
  'companies/999-99-99999': { name: '쉬는회사', active: 'N' },
  'cert_master/venture': { certName: '벤처기업', cycleType: 'fixed', reportType: 'renewal' },
  'cert_master/lab': { certName: '기업부설연구소', cycleType: 'fixed', reportType: 'annual', annualMonth: 4, annualDay: 30 },
  'cert_master/iso_9001': { certName: 'ISO 9001', cycleType: 'complex' },
  'certifications/c1': { bizno: '111-11-11111', certMasterId: 'venture', expDate: ymd(NOW + 40 * DAY), status: '유효' },   // D-40 → 생성
  'certifications/c2': { bizno: '222-22-22222', certMasterId: 'venture', expDate: ymd(NOW + 200 * DAY), status: '유효' },  // 먼 미래 → 안 함
  'certifications/c3': { bizno: '999-99-99999', certMasterId: 'venture', expDate: ymd(NOW + 10 * DAY), status: '유효' },   // 비활성 기업 → 안 함
  'certifications/c4': { bizno: '111-11-11111', certMasterId: 'iso_9001', cycleType: 'complex', expDate: ymd(NOW + 10 * DAY) }, // ISO → iso-one 경로
  'certifications/c5': { bizno: '222-22-22222', certMasterId: 'lab', expDate: ymd(NOW + 30 * DAY), status: '유효' },         // 연간신고 대상
  'certifications/c6': { bizno: '222-22-22222', certMasterId: 'venture', expDate: ymd(NOW - 5 * DAY), status: '완료' },    // 완료 → 안 함
  'iso_audits/a1': { bizno: '222-22-22222', auditId: 'AUD1', nextDeadline: ymd(NOW + 60 * DAY), nextAtype: '사후심사', companyName: '청림테크' },
  'iso_audits/a2': { bizno: '222-22-22222', auditId: 'AUD2', nextDeadline: ymd(NOW + 120 * DAY) },
}, extra));

test('자동 생성 계획 — CRM 규칙과 같게', async () => {
  const db = seed();
  const pv = await previewAuto(db, NOW);
  assert.deepEqual(pv.items.map(i => i.text), ['[㈜하이퍼다인] 벤처기업 갱신 준비', '[청림테크] ISO 사후심사 준비']);   // 10월 → 연간신고 없음
  const mar = await previewAuto(db, MAR);
  assert.ok(mar.items.some(i => i.text === '[청림테크] 기업부설연구소 연간신고' && i.dueDate === '2027-04-30'));
});

test('자동 생성 실행 — 번호·출처·기록, 두 번 돌려도 한 번만, 옛 키(certTaskId)도 인정', async () => {
  const db = seed({ 'app_state/todo_seq': { last: 23 }, 'todos/old': { no: 5, text: '옛 ISO 할 일', status: 'wait', isoAuditId: 'AUD1' } });
  const r = await runAuto(db, NOW);
  assert.deepEqual(r.made, ['T-0024 [㈜하이퍼다인] 벤처기업 갱신 준비']);         // ISO는 옛 isoAuditId로 이미 있음
  const t = db.store.get('todos/T-0024');
  assert.equal(t.source, 'cert'); assert.equal(t.dedupeKey, 'cert:c1'); assert.equal(t.bizno, '111-11-11111');
  assert.equal(t.createdBy, '자동'); assert.equal(t.category, 'ven'); assert.equal(t.dueDate, ymd(NOW + 40 * DAY));
  assert.equal(db.store.get('app_state/todo_seq').last, 24);
  assert.ok([...db.store.entries()].some(([p, d]) => p.startsWith('activity/') && d.action === 'auto' && d.ref === 'T-0024'));
  assert.deepEqual((await runAuto(db, NOW)).made, []);
  assert.deepEqual(planAuto({ todos: [], companies: [], certifications: [], certMaster: [], annualReports: [], isoAudits: [] }, NOW), []);
});

test('자동 생성 — 연간신고 이미 신고했으면 안 만듦', async () => {
  const db = seed({ 'annual_reports/r1': { certId: 'c5', year: 2027, status: 'done' } });
  assert.ok(!(await previewAuto(db, MAR)).items.some(i => i.text.includes('연간신고')));
});

test('휴지통 30일 지난 것만 완전 삭제', async () => {
  const db = seed({
    'todos/T-0001': { no: 1, text: '오래된 삭제', deletedAt: NOW - 31 * DAY },
    'todos/T-0002': { no: 2, text: '최근 삭제', deletedAt: NOW - 3 * DAY },
    'todos/T-0003': { no: 3, text: '살아있음' },
  });
  assert.deepEqual(await purgeTrash(db, NOW), ['T-0001']);
  assert.equal(db.store.has('todos/T-0001'), false);
  assert.equal(db.store.has('todos/T-0002'), true);
  assert.deepEqual(await purgeTrash(db, NOW), []);
});

test('사업자번호 변경 — 그 기업 할 일을 새 번호로', async () => {
  const db = seed({
    'companies/333-33-33333': { name: '예비→정식 주식회사', active: 'Y' },
    'todos/T-0001': { no: 1, text: 'a', bizno: 'TEMP-001', companyName: '예비' },
    'todos/T-0002': { no: 2, text: 'b', bizno: 'TEMP-001', companyName: '예비' },
    'todos/T-0003': { no: 3, text: 'c', bizno: '111-11-11111' },
  });
  const r = await rebizno({ db, actor: { name: '정석진', via: 'web' }, nowMs: NOW }, 'TEMP-001', '333-33-33333');
  assert.equal(r.moved, 2);
  assert.equal(db.store.get('todos/T-0002').bizno, '333-33-33333');
  assert.equal(db.store.get('todos/T-0002').companyName, '예비→정식 주식회사');
  assert.equal(db.store.get('todos/T-0003').bizno, '111-11-11111');
});

test('인증 연동(cert_status) — 갱신 D-90 · nextDue 우선 · ISO 통합심사 하나로 · 수기 기록·iso_audits와 안 겹침', async () => {
  const db = seed({
    'cert_master/mainbiz': { certName: '메인비즈', cycleType: 'fixed', reportType: 'renewal' },
    'cert_master/iso_14001': { certName: 'ISO 14001', cycleType: 'complex' },
    // 메인비즈 만료 D-50, nextDue 없음 → 갱신 준비
    'cert_status/111-11-11111__mainbiz': { bizno: '111-11-11111', cert: 'mainbiz', companyName: '하이퍼다인', status: 'certified', issuedAt: '2023-11-27', expiresAt: ymd(NOW + 50 * DAY), source: 'mainbiz-innobiz' },
    // 같은 기업 벤처: 연동이 있으면 수기 기록(c1, D-40)으로는 안 만듦. 연동은 만료 먼 미래 → 아무것도 없음
    'cert_status/111-11-11111__venture': { bizno: '111-11-11111', cert: 'venture', status: 'certified', expiresAt: ymd(NOW + 400 * DAY) },
    // ISO 통합심사 — 두 규격 같은 nextDue·nextAction → 할 일 하나, iso_audits a1(같은 마감)과도 겹치지 않게
    'cert_status/222-22-22222__iso_9001': { bizno: '222-22-22222', cert: 'iso_9001', status: 'certified', expiresAt: ymd(NOW + 500 * DAY), nextAction: 'ISO 9001·14001 사후심사(1차)', nextDue: ymd(NOW + 60 * DAY), source: 'iso-one' },
    'cert_status/222-22-22222__iso_14001': { bizno: '222-22-22222', cert: 'iso_14001', status: 'certified', expiresAt: ymd(NOW + 500 * DAY), nextAction: 'ISO 9001·14001 사후심사(1차)', nextDue: ymd(NOW + 60 * DAY), source: 'iso-one' },
    // 만료·불합격은 안 만듦
    'cert_status/222-22-22222__venture': { bizno: '222-22-22222', cert: 'venture', status: 'expired', expiresAt: ymd(NOW - 3 * DAY) },
  });
  const pv = await previewAuto(db, NOW);
  assert.deepEqual(pv.items.map(i => i.text), ['[㈜하이퍼다인] 메인비즈 갱신 준비', '[청림테크] ISO 9001·14001 사후심사(1차)']);
  const r = await runAuto(db, NOW);
  assert.equal(r.made.length, 2);
  const keys = [...db.store.entries()].filter(([p]) => p.startsWith('todos/')).map(([, d]) => d.dedupeKey).sort();
  assert.deepEqual(keys, ['cert:cs:111-11-11111__mainbiz', 'cert:cs:222-22-22222__iso_14001:' + ymd(NOW + 60 * DAY)]);
  const iso = [...db.store.values()].find(d => d.dedupeKey && d.dedupeKey.includes('iso_14001'));
  assert.equal(iso.category, 'iso'); assert.equal(iso.source, 'cert'); assert.equal(iso.dueDate, ymd(NOW + 60 * DAY));
  assert.deepEqual((await runAuto(db, NOW)).made, []);   // 두 번 돌려도 한 번만
});
