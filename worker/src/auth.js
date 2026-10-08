// ── 로그인 확인 ──
// ① 할 일 웹 화면: Firebase 로그인(구글) ID 토큰을 Authorization: Bearer 로 받는다 → 서명·만료·프로젝트·허용 메일 확인
// ② 드라이브 스크립트·비서: X-Api-Key 헤더(INGEST_KEY 비밀값)
// 「누가 했나」(정석진·김학미·공동)는 공용 계정이라 토큰으로 알 수 없어 X-SG-User 헤더로 받는다 (TODO_ARCHITECTURE.md §4-0)

import { AUTHORS } from './core.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: null, exp: 0 };

export class AuthError extends Error {
  constructor(msg, status = 401) { super(msg); this.name = 'AuthError'; this.status = status; }
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function getJwks(fetchFn, nowMs) {
  if (jwksCache.keys && nowMs < jwksCache.exp) return jwksCache.keys;
  const r = await fetchFn(JWKS_URL);
  if (!r.ok) throw new AuthError('로그인 확인용 공개키를 받지 못했습니다', 503);
  const j = await r.json();
  const m = (r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  jwksCache = { keys: j.keys || [], exp: nowMs + (m ? Number(m[1]) : 3600) * 1000 };
  return jwksCache.keys;
}
export function _resetJwksCache() { jwksCache = { keys: null, exp: 0 }; }

// Firebase ID 토큰 확인 → {email, uid}
export async function verifyIdToken(token, { projectId, allowedEmails, fetchFn = fetch, nowMs = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('로그인이 필요합니다');
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { throw new AuthError('로그인 정보가 올바르지 않습니다'); }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('로그인 정보가 올바르지 않습니다');
  const jwk = (await getJwks(fetchFn, nowMs)).find(k => k.kid === header.kid);
  if (!jwk) { _resetJwksCache(); throw new AuthError('로그인이 만료되었습니다. 다시 로그인하세요'); }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new AuthError('로그인 정보가 올바르지 않습니다');
  const now = Math.floor(nowMs / 1000);
  if (payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId)
    throw new AuthError('다른 프로젝트의 로그인입니다');
  if (!payload.exp || payload.exp < now - 30) throw new AuthError('로그인이 만료되었습니다. 다시 로그인하세요');
  if (payload.iat && payload.iat > now + 300) throw new AuthError('로그인 시각이 올바르지 않습니다');
  if (!payload.sub) throw new AuthError('로그인 정보가 올바르지 않습니다');
  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified || !allowedEmails.includes(email)) throw new AuthError('이 계정은 사용할 수 없습니다: ' + email, 403);
  return { email, uid: payload.sub };
}

// 요청 → 쓰는 사람 {name, via, email}
export async function authenticate(request, env, { fetchFn = fetch, nowMs = Date.now() } = {}) {
  const allowedEmails = String(env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const apiKey = request.headers.get('x-api-key');
  let ident;
  if (apiKey) {
    if (!env.INGEST_KEY || !timingSafeEqual(apiKey, env.INGEST_KEY)) throw new AuthError('키가 올바르지 않습니다', 403);
    ident = { email: 'script', via: 'script' };
  } else {
    const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m) throw new AuthError('로그인이 필요합니다');
    const v = await verifyIdToken(m[1], { projectId: env.FIREBASE_PROJECT, allowedEmails, fetchFn, nowMs });
    ident = { email: v.email, via: 'web' };
  }
  const raw = decodeURIComponent(request.headers.get('x-sg-user') || '').trim();
  return Object.assign(ident, { name: raw });
}
// 쓰기에는 사람 이름이 꼭 있어야 한다 (빈 작성자 금지)
export function requireAuthor(actor, allowExtra = []) {
  if (!AUTHORS.includes(actor.name) && !allowExtra.includes(actor.name))
    throw new AuthError('누가 하는지(정석진·김학미·공동)를 골라 주세요', 400);
  return actor;
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
