// ── Claude 채팅 도구 (MCP, Streamable HTTP) ── TODO_ARCHITECTURE.md §6
// claude.ai 「커스텀 커넥터」가 POST /mcp 로 JSON-RPC를 보낸다. 출입증 확인은 oauth.js, 할 일 규칙은 todos.js·core.js 그대로.
// 공용 Claude 계정이라 로그인으로는 누가 말했는지 모른다 → 쓰기 도구는 author(정석진·김학미·공동)를 필수로 받는다.

import {
  createTodo, updateTodo, completeTodo, deleteTodo, restoreTodo, listTodos, getTodo, changesSince, loadCompanies, NotFoundError,
} from './todos.js';
import { RuleError, AUTHORS, STATUSES, STATUS_LABEL, KINDS, kstToday, resolveCompany, COL_LABEL, CATEGORIES, CAT_LABEL } from './core.js';
import { AuthError } from './auth.js';
import { sendIsoUpdate, isoInboxStatus, describe as isoDescribe, ISO_STATUSES, ATYPES } from './iso.js';
import { listLeads, actLead, leadStats, syncMeta, resetLeads, leadLine, leadHistory, historyLine, presentLead, getLead, LEAD_ACTIONS, PRODUCTS, MAX_TRIES } from './leads.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'sg-todo', title: 'SG솔루션 할 일', version: '1.0.0' };
const INSTRUCTIONS = 'SG솔루션 할 일(T-번호) 도구. 할 일을 넣거나 바꾸기 전에 누가 하는지(정석진·김학미·공동)를 author로 넣는다 — '
  + '대화나 프로젝트 지침에 이름이 없으면 먼저 물어본다. 기업은 이름이나 사업자번호로 company에 넣고, 후보가 여럿이라고 하면 사용자에게 골라 달라고 한다. '
  + '번호는 T-0123 형식. 삭제는 휴지통(30일 안에 todo_restore로 되살림). 「안 하기로 한 일」은 삭제가 아니라 status=cancel. '
  + '할 일을 넣을 때 category(업무 분야)를 내용에 맞게 하나 고른다(정책자금·지원사업·벤처·연구소·특허·ISO·자금조달·확인서·재무·기타). 화면이 칸 안을 분야별로 묶는다. '
  + '할 일은 세 칸 — 진행 업무(시작일이 오늘이거나 지남)·예정 업무(시작일이 앞날)·완료 업무. 시작일 기본은 오늘이고, 「내일부터」「다음 주 월요일부터」처럼 말하면 start에 그 날짜를 넣는다. '
  + '「어제 끝냈어」처럼 끝낸 날을 말하면 todo_complete의 date에 넣는다. '
  + '📞 통화 = 「언제 몇 시에 누구에게 전화」(업무가 아님) → todo_add kind=call, start=통화 날짜(기본 오늘), time=시각(「오후 2시」「14:00」, 모르면 비움). 통화는 업무 칸이 아니라 통화 칸에 나온다. 통화했다고 하면 todo_complete. 목록은 todo_list view=call. '
  + '제안 업무 = 업체가 맡기지 않았지만 우리가 먼저 제안하려는 일(「하이퍼다인 ISO 인증 제안 예정」) → todo_add status=idea. 제안 업무의 날짜(start 시작일·due 종료일)는 사용자가 말했을 때만 넣고, 먼저 권하지 않는다. 날짜가 있어도 제안 칸에 머문다(시작일이 와도 옮기지 않고, 종료일이 지나도 빨간 표시 없음). 목록은 todo_list view=idea. '
  + '제안해서 실제로 맡게 되면 todo_update status=ing(지금부터) 또는 status=wait+start(그 날부터)로 옮긴다. '
  + '📣 광고 DB(D-0012) = Meta 광고(ISO심사·벤처인증·기업인증·ESG인증)로 들어온 신청자. 5분마다 자동으로 들어온다. 「오늘 전화할 DB」 → lead_list. '
  + '전화 결과는 lead_update: 안 받음 → noans(다음 영업일 재통화 자동, 3번째 부재면 연락 안 됨), 통화됨·상담 이어감 → talk(다시 걸 날은 date·time), 통화 약속만 → schedule, 미팅 잡힘 → meeting(date·time, 장소는 memo), 계약·진행하기로 → won(할 일이 하나 생김), 관심 없음·잘못된 번호 → lost(이유는 memo). 통화 내용은 memo에 꼭 남긴다(📒 통화 이력에 한 줄씩 쌓임 — 들어와서 미팅 잡힐 때까지). 「D-0022 이력」「그 업체 통화한 내용」 → lead_history. '
  + '광고별 성과는 lead_list view=stats. '
  + '🏅 ISO 인증·심사 소식(「태성 인증서 발급됐어 10/20」「사후1차 심사 내년 9/14~15로 확정」「심사 끝났어」「불합격」「45001 추가」) → iso_update로 iso-one 우편함에 보낸다(iso-one이 반영, 업무창은 iso-one 데이터를 직접 고치지 않음). 결과는 iso_update_status.';

// ── 도구 정의 ──
const AUTHOR = { type: 'string', enum: AUTHORS, description: '누가 하는지 — 정석진·김학미·공동 (모르면 사용자에게 먼저 물을 것)' };
const NOS = { description: '할 일 번호 (T-0123 또는 123). 여러 개면 배열', anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 12 }] };
const NO = { description: '할 일 번호 (T-0123 또는 123)', anyOf: [{ type: 'string' }, { type: 'integer' }] };
const DUE = { type: 'string', description: '(선택) 마감일 — 꼬리표로만 보임(칸은 시작일로 정함): 2026-10-20 · 10/20 · 10월 20일 · 오늘 · 내일 · 모레 · +7(7일 뒤). 빈 문자열이면 마감 없앰' };
const START = { type: 'string', description: '시작일 — 이 날이 오면 「진행 업무」로 옮겨 감. 기본 오늘. 「내일부터」=내일, 「다음 주 월요일부터」=그 날짜(YYYY-MM-DD로 계산해서). 형식: 2026-10-20 · 10/20 · 10월 20일 · 오늘 · 내일 · 모레 · +7' };
const REPEAT = {
  description: '반복 — 완료하면 다음 회차가 자동으로 생김. 없애려면 null',
  anyOf: [{ type: 'null' }, {
    type: 'object', required: ['every'],
    properties: {
      every: { type: 'string', enum: ['week', 'month', 'year'] }, n: { type: 'integer', minimum: 1, maximum: 12, description: '몇 주/달/년마다 (기본 1)' },
      day: { type: 'integer', description: 'week면 요일 0(일)~6(토), month·year면 날짜 1~31' }, month: { type: 'integer', minimum: 1, maximum: 12, description: 'year일 때 월' },
    },
  }],
};
const FIELDS = {
  text: { type: 'string', description: '할 일 내용 (500자 이하)' },
  company: { type: 'string', description: '기업 이름 또는 사업자번호(000-00-00000). 빈 문자열이면 기업 연결 해제' },
  start: START,
  time: { type: 'string', description: '📞 통화 시각(kind=call일 때) — 14:00 · 오후 2시 · 2시 반 · 오전 10시 30분. 넣으면 통화로 본다. 빈 문자열이면 시간 미정' },
  due: DUE,
  status: { type: 'string', enum: STATUSES, description: '보통은 넣지 않는다(칸은 시작일로 정해짐). idea = 제안 업무(아직 맡지 않은, 우리가 먼저 제안할 일 — 날짜와 상관없이 제안 칸) · waiting = 기다리는 중 꼬리표(누구를·무엇을은 waitingFor) · ing = 지금 시작(시작일이 앞날이면 오늘로 당김) · wait = 기다림 꼬리표 떼기·다시 열기 · done 완료 · cancel 취소(안 하기로 함)' },
  waitingFor: { type: 'string', description: '기다리는 대상 (예: 「고객 서류 회신」)' },
  kind: { type: 'string', enum: ['', ...KINDS], description: 'call 전화 · doc 서류 · apply 신청 · visit 방문 · chase 독촉 · internal 내부' },
  category: { type: 'string', enum: ['', ...CATEGORIES.map(c => c[0])], description: '업무 분야(중분류 — 화면이 이걸로 묶는다). 넣을 때 내용을 보고 하나 고른다: ' + CATEGORIES.map(([id, , nm]) => id + ' ' + nm).join(' · ') + '. 업체 일반 서류·견적·연락 등은 etc' },
  priority: { type: 'string', enum: ['', 'high'], description: 'high = 긴급(★, 진행 업무 맨 위)' },
  memo: { type: 'string', description: '메모 전체 (바꾸면 덮어씀 — 덧붙일 때는 memoAppend)' },
  repeat: REPEAT,
};
const pick = (keys) => Object.fromEntries(keys.map(k => [k, FIELDS[k]]));

export const TOOLS = [
  {
    name: 'todo_add', title: '할 일 추가',
    description: '할 일을 하나 추가하고 T-번호를 돌려준다. 제안 업무(우리가 먼저 제안할 일)는 status=idea — 시작일(start)·종료일(due)은 사용자가 말했을 때만 넣는다(없으면 비워 둠, 등록한 날로 채우지 않음). 기업 후보가 여럿이면 저장하지 않고 후보 목록을 돌려준다(사용자에게 고르게 한 뒤 사업자번호로 다시 호출).',
    inputSchema: { type: 'object', required: ['text', 'author'], properties: Object.assign({ author: AUTHOR }, pick(['text', 'company', 'start', 'time', 'due', 'status', 'waitingFor', 'kind', 'category', 'priority', 'memo', 'repeat']),
      { ref: { type: 'string', description: '(선택) 같은 내용을 두 번 넣지 않게 하는 출처 표시 — 같은 ref로 다시 부르면 새로 만들지 않음' } }) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'todo_complete', title: '할 일 완료',
    description: '할 일을 완료 업무로 옮긴다(여러 개 가능). 끝낸 날을 말하면 date에 넣는다(없으면 오늘). 이미 완료된 일에 date를 주면 완료일만 고친다. 반복 할 일이면 다음 회차 번호도 알려 준다.',
    inputSchema: { type: 'object', required: ['no', 'author'], properties: { no: NOS, author: AUTHOR,
      date: { type: 'string', description: '끝낸 날 — 오늘 · 어제 · 그제 · 3일 전 · 10/14 · 2026-10-14 (앞날은 안 됨). 기본 오늘' },
      note: { type: 'string', description: '완료 메모 (메모 끝에 덧붙음)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'todo_update', title: '할 일 수정',
    description: '할 일의 내용·시작일·마감·기업·메모 등을 바꾼다. 바꿀 항목만 넣는다. 미루기=start(시작일을 뒤로) · 당기기/지금 시작=start 오늘 · 기다림=status waiting(+waitingFor) · 기다림 끝=status ing · 다시 열기=status wait · 취소=status cancel · 마감=due · 제안을 맡게 됨=status ing(오늘부터) 또는 status wait+start(그 날부터) · 제안 접음=status cancel.',
    inputSchema: { type: 'object', required: ['no', 'author'], properties: Object.assign({ no: NO, author: AUTHOR }, pick(['text', 'start', 'time', 'status', 'due', 'waitingFor', 'company', 'kind', 'category', 'priority', 'memo', 'repeat']),
      { memoAppend: { type: 'string', description: '메모 끝에 날짜와 함께 한 줄 덧붙임' } }) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'todo_list', title: '할 일 목록',
    description: '할 일 목록 — 웹 화면과 같은 칸. call = 📞 통화(날짜·시각 순, 놓친 통화 포함), open = 진행 업무+예정 업무, idea = 제안 업무, all = open+제안(기업별로 볼 때), ing = 진행 업무(시작일 지남, 오늘 시작·+N일), todo = 예정 업무(시작 전, -N일), done = 완료 업무(최근 순), alert = 빨간 표시(마감 지남·14일 넘게 끈 일), waiting = 기다리는 중 꼬리표, week = 7일 안 마감, trash = 휴지통.',
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: ['open', 'call', 'ing', 'todo', 'idea', 'all', 'done', 'alert', 'waiting', 'week', 'trash'], description: '기본 open' },
      company: { type: 'string', description: '기업 이름(일부) 또는 사업자번호로 거르기' },
      category: { type: 'string', description: '분류로 거르기' },
      query: { type: 'string', description: '내용·메모·기업명 검색어' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '기본 30' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'todo_get', title: '할 일 자세히',
    description: '할 일 하나의 전체 내용과 변경 이력(누가 언제 무엇을)을 본다.',
    inputSchema: { type: 'object', required: ['no'], properties: { no: NO } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'todo_changes', title: '바뀐 것',
    description: '어느 때 이후로 할 일에 바뀐 것(추가·완료·수정·삭제, 누가·어떻게). 에이전트가 「지난번 본 뒤로 우리가 한 일」을 이어 볼 때.',
    inputSchema: { type: 'object', properties: {
      since: { type: 'string', description: '언제부터 — 2026-10-08 · 2026-10-08 14:00(한국 시간) · 3h(3시간 전) · 2d(2일 전). 기본 24시간 전' },
      company: { type: 'string', description: '기업 이름 또는 사업자번호로 거르기' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '기본 50' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'todo_delete', title: '할 일 삭제(휴지통)',
    description: '잘못 넣은 할 일을 휴지통으로 옮긴다(여러 개 가능). 30일 안에는 todo_restore로 되살릴 수 있다. 「안 하기로 한 일」은 삭제 말고 todo_update status=cancel.',
    inputSchema: { type: 'object', required: ['no', 'author'], properties: { no: NOS, author: AUTHOR, reason: { type: 'string', description: '지우는 이유' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'todo_restore', title: '휴지통에서 되살리기',
    description: '휴지통에 있는 할 일을 되살린다.',
    inputSchema: { type: 'object', required: ['no', 'author'], properties: { no: NO, author: AUTHOR } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'lead_list', title: '📣 광고 DB 목록',
    description: 'Meta 광고(ISO심사·벤처인증·기업인증·ESG인증)로 들어온 DB(신청자). today(기본) = 🆕 새 DB(아직 한 번도 안 건 곳) + 오늘 걸 곳(재통화·상담 약속) + 결과 안 남긴 지난 미팅 · new · call · meet(🤝 미팅 예정) · later(재통화가 앞날·상담 중) · open(안 끝난 것 전부) · closed(전환·거절·연락 안 됨) · all · stats(광고별 성과: 들어옴·통화 연결·전환). 🔴 = 들어온 지 24시간 넘게 전화 안 함 또는 약속한 날이 지남.',
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: ['today', 'new', 'call', 'meet', 'later', 'open', 'closed', 'all', 'stats'], description: '기본 today' },
      product: { type: 'string', enum: ['', ...PRODUCTS.map(p => p[0])], description: PRODUCTS.map(([k, n]) => k + ' ' + n).join(' · ') },
      query: { type: 'string', description: '이름·회사·전화번호·답변 검색' },
      days: { type: 'integer', description: 'stats 기간(기본 30일)' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '기본 50' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lead_update', title: '📣 광고 DB 전화 결과',
    description: '광고 DB 하나에 전화 결과를 기록한다. noans = 안 받음(다음 영업일 재통화가 저절로 잡힘 — 3번째면 「연락 안 됨」으로 닫힘) · talk = 통화됨, 상담 이어감(다시 걸 날은 date·time) · schedule = 통화 약속만 잡기(date 필수) · meeting = 🤝 미팅 잡힘(date 필수·time, 장소·내용은 memo — 통화 이력의 끝, 이후 결과는 won·lost) · won = 고객 전환(진행 업무 할 일이 하나 생김) · lost = 거절·무효(이유는 memo) · reopen = 닫힌 것 다시 열기 · memo = 메모만.',
    inputSchema: { type: 'object', required: ['no', 'action', 'author'], properties: {
      author: AUTHOR,
      no: { description: '광고 DB 번호 (D-0012 또는 12)', anyOf: [{ type: 'string' }, { type: 'integer' }] },
      action: { type: 'string', enum: LEAD_ACTIONS },
      date: { type: 'string', description: '다시 걸 날 — 내일 · 10/20 · +3 · 2026-10-20 (noans는 비우면 다음 영업일)' },
      time: { type: 'string', description: '시각 — 14:00 · 오후 2시 (선택)' },
      memo: { type: 'string', description: '통화 내용·거절 이유·미팅 장소 등 — 📒 통화 이력에 한 줄로 쌓인다' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'lead_history', title: '📒 광고 DB 통화 이력',
    description: '광고 DB 하나의 통화 이력 — 들어온 시각부터 부재·통화 내용·약속·🤝 미팅까지 시간순. 「D-0022 이력」「하윤수 통화한 내용」. 번호를 모르면 query로 이름·회사·전화번호를 찾는다.',
    inputSchema: { type: 'object', properties: {
      no: { description: '광고 DB 번호 (D-0012 또는 12)', anyOf: [{ type: 'string' }, { type: 'integer' }] },
      query: { type: 'string', description: '번호 대신 이름·회사·전화번호' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lead_sync', title: '📣 광고 DB 지금 가져오기',
    description: 'Meta에서 새 광고 DB를 지금 가져온다(평소엔 5분마다 자동). 결과: 새로 들어온 건수.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lead_reset', title: '📣 광고 DB 비우고 기준일부터 다시',
    description: '광고 DB를 전부 지우고(번호도 D-0001부터), 기준일 이후 신청만 다시 받는다. 사용자가 「광고 DB 비우고 ○일부터 다시」처럼 분명히 말했을 때만. confirm에 「초기화」를 넣어야 실행된다. 지운 것도 Meta에 90일 남아 있어 기준일을 앞당겨 다시 받을 수 있다.',
    inputSchema: { type: 'object', required: ['since', 'confirm', 'author'], properties: {
      author: AUTHOR,
      since: { type: 'string', description: '기준일 — 이 날 0시(한국) 이후 신청만 받는다: 2026-10-13 · 오늘 · 10/6' },
      confirm: { type: 'string', description: '실행 확인 — 「초기화」' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'iso_update', title: '🏅 ISO 소식 보내기(iso-one 우편함)',
    description: 'ISO 인증·심사 소식을 iso-one 우편함(iso_inbox)에 한 줄 쓴다. iso-one이 읽어 반영하고 결과는 CRM에 올라간다. 말한 것만 넣고 모르는 항목은 뺀다(빈 값 금지). 예) 「인증서 발급됐어 10/20」 → status=certified, issuedAt / 「사후1차 심사 내년 9/14~15로 확정」 → status=in_progress, atype=사후심사(1차), s2Date=2027-09-14~2027-09-15 / 「사후1차 심사 끝났어」 → atype, auditDone=true (인증서 발급 전이면 「인증서 발급 확인」 할 일이 생김) / 「불합격」 → status=failed / 「45001 추가」 → addCerts=45001. 취득일이 들어오면 그 기업의 「인증서 발급 확인」 할 일이 저절로 완료된다. 기업 후보가 여럿이면 저장하지 않고 후보를 돌려준다.',
    inputSchema: { type: 'object', required: ['company', 'author'], properties: {
      author: AUTHOR,
      company: { type: 'string', description: '기업 이름 또는 사업자번호' },
      status: { type: 'string', enum: ISO_STATUSES, description: 'certified = 심사 끝남·인증 발급/유지(사후심사 통과 포함) · in_progress = 심사 진행·일정 확정 · preparing = 준비 · failed = 불합격 · expired = 만료 · dropped = 중단' },
      atype: { type: 'string', enum: ATYPES, description: '이번 심사 유형' },
      s1Date: { type: 'string', description: '1단계 심사일 — 2027-09-14 또는 여러 날 2027-09-14~2027-09-15 (사후·갱신은 보통 s2Date만)' },
      s2Date: { type: 'string', description: '2단계(사후·갱신은 그 심사) 심사일 — 같은 형식' },
      auditDone: { type: 'boolean', description: 'true = 그 심사가 끝남(인증서는 아직일 수 있음)' },
      issuedAt: { type: 'string', description: '취득일(인증서 발급일) YYYY-MM-DD · 10/20' },
      expiresAt: { type: 'string', description: '만료일 — 말했을 때만(iso-one이 취득일+3년-1일로 계산)' },
      certs: { description: '규격 전체 목록(바꿀 때) — ["9001","14001"] 또는 「9001·14001·45001」', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      addCerts: { description: '규격 추가 — 「45001 추가」', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      removeCerts: { description: '규격 빼기', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      nextAction: { type: 'string', description: '다음 할 일 — 말했을 때만(iso-one이 계산)' },
      note: { type: 'string', description: '짧은 메모(개인정보 금지)' },
      ref: { type: 'string', description: '(선택) 관련 할 일 번호 T-0123' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'iso_update_status', title: '🏅 ISO 소식 반영 결과',
    description: '최근 iso_update로 보낸 줄의 iso-one 반영 상태(pending 대기 · applying 처리 중 · applied 반영 · rejected 못 함)와 결과 문장. 오래 대기면 안내를 붙인다.',
    inputSchema: { type: 'object', properties: { company: { type: 'string', description: '기업으로 거르기' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: '기본 10' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'company_find', title: '기업 찾기',
    description: 'SGCRM 고객사에서 기업을 찾는다(이름 일부 또는 사업자번호) → 이름·사업자번호. 할 일에 기업을 붙이기 전 확인용.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ── 보여 주는 글 ──
const catTxt = (c) => c ? ' {' + (CAT_LABEL[c] || c) + '}' : '';
const SHORT = { call: '📞 통화', ing: '진행', todo: '예정', idea: '💡 제안', done: '완료', trash: '휴지통' };
const md = (ds) => ds ? ds.slice(5).replace('-', '/') : '';
function line(r) {
  const tag = SHORT[r.col] + (r.reason ? ' · ' + r.reason : '') + (r.alert ? ' 🔴' : '');
  return r.label + ' [' + tag + '] ' + (r.companyName ? r.companyName + ' — ' : '') + r.text
    + (r.col === 'todo' ? ' (' + md(r.startDate) + ' 시작)' : '') + catTxt(r.category) + (r.createdBy ? ' · ' + r.createdBy : '');
}
const kstTime = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/');
const FIELD_LABEL = { callTime: '통화 시각', text: '내용', status: '상태', startDate: '시작일', dueDate: '마감', waitingFor: '기다리는 대상', bizno: '기업', companyName: '기업명', category: '분류', kind: '종류', priority: '중요', memo: '메모', repeat: '반복' };
function changeText(changes) {
  return Object.entries(changes || {}).filter(([k]) => k !== 'companyName').map(([k, [, to]]) => {
    if (k === 'status') return '상태 → ' + (STATUS_LABEL[to] || to);
    if (k === 'dueDate') return to ? '마감 → ' + to : '마감 없앰';
    if (k === 'memo') return '메모 수정';
    if (k === 'repeat') return to ? '반복 설정' : '반복 없앰';
    if (k === 'doneAt') return to ? '완료일 → ' + kstToday(to) : '완료일 지움';
    return (FIELD_LABEL[k] || k) + ' → ' + (to === null || to === '' ? '(비움)' : typeof to === 'object' ? JSON.stringify(to) : to);
  }).join(', ');
}
// 한 번에 12개까지 — 하나에 외부 호출 3~4번이라 Cloudflare 무료 요금제 한도(요청당 50번)를 넘지 않게 (10/13 20개 삭제 때 걸림)
const MAX_NOS = 12;
const nosAll = (v) => (Array.isArray(v) ? v : [v]).filter(x => x !== undefined && x !== null && String(x).trim() !== '');
const nosOf = (v) => nosAll(v).slice(0, MAX_NOS);
const nosRest = (v) => { const r = nosAll(v).slice(MAX_NOS); return r.length ? '\n⚠ 한 번에 ' + MAX_NOS + '개까지라 남은 ' + r.length + '개(' + r.join(', ') + ')는 다시 불러 주세요' : ''; };

// 「언제부터」 말 → ms (한국 시간)
export function parseSince(s, nowMs) {
  if (s === undefined || s === null || String(s).trim() === '') return nowMs - 24 * 3600000;
  const v = String(s).trim();
  let m = v.match(/^(\d{1,4})\s*(h|시간|d|일)$/i);
  if (m) return nowMs - Number(m[1]) * (/^(h|시간)$/i.test(m[2]) ? 3600000 : 86400000);
  m = v.match(/^(20\d{2}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return Date.parse(m[1] + 'T' + (m[2] ? m[2].padStart(2, '0') + ':' + m[3] : '00:00') + ':00+09:00');
  if (/^\d{12,}$/.test(v)) return Number(v);
  if (v === '오늘') return Date.parse(kstToday(nowMs) + 'T00:00:00+09:00');
  throw new RuleError('since를 알아볼 수 없습니다: 「' + v + '」 (예: 2026-10-08, 2026-10-08 14:00, 3h, 2d)');
}

// ── 도구 실행 ── 돌려주는 값: 사람이 읽을 글 (오류면 RuleError 등을 던짐)
export async function callTool(name, args, { db, email, nowMs, env = {}, fetchFn }) {
  args = args || {};
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new RuleError('없는 도구입니다: ' + name);
  const writes = !tool.annotations.readOnlyHint;
  let actor = null;
  if (writes && name !== 'lead_sync') {
    if (!AUTHORS.includes(args.author)) throw new RuleError('누가 하는지(author: 정석진·김학미·공동)를 넣어 주세요. 모르면 사용자에게 물어보세요');
    actor = { name: args.author, via: 'mcp', email };
  }
  const ctx = { db, actor, nowMs };
  const { author, ...rest } = args;

  switch (name) {
    case 'todo_add': {
      const { ref, ...fields } = rest;
      const r = await createTodo(ctx, fields, ref ? { source: 'chat', sourceRef: String(ref) } : { source: 'chat', checkRecentDup: true });
      const t = r.todo;
      const today = kstToday(nowMs);
      const where = t.kind === 'call' && t.status !== 'idea' ? ' · 📞 통화 ' + t.startDate + (t.callTime ? ' ' + t.callTime : ' (시간 미정)') : t.status === 'idea' ? ' · 💡 제안 업무' + (t.startDate ? '(시작 ' + t.startDate + ')' : '') : t.startDate > today ? ' · 예정 업무(' + t.startDate + ' 시작)' : ' · 진행 업무';
      const tail = (t.companyName ? ' · ' + t.companyName : '') + where + (t.dueDate ? (t.status === 'idea' ? ' · 종료 ' : ' · 마감 ') + t.dueDate : '') + (t.status === 'waiting' ? ' · 기다리는 중' : '') + (t.priority === 'high' ? ' · 긴급' : '');
      return r.created ? r.label + ' 저장됨' + tail + ' — ' + t.text : '이미 있는 할 일이라 새로 만들지 않았습니다: ' + r.label + tail + ' — ' + t.text;
    }
    case 'todo_complete': {
      const out = [];
      for (const no of nosOf(rest.no)) {
        try {
          const r = await completeTodo(ctx, no, rest.note, rest.date);
          const dd = r.todo.doneAt ? kstToday(r.todo.doneAt) : '';
          const what = !r.changed ? ' 이미 완료' : r.changes && !r.changes.status && r.changes.doneAt ? ' 완료일 고침' : ' 완료';
          out.push(r.label + what + (dd ? '(' + dd + ')' : '') + ' — ' + r.todo.text + (r.next ? ' (반복: 다음 회차 ' + r.next.label + ', ' + r.next.startDate + ' 시작 · 마감 ' + r.next.dueDate + ')' : ''));
        } catch (e) { out.push(String(no) + ' 실패: ' + e.message); }
      }
      if (!out.length) throw new RuleError('완료할 번호(no)를 넣어 주세요');
      return out.join('\n') + nosRest(rest.no);
    }
    case 'todo_update': {
      const { no, ...patch } = rest;
      if (!Object.keys(patch).length) throw new RuleError('바꿀 항목을 하나 이상 넣어 주세요');
      const r = await updateTodo(ctx, no, patch);
      if (!r.changed) return r.label + ' 바뀐 것 없음 — ' + r.todo.text;
      return r.label + ' 수정됨: ' + changeText(r.changes) + ' — ' + r.todo.text + (r.next ? '\n반복: 다음 회차 ' + r.next.label + ' (' + r.next.startDate + ' 시작 · 마감 ' + r.next.dueDate + ')' : '');
    }
    case 'todo_list': {
      const r = await listTodos(db, { view: rest.view || 'open', company: rest.company || '', category: rest.category || '', query: rest.query || '', limit: Number(rest.limit) || 30 }, nowMs);
      const names = { call: '📞 통화', open: '진행 업무 + 예정 업무', all: '진행 + 예정 + 제안 업무', idea: COL_LABEL.idea, ing: COL_LABEL.ing, todo: COL_LABEL.todo, done: COL_LABEL.done + '(최근 순)', alert: '빨간 표시(마감 지남·오래 끈 일)', waiting: '기다리는 중', week: '7일 안 마감', trash: '휴지통' };
      const head = names[r.view] + ' ' + r.total + '건' + (r.items.length < r.total ? ' (앞 ' + r.items.length + '건)' : '') + ' · 오늘 ' + kstToday(nowMs);
      return r.items.length ? head + '\n' + r.items.map(line).join('\n') : head + '\n(없음)';
    }
    case 'todo_get': {
      const t = await getTodo(db, rest.no, nowMs);
      const rows = [
        line(t),
        '칸: ' + (COL_LABEL[t.col] || t.col) + (t.startDate ? ' · 시작 ' + t.startDate : '') + (t.dueDate ? (t.col === 'idea' ? ' · 종료 ' : ' · 마감 ') + t.dueDate : '') + (t.doneDate ? ' · 완료 ' + t.doneDate : '')
          + (t.status === 'waiting' ? ' · 기다리는 중' + (t.waitingFor ? '(' + t.waitingFor + ')' : '') : '') + (t.status === 'cancel' ? ' · 취소' : '') + (t.deletedAt ? ' · 휴지통에 있음' : ''),
        t.bizno ? '기업: ' + t.companyName + ' (' + t.bizno + ')' : '',
        t.category || t.kind ? '분류: ' + [t.category, t.kind].filter(Boolean).join(' · ') : '',
        t.repeat ? '반복: ' + JSON.stringify(t.repeat) : '',
        t.memo ? '메모:\n' + t.memo : '',
        t.history.length ? '이력:\n' + t.history.map(h => '  ' + kstTime(h.at) + ' ' + h.summary + (h.via === 'mcp' ? ' (Claude)' : '')).join('\n') : '',
      ];
      return rows.filter(Boolean).join('\n');
    }
    case 'todo_changes': {
      const since = parseSince(rest.since, nowMs);
      let bizno = '';
      if (rest.company) {
        const c = resolveCompany(rest.company, await loadCompanies(db));
        if (!c.company) throw new RuleError(c.candidates ? '기업이 여러 곳입니다: ' + c.candidates.map(x => x.name + '(' + x.id + ')').join(', ') : '기업을 찾지 못했습니다: ' + rest.company);
        bizno = c.company.id;
      }
      const r = await changesSince(db, { since, company: bizno, limit: Number(rest.limit) || 50 }, nowMs);
      const head = kstTime(since) + ' 이후 바뀐 것 ' + r.total + '건';
      return r.items.length ? head + '\n' + r.items.map(i => kstTime(i.at) + ' ' + i.summary + (i.via === 'mcp' ? ' (Claude)' : '')).join('\n') : head + '\n(없음)';
    }
    case 'todo_delete': {
      const out = [];
      for (const no of nosOf(rest.no)) {
        try {
          const r = await deleteTodo(ctx, no, rest.reason);
          out.push(r.changed ? r.label + ' 휴지통으로 옮김 (' + r.purgeAfter + '까지 todo_restore로 되살릴 수 있음)' : r.label + ' 이미 휴지통에 있음');
        } catch (e) { out.push(String(no) + ' 실패: ' + e.message); }
      }
      if (!out.length) throw new RuleError('지울 번호(no)를 넣어 주세요');
      return out.join('\n') + nosRest(rest.no);
    }
    case 'todo_restore': {
      const r = await restoreTodo(ctx, rest.no);
      return r.changed ? r.label + ' 되살림' : r.label + ' 휴지통에 없음 (이미 살아 있음)';
    }
    case 'lead_list': {
      if (rest.view === 'stats') {
        const st = await leadStats(db, { days: Number(rest.days) || 30 }, nowMs);
        const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '-';
        return '📣 광고별 성과 (최근 ' + (Number(rest.days) || 30) + '일 들어온 DB)\n' + st.map(x => x.label + ': 들어옴 ' + x.received + ' · 통화 연결 ' + x.reached + '(' + pct(x.reached, x.received) + ') · 고객 전환 ' + x.won + '(' + pct(x.won, x.received) + ') · 거절 ' + x.lost + ' · 연락 안 됨 ' + x.unreach + ' · 진행 중 ' + x.waiting).join('\n');
      }
      const r = await listLeads(db, { view: rest.view || 'today', product: rest.product || '', query: rest.query || '', limit: Number(rest.limit) || 50 }, nowMs);
      const names = { today: '오늘 전화할 DB(새 DB + 재통화·약속)', new: '🆕 새 DB', call: '오늘 걸 곳', meet: '🤝 미팅 예정', later: '재통화 앞날·상담 중', open: '진행 중 전부', closed: '끝난 DB', all: '전체' };
      const head = '📣 ' + names[r.view] + ' ' + r.total + '건 · 새 DB ' + r.counts.new + ' · 오늘 걸 곳 ' + r.counts.call + (r.counts.meet ? ' · 🤝 미팅 ' + r.counts.meet : '') + (r.counts.alert ? ' · 🔴 ' + r.counts.alert : '') + ' · 부재 ' + MAX_TRIES + '번이면 연락 안 됨';
      return r.leads.length ? head + '\n' + r.leads.map(leadLine).join('\n') : head + '\n(없음)';
    }
    case 'lead_history': {
      let l;
      if (rest.no !== undefined && rest.no !== '') l = await getLead(db, rest.no);
      else {
        const q = String(rest.query || '').trim();
        if (!q) throw new RuleError('no(광고 DB 번호) 또는 query(이름·회사·전화)가 필요합니다');
        const r = await listLeads(db, { view: 'all', query: q, limit: 10 }, nowMs);
        if (!r.leads.length) return '「' + q + '」에 맞는 광고 DB가 없습니다';
        if (r.leads.length > 1) return '여러 건입니다 — 번호로 다시 물어봐 주세요:\n' + r.leads.map(leadLine).join('\n');
        l = await getLead(db, r.leads[0].label);
      }
      const p = presentLead(l, nowMs);
      const hist = leadHistory(l);
      return '📒 ' + leadLine(p) + '\n지금: ' + p.reason + '\n'
        + hist.map(historyLine).join('\n') + (hist.length === 1 ? '\n(아직 통화 기록 없음)' : '');
    }
    case 'lead_update': {
      const r = await actLead(ctx, rest.no, rest.action, rest);
      return r.label + ' ' + (r.lead.name || '') + ' — ' + r.what + ' → 지금: ' + r.lead.reason + (r.todo ? '\n할 일 ' + r.todo + ' 만들어짐(진행 업무)' : '');
    }
    case 'iso_update': {
      const r = await sendIsoUpdate(ctx, rest);
      if (r.same) return '이미 iso-one에 반영된 같은 소식입니다 — ' + r.doc.companyName + ' · ' + isoDescribe(r.doc) + (r.prevResult ? '\n결과: ' + r.prevResult : '');
      const t = r.todo;
      return '🏅 iso-one 우편함에 보냄 — ' + r.doc.companyName + ' · ' + isoDescribe(r.doc) + '\niso-one이 열려 있으면 곧 반영됩니다(결과는 iso_update_status).'
        + (t.made ? '\n할 일 ' + t.made + ' 「인증서 발급 확인」 만들어짐' : t.exists ? '\n할 일 ' + t.exists + ' 「인증서 발급 확인」 이미 있음' : '')
        + (t.done ? '\n할 일 ' + t.done + ' 「인증서 발급 확인」 완료 처리' : '');
    }
    case 'iso_update_status': {
      const rows = await isoInboxStatus(db, { company: rest.company || '', limit: Number(rest.limit) || 10 }, nowMs);
      if (!rows.length) return '보낸 ISO 소식이 없습니다';
      const ST = { pending: '⏳ 대기', applying: '🔄 처리 중', applied: '✅ 반영', rejected: '⚠ 못 함' };
      return rows.map(d => kstTime(d.createdAt) + ' ' + (ST[d.state] || d.state) + ' · ' + d.companyName + ' · ' + isoDescribe(d) + (d.by ? ' — ' + d.by : '')
        + (d.result ? '\n   결과: ' + d.result : '') + (d.hint ? '\n   ' + d.hint : '')).join('\n');
    }
    case 'lead_reset': {
      if (String(rest.confirm || '').trim() !== '초기화') throw new RuleError('지우기 전 확인: confirm에 「초기화」를 넣어 주세요 (사용자에게 먼저 확인)');
      const r = await resetLeads(ctx, rest.since);
      return '📣 광고 DB ' + r.removed + '건 지움 · 번호는 D-0001부터 · ' + r.since + ' 이후 신청만 받습니다. 바로 받으려면 lead_sync';
    }
    case 'lead_sync': {
      const r = await syncMeta(env, db, { nowMs, fetchFn, actor: { name: AUTHORS.includes(args.author) ? args.author : '자동', via: 'mcp', email } });
      if (!r.ok) return '가져오지 못했습니다: ' + r.error;
      return 'Meta 확인 ' + r.fetched + '건 · 새로 들어옴 ' + r.created.length + '건' + (r.created.length ? ' (' + r.created.map(c => c.label + ' ' + (c.name || '')).join(', ') + ')' : '') + (r.forms.length ? '\n양식: ' + r.forms.join(' · ') : '');
    }
    case 'company_find': {
      const q = String(rest.query || '').trim();
      if (!q) throw new RuleError('찾을 기업 이름이나 사업자번호를 넣어 주세요');
      const r = resolveCompany(q, await loadCompanies(db));
      if (r.company) return r.company.name + ' · ' + r.company.id;
      if (r.candidates) return '후보 ' + r.candidates.length + '곳:\n' + r.candidates.map(c => c.name + ' · ' + c.id).join('\n');
      return '찾지 못했습니다: ' + q;
    }
  }
  throw new RuleError('없는 도구입니다: ' + name);
}

// ── JSON-RPC 처리 ──
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleRpc(msg, deps) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, '올바른 요청이 아닙니다');
  const isNotice = msg.id === undefined || msg.id === null;
  const { id, method, params = {} } = msg;
  if (isNotice) return null;   // notifications/initialized 등 — 답하지 않음
  switch (method) {
    case 'initialize': {
      const want = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const text = await callTool(params.name, params.arguments, deps());
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        if (e instanceof RuleError || e instanceof NotFoundError || e instanceof AuthError) {
          let text = e.message;
          if (e.extra && e.extra.candidates) text += '\n' + e.extra.candidates.map(c => '- ' + c.name + ' · ' + c.bizno).join('\n') + '\n(사용자에게 고르게 한 뒤 company에 사업자번호를 넣어 다시 호출)';
          return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
        }
        console.error('[sg-todo mcp] 도구 오류', params.name, e && e.stack || e);
        return rpcResult(id, { content: [{ type: 'text', text: '처리 중 오류가 났습니다: ' + String(e && e.message || e).slice(0, 200) }], isError: true });
      }
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default: return rpcError(id, -32601, '없는 기능입니다: ' + method);
  }
}

// POST /mcp 본문 하나(또는 배열) → 응답
export async function handleMcpPost(request, deps) {
  let body;
  try { body = await request.json(); } catch { return mcpJson(rpcError(null, -32700, 'JSON을 읽을 수 없습니다'), 400); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) { const r = await handleRpc(m, deps); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202, headers: { 'access-control-allow-origin': '*' } });
  return mcpJson(Array.isArray(body) ? out : out[0], 200);
}
function mcpJson(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
