// ── 📎 접수 첨부 내려주기 (메인이노 프로그램 전용) ──
// 업체가 접수 폼에 올린 서류는 `apply-biz.js`가 공유 드라이브에 넣고 우편함에는
// **주소만** 싣는다(규격 §5). 메인이노 프로그램은 그 파일을 **파일로** 가져야 한다 —
// 증빙 점검이 「파일이 손에 있다」를 세고, 현장평가 서류철이 집어서 묶기 때문이다.
//
// 담당자 PC의 구글 자격으로 받는 길도 있었지만 **사람 계정에 매달려 자꾸 멈췄다**
// (자격 만료 → 2단계 인증 → 앱 차단, 하루에 셋). 창구의 서비스 계정은 그 셋이
// 전부 없고, **이미 이 폴더에 쓰고 있다** — 읽기만 더하는 것이다.
//
//   GET  /api/drive-get/config   {ok, files}
//   POST /api/drive-get          {fileId, meta?:true}  →  meta면 {ok,name,size}, 아니면 파일 바이트
//
// **두 길을 로그인 없이 통과하는 목록에 넣어야 한다** — `/api/apply-biz`와 같은 자리다.
// 대신 **공용 열쇠(DRIVE_GET_TOKEN)로 막는다.** 열쇠가 설정돼 있지 않으면 아예 거절한다
// (열어 둔 채로 돌아가지 않게).
//
// **접수 폴더 밑의 파일만 내준다.** 열쇠가 새더라도 그 밖의 드라이브는 지나갈 수 없다 —
// 담당자 PC 자격으로는 이런 제한을 걸 수 없고, 그것이 이 길을 고른 이유의 하나다.
//
// **이 파일은 메인이노 저장소(deploy/worker/)에서 관리하고 창구에 복사해 온다.**

import { accessToken } from './firestore.js';

export const TOKEN_ENV = 'DRIVE_GET_TOKEN';
const FOLDER_ENV = 'APPLY_DRIVE_FOLDER_SG';
// **읽기 권한만 받는다** — 내주는 것이 일의 전부다 (apply-biz는 쓰기가 필요해 전체를 받는다)
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3/files';
// 공유 드라이브에 있는 파일이라 이 깃발이 없으면 못 찾는다 (올릴 때도 같은 깃발이다)
const SHARED = 'supportsAllDrives=true';
// 프로그램이 받는 한도와 같다 (services.evidence_service.MAX_UPLOAD_BYTES)
const MAX_BYTES = 20 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export function driveGetConfig(env) {
  return { ok: true, files: !!(env[FOLDER_ENV] && env.GCP_SA_KEY && env[TOKEN_ENV]) };
}

/** 길이와 내용이 모두 같은지 **시간이 같게** 본다 — 틀린 자리를 알려 주지 않는다. */
function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const got = request.headers.get('authorization') || '';
  return got.startsWith('Bearer ') ? got.slice(7).trim() : '';
}

function fail(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status, headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

async function meta(token, fileId, fetchFn) {
  const r = await fetchFn(`${API}/${fileId}?${SHARED}&fields=name,size,mimeType,parents`, {
    headers: { authorization: 'Bearer ' + token },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = (j.error && j.error.message) || r.status;
    throw Object.assign(new Error('드라이브에서 찾지 못했습니다: ' + why), {
      status: r.status === 404 ? 404 : 502,
    });
  }
  return j;
}

/**
 * **접수 폴더 밑인지 본다.** 첨부는 `<APPLY_DRIVE_FOLDER_SG>/<접수번호_상호>/파일`로
 * 올라가므로, 파일의 부모가 접수처이거나 그 부모가 접수처여야 한다.
 * 더 깊이 올라가지 않는다 — 올리는 쪽이 그보다 깊이 만들지 않는다.
 */
async function insideApplyFolder(token, info, root, fileId, fetchFn) {
  const parents = Array.isArray(info.parents) ? info.parents : [];
  if (parents.includes(root)) return true;
  for (const parent of parents) {
    const up = await meta(token, parent, fetchFn).catch(() => null);
    if (up && Array.isArray(up.parents) && up.parents.includes(root)) return true;
  }
  return false;
}

/** deps: {fetchFn, nowMs} — apply-biz와 같은 모양 */
export async function handleDriveGet(env, request, deps = {}) {
  const { fetchFn = fetch, nowMs = Date.now() } = deps;

  // 열쇠가 없으면 **열어 둔 채로 돌지 않는다**
  if (!env[TOKEN_ENV]) return fail(503, '첨부 내려주기가 설정되지 않았습니다');
  if (!env.GCP_SA_KEY || !env[FOLDER_ENV]) return fail(503, '드라이브 설정이 없습니다');
  if (!sameSecret(bearer(request), env[TOKEN_ENV])) return fail(401, '열쇠가 맞지 않습니다');

  let body = {};
  try {
    body = await request.json();
  } catch {
    return fail(400, 'JSON 본문이 필요합니다');
  }
  const fileId = String(body.fileId || '');
  if (!FILE_ID.test(fileId)) return fail(400, '파일 ID가 올바르지 않습니다');

  let token, info;
  try {
    token = await accessToken(env.GCP_SA_KEY, fetchFn, nowMs, SCOPE);
    info = await meta(token, fileId, fetchFn);
  } catch (e) {
    return fail(e.status || 502, String(e.message || e));
  }

  if (!(await insideApplyFolder(token, info, env[FOLDER_ENV], fileId, fetchFn))) {
    // **무엇을 보고 막았는지 함께 말한다** — 접수 폴더를 옮기거나 설정이 어긋났을 때
    // 이 말이 없으면 「막혔다」만 알 수 있고 어디가 틀렸는지 알 수 없다.
    // 열쇠를 가진 쪽에만 가고, 그 쪽은 이미 파일을 받을 수 있는 사람이라 새로 새는 것이 없다.
    return new Response(JSON.stringify({
      ok: false, error: '접수 폴더의 파일이 아닙니다',
      root: env[FOLDER_ENV], parents: info.parents || null,
    }), { status: 403, headers: { 'content-type': 'application/json; charset=UTF-8' } });
  }

  const size = info.size === undefined ? null : Number(info.size);
  if (body.meta === true) {
    return new Response(JSON.stringify({ ok: true, name: info.name || fileId, size }), {
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
  }
  if (size !== null && size > MAX_BYTES) {
    return fail(413, `${size.toLocaleString()}바이트로 제한(${MAX_BYTES.toLocaleString()})을 넘습니다`);
  }

  const r = await fetchFn(`${API}/${fileId}?${SHARED}&alt=media`, {
    headers: { authorization: 'Bearer ' + token },
  });
  if (!r.ok) return fail(502, '드라이브에서 받지 못했습니다: ' + r.status);
  return new Response(r.body, {
    headers: { 'content-type': info.mimeType || 'application/octet-stream' },
  });
}
