// ── 할 일 상태 규칙 · 칸 계산 · 기업 찾기 (순수 함수 — Firestore·네트워크 없음) ──
// 쓰기 창구(Worker)와 할 일 웹 화면이 같은 규칙을 쓰도록 이 파일 하나에 모은다.
// 설계: sgcrm/TODO_ARCHITECTURE.md §3

export const STATUSES = ['wait', 'ing', 'waiting', 'hold', 'idea', 'done', 'cancel'];
export const STATUS_LABEL = { wait: '진행', ing: '진행', waiting: '기다리는 중', hold: '장기 대기', idea: '제안', done: '완료', cancel: '취소' };
// 칸 — 시작일이 오면 진행 업무, 아직이면 예정 업무, 끝나면 완료 (2026-10-11 사장님 지시)
//   + 제안 업무(status idea): 업체와 상관없이 우리가 먼저 제안하려는 일. 시작일과 상관없이 이 칸에 머물고,
//     실제로 맡으면(status ing/wait) 하고 있는·예정 업무로 옮겨 간다
//     제안의 시작일·종료일(마감)은 사람이 넣을 때만 저장하고 보여 주기만 한다 (2026-10-12 사장님 지시 — A안)
//     등록한 날로 저절로 채우지 않고, 날짜가 와도 제안 칸에 머물며, 종료일이 지나도 빨간 표시 없이 회색 「종료일 지남」
//   + 📞 통화(kind call, 2026-10-12): 업무가 아니라 「언제 몇 시에 누구에게 전화」. 날짜 = 시작일, 시각 = callTime.
//     진행·예정 업무 칸에는 안 나오고 통화 칸에만. 날짜가 지났는데 안 한 통화는 놓친 통화(빨간 표시)
//   + ⏸ 장기 대기(status hold, 2026-10-28 사장님): ① 업체에 요청하고 회신을 오래 기다리는 일 ② 당장은 아니지만 꼭 처리할 내부 일 — 진행 업무에서 빼 두는 칸(사장님 정의). 사람이 넘길 때만 들어가고
//     빨간 표시(오래 끈 일·마감 지남) 없이 「대기 N일째」만. 다시 맡으면(wait·ing·waiting) 시작일을 따로 안 주면 오늘부터 진행
//     장기 대기는 두 가지(holdKind, 2026-10-28): reply = 📨 업체 회신 대기(공이 업체 쪽) · internal = 🗂 내부 장기 대기(우리가 언젠가 할 일)
//     안 정했으면 「무엇을 기다리나」(waitingFor)가 있으면 업체 회신, 없으면 내부
export const HOLD_KINDS = ['reply', 'internal'];
export const HOLD_LABEL = { reply: '📨 업체 회신 대기', internal: '🗂 내부 장기 대기' };
export function holdKindOf(t) { return HOLD_KINDS.includes(t && t.holdKind) ? t.holdKind : (t && t.waitingFor ? 'reply' : 'internal'); }
export const COLS = ['call', 'ing', 'todo', 'hold', 'idea', 'done'];
export const COL_LABEL = { call: '📞 통화', ing: '진행 업무', todo: '예정 업무', hold: '장기 대기', idea: '제안 업무', done: '완료 업무', trash: '휴지통' };
export const KINDS = ['call', 'doc', 'apply', 'visit', 'chase', 'internal'];
export const KIND_LABEL = { call: '전화', doc: '서류', apply: '신청', visit: '방문', chase: '독촉', internal: '내부' };
// 업무 분야(중분류) — SGCRM DEFAULT_CAT_META와 같은 id. 화면은 칸 안을 이 순서로 묶는다 (2026-10-12)
export const CATEGORIES = [
  ['policy', '💰', '정책자금'], ['support', '🏆', '지원사업'], ['ven', '🚀', '벤처·이노비즈·메인비즈'], ['lab', '🔬', '기업부설연구소'],
  ['pat', '💡', '특허·지재'], ['iso', '🏅', 'ISO 인증'], ['fund', '🏦', '일반자금조달'], ['confirm', '📜', '확인서'],
  ['fin', '📊', '재무'], ['etc', '📋', '기타·행정'],
];
export const CAT_LABEL = Object.fromEntries(CATEGORIES.map(([id, ic, nm]) => [id, ic + ' ' + nm]));
// 분야 말 → id (「정책자금」「벤처」「ISO」처럼 이름으로 와도 알아듣는다. 모르는 말은 그대로 둔다)
export function normCategory(v) {
  const s = String(v ?? '').trim(); if (!s) return '';
  if (CAT_LABEL[s]) return s;
  const k = s.replace(/\s/g, '').toLowerCase();
  const hit = CATEGORIES.find(([id, , nm]) => nm.replace(/\s/g, '').toLowerCase() === k)
    || CATEGORIES.find(([id, , nm]) => nm.replace(/\s/g, '').toLowerCase().split('·').some(p => p && (k === p || k.startsWith(p))));
  if (hit) return hit[0];
  const alias = { 이노비즈: 'ven', 메인비즈: 'ven', 벤처: 'ven', 연구소: 'lab', 특허: 'pat', iso: 'iso', 자금조달: 'fund', 자금: 'fund', 기타: 'etc', 행정: 'etc', 서류: 'etc' };
  return alias[k] || s;
}
export const SOURCES = ['manual', 'chat', 'voice', 'cert', 'iso', 'annual', 'lead', 'card', 'secretary', 'repeat'];
export const AUTHORS = ['정석진', '김학미', '공동'];
export const RULES_DEFAULT = { stallDays: 14, soonDays: 3, horizonDays: 30, leadDays: 14 };
export const TRASH_DAYS = 30;

// 사람이 바꿀 수 있는 칸 (그 외 no·createdAt·source 등은 창구만 정한다)
export const EDITABLE = ['text', 'status', 'holdKind', 'startDate', 'dueDate', 'waitingFor', 'bizno', 'companyName', 'category',
  'kind', 'callTime', 'priority', 'assignee', 'memo', 'tag', 'repeat'];
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

// 통화 시각 말: 14:00 · 14시 · 2시 반 · 오후 2시 · 오전 10시 30분 · 1430 → 'HH:MM'. 빈 값이면 ''(시간 미정)
//   오전/오후 없이 1~7시는 오후로 본다(업무 시간 통화)
export function parseCallTime(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, '');
  if (!s) return '';
  let m = s.match(/^(오전|오후|아침|저녁|낮)?(\d{1,2})(?::|시)(\d{1,2})?(?:분)?(반)?$/) || s.match(/^(오전|오후)?(\d{1,2})(\d{2})$/);
  if (!m) throw new RuleError('통화 시각을 알아볼 수 없습니다: 「' + v + '」 (예: 14:00, 오후 2시, 2시 반)');
  let h = Number(m[2]); let mi = m[3] ? Number(m[3]) : (m[4] ? 30 : 0);
  const ap = m[1] || '';
  if ((ap === '오후' || ap === '저녁') && h < 12) h += 12;
  else if (!ap && h >= 1 && h <= 7) h += 12;
  if (h > 23 || mi > 59) throw new RuleError('통화 시각이 올바르지 않습니다: 「' + v + '」');
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
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
    if (k === 'company' || k === 'memoAppend' || k === 'due' || k === 'start' || k === 'doneDate' || k === 'time') continue;   // 아래에서 따로 처리
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
  if ('holdKind' in patch) {
    const hk = { 업체: 'reply', 회신: 'reply', '업체 회신': 'reply', 내부: 'internal' }[String(patch.holdKind || '').trim()] || patch.holdKind || '';
    if (hk && !HOLD_KINDS.includes(hk)) throw new RuleError('장기 대기 종류는 reply(업체 회신 대기)·internal(내부 장기 대기) 중 하나입니다');
    out.holdKind = hk;
  }
  const dueIn = 'due' in patch ? patch.due : patch.dueDate;
  if ('due' in patch || 'dueDate' in patch) out.dueDate = parseDue(dueIn ?? '', nowMs);
  // 시작일 — 이 날이 오면 「진행 업무」로 옮겨 간다. 빈 값('')은 「비움」 — 제안 업무면 비워 두고, 아니면 applyChange·newTodo가 오늘로 채운다
  const startIn = 'start' in patch ? patch.start : patch.startDate;
  if ('start' in patch || 'startDate' in patch) out.startDate = startIn === '' || startIn === null || startIn === undefined ? '' : parseDue(startIn, nowMs);
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
  // 통화 시각 — time 또는 callTime. 시각을 넣으면 통화(kind call)로 본다
  if ('time' in patch || 'callTime' in patch) {
    out.callTime = parseCallTime('time' in patch ? patch.time : patch.callTime);
    if (out.callTime && !('kind' in out)) out.kind = 'call';
  }
  if ('priority' in patch) out.priority = patch.priority === 'high' || patch.priority === true ? 'high' : '';
  for (const k of ['waitingFor', 'category', 'assignee', 'memo', 'tag', 'bizno', 'companyName']) {
    if (k in patch) out[k] = String(patch[k] ?? '').trim();
  }
  if ('category' in out) out.category = normCategory(out.category);
  if ('memo' in out && out.memo.length > 2000) throw new RuleError('메모가 너무 깁니다(2000자 이하)');
  if ('repeat' in patch) out.repeat = normRepeat(patch.repeat);
  return out;
}

// 기존 문서 old + 정리된 변경 upd → 실제로 쓸 값과 기록용 변경 목록
//   actor: {name, via}  — 이름은 정석진·김학미·공동(채팅이면 'Claude(정석진)')
export function applyChange(old, upd, actor, nowMs = Date.now()) {
  const next = {}; const changes = {};
  upd = Object.assign({}, upd);
  // 제안이었던 일을 완료·취소한 뒤 「다시 열기」(wait)하면 제안으로 돌아간다 — fromIdea로 기억 (2026-10-12 T-0033 사례)
  if (old && old.fromIdea && (old.status === 'done' || old.status === 'cancel') && upd.status === 'wait') upd.status = 'idea';
  const finalStatus = 'status' in upd ? upd.status : old && old.status;
  // 제안 업무의 날짜는 사람이 넣은 것만 — 보통 할 일을 제안으로 돌릴 때 시작일을 함께 주지 않으면 비운다(등록한 날로 채워진 값일 수 있어서)
  if (finalStatus === 'idea' && old && old.status !== 'idea' && !('startDate' in upd)) upd.startDate = '';
  // 보통 할 일은 시작일이 꼭 있다 — 비우라고 오면 오늘
  if (finalStatus !== 'idea' && 'startDate' in upd && !upd.startDate) upd.startDate = kstToday(nowMs);
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
    // 제안 → 실제 업무: 시작일을 따로 주지 않으면 — 「지금 시작」(ing)은 오늘부터, 그 밖에는 제안에 적어 둔 시작일(없으면 오늘)
    // 장기 대기 → 다시 맡음: 시작일을 따로 주지 않으면 오늘부터(대기 전 시작일로 「+40일」처럼 보이지 않게)
    if (old && old.status === 'hold' && ['wait', 'ing', 'waiting'].includes(next.status) && !('startDate' in upd) && !('startDate' in next) && (old.startDate || '') < today) {
      next.startDate = today; changes.startDate = [old.startDate || null, today];
    }
    if (old && old.status === 'idea' && ['wait', 'ing', 'waiting'].includes(next.status) && !('startDate' in upd) && !('startDate' in next)) {
      const s = next.status === 'ing' || !old.startDate ? today : old.startDate;
      if ((old.startDate || '') !== s) { next.startDate = s; changes.startDate = [old.startDate || null, s]; }
    }
  }
  if ('status' in next) {
    if (next.status === 'hold') next.holdAt = nowMs;   // 대기 시작한 때 — 메모를 고쳐도 「대기 N일째」가 다시 0이 되지 않게
    else if (old && old.status === 'hold') { next.holdAt = null; if (old.holdKind) next.holdKind = null; }
    if (old && old.status === 'idea' && (next.status === 'done' || next.status === 'cancel')) next.fromIdea = true;
    else if (old && old.fromIdea && next.status !== 'done' && next.status !== 'cancel') next.fromIdea = null;
  }
  if (TOUCH_FIELDS.some(k => k in changes)) next.statusAt = nowMs;
  next.updatedAt = nowMs;
  next.updatedBy = actor.name;
  return { write: next, changes };
}

// 새 할 일 문서
export function newTodo(fields, { no, source, sourceRef, actor, nowMs = Date.now(), seriesId }) {
  const doc = Object.assign({ status: 'wait', dueDate: '' }, fields);
  if (doc.status === 'idea') doc.startDate = doc.startDate || '';   // 제안 업무 — 사람이 넣은 날짜만 (등록한 날로 채우지 않음)
  else if (!doc.startDate) doc.startDate = kstToday(nowMs);   // 시작일 기본 = 등록한 날
  doc.no = no;
  doc.source = source;
  if (sourceRef) doc.sourceRef = sourceRef;
  if (sourceRef) doc.dedupeKey = source + ':' + sourceRef;
  doc.createdBy = actor.name;
  doc.updatedBy = actor.name;
  doc.createdAt = nowMs; doc.updatedAt = nowMs; doc.statusAt = nowMs;
  if (doc.status === 'done') doc.doneAt = nowMs;
  if (doc.status === 'hold') doc.holdAt = nowMs;   // 처음부터 장기 대기로 넣은 일
  if (doc.repeat) doc.seriesId = seriesId || noLabel(no);
  return doc;
}

// ── 세 칸 계산 + 꼬리표 ── 칸은 시작일만 본다. 긴급·기다림·마감·오래 끈 일은 꼬리표(tags)
//   돌려주는 값: {col: ing|todo|done|trash, days(시작 뒤 지난 날 / 시작까지 남은 날), alert(빨간 표시), tags:[{t, tone}], reason(한 줄 글)}
//   tone: red 빨강 · amber 주황 · wait 기다림 · plain 보통 · mute 회색(제안 업무 종료일 지남)
export function touchedAt(t) { return t.statusAt || t.createdAt || 0; }
export function startOf(t, nowMs = Date.now()) {
  if (t.status === 'idea') return t.startDate || '';   // 제안 업무는 시작일이 없을 수 있다
  return t.startDate || (t.createdAt ? kstToday(t.createdAt) : kstToday(nowMs));
}
// 칸 앞머리 날짜 표시 (2026-10-13 사장님): 진행 업무 = 오늘 시작 · +1일 · +2일 … (시작일에서 며칠 지났나)
//   예정 업무 = -1일 · -2일 … (시작일까지 며칠 남았나). days는 bucket 값 그대로(진행은 시작한 날 = 1)
export function dayTag(col, days) {
  if (col === 'ing') return days <= 1 ? '오늘 시작' : '+' + (days - 1) + '일';
  if (col === 'todo') return '-' + days + '일';
  return '';
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
  if (t.status === 'hold') {   // ⏸ 장기 대기 — 빨간 표시 없음. 대기에 들어간 날(statusAt)부터 며칠째인지만
    const since = t.holdAt || touchedAt(t);
    const d = since ? daysBetween(kstToday(since), today) : 0;
    if (t.priority === 'high') tags.push({ t: '긴급', tone: 'red' });
    const hk = holdKindOf(t);
    if (t.waitingFor) tags.push({ t: '⏳ ' + t.waitingFor, tone: 'wait' });
    if (due) tags.push({ t: (dleft < 0 ? '마감 지남 ' : '마감 ') + due.slice(5).replace('-', '/'), tone: 'mute' });
    const head = hk === 'reply' ? (d === 0 ? '오늘 요청' : '요청 ' + d + '일째') : (d === 0 ? '오늘 대기 시작' : '대기 ' + d + '일째');
    return { col: 'hold', holdKind: hk, days: d, alert: false, tags, reason: [head].concat(tags.map(x => x.t)).join(' · ') };
  }
  if (t.kind === 'call' && t.status !== 'idea') {   // 📞 통화 — 날짜(시작일)·시각만 본다. 날짜 지났는데 안 했으면 놓친 통화
    const d = start;
    const when = (d === today ? '오늘' : d === addDays(today, 1) ? '내일' : d.slice(5).replace('-', '/')) + (t.callTime ? ' ' + t.callTime : ' 시간 미정');
    const missed = d < today;
    if (t.priority === 'high') tags.push({ t: '긴급', tone: 'red' });
    if (missed) tags.push({ t: '놓친 통화', tone: 'red' });
    if (t.status === 'waiting') tags.push({ t: '⏳ ' + (t.waitingFor || '기다리는 중'), tone: 'wait' });
    return { col: 'call', days: daysBetween(today, d), alert: missed, tags, reason: [when].concat(tags.map(x => x.t)).join(' · ') };
  }
  if (t.status === 'idea') {   // 제안 업무 — 날짜로 압박하지 않는다(빨간 표시 없음). 얼마나 묵었는지만
    const age = t.createdAt ? daysBetween(kstToday(t.createdAt), today) : 0;
    if (t.priority === 'high') tags.push({ t: '긴급', tone: 'red' });
    // 날짜는 보여 주기만 — 시작일이 와도 제안 칸 그대로, 종료일이 지나도 빨간 표시 없음
    if (start) tags.push({ t: '시작 ' + start.slice(5).replace('-', '/'), tone: 'plain' });
    if (due) tags.push(dleft < 0 ? { t: '종료일 지남', tone: 'mute' } : { t: '종료 ' + due.slice(5).replace('-', '/'), tone: 'plain' });
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
    return { col: 'todo', days: left, alert, tags, reason: [dayTag('todo', left)].concat(tags.map(x => x.t)).join(' · ') };
  }
  const days = daysBetween(start, today) + 1;   // 시작한 날 = 1일째
  if (days >= rules.stallDays) alert = true;     // 오래 끈 일
  const head = dayTag('ing', days);
  return { col: 'ing', days, alert, tags, reason: [head].concat(tags.map(x => x.t)).join(' · ') };
}

// 화면에 보일 업무 글 (2026-10-28 사장님: 「업무 먼저, 회사는 🏢 칩」으로 통일) — 저장된 글은 그대로, 보여 줄 때만
//   회사가 연결된 업무면 글 맨 앞의 [회사명] 또는 회사 이름(주식회사·(주)·㈜·(유) 등 떼고, 띄어쓰기 달라도)을 뗀다.
//   뒤에 바로 한글이 붙으면(「하이퍼다인에」) 떼지 않는다. 다 떼고 남는 글이 없으면 원래 글
const CORP_RE = /주식회사|유한회사|농업회사법인|\(주\)|㈜|\(유\)|\(사\)|\(재\)/g;
export function taskText(t) {
  const x = String((t && t.text) || '').trim();
  if (!t || !t.companyName) return x;
  let y = x.replace(/^\[[^\]]+\]\s*/, '');
  const base = String(t.companyName).replace(CORP_RE, ' ').replace(/\s+/g, ' ').trim();
  if (base) {
    const names = [base, base.replace(/\s/g, '')].concat(base.split(' ').filter(w => w.length >= 2));
    const lead = y.match(/^(?:주식회사|\(주\)|㈜|\(유\)|유한회사)?\s*/)[0];
    const body = y.slice(lead.length);
    for (const n of names.sort((a, b) => b.length - a.length)) {
      if (n.length < 2 || !body.toLowerCase().startsWith(n.toLowerCase())) continue;
      const rest = body.slice(n.length);
      if (/^[가-힣A-Za-z0-9]/.test(rest)) continue;   // 「하이퍼다인에」처럼 낱말이 이어지면 그대로
      const z = rest.replace(/^\s*(?:주식회사|\(주\)|㈜)?\s*[·\-—:,/|]?\s*/, '');
      if (z) { y = z; break; }
    }
  }
  return y || x;
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
