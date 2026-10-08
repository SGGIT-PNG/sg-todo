// ── Firestore REST 클라이언트 (서비스 계정) ──
// Cloudflare Worker에서는 Firebase Admin SDK를 쓸 수 없어 REST + 직접 서명한 토큰으로 접근한다.
// 서비스 계정 요청은 보안 규칙이 아니라 IAM 권한(Cloud Datastore 사용자)으로 통과한다.
//
// 인터페이스 (테스트용 가짜 DB도 같은 모양 — test/fakeDb.js)
//   get(path) → {id, path, data} | null
//   query(collection, filters:[[field, op, value]], {limit, orderBy:[field,'desc'|'asc']}) → [{id, path, data}]
//   list(collection) → 전체 문서
//   transaction(async tx => …)  tx.get / tx.query / tx.create(path, data) / tx.update(path, data) / tx.set(path, data) / tx.delete(path)

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

// ── 값 변환 (JS ↔ Firestore REST) ──
export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
export function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}
export function decodeValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
export function decodeFields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) out[k] = decodeValue(v);
  return out;
}

// ── 서비스 계정 → 접근 토큰 (1시간짜리, 만료 1분 전까지 재사용) ──
function b64url(input) {
  const u = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = ''; for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
let tokenCache = { token: '', exp: 0, email: '' };
export async function accessToken(saKeyJson, fetchFn = fetch, nowMs = Date.now()) {
  let sa = saKeyJson;
  if (typeof sa === 'string') {
    if (!sa.trim()) throw new Error('서비스 계정 키(GCP_SA_KEY)가 설정되지 않았습니다');
    try { sa = JSON.parse(sa); } catch { throw new Error('서비스 계정 키(GCP_SA_KEY)가 JSON 형식이 아닙니다 — 키 파일 내용 전체를 넣었는지 확인'); }
  }
  if (!sa || !sa.client_email || !sa.private_key) throw new Error('서비스 계정 키(GCP_SA_KEY)가 설정되지 않았습니다');
  if (tokenCache.token && tokenCache.email === sa.client_email && nowMs < tokenCache.exp - 60000) return tokenCache.token;
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(header + '.' + claim));
  const jwt = header + '.' + claim + '.' + b64url(sig);
  const r = await fetchFn(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('서비스 계정 토큰 발급 실패: ' + (j.error_description || j.error || r.status));
  tokenCache = { token: j.access_token, exp: nowMs + (j.expires_in || 3600) * 1000, email: sa.client_email };
  return j.access_token;
}

// ── REST 클라이언트 ──
export function restDb({ projectId, saKey, fetchFn = fetch }) {
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)`;
  const docsRoot = root + '/documents';
  const nameOf = (path) => `projects/${projectId}/databases/(default)/documents/${path}`;
  const toDoc = (d) => {
    const path = d.name.split('/documents/')[1];
    return { id: path.split('/').pop(), path, data: decodeFields(d.fields), updateTime: d.updateTime };
  };
  async function call(url, opt = {}) {
    const tok = await accessToken(saKey, fetchFn);
    const r = await fetchFn(url, Object.assign({}, opt, {
      headers: Object.assign({ authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, opt.headers || {}),
    }));
    if (r.status === 404) return { notFound: true };
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error('Firestore ' + r.status + ': ' + ((j.error && j.error.message) || ''));
      e.status = r.status; e.code = j.error && j.error.status; throw e;
    }
    return j;
  }
  function structuredQuery(collection, filters = [], opts = {}) {
    const ops = { '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', 'in': 'IN' };
    const f = filters.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: ops[op] || op, value: encodeValue(value) } }));
    const q = { from: [{ collectionId: collection }] };
    if (f.length === 1) q.where = f[0];
    else if (f.length > 1) q.where = { compositeFilter: { op: 'AND', filters: f } };
    if (opts.orderBy) q.orderBy = [{ field: { fieldPath: opts.orderBy[0] }, direction: opts.orderBy[1] === 'desc' ? 'DESCENDING' : 'ASCENDING' }];
    if (opts.limit) q.limit = opts.limit;
    return q;
  }
  async function get(path, transaction) {
    const j = await call(docsRoot + '/' + path + (transaction ? '?transaction=' + encodeURIComponent(transaction) : ''));
    return j.notFound ? null : toDoc(j);
  }
  async function query(collection, filters, opts, transaction) {
    const body = { structuredQuery: structuredQuery(collection, filters, opts || {}) };
    if (transaction) body.transaction = transaction;
    const rows = await call(docsRoot + ':runQuery', { method: 'POST', body: JSON.stringify(body) });
    return (rows || []).filter(x => x.document).map(x => toDoc(x.document));
  }
  async function list(collection) {
    const out = []; let tok = '';
    do {
      const j = await call(docsRoot + '/' + collection + '?pageSize=300' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''));
      (j.documents || []).forEach(d => out.push(toDoc(d)));
      tok = j.nextPageToken || '';
    } while (tok);
    return out;
  }
  // 트랜잭션: 읽은 문서가 그사이 바뀌면 Firestore가 ABORTED → 처음부터 다시(최대 4번)
  async function transaction(fn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { transaction: t } = await call(root + '/documents:beginTransaction', { method: 'POST', body: JSON.stringify({ options: { readWrite: {} } }) });
      const writes = [];
      const tx = {
        get: (path) => get(path, t),
        query: (c, f, o) => query(c, f, o, t),
        create: (path, data) => writes.push({ update: { name: nameOf(path), fields: encodeFields(data) }, currentDocument: { exists: false } }),
        set: (path, data) => writes.push({ update: { name: nameOf(path), fields: encodeFields(data) } }),
        update: (path, data) => writes.push({ update: { name: nameOf(path), fields: encodeFields(data) }, updateMask: { fieldPaths: Object.keys(data) }, currentDocument: { exists: true } }),
        delete: (path) => writes.push({ delete: nameOf(path) }),
      };
      let result;
      try { result = await fn(tx); }
      catch (e) { await call(root + '/documents:rollback', { method: 'POST', body: JSON.stringify({ transaction: t }) }).catch(() => {}); throw e; }
      try {
        if (writes.length) await call(root + '/documents:commit', { method: 'POST', body: JSON.stringify({ writes, transaction: t }) });
        else await call(root + '/documents:rollback', { method: 'POST', body: JSON.stringify({ transaction: t }) }).catch(() => {});
        return result;
      } catch (e) {
        if ((e.status === 409 || e.code === 'ABORTED') && attempt < 3) continue;
        throw e;
      }
    }
    throw new Error('저장이 계속 충돌합니다. 잠시 뒤 다시 시도하세요');
  }
  return { get: (p) => get(p), query: (c, f, o) => query(c, f, o), list, transaction };
}
