// ── 할 일 상태 규칙 · 칸 계산 · 기업 찾기 (순수 함수 — Firestore·네트워크 없음) ──
// 쓰기 창구(Worker)와 할 일 웹 화면이 같은 규칙을 쓰도록 이 파일 하나에 모은다.
// 설계: sgcrm/TODO_ARCHITECTURE.md §3

export const STATUSES = ['wait', 'ing', 'waiting', 'done', 'cancel'];
export const STATUS_LABEL = { wait: '해야 할 일', ing: '하는 중', waiting: '기다리는 중', done: '완료', cancel: '취소' };
export const KINDS = ['call', 'doc', 'apply', 'visit', 'chase', 'internal'];
export const KIND_LABEL = { call: '전화', doc: '서류', apply: '신청', visit: '방문', chase: '독촉', internal: '내부' };
export const SOURCES = ['manual', 'chat', 'voice', 'cert', 'iso', 'annual', 'lead', 'card', 'secretary', 'repeat'];
export const AUTHORS = ['정석진', '김학미', '공동'];
export const RULES_DEFAULT = { stallDays: 14, soonDays: 3, horizonDays: 30, leadDays: 14 };
export const TRASH_DAYS = 30;

// 사람이 바꿀 수 있는 칸 (그 외 no·createdAt·source 등은 창구만 정한다)
export const EDITABLE = ['text', 'status', 'dueDate', 'waitingFor', 'bizno', 'companyName', 'category',
  'kind', 'priority', 'assignee', 'memo', 'tag', 'repeat'];
// 바뀌면 「손댄 것」으로 보는 칸 — 멈춤 판정 기준 statusAt 갱신 (CRM 기존 규칙과 같음)
const TOUCH_FIELDS = ['status', 'dueDate', 'memo', 'waitingFor'];

export class RuleError extends Error {
  constructor(msg, extra) { super(msg); this.name = 'RuleError'; this.extra = extra || null; }
}

export const noLabel = (no) => 'T-' + String(no).padStart(4, '0');
export function parseNo(v) {
  const m = String(v ?? '').trim().match(/^(?:T-?)?0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

// ── 날짜 (한국 시간 기준 YYYY-MM-DD) ──
export function kstToday(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
}
export function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
export function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {   // a → b 일수
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
// 채팅에서 오는 날짜 말: 2026-10-20 · 2026.10.20 · 10/20 · 10월 20일 · 오늘·내일·모레 · +7(7일 뒤)
export function parseDue(v, nowMs = Date.now()) {
  if (v === '' || v === null) return '';
  if (v === undefined) return undefined;
  const s = String(v).trim();
  const today = kstToday(nowMs);
  const rel = { '오늘': 0, '내일': 1, '모레': 2, '글피': 3 };
  if (s in rel) return addDays(today, rel[s]);
  let m = s.match(/^\+(\d{1,3})$/);
  if (m) return addDays(today, Number(m[1]));
  m = s.match(/^(20\d{2})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})$/);
  if (m) { const d = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0'); if (isDate(d)) return d; }
  m = s.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/) || s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const y = Number(today.slice(0, 4));
    let d = y + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    if (isDate(d)) {
      if (daysBetween(d, today) > 60) d = (y + 1) + d.slice(4);   // 한참 지난 월/일이면 내년
      return d;
    }
  }
  throw new RuleError('날짜를 알아볼 수 없습니다: 「' + s + '」 (예: 2026-10-20, 10/20, 내일)');
}

// ── 반복 ── {every:'week'|'month'|'year', n:1, day?, month?}
export function normRepeat(r) {
  if (r === null || r === '' || r === undefined) return r === undefined ? undefined : null;
  if (typeof r !== 'object') throw new RuleError('반복 형식이 올바르지 않습니다');
  const every = r.every;
  if (!['week', 'month', 'year'].includes(every)) throw new RuleError('반복 단위는 week·month·year 중 하나입니다');
  const n = Math.max(1, Math.min(12, Number(r.n) || 1));
  const out = { every, n };
  if (every === 'week' && r.day !== undefined) { const d = Number(r.day); if (d >= 0 && d <= 6) out.day = d; }   // 0=일 … 6=토
  if (every !== 'week' && r.day !== undefined) { const d = Number(r.day); if (d >= 1 && d <= 31) out.day = d; }
  if (every === 'year' && r.month !== undefined) { const mo = Number(r.month); if (mo >= 1 && mo <= 12) out.month = mo; }
  return out;
}
export function nextRepeatDate(base, rep) {
  const d = new Date(base + 'T00:00:00Z');
  if (rep.every === 'week') {
    d.setUTCDate(d.getUTCDate() + 7 * rep.n);
    if (rep.day !== undefined) { const diff = (rep.day - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + diff); }
    return d.toISOString().slice(0, 10);
  }
  const months = rep.every === 'month' ? rep.n : 12 * rep.n;
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  if (rep.every === 'year' && rep.month) m = rep.month - 1;
  const want = rep.day || d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // 31일이 없는 달은 말일로
  return new Date(Date.UTC(y, m, Math.min(want, last))).toISOString().slice(0, 10);
}

// ── 기업명 짝짓기 (SGCRM normCompName·compNameKeys·findCompany와 같은 규칙) ──
export function normCompName(n) {
  return String(n || '').replace(/주식회사|유한회사|농업회사법인|영농조합법인|\(주\)|㈜|\(유\)|\(사\)|\s|[()·.,\-_]/g, '').toLowerCase();
}
export function compNameKeys(n) {
  n = String(n || '');
  const keys = [normCompName(n.replace(/\((?!주\)|유\))[^)]*\)/g, ''))];
  const inner = n.match(/\((?!주\)|유\))([^)]+)\)/);
  if (inner) keys.push(normCompName(inner[1]));
  keys.push(normCompName(n.replace(/[가-힣]+\(([A-Za-z0-9 &]+)\)/, '$1')));
  return keys.filter((k, i) => k.length >= 2 && keys.indexOf(k) === i);
}
const BIZNO_RE = /^(\d{3}-\d{2}-\d{5}|TEMP-\d+)$/i;
// 이름 또는 사업자번호 → {company} | {candidates:[...]} | {none:true}
export function resolveCompany(query, companies) {
  const q = String(query || '').trim();
  if (!q) return { none: true };
  const live = companies.filter(c => c.active !== 'N');
  if (BIZNO_RE.test(q) || /^\d{10}$/.test(q)) {
    const id = /^\d{10}$/.test(q) ? q.slice(0, 3) + '-' + q.slice(3, 5) + '-' + q.slice(5) : q.toUpperCase();
    const c = companies.find(x => x.id.toUpperCase() === id);
    return c ? { company: c } : { none: true };
  }
  const nq = normCompName(q);
  const exact = live.filter(c => compNameKeys(c.name).includes(nq));
  if (exact.length === 1) return { company: exact[0] };
  if (exact.length > 1) return { candidates: exact };
  const part = live.filter(c => compNameKeys(c.name).some(k => k.includes(nq) || nq.includes(k)));
  if (part.length === 1) return { company: part[0] };
  if (part.length > 1) return { candidates: part.slice(0, 8) };
  return { none: true };
}
// 글 속에서 가장 길게 맞는 기업 하나 (채팅 글에 기업명이 섞여 있을 때)
export function findCompanyInText(text, companies) {
  const nt = normCompName(text); let best = null, len = 0;
  companies.forEach(c => {
    if (c.active === 'N') return;
    compNameKeys(c.name).forEach(k => { if (k.length > len && nt.includes(k)) { best = c; len = k.length; } });
  });
  return best;
}

// ── 입력 정리·검증 ── patch는 사람이 보낸 값. 모르는 칸·잘못된 값은 거절
export function cleanPatch(patch, { nowMs = Date.now(), creating = false } = {}) {
  if (!patch || typeof patch !== 'object') throw new RuleError('바꿀 내용이 없습니다');
  const out = {};
  for (const k of Object.keys(patch)) {
    if (k === 'company' || k === 'memoAppend' || k === 'due') continue;   // 아래에서 따로 처리
    if (!EDITABLE.includes(k)) throw new RuleError('바꿀 수 없는 항목입니다: ' + k);
  }
  if ('text' in patch) {
    const t = String(patch.text ?? '').trim();
    if (!t) throw new RuleError('할 일 내용이 비어 있습니다');
    if (t.length > 500) throw new RuleError('할 일 내용이 너무 깁니다(500자 이하)');
    out.text = t;
  } else if (creating) throw new RuleError('할 일 내용이 비어 있습니다');
  if ('status' in patch) {
    if (!STATUSES.includes(patch.status)) throw new RuleError('상태는 ' + STATUSES.join('·') + ' 중 하나입니다');
    out.status = patch.status;
  }
  const dueIn = 'due' in patch ? patch.due : patch.dueDate;
  if ('due' in patch || 'dueDate' in patch) out.dueDate = parseDue(dueIn ?? '', nowMs);
  if ('kind' in patch) {
    if (patch.kind && !KINDS.includes(patch.kind)) throw new RuleError('종류는 ' + KINDS.join('·') + ' 중 하나입니다');
    out.kind = patch.kind || '';
  }
  if ('priority' in patch) out.priority = patch.priority === 'high' || patch.priority === true ? 'high' : '';
  for (const k of ['waitingFor', 'category', 'assignee', 'memo', 'tag', 'bizno', 'companyName']) {
    if (k in patch) out[k] = String(patch[k] ?? '').trim();
  }
  if ('memo' in out && out.memo.length > 2000) throw new RuleError('메모가 너무 깁니다(2000자 이하)');
  if ('repeat' in patch) out.repeat = normRepeat(patch.repeat);
  return out;
}

// 기존 문서 old + 정리된 변경 upd → 실제로 쓸 값과 기록용 변경 목록
//   actor: {name, via}  — 이름은 정석진·김학미·공동(채팅이면 'Claude(정석진)')
export function applyChange(old, upd, actor, nowMs = Date.now()) {
  const next = {}; const changes = {};
  for (const [k, v] of Object.entries(upd)) {
    const before = old ? old[k] : undefined;
    if (JSON.stringify(before ?? '') === JSON.stringify(v ?? '')) continue;
    next[k] = v; changes[k] = [before ?? null, v ?? null];
  }
  if (!Object.keys(next).length) return { write: {}, changes: {} };
  if ('status' in next) {
    if (next.status === 'done') next.doneAt = nowMs;
    else if (old && (old.status === 'done' || old.status === 'cancel')) next.doneAt = null;   // 다시 열면 완료일 지움
  }
  if (TOUCH_FIELDS.some(k => k in changes)) next.statusAt = nowMs;
  next.updatedAt = nowMs;
  next.updatedBy = actor.name;
  return { write: next, changes };
}

// 새 할 일 문서
export function newTodo(fields, { no, source, sourceRef, actor, nowMs = Date.now(), seriesId }) {
  const doc = Object.assign({ status: 'wait', dueDate: '' }, fields);
  doc.no = no;
  doc.source = source;
  if (sourceRef) doc.sourceRef = sourceRef;
  if (sourceRef) doc.dedupeKey = source + ':' + sourceRef;
  doc.createdBy = actor.name;
  doc.updatedBy = actor.name;
  doc.createdAt = nowMs; doc.updatedAt = nowMs; doc.statusAt = nowMs;
  if (doc.status === 'done') doc.doneAt = nowMs;
  if (doc.repeat) doc.seriesId = seriesId || noLabel(no);
  return doc;
}

// ── 네 칸(+기다리는 중) 계산 — SGCRM todoBucket과 같은 규칙에 waiting·cancel·휴지통 추가 ──
export function touchedAt(t) { return t.statusAt || t.createdAt || 0; }
export function bucket(t, rules = RULES_DEFAULT, nowMs = Date.now()) {
  if (t.deletedAt) return { col: 'trash', reason: '' };
  if (t.status === 'done' || t.status === 'cancel') return { col: 'done', reason: '' };
  const today = kstToday(nowMs);
  const due = t.dueDate || '';
  const dleft = due ? daysBetween(today, due) : null;
  const idle = Math.floor((nowMs - touchedAt(t)) / 86400000);
  if (t.status === 'waiting') {
    if (due && dleft < 0) return { col: 'miss', reason: '확인일 ' + (-dleft) + '일 지남' + (t.waitingFor ? ' · ' + t.waitingFor : '') };
    if (!due && touchedAt(t) && idle >= rules.stallDays) return { col: 'miss', reason: idle + '일째 기다림' };
    return { col: 'waiting', reason: (t.waitingFor || '') + (due ? (t.waitingFor ? ' · ' : '') + '확인 D-' + dleft : '') };
  }
  if (due && dleft < 0) return { col: 'miss', reason: '마감 ' + (-dleft) + '일 지남' };
  if (t.status === 'ing' && touchedAt(t) && idle >= rules.stallDays) return { col: 'miss', reason: idle + '일째 그대로' };
  if (t.status !== 'ing' && due && dleft <= rules.soonDays) return { col: 'miss', reason: 'D-' + dleft + ' · 아직 시작 안 함' };
  if (t.status === 'ing') return { col: 'ing', reason: due ? 'D-' + dleft : '' };
  if (!due || dleft <= rules.horizonDays) return { col: 'todo', reason: due ? 'D-' + dleft : '' };
  return { col: 'later', reason: due };
}

// 변동 기록 한 줄 요약
export function summarize(action, todo, changes, actorName) {
  const who = actorName || '';
  const head = noLabel(todo.no) + ' ' + (todo.companyName ? todo.companyName + ' — ' : '') + (todo.text || '');
  const verbs = { create: '추가', complete: '완료', delete: '삭제(휴지통)', restore: '되살림', auto: '자동 추가' };
  if (verbs[action]) return who + ' · ' + head + ' → ' + verbs[action];
  const parts = Object.entries(changes || {}).map(([k, [, to]]) => {
    if (k === 'status') return STATUS_LABEL[to] || to;
    if (k === 'dueDate') return to ? '마감 ' + to : '마감 없앰';
    if (k === 'text') return '내용 수정';
    if (k === 'memo') return '메모 수정';
    if (k === 'bizno') return '기업 연결 변경';
    return k + ' 변경';
  });
  return who + ' · ' + head + ' → ' + (parts.join(', ') || '수정');
}
