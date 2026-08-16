/**
 * user_records 三道鎖與 constraint 的實測驗證：`npm run l4:verify`
 *
 * 重點在兩件事：
 *   1. 人的紀錄改不掉、刪不掉 —— G4 的「人工執行一致率」必須誠實
 *   2. 買賣紀錄缺欄位一律拒絕 —— 不知道股數價格的「買進」記了也沒用
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

/** 探針一律用這個前綴，下游查詢過濾即可 */
const PROBE_PREFIX = '__probe_';

interface ApiResponse {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly text: string;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(method === 'GET' ? {} : { Prefer: 'return=minimal' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    code = typeof parsed.code === 'string' ? parsed.code : null;
    message = typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    /* 非 JSON 回應 */
  }
  return { status: res.status, code, message, text: raw.slice(0, 200) };
}

const results: { name: string; passed: boolean; detail: string }[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

async function expectRejected(
  name: string,
  method: string,
  path: string,
  body: unknown,
  expectCode: string,
  messageContains?: string,
): Promise<void> {
  const res = await call(method, path, body);
  const rejected = res.status >= 400;
  const codeOk = res.code === expectCode;
  const msgOk = messageContains === undefined || (res.message ?? res.text).includes(messageContains);
  record(
    name,
    rejected && codeOk && msgOk,
    rejected
      ? `HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}` +
          (codeOk && msgOk ? '' : `　（預期 code=${expectCode}）`)
      : `⚠️ 沒有被擋下：HTTP ${res.status}`,
  );
}

async function expectAccepted(name: string, body: unknown): Promise<void> {
  const res = await call('POST', 'user_records', body);
  record(
    name,
    res.status === 201,
    res.status === 201
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
}

/** 每次執行用不同的訊息 ID，避免撞唯一索引造成假失敗 */
const RUN_TAG = `${PROBE_PREFIX}${Date.now()}`;
let seq = 0;
function msgId(): string {
  seq += 1;
  return `${RUN_TAG}_${seq}`;
}

function probeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recorded_at: new Date().toISOString(),
    data_as_of: '2026-08-14',
    source: 'line',
    line_message_id: msgId(),
    action: 'watch',
    code: '2330',
    shares: null,
    price: null,
    note: '守門驗證探針',
    raw_text: '/rec 觀望 2330 守門驗證探針',
    ...overrides,
  };
}

console.log('=== user_records append-only 驗證 ===\n');
console.log(`探針 line_message_id 前綴 = ${RUN_TAG}\n`);

await expectAccepted('對照組：正常的觀望紀錄寫得進去', [probeRow()]);
if (results[0]?.passed !== true) {
  console.log('✗ 探針寫不進去，後續測試無意義。先確認 0009 migration 已執行。');
  process.exit(1);
}

// ── 鎖二 ────────────────────────────────────────────────────────────────────
await expectRejected(
  '事後改寫自己的紀錄（UPDATE）',
  'PATCH',
  `user_records?line_message_id=like.${RUN_TAG}*`,
  { note: '其實我早就說要買了' },
  '42501',
  'permission denied',
);

await expectRejected(
  '刪掉不想承認的紀錄（DELETE）',
  'DELETE',
  `user_records?line_message_id=like.${RUN_TAG}*`,
  undefined,
  '42501',
  'permission denied',
);

// ── 欄位級權限 ──────────────────────────────────────────────────────────────
await expectRejected(
  '偽造 inserted_at',
  'POST',
  'user_records',
  [probeRow({ inserted_at: '2020-01-01T00:00:00Z' })],
  '42501',
);
await expectAccepted('　└ 對照組：同一列拿掉 inserted_at 就寫得進去', [probeRow()]);

// ── constraint：買賣必須有股數與價格 ────────────────────────────────────────
await expectAccepted('對照組：完整的買進紀錄', [
  probeRow({ action: 'buy', shares: 24, price: 580.5, raw_text: '/rec 買 2330 24 580.5' }),
]);

await expectRejected(
  '買進但沒有股數（不知道買了多少，記了也沒用）',
  'POST',
  'user_records',
  [probeRow({ action: 'buy', shares: null, price: 580.5, raw_text: 'x' })],
  '23514',
  'user_records_trade_fields_check',
);

await expectRejected(
  '買進但沒有價格',
  'POST',
  'user_records',
  [probeRow({ action: 'buy', shares: 24, price: null, raw_text: 'x' })],
  '23514',
  'user_records_trade_fields_check',
);

await expectRejected(
  '買進股數為 0',
  'POST',
  'user_records',
  [probeRow({ action: 'buy', shares: 0, price: 580, raw_text: 'x' })],
  '23514',
  'user_records_trade_fields_check',
);

await expectRejected(
  '觀望但沒指明哪一檔',
  'POST',
  'user_records',
  [probeRow({ action: 'watch', code: null, raw_text: 'x' })],
  '23514',
  'user_records_target_check',
);

await expectRejected(
  '未定義的動作',
  'POST',
  'user_records',
  [probeRow({ action: 'all_in', raw_text: 'x' })],
  '23514',
  'user_records_action_check',
);

await expectRejected(
  '沒有保留原話（raw_text 空白）',
  'POST',
  'user_records',
  [probeRow({ raw_text: '   ' })],
  '23514',
  'user_records_raw_text_not_blank',
);

// ── 唯一索引：webhook 重送不會記兩次 ────────────────────────────────────────
const duplicateId = msgId();
await expectAccepted('對照組：先寫入一筆', [probeRow({ line_message_id: duplicateId })]);
await expectRejected(
  '同一則 LINE 訊息重送（webhook 會重送，不該記兩次）',
  'POST',
  'user_records',
  [probeRow({ line_message_id: duplicateId, note: '重送' })],
  '23505',
  'user_records_line_message_uniq',
);

// ── 匿名身分 ────────────────────────────────────────────────────────────────
if (config.anonKey !== null) {
  const res = await fetch(`${config.url}/rest/v1/user_records`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([probeRow()]),
    signal: AbortSignal.timeout(30_000),
  });
  record(
    '匿名金鑰寫入（鎖一 RLS）',
    res.status >= 400,
    `HTTP ${res.status}${res.status >= 400 ? '' : ' ⚠️ 匿名竟然寫得進去'}`,
  );
} else {
  record('匿名金鑰寫入（鎖一 RLS）', false, '未提供 NEXT_PUBLIC_SUPABASE_ANON_KEY，無法驗證');
}

console.log('='.repeat(64));
const failed = results.filter((r) => !r.passed);
console.log(`${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`  ✗ ${f.name}：${f.detail}`);
  }
  process.exit(1);
}
console.log('✓ user_records 三道鎖與 constraint 全部有效');
console.log(`  註：探針列永久留在表中（line_message_id 以 ${PROBE_PREFIX} 開頭）。`);
process.exit(0);
