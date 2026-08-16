/**
 * P11 四張表的三道鎖與 constraint 實測：`npm run llm:verify`
 *
 * 【這支程式要證明的，是三件在文件裡講一百遍也不算數的事】
 *   1. `llm_results.verdict` 寫不進 'buy'。LLM 在資料層無法產生買進訊號。
 *   2. 沒有 gold_set 成績的模型當不了 champion。禁止熱抽換是資料庫在擋。
 *   3. 端點填成 api.openai.com 之類的外部網址，資料庫直接拒絕。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

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
    /* 非 JSON */
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
          (codeOk && msgOk ? '' : `　（預期 code=${expectCode}${messageContains ? ` / ${messageContains}` : ''}）`)
      : `⚠️ 沒有被擋下：HTTP ${res.status}`,
  );
}

async function expectAccepted(name: string, table: string, body: unknown): Promise<boolean> {
  const res = await call('POST', table, body);
  const ok = res.status === 201;
  record(
    name,
    ok,
    ok
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
  return ok;
}

/** 查目前最大的探針序號，避免重跑撞唯一索引 */
async function nextProbeIndex(): Promise<number> {
  const res = await fetch(
    `${config.url}/rest/v1/llm_queue?task_key=like.__probe*&select=task_key&order=task_key.desc&limit=1`,
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } },
  );
  if (!res.ok) {
    throw new Error(`查詢探針序號失敗：HTTP ${res.status}（0012 migration 執行了嗎？）`);
  }
  const rows = (await res.json()) as { task_key: string }[];
  const last = rows[0]?.task_key ?? '';
  const parsed = Number(last.replace(/^__probe-/, '').split('-')[0]);
  return Number.isFinite(parsed) ? parsed + 1 : 1;
}

const N = await nextProbeIndex();
const KEY = `__probe-${String(N).padStart(6, '0')}`;
const NOW = new Date().toISOString();

console.log('=== P11 LLM 四張表 append-only 驗證 ===\n');
console.log(`探針序號 = ${KEY}\n`);

// ── model_registry ──────────────────────────────────────────────────────────
console.log('── model_registry ──────────────────────────────────────────────\n');

function modelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_key: KEY,
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    role: 'challenger',
    prompt_version: 'probe',
    prompt_hash: 'p'.repeat(64),
    params_hash: 'q'.repeat(64),
    params_json: { temperature: 0 },
    note: '驗證用探針',
    registered_at: NOW,
    ...overrides,
  };
}

const modelOk = await expectAccepted(
  '對照組：challenger 可以不帶成績登記',
  'model_registry',
  [modelRow()],
);
if (!modelOk) {
  console.log('✗ 探針寫不進去，後續測試無意義。先確認 0012 migration 已執行。');
  process.exit(1);
}

await expectRejected(
  '【禁止熱抽換】沒有 gold_set 成績卻要當 champion',
  'POST',
  'model_registry',
  [modelRow({ model_key: `${KEY}-c`, role: 'champion' })],
  '23514',
  'model_registry_champion_needs_score_check',
);

await expectRejected(
  '【零 AI API 支出】端點填外部網址',
  'POST',
  'model_registry',
  [modelRow({ model_key: `${KEY}-x`, endpoint: 'https://api.openai.com/v1' })],
  '23514',
  'model_registry_local_endpoint_check',
);

await expectRejected(
  '樣本數 29 就想登記成績（CLAUDE.md：樣本 < 30 不下結論）',
  'POST',
  'model_registry',
  [
    modelRow({
      model_key: `${KEY}-s`,
      role: 'champion',
      gold_accuracy: 0.99,
      gold_sample_size: 29,
      gold_set_hash: 'g'.repeat(64),
      gold_false_negatives: 0,
      gold_false_positives: 1,
    }),
  ],
  '23514',
  'model_registry_min_sample_check',
);

await expectAccepted('　└ 對照組：樣本 30 且成績齊全就登記得上', 'model_registry', [
  modelRow({
    model_key: `${KEY}-s`,
    role: 'champion',
    gold_accuracy: 0.99,
    gold_sample_size: 30,
    gold_set_hash: 'g'.repeat(64),
    gold_false_negatives: 0,
    gold_false_positives: 1,
  }),
]);

await expectRejected(
  '事後修改模型成績（UPDATE）',
  'PATCH',
  `model_registry?model_key=eq.${KEY}`,
  { gold_accuracy: 1 },
  '42501',
  'permission denied',
);
await expectRejected(
  '刪除模型換代紀錄（DELETE）',
  'DELETE',
  `model_registry?model_key=eq.${KEY}`,
  undefined,
  '42501',
  'permission denied',
);

// ── gold_set ────────────────────────────────────────────────────────────────
console.log('── gold_set ────────────────────────────────────────────────────\n');

function goldRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_key: KEY,
    revision: 1,
    source_id: 'mops_twse_material_announcements',
    code: '__probe',
    market: 'TWSE',
    speak_date: '2026-08-15',
    clause: '第51款',
    subject: '驗證用主旨',
    detail: '驗證用說明',
    content_hash: 'h'.repeat(64),
    label: 'no_veto',
    label_reason: '驗證用探針，非真實標註',
    labeled_by: 'verify-llm',
    labeled_at: NOW,
    ...overrides,
  };
}

await expectAccepted('對照組：正常的標註寫得進去', 'gold_set', [goldRow()]);

await expectRejected(
  '【只能否決】標準答案填 buy',
  'POST',
  'gold_set',
  [goldRow({ item_key: `${KEY}-b`, label: 'buy' })],
  '23514',
  'gold_set_label_check',
);

await expectRejected(
  '標註理由留白（空白即拒絕，同 factor_registry）',
  'POST',
  'gold_set',
  [goldRow({ item_key: `${KEY}-r`, label_reason: '   ' })],
  '23514',
  'gold_set_reason_not_blank_check',
);

await expectRejected(
  '同一題同一 revision 重複標註',
  'POST',
  'gold_set',
  [goldRow({ label: 'veto' })],
  '23505',
  'gold_set_item_revision_uniq',
);
await expectAccepted('　└ 對照組：改寫成 revision 2 就是重標，舊的保留', 'gold_set', [
  goldRow({ revision: 2, label: 'veto', label_reason: '重標：改判為應否決' }),
]);

await expectRejected(
  '事後改標準答案（UPDATE）',
  'PATCH',
  `gold_set?item_key=eq.${KEY}`,
  { label: 'veto' },
  '42501',
  'permission denied',
);
await expectRejected(
  '刪掉答錯的題目（DELETE）',
  'DELETE',
  `gold_set?item_key=eq.${KEY}`,
  undefined,
  '42501',
  'permission denied',
);

// ── llm_queue ───────────────────────────────────────────────────────────────
console.log('── llm_queue ───────────────────────────────────────────────────\n');

function queueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_key: KEY,
    data_as_of: '2026-08-15',
    source_id: 'mops_twse_material_announcements',
    code: '__probe',
    market: 'TWSE',
    speak_date: '2026-08-15',
    clause: '第51款',
    subject: '驗證用主旨',
    detail: '驗證用說明',
    content_hash: 'h'.repeat(64),
    enqueued_at: NOW,
    ...overrides,
  };
}

await expectAccepted('對照組：任務入佇列', 'llm_queue', [queueRow()]);

// 前視偏誤的判準是「排入當下」而不是「訊號日」。
// 收盤後或假日發布的公告，發言日會晚於訊號日，那是正常且必須採用的資訊；
// 真正不准的是發言日還沒到就先排進去。
const TOMORROW_TAIPEI = new Date(Date.now() + 8 * 3_600_000 + 86_400_000)
  .toISOString()
  .slice(0, 10);

await expectRejected(
  '【前視偏誤】公告日還沒到就先排入',
  'POST',
  'llm_queue',
  [queueRow({ task_key: `${KEY}-f`, data_as_of: '2026-08-15', speak_date: TOMORROW_TAIPEI })],
  '23514',
  'llm_queue_not_future_check',
);

await expectAccepted('　└ 對照組：公告日晚於訊號日（假日發布）可以排入', 'llm_queue', [
  queueRow({ task_key: `${KEY}-w`, data_as_of: '2026-08-14', speak_date: '2026-08-15' }),
]);

await expectRejected(
  '同一則公告重複入佇列',
  'POST',
  'llm_queue',
  [queueRow()],
  '23505',
  'llm_queue_task_key_uniq',
);

await expectRejected(
  '【佇列也是 append-only】把任務標記成已完成（UPDATE）',
  'PATCH',
  `llm_queue?task_key=eq.${KEY}`,
  { code: 'done' },
  '42501',
  'permission denied',
);
await expectRejected(
  '處理完就把任務刪掉（DELETE）',
  'DELETE',
  `llm_queue?task_key=eq.${KEY}`,
  undefined,
  '42501',
  'permission denied',
);

// ── llm_results ─────────────────────────────────────────────────────────────
console.log('── llm_results ─────────────────────────────────────────────────\n');

/** 取剛才寫進去的探針模型 id */
async function probeModelId(): Promise<number> {
  const res = await fetch(
    `${config.url}/rest/v1/model_registry?model_key=eq.${KEY}&select=id&limit=1`,
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } },
  );
  const rows = (await res.json()) as { id: number }[];
  return rows[0]?.id ?? -1;
}
const MODEL_ID = await probeModelId();

function resultRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_key: KEY,
    model_registry_id: MODEL_ID,
    model_key: KEY,
    prompt_version: 'probe',
    role_at_run: 'challenger',
    verdict: 'no_veto',
    quoted_evidence: '',
    evidence_verified: true,
    parse_ok: true,
    reason: '驗證用',
    raw_response: '{"verdict":"no_veto"}',
    latency_ms: 1,
    computed_at: NOW,
    ...overrides,
  };
}

await expectAccepted('對照組：no_veto 結果寫得進去', 'llm_results', [resultRow()]);

await expectRejected(
  '★【L2 只能否決】verdict 寫 buy',
  'POST',
  'llm_results',
  [resultRow({ task_key: `${KEY}-buy`, verdict: 'buy' })],
  '23514',
  'llm_results_verdict_check',
);

for (const invented of ['strong_buy', 'neutral', 'hold', 'sell']) {
  await expectRejected(
    `　└ verdict 寫 ${invented} 一樣寫不進去`,
    'POST',
    'llm_results',
    [resultRow({ task_key: `${KEY}-${invented}`, verdict: invented })],
    '23514',
    'llm_results_verdict_check',
  );
}

await expectRejected(
  '【解析失敗不得否決】parse_ok=false 卻判 veto',
  'POST',
  'llm_results',
  [
    resultRow({
      task_key: `${KEY}-pf`,
      verdict: 'veto',
      parse_ok: false,
      quoted_evidence: '原文片段',
      evidence_verified: true,
    }),
  ],
  '23514',
  'llm_results_parse_fail_cannot_veto_check',
);

await expectRejected(
  '【幻覺不得構成否決】引用未通過原文比對卻判 veto',
  'POST',
  'llm_results',
  [
    resultRow({
      task_key: `${KEY}-hal`,
      verdict: 'veto',
      quoted_evidence: '原文裡沒有的句子',
      evidence_verified: false,
    }),
  ],
  '23514',
  'llm_results_veto_needs_evidence_check',
);

await expectRejected(
  '判 veto 卻沒附引用',
  'POST',
  'llm_results',
  [resultRow({ task_key: `${KEY}-noq`, verdict: 'veto', quoted_evidence: '', evidence_verified: true })],
  '23514',
  'llm_results_veto_needs_evidence_check',
);

await expectAccepted('　└ 對照組：引用齊備的 veto 寫得進去', 'llm_results', [
  resultRow({
    task_key: `${KEY}-ok`,
    verdict: 'veto',
    quoted_evidence: '驗證用說明',
    evidence_verified: true,
  }),
]);

await expectRejected(
  '同一任務同一模型重複寫入結果',
  'POST',
  'llm_results',
  [resultRow({ verdict: 'no_veto' })],
  '23505',
  'llm_results_task_model_uniq',
);

await expectRejected(
  '事後把否決改成不否決（UPDATE）',
  'PATCH',
  `llm_results?task_key=eq.${KEY}`,
  { verdict: 'veto' },
  '42501',
  'permission denied',
);
await expectRejected(
  '刪掉判錯的紀錄（DELETE）',
  'DELETE',
  `llm_results?task_key=eq.${KEY}`,
  undefined,
  '42501',
  'permission denied',
);

// ── veto_events 的新規則 ────────────────────────────────────────────────────
console.log('── veto_events（0012 新增的 rule_id）───────────────────────────\n');

await expectRejected(
  '未登記的 rule_id 仍然寫不進 veto_events',
  'POST',
  'veto_events',
  [
    {
      run_id: '00000000-0000-4000-8000-000000000011',
      data_as_of: '2026-08-15',
      signal_at: NOW,
      code: '__probe',
      market: 'TWSE',
      rule_id: 'llm_says_buy',
      reason: '探針',
      evidence: '探針',
      engine_version: 'probe',
    },
  ],
  '23514',
  'veto_events_rule_id_check',
);

await expectAccepted('　└ 對照組：llm_material_news 已可寫入', 'veto_events', [
  {
    run_id: '00000000-0000-4000-8000-000000000011',
    data_as_of: '2026-08-15',
    signal_at: NOW,
    code: '__probe',
    market: 'TWSE',
    rule_id: 'llm_material_news',
    reason: `探針 ${KEY}`,
    evidence: '探針用官方原文片段',
    engine_version: 'probe',
  },
]);

// ── 匿名 ────────────────────────────────────────────────────────────────────
console.log('── 鎖一 RLS ────────────────────────────────────────────────────\n');

if (config.anonKey !== null) {
  for (const [table, body] of [
    ['model_registry', modelRow({ model_key: `${KEY}-anon` })],
    ['gold_set', goldRow({ item_key: `${KEY}-anon` })],
    ['llm_queue', queueRow({ task_key: `${KEY}-anon` })],
    ['llm_results', resultRow({ task_key: `${KEY}-anon` })],
  ] as const) {
    const res = await fetch(`${config.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([body]),
      signal: AbortSignal.timeout(30_000),
    });
    record(
      `匿名金鑰寫入 ${table}`,
      res.status >= 400,
      `HTTP ${res.status}${res.status >= 400 ? '' : ' ⚠️ 匿名竟然寫得進去'}`,
    );
  }
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
console.log('✓ P11 四張表三道鎖與 constraint 全部有效');
console.log('  已證明：verdict 寫不進 buy／沒考過不能當 champion／端點不得對外');
console.log(`  註：探針列永久留在表中（key 以 __probe- 開頭、code __probe）。`);
process.exit(0);
