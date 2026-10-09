// ── Claude 커넥터 로그인 (OAuth 2.1 — claude.ai 「커스텀 커넥터」) ──
// Claude가 /mcp 를 부르려면 먼저 이 창구에서 로그인 허락을 받아 「출입증(토큰)」을 얻는다.
//   ① Claude → /.well-known/* 로 로그인 주소를 알아냄 → /oauth/register 로 자기 등록
//   ② 사장님 브라우저가 /oauth/authorize 로 열림 → 구글 로그인(Firebase, 허용 메일만) → 「연결 허용」
//   ③ Claude 주소로 되돌아가며 일회용 코드 → /oauth/token 에서 출입증(1시간) + 갱신증(90일)으로 바꿈
// 저장소(KV)를 쓰지 않는다: 코드·출입증은 모두 비밀키로 서명한 문자열이라 창구가 서명만 확인하면 된다.
// 비밀키 = Cloudflare Secret MCP_SECRET (없으면 서비스 계정 키에서 만들어 씀).
// MCP_SECRET 값을 바꾸면 이미 연결된 커넥터가 전부 끊긴다(분실·유출 시 비상 차단).

import { verifyIdToken, AuthError } from './auth.js';

export const ACCESS_TTL = 3600;            // 출입증 1시간 (Claude가 갱신증으로 알아서 다시 받음)
export const REFRESH_TTL = 90 * 86400;     // 갱신증 90일 — 그 안에 한 번이라도 쓰면 계속 연장
const CODE_TTL = 300;                      // 일회용 코드 5분
const REQ_TTL = 900;                       // 로그인 화면 유효 15분

const enc = new TextEncoder();
function b64url(bytes) {
  let s = ''; const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

const keyCache = new Map();
async function hmacKey(env) {
  let raw = env.MCP_SECRET;
  if (!raw) {
    if (!env.GCP_SA_KEY) throw new Error('MCP_SECRET 또는 GCP_SA_KEY 비밀값이 없습니다');
    raw = 'sg-todo-mcp-v1\n' + (JSON.parse(env.GCP_SA_KEY).private_key || '');
  }
  if (keyCache.has(raw)) return keyCache.get(raw);
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  keyCache.set(raw, key);
  return key;
}

// 서명한 문자열: v1.<내용>.<서명>  (typ으로 용도를 구분 — 코드를 출입증으로 쓰는 식의 바꿔치기 방지)
export async function seal(env, typ, data, ttlSec, nowMs = Date.now()) {
  const body = Object.assign({ typ, iat: Math.floor(nowMs / 1000) }, data);
  if (ttlSec) body.exp = body.iat + ttlSec;
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode('v1.' + p));
  return 'v1.' + p + '.' + b64url(sig);
}
export async function unseal(env, typ, token, nowMs = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlToBytes(parts[2]), enc.encode('v1.' + parts[1])); }
  catch { return null; }
  if (!ok) return null;
  let body;
  try { body = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))); } catch { return null; }
  if (body.typ !== typ) return null;
  if (body.exp && body.exp < Math.floor(nowMs / 1000)) return null;
  return body;
}

// Claude가 되돌아갈 주소는 Claude 것만 허용 (claude.ai·claude.com, Claude Code의 내 PC 주소)
export function redirectAllowed(uri) {
  let u; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:' && ['claude.ai', 'claude.com', 'www.claude.ai', 'www.claude.com'].includes(u.hostname)) return true;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return true;
  return false;
}

const allowedEmails = (env) => String(env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
export const originOf = (request) => new URL(request.url).origin;

function oauthJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,mcp-protocol-version' }, extra),
  });
}
const oauthErr = (error, desc, status = 400) => oauthJson({ error, error_description: desc }, status);

// ── 안내 문서 (Claude가 처음 읽는 곳) ──
export function protectedResourceMeta(request) {
  const o = originOf(request);
  return oauthJson({ resource: o + '/mcp', authorization_servers: [o], bearer_methods_supported: ['header'], resource_name: 'SG솔루션 할 일' });
}
export function authServerMeta(request) {
  const o = originOf(request);
  return oauthJson({
    issuer: o,
    authorization_endpoint: o + '/oauth/authorize',
    token_endpoint: o + '/oauth/token',
    registration_endpoint: o + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['todo'],
  });
}
// /mcp 에 출입증 없이 오면 — 어디서 로그인하는지 알려 주는 401
export function unauthorized(request, msg = '로그인이 필요합니다') {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: msg }), {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer resource_metadata="' + originOf(request) + '/.well-known/oauth-protected-resource"',
      'access-control-allow-origin': '*', 'access-control-expose-headers': 'www-authenticate',
    },
  });
}

// ── ① 자기 등록 (Dynamic Client Registration) ── 등록 내용(되돌아갈 주소)을 client_id 안에 서명해 넣는다
export async function register(request, env, nowMs) {
  let body; try { body = await request.json(); } catch { return oauthErr('invalid_client_metadata', '요청 본문(JSON)이 올바르지 않습니다'); }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5) return oauthErr('invalid_redirect_uri', 'redirect_uris가 필요합니다');
  const bad = uris.find(u => !redirectAllowed(u));
  if (bad) return oauthErr('invalid_redirect_uri', 'Claude 주소만 연결할 수 있습니다: ' + bad);
  const name = String(body.client_name || 'Claude').slice(0, 60);
  const clientId = await seal(env, 'client', { ru: uris, n: name }, 0, nowMs);
  return oauthJson({
    client_id: clientId, client_id_issued_at: Math.floor(nowMs / 1000), client_name: name, redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, 201);
}

async function checkClient(env, clientId, redirectUri, nowMs) {
  const c = await unseal(env, 'client', clientId, nowMs);
  if (!c) return '등록되지 않은 연결입니다(client_id). Claude에서 커넥터를 지우고 다시 추가하세요';
  if (!redirectUri || !c.ru.includes(redirectUri) || !redirectAllowed(redirectUri)) return '되돌아갈 주소가 등록과 다릅니다';
  return '';
}

// ── ② 로그인 화면 ──
export async function authorizePage(request, env, nowMs) {
  const q = new URL(request.url).searchParams;
  const clientId = q.get('client_id') || '', redirectUri = q.get('redirect_uri') || '';
  const err = await checkClient(env, clientId, redirectUri, nowMs);
  if (err) return htmlPage('연결할 수 없습니다', '<p class="err">' + esc(err) + '</p>', 400);
  const back = (e, d) => { const u = new URL(redirectUri); u.searchParams.set('error', e); u.searchParams.set('error_description', d); if (q.get('state')) u.searchParams.set('state', q.get('state')); return Response.redirect(u.toString(), 302); };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'code만 됩니다');
  if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE(S256)가 필요합니다');
  const req = await seal(env, 'req', { cid: clientId, ru: redirectUri, cc: q.get('code_challenge'), st: q.get('state') || '' }, REQ_TTL, nowMs);
  return htmlPage('Claude 연결', loginBody(req, env));
}

// ②-2 「연결 허용」 → 구글 로그인 확인 → Claude 주소로 일회용 코드를 들고 되돌아감
export async function approve(request, env, deps, nowMs) {
  const form = await request.formData().catch(() => null);
  if (!form) return htmlPage('연결할 수 없습니다', '<p class="err">요청이 올바르지 않습니다</p>', 400);
  const req = await unseal(env, 'req', form.get('req'), nowMs);
  if (!req) return htmlPage('연결할 수 없습니다', '<p class="err">로그인 화면이 만료되었습니다. Claude에서 「연결」을 다시 누르세요</p>', 400);
  let who;
  try {
    who = await verifyIdToken(form.get('idToken'), { projectId: env.FIREBASE_PROJECT, allowedEmails: allowedEmails(env), fetchFn: deps.fetchFn || fetch, nowMs });
  } catch (e) {
    return htmlPage('연결할 수 없습니다', '<p class="err">' + esc(e instanceof AuthError ? e.message : '로그인 확인 중 오류가 났습니다') + '</p>', 403);
  }
  const code = await seal(env, 'code', { cid: req.cid, ru: req.ru, cc: req.cc, em: who.email }, CODE_TTL, nowMs);
  const u = new URL(req.ru);
  u.searchParams.set('code', code);
  if (req.st) u.searchParams.set('state', req.st);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

// ── ③ 코드 → 출입증 / 갱신증 → 새 출입증 ──
async function pkceOk(verifier, challenge) {
  if (!verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const h = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(h) === challenge;
}
async function issueTokens(env, email, clientId, nowMs) {
  return {
    access_token: await seal(env, 'at', { em: email, cid: clientId.slice(-24) }, ACCESS_TTL, nowMs),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: await seal(env, 'rt', { em: email, cid: clientId }, REFRESH_TTL, nowMs),
    scope: 'todo',
  };
}
export async function token(request, env, nowMs) {
  let p;
  const ct = request.headers.get('content-type') || '';
  try { p = ct.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData()); }
  catch { return oauthErr('invalid_request', '요청 형식이 올바르지 않습니다'); }
  if (p.grant_type === 'authorization_code') {
    const c = await unseal(env, 'code', p.code, nowMs);
    if (!c) return oauthErr('invalid_grant', '코드가 올바르지 않거나 만료되었습니다');
    if (p.client_id && p.client_id !== c.cid) return oauthErr('invalid_grant', '다른 연결의 코드입니다');
    if (p.redirect_uri && p.redirect_uri !== c.ru) return oauthErr('invalid_grant', '되돌아갈 주소가 다릅니다');
    if (!(await pkceOk(p.code_verifier, c.cc))) return oauthErr('invalid_grant', 'PKCE 확인 실패');
    if (!allowedEmails(env).includes(c.em)) return oauthErr('invalid_grant', '허용되지 않은 계정입니다');
    return oauthJson(await issueTokens(env, c.em, c.cid, nowMs));
  }
  if (p.grant_type === 'refresh_token') {
    const r = await unseal(env, 'rt', p.refresh_token, nowMs);
    if (!r) return oauthErr('invalid_grant', '다시 로그인이 필요합니다');
    if (p.client_id && p.client_id !== r.cid) return oauthErr('invalid_grant', '다른 연결의 갱신증입니다');
    if (!allowedEmails(env).includes(r.em)) return oauthErr('invalid_grant', '허용되지 않은 계정입니다');
    return oauthJson(await issueTokens(env, r.em, r.cid, nowMs));
  }
  return oauthErr('unsupported_grant_type', 'authorization_code·refresh_token만 됩니다');
}

// /mcp 요청의 출입증 확인 → {email} 또는 null
export async function checkAccess(request, env, nowMs) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = await unseal(env, 'at', m[1].trim(), nowMs);
  if (!t || !allowedEmails(env).includes(t.em)) return null;
  return { email: t.em };
}

// ── 로그인 화면 HTML ── Firebase 구글 로그인(할 일 웹 화면과 같은 방식) → ID 토큰을 approve로 보냄
// ⚠️ Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 이 창구 주소(sg-todo.sgsolution.workers.dev)가 있어야 팝업 로그인이 된다
const FIREBASE_WEB = { apiKey: 'AIzaSyD7EoihxcX9zIbr1n4NiXK_qlWpv8p5gRk', authDomain: 'sg-crm-f9adc.firebaseapp.com', projectId: 'sg-crm-f9adc' };
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function loginBody(req, env) {
  const cfg = Object.assign({}, FIREBASE_WEB, { projectId: env.FIREBASE_PROJECT || FIREBASE_WEB.projectId });
  return `
<p>Claude가 <b>SG솔루션 할 일</b>을 읽고 쓰도록 연결합니다.<br>허용된 회사 구글 계정으로 로그인하세요.</p>
<button id="go" type="button">구글 계정으로 로그인</button>
<form id="f" method="post" action="/oauth/approve" style="display:none">
  <input type="hidden" name="req" value="${esc(req)}"><input type="hidden" name="idToken" id="tok">
  <p id="who"></p>
  <button type="submit">Claude 연결 허용</button>
</form>
<p id="msg" class="err"></p>
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
const auth = getAuth(initializeApp(${JSON.stringify(cfg)}));
const $ = (id) => document.getElementById(id);
$('go').onclick = async () => {
  $('msg').textContent = '';
  try {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    const r = await signInWithPopup(auth, p);
    $('tok').value = await r.user.getIdToken(true);
    $('who').textContent = r.user.email + ' 로 연결합니다.';
    $('go').style.display = 'none'; $('f').style.display = '';
  } catch (e) {
    $('msg').textContent = (e && e.code === 'auth/unauthorized-domain')
      ? 'Firebase 승인된 도메인에 ' + location.hostname + ' 을(를) 추가해야 합니다'
      : '로그인 실패: ' + (e && (e.code || e.message) || e);
  }
};
</script>`;
}
function htmlPage(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — SG솔루션 할 일</title>
<style>body{font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif;background:#f5f6f8;color:#1f2937;margin:0;padding:48px 16px}
.box{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 16px}button{font-size:16px;padding:12px 18px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;width:100%;margin-top:8px}
.err{color:#b91c1c}p{line-height:1.6}</style></head>
<body><div class="box"><h1>${esc(title)}</h1>${body}</div></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
}
