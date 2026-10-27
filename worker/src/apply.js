// ── 🏅 ISO 인증심사 온라인 접수 (로그인 없는 공개 창구) ──
// 업체가 iso-one 주소의 접수 화면(apply.html)에서 제출 → 여기서 받아
//   ① iso_inbox에 업체 정보 한 줄(kind:'profile', source:'apply', createIfMissing) → iso-one이 열릴 때 업체 새로 등록 + 빈 칸 채움
//   ② iso_apply/{접수번호}에 접수 원본(요청사항·첨부 링크 등 iso-one 칸에 없는 것까지)
//   ③ 할 일 「[업체] ISO 심사 접수 확인」(분야 ISO)
//   ④ 첨부 서류는 드라이브 공유 폴더(APPLY_DRIVE_FOLDER)에 「접수번호_상호」 폴더로 — 설정 전이면 첨부 받지 않음
// CRM 기업 등록은 필요 없다(사장님 결정 2026-10-27). 업무창은 iso-one 데이터를 직접 고치지 않는다(우편함만).
//
//   GET  /api/apply/config   {ok, files}            접수 화면이 첨부 칸을 보일지
//   POST /api/apply          multipart: data(JSON) + 첨부 파일(칸 이름 = 서류 종류)

import { RuleError, kstToday } from './core.js';
import { accessToken } from './firestore.js';
import { createTodo } from './todos.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const FILE_KINDS = {
  f_biz: '사업자등록증', f_ins: '4대보험 가입자 명부', f_perm: '허가증·신고증·등록증', f_cert: '기존 인증서·심사보고서',
  f_org: '조직도', f_proc: '공정도·설비 목록',
};
const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024, MAX_FILES = 15;
const OK_TYPES = /^(application\/pdf|image\/jpeg|image\/png)$/, OK_EXT = /\.(pdf|jpe?g|png)$/i;
const DAY_LIMIT_BIZNO = 3, DAY_LIMIT_IP = 10;   // 하루 접수 한도(같은 사업자번호·같은 접속 주소) — 장난 제출 막기

// 사업자등록번호 검증(국세청 체크섬)
export function validBizno(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * w[i];
  s += Math.floor(Number(d[8]) * 5 / 10);
  return (10 - (s % 10)) % 10 === Number(d[9]);
}
const fmtBizno = (v) => { const d = String(v).replace(/\D/g, ''); return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5); };
const t = (v, n = 500) => (v == null ? '' : String(v).trim().slice(0, n));
const num = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d ? String(Number(d)) : ''; };

const ATYPE = { '최초': '최초심사', '사후1': '사후심사(1차)', '사후2': '사후심사(2차)', '갱신': '갱신심사' };
const STD_CERT = { q: 'iso_9001', e: 'iso_14001', o: 'iso_45001' };
const PERMIT = { '있음': '있음 — 첨부 서류(허가증·신고증·등록증)로 확인', '없음': '없음' };

// 비워 두면 「추후 요청」으로 알려 줄 선택 항목 [칸, 이름]
export const LATER = [['emp_reg', '인원 구분(상근·일용·외주)'], ['dept_names', '부서 이름'], ['process', '공정 순서'], ['equip', '주요 설비'],
  ['customer', '주요 매출처'], ['supplier', '주요 매입처'], ['design', '설계·개발 여부'], ['multi_site', '복수 사업장 여부'],
  ['has_permit', '인허가 여부'], ['cert_exp', '다른 기관 심사 경험']];

// 접수 화면 값 → 검사 + iso-one 우편함 profile + 접수 원본
export function parseApply(d, nowMs = Date.now()) {
  if (!d || typeof d !== 'object') throw new RuleError('접수 내용이 비어 있습니다');
  const bad = [];
  const need = (k, label) => { if (!t(d[k])) bad.push(label); };
  need('co_name', '국문 상호'); need('co_en', '영문 상호'); need('ceo', '대표자'); need('addr', '사업장 주소'); need('tel', '대표 전화');
  need('scope', '인증범위'); need('mgr', 'ISO 담당자'); need('mgr_title', '담당자 부서/직위'); need('mgr_hp', '담당자 휴대전화'); need('mgr_email', '담당자 이메일');
  if (!validBizno(d.bizno)) bad.push('사업자등록번호(10자리 숫자를 확인해 주세요)');
  const stds = (Array.isArray(d.stds) ? d.stds : []).filter(s => ['q', 'e', 'o', 'etc'].includes(s));
  if (!stds.length) bad.push('인증 규격');
  const atypeKey = t(d.atype);
  if (!ATYPE[atypeKey] && atypeKey !== '전환') bad.push('심사 유형');
  if (!num(d.emp_total)) bad.push('총 인원');
  if (stds.includes('o')) { need('safe_mgr', '안전보건 관리 담당자 이름'); need('safe_title', '안전보건 담당자 부서/직위'); need('safe_hp', '안전보건 담당자 휴대전화'); }
  if (d.agree !== true) bad.push('개인정보 수집·이용 동의');
  if (t(d.mgr_email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(d.mgr_email))) bad.push('담당자 이메일 형식');
  if (bad.length) throw new RuleError('다음 항목을 확인해 주세요: ' + bad.join(', '));

  const bizno = fmtBizno(d.bizno);
  const [dept, title] = t(d.mgr_title).includes('/') ? t(d.mgr_title).split('/').map(s => s.trim()) : ['', t(d.mgr_title)];
  const p = {
    name: t(d.co_name, 100), en: t(d.co_en, 200), ceo: t(d.ceo, 50), addr: t(d.addr, 200), addr_zip: /^\d{5}$/.test(t(d.addr_zip)) ? t(d.addr_zip) : '', tel: t(d.tel, 30), scope: t(d.scope, 1000),
    founding_date: /^\d{4}-\d{2}-\d{2}$/.test(t(d.founding)) ? t(d.founding) : '',
    fax: t(d.fax, 30), homepage: t(d.homepage, 200),
    mgr: t(d.mgr, 50), mgr_dept: dept, mgr_title: title, mgr_hp: t(d.mgr_hp, 30), mgr_email: t(d.mgr_email, 100),
    safety_mgr: stds.includes('o') ? t(d.safe_mgr, 50) : '', tax_mgr: t(d.tax_mgr, 50), tax_email: t(d.tax_email, 100),
    emp_total: num(d.emp_total), emp_reg: num(d.emp_reg), emp_day: num(d.emp_day), emp_out: num(d.emp_out),
    shift: ['1교대', '2교대', '3교대'].includes(t(d.shift)) ? t(d.shift) : '',
    dept_names: t(d.dept_names), dept_people: t(d.dept_people),
    multi_site: ['예', '아니오'].includes(t(d.multi_site)) ? t(d.multi_site) : '', sites: t(d.multi_site) === '예' ? t(d.sites, 2000) : '',
    process_order: t(d.process, 2000), prod_facility: t(d.equip, 2000),
    outsource: ['있다', '없다'].includes(t(d.outsource)) ? t(d.outsource) : '', outsource_proc: t(d.outsource) === '있다' ? t(d.outsource_proc, 2000) : '',
    customer: t(d.customer), supplier: t(d.supplier),
    design: ['있다', '없다'].includes(t(d.design)) ? t(d.design) : '',
    permits: PERMIT[t(d.has_permit)] || '',
    site_type: stds.includes('e') ? t(d.site_type, 30) : '', env_facility: stds.includes('e') ? t(d.env_facility) : '',
    haz_danger: stds.includes('o') ? t(d.haz_danger) : '', haz_toxic: stds.includes('o') ? t(d.haz_toxic) : '',
    cert_exp: ['있음', '없음'].includes(t(d.cert_exp)) ? t(d.cert_exp) : '', cert_exp_org: t(d.cert_exp) === '있음' ? t(d.cert_exp_org) : '',
  };
  if (atypeKey === '전환') {
    Object.assign(p, { transfer: '예', transfer_org: t(d.transfer_org), transfer_last_date: t(d.transfer_last_date, 200),
      transfer_last_type: (Array.isArray(d.xlt) ? d.xlt : []).filter(x => ['최초심사', '사후심사', '갱신심사'].includes(x)).join(', '),
      transfer_valid_q: stds.includes('q') ? t(d.transfer_valid_q, 100) : '', transfer_valid_e: stds.includes('e') ? t(d.transfer_valid_e, 100) : '',
      transfer_valid_o: stds.includes('o') ? t(d.transfer_valid_o, 100) : '' });
  }
  for (const k of Object.keys(p)) if (!p[k]) delete p[k];

  const certs = stds.filter(s => STD_CERT[s]).map(s => STD_CERT[s]);
  const later = LATER.filter(([k]) => !t(d[k])).map(([, label]) => label);
  const extra = {
    stdEtc: stds.includes('etc') ? t(d.std_etc, 200) || '기타 규격 상담' : '',
    products: t(d.products), when: t(d.when, 20), certNeed: t(d.cert_need, 200), shipAddr: d.ship_same === true ? '사업장 주소와 같음' : [t(d.ship_zip, 10) && /^\d{5}$/.test(t(d.ship_zip)) ? '(' + t(d.ship_zip) + ')' : '', t(d.ship_addr, 200)].filter(Boolean).join(' '), memo: t(d.memo, 2000),
    safety: stds.includes('o') ? { name: t(d.safe_mgr, 50), title: t(d.safe_title, 50), hp: t(d.safe_hp, 30), email: t(d.safe_email, 100) } : null,
  };
  return { bizno, profile: p, certs, atype: ATYPE[atypeKey] || '', transfer: atypeKey === '전환', later, extra, contact: { name: p.mgr, hp: p.mgr_hp, email: p.mgr_email } };
}

// 접수번호 ISO-YYMMDD-XXXX (같은 날 겹치면 다시 뽑음)
export function receiptNo(nowMs, rnd = Math.random) {
  return 'ISO-' + kstToday(nowMs).slice(2).replace(/-/g, '') + '-' + String(Math.floor(rnd() * 9000) + 1000);
}
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── 드라이브(공유 드라이브 폴더) ──
async function driveFolder(token, parent, name, fetchFn) {
  const r = await fetchFn('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  const j = await r.json(); if (!r.ok) throw new Error('드라이브 폴더 만들기 실패: ' + (j.error && j.error.message || r.status));
  return j;
}
async function driveUpload(token, folderId, name, type, bytes, fetchFn) {
  const bd = 'sgapply' + Math.random().toString(36).slice(2);
  const head = '--' + bd + '\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, parents: [folderId] })
    + '\r\n--' + bd + '\r\ncontent-type: ' + type + '\r\n\r\n';
  const body = new Blob([head, bytes, '\r\n--' + bd + '--']);
  const r = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/related; boundary=' + bd }, body,
  });
  const j = await r.json(); if (!r.ok) throw new Error('드라이브 올리기 실패(' + name + '): ' + (j.error && j.error.message || r.status));
  return j;
}

// HTML을 구글 문서로 바꿔 올림(드라이브가 변환) → {id, webViewLink}
async function driveDoc(token, folderId, name, html, fetchFn) {
  const bd = 'sgapplydoc' + Math.random().toString(36).slice(2);
  const body = '--' + bd + '\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify({ name, parents: [folderId], mimeType: 'application/vnd.google-apps.document' })
    + '\r\n--' + bd + '\r\ncontent-type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + bd + '--';
  const r = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/related; boundary=' + bd }, body,
  });
  const j = await r.json(); if (!r.ok) throw new Error('접수서 만들기 실패: ' + (j.error && j.error.message || r.status));
  return j;
}

// 접수서(업체가 쓴 그대로 — 나중에 확인용). d = 접수 화면 값 원본
const STD_NAME = { q: 'ISO 9001', e: 'ISO 14001', o: 'ISO 45001', etc: '기타 규격(상담)' };
const ATYPE_NAME = { '최초': '최초심사', '사후1': '사후심사 1차', '사후2': '사후심사 2차', '갱신': '갱신심사', '전환': '다른 인증기관에서 옮겨 옴(전환)' };
export function applyDocHtml(d, meta) {
  const e = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>');
  const v = (k) => t(d[k], 2000);
  const stds = (Array.isArray(d.stds) ? d.stds : []);
  const has = (k) => stds.includes(k);
  const row = (label, val) => '<tr><td style="width:32%;background:#EEF2F8;border:1px solid #B8C2D0;padding:4px 8px"><b>' + e(label) + '</b></td>'
    + '<td style="border:1px solid #B8C2D0;padding:4px 8px">' + (val ? e(val) : '<span style="color:#8A94A6">(비움)</span>') + '</td></tr>';
  const sec = (title, rows) => '<h3 style="color:#003477;margin:14px 0 4px">' + e(title) + '</h3><table style="border-collapse:collapse;width:100%">' + rows.join('') + '</table>';
  const parts = [
    '<h1 style="color:#003477">ISO 인증심사 접수서</h1>',
    '<p>접수번호 <b>' + e(meta.no) + '</b> · 접수 일시 ' + e(meta.at) + ' · 온라인 접수(iso-one.web.app/apply)</p>',
    sec('1. 회사 정보', [row('국문 상호', v('co_name')), row('영문 상호', v('co_en')), row('사업자등록번호', meta.bizno), row('대표자', v('ceo')),
      row('사업장 주소', (/^\d{5}$/.test(v('addr_zip')) ? '(' + v('addr_zip') + ') ' : '') + v('addr')), row('대표 전화', v('tel')), row('팩스', v('fax')), row('설립일', v('founding')), row('홈페이지', v('homepage')), row('인증서 받을 주소', d.ship_same === true ? '사업장 주소와 같음' : (/^\d{5}$/.test(v('ship_zip')) ? '(' + v('ship_zip') + ') ' : '') + v('ship_addr'))]),
    sec('2. 인증 신청', [row('인증 규격', stds.map(k => STD_NAME[k] || k).join(', ') + (has('etc') && v('std_etc') ? ' (' + v('std_etc') + ')' : '')),
      row('심사 유형', ATYPE_NAME[v('atype')] || v('atype')), row('인증범위', v('scope')), row('설계·개발 업무', v('design')),
      row('희망 심사 시기', v('when')), row('인증서가 필요한 날짜', v('cert_need'))]),
    sec('3. 담당자', [row('ISO 담당자', v('mgr')), row('부서 / 직위', v('mgr_title')), row('휴대전화', v('mgr_hp')), row('이메일', v('mgr_email'))]
      .concat(has('o') ? [row('안전보건 관리 담당자', v('safe_mgr')), row('안전보건 부서 / 직위', v('safe_title')), row('안전보건 휴대전화', v('safe_hp')), row('안전보건 이메일', v('safe_email'))] : [])
      .concat([row('세금계산서 담당자', v('tax_mgr')), row('세금계산서 이메일', v('tax_email'))])),
    sec('4. 인원 · 조직', [row('총 인원', v('emp_total')), row('근무 형태', v('shift')), row('상근직', v('emp_reg')), row('일용직 · 임시직', v('emp_day')),
      row('외주 · 파견', v('emp_out')), row('부서 이름', v('dept_names')), row('부서별 담당자', v('dept_people'))]),
    sec('5. 사업장 · 공정', [row('다른 사업장도 인증', v('multi_site'))].concat(v('multi_site') === '예' ? [row('추가 사업장', v('sites'))] : [])
      .concat([row('주요 제품 · 서비스', v('products')), row('공정 순서', v('process')), row('주요 설비', v('equip')), row('외주 공정', v('outsource'))])
      .concat(v('outsource') === '있다' ? [row('외주 공정 내용', v('outsource_proc'))] : [])
      .concat([row('주요 매출처(고객사)', v('customer')), row('주요 매입처(공급업체)', v('supplier'))])),
    sec('6. 인허가 · 환경 · 안전', [row('인허가 · 신고 · 등록', v('has_permit'))]
      .concat(has('e') ? [row('사업장 입지', v('site_type')), row('배출 · 방지 시설', v('env_facility'))] : [])
      .concat(has('o') ? [row('위험물질', v('haz_danger')), row('유해물질', v('haz_toxic'))] : [])),
    sec('7. 인증 이력', [row('다른 인증기관 심사 경험', v('cert_exp'))].concat(v('cert_exp') === '있음' ? [row('인증기관 이름', v('cert_exp_org'))] : [])
      .concat(v('atype') === '전환' ? [row('현재 인증기관', v('transfer_org')), row('최근 심사일', v('transfer_last_date')),
        row('최근 심사 유형', (Array.isArray(d.xlt) ? d.xlt : []).join(', ')),
        ...(has('q') ? [row('ISO 9001 유효기간', v('transfer_valid_q'))] : []), ...(has('e') ? [row('ISO 14001 유효기간', v('transfer_valid_e'))] : []),
        ...(has('o') ? [row('ISO 45001 유효기간', v('transfer_valid_o'))] : [])] : [])),
    sec('8. 첨부 서류', meta.files.length ? meta.files.map(f => row(f.label, f.name)) : [row('첨부', '')]),
    sec('9. 요청 · 참고 사항', [row('요청 사항', v('memo')), row('개인정보 수집 · 이용 동의', d.agree === true ? '동의함' : '')]),
    meta.later.length ? '<h3 style="color:#8A5300;margin:14px 0 4px">추후 요청할 항목</h3><p>' + meta.later.map(e).join(', ') + '</p>' : '',
    '<p style="color:#5B6678;font-size:9pt">이 문서는 접수 시 자동으로 만들어졌습니다. 업체가 제출한 내용 그대로이며, 수정 내용은 iso-one에 반영해 주세요.</p>',
  ];
  return '<html><head><meta charset="utf-8"></head><body style="font-family:Malgun Gothic,sans-serif;font-size:10pt">' + parts.join('') + '</body></html>';
}

// 받은 파일 검사 → [{kind, name, type, bytes}]
export async function collectFiles(form) {
  const out = []; let total = 0;
  for (const [k, v] of form.entries()) {
    if (!FILE_KINDS[k] || typeof v === 'string') continue;
    if (!v || !v.size) continue;
    if (out.length >= MAX_FILES) throw new RuleError('첨부는 ' + MAX_FILES + '개까지입니다');
    if (v.size > MAX_FILE) throw new RuleError('파일 하나는 10MB까지입니다: ' + v.name);
    if (!OK_TYPES.test(v.type || '') && !OK_EXT.test(v.name || '')) throw new RuleError('PDF, JPG, PNG 파일만 올릴 수 있습니다: ' + v.name);
    total += v.size; if (total > MAX_TOTAL) throw new RuleError('첨부 파일은 모두 합쳐 40MB까지입니다');
    out.push({ kind: k, name: String(v.name || 'file').slice(0, 120), type: v.type || 'application/octet-stream', bytes: await v.arrayBuffer() });
  }
  return out;
}

export function applyConfig(env) { return { ok: true, files: !!(env.APPLY_DRIVE_FOLDER && env.GCP_SA_KEY) }; }

// 접수 처리. deps: {db, fetchFn, nowMs, ip}
export async function submitApply(env, { data, files = [] }, deps) {
  const { db, fetchFn = fetch, nowMs = Date.now() } = deps;
  if (data && t(data.website)) return { ok: true, receipt: receiptNo(nowMs), later: [] };   // 자동 입력 프로그램(숨은 칸을 채움) — 조용히 무시
  const a = parseApply(data, nowMs);
  const day = kstToday(nowMs);
  const ipHash = deps.ip ? await sha('apply:' + deps.ip + ':' + day) : '';

  // 하루 한도
  const sameBiz = await db.query('iso_apply', [['bizno', '==', a.bizno], ['day', '==', day]], {});
  if (sameBiz.length >= DAY_LIMIT_BIZNO) throw new RuleError('오늘 이 사업자번호로 이미 여러 번 접수하셨습니다. 내용을 고치실 것은 담당자에게 말씀해 주세요.');
  if (ipHash) {
    const sameIp = await db.query('iso_apply', [['ipHash', '==', ipHash]], {});
    if (sameIp.length >= DAY_LIMIT_IP) throw new RuleError('오늘 접수 한도를 넘었습니다. 잠시 뒤 다시 시도하거나 담당자에게 연락해 주세요.');
  }

  let no = receiptNo(nowMs);
  for (let i = 0; i < 5 && await db.get('iso_apply/' + no); i++) no = receiptNo(nowMs);

  // 첨부 → 드라이브
  const cfg = applyConfig(env);
  const saved = [], fileNotes = [];
  let folderLink = '', docLink = '', tok = '', folder = null;
  if (files.length && !cfg.files) fileNotes.push('첨부 ' + files.length + '개는 저장 설정 전이라 받지 못함 — 업체에 메일로 요청');
  if (cfg.files) {   // 드라이브 설정이 있으면 첨부가 없어도 폴더를 만들어 접수서를 남긴다
    try {
      tok = await accessToken(env.GCP_SA_KEY, fetchFn, nowMs, DRIVE_SCOPE);
      folder = await driveFolder(tok, env.APPLY_DRIVE_FOLDER, no + '_' + a.profile.name.replace(/[\\/:*?"<>|]/g, ''), fetchFn);
      folderLink = folder.webViewLink || ('https://drive.google.com/drive/folders/' + folder.id);
      for (const f of files) {
        const r = await driveUpload(tok, folder.id, FILE_KINDS[f.kind] + '_' + f.name, f.type, f.bytes, fetchFn);
        saved.push({ kind: f.kind, label: FILE_KINDS[f.kind], name: f.name, id: r.id });
      }
    } catch (e) {
      console.error('[ISO 접수] 첨부 저장 실패', e && e.message);
      fileNotes.push('첨부 저장 실패(' + String(e && e.message || e).slice(0, 80) + ') — 업체에 메일로 요청');
    }
  }
  const gotKinds = new Set(saved.map(f => f.kind));
  const later = a.later.slice();
  for (const k of ['f_biz', 'f_ins']) if (!gotKinds.has(k)) later.unshift(FILE_KINDS[k] + '(첨부)');
  if (a.profile.permits && a.profile.permits.startsWith('있음') && !gotKinds.has('f_perm')) later.unshift(FILE_KINDS.f_perm + '(첨부)');
  // 접수서 — 업체가 쓴 그대로(구글 문서). 실패해도 접수는 진행(원본은 iso_apply에 있음)
  if (folder) {
    try {
      const at = new Date(nowMs + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      const doc = await driveDoc(tok, folder.id, '접수서_' + no + '_' + a.profile.name.replace(/[\\/:*?"<>|]/g, ''),
        applyDocHtml(data, { no, at, bizno: a.bizno, files: saved, later }), fetchFn);
      docLink = doc.webViewLink || ('https://docs.google.com/document/d/' + doc.id + '/edit');
    } catch (e) {
      console.error('[ISO 접수] 접수서 만들기 실패', e && e.message);
      fileNotes.push('접수서 문서를 만들지 못함 — 원본은 CRM iso_apply/' + no);
    }
  }

  const assignee = String(env.APPLY_ASSIGNEE || String(env.ALLOWED_EMAILS || '').split(',')[0] || '').trim().toLowerCase();
  const inboxDoc = {
    bizno: a.bizno, companyName: a.profile.name, kind: 'profile', profile: a.profile,
    createIfMissing: true, source: 'apply', applyNo: no, createdAt: nowMs, state: 'pending', by: '온라인 접수',
  };
  if (assignee) inboxDoc.assignee = assignee;
  if (a.certs.length) inboxDoc.certs = a.certs;
  if (a.atype) inboxDoc.atype = a.atype;
  if (docLink) inboxDoc.applyDoc = docLink;
  if (folderLink) inboxDoc.applyFolder = folderLink;
  const record = {
    no, day, at: nowMs, bizno: a.bizno, companyName: a.profile.name, certs: a.certs, atype: a.atype || (a.transfer ? '전환(기관 이전)' : ''),
    profile: a.profile, extra: a.extra, contact: a.contact, later, files: saved, folder: folderLink, doc: docLink, fileNotes, ipHash, state: 'new',
  };
  await db.transaction(async (tx) => {
    tx.set('iso_inbox/apply__' + a.bizno.replace(/\D/g, '') + '__' + no, inboxDoc);
    tx.set('iso_apply/' + no, record);
    tx.create('activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10), {
      at: nowMs, app: 'iso', ref: no, no: 0, action: 'iso_apply', by: '온라인 접수', via: 'apply', bizno: a.bizno, changes: {},
      summary: '🏅 ISO 심사 온라인 접수: ' + a.profile.name + ' (' + no + ')',
    });
  });

  // 할 일 — 접수 확인 (CRM에 없는 업체라 기업 칸은 비우고 이름을 글에)
  const stdTxt = a.certs.map(c => c.replace('iso_', '')).join('·') + (a.extra.stdEtc ? (a.certs.length ? ' + ' : '') + a.extra.stdEtc : '');
  const memo = [
    '접수번호 ' + no + ' · ' + a.bizno + ' · ' + stdTxt + ' · ' + (a.atype || (a.transfer ? '기관 이전(전환)' : '')),
    '담당 ' + a.contact.name + ' ' + a.contact.hp + ' ' + a.contact.email,
    a.extra.when ? '희망 시기: ' + a.extra.when : '', a.extra.certNeed ? '인증서 필요: ' + a.extra.certNeed : '', a.extra.shipAddr && a.extra.shipAddr !== '사업장 주소와 같음' ? '인증서 받을 주소: ' + a.extra.shipAddr : '',
    a.extra.memo ? '요청사항: ' + a.extra.memo : '',
    later.length ? '추후 요청할 것: ' + later.join(', ') : '필요 항목 모두 작성',
    docLink ? '접수서: ' + docLink : '', folderLink ? '첨부 폴더: ' + folderLink : '', ...fileNotes,
    'iso-one에는 화면을 열면 자동 등록됩니다(업종은 「제조업 — 확인 필요」로 들어가니 확인).',
  ].filter(Boolean).join('\n').slice(0, 1990);
  let todo = null;
  try {
    todo = await createTodo({ db, actor: { name: '공동', via: 'apply' }, nowMs, companies: [] },
      { text: '[' + a.profile.name + '] ISO 심사 접수 확인 (' + no + ')', category: 'iso', memo },
      { source: 'iso', sourceRef: 'apply:' + no, autoCompany: false });
  } catch (e) { console.error('[ISO 접수] 할 일 만들기 실패', e && e.message); }

  return { ok: true, receipt: no, later, filesSaved: saved.length, doc: !!docLink, todo: (todo && todo.label) || '' };
}
