// ── 할 일 상태 규칙 · 칸 계산 · 기업 찾기 (순수 함수 — Firestore·네트워크 없음) ──
// 쓰기 창구(Worker)와 할 일 웹 화면이 같은 규칙을 쓰도록 이 파일 하나에 모은다.
// 설계: sgcrm/TODO_ARCHITECTURE.md §3

export const STATUSES = ['wait', 'ing', 'waiting', 'idea', 'done', 'cancel'];
export const STATUS_LABEL = { wait: '진행', ing: '진행', waiting: '기다리는 중', idea: '제안', done: '완료', cancel: '취소' };
// 칸 — 시작일이 오면 하고 있는 업무, 아직이면 해야 할 업무, 끝나면 완료 (2026-10-11 사장님 지시)
//   + 제안 업무(status idea): 업체와 상관없이 우리가 먼저 제안하려는 일. 시작일과 상관없이 이 칸에 머물고,
//     실제로 맡으면(status ing/wait) 하고 있는·해야 할 업무로 옮겨 간다
export const COLS = ['ing', 'todo', 'idea', 'done'];
export const COL_LABEL = { ing: '하고 있는 업무', todo: '해야 할 업무', idea: '제안 업무', done: '완료 업무', trash: '휴지통' };
export const KINDS = ['call', 'doc', 'apply', 'visit', 'chase', 'internal'];
export const KIND_LABEL = { call: '전화', doc: '서류', apply: '신청', visit: '방문', chase: '독촉', internal: '내부' };
export const SOURCES = ['manual', 'chat', 'voice', 'cert', 'iso', 'annual', 'lead', 'card', 'secretary', 'repeat'];
export const AUTHORS = ['정석진', '김학미', '공동'];
export const RULES_DEFAULT = { stallDays: 14, soonDays: 3, horizonDays: 30, leadDays: 14 };
export const TRASH_DAYS = 30;

// 사람이 바꿀 수 있는 칸 (그 외 no·createdAt·source 등은 창구만 정한다)
export const EDITABLE = ['text', 'status', 'startDate', 'dueDate', 'waitingFor', 'bizno', 'companyName', 'category',
  'kind', 'priority', 'assignee', 'memo', 'tag', 'repeat'];
// 바뀌면 「손댄 것」으로 보는 칸 — 멈춤 판정 기준 statusAt 갱신 (CRM 기존 규칙과 같음)
const TOUCH_FIELDS = ['status', 'startDate', 'dueDate', 'memo', 'waitingFor'];

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

// 완료한 날 말: 오늘 · 어제 · 그제 · -3(3일 전) · 10/14 · 2026-10-14 — 지난 날짜만 (앞날이면 거절)
export function parseDoneDate(v, nowMs = Date.now()) {
  const today = kstToday(nowMs);
  if (v === undefined || v === null || String(v).trim() === '') return today;
  const s = String(v).trim();
  const rel = { '오늘': 0, '어제': 1, '그제': 2, '그저께': 2, '엊그제': 2, '내일': -1, '모레': -2 };   // 내일·모레는 아래에서 「앞날」로 거절
  let d;
  if (s in rel) d = addDays(today, -rel[s]);
  else {
    let m = s.match(/^-(\d{1,3})$/) || s.match(/^(\d{1,3})\s*일\s*전$/);
    if (m) d = addDays(today, -Number(m[1]));
    else {
      m = s.match(/^(20\d{2})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})$/);
      if (m) d = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
      else {
        m = s.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/) || s.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (m) {
          const y = Number(today.slice(0, 4));
          d = y + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
          if (isDate(d) && d > today) d = (y - 1) + d.slice(4);   // 앞날 월/일이면 작년
        }
      }
    }
  }
  if (!d || !isDate(d)) throw new RuleError('완료한 날을 알아볼 수 없습니다: 「' + s + '」 (예: 오늘, 어제, 10/14)');
  if (d > today) throw new RuleError('완료한 날이 앞날입니다: ' + d);
  return d;
}
// 완료한 날 → doneAt(ms). 오늘이면 지금 시각, 지난 날이면 그날 정오(한국)
export function doneAtOf(ds, nowMs = Date.now()) {
  return ds === kstToday(nowMs) ? nowMs : Date.parse(ds + 'T12:00:00+09:00');
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
    if (k === 'company' || k === 'memoAppend' || k === 'due' || k === 'start' || k === 'doneDate') continue;   // 아래에서 따로 처리
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
  // 시작일 — 비우면 오늘. 이 날이 오면 「하고 있는 업무」로 옮겨 간다
  const startIn = 'start' in patch ? patch.start : patch.startDate;
  if ('start' in patch || 'startDate' in patch) out.startDate = startIn === '' || startIn === null || startIn === undefined ? kstToday(nowMs) : parseDue(startIn, nowMs);
  // 완료한 날 — 넣으면 완료로 바꾸고 그날을 완료일로
  if ('doneDate' in patch) {
    if (creating) throw new RuleError('새 할 일은 완료 상태로 만들 수 없습니다');
    if ('status' in out && out.status !== 'done') throw new RuleError('완료한 날(doneDate)은 완료(status=done)일 때만 넣습니다');
    out.status = 'done';
    out.doneAt = doneAtOf(parseDoneDate(patch.doneDate, nowMs), nowMs);
  }
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
  upd = Object.assign({}, upd);
  if ('doneAt' in upd && old && old.doneAt && kstToday(old.doneAt) === kstToday(upd.doneAt)) delete upd.doneAt;   // 같은 날이면 그대로
  for (const [k, v] of Object.entries(upd)) {
    const before = old ? old[k] : undefined;
    if (JSON.stringify(before ?? '') === JSON.stringify(v ?? '')) continue;
    next[k] = v; changes[k] = [before ?? null, v ?? null];
  }
  if (!Object.keys(next).length) return { write: {}, changes: {} };
  if ('status' in next) {
    if (next.status === 'done') { if (!('doneAt' in upd)) next.doneAt = nowMs; }
    else if (old && (old.status === 'done' || old.status === 'cancel')) next.doneAt = null;   // 다시 열면 완료일 지움
    // 「시작」(ing)으로 바꿨는데 시작일이 앞날이면 오늘로 당긴다
    const today = kstToday(nowMs);
    if (next.status === 'ing' && !('startDate' in upd) && old && old.startDate && old.startDate > today) {
      next.startDate = today; changes.startDate = [old.startDate, today];
    }
    // 제안 → 실제 업무: 시작일을 따로 주지 않으면 오늘부터 (제안으로 묵힌 날은 「N일째」에 넣지 않는다)
    if (old && old.status === 'idea' && ['wait', 'ing', 'waiting'].includes(next.status) && !('startDate' in upd) && (old.startDate || '') !== today) {
      next.startDate = today; changes.startDate = [old.startDate || null, today];
    }
  }
  if (TOUCH_FIELDS.some(k => k in changes)) next.statusAt = nowMs;
  next.updatedAt = nowMs;
  next.updatedBy = actor.name;
  return { write: next, changes };
}

// 새 할 일 문서
export function newTodo(fields, { no, source, sourceRef, actor, nowMs = Date.now(), seriesId }) {
  const doc = Object.assign({ status: 'wait', dueDate: '' }, fields);
  if (!doc.startDate) doc.startDate = kstToday(nowMs);   // 시작일 기본 = 등록한 날
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

// ── 세 칸 계산 + 꼬리표 ── 칸은 시작일만 본다. 긴급·기다림·마감·오래 끈 일은 꼬리표(tags)
//   돌려주는 값: {col: ing|todo|done|trash, days(시작 뒤 지난 날 / 시작까지 남은 날), alert(빨간 표시), tags:[{t, tone}], reason(한 줄 글)}
//   tone: red 빨강 · amber 주황 · wait 기다림 · plain 보통
export function touchedAt(t) { return t.statusAt || t.createdAt || 0; }
export function startOf(t, nowMs = Date.now()) {
  return t.startDate || (t.createdAt ? kstToday(t.createdAt) : kstToday(nowMs));
}
export function bucket(t, rules = RULES_DEFAULT, nowMs = Date.now()) {
  if (t.deletedAt) return { col: 'trash', days: 0, alert: false, tags: [], reason: '' };
  const tags = [];
  if (t.status === 'done' || t.status === 'cancel') {
    const dd = t.doneAt ? kstToday(t.doneAt) : '';
    return { col: 'done', days: 0, alert: false, tags: t.status === 'cancel' ? [{ t: '취소', tone: 'plain' }] : [], reason: t.status === 'cancel' ? '취소' : dd ? dd.slice(5).replace('-', '/') + ' 완료' : '완료' };
  }
  const today = kstToday(nowMs);
  const start = startOf(t, nowMs);
  const due = t.dueDate || '';
  const dleft = due ? daysBetween(today, due) : null;
  if (t.status === 'idea') {   // 제안 업무 — 날짜로 압박하지 않는다(빨간 표시 없음). 얼마나 묵었는지만
    const age = t.createdAt ? daysBetween(kstToday(t.createdAt), today) : 0;
    if (t.priority === 'high') tags.push({ t: '긴급', tone: 'red' });
    if (due) tags.push({ t: '제안 목표 ' + due.slice(5).replace('-', '/'), tone: 'plain' });
    return { col: 'idea', days: age, alert: false, tags, reason: [age === 0 ? '오늘 등록' : '등록 ' + age + '일 전'].concat(tags.map(x => x.t)).join(' · ') };
  }
  if (t.priority === 'high') tags.push({ t: '긴급', tone: 'red' });
  if (t.status === 'waiting') tags.push({ t: '⏳ ' + (t.waitingFor || '기다리는 중'), tone: 'wait' });
  let alert = false;
  if (due) {
    if (dleft < 0) { tags.push({ t: '마감 ' + (-dleft) + '일 지남', tone: 'red' }); alert = true; }
    else tags.push({ t: '마감 ' + (dleft === 0 ? '오늘' : 'D-' + dleft), tone: dleft <= rules.soonDays ? 'amber' : 'plain' });
  }
  if (start > today) {
    const left = daysBetween(today, start);
    return { col: 'todo', days: left, alert, tags, reason: [(left === 1 ? '내일 시작' : 'D-' + left)].concat(tags.map(x => x.t)).join(' · ') };
  }
  const days = daysBetween(start, today) + 1;   // 시작한 날 = 1일째
  if (days >= rules.stallDays) alert = true;     // 오래 끈 일
  const head = days === 1 ? '오늘 시작' : days + '일째';
  return { col: 'ing', days, alert, tags, reason: [head].concat(tags.map(x => x.t)).join(' · ') };
}

// 변동 기록 한 줄 요약
export function summarize(action, todo, changes, actorName) {
  const who = actorName || '';
  const head = noLabel(todo.no) + ' ' + (todo.companyName ? todo.companyName + ' — ' : '') + (todo.text || '');
  const verbs = { create: '추가', complete: '완료', delete: '삭제(휴지통)', restore: '되살림', auto: '자동 추가' };
  if (verbs[action]) return who + ' · ' + head + ' → ' + verbs[action];
  const parts = Object.entries(changes || {}).map(([k, [, to]]) => {
    if (k === 'status') return (changes.status[0] === 'idea' && to !== 'idea' ? '제안 → ' : '') + (STATUS_LABEL[to] || to);
    if (k === 'dueDate') return to ? '마감 ' + to : '마감 없앰';
    if (k === 'startDate') return '시작 ' + to;
    if (k === 'doneAt') return to ? '완료일 ' + kstToday(to) : '완료일 지움';
    if (k === 'text') return '내용 수정';
    if (k === 'memo') return '메모 수정';
    if (k === 'bizno') return '기업 연결 변경';
    return k + ' 변경';
  });
  return who + ' · ' + head + ' → ' + (parts.join(', ') || '수정');
}
