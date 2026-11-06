// ── 📋 메인비즈·이노비즈 인증 온라인 접수 (로그인 없는 공개 창구) ──
// 업체가 maininno.web.app 접수 화면에서 제출 → 여기서 받아
//   ① biz_inbox에 업체 정보 한 줄(kind:'profile', source:'apply', createIfMissing)
//      → 메인이노 프로그램이 `python -m cli 접수확인`으로 읽어 고객사·진단에 반영
//   ② 첨부 서류는 드라이브 공유 폴더(APPLY_DRIVE_FOLDER_SG)에 「접수번호_상호」 폴더로
//   ③ 할 일 「[업체] 메인비즈 접수 확인」
//
//   GET  /api/apply-biz/config   {ok, files}
//   POST /api/apply-biz          multipart: data(JSON) + 첨부 파일(칸 이름 = 증빙 ID)
//
// **두 길을 로그인 없이 통과하는 목록에 넣어야 한다** — 창구가 그 밖의 길에는
// `{"ok":false,"error":"로그인이 필요합니다"}`(401)를 준다. `/api/apply`가 어떻게
// 통과하는지 보고 같은 자리에 더한다. 안 더하면 업체가 접수할 때 401을 받는다.
//
// **이 파일은 메인이노 저장소(deploy/worker/)에서 관리하고 여기에 복사해 온다** —
// 저장 모양 규격이 거기 있기 때문이다(docs/BIZ_INBOX_SPEC.md). 규격을 고치면 함께 고친다.
//
// ISO 쪽 `apply.js`를 본으로 썼다 — 같은 창구에서 도는 형제 모듈이라 `db`·`accessToken`·
// 드라이브 올리기·하루 한도·접수번호 방식을 그대로 따른다. 다른 점은 받는 칸뿐이다.

import { RuleError, kstToday } from './core.js';
import { accessToken } from './firestore.js';
import { createTodo } from './todos.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const COLLECTION = 'biz_inbox';
const FOLDER_ENV = 'APPLY_DRIVE_FOLDER_SG';   // 메인비즈·이노비즈는 SG솔루션 접수처다

// 인증 구분 → 접수번호 머리글. **플러그인 ID를 그대로 쓴다**(규격 §2-2)
const PREFIX = { mainbiz: 'MB', innobiz: 'IB' };
const CERT_NAME = { mainbiz: '메인비즈', innobiz: '이노비즈' };
const SELECTIONS = ['new', 'renewal'];

// 접수 화면이 보내는 파일 칸 = **증빙 ID**(규격 §8-1). 짝이 없는 파일은 `other`로 와서
// evidenceId 없이 적는다 — 담당자가 `증빙확인`으로 가린다.
export const FILE_KINDS = {
  'EV-BUSINESS-LICENSE': '사업자등록증',
  'EV-FINANCIAL-STATEMENTS': '최근 3개년 재무제표',
  'EV-STANDARD-FINANCIAL-CERT': '표준재무제표증명원',
  'EV-SME-CERTIFICATE': '중소기업확인서',
  'EV-RND-CENTER-CERT': '연구소·전담부서 인정서',
  other: '그 밖의 서류',
};

const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024, MAX_FILES = 15;
const OK_TYPES = /^(application\/pdf|image\/jpeg|image\/png)$/, OK_EXT = /\.(pdf|jpe?g|png)$/i;
const DAY_LIMIT_BIZNO = 3, DAY_LIMIT_IP = 10;   // 하루 접수 한도 — 장난 제출 막기 (ISO와 같다)

// 할 일의 분야(중분류 — 화면이 이걸로 묶는다). 창구가 받는 값은
// policy·support·ven·lab·pat·iso·fund·confirm·fin·etc이고
// **`ven`이 「벤처·이노비즈·메인비즈」다** (ISO 접수는 'iso'를 쓴다).
const TODO_CATEGORY = 'ven';

// 업종 — `criteria.json`의 tracks에서 온 값이다(규격 §2-6). 인증마다 목록이 다르다.
const INDUSTRY = {
  mainbiz: ['manufacturing', 'construction', 'retail', 'service', 'knowledge'],
  innobiz: ['manufacturing', 'construction', 'software', 'nonmanufacturing',
    'bio', 'environment', 'design', 'agriculture'],
};

// 재무 — 3개년 × 11항목(규격 §3-2). 금액은 **원 단위 정수**다
const FIN = ['Revenue', 'OperatingIncome', 'TotalAssets', 'TotalLiabilities', 'TotalEquity',
  'TradeReceivables', 'TradePayables', 'Inventories', 'InterestExpense', 'ValueAdded', 'RndExpense'];
const PEOPLE = ['regularEmployees', 'researchers', 'insuredEmployees'];
const TEXTS = ['name', 'ceoName', 'foundedOn', 'industryCode', 'address', 'tel',
  'mgr', 'mgrDept', 'mgrTitle', 'mgrHp', 'mgrEmail',
  'certifications', 'patents', 'researchInstitutes', 'workforceAsOf'];

// ── 작은 도구 (ISO apply.js와 같은 모양) ──
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

// 금액·인원. **0과 음수는 실제 값이다**(재고 0·영업손실) — 비었을 때만 건너뛴다(규격 §1·§3-6)
const int = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** 접수번호 MB-YYMMDD-XXXX / IB-… (같은 날 겹치면 다시 뽑는다 — ISO와 같은 방식) */
export function receiptNo(cert, nowMs, rnd = Math.random) {
  return PREFIX[cert] + '-' + kstToday(nowMs).slice(2).replace(/-/g, '') + '-'
    + String(Math.floor(rnd() * 9000) + 1000);
}
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 접수 화면 값 → 검사 + 우편함 profile (규격 §2·§3) */
export function parseApplyBiz(d) {
  if (!d || typeof d !== 'object') throw new RuleError('접수 내용이 비어 있습니다');
  const bad = [];
  if (!validBizno(d.bizno)) bad.push('사업자등록번호(10자리 숫자를 확인해 주세요)');
  if (!PREFIX[d.cert]) bad.push('인증 구분');
  if (!SELECTIONS.includes(d.selection)) bad.push('선정 구분');
  if (!t(d.companyName)) bad.push('국문 상호');
  if (!t((d.profile || {}).mgr)) bad.push('담당자 이름');
  if (!t((d.profile || {}).mgrHp)) bad.push('담당자 휴대전화');
  const email = t((d.profile || {}).mgrEmail);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad.push('담당자 이메일 형식');
  if (bad.length) throw new RuleError('다음 항목을 확인해 주세요: ' + bad.join(', '));

  const src = d.profile && typeof d.profile === 'object' ? d.profile : {};
  const p = {};
  // **빈 칸은 넣지 않는다** — 빈 문자열·0으로 채우면 '미입력'과 '0'을 구분할 수 없다(규격 §1)
  for (const k of TEXTS) { const v = t(src[k], 300); if (v) p[k] = v; }
  for (const k of PEOPLE) { const v = int(src[k]); if (v !== null) p[k] = v; }
  for (let y = 0; y < 3; y++) {
    const yr = int(src['fy' + y + 'Year']); if (yr !== null) p['fy' + y + 'Year'] = yr;
    for (const f of FIN) { const v = int(src['fy' + y + f]); if (v !== null) p['fy' + y + f] = v; }
  }

  const cert = d.cert;
  const industry = INDUSTRY[cert].includes(t(d.industry)) ? t(d.industry) : '';
  const status = d.evidenceStatus && typeof d.evidenceStatus === 'object' ? d.evidenceStatus : null;
  const evidenceStatus = {};
  if (status) for (const [k, v] of Object.entries(status)) {
    if (['have', 'preparing', 'none'].includes(v)) evidenceStatus[k] = v;
  }
  return {
    bizno: fmtBizno(d.bizno), cert, selection: d.selection, industry,
    companyName: t(d.companyName, 100), profile: p,
    evidenceStatus: Object.keys(evidenceStatus).length ? evidenceStatus : null,
    note: t(d.note, 2000),
    contact: { name: p.mgr, hp: p.mgrHp, email: p.mgrEmail || '' },
  };
}

/** 비어 있어 담당자가 따로 요청할 항목 (규격 §8-3) */
export function laterList(a, gotKinds = new Set()) {
  const p = a.profile, out = [];
  if (!a.industry) out.push('업종');
  if (!p.foundedOn) out.push('설립일');
  const anyFin = Object.keys(p).some(k => /^fy[0-2]/.test(k));
  const finFile = gotKinds.has('EV-STANDARD-FINANCIAL-CERT') || gotKinds.has('EV-FINANCIAL-STATEMENTS');
  if (!anyFin && !finFile) out.push('재무 3개년(표를 채우거나 재무제표를 올려 주세요)');
  if (p.regularEmployees === undefined) out.push('상시근로자 수');
  if (p.researchers === undefined) out.push('연구·개발 인력 수');
  return out;
}

/** 받은 파일 검사 → [{kind, name, type, bytes}] (ISO collectFiles와 같다) */
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

export function applyBizConfig(env) { return { ok: true, files: !!(env[FOLDER_ENV] && env.GCP_SA_KEY) }; }

// ── 드라이브 — ISO apply.js의 driveFolder·driveUpload와 같다.
// **저쪽이 export하면 이 둘을 지우고 import로 바꾼다**(같은 창구에 두 벌 둘 이유가 없다).
async function driveFolder(token, parent, name, fetchFn) {
  const r = await fetchFn('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  const j = await r.json(); if (!r.ok) throw new Error('드라이브 폴더 만들기 실패: ' + (j.error && j.error.message || r.status));
  return j;
}
async function driveUpload(token, folderId, name, type, bytes, fetchFn) {
  const bd = 'sgbiz' + Math.random().toString(36).slice(2);
  const head = '--' + bd + '\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, parents: [folderId] })
    + '\r\n--' + bd + '\r\ncontent-type: ' + type + '\r\n\r\n';
  const body = new Blob([head, bytes, '\r\n--' + bd + '--']);
  const r = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/related; boundary=' + bd }, body,
  });
  const j = await r.json(); if (!r.ok) throw new Error('드라이브 올리기 실패(' + name + '): ' + (j.error && j.error.message || r.status));
  return j;
}

/** 접수 처리. deps: {db, fetchFn, nowMs, ip} — ISO submitApply와 같은 모양 */
export async function submitApplyBiz(env, { data, files = [] }, deps) {
  const { db, fetchFn = fetch, nowMs = Date.now() } = deps;
  // 자동 입력 프로그램(숨은 칸을 채움) — 조용히 무시 (ISO와 같다)
  if (data && t(data.website)) return { ok: true, receipt: receiptNo(data.cert in PREFIX ? data.cert : 'mainbiz', nowMs), later: [] };

  const a = parseApplyBiz(data);
  const day = kstToday(nowMs);
  const ipHash = deps.ip ? await sha('applybiz:' + deps.ip + ':' + day) : '';

  // 하루 한도
  const sameBiz = await db.query(COLLECTION, [['bizno', '==', a.bizno], ['day', '==', day]], {});
  if (sameBiz.length >= DAY_LIMIT_BIZNO) throw new RuleError('오늘 이 사업자번호로 이미 여러 번 접수하셨습니다. 내용을 고치실 것은 담당자에게 말씀해 주세요.');
  if (ipHash) {
    const sameIp = await db.query(COLLECTION, [['ipHash', '==', ipHash]], {});
    if (sameIp.length >= DAY_LIMIT_IP) throw new RuleError('오늘 접수 한도를 넘었습니다. 잠시 뒤 다시 시도하거나 담당자에게 연락해 주세요.');
  }

  const digits = a.bizno.replace(/\D/g, '');
  let no = receiptNo(a.cert, nowMs);
  for (let i = 0; i < 5 && await db.get(COLLECTION + '/apply__' + digits + '__' + no); i++) no = receiptNo(a.cert, nowMs);

  // 첨부 → 드라이브
  const cfg = applyBizConfig(env);
  const saved = [], fileNotes = [];
  let folderLink = '';
  if (files.length && !cfg.files) fileNotes.push('첨부 ' + files.length + '개는 저장 설정 전이라 받지 못함 — 업체에 메일로 요청');
  if (cfg.files && files.length) {
    try {
      const tok = await accessToken(env.GCP_SA_KEY, fetchFn, nowMs, DRIVE_SCOPE);
      const folder = await driveFolder(tok, env[FOLDER_ENV], no + '_' + a.companyName.replace(/[\\/:*?"<>|]/g, ''), fetchFn);
      folderLink = folder.webViewLink || ('https://drive.google.com/drive/folders/' + folder.id);
      for (const f of files) {
        const r = await driveUpload(tok, folder.id, FILE_KINDS[f.kind] + '_' + f.name, f.type, f.bytes, fetchFn);
        // **우편함은 파일을 담지 않는다 — 링크만 적는다**(규격 §5)
        const row = { name: f.name, url: r.webViewLink || ('https://drive.google.com/file/d/' + r.id + '/view') };
        if (f.kind !== 'other') row.evidenceId = f.kind;
        saved.push(row);
      }
    } catch (e) {
      console.error('[메인이노 접수] 첨부 저장 실패', e && e.message);
      fileNotes.push('첨부 저장 실패(' + String(e && e.message || e).slice(0, 80) + ') — 업체에 메일로 요청');
    }
  }
  const gotKinds = new Set(files.map(f => f.kind));
  const later = laterList(a, gotKinds);

  // 우편함 한 줄 (규격 §2-2). **state는 항상 pending이다**
  const doc = {
    bizno: a.bizno, companyName: a.companyName, cert: a.cert, selection: a.selection,
    profile: a.profile, kind: 'profile', round: 1, createIfMissing: true,
    source: 'apply', by: '온라인 접수', applyNo: no, createdAt: nowMs, state: 'pending',
    day, // 하루 한도를 세는 데 쓴다 (규격에 없는 칸 — 읽는 쪽은 모르는 칸을 건너뛴다)
  };
  if (a.industry) doc.industry = a.industry;
  if (a.evidenceStatus) doc.evidenceStatus = a.evidenceStatus;
  if (saved.length) doc.attachments = saved;
  if (a.note) doc.note = a.note;
  if (folderLink) doc.applyFolder = folderLink;
  if (ipHash) doc.ipHash = ipHash;

  await db.transaction(async (tx) => {
    tx.set(COLLECTION + '/apply__' + digits + '__' + no, doc);
    tx.create('activity/' + nowMs + '-' + Math.random().toString(36).slice(2, 10), {
      at: nowMs, app: 'biz', ref: no, no: 0, action: 'biz_apply', by: '온라인 접수', via: 'apply', bizno: a.bizno, changes: {},
      summary: '📋 ' + CERT_NAME[a.cert] + ' 온라인 접수: ' + a.companyName + ' (' + no + ')',
    });
  });

  // 할 일 — 접수 확인
  const memo = [
    '접수번호 ' + [no, a.bizno, CERT_NAME[a.cert], a.selection === 'new' ? '신규선정' : '재선정', a.industry].filter(Boolean).join(' · '),
    '담당 ' + a.contact.name + ' ' + a.contact.hp + ' ' + a.contact.email,
    a.note ? '요청사항: ' + a.note : '',
    later.length ? '추후 요청할 것: ' + later.join(', ') : '필요 항목 모두 작성',
    folderLink ? '첨부 폴더: ' + folderLink : '', ...fileNotes,
    '메인이노 프로그램에서 `python -m cli 접수확인`으로 반영합니다.',
  ].filter(Boolean).join('\n').slice(0, 1990);
  let todo = null;
  try {
    todo = await createTodo({ db, actor: { name: '공동', via: 'apply' }, nowMs, companies: [] },
      { text: '[' + a.companyName + '] ' + CERT_NAME[a.cert] + ' 접수 확인 (' + no + ')', category: TODO_CATEGORY, memo },
     { source: 'cert', sourceRef: 'applybiz:' + no, autoCompany: false });
  } catch (e) { console.error('[메인이노 접수] 할 일 만들기 실패', e && e.message); }

  return { ok: true, receipt: no, later, filesSaved: saved.length, todo: (todo && todo.label) || '' };
}
