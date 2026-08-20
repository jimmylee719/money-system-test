/**
 * veto_events 三道鎖與 constraint 的實測驗證：`npm run l2:verify`
 *
 * 【刻意繞過程式端】直接打 PostgREST。程式可以被改（包括被我改），
 * 要證明的是「即使程式被繞過，資料庫仍然拒絕」。
 *
 * 【每個負面測試都配對照組】
 * 2026-08-16 實測：欄位級 INSERT 權限不足時 PostgREST 只回
 * 「permission denied for table」，訊息不指名欄位。光看錯誤碼分不出原因，
 * 故同一列只差一個欄位、一擋一過，才算真的證明。
 *
 * 【探針列刪不掉，所以必須一眼可辨識】
 * 探針的 code 一律以 `__probe` 開頭，下游查詢過濾即可。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { RULE_SPECS } from '../src/lib/l2/rules';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

/** 每次執行用不同的 run_id，避免負面測試因唯一索引而假通過 */
const PROBE_RUN_ID = `00000000-0000-4000-8000-${String(process.hrtime.bigint() % 1_000_000_000_000n).padStart(12, '0')}`;
const PROBE_DATE = '2026-08-14';

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
      Prefer: 'return=minimal',
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
  const res = await call('POST', 'veto_events', body);
  record(
    name,
    res.status === 201,
    res.status === 201
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
}

function probeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: PROBE_RUN_ID,
    data_as_of: PROBE_DATE,
    signal_at: new Date().toISOString(),
    code: '__probe',
    market: 'TWSE',
    rule_id: 'attention',
    reason: '守門驗證探針',
    evidence: '此列由 npm run l2:verify 產生，非真實否決',
    rank_at_signal: 1,
    composite_score: 0.5,
    engine_version: 'probe',
    failed_closed: false,
    ...overrides,
  };
}

console.log('=== veto_events append-only 三道鎖驗證 ===\n');
console.log(`探針 run_id = ${PROBE_RUN_ID}，code 以 __probe 開頭，可辨識\n`);

const seeded = await call('POST', 'veto_events', [probeRow()]);
record(
  '寫入探針列（正常 INSERT 應該成功）',
  seeded.status === 201,
  `HTTP ${seeded.status}${seeded.status === 201 ? '' : ` ${seeded.text}`}`,
);
if (seeded.status !== 201) {
  console.log('✗ 探針寫不進去，後續測試無意義。先確認 0007 migration 已執行。');
  process.exit(1);
}

// ── 鎖二 ────────────────────────────────────────────────────────────────────
await expectRejected(
  '事後改寫否決理由（UPDATE）',
  'PATCH',
  `veto_events?run_id=eq.${PROBE_RUN_ID}`,
  { reason: '改過的理由' },
  '42501',
  'permission denied',
);

await expectRejected(
  '刪除不利的否決紀錄（DELETE）',
  'DELETE',
  `veto_events?run_id=eq.${PROBE_RUN_ID}`,
  undefined,
  '42501',
  'permission denied',
);

// ── 欄位級權限 ──────────────────────────────────────────────────────────────
await expectRejected(
  '偽造 inserted_at',
  'POST',
  'veto_events',
  [probeRow({ rule_id: 'disposition', inserted_at: '2020-01-01T00:00:00Z' })],
  '42501',
);
await expectAccepted('　└ 對照組：同一列拿掉 inserted_at 就寫得進去', [
  probeRow({ rule_id: 'disposition' }),
]);

// ── 唯一索引 ────────────────────────────────────────────────────────────────
await expectRejected(
  '同一次執行、同一檔、同一條規則重複記錄',
  'POST',
  'veto_events',
  [probeRow({ reason: '換個理由再記一次' })],
  '23505',
  'veto_events_slot_uniq',
);

// ── constraint ──────────────────────────────────────────────────────────────
await expectRejected(
  '偷加一條沒登記過的否決規則',
  'POST',
  'veto_events',
  [probeRow({ rule_id: 'my_secret_rule' })],
  '23514',
  'veto_events_rule_id_check',
);

/**
 * 【每一條程式裡的規則都必須真的寫得進去】
 *
 * 上一則證明「沒登記的規則會被擋」，但那擋不住相反的錯誤：
 * 程式新增了規則、migration 卻忘了跑。那種情況下 migration 不會報錯，
 * 要等到隔天早上排程實際寫入否決紀錄時才 403/400 ——
 * 而排程對 picks 那一步設了 continue-on-error，整條管線仍是綠燈，
 * 只有那天沒有觀察榜。與 2026-08-19 LINE 靜默失效是同一種故障形狀。
 *
 * 這裡逐一拿 RULE_SPECS 裡的每個 rule_id 實際寫一次。
 * 新增規則卻沒更新 constraint，這裡會當場紅燈。
 */
for (const [i, spec] of RULE_SPECS.entries()) {
  await expectAccepted(`程式登記的規則「${spec.displayName}」資料庫也接受（${spec.id}）`, [
    probeRow({ rule_id: spec.id, code: `__probe_rule_${i}` }),
  ]);
}

await expectRejected(
  '沒有證據的否決（evidence 空白）',
  'POST',
  'veto_events',
  [probeRow({ rule_id: 'suspended', evidence: '   ' })],
  '23514',
  'veto_events_evidence_not_blank_check',
);

await expectRejected(
  '回填 L0 開始累積之前的日期',
  'POST',
  'veto_events',
  [probeRow({ rule_id: 'altered_trading', data_as_of: '2020-01-01' })],
  '23514',
  'veto_events_no_backfill_check',
);

await expectRejected(
  '名次為 0（名次從 1 起算）',
  'POST',
  'veto_events',
  [probeRow({ rule_id: 'source_unavailable', rank_at_signal: 0 })],
  '23514',
  'veto_events_rank_check',
);

// ── 匿名身分 ────────────────────────────────────────────────────────────────
if (config.anonKey !== null) {
  const res = await fetch(`${config.url}/rest/v1/veto_events`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([probeRow({ rule_id: 'suspended' })]),
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
console.log('✓ veto_events 三道鎖與 constraint 全部有效');
console.log('  註：探針列永久留在表中（code 以 __probe 開頭），這正是 append-only 的證明。');
process.exit(0);
