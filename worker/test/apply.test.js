// 🏅 ISO 온라인 접수 시험 — 메모리 DB·가짜 드라이브만. 실제 Firestore·드라이브에 접속하지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { validBizno, parseApply, submitApply, applyConfig, collectFiles, applyDocHtml } from '../src/apply.js';
import { handle } from '../src/index.js';

const NOW = Date.parse('2026-10-27T01:00:00Z');   // 한국 2026-10-27 10:00
const BIZ = '403-81-51013';   // 실제 체크섬이 맞는 번호(세웅바이오)
const base = () => ({
  co_name: '주식회사 한빛정밀', co_en: 'Hanbit Precision Co., Ltd.', bizno: '4038151013', ceo: '박한빛', addr: '경기도 화성시 향남읍 제약공단1길 25',
  tel: '031-123-4567', stds: ['q', 'o'], atype: '최초', scope: '자동차 엔진용 연료 분사 부품의 가공 및 조립', mgr: '이영희', mgr_title: '품질팀 / 과장',
  mgr_hp: '010-1234-5678', mgr_email: 'q@hanbit.example', emp_total: '28명', safe_mgr: '김안전', safe_title: '관리팀 / 부장', safe_hp: '010-2222-3333',
  customer: '㈜현대모비스', supplier: '㈜한국철강', has_permit: '있음', agree: true, when: '다음 달', memo: '12월 입찰 전 인증 필요',
});
const env = { ALLOWED_EMAILS: 'sgceo@sgsolutionss.com', APPLY_ASSIGNEE: 'sgceo@sgsolutionss.com', ALLOWED_ORIGINS: 'https://iso-one.web.app' };
const docs = (db, col) => [...db.store.entries()].filter(([p]) => p.startsWith(col + '/')).map(([p, d]) => Object.assign({ _id: p.split('/')[1] }, d));

test('사업자번호 체크섬', () => {
  assert.equal(validBizno(BIZ), true);
  assert.equal(validBizno('4038151012'), false);
  assert.equal(validBizno('123-45-678'), false);
});

test('접수 값 → iso-one 칸', () => {
  const a = parseApply(base(), NOW);
  assert.equal(a.bizno, BIZ);
  assert.deepEqual(a.certs, ['iso_9001', 'iso_45001']);
  assert.equal(a.atype, '최초심사');
  assert.equal(a.profile.mgr_dept, '품질팀'); assert.equal(a.profile.mgr_title, '과장');
  assert.equal(a.profile.emp_total, '28');
  assert.equal(a.profile.safety_mgr, '김안전');
  assert.equal(a.profile.supplier, '㈜한국철강');
  // 우편번호·인증서 받을 주소
  const z = parseApply(Object.assign(base(), { addr_zip: '18622', ship_same: true, founding: '2008-08-04' }), NOW);
  assert.equal(z.profile.addr_zip, '18622'); assert.equal(z.extra.shipAddr, '사업장 주소와 같음'); assert.equal(z.profile.founding_date, '2008-08-04');
  const z2 = parseApply(Object.assign(base(), { addr_zip: '12', ship_same: false, ship_zip: '04524', ship_addr: '서울 중구 세종대로 110', founding: '200808-04' }), NOW);
  assert.ok(!('addr_zip' in z2.profile)); assert.equal(z2.extra.shipAddr, '(04524) 서울 중구 세종대로 110'); assert.ok(!('founding_date' in z2.profile));
  assert.match(a.profile.permits, /^있음/);
  assert.ok(!('transfer' in a.profile));
  assert.ok(a.later.includes('공정 순서') && !a.later.includes('주요 매출처'));
  // 사후 2차·전환
  assert.equal(parseApply(Object.assign(base(), { atype: '사후2' }), NOW).atype, '사후심사(2차)');
  const x = parseApply(Object.assign(base(), { atype: '전환', transfer_org: '○○인증원', xlt: ['사후심사', '갱신심사'], transfer_valid_q: '2023.11.28~2026.11.27', transfer_valid_e: '안 보냄' }), NOW);
  assert.equal(x.atype, ''); assert.equal(x.profile.transfer, '예'); assert.equal(x.profile.transfer_last_type, '사후심사, 갱신심사');
  assert.equal(x.profile.transfer_valid_q, '2023.11.28~2026.11.27'); assert.ok(!('transfer_valid_e' in x.profile));   // 14001은 신청 안 함
});

test('필수·형식 검사', () => {
  assert.throws(() => parseApply(Object.assign(base(), { bizno: '1234567890' }), NOW), /사업자등록번호/);
  assert.throws(() => parseApply(Object.assign(base(), { stds: [] }), NOW), /인증 규격/);
  assert.throws(() => parseApply(Object.assign(base(), { safe_mgr: '' }), NOW), /안전보건 관리 담당자/);   // 45001이면 필수
  assert.doesNotThrow(() => parseApply(Object.assign(base(), { stds: ['q'], safe_mgr: '' }), NOW));
  assert.throws(() => parseApply(Object.assign(base(), { agree: false }), NOW), /동의/);
});

test('접수 → 우편함·접수 원본·할 일 (첨부 설정 전)', async () => {
  const db = fakeDb();
  const r = await submitApply(env, { data: base(), files: [] }, { db, nowMs: NOW, ip: '1.2.3.4' });
  assert.equal(r.ok, true); assert.match(r.receipt, /^ISO-261027-\d{4}$/);
  const [ib] = docs(db, 'iso_inbox');
  assert.equal(ib.kind, 'profile'); assert.equal(ib.source, 'apply'); assert.equal(ib.createIfMissing, true);
  assert.equal(ib.assignee, 'sgceo@sgsolutionss.com'); assert.equal(ib.bizno, BIZ); assert.equal(ib.state, 'pending');
  assert.deepEqual(ib.certs, ['iso_9001', 'iso_45001']); assert.equal(ib.applyNo, r.receipt);
  const [rec] = docs(db, 'iso_apply');
  assert.equal(rec.no, r.receipt); assert.equal(rec.extra.memo, '12월 입찰 전 인증 필요'); assert.equal(rec.extra.safety.hp, '010-2222-3333');
  assert.ok(rec.later[0].includes('(첨부)'));   // 첨부 없음 → 추후 요청 맨 앞
  const [td] = docs(db, 'todos');
  assert.match(td.text, /한빛정밀.*ISO 심사 접수 확인/); assert.equal(td.category, 'iso'); assert.match(td.memo, /희망 시기: 다음 달/);
  assert.equal(r.todo, td._id);
});

test('기존 고객사 — 바뀐 내용만(필수 최소·추후 요청 없음)', async () => {
  const d = { existing: true, co_name: '유한회사 세웅바이오', bizno: '4038151013', mgr: '김신혜', mgr_hp: '010-5555-6666', agree: true, outsource: '없다', multi_site: '아니오' };
  const a = parseApply(d, NOW);
  assert.equal(a.existing, true); assert.deepEqual(a.certs, []); assert.equal(a.atype, ''); assert.deepEqual(a.later, []);
  assert.equal(a.profile.outsource, '없다'); assert.ok(!('scope' in a.profile)); assert.ok(!('emp_total' in a.profile));
  assert.throws(() => parseApply({ existing: true, co_name: '세웅', bizno: '4038151013', agree: true }, NOW), /ISO 담당자.*담당자 휴대전화/);
  assert.throws(() => parseApply(Object.assign({}, d, { existing: false }), NOW), /영문 상호/);   // 처음 신청이면 기존 필수 그대로
  const db = fakeDb();
  const r = await submitApply(env, { data: d, files: [] }, { db, nowMs: NOW, ip: '1.2.3.9' });
  assert.deepEqual(r.later, []);   // 첨부도 추후 요청에 안 넣음
  const [ib] = docs(db, 'iso_inbox'); assert.ok(!('certs' in ib)); assert.ok(!('atype' in ib)); assert.equal(ib.source, 'apply');
  const [rec] = docs(db, 'iso_apply'); assert.equal(rec.existing, true);
  const [td] = docs(db, 'todos');
  assert.match(td.text, /세웅바이오.*ISO 정보 회신 확인/); assert.match(td.memo, /기존 ISO 고객사 회신/); assert.doesNotMatch(td.memo, /자동 등록/); assert.doesNotMatch(td.memo, / · {2}·/);
  assert.match(applyDocHtml(d, { no: 'ISO-1', at: '', bizno: BIZ, files: [], later: [] }), /기존 ISO 고객사/);
});

test('하루 한도·숨은 칸', async () => {
  const db = fakeDb();
  for (let i = 0; i < 3; i++) await submitApply(env, { data: base(), files: [] }, { db, nowMs: NOW + i });
  await assert.rejects(() => submitApply(env, { data: base(), files: [] }, { db, nowMs: NOW + 9 }), /여러 번/);
  const db2 = fakeDb();
  const r = await submitApply(env, { data: Object.assign(base(), { website: 'http://spam' }), files: [] }, { db: db2, nowMs: NOW });
  assert.equal(r.ok, true); assert.equal(docs(db2, 'iso_inbox').length, 0);   // 아무것도 쓰지 않음
});

test('첨부 → 드라이브(가짜)', async () => {
  const calls = [], docBodies = [];
  const fetchFn = async (url, opt) => {
    calls.push(url);
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.includes('/upload/drive/v3/files')) {
      const txt = await new Response(opt.body).text();
      if (txt.includes('application/vnd.google-apps.document')) { docBodies.push(txt); return new Response(JSON.stringify({ id: 'DOC1', webViewLink: 'https://docs.google.com/document/d/DOC1/edit' })); }
      return new Response(JSON.stringify({ id: 'F' + calls.length, name: 'x' }));
    }
    if (url.includes('/drive/v3/files')) return new Response(JSON.stringify({ id: 'FOLDER1', webViewLink: 'https://drive.google.com/drive/folders/FOLDER1' }));
    return new Response('{}', { status: 404 });
  };
  // 서명이 되는 가짜 키
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const sa = JSON.stringify({ client_email: 'sa@test.iam', private_key: '-----BEGIN PRIVATE KEY-----\n' + der + '\n-----END PRIVATE KEY-----\n' });
  const env2 = Object.assign({}, env, { GCP_SA_KEY: sa, APPLY_DRIVE_FOLDER: 'PARENT' });
  assert.equal(applyConfig(env2).files, true); assert.equal(applyConfig(env).files, false);
  const db = fakeDb();
  const files = [{ kind: 'f_biz', name: '등록증.pdf', type: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]).buffer },
    { kind: 'f_ins', name: '명부.png', type: 'image/png', bytes: new Uint8Array([1, 2]).buffer }];
  const r = await submitApply(env2, { data: base(), files }, { db, nowMs: NOW, fetchFn });
  assert.equal(r.filesSaved, 2);
  const [rec] = docs(db, 'iso_apply');
  assert.equal(rec.folder, 'https://drive.google.com/drive/folders/FOLDER1');
  assert.ok(!rec.later.some(x => x.includes('사업자등록증')));
  assert.ok(rec.later.some(x => x.includes('허가증')));   // 인허가 「있음」인데 허가증 안 올림
  assert.equal(calls.filter(u => u.includes('/upload/')).length, 3);   // 첨부 2 + 접수서 1
  assert.equal(rec.doc, 'https://docs.google.com/document/d/DOC1/edit');
  const [ib] = docs(db, 'iso_inbox');
  assert.equal(ib.applyDoc, 'https://docs.google.com/document/d/DOC1/edit'); assert.equal(ib.applyFolder, 'https://drive.google.com/drive/folders/FOLDER1');
  assert.match(docBodies[0], /접수서_ISO-261027-\d{4}_주식회사 한빛정밀/);
  assert.match(docBodies[0], /12월 입찰 전 인증 필요/); assert.match(docBodies[0], /등록증\.pdf/);
  const [td] = docs(db, 'todos'); assert.match(td.memo, /접수서: https:\/\/docs\.google\.com/);
  // 첨부가 없어도 드라이브 설정이 있으면 폴더 + 접수서
  const db2 = fakeDb(); docBodies.length = 0;
  const r2 = await submitApply(env2, { data: base(), files: [] }, { db: db2, nowMs: NOW, fetchFn });
  assert.equal(r2.doc, true); assert.equal(docBodies.length, 1);
});

test('접수서 내용 — 업체가 쓴 그대로, 규격에 맞는 칸만', () => {
  const h = applyDocHtml(Object.assign(base(), { products: '연료 분사 노즐', safe_title: '관리팀 / 부장', ship_addr: '' }),
    { no: 'ISO-261027-1234', at: '2026-10-27 10:00', bizno: BIZ, files: [], later: ['공정 순서'] });
  assert.match(h, /ISO-261027-1234/); assert.match(h, /주식회사 한빛정밀/); assert.match(h, /연료 분사 노즐/);
  assert.match(h, /ISO 9001, ISO 45001/); assert.match(h, /안전보건 관리 담당자/); assert.match(h, /김안전/);
  assert.doesNotMatch(h, /사업장 입지/);   // 14001 안 고름
  assert.match(h, /추후 요청할 항목/); assert.match(h, /\(비움\)/);
  assert.doesNotMatch(applyDocHtml(Object.assign(base(), { memo: '<script>x</script>' }), { no: 'N', at: '', bizno: BIZ, files: [], later: [] }), /<script>/);
});

test('파일 검사', async () => {
  const fd = new FormData();
  fd.append('f_biz', new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' }));
  fd.append('f_org', new File([new Uint8Array(10)], 'a.exe', { type: 'application/x-msdownload' }));
  await assert.rejects(() => collectFiles(fd), /PDF, JPG, PNG/);
  const fd2 = new FormData();
  fd2.append('f_biz', new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
  await assert.rejects(() => collectFiles(fd2), /10MB/);
});

test('주소로 부르기 — 로그인 없이, iso-one 화면 주소 허용', async () => {
  const db = fakeDb();
  const cfg = await handle(new Request('https://w/api/apply/config', { headers: { origin: 'https://iso-one.web.app' } }), env, { db, nowMs: NOW });
  assert.equal(cfg.status, 200); assert.equal(cfg.headers.get('access-control-allow-origin'), 'https://iso-one.web.app');
  const fd = new FormData(); fd.append('data', JSON.stringify(base()));
  const res = await handle(new Request('https://w/api/apply', { method: 'POST', body: fd, headers: { origin: 'https://iso-one.web.app' } }), env, { db, nowMs: NOW });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j)); assert.match(j.receipt, /^ISO-/);
  const bad = new FormData(); bad.append('data', JSON.stringify(Object.assign(base(), { bizno: '1' })));
  const res2 = await handle(new Request('https://w/api/apply', { method: 'POST', body: bad }), env, { db, nowMs: NOW });
  assert.equal(res2.status, 400); assert.match((await res2.json()).error, /사업자등록번호/);
});
