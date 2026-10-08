// ── 할 일 쓰기·읽기 동작 ── 상태 규칙은 core.js, 저장은 db(firestore.js 또는 테스트용 가짜) 로
// 모든 쓰기는 트랜잭션 하나 안에서: 번호 발급 + 할 일 저장 + 변동 기록(activity)이 함께 되거나 함께 안 된다.

import {
  RuleError, cleanPatch, applyChange, newTodo, noLabel, parseNo, bucket, summarize, kstToday,
  resolveCompany, findCompanyInText, nextRepeatDate, RULES_DEFAULT, TRASH_DAYS, SOURCES,
} from './core.js';

const SEQ_PATH = 'app_state/todo_seq';
const RECENT_DUP_MS = 2 * 60 * 1000;

export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; this.status = 404; }
}

export async function loadCompanies(db) {
  return (await db.list('companies')).map(d => ({ id: d.id, name: d.data.name || '', active: d.data.active || '' }));
}

// patch.company(이름·사업자번호·'') → bizno·companyName. 여럿이면 저장하지 않고 후보를 돌려준다
function applyCompany(out, patch, companies, { autoFromText }) {
  if ('company' in patch) {
    const q = String(patch.company ?? '').trim();
    if (!q) { out.bizno = ''; out.companyName = ''; return; }
    const r = resolveCompany(q, companies);
    if (r.candidates) throw new RuleError('기업이 여러 곳입니다. 하나를 골라 주세요: ' + q,
      { candidates: r.candidates.map(c => ({ bizno: c.id, name: c.name })) });
    if (r.none) throw new RuleError('기업을 찾지 못했습니다: ' + q + ' (기업 없이 저장하려면 company를 비우세요)');
    out.bizno = r.company.id; out.companyName = r.company.name;
    return;
  }
  if ('bizno' in out && out.bizno) {
    const c = companies.find(x => x.id === out.bizno);
    if (!c) throw new RuleError('없는 사업자번호입니다: ' + out.bizno);
    out.companyName = c.name;
    return;
  }
  if (autoFromText && out.text) {
    const c = findCompanyInText(out.text, companies);
    if (c) { out.bizno = c.id; out.companyName = c.name; }
  }
}

function activityDoc(action, todo, changes, actor, nowMs) {
  return {
    at: nowMs, app: 'todo', ref: noLabel(todo.no), no: todo.no, action,
    summary: summarize(action, todo, changes, actor.name),
    by: actor.name, via: actor.via, email: actor.email || '',
    bizno: todo.bizno || '', changes: changes || {},
  };
}
const activityPath = (nowMs) => 'activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10);

async function nextNo(tx) {
  const seq = await tx.get(SEQ_PATH);
  if (seq && Number(seq.data.last) >= 0) return Number(seq.data.last) + 1;
  // 카운터가 아직 없으면(이전 작업 전) 지금 있는 가장 큰 번호 다음
  const top = await tx.query('todos', [], { orderBy: ['no', 'desc'], limit: 1 });
  return (top[0] && Number(top[0].data.no) || 0) + 1;
}

async function findByNo(reader, noInput) {
  const no = parseNo(noInput);
  if (!no) throw new RuleError('할 일 번호가 올바르지 않습니다: ' + noInput);
  const rows = await reader.query('todos', [['no', '==', no]], { limit: 1 });
  if (!rows.length) throw new NotFoundError('없는 할 일입니다: ' + noLabel(no));
  return rows[0];
}

// ── 추가 ──
//   opts.source: manual(웹)·chat·voice·cert·iso·annual·lead·card·secretary
//   opts.sourceRef: 출처 ID — 있으면 같은 출처로 두 번 만들지 않는다(dedupeKey)
export async function createTodo(ctx, input, opts = {}) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const source = opts.source || 'manual';
  if (!SOURCES.includes(source)) throw new RuleError('알 수 없는 출처입니다: ' + source);
  const fields = cleanPatch(input, { nowMs, creating: true });
  const companies = ctx.companies || await loadCompanies(db);
  applyCompany(fields, input, companies, { autoFromText: opts.autoCompany !== false });
  if (fields.status === 'done' || fields.status === 'cancel') throw new RuleError('새 할 일은 완료·취소 상태로 만들 수 없습니다');
  const dedupeKey = opts.sourceRef ? source + ':' + opts.sourceRef : '';

  return db.transaction(async (tx) => {
    if (dedupeKey) {
      const dup = await tx.query('todos', [['dedupeKey', '==', dedupeKey]], { limit: 1 });
      if (dup.length) return { created: false, duplicate: true, todo: dup[0].data, label: noLabel(dup[0].data.no) };
    }
    if (opts.checkRecentDup) {   // 채팅 재시도로 같은 할 일이 두 번 들어오는 것 막기
      const recent = await tx.query('todos', [['createdAt', '>=', nowMs - RECENT_DUP_MS]], {});
      const same = recent.find(r => r.data.text === fields.text && (r.data.bizno || '') === (fields.bizno || '')
        && (r.data.dueDate || '') === (fields.dueDate || '') && !r.data.deletedAt);
      if (same) return { created: false, duplicate: true, todo: same.data, label: noLabel(same.data.no) };
    }
    const no = await nextNo(tx);
    const todo = newTodo(fields, { no, source, sourceRef: opts.sourceRef, actor, nowMs });
    tx.create('todos/' + noLabel(no), todo);
    tx.set(SEQ_PATH, { last: no, updatedAt: nowMs });
    tx.create(activityPath(nowMs), activityDoc(source === 'manual' || source === 'chat' ? 'create' : 'auto', todo, {}, actor, nowMs));
    return { created: true, todo, label: noLabel(no) };
  });
}

// ── 수정 (상태 변경·완료·다시 열기·미루기·메모 덧붙이기 모두 여기로) ──
export async function updateTodo(ctx, noInput, input) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const upd = cleanPatch(input, { nowMs });
  const needCompanies = 'company' in input || ('bizno' in upd && upd.bizno);
  const companies = needCompanies ? (ctx.companies || await loadCompanies(db)) : [];
  if (needCompanies) applyCompany(upd, input, companies, { autoFromText: false });

  return db.transaction(async (tx) => {
    const doc = await findByNo(tx, noInput);
    const old = doc.data;
    if (old.deletedAt) throw new RuleError(noLabel(old.no) + '는 휴지통에 있습니다. 먼저 되살리세요');
    if (input.memoAppend) {
      const line = kstToday(nowMs).slice(5).replace('-', '/') + ' ' + String(input.memoAppend).trim();
      upd.memo = ((('memo' in upd ? upd.memo : old.memo) || '').trim() + '\n' + line).trim();
    }
    const { write, changes } = applyChange(old, upd, actor, nowMs);
    if (!Object.keys(write).length) return { changed: false, todo: old, label: noLabel(old.no) };
    const after = Object.assign({}, old, write);

    // 반복 할 일을 완료하면 다음 회차를 같은 트랜잭션에서 만든다 (두 번 완료해도 한 건 — dedupeKey)
    let next = null;
    if (write.status === 'done' && after.repeat && after.repeat.every) {
      const base = after.dueDate || kstToday(nowMs);
      const due = nextRepeatDate(base, after.repeat);
      const seriesId = after.seriesId || noLabel(after.no);
      const ref = seriesId + ':' + due;
      const dup = await tx.query('todos', [['dedupeKey', '==', 'repeat:' + ref]], { limit: 1 });
      if (!dup.length) {
        const no = await nextNo(tx);
        const keep = {};
        for (const k of ['text', 'bizno', 'companyName', 'category', 'kind', 'priority', 'assignee', 'tag', 'repeat']) if (after[k]) keep[k] = after[k];
        next = newTodo(Object.assign(keep, { status: 'wait', dueDate: due }), { no, source: 'repeat', sourceRef: ref, actor, nowMs, seriesId });
        tx.create('todos/' + noLabel(no), next);
        tx.set(SEQ_PATH, { last: no, updatedAt: nowMs });
        tx.create(activityPath(nowMs + 1), activityDoc('auto', next, {}, actor, nowMs));
      }
      if (!after.seriesId) write.seriesId = seriesId;
    }
    tx.update(doc.path, write);
    tx.create(activityPath(nowMs), activityDoc(write.status === 'done' ? 'complete' : 'update', after, changes, actor, nowMs));
    return { changed: true, todo: after, label: noLabel(after.no), changes, next: next ? { label: noLabel(next.no), dueDate: next.dueDate } : null };
  });
}

export function completeTodo(ctx, noInput, note) {
  const p = { status: 'done' };
  if (note) p.memoAppend = '완료: ' + note;
  return updateTodo(ctx, noInput, p);
}

// ── 삭제(휴지통) · 되살리기 ── 바로 지우지 않는다. TRASH_DAYS 뒤 예약 작업이 완전히 지운다
export async function deleteTodo(ctx, noInput, reason) {
  const { db, actor, nowMs = Date.now() } = ctx;
  return db.transaction(async (tx) => {
    const doc = await findByNo(tx, noInput);
    if (doc.data.deletedAt) return { changed: false, label: noLabel(doc.data.no) };
    const write = { deletedAt: nowMs, deletedBy: actor.name, deleteReason: String(reason || '').slice(0, 200), updatedAt: nowMs, updatedBy: actor.name };
    tx.update(doc.path, write);
    tx.create(activityPath(nowMs), activityDoc('delete', doc.data, { deleteReason: [null, write.deleteReason] }, actor, nowMs));
    return { changed: true, label: noLabel(doc.data.no), purgeAfter: kstToday(nowMs + TRASH_DAYS * 86400000) };
  });
}
export async function restoreTodo(ctx, noInput) {
  const { db, actor, nowMs = Date.now() } = ctx;
  return db.transaction(async (tx) => {
    const doc = await findByNo(tx, noInput);
    if (!doc.data.deletedAt) return { changed: false, label: noLabel(doc.data.no) };
    tx.update(doc.path, { deletedAt: null, deletedBy: null, deleteReason: null, updatedAt: nowMs, updatedBy: actor.name });
    tx.create(activityPath(nowMs), activityDoc('restore', doc.data, {}, actor, nowMs));
    return { changed: true, label: noLabel(doc.data.no) };
  });
}

// ── 읽기 ──
async function loadRules(db) {
  const cfg = await db.get('app_state/config');
  return Object.assign({}, RULES_DEFAULT, (cfg && cfg.data.todoRules) || {});
}
export function present(t, rules, nowMs) {
  const b = bucket(t, rules, nowMs);
  return {
    no: t.no, label: t.no ? noLabel(t.no) : '(번호 없음)', text: t.text, status: t.status, dueDate: t.dueDate || '',
    bizno: t.bizno || '', companyName: t.companyName || '', category: t.category || '', kind: t.kind || '',
    priority: t.priority || '', waitingFor: t.waitingFor || '', memo: t.memo || '', source: t.source || '',
    createdBy: t.createdBy || '', repeat: t.repeat || null, col: b.col, reason: b.reason,
  };
}
const COL_ORDER = { miss: 0, ing: 1, waiting: 2, todo: 3, later: 4, done: 5, trash: 6 };
//   view: today(놓친·하는 중·기다림·해야) | missed | waiting | week(7일 안 마감) | open(완료 아닌 전부) | recent_done | trash
export async function listTodos(db, { view = 'today', company, category, query, limit = 50 } = {}, nowMs = Date.now()) {
  const [docs, rules] = await Promise.all([db.list('todos'), loadRules(db)]);
  let rows = docs.map(d => present(d.data, rules, nowMs));
  const today = kstToday(nowMs);
  const views = {
    today: r => ['miss', 'ing', 'waiting', 'todo'].includes(r.col),
    missed: r => r.col === 'miss',
    waiting: r => r.col === 'waiting' || (r.status === 'waiting' && r.col === 'miss'),
    week: r => !['done', 'trash'].includes(r.col) && r.dueDate && r.dueDate <= addDaysStr(today, 7),
    open: r => !['done', 'trash'].includes(r.col),
    recent_done: r => r.col === 'done',
    trash: r => r.col === 'trash',
  };
  if (!views[view]) throw new RuleError('보기는 ' + Object.keys(views).join('·') + ' 중 하나입니다');
  rows = rows.filter(views[view]);
  if (company) { const q = String(company).trim(); rows = rows.filter(r => r.bizno === q || r.companyName.includes(q)); }
  if (category) rows = rows.filter(r => r.category === category);
  if (query) { const q = String(query).toLowerCase(); rows = rows.filter(r => (r.text + ' ' + r.memo + ' ' + r.companyName).toLowerCase().includes(q)); }
  if (view === 'recent_done') rows.sort((a, b) => (b.no || 0) - (a.no || 0));
  else rows.sort((a, b) => COL_ORDER[a.col] - COL_ORDER[b.col] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || ((b.priority === 'high') - (a.priority === 'high')));
  return { total: rows.length, items: rows.slice(0, Math.max(1, Math.min(200, limit))) };
}
function addDaysStr(ds, n) { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export async function getTodo(db, noInput, nowMs = Date.now()) {
  const doc = await findByNo(db, noInput);
  const rules = await loadRules(db);
  const hist = await db.query('activity', [['ref', '==', noLabel(doc.data.no)]], { limit: 100 });
  hist.sort((a, b) => b.data.at - a.data.at);
  return Object.assign(present(doc.data, rules, nowMs), {
    deletedAt: doc.data.deletedAt || null,
    history: hist.slice(0, 30).map(h => ({ at: h.data.at, by: h.data.by, via: h.data.via, summary: h.data.summary })),
  });
}

// 그 뒤로 바뀐 것 (통합제어 화면·에이전트용)
export async function changesSince(db, { since, company, limit = 100 } = {}, nowMs = Date.now()) {
  const from = Number(since) || nowMs - 24 * 3600000;
  let rows = (await db.query('activity', [['at', '>=', from]], {})).map(d => d.data);
  if (company) rows = rows.filter(r => r.bizno === company);
  rows.sort((a, b) => b.at - a.at);
  return { since: from, total: rows.length, items: rows.slice(0, Math.min(500, limit)).map(r => ({ at: r.at, ref: r.ref, action: r.action, by: r.by, via: r.via, summary: r.summary })) };
}

// ── 기존 할 일 번호 붙이기 (이전 작업) ── TODO_ARCHITECTURE.md §8
//   번호(no)가 없는 문서에 createdAt 오래된 순으로 번호를 붙이고, 출처·중복키·완료일을 채운다.
//   이미 번호가 있는 문서는 건드리지 않는다 → 여러 번 돌려도 안전. 한 번에 최대 400건(Firestore 한 번 저장 한도 500)
const MIGRATE_MAX = 400;
function legacySource(t) { return t.source || (t.certTaskId ? 'cert' : t.isoAuditId ? 'iso' : 'manual'); }
function legacyDedupe(t, source) {
  if (t.dedupeKey) return t.dedupeKey;
  if (t.sourceRef && source !== 'manual') return source + ':' + t.sourceRef;
  if (t.certTaskId) return 'cert:' + t.certTaskId;
  if (t.isoAuditId) return 'iso:' + t.isoAuditId;
  return '';
}
function migratePlan(docs, lastNo) {
  const todo = docs.filter(d => !(Number(d.data.no) > 0))
    .sort((a, b) => (a.data.createdAt || 0) - (b.data.createdAt || 0) || a.id.localeCompare(b.id));
  const maxNo = docs.reduce((m, d) => Math.max(m, Number(d.data.no) || 0), Number(lastNo) || 0);
  let no = maxNo;
  const items = todo.slice(0, MIGRATE_MAX).map(d => {
    const t = d.data; no += 1;
    const set = { no };
    const source = legacySource(t);
    if (!t.source) set.source = source;
    const dk = legacyDedupe(t, source);
    if (dk && !t.dedupeKey) set.dedupeKey = dk;
    if (t.status === 'done' && !t.doneAt) set.doneAt = t.updatedAt || t.createdAt || null;
    if (!t.status) set.status = 'wait';
    return { path: d.path, docId: d.id, label: noLabel(no), text: t.text || '', companyName: t.companyName || '', status: t.status || 'wait', set };
  });
  return { items, remaining: Math.max(0, todo.length - items.length), lastNo: no, alreadyNumbered: docs.length - todo.length };
}
export async function migratePreview(db) {
  const [docs, seq] = await Promise.all([db.list('todos'), db.get(SEQ_PATH)]);
  const p = migratePlan(docs, seq && seq.data.last);
  return { preview: true, count: p.items.length, remaining: p.remaining, alreadyNumbered: p.alreadyNumbered, nextLastNo: p.lastNo,
    items: p.items.map(i => ({ label: i.label, docId: i.docId, text: i.text, companyName: i.companyName, status: i.status, fills: Object.keys(i.set).filter(k => k !== 'no') })) };
}
export async function migrateApply(ctx) {
  const { db, actor, nowMs = Date.now() } = ctx;
  return db.transaction(async (tx) => {
    const [docs, seq] = [await tx.query('todos', [], {}), await tx.get(SEQ_PATH)];
    const p = migratePlan(docs, seq && seq.data.last);
    if (!p.items.length) return { applied: 0, remaining: 0, lastNo: p.lastNo };
    p.items.forEach(i => tx.update(i.path, i.set));
    tx.set(SEQ_PATH, { last: p.lastNo, updatedAt: nowMs });
    tx.create(activityPath(nowMs), {
      at: nowMs, app: 'todo', ref: 'MIGRATE', no: 0, action: 'migrate',
      summary: actor.name + ' · 기존 할 일 ' + p.items.length + '건에 번호 붙임 (' + p.items[0].label + '~' + p.items[p.items.length - 1].label + ')',
      by: actor.name, via: actor.via, email: actor.email || '', bizno: '', changes: {},
    });
    return { applied: p.items.length, remaining: p.remaining, lastNo: p.lastNo, first: p.items[0].label, last: p.items[p.items.length - 1].label };
  });
}

// ── 사업자번호 변경 반영 (SGCRM 「사업자번호 변경」 TEMP-… → 정식 번호) ── 그 기업의 할 일 bizno·기업명을 옮긴다
export async function rebizno(ctx, from, to) {
  const { db, actor, nowMs = Date.now() } = ctx;
  from = String(from || '').trim(); to = String(to || '').trim();
  if (!from || !to || from === to) throw new RuleError('바꿀 사업자번호(from·to)가 필요합니다');
  const c = (await db.get('companies/' + to));
  const name = c ? (c.data.name || '') : '';
  return db.transaction(async (tx) => {
    const rows = await tx.query('todos', [['bizno', '==', from]], {});
    rows.forEach(r => tx.update(r.path, Object.assign({ bizno: to, updatedAt: nowMs, updatedBy: actor.name }, name ? { companyName: name } : {})));
    if (rows.length) tx.create(activityPath(nowMs), {
      at: nowMs, app: 'todo', ref: 'REBIZNO', no: 0, action: 'rebizno', by: actor.name, via: actor.via, email: actor.email || '', bizno: to, changes: {},
      summary: actor.name + ' · 사업자번호 변경 ' + from + ' → ' + to + ' : 할 일 ' + rows.length + '건 옮김',
    });
    return { moved: rows.length };
  });
}

// ── 여러 건 한 번에 추가 (자동 생성용) ── 트랜잭션 하나: 번호 연속 발급 + 같은 출처 건너뛰기 + 기록
//   Cloudflare 무료 요금제는 요청당 외부 호출 50번 제한 → 한 건씩 만들면 금방 넘는다
export async function createMany(ctx, items) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const companies = ctx.companies || await loadCompanies(db);
  const prepared = [];
  const errors = [];
  for (const it of items) {
    try {
      const f = cleanPatch(it.fields, { nowMs, creating: true });
      applyCompany(f, it.fields, companies, { autoFromText: false });
      prepared.push({ f, source: it.source, sourceRef: it.sourceRef, key: it.source + ':' + it.sourceRef });
    } catch (e) { errors.push((it.fields && it.fields.text) + ': ' + e.message); }
  }
  if (!prepared.length) return { made: [], errors };
  return db.transaction(async (tx) => {
    const keys = [...new Set(prepared.map(p => p.key))];
    const exist = new Set();
    for (let i = 0; i < keys.length; i += 30) {          // Firestore IN 은 30개까지
      (await tx.query('todos', [['dedupeKey', 'in', keys.slice(i, i + 30)]], {})).forEach(r => exist.add(r.data.dedupeKey));
    }
    let no = (await nextNo(tx)) - 1;
    const made = [];
    prepared.filter(p => !exist.has(p.key)).slice(0, 150).forEach((p, i) => {
      exist.add(p.key);
      no += 1;
      const todo = newTodo(p.f, { no, source: p.source, sourceRef: p.sourceRef, actor, nowMs });
      tx.create('todos/' + noLabel(no), todo);
      tx.create(activityPath(nowMs + i), activityDoc('auto', todo, {}, actor, nowMs + i));
      made.push(noLabel(no) + ' ' + todo.text);
    });
    if (made.length) tx.set(SEQ_PATH, { last: no, updatedAt: nowMs });
    return { made, errors };
  });
}
