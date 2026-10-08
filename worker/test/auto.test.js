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
