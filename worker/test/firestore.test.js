// Firestore REST 요청 모양 시험 — 가짜 서버(fetch)로 받아서 확인한다. 실제 Google에는 접속하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { restDb, encodeFields, decodeFields } from '../src/firestore.js';

test('값 변환 왕복', () => {
  const v = { s: '가', i: 3, d: 1.5, b: true, n: null, a: ['x', 2], m: { every: 'month', n: 1 }, ch: { status: ['ing', 'done'] } };
  assert.deepEqual(decodeFields(encodeFields(v)), v);
  assert.deepEqual(encodeFields({ t: 1791428400000 }).t, { integerValue: '1791428400000' });
});

test('서비스 계정 토큰 → 조회 → 트랜잭션 저장', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const saKey = JSON.stringify({ client_email: 'sg-todo-api@sg-crm-f9adc.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\n' + pkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n' });
  const calls = [];
  const fetchFn = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || 'GET', body: opt.body, auth: opt.headers && opt.headers.authorization });
    if (url === 'https://oauth2.googleapis.com/token') {
      const jwt = new URLSearchParams(opt.body).get('assertion');
      const [h, p, s] = jwt.split('.');
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + p));
      const claim = JSON.parse(Buffer.from(p, 'base64url').toString());
      assert.ok(ok, 'JWT 서명이 맞아야 함');
      assert.equal(claim.scope, 'https://www.googleapis.com/auth/datastore');
      assert.equal(claim.iss, 'sg-todo-api@sg-crm-f9adc.iam.gserviceaccount.com');
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
    }
    if (url.endsWith(':beginTransaction')) return new Response(JSON.stringify({ transaction: 'TX1' }));
    if (url.includes('/documents/app_state/todo_seq?transaction=TX1'))
      return new Response(JSON.stringify({ name: 'projects/sg-crm-f9adc/databases/(default)/documents/app_state/todo_seq', fields: { last: { integerValue: '41' } } }));
    if (url.endsWith(':runQuery')) return new Response(JSON.stringify([{ readTime: 'x' }]));
    if (url.endsWith(':commit')) return new Response(JSON.stringify({ writeResults: [{}] }));
    if (url.includes('/documents/todos/T-0404')) return new Response('{}', { status: 404 });
    throw new Error('예상 못 한 요청: ' + url);
  };
  const db = restDb({ projectId: 'sg-crm-f9adc', saKey, fetchFn });
  assert.equal(await db.get('todos/T-0404'), null);
  const r = await db.transaction(async (tx) => {
    const seq = await tx.get('app_state/todo_seq');
    const dup = await tx.query('todos', [['dedupeKey', '==', 'cert:1']], { limit: 1 });
    assert.equal(dup.length, 0);
    const no = seq.data.last + 1;
    tx.create('todos/T-0042', { no, text: '시험' });
    tx.set('app_state/todo_seq', { last: no });
    tx.update('todos/T-0001', { status: 'done', doneAt: null });
    return no;
  });
  assert.equal(r, 42);
  assert.equal(calls.filter(c => c.url.includes('oauth2')).length, 1);           // 토큰은 한 번만 발급해 재사용
  assert.ok(calls.filter(c => !c.url.includes('oauth2')).every(c => c.auth === 'Bearer tok-1'));
  const q = JSON.parse(calls.find(c => c.url.endsWith(':runQuery')).body);
  assert.equal(q.transaction, 'TX1');
  assert.deepEqual(q.structuredQuery.where.fieldFilter, { field: { fieldPath: 'dedupeKey' }, op: 'EQUAL', value: { stringValue: 'cert:1' } });
  const commit = JSON.parse(calls.find(c => c.url.endsWith(':commit')).body);
  assert.equal(commit.transaction, 'TX1');
  assert.deepEqual(commit.writes[0].currentDocument, { exists: false });          // 새 번호 문서는 「없을 때만」 만든다
  assert.equal(commit.writes[0].update.name, 'projects/sg-crm-f9adc/databases/(default)/documents/todos/T-0042');
  assert.deepEqual(commit.writes[2].updateMask, { fieldPaths: ['status', 'doneAt'] });
  assert.deepEqual(commit.writes[2].update.fields.doneAt, { nullValue: null });
});
