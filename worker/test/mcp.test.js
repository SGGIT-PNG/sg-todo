// Claude 커넥터(MCP + 로그인) 모의 시험 — 실제 Firestore·Claude에 접속하지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { handle } from '../src/index.js';
import { _resetJwksCache } from '../src/auth.js';
import { seal, unseal, redirectAllowed } from '../src/oauth.js';
import { parseSince } from '../src/mcp.js';

const NOW = Date.parse('2026-10-08T03:00:00Z');   // 한국 시간 2026-10-08 12:00
const BASE = 'https://sg-todo.sgsolution.workers.dev';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const ENV = { FIREBASE_PROJECT: 'sg-crm-f9adc', ALLOWED_EMAILS: 'sgceo@sgsolutionss.com', ALLOWED_ORIGINS: 'https://sggit-png.github.io', MCP_SECRET: 'test-secret-1' };
const seed = () => fakeDb({
  'companies/111-11-11111': { name: '㈜하이퍼다인', active: 'Y' },
  'companies/222-22-22222': { name: '청림테크', active: 'Y' },
  'companies/333-33-33333': { name: '청림식품', active: 'Y' },
});

async function makeAuth() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = Object.assign(await crypto.subtle.exportKey('jwk', kp.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (o = {}) => {
    const payload = Object.assign({ aud: 'sg-crm-f9adc', iss: 'https://securetoken.google.com/sg-crm-f9adc', sub: 'u1', email: 'sgceo@sgsolutionss.com', email_verified: true, iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 3000 }, o);
    const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64(payload);
    const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return h + '.' + p + '.' + Buffer.from(s).toString('base64url');
  };
  const fetchFn = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });
  return { sign, fetchFn };
}
const pkce = async () => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  return { verifier, challenge };
};

// 로그인 전 과정 → 출입증
async function connect(env, deps, sign) {
  const go = (req, nowMs = NOW) => handle(req, env, Object.assign({}, deps, { nowMs }));
  const reg = await go(new Request(BASE + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CB], client_name: 'Claude' }), headers: { 'content-type': 'application/json' } }));
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1' });
  const page = await go(new Request(BASE + '/oauth/authorize?' + q));
  assert.equal(page.status, 200);
  const html = await page.text();
  const reqTok = html.match(/name="req" value="([^"]+)"/)[1];
  const form = new FormData(); form.set('req', reqTok); form.set('idToken', await sign());
  const ap = await go(new Request(BASE + '/oauth/approve', { method: 'POST', body: form }));
  assert.equal(ap.status, 302);
  const back = new URL(ap.headers.get('location'));
  assert.equal(back.origin + back.pathname, CB);
  assert.equal(back.searchParams.get('state'), 'st1');
  const tk = await go(new Request(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: CB, client_id, code_verifier: verifier }) }));
  assert.equal(tk.status, 200);
  return Object.assign(await tk.json(), { client_id, code: back.searchParams.get('code'), verifier });
}

test('커넥터 안내 문서 · 출입증 없이 /mcp → 401 + 로그인 위치', async () => {
  const db = seed();
  const r1 = await handle(new Request(BASE + '/.well-known/oauth-protected-resource'), ENV, { db, nowMs: NOW });
  assert.deepEqual((await r1.json()).authorization_servers, [BASE]);
  const r2 = await (await handle(new Request(BASE + '/.well-known/oauth-authorization-server'), ENV, { db, nowMs: NOW })).json();
  assert.equal(r2.token_endpoint, BASE + '/oauth/token');
  assert.deepEqual(r2.code_challenge_methods_supported, ['S256']);
  const r3 = await handle(new Request(BASE + '/mcp', { method: 'POST', body: '{}' }), ENV, { db, nowMs: NOW });
  assert.equal(r3.status, 401);
  assert.match(r3.headers.get('www-authenticate'), /resource_metadata="https:\/\/sg-todo\.sgsolution\.workers\.dev\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await handle(new Request(BASE + '/mcp', { method: 'POST', body: '{}', headers: { authorization: 'Bearer v1.fake.sig' } }), ENV, { db, nowMs: NOW })).status, 401);
});

test('로그인 지키기 — Claude 주소만 · PKCE · 허용 메일 · 위조·만료', async () => {
  _resetJwksCache();
  const { sign, fetchFn } = await makeAuth();
  const db = seed();
  const go = (req, nowMs = NOW) => handle(req, ENV, { db, fetchFn, nowMs });
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(redirectAllowed('http://localhost:33418/callback'), true);
  assert.equal(redirectAllowed('https://evil.example/cb'), false);
  assert.equal(redirectAllowed('https://claude.ai.evil.example/cb'), false);
  const bad = await go(new Request(BASE + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) }));
  assert.equal(bad.status, 400);

  const t = await connect(ENV, { db, fetchFn }, sign);
  assert.ok(t.access_token && t.refresh_token); assert.equal(t.expires_in, 3600);
  // 같은 코드를 다른 PKCE로 → 거절
  const wrong = await go(new Request(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: t.code, redirect_uri: CB, client_id: t.client_id, code_verifier: 'x'.repeat(43) }) }));
  assert.equal(wrong.status, 400);
  // 코드 6분 뒤 → 만료
  const late = await go(new Request(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: t.code, redirect_uri: CB, client_id: t.client_id, code_verifier: t.verifier }) }), NOW + 6 * 60000);
  assert.equal(late.status, 400);
  // 갱신증 → 새 출입증
  const rf = await go(new Request(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }) }), NOW + 2 * 3600000);
  assert.equal(rf.status, 200); assert.ok((await rf.json()).access_token);
  // 출입증을 갱신증 자리에 → 거절 (용도 바꿔치기)
  const swap = await go(new Request(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.access_token }) }));
  assert.equal(swap.status, 400);
  // 출입증 1시간 뒤 → 401 (Claude가 갱신증으로 다시 받음)
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const mcp = (tok, nowMs) => go(new Request(BASE + '/mcp', { method: 'POST', body: JSON.stringify(ping), headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' } }), nowMs);
  assert.equal((await mcp(t.access_token, NOW)).status, 200);
  assert.equal((await mcp(t.access_token, NOW + 3601000)).status, 401);
  // 비밀키를 바꾸면 전부 끊김 (비상 차단)
  assert.equal((await handle(new Request(BASE + '/mcp', { method: 'POST', body: JSON.stringify(ping), headers: { authorization: 'Bearer ' + t.access_token } }), Object.assign({}, ENV, { MCP_SECRET: 'rotated' }), { db, nowMs: NOW })).status, 401);
  // 허용 안 된 구글 계정 → 연결 거절
  const reg = await (await go(new Request(BASE + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CB] }) }))).json();
  const { challenge } = await pkce();
  const html = await (await go(new Request(BASE + '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256' })))).text();
  const form = new FormData(); form.set('req', html.match(/name="req" value="([^"]+)"/)[1]); form.set('idToken', await sign({ email: 'x@gmail.com' }));
  assert.equal((await go(new Request(BASE + '/oauth/approve', { method: 'POST', body: form }))).status, 403);
  // 등록과 다른 되돌아갈 주소 → 로그인 화면도 안 열림
  const other = await go(new Request(BASE + '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/other', code_challenge: challenge, code_challenge_method: 'S256' })));
  assert.equal(other.status, 400);
});

test('서명 — 비밀값이 없으면 서비스 계정 키에서 만든다 · 용도 구분', async () => {
  const env = { GCP_SA_KEY: JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }) };
  const s = await seal(env, 'at', { em: 'a' }, 60, NOW);
  assert.equal((await unseal(env, 'at', s, NOW)).em, 'a');
  assert.equal(await unseal(env, 'rt', s, NOW), null);
  assert.equal(await unseal(env, 'at', s, NOW + 61000), null);
  assert.equal(await unseal(env, 'at', s.slice(0, -2) + 'AA', NOW), null);
});

test('MCP 도구 — 추가·완료·수정·조회·바뀐 것·삭제·되살리기', async () => {
  _resetJwksCache();
  const { sign, fetchFn } = await makeAuth();
  const db = seed();
  const { access_token } = await connect(ENV, { db, fetchFn }, sign);
  let id = 0;
  const rpc = async (method, params, nowMs = NOW) => {
    const r = await handle(new Request(BASE + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json' } }), ENV, { db, fetchFn, nowMs });
    assert.equal(r.status, 200);
    return (await r.json()).result;
  };
  const tool = async (name, args, nowMs) => { const r = await rpc('tools/call', { name, arguments: args }, nowMs); return { text: r.content[0].text, err: r.isError }; };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18'); assert.ok(init.capabilities.tools);
  const n = await handle(new Request(BASE + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), headers: { authorization: 'Bearer ' + access_token } }), ENV, { db, nowMs: NOW });
  assert.equal(n.status, 202);
  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map(t => t.name).sort(), ['company_find', 'todo_add', 'todo_changes', 'todo_complete', 'todo_delete', 'todo_get', 'todo_list', 'todo_restore', 'todo_update']);
  assert.equal(tools.find(t => t.name === 'todo_list').annotations.readOnlyHint, true);

  // 작성자 없으면 거절 (공용 계정)
  let r = await tool('todo_add', { text: '서류 요청' });
  assert.equal(r.err, true); assert.match(r.text, /author/);
  // 기업 후보 여럿 → 저장 안 함
  r = await tool('todo_add', { text: '견적 보내기', company: '청림', author: '정석진' });
  assert.equal(r.err, true); assert.match(r.text, /청림테크 · 222-22-22222/);
  assert.equal([...db.store.keys()].filter(k => k.startsWith('todos/')).length, 0);
  // 추가
  r = await tool('todo_add', { text: '벤처 서류 요청', company: '하이퍼다인', due: '10/10', author: '정석진' });
  assert.equal(r.err, false); assert.match(r.text, /^T-0001 저장됨 · ㈜하이퍼다인 · 마감 2026-10-10/);
  // 같은 말을 곧바로 또 → 새로 안 만듦(재시도 중복 방지)
  r = await tool('todo_add', { text: '벤처 서류 요청', company: '하이퍼다인', due: '10/10', author: '정석진' });
  assert.match(r.text, /이미 있는 할 일/);
  r = await tool('todo_add', { text: '월말 정산', due: '10/31', repeat: { every: 'month', n: 1 }, author: '김학미' });
  assert.match(r.text, /^T-0002 저장됨/);
  const t1 = db.store.get('todos/T-0001');
  assert.equal(t1.source, 'chat'); assert.equal(t1.createdBy, '정석진');
  // 조회
  r = await tool('todo_list', {});
  assert.match(r.text, /오늘 볼 할 일 2건/);
  assert.match(r.text, /T-0001 \[놓침·D-2 · 아직 시작 안 함\] ㈜하이퍼다인 — 벤처 서류 요청 \(10\/10\) · 정석진/);
  // 수정 — 기다림
  r = await tool('todo_update', { no: 'T-0001', status: 'waiting', waitingFor: '고객 서류 회신', due: '10/15', author: '김학미' });
  assert.match(r.text, /T-0001 수정됨: .*상태 → 기다리는 중/);
  r = await tool('todo_list', { view: 'waiting' });
  assert.match(r.text, /T-0001 \[기다림·고객 서류 회신 · 확인 D-7\]/);
  // 완료 — 여러 개, 반복은 다음 회차
  r = await tool('todo_complete', { no: ['T-0001', 2, 'T-0099'], author: '정석진', note: '접수 완료' });
  assert.match(r.text, /T-0001 완료/); assert.match(r.text, /T-0002 완료 .*다음 회차 T-0003, 마감 2026-11-30/); assert.match(r.text, /T-0099 실패: 없는 할 일/);
  assert.equal(db.store.get('todos/T-0001').status, 'done');
  // 자세히 — 이력에 Claude 표시
  r = await tool('todo_get', { no: 1 });
  assert.match(r.text, /메모:\n10\/08 완료: 접수 완료/); assert.match(r.text, /정석진 · T-0001 .* → 완료 \(Claude\)/);
  // 삭제 → 목록에서 빠짐 → 되살리기
  r = await tool('todo_delete', { no: 'T-0003', reason: '잘못 넣음', author: '공동' });
  assert.match(r.text, /T-0003 휴지통으로 옮김 \(2026-11-07까지/);
  assert.match((await tool('todo_list', { view: 'open' })).text, /끝나지 않은 할 일 0건/);
  assert.match((await tool('todo_restore', { no: 'T-0003', author: '공동' })).text, /T-0003 되살림/);
  // 바뀐 것
  r = await tool('todo_changes', { since: '1h' }, NOW + 1000);
  assert.match(r.text, /이후 바뀐 것 \d+건/); assert.match(r.text, /공동 · T-0003 .* 되살림 \(Claude\)/);
  r = await tool('todo_changes', { company: '하이퍼다인', since: '2026-10-08' }, NOW + 1000);
  assert.doesNotMatch(r.text, /T-0003/);
  // 기업 찾기
  assert.match((await tool('company_find', { query: '청림' })).text, /후보 2곳/);
  assert.equal((await tool('company_find', { query: '1111111111' })).text, '㈜하이퍼다인 · 111-11-11111');
  // 활동 기록에 via=mcp
  const acts = [...db.store.entries()].filter(([p]) => p.startsWith('activity/')).map(([, d]) => d);
  assert.ok(acts.length >= 6 && acts.every(a => a.via === 'mcp'));
});

test('since 말 알아듣기', () => {
  assert.equal(parseSince('3h', NOW), NOW - 3 * 3600000);
  assert.equal(parseSince('2일', NOW), NOW - 2 * 86400000);
  assert.equal(parseSince('2026-10-08', NOW), Date.parse('2026-10-07T15:00:00Z'));
  assert.equal(parseSince('2026-10-08 14:00', NOW), Date.parse('2026-10-08T05:00:00Z'));
  assert.equal(parseSince('', NOW), NOW - 86400000);
  assert.throws(() => parseSince('지난주쯤', NOW));
});
