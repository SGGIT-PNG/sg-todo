// ── 자동으로 생기는 할 일 (하루 한 번 예약 작업 + 관리 화면 「지금 실행」) ──
// SGCRM index.html의 createCertTasks · createIsoTasks · createAnnualTasks 규칙을 그대로 옮겼다(2026-10-08).
// 예전엔 CRM을 여는 기기마다 돌아 중복 위험이 있었다 → 이제 쓰기 창구 한 곳에서, 번호·기록과 함께.
// 휴지통 30일 지난 할 일 완전 삭제도 여기서 한다.

import { kstToday, TRASH_DAYS, noLabel } from './core.js';
import { createMany } from './todos.js';

export const CERT_TASK_DAYS = 90;
export const ISO_TASK_DAYS = 90;

// CRM getCertDday와 같은 계산 (만료일 'YYYY-MM-DD'을 UTC 자정으로 보고 올림)
function dday(ds, nowMs) { return ds ? Math.ceil((new Date(ds) - nowMs) / 86400000) : null; }

function masterOf(certMaster, id) {
  if (!id) return { certName: '미분류', cycleType: 'fixed', reportType: 'renewal' };
  return certMaster.find(m => m.id === id) || certMaster.find(m => m.certName === id)
    || { certName: id, cycleType: 'fixed', reportType: 'renewal' };
}
function categoryOf(masterId, categories, certMaster) {
  if (!masterId) return '';
  for (const c of categories) if ((c.certMasterIds || []).includes(masterId)) return c.id;
  if (['venture', 'innobiz', 'mainbiz'].includes(masterId)) return 'ven';
  if (['lab', 'rnd_dept'].includes(masterId)) return 'lab';
  const m = certMaster.find(x => x.id === masterId);
  if (/^iso_/i.test(masterId) || /iso/i.test((m && m.certName) || '')) return 'iso';
  return '';
}

// 만들 할 일 목록 계산 (쓰지 않음) — data: {todos, companies, certifications, certMaster, annualReports, isoAudits, categories}
export function planAuto(data, nowMs = Date.now()) {
  const { todos, companies, certifications, certMaster, annualReports, isoAudits } = data;
  const categories = (data.categories || []).slice().sort((a, b) => (a.order || 99) - (b.order || 99));
  const inactive = new Set(companies.filter(c => c.active === 'N').map(c => c.id));
  const nameOf = (bizno, fallback) => (companies.find(c => c.id === bizno) || {}).name || fallback || '';
  const coOf = (bizno) => companies.some(c => c.id === bizno) ? bizno : '';   // 기업 목록에 없으면 연결 없이 (글에 이름은 남음)
  const has = (pred) => todos.some(pred);
  const out = [];

  // ① 인증 갱신 D-90 (고정주기 인증. ISO 복합주기는 iso-one 경로, 연간신고 대상은 ③)
  certifications.forEach(c => {
    if (!c || !c.expDate || !c.bizno) return;
    if (c.status === '제외' || c.status === '완료' || inactive.has(c.bizno)) return;
    if (c.cycleType === 'complex') return;
    const m = masterOf(certMaster, c.certMasterId);
    if (m.reportType === 'annual') return;
    const d = dday(c.expDate, nowMs);
    if (d === null || d > CERT_TASK_DAYS) return;          // 지난 것(음수)도 포함 — 놓친 갱신
    if (has(t => t.certTaskId === c.id || t.dedupeKey === 'cert:' + c.id)) return;
    const nm = nameOf(c.bizno, c.companyName);
    out.push({ source: 'cert', sourceRef: c.id, dday: d, fields: {
      text: '[' + nm + '] ' + (m.certName || '인증') + ' 갱신 준비', due: c.expDate, tag: '인증',
      company: coOf(c.bizno), category: categoryOf(c.certMasterId, categories, certMaster) || 'etc' } });
  });

  // ② ISO 차기심사 D-90 (iso-one이 보낸 iso_audits 기준)
  isoAudits.forEach(a => {
    if (!a.nextDeadline || !a.bizno || !a.auditId) return;
    const d = dday(a.nextDeadline, nowMs);
    if (d === null || d > ISO_TASK_DAYS) return;
    if (has(t => t.isoAuditId === a.auditId || t.dedupeKey === 'iso:' + a.auditId)) return;
    const nm = nameOf(a.bizno, a.companyName);
    out.push({ source: 'iso', sourceRef: a.auditId, dday: d, fields: {
      text: '[' + nm + '] ISO ' + (a.nextAtype || '심사') + ' 준비', due: a.nextDeadline, tag: 'ISO',
      company: coOf(a.bizno), category: 'iso' } });
  });

  // ③ 연구소·전담부서 연간신고 — 3월 1일 ~ 신고기한 사이에만
  const today = kstToday(nowMs); const y = Number(today.slice(0, 4));
  if (today >= y + '-03-01') {
    certifications.forEach(c => {
      if (!c || !c.bizno || c.status === '제외' || inactive.has(c.bizno)) return;
      const m = masterOf(certMaster, c.certMasterId);
      if (m.reportType !== 'annual') return;
      const due = y + '-' + String(m.annualMonth || 4).padStart(2, '0') + '-' + String(m.annualDay || 30).padStart(2, '0');
      if (today > due) return;
      if (annualReports.some(r => r.certId === c.id && Number(r.year) === y && r.status === 'done')) return;
      const ref = c.id + ':' + y;
      if (has(t => (t.source === 'annual' && t.sourceRef === ref) || t.dedupeKey === 'annual:' + ref)) return;
      const nm = nameOf(c.bizno, c.companyName);
      out.push({ source: 'annual', sourceRef: ref, dday: dday(due, nowMs), fields: {
        text: '[' + nm + '] ' + (m.certName || '연구소') + ' 연간신고', due, company: coOf(c.bizno),
        category: categoryOf(c.certMasterId, categories, certMaster) || 'lab' } });
    });
  }
  return out.sort((a, b) => a.dday - b.dday);
}

async function loadAll(db) {
  const names = ['todos', 'companies', 'certifications', 'cert_master', 'annual_reports', 'iso_audits', 'categories'];
  const [todos, companies, certifications, certMaster, annualReports, isoAudits, categories] =
    await Promise.all(names.map(n => db.list(n)));
  const plain = (rows) => rows.map(d => Object.assign({ id: d.id }, d.data));
  return {
    todos: plain(todos), companies: plain(companies).map(c => ({ id: c.id, name: c.name || '', active: c.active || '' })),
    certifications: plain(certifications), certMaster: plain(certMaster), annualReports: plain(annualReports),
    isoAudits: plain(isoAudits), categories: plain(categories),
  };
}

export async function previewAuto(db, nowMs = Date.now()) {
  const plan = planAuto(await loadAll(db), nowMs);
  return { count: plan.length, items: plan.map(p => ({ source: p.source, text: p.fields.text, dueDate: p.fields.due, dday: p.dday })) };
}

// 실행: 할 일 만들기(같은 출처는 한 번만 — createTodo의 dedupeKey 확인) + 휴지통 정리
export async function runAuto(db, nowMs = Date.now()) {
  const data = await loadAll(db);
  const plan = planAuto(data, nowMs);
  const actor = { name: '자동', via: 'cron', email: '' };
  const r = plan.length ? await createMany({ db, actor, nowMs, companies: data.companies },
    plan.map(p => ({ fields: p.fields, source: p.source, sourceRef: p.sourceRef }))) : { made: [], errors: [] };
  const made = r.made, errors = r.errors;
  const purged = await purgeTrash(db, nowMs);
  if (made.length || purged.length || errors.length) console.log('[sg-todo 자동]', JSON.stringify({ made, purged, errors }));
  return { made, purged, errors };
}

// 휴지통 30일 지난 할 일 완전 삭제 (변동 기록에 한 줄)
export async function purgeTrash(db, nowMs = Date.now()) {
  const limitMs = nowMs - TRASH_DAYS * 86400000;
  const old = (await db.list('todos')).filter(d => d.data.deletedAt && d.data.deletedAt < limitMs);
  if (!old.length) return [];
  const labels = old.slice(0, 400).map(d => d.data.no ? noLabel(d.data.no) : d.id);
  await db.transaction(async (tx) => {
    old.slice(0, 400).forEach(d => tx.delete(d.path));
    tx.create('activity/' + nowMs + '-purge', {
      at: nowMs, app: 'todo', ref: 'PURGE', no: 0, action: 'purge', by: '자동', via: 'cron', email: '', bizno: '', changes: {},
      summary: '자동 · 휴지통 ' + TRASH_DAYS + '일 지난 할 일 ' + labels.length + '건 완전 삭제 (' + labels.join(', ') + ')',
    });
  });
  return labels;
}
