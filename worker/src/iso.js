// ── ISO 소식 우편함 (iso_inbox) ── 2026-10-14
// 업무창(Claude 채팅)에서 말한 ISO 인증·심사 소식을 Firestore `iso_inbox`에 한 줄 쓴다.
// iso-one이 이 우편함을 읽어 자기 데이터에 반영하고(state: applying → applied / rejected), 결과는 cert_status로 CRM에 올라간다.
// 업무창은 iso-one 데이터를 직접 고치지 않는다 — 우편함에 쓰기만, 결과는 읽기만.
// 규격: iso-one 저장소 docs/ISO_INBOX_SPEC.md v1 (원본 SGGIT-PNG/ims-project) · 상태값은 SGCRM CERT_STATUS_SPEC.md와 같다.
//
// 할 일 연동: 「심사 끝남(auditDone 또는 certified) + 취득일 없음」 → 「[기업] 인증서 발급 확인」(dedupeKey iso:issue:{사업자번호})
//             같은 기업에 취득일이 들어오면 그 할 일을 자동 완료(완료일 = 취득일, 앞날이면 오늘)

import { RuleError, kstToday, parseDue, isDate, addDays, resolveCompany, noLabel } from './core.js';
import { loadCompanies, createTodo, completeTodo } from './todos.js';

export const ISO_STATUSES = ['certified', 'in_progress', 'preparing', 'failed', 'expired', 'dropped'];
export const ISO_STATUS_LABEL = { certified: '인증 발급·유지', in_progress: '심사 진행', preparing: '준비 중', failed: '불합격', expired: '만료', dropped: '중단' };
export const ATYPES = ['최초심사', '사후심사(1차)', '사후심사(2차)', '갱신심사'];
export const ISO_STD = ['9001', '14001', '45001', '22000', '37001', '37301', '13485', '27001', '50001'];
const INBOX = 'iso_inbox';
const PENDING_HINT_MS = 30 * 60000;   // 30분 넘게 pending이면 안내

// 규격 말 → 코드: 'ISO 9001' · '9001' · 'iso_9001' · '45001' → 'iso_45001'
export function normCert(v) {
  const m = String(v ?? '').toLowerCase().replace(/\s+/g, '').match(/(?:iso[_-]?)?(\d{4,5})/);
  if (!m || !ISO_STD.includes(m[1])) throw new RuleError('ISO 규격을 알아볼 수 없습니다: 「' + v + '」 (예: 9001, 14001, 45001)');
  return 'iso_' + m[1];
}
export function normCerts(v) {
  const arr = Array.isArray(v) ? v : (String(v ?? '').match(/\d{4,5}/g) || [String(v ?? '')]);   // 「ISO 9001·14001」 → 숫자만
  return [...new Set(arr.filter(x => String(x).trim()).map(normCert))].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}
// 심사 유형 말 → 정해진 이름: '사후1차' · '1차 사후' · '사후심사 1차' → '사후심사(1차)'
export function normAtype(v) {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return '';
  if (/최초|신규|인증심사$/.test(s)) return '최초심사';
  if (/갱신|재인증/.test(s)) return '갱신심사';
  if (/사후|정기/.test(s)) { if (/2/.test(s)) return '사후심사(2차)'; if (/1/.test(s)) return '사후심사(1차)'; }
  if (ATYPES.includes(v)) return v;
  throw new RuleError('심사 유형은 ' + ATYPES.join('·') + ' 중 하나입니다: 「' + v + '」');
}
// 하루 또는 여러 날: '2027-09-14' · '2027-09-14~2027-09-15' · '2027-09-14~15' · '9/14~9/15'
export function normDayRange(v, nowMs) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const [a, b] = s.split(/\s*[~～]\s*/);
  const d1 = parseDue(a, nowMs);
  if (!b) return d1;
  let d2;
  if (/^\d{1,2}$/.test(b)) d2 = d1.slice(0, 8) + b.padStart(2, '0');           // 「~15」 = 같은 달 15일
  else if (/^\d{1,2}[/.]\d{1,2}$/.test(b) || /^\d{1,2}월/.test(b)) {           // 「~9/15」 = 시작한 해
    const p = parseDue(b, nowMs); d2 = d1.slice(0, 4) + p.slice(4);
  } else d2 = parseDue(b, nowMs);
  if (!isDate(d2) || d2 < d1) throw new RuleError('날짜 범위가 올바르지 않습니다: 「' + s + '」');
  return d1 === d2 ? d1 : d1 + '~' + d2;
}
function strictDay(v, nowMs, label) {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  const d = parseDue(v, nowMs);
  if (!isDate(d)) throw new RuleError(label + ' 날짜가 올바르지 않습니다: 「' + v + '」');
  return d;
}

// 같은 내용이면 같은 문서 ID → 다시 보내도 쌓이지 않는다
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const CONTENT_KEYS = ['bizno', 'certs', 'status', 'issuedAt', 'expiresAt', 'nextAction', 'atype', 's1Date', 's2Date', 'auditDone', 'note'];
export function inboxId(doc, nowMs) {
  const day = kstToday(nowMs).replace(/-/g, '');
  const ref = doc.sourceRef ? String(doc.sourceRef).replace(/[^\w가-힣-]/g, '') : 'chat-' + hashStr(JSON.stringify(CONTENT_KEYS.map(k => doc[k] ?? null)));
  return 'sg-todo__' + ref + '__' + day;
}

// 지금 이 기업의 ISO 규격(cert_status에서, 만료·중단 제외) — 「45001 추가」처럼 말할 때 바탕
async function currentCerts(db, bizno) {
  const rows = await db.query('cert_status', [['bizno', '==', bizno]], {});
  return rows.map(r => r.data).filter(d => /^iso_/.test(d.cert || '') && !['expired', 'dropped', 'failed'].includes(d.status)).map(d => d.cert);
}

// 입력 → 우편함 문서 (모르는 항목은 빼고, 빈 문자열·0 넣지 않음)
export async function buildInbox(ctx, input) {
  const { db, actor, nowMs = Date.now() } = ctx;
  if (!input.company) throw new RuleError('기업(company)을 넣어 주세요 — 이름이나 사업자번호');
  const companies = ctx.companies || await loadCompanies(db);
  const r = resolveCompany(input.company, companies);
  if (r.candidates) throw new RuleError('기업이 여러 곳입니다. 하나를 골라 주세요: ' + input.company, { candidates: r.candidates.map(c => ({ bizno: c.id, name: c.name })) });
  if (r.none) throw new RuleError('기업을 찾지 못했습니다: ' + input.company + ' (CRM에 먼저 기업 등록)');
  const doc = { bizno: r.company.id, companyName: r.company.name };

  if (input.certs !== undefined && String(input.certs).trim() !== '') doc.certs = normCerts(input.certs);
  if (input.addCerts || input.removeCerts) {
    const base = doc.certs || await currentCerts(db, doc.bizno);
    if (!base.length && input.removeCerts) throw new RuleError('지금 규격을 몰라 뺄 수 없습니다. 전체 규격을 certs로 넣어 주세요');
    const add = input.addCerts ? normCerts(input.addCerts) : [], rm = new Set(input.removeCerts ? normCerts(input.removeCerts) : []);
    if (!base.length && add.length) throw new RuleError('지금 규격을 알 수 없습니다(연동 기록 없음). 「9001·14001·45001」처럼 전체 규격을 certs로 넣어 주세요');
    doc.certs = normCerts(base.concat(add).filter(c => !rm.has(c)));
  }
  if (input.status) {
    if (!ISO_STATUSES.includes(input.status)) throw new RuleError('status는 ' + ISO_STATUSES.join('·') + ' 중 하나입니다');
    doc.status = input.status;
  }
  const iss = strictDay(input.issuedAt, nowMs, '취득일'); if (iss) doc.issuedAt = iss;
  const exp = strictDay(input.expiresAt, nowMs, '만료일'); if (exp) doc.expiresAt = exp;
  if (input.nextAction && String(input.nextAction).trim()) doc.nextAction = String(input.nextAction).trim().slice(0, 100);
  const at = normAtype(input.atype); if (at) doc.atype = at;
  const s1 = normDayRange(input.s1Date, nowMs); if (s1) doc.s1Date = s1;
  const s2 = normDayRange(input.s2Date, nowMs); if (s2) doc.s2Date = s2;
  if (input.auditDone === true || input.auditDone === 'true') doc.auditDone = true;
  if (input.note && String(input.note).trim()) doc.note = String(input.note).trim().slice(0, 200);
  const meaningful = ['certs', 'status', 'issuedAt', 'expiresAt', 'nextAction', 'atype', 's1Date', 's2Date', 'auditDone'].some(k => k in doc);
  if (!meaningful) throw new RuleError('무엇이 바뀌었는지(발급·심사 일정·심사 끝남·불합격·규격 등) 하나 이상 넣어 주세요');
  Object.assign(doc, { source: 'sg-todo', createdAt: nowMs, state: 'pending', by: actor.name });
  if (input.ref) doc.sourceRef = String(input.ref).slice(0, 60);
  return doc;
}

// 우편함에 쓰기 + 할 일 연동
export async function sendIsoUpdate(ctx, input) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const doc = await buildInbox(ctx, input);
  const id = inboxId(doc, nowMs);
  const written = await db.transaction(async (tx) => {
    const old = await tx.get(INBOX + '/' + id);
    // 같은 내용이 이미 반영(applied)됐으면 덮어쓰지 않는다 — 다시 pending으로 돌려 두 번 반영되지 않게
    if (old && old.data.state === 'applied' && CONTENT_KEYS.every(k => JSON.stringify(old.data[k] ?? null) === JSON.stringify(doc[k] ?? null))) return { same: true, state: old.data.state, result: old.data.result || '' };
    tx.set(INBOX + '/' + id, doc);
    tx.create('activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10), {
      at: nowMs, app: 'iso', ref: 'ISO', no: 0, action: 'iso_inbox', by: actor.name, via: actor.via || '', email: actor.email || '', bizno: doc.bizno, changes: {},
      summary: '🏅 ISO 소식 → iso-one 우편함: ' + doc.companyName + ' · ' + describe(doc) + ' — ' + actor.name,
    });
    return { same: false };
  });

  // 할 일 연동
  const todo = {};
  const key = 'iso:issue:' + doc.bizno;
  if ((doc.auditDone || doc.status === 'certified') && !doc.issuedAt) {
    const r = await createTodo(ctx, { text: '[' + doc.companyName + '] 인증서 발급 확인', company: doc.bizno, category: 'iso', memo: describe(doc) },
      { source: 'iso', sourceRef: 'issue:' + doc.bizno, autoCompany: false });
    if (r.created) todo.made = r.label; else if (r.todo && r.todo.status !== 'done') todo.exists = r.label;
  }
  if (doc.issuedAt) {
    const open = (await db.query('todos', [['dedupeKey', '==', key]], {})).find(d => !['done', 'cancel'].includes(d.data.status) && !d.data.deletedAt);
    if (open) {
      const today = kstToday(nowMs);
      const day = doc.issuedAt <= today ? doc.issuedAt : today;
      await completeTodo(ctx, open.data.no, '인증서 발급 ' + doc.issuedAt + ' (ISO 소식)', day);
      // 다음 심사 때 새 「발급 확인」을 만들 수 있게 키를 비켜 둔다
      await db.transaction(async tx => tx.update(open.path, { dedupeKey: key + ':' + doc.issuedAt }));
      todo.done = noLabel(open.data.no);
    }
  }
  return { id, doc, same: written.same, prevState: written.state, prevResult: written.result, todo };
}

// 사람이 읽는 한 줄 요약
export function describe(d) {
  const p = [];
  if (d.certs) p.push(d.certs.map(c => c.replace('iso_', '')).join('·'));
  if (d.atype) p.push(d.atype);
  if (d.status) p.push(ISO_STATUS_LABEL[d.status] || d.status);
  if (d.s1Date) p.push('1단계 ' + d.s1Date);
  if (d.s2Date) p.push((d.atype && d.atype !== '최초심사' ? '심사일 ' : '2단계 ') + d.s2Date);
  if (d.auditDone) p.push('심사 끝남');
  if (d.issuedAt) p.push('취득 ' + d.issuedAt);
  if (d.expiresAt) p.push('만료 ' + d.expiresAt);
  if (d.nextAction) p.push('다음: ' + d.nextAction);
  if (d.note) p.push('메모: ' + d.note);
  return p.join(' · ');
}

// 최근 보낸 줄과 iso-one 반영 결과 (색인 없이 되도록 createdAt 순으로만 읽고 걸러 냄)
export async function isoInboxStatus(db, { company = '', limit = 10 } = {}, nowMs = Date.now()) {
  let bizno = '';
  if (company) {
    const r = resolveCompany(company, await loadCompanies(db));
    if (!r.company) throw new RuleError(r.candidates ? '기업이 여러 곳입니다: ' + r.candidates.map(c => c.name + '(' + c.id + ')').join(', ') : '기업을 찾지 못했습니다: ' + company);
    bizno = r.company.id;
  }
  const rows = (await db.query(INBOX, [], { orderBy: ['createdAt', 'desc'], limit: 200 }))
    .map(d => Object.assign({ id: d.id }, d.data)).filter(d => d.source === 'sg-todo' && (!bizno || d.bizno === bizno)).slice(0, Math.max(1, Math.min(50, limit)));
  return rows.map(d => {
    const age = nowMs - (d.createdAt || nowMs);
    let hint = '';
    if (d.state === 'pending' && age > PENDING_HINT_MS) hint = 'iso-one을 열면 반영됩니다 — 그래도 그대로면 iso-one에 이 업체(사업자번호 ' + d.bizno + ') 등록 필요';
    else if (d.state === 'rejected') hint = '반영 못 함 — 사유를 보고 iso-one에서 직접 고치거나 다시 보내 주세요';
    return Object.assign(d, { hint });
  });
}

// ── 🏢 업체 정보(profile) — iso-one docs/ISO_INBOX_SPEC.md v2 §6 ── 2026-10-19
// ISO one 에이전트(Claude)가 구글 드라이브 업체카드·사업자등록증에서 뽑은 회사 정보를 우편함에 쓴다.
// iso-one은 빈 칸만 채우고(손으로 넣은 값은 안 덮음), 다르면 result에 「차이」로 남긴다. createIfMissing이면 업체를 새로 등록.
export const IND_LIST = ['제조업', '건설업', '식품업', '서비스업', '정보통신업', '도소매업', '운수·물류업', '화학·금속제조업', '환경·폐기물처리업', '의료', '교육', '금융'];
// 칸 이름 → 한글 이름 (iso-one INBOX_CO_FIELDS + INBOX_AUDIT_FIELDS와 같은 목록)
export const PROFILE_FIELDS = {
  name: '업체명', ceo: '대표자', addr: '주소', tel: '전화', ind: '업종', scope: '인증범위', founding_date: '설립일', en: '영문 업체명',
  item: '종목', ind_detail: '업태 세부', fax: '팩스', homepage: '홈페이지', addr_zip: '우편번호', addr_en: '영문 주소',
  mgr: '담당자', mgr_dept: '담당자 부서', mgr_title: '담당자 직책', mgr_hp: '담당자 연락처', mgr_email: '담당자 이메일',
  safety_mgr: '안전보건 담당자', tax_mgr: '세금계산서 담당자', tax_email: '세금계산서 이메일',
  emp_total: '총 인원', emp_exec: '임원', emp_reg: '상근직', emp_day: '일용직', emp_out: '외주', dept_names: '부서명',
  shift: '근무형태', customer: '주요 고객', prod_facility: '생산설비', process_order: '공정순서(제품1)',
  process_order2: '공정순서(제품2)', process_order3: '공정순서(제품3)', scope_en: '영문 인증범위',
  iaf: 'IAF 코드', iaf_sub: 'IAF 세부코드', design: '설계 유무',
  mgno_q: '관리번호(품질)', mgno_e: '관리번호(환경)', mgno_s: '관리번호(안전)', ncr_action_date: '부적합 시정조치 일자',
  // 2026-10-23 정보요청서 추가 칸 (iso-one이 Y·N·있음 같은 답을 예·아니오로 바꿔 받음)
  multi_site: '복수 사업장', sites: '추가 사업장', outsource: '외주공정', outsource_proc: '외주 공정 내용',
  permits: '인허가 사항', env_permit: '환경 허가·신고', site_type: '사업장 입지조건',
  cert_exp: '타 기관 심사경험', cert_exp_org: '심사경험 기관명',
  transfer: '전환심사', transfer_org: '이전 인증기관', transfer_last_date: '이전 기관 최근 심사일', transfer_last_type: '이전 기관 최근 심사유형',
  transfer_valid_q: '이전 인증 유효기간(품질)', transfer_valid_e: '이전 인증 유효기간(환경)', transfer_valid_o: '이전 인증 유효기간(안전)',
  dept_people: '부서별 담당자', env_facility: '환경 배출·방지시설', safety_facility: '안전 주요 설비', energy_facility: '에너지 주요 시설',
  haz_danger: '위험물질', haz_toxic: '유해물질', haz_air: '대기오염물질',
  atype_q: '심사유형(품질)', atype_e: '심사유형(환경)', atype_o: '심사유형(안전보건)',
};
// 목록에 없는 칸도 이름 모양(영문 소문자·숫자·_)만 맞으면 그대로 보낸다 — iso-one이 칸을 늘려도 업무창은 고칠 필요 없게.
// 값 검사는 iso-one이 한다(모르는 칸·틀린 값은 반영하지 않고 result에 「건너뜀」).
const P_KEY = /^[a-z][a-z0-9_]{1,40}$/;
export const profileLabel = (k) => PROFILE_FIELDS[k] || k;
const P_LONG = new Set(['sites', 'permits', 'process_order', 'process_order2', 'process_order3', 'prod_facility', 'outsource_proc']);
const P_DATE = new Set(['founding_date', 'ncr_action_date', 'transfer_last_date']);
const P_NUM = new Set(['emp_total', 'emp_exec', 'emp_reg', 'emp_day', 'emp_out']);
const P_ENUM = { ind: IND_LIST, shift: ['1교대', '2교대', '3교대', '기타'], design: ['있다', '없다'] };

// profile 정리 — 모르는 칸·틀린 값은 저장하지 않고 바로 알려 준다(우편함엔 깨끗한 값만)
export function normProfile(p, nowMs) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RuleError('profile은 {칸: 값} 묶음이어야 합니다');
  const out = {}, bad = [];
  for (const [k, raw] of Object.entries(p)) {
    if (!(k in PROFILE_FIELDS) && !P_KEY.test(k)) { bad.push('칸 이름 「' + k + '」(영문 소문자·숫자·_ — iso-one이 알려 준 key 그대로)'); continue; }
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') { bad.push(profileLabel(k) + ' 값은 글자나 숫자'); continue; }
    const v = String(raw).trim();
    if (!v) continue;
    if (P_DATE.has(k)) {
      let d = '';
      try { d = parseDue(v, nowMs); } catch (e) { d = ''; }
      if (!isDate(d)) { bad.push(PROFILE_FIELDS[k] + ' 날짜 「' + v + '」'); continue; }
      out[k] = d;
    } else if (P_NUM.has(k)) {
      const n = v.replace(/[^0-9]/g, '');
      if (!n) { bad.push(PROFILE_FIELDS[k] + ' 숫자 「' + v + '」'); continue; }
      out[k] = String(Number(n));
    } else if (P_ENUM[k]) {
      if (!P_ENUM[k].includes(v)) { bad.push(PROFILE_FIELDS[k] + ' 값은 ' + P_ENUM[k].join('·') + ' 중 하나 — 「' + v + '」'); continue; }
      out[k] = v;
    } else out[k] = v.slice(0, P_LONG.has(k) ? 2000 : 500);
  }
  if (bad.length) throw new RuleError('업체 정보를 고쳐 주세요: ' + bad.join(' / '));
  if (!Object.keys(out).length) throw new RuleError('보낼 업체 정보가 없습니다(profile 칸을 하나 이상)');
  return out;
}
const isWeekend = (ds) => { const w = new Date(ds + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };
function weekendDays(range) {
  if (!range) return [];
  const [a, b = a] = range.split('~'), out = [];
  for (let d = a, n = 0; d <= b && n < 31; d = addDays(d, 1), n++) if (isWeekend(d)) out.push(d);
  return out;
}

const PROFILE_KEYS = ['bizno', 'certs', 'atype', 's1Date', 's2Date', 'profile', 'createIfMissing', 'assignee'];
export async function buildProfileInbox(ctx, input) {
  const { db, actor, nowMs = Date.now() } = ctx;
  if (!input.company) throw new RuleError('기업(company)을 넣어 주세요 — 이름이나 사업자번호');
  const r = resolveCompany(input.company, ctx.companies || await loadCompanies(db));
  if (r.candidates) throw new RuleError('기업이 여러 곳입니다. 하나를 골라 주세요: ' + input.company, { candidates: r.candidates.map(c => ({ bizno: c.id, name: c.name })) });
  if (r.none) throw new RuleError('기업을 찾지 못했습니다: ' + input.company + ' (CRM에 먼저 기업 등록)');
  const doc = { bizno: r.company.id, companyName: r.company.name, kind: 'profile' };
  if (input.certs !== undefined && String(input.certs).trim() !== '') doc.certs = normCerts(input.certs);
  const at = normAtype(input.atype); if (at) doc.atype = at;
  const s1 = normDayRange(input.s1Date, nowMs); if (s1) doc.s1Date = s1;
  const s2 = normDayRange(input.s2Date, nowMs); if (s2) doc.s2Date = s2;
  doc.profile = normProfile(input.profile, nowMs);
  doc.createIfMissing = input.createIfMissing !== false && input.createIfMissing !== 'false';
  if (input.assignee && String(input.assignee).trim()) {
    const em = String(input.assignee).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new RuleError('assignee는 iso-one 로그인 이메일입니다: 「' + input.assignee + '」');
    doc.assignee = em;
  }
  if (input.note && String(input.note).trim()) doc.note = String(input.note).trim().slice(0, 200);
  Object.assign(doc, { source: 'sg-todo', createdAt: nowMs, state: 'pending', by: actor.name });
  if (input.ref) doc.sourceRef = String(input.ref).slice(0, 60);
  return doc;
}
export function profileInboxId(doc, nowMs) {
  const day = kstToday(nowMs).replace(/-/g, '');
  return 'sg-todo__profile-' + doc.bizno.replace(/\D/g, '') + '-' + hashStr(JSON.stringify(PROFILE_KEYS.map(k => doc[k] ?? null))) + '__' + day;
}
// 우편함에 업체 정보 쓰기. 반환 {id, doc, same, warnings}
export async function sendIsoProfile(ctx, input) {
  const { db, actor, nowMs = Date.now() } = ctx;
  const doc = await buildProfileInbox(ctx, input);
  const id = profileInboxId(doc, nowMs);
  const warnings = [];
  for (const [label, r] of [['1단계', doc.s1Date], ['2단계', doc.s2Date]]) {
    const w = weekendDays(r); if (w.length) warnings.push(label + ' 심사일에 주말 포함: ' + w.join(', ') + ' — ISO 심사는 영업일에만');
  }
  const written = await db.transaction(async (tx) => {
    const old = await tx.get(INBOX + '/' + id);
    if (old && old.data.state === 'applied') return { same: true, result: old.data.result || '' };   // 같은 내용이 이미 반영됨
    tx.set(INBOX + '/' + id, doc);
    tx.create('activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10), {
      at: nowMs, app: 'iso', ref: 'ISO', no: 0, action: 'iso_inbox', by: actor.name, via: actor.via || '', email: actor.email || '', bizno: doc.bizno, changes: {},
      summary: '🏢 업체 정보 → iso-one 우편함: ' + doc.companyName + ' · ' + describeProfile(doc) + ' — ' + actor.name,
    });
    return { same: false };
  });
  return { id, doc, same: written.same, prevResult: written.result, warnings };
}
export function describeProfile(d) {
  const p = [];
  const head = describe(d); if (head) p.push(head);
  const keys = Object.keys(d.profile || {});
  p.push('업체 정보 ' + keys.length + '칸(' + keys.map(profileLabel).join(', ') + ')');
  if (d.createIfMissing) p.push('없으면 새로 등록' + (d.assignee ? '(' + d.assignee + ')' : ''));
  return p.join(' · ');
}
