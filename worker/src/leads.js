// ── 📣 광고 DB (Meta 리드 광고) ── 2026-10-13
// 광고 4개(ISO심사·벤처인증·기업인증·ESG인증)로 들어온 신청자(DB)를 받아 「놓치지 않고 전화」하도록 관리한다.
//   들어오는 길: ① 5분마다 Meta에서 직접 가져오기(syncMeta — META_TOKEN 비밀값이 있을 때) ② 예비: 웹에서 Meta 엑셀·CSV 올리기(importLeads)
//   저장: Firestore `leads/D-0001` (번호 = app_state/lead_seq), 변동은 `activity`에 한 줄 (할 일과 같은 곳)
//   중복: Meta 리드 ID(metaId)가 같거나, 같은 광고에 같은 전화번호면 다시 넣지 않는다
//
// 상태 status: new(새 DB) → noans(부재, tries 1~2) → talk(상담 중) → won(고객 전환) / lost(거절·무효) / unreach(부재 3번 = 연락 안 됨)
//   부재를 누르면 다음 영업일 재통화(nextCallDate)가 잡히고, 3번째 부재면 연락 안 됨으로 닫힌다
//   새 DB가 들어온 지 24시간 넘게 전화 안 했으면 빨간 표시, 재통화 날짜가 지났어도 빨간 표시
// 담당 assignee 기본 = 정석진(사장님 지시 10/13)
//
// 📒 통화 이력 calls (2026-10-14 사장님: DB가 들어와서 미팅 잡힐 때까지 통화한 내용을 남긴다)
//   전화 결과·메모를 남길 때마다 [{at, by, action, what}] 한 줄씩 쌓는다(덮어쓰지 않음, 최근 100줄).
//   🤝 미팅 약속(meeting) = 이력의 끝 — 상태 meet(미팅 예정), 날짜 meetDate·시각 meetTime. 미팅 뒤 결과는 전환(won)·거절(lost)
//   이력을 남기기 전 기록(10/13~)은 activity에서 한 번 옮겨 채운다(backfillLeadCalls — 5분 가져오기 때 한 번만)

import { RuleError, kstToday, addDays, parseDue } from './core.js';
import { NotFoundError, createTodo } from './todos.js';

export const PRODUCTS = [['iso', 'ISO심사'], ['venture', '벤처인증'], ['cert', '기업인증'], ['esg', 'ESG인증'], ['etc', '기타']];
export const PRODUCT_LABEL = Object.fromEntries(PRODUCTS);
export const LEAD_STATUS = { new: '🆕 새 DB', noans: '📞 부재', talk: '💬 상담 중', meet: '🤝 미팅 예정', won: '✅ 고객 전환', lost: '✖ 거절·무효', unreach: '📵 연락 안 됨' };
export const CLOSED = ['won', 'lost', 'unreach'];
export const MAX_TRIES = 3;
export const NEW_ALERT_HOURS = 24;
export const DEFAULT_ASSIGNEE = '정석진';
const SEQ_PATH = 'app_state/lead_seq';
export const SYNC_PATH = 'app_state/lead_sync';
const BACKFILL_DAYS = 90;   // 처음 연결할 때 Meta에서 가져오는 기간(Meta가 리드를 90일 보관)
const HOUR = 3600000;

export const leadLabel = (no) => 'D-' + String(no).padStart(4, '0');
export function parseLeadNo(v) {
  const m = String(v ?? '').trim().match(/^(?:d-?)?0*(\d{1,6})$/i);
  return m ? Number(m[1]) : 0;
}

// 광고·양식 이름으로 광고 종류 고르기 — ESG·ISO·벤처를 먼저 보고, 남은 「인증」은 기업인증
export function classifyProduct(...texts) {
  const s = texts.filter(Boolean).join(' ').toLowerCase();
  if (/esg/.test(s)) return 'esg';
  if (/iso|심사/.test(s)) return 'iso';
  if (/벤처|venture/.test(s)) return 'venture';
  if (/기업\s*인증|이노비즈|메인비즈|인증/.test(s)) return 'cert';
  return 'etc';
}
export function normProduct(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (PRODUCT_LABEL[s]) return s;
  const hit = PRODUCTS.find(([, n]) => n === s);
  return hit ? hit[0] : classifyProduct(s);
}

// 전화번호 → 보기 좋은 모양 + 비교용 숫자 (+82 10… → 010…)
export function normPhone(raw) {
  let d = String(raw ?? '').replace(/^p:/i, '').replace(/[^\d+]/g, '');
  if (d.startsWith('+82')) d = '0' + d.slice(3);
  else if (d.startsWith('82') && d.length >= 11) d = '0' + d.slice(2);
  d = d.replace(/\D/g, '');
  if (d.length === 10 && !d.startsWith('0')) d = '0' + d;   // 엑셀이 앞 0을 지운 경우(10 1234 5678)
  let display = d;
  if (/^01\d{9}$/.test(d)) display = d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  else if (/^01\d{8}$/.test(d)) display = d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  else if (/^02\d{7,8}$/.test(d)) display = '02-' + d.slice(2, d.length - 4) + '-' + d.slice(-4);
  else if (/^0\d{9,10}$/.test(d)) display = d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
  return { display: display || String(raw ?? '').trim(), key: d };
}

// 질문 이름 → 이름·전화·메일·회사 (Meta 기본 항목 + 우리말 질문), 나머지는 extras로 그대로
const FIELD_RE = {
  name: /^(full_?name|name|first_?name|이름|성함|성명|대표자?\s*(성함|이름|명)?|담당자\s*(성함|이름|명)?)$/i,
  phone: /phone|전화|연락처|휴대|핸드폰|mobile/i,
  email: /e-?mail|이메일|메일/i,
  company: /company|회사|기업|업체|상호|법인/i,
};
const META_COLS = /^(id|created_time|ad_id|ad_name|adset_id|adset_name|campaign_id|campaign_name|form_id|form_name|is_organic|platform|lead_status|retailer_item_id|inbox_url)$/i;
export function mapFields(pairs) {
  const out = { name: '', phone: '', email: '', company: '', extras: [] };
  for (const [q0, a0] of pairs) {
    const q = String(q0 ?? '').trim(), a = String(a0 ?? '').trim();
    if (!q || !a || META_COLS.test(q)) continue;
    const k = ['phone', 'email', 'name', 'company'].find(f => !out[f] && FIELD_RE[f].test(q.replace(/[?:]/g, '').trim()));
    if (k) out[k] = a;
    else out.extras.push([q.replace(/_/g, ' '), a]);
  }
  return out;
}

const parseMetaTime = (s) => {
  if (s === undefined || s === null || s === '') return 0;
  if (typeof s === 'number') return s < 1e12 ? s * 1000 : s;
  const t = Date.parse(String(s).trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : 0;
};

// Meta API 리드 하나 → 저장할 모양
export function fromMetaLead(lead, form = {}) {
  const pairs = (lead.field_data || []).map(f => [f.name, (f.values || []).join(', ')]);
  const f = mapFields(pairs);
  return {
    metaId: String(lead.id || ''), receivedAt: parseMetaTime(lead.created_time),
    product: classifyProduct(form.name, lead.ad_name, lead.campaign_name),
    formName: form.name || '', formId: String(lead.form_id || form.id || ''), adName: lead.ad_name || '', campaignName: lead.campaign_name || '',
    ...f,
  };
}
// Meta 엑셀·CSV 한 줄(열 이름 → 값) → 저장할 모양
export function fromSheetRow(row, fallbackProduct = '') {
  const get = (k) => { const hit = Object.keys(row).find(x => x.trim().toLowerCase() === k); return hit ? String(row[hit] ?? '').trim() : ''; };
  const f = mapFields(Object.entries(row));
  const fromRow = classifyProduct(get('form_name'), get('ad_name'), get('campaign_name'));   // 양식 이름이 있으면 그걸로, 없으면 파일 이름 등으로
  const product = fromRow !== 'etc' ? fromRow : (normProduct(fallbackProduct) || 'etc');
  return {
    metaId: get('id').replace(/^l:/, ''), receivedAt: parseMetaTime(get('created_time')),
    product: product || 'etc', formName: get('form_name'), formId: get('form_id').replace(/^f:/, ''), adName: get('ad_name'), campaignName: get('campaign_name'),
    ...f,
  };
}

// ── 칸 계산 ── {col:'new'|'call'|'later'|'closed', alert, reason}
//   new = 새 DB(아직 한 번도 안 걸었음) · call = 오늘 걸 곳(재통화·상담 날짜가 오늘이거나 지남) · later = 날짜가 앞날이거나 상담 중(날짜 없음) · closed = 끝
export function leadState(l, nowMs = Date.now()) {
  const today = kstToday(nowMs);
  if (CLOSED.includes(l.status)) return { col: 'closed', alert: false, reason: LEAD_STATUS[l.status] };
  if (l.status === 'new' || !l.status) {
    const h = Math.max(0, Math.floor((nowMs - (l.receivedAt || l.createdAt || nowMs)) / HOUR));
    const ago = h < 1 ? '방금' : h < 24 ? h + '시간 전' : Math.floor(h / 24) + '일 전';
    return { col: 'new', alert: h >= NEW_ALERT_HOURS, reason: '🆕 ' + ago + ' 들어옴' + (h >= NEW_ALERT_HOURS ? ' · 아직 전화 안 함' : '') };
  }
  if (l.status === 'meet' && !(l.nextCallDate && l.nextCallDate <= today)) {
    const md = (l.meetDate || '').slice(5).replace('-', '/') + (l.meetTime ? ' ' + l.meetTime : '');
    const past = l.meetDate && l.meetDate < today;
    return { col: 'meet', alert: !!past, reason: '🤝 미팅 ' + (l.meetDate === today ? '오늘' + (l.meetTime ? ' ' + l.meetTime : '') : md) + (past ? ' 지남 · 결과(전환·거절) 남기기' : '') };
  }
  const when = l.nextCallDate ? (l.nextCallDate === today ? '오늘' : l.nextCallDate === addDays(today, 1) ? '내일' : l.nextCallDate.slice(5).replace('-', '/')) + (l.nextCallTime ? ' ' + l.nextCallTime : '') : '';
  const head = l.status === 'noans' ? '📞 부재 ' + (l.tries || 0) + '/' + MAX_TRIES : l.status === 'meet' ? '🤝 미팅 전' : '💬 상담 중';
  if (l.nextCallDate && l.nextCallDate <= today) {
    const late = l.nextCallDate < today;
    return { col: 'call', alert: late, reason: head + ' · ' + (late ? when + ' 걸기로 했는데 지남' : '오늘 ' + (l.status === 'noans' ? '재통화' : '통화') + (l.nextCallTime ? ' ' + l.nextCallTime : '')) };
  }
  return { col: 'later', alert: false, reason: head + (when ? ' · ' + when + ' 통화' : '') };
}

// 다음 영업일(토·일 건너뜀)
export function nextBizDay(day) {
  let d = addDays(day, 1);
  for (let i = 0; i < 3; i++) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) break; d = addDays(d, 1); }
  return d;
}

export const LEAD_ACTIONS = ['noans', 'talk', 'schedule', 'meeting', 'won', 'lost', 'reopen', 'memo'];
export const CALLS_MAX = 100;
// 동작 하나 → 바뀔 값 + 기록 한 줄 (순수 함수 — 시험하기 쉽게)
//   opts: {date?, time?, memo?}  date = 「내일」「10/20」「+3」 · time = 「14:00」「오후 2시」
export function applyLeadAction(l, action, opts = {}, nowMs = Date.now()) {
  if (!LEAD_ACTIONS.includes(action)) throw new RuleError('동작은 ' + LEAD_ACTIONS.join('·') + ' 중 하나입니다');
  const today = kstToday(nowMs);
  const date = opts.date ? parseDue(opts.date, nowMs) : '';
  const time = opts.time ? parseTime(opts.time) : '';
  const w = {}; let what = '';
  if (CLOSED.includes(l.status) && !['reopen', 'memo'].includes(action)) throw new RuleError(leadLabel(l.no) + '는 이미 끝났습니다(' + LEAD_STATUS[l.status] + '). 다시 하려면 reopen');
  if (action === 'noans') {
    const tries = (l.tries || 0) + 1;
    w.tries = tries; w.lastCallAt = nowMs;
    if (tries >= MAX_TRIES && !date) { w.status = 'unreach'; w.nextCallDate = ''; w.nextCallTime = ''; what = '부재 ' + tries + '번째 → 📵 연락 안 됨'; }
    else { w.status = ['talk', 'meet'].includes(l.status) ? l.status : 'noans'; w.nextCallDate = date || nextBizDay(today); w.nextCallTime = time; what = '부재 ' + tries + '번째 → ' + w.nextCallDate.slice(5).replace('-', '/') + (time ? ' ' + time : '') + ' 다시 걸기'; }
  } else if (action === 'talk') {
    w.status = l.status === 'meet' ? 'meet' : 'talk'; w.lastCallAt = nowMs; w.nextCallDate = date; w.nextCallTime = date ? time : '';   // 미팅 잡힌 뒤 통화해도 미팅 예정 유지
    what = '통화됨 → ' + LEAD_STATUS[w.status] + (date ? ' · ' + date.slice(5).replace('-', '/') + (time ? ' ' + time : '') + ' 다시 통화' : '');
  } else if (action === 'schedule') {
    if (!date) throw new RuleError('언제 걸지 date가 필요합니다 (예: 내일, 10/20)');
    w.nextCallDate = date; w.nextCallTime = time;
    if (l.status === 'new') w.status = 'talk';
    what = '통화 약속 ' + date.slice(5).replace('-', '/') + (time ? ' ' + time : '');
  } else if (action === 'meeting') {
    if (!date) throw new RuleError('미팅 날짜(date)가 필요합니다 (예: 10/15, 다음 주 목요일은 날짜로)');
    w.status = 'meet'; w.meetDate = date; w.meetTime = time; w.lastCallAt = nowMs; w.nextCallDate = ''; w.nextCallTime = '';
    what = '🤝 미팅 약속 ' + date.slice(5).replace('-', '/') + (time ? ' ' + time : '');
  } else if (action === 'won') {
    w.status = 'won'; w.closedAt = nowMs; w.nextCallDate = ''; w.nextCallTime = ''; what = '✅ 고객 전환';
  } else if (action === 'lost') {
    w.status = 'lost'; w.closedAt = nowMs; w.nextCallDate = ''; w.nextCallTime = ''; what = '✖ 거절·무효' + (opts.memo ? ' (' + String(opts.memo).trim() + ')' : '');
  } else if (action === 'reopen') {
    w.status = (l.tries || 0) > 0 ? 'noans' : 'new'; w.closedAt = null;
    if (w.status === 'noans') w.tries = Math.min(l.tries || 0, MAX_TRIES - 1);
    w.nextCallDate = date || (w.status === 'noans' ? today : ''); w.nextCallTime = time;
    what = '다시 열기 → ' + LEAD_STATUS[w.status];
  } else if (action === 'memo') {
    if (!String(opts.memo || '').trim()) throw new RuleError('memo 내용이 필요합니다');
    what = '📝 ' + String(opts.memo).trim();
  }
  if (opts.memo && String(opts.memo).trim()) {
    const line = today.slice(5).replace('-', '/') + ' ' + String(opts.memo).trim();
    w.memo = ((l.memo || '').trim() + '\n' + line).trim();
    if (action !== 'lost' && action !== 'memo') what += ' · ' + String(opts.memo).trim();
  }
  return { write: w, what };
}
function parseTime(v) {
  const s = String(v).trim().replace(/\s+/g, '');
  const m = s.match(/^(오전|오후)?(\d{1,2})(?::|시)?(\d{2})?(?:분)?(반)?$/);
  if (!m) throw new RuleError('시각을 알아볼 수 없습니다: 「' + v + '」 (예: 14:00, 오후 2시)');
  let h = Number(m[2]); const mi = m[3] ? Number(m[3]) : m[4] ? 30 : 0;
  if (m[1] === '오후' && h < 12) h += 12; else if (!m[1] && h >= 1 && h <= 7) h += 12;
  if (h > 23 || mi > 59) throw new RuleError('시각이 올바르지 않습니다: 「' + v + '」');
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

// 저장 모양의 extras({q,a}) → 쌍([q,a])
const extrasPairs = (l) => (l.extras || []).map(e => Array.isArray(e) ? e : [e.q, e.a]);
// 사장님이 보는 항목(10/13): 이름 · 회사(company_name) · 지역(city) · 양식 이름(form_name) · 사업자 유형 · 업종 — 질문 이름이 조금 달라도 찾는다
const PICK = { city: /^(city|지역|도시|소재지|시\s*\/?\s*군|주소)/i, bizType: /사업자\s*(유형|구분|형태)/, industry: /^(업종|업태|industry)/i };
export function leadPick(extras, key) {
  const hit = (extras || []).map(e => Array.isArray(e) ? e : [e.q, e.a]).find(([q]) => PICK[key].test(String(q || '').trim()));
  return hit ? String(hit[1] || '').replace(/_/g, ' ').trim() : '';
}
// 화면·채팅에 내보낼 모양
export function presentLead(l, nowMs = Date.now()) {
  const st = leadState(l, nowMs);
  return {
    label: leadLabel(l.no), no: l.no, product: l.product, productLabel: PRODUCT_LABEL[l.product] || '기타',
    name: l.name || '', phone: l.phone || '', company: l.company || '', email: l.email || '', status: l.status, statusLabel: LEAD_STATUS[l.status] || '',
    tries: l.tries || 0, nextCallDate: l.nextCallDate || '', nextCallTime: l.nextCallTime || '', receivedAt: l.receivedAt || 0, createdAt: l.createdAt || 0,
    city: leadPick(l.extras, 'city'), bizType: leadPick(l.extras, 'bizType'), industry: leadPick(l.extras, 'industry'),
    meetDate: l.meetDate || '', meetTime: l.meetTime || '', calls: Array.isArray(l.calls) ? l.calls : [],
    extras: extrasPairs(l), memo: l.memo || '', assignee: l.assignee || '', formName: l.formName || '', col: st.col, alert: st.alert, reason: st.reason,
  };
}
export function leadLine(p) {
  const info = [p.city, p.bizType, p.industry, p.calls && p.calls.length ? '📒 통화 기록 ' + p.calls.length + '줄' : ''].filter(Boolean).join(' · ');
  return p.label + ' [' + p.productLabel + ' · ' + p.reason + (p.alert ? ' 🔴' : '') + '] ' + (p.name || '(이름 없음)') + (p.company ? ' · ' + p.company : '') + (p.phone ? ' ☎ ' + p.phone : '')
    + (info ? ' — ' + info : '') + (p.formName ? ' 〔' + p.formName + '〕' : '');
}

// 📒 통화 이력 보기 — 들어옴(신청 시각) + 쌓인 기록. 웹 화면·Claude 공용
const kstMDHM = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ');
export function leadHistory(l) {
  const rows = [{ at: l.receivedAt || l.createdAt || 0, by: '', action: 'in', what: '📥 들어옴 — ' + (PRODUCT_LABEL[l.product] || '기타') + ' 광고' + (l.formName ? ' 〔' + l.formName + '〕' : '') }];
  return rows.concat((Array.isArray(l.calls) ? l.calls : []).slice().sort((a, b) => (a.at || 0) - (b.at || 0)))
    .map(c => Object.assign({}, c, { when: c.at ? kstMDHM(c.at) : '' }));
}
export const historyLine = (h) => h.when + ' ' + h.what + (h.by ? ' — ' + h.by : '');

const activityPath = (nowMs) => 'activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10);
function activity(ref, no, action, summary, actor, nowMs) {
  return { at: nowMs, app: 'lead', ref, no, action, summary, by: actor.name, via: actor.via || '', email: actor.email || '', bizno: '', changes: {} };
}

// ── 넣기 (Meta 자동·엑셀 공용) ── 트랜잭션 하나: 중복 확인 + 번호 + 저장 + 기록 한 줄
//   items: fromMetaLead / fromSheetRow 결과 배열
export async function importLeads(ctx, items, { source = 'meta' } = {}) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const clean = items.filter(x => x && (x.phone || x.name || x.email));
  if (!clean.length) return { created: [], skipped: items.length };
  return db.transaction(async (tx) => {
    const all = await tx.query('leads', [], {});   // 한 번에 다 읽어 비교(수백 건 규모) — 외부 호출 1번
    const seenMeta = new Set(all.map(d => d.data.metaId).filter(Boolean));
    const seenPhone = new Set(all.map(d => (d.data.phoneKey || '') + '|' + d.data.product).filter(k => !k.startsWith('|')));
    const seq = await tx.get(SEQ_PATH);
    let no = Math.max(seq ? Number(seq.data.last) || 0 : 0, ...all.map(d => Number(d.data.no) || 0));
    const created = []; let skipped = 0;
    for (const x of clean.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0))) {
      const ph = normPhone(x.phone);
      const pk = ph.key ? ph.key + '|' + (x.product || 'etc') : '';
      if ((x.metaId && seenMeta.has(x.metaId)) || (pk && seenPhone.has(pk))) { skipped++; continue; }
      if (x.metaId) seenMeta.add(x.metaId); if (pk) seenPhone.add(pk);
      no += 1;
      const lead = {
        no, source, metaId: x.metaId || '', formId: x.formId || '', formName: x.formName || '', adName: x.adName || '', campaignName: x.campaignName || '',
        product: x.product || 'etc', name: x.name || '', phone: ph.display, phoneKey: ph.key, email: x.email || '', company: x.company || '',
        extras: (x.extras || []).map(([q, a]) => ({ q, a })), receivedAt: x.receivedAt || nowMs,
        status: 'new', tries: 0, nextCallDate: '', nextCallTime: '', memo: '', assignee: DEFAULT_ASSIGNEE,
        createdAt: nowMs, updatedAt: nowMs, updatedBy: actor.name, lastCallAt: null, closedAt: null,
      };
      tx.create('leads/' + leadLabel(no), lead);
      created.push(lead);
    }
    if (created.length) {
      tx.set(SEQ_PATH, { last: no, updatedAt: nowMs });
      const by = PRODUCTS.map(([k, n]) => [n, created.filter(c => c.product === k).length]).filter(([, c]) => c).map(([n, c]) => n + ' ' + c).join('·');
      tx.create(activityPath(nowMs), activity(leadLabel(created[0].no) + (created.length > 1 ? '~' + leadLabel(created[created.length - 1].no) : ''), created[0].no, 'import',
        '📣 광고 DB ' + created.length + '건 들어옴 (' + by + ')' + (source === 'excel' ? ' · 엑셀' : ''), actor, nowMs));
    }
    return { created: created.map(c => ({ label: leadLabel(c.no), product: c.product, name: c.name })), skipped };
  });
}

async function findLead(reader, noInput) {
  const no = parseLeadNo(noInput);
  if (!no) throw new RuleError('광고 DB 번호가 올바르지 않습니다: ' + noInput + ' (예: D-0012)');
  const rows = await reader.query('leads', [['no', '==', no]], { limit: 1 });
  if (!rows.length) throw new NotFoundError('없는 광고 DB입니다: ' + leadLabel(no));
  return rows[0];
}

// 하나 읽기(통화 이력 보기용)
export async function getLead(db, noInput) { return (await findLead(db, noInput)).data; }

// ── 전화 결과 기록 ── 고객 전환이면 할 일(진행 업무)도 하나 만든다 (출처 lead, 같은 DB로 두 번 안 만듦)
const PRODUCT_CAT = { iso: 'iso', venture: 'ven', cert: 'ven', esg: 'etc', etc: 'etc' };
export async function actLead(ctx, noInput, action, opts = {}) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const res = await db.transaction(async (tx) => {
    const doc = await findLead(tx, noInput);
    const l = doc.data;
    const { write, what } = applyLeadAction(l, action, opts, nowMs);
    Object.assign(write, { updatedAt: nowMs, updatedBy: actor.name });
    write.calls = (Array.isArray(l.calls) ? l.calls : []).concat({ at: nowMs, by: actor.name, action, what }).slice(-CALLS_MAX);   // 📒 통화 이력 한 줄
    tx.update(doc.path, write);
    const label = leadLabel(l.no);
    const summary = label + ' ' + (l.name || '') + (l.company ? '(' + l.company + ')' : '') + ' · ' + what + ' — ' + actor.name;
    tx.create(activityPath(nowMs), activity(label, l.no, action, summary, actor, nowMs));
    return { lead: Object.assign({}, l, write), label, what };
  });
  let todo = null;
  if (action === 'won') {
    const l = res.lead;
    const text = '[' + (PRODUCT_LABEL[l.product] || '광고') + ' 광고] ' + (l.name || '') + (l.company ? '(' + l.company + ')' : '') + ' 상담 진행' + (l.phone ? ' ☎ ' + l.phone : '');
    const r = await createTodo(ctx, { text, category: PRODUCT_CAT[l.product] || 'etc', memo: extrasPairs(l).map(([q, a]) => q + ': ' + a).join('\n') },
      { source: 'lead', sourceRef: res.label, autoCompany: true });
    todo = r.label;
  }
  return { label: res.label, what: res.what, lead: presentLead(res.lead, nowMs), todo };
}

// ── 목록 ── view: today(새 DB + 오늘 걸 곳, 기본)·new·call·later·open(안 끝난 것 전부)·closed·all · product · query
export async function listLeads(db, { view = 'today', product = '', query = '', limit = 50 } = {}, nowMs = Date.now()) {
  const rows = (await db.list('leads')).map(d => presentLead(d.data, nowMs));
  const pr = normProduct(product);
  const q = String(query || '').trim().toLowerCase();
  const pick = rows.filter(p => {
    if (pr && p.product !== pr) return false;
    if (q && ![p.name, p.company, p.phone, p.email, p.memo, p.label].concat((p.extras || []).map(e => e.join(' '))).join(' ').toLowerCase().includes(q.replace(/-/g, '')) &&
      !String(p.phone).replace(/-/g, '').includes(q.replace(/-/g, ''))) return false;
    if (view === 'today') return p.col === 'new' || p.col === 'call' || (p.col === 'meet' && p.alert);
    if (view === 'open') return p.col !== 'closed';
    if (['new', 'call', 'meet', 'later', 'closed'].includes(view)) return p.col === view;
    return true;
  });
  const ord = { new: 0, call: 1, meet: 2, later: 3, closed: 4 };
  pick.sort((a, b) => ord[a.col] - ord[b.col] || (b.alert - a.alert)
    || (a.col === 'new' ? a.receivedAt - b.receivedAt : a.col === 'closed' ? b.receivedAt - a.receivedAt : a.col === 'meet' ? (a.meetDate + a.meetTime).localeCompare(b.meetDate + b.meetTime) : (a.nextCallDate || '9999').localeCompare(b.nextCallDate || '9999') || (a.nextCallTime || '99').localeCompare(b.nextCallTime || '99')));
  const open = rows.filter(p => p.col !== 'closed');
  const counts = { new: open.filter(p => p.col === 'new').length, call: open.filter(p => p.col === 'call').length, later: open.filter(p => p.col === 'later').length, meet: open.filter(p => p.col === 'meet').length, alert: open.filter(p => p.alert).length };
  const byProduct = Object.fromEntries(PRODUCTS.map(([k]) => [k, open.filter(p => p.product === k).length]));
  return { view, total: pick.length, counts, byProduct, leads: pick.slice(0, Math.max(1, Math.min(200, limit))) };
}

// ── 광고별 성과 ── 최근 N일 들어온 DB 기준: 들어옴 · 통화 연결(상담·전환) · 고객 전환 · 연락 안 됨/거절
export async function leadStats(db, { days = 30 } = {}, nowMs = Date.now()) {
  const since = nowMs - days * 86400000;
  const rows = (await db.list('leads')).map(d => d.data).filter(l => (l.receivedAt || 0) >= since);
  return PRODUCTS.map(([k, n]) => {
    const r = rows.filter(l => l.product === k);
    return { product: k, label: n, received: r.length, reached: r.filter(l => ['talk', 'meet', 'won'].includes(l.status) || (l.status === 'lost' && l.lastCallAt)).length,
      won: r.filter(l => l.status === 'won').length, lost: r.filter(l => l.status === 'lost').length, unreach: r.filter(l => l.status === 'unreach').length,
      waiting: r.filter(l => !CLOSED.includes(l.status)).length };
  }).filter(s => s.received || s.product !== 'etc');
}

// ── Meta에서 가져오기 ── 5분마다(예약 작업) · 웹 「지금 가져오기」 · 채팅 lead_sync
//   env.META_TOKEN(비밀값) — 페이지 토큰이든, 만료 없는 「시스템 사용자」 토큰이든 된다(10/19: 사람 계정 토큰이 자꾸 끊겨서).
//     시스템 사용자·사용자 토큰이면 매번 페이지 토큰으로 바꿔 쓴다(pageToken) · env.META_PAGE_ID(페이지 번호, 여럿이면 쉼표) · env.META_API_VERSION(기본 v26.0)
//   지난번 받은 가장 늦은 신청 시각 10분 전부터 다시 물어 빠지는 것이 없게 하고, 중복은 importLeads가 거른다
export async function syncMeta(env, db, { nowMs = Date.now(), fetchFn = fetch, actor = { name: '자동', via: 'meta' }, full = false } = {}) {
  const token = String(env.META_TOKEN || '').trim();
  const pages = String(env.META_PAGE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !pages.length) return { ok: false, skipped: true, error: 'Meta 연결 전입니다(META_TOKEN·META_PAGE_ID 설정 필요)' };
  const ver = env.META_API_VERSION || 'v26.0';
  const base = 'https://graph.facebook.com/' + ver + '/';
  const prev = (await db.get(SYNC_PATH))?.data || {};
  // 📒 통화 이력을 처음 쓰는 날 한 번: 지난 기록 옮겨 채우기 — Meta 가져오기가 실패해도 먼저 한다(10/14: 토큰 오류로 못 하던 것)
  let callsBackfilledAt = prev.callsBackfilledAt || null;
  if (!callsBackfilledAt) {
    try { const b = await backfillLeadCalls(db, { sinceMs: prev.resetAt || prev.startFrom || 0 }); callsBackfilledAt = nowMs; console.log('[광고 DB] 통화 이력 옮겨 채움', b); }
    catch (e) { console.warn('[광고 DB] 통화 이력 옮기기 실패', e && e.message); }
  }
  // startFrom = 「이 날 이후 신청만」(lead_reset으로 정함) — 처음·전체 다시 받기도 그 앞으로는 가지 않는다
  const sinceMs = full || !prev.lastTime ? Math.max(nowMs - BACKFILL_DAYS * 86400000, prev.startFrom || 0) : Math.max(prev.lastTime - 10 * 60000, prev.startFrom || 0);
  const graph = async (url, tok = token) => {
    const r = await fetchFn(url, { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const m = (j.error && (j.error.error_user_msg || j.error.message)) || ('HTTP ' + r.status);
      const code = j.error && j.error.code;
      throw new Error('Meta: ' + m + (code === 190 || code === 10 || code === 200 ? ' — 토큰이 만료됐거나 권한이 풀렸습니다(META_TOKEN 다시 넣기)' : ''));
    }
    return j;
  };
  const items = []; const forms = []; let calls = 0;
  try {
    for (const page of pages) {
      // 시스템 사용자 토큰 → 이 페이지의 페이지 토큰으로 바꾼다. 이미 페이지 토큰이면 실패하거나 같은 값 → 원래 토큰 그대로
      let pt = token;
      try { const pj = await graph(base + encodeURIComponent(page) + '?fields=access_token'); if (pj.access_token) pt = pj.access_token; } catch (e) { /* 페이지 토큰이면 여기로 */ }
      calls++;
      const fj = await graph(base + encodeURIComponent(page) + '/leadgen_forms?fields=id,name,status&limit=100', pt); calls++;
      for (const f of fj.data || []) {
        forms.push({ id: f.id, name: f.name || '', status: f.status || '', product: classifyProduct(f.name) });
        const filtering = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(sinceMs / 1000) }]));
        let url = base + f.id + '/leads?fields=id,created_time,field_data,ad_name,campaign_name,form_id&limit=100&filtering=' + filtering;
        for (let page2 = 0; url && page2 < 5 && calls < 30; page2++) {   // 무료 요금제 외부 호출 50번 안에서
          const lj = await graph(url, pt); calls++;
          (lj.data || []).forEach(ld => items.push(fromMetaLead(ld, f)));
          url = lj.paging && lj.paging.next || '';
        }
      }
    }
  } catch (e) {
    await db.transaction(async tx => tx.set(SYNC_PATH, Object.assign({}, prev, { callsBackfilledAt, lastRunAt: nowMs, lastError: String(e.message || e).slice(0, 300), lastErrorAt: nowMs })));
    return { ok: false, error: String(e.message || e) };
  }
  // 10분 겹쳐 묻기 때문에 지난번에 이미 받은 리드가 또 온다 → lead_sync에 적어 둔 최근 ID로 먼저 걸러,
  //   새 리드가 없으면 leads 전체를 읽지 않는다(Firestore 무료 읽기 하루 5만 건 아끼기 — 5분마다 전체를 읽으면 금방 넘음)
  const known = new Set(full ? [] : prev.recentIds || []);
  const fresh = items.filter(x => !x.metaId || !known.has(x.metaId));
  const r = fresh.length ? await importLeads({ db, actor, nowMs }, fresh, { source: 'meta' }) : { created: [], skipped: 0 };
  const lastTime = Math.max(prev.lastTime || 0, ...items.map(x => x.receivedAt || 0));
  const recentIds = items.filter(x => x.metaId && (x.receivedAt || 0) >= lastTime - 15 * 60000).map(x => x.metaId).slice(0, 200);
  await db.transaction(async tx => tx.set(SYNC_PATH, { lastRunAt: nowMs, lastOkAt: nowMs, lastTime: lastTime || prev.lastTime || 0, lastError: '', lastErrorAt: prev.lastErrorAt || null,
    forms, fetched: items.length, created: r.created.length, totalCreated: (prev.totalCreated || 0) + r.created.length, recentIds, startFrom: prev.startFrom || 0,
    resetAt: prev.resetAt || null, callsBackfilledAt }));
  return { ok: true, fetched: items.length, created: r.created, skipped: r.skipped + (items.length - fresh.length), forms: forms.map(f => f.name + ' → ' + PRODUCT_LABEL[f.product]) };
}

// ── 📒 지난 통화 기록 옮겨 채우기 ── 이력(calls)이 아직 없는 DB에, activity에 남은 전화 결과를 시간순으로 넣는다
//   sinceMs = 광고 DB를 비운 시각(lead_reset) — 그 앞 기록은 옛 번호라 섞지 않는다. 여러 번 해도 안전(calls가 있으면 건너뜀)
export async function backfillLeadCalls(db, { sinceMs = 0 } = {}) {
  return db.transaction(async (tx) => {
    const acts = (await tx.query('activity', [['app', '==', 'lead']], {})).map(d => d.data)
      .filter(a => (a.at || 0) > sinceMs && LEAD_ACTIONS.includes(a.action) && a.no);
    const rows = await tx.query('leads', [], {});
    let filled = 0, lines = 0;
    for (const r of rows) {
      if (Array.isArray(r.data.calls)) continue;
      const calls = acts.filter(a => a.no === r.data.no).sort((a, b) => a.at - b.at).map(a => {
        let w = String(a.summary || ''); const i = w.indexOf(' · '); if (i >= 0) w = w.slice(i + 3);
        const j = w.lastIndexOf(' — '); if (j >= 0) w = w.slice(0, j);
        return { at: a.at, by: a.by || '', action: a.action, what: w };
      }).slice(-CALLS_MAX);
      tx.update(r.path, { calls });
      filled++; lines += calls.length;
    }
    return { filled, lines };
  });
}

// ── 광고 DB 비우고 기준일부터 다시 ── (사장님 지시 10/13: 시험으로 들어온 90일치를 지우고 정한 날 이후 신청만 받기)
//   leads 전부 지움(번호도 D-0001부터) + lead_sync.startFrom = 기준일 0시(한국) → 다음 가져오기부터 그 날 이후 신청만
//   Meta에는 90일치가 남아 있어 기준일을 앞당기면 다시 받을 수 있다. 한 번에 400건씩 지운다(트랜잭션 쓰기 500 이하)
export async function resetLeads(ctx, sinceInput) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const day = parseDue(sinceInput, nowMs);
  if (!day) throw new RuleError('기준일이 필요합니다 (예: 2026-10-13, 오늘, 10/6)');
  const startFrom = Date.parse(day + 'T00:00:00+09:00');
  let removed = 0;
  for (let round = 0; round < 10; round++) {
    const n = await db.transaction(async (tx) => {
      const rows = (await tx.query('leads', [], { limit: 400 }));
      rows.forEach(r => tx.delete(r.path));
      return rows.length;
    });
    removed += n;
    if (n < 400) break;
  }
  await db.transaction(async (tx) => {
    const prev = (await tx.get(SYNC_PATH))?.data || {};
    tx.set(SEQ_PATH, { last: 0, updatedAt: nowMs });
    tx.set(SYNC_PATH, Object.assign({}, prev, { startFrom, lastTime: startFrom, recentIds: [], lastError: '', resetAt: nowMs, resetBy: actor.name }));
    tx.create(activityPath(nowMs), activity('광고 DB', 0, 'reset', '📣 광고 DB 비움 ' + removed + '건 — ' + day + ' 이후 신청부터 다시 받기 — ' + actor.name, actor, nowMs));
  });
  return { removed, since: day };
}
