/**
 * 因子登記守門機制的實測驗證：`npm run factors:verify`
 *
 * 【刻意繞過程式端驗證】直接打 PostgREST 送出非法資料。
 * 理由：程式端的 validation.ts 可以被改（包括被我改），
 * 真正要證明的是「即使程式被繞過，資料庫仍然拒絕」。
 *
 * 【每項檢查都比對錯誤碼與訊息】
 * 只檢查「有沒有被擋」不夠 —— 2026-08-16 就發生過：探針因子在前一輪被封存後，
 * 樣本數／k-fold／passed 造假等測試全部撞在「已封存」上而假通過，
 * 實際上那幾道守門根本沒被測到。
 *
 * 【兩個探針因子分工】
 *   probe_guard_check_v2  永久保留、絕不封存 → 測檢定結果的各道守門
 *   probe_archive_<每次不同> 每次新建後封存   → 測封存後的行為
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 * ⚠️ 探針寫入後刪不掉（append-only）。factor_trial_summary 的
 *    real_registrations 已排除 probe_ 開頭者，DSR 呈報不受污染。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { hashDefinition } from '../src/lib/factors/definition-hash';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

/** 每次執行用不同後綴，避免負面測試因鍵重複而假通過 */
const RUN_SUFFIX = process.hrtime.bigint().toString().slice(-9);

const PERMANENT_KEY = 'probe_guard_check_v2';
const PERMANENT_DEF = { probe: 'guard_v2', note: 'permanent guard probe, never archived' };
const PERMANENT_HASH = hashDefinition(PERMANENT_DEF);

const ARCHIVE_KEY = `probe_archive_${RUN_SUFFIX}`;
const ARCHIVE_DEF = { probe: 'archive', run: RUN_SUFFIX };
const ARCHIVE_HASH = hashDefinition(ARCHIVE_DEF);

const RATIONALE =
  '此為守門機制驗證用探針因子，非真實交易因子。撰寫足夠長度的說明以通過 ' +
  'economic_rationale 的最小長度限制，並記錄其用途供日後稽核追溯。';

interface Result {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}
const results: Result[] = [];

interface ApiResponse {
  readonly status: number;
  /** PostgREST 的 SQLSTATE */
  readonly code: string | null;
  /** PostgREST 的 message 欄位。constraint 名稱在這裡，不在 details。 */
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
  // 解析而非在原始字串上做子字串比對：details 會傾印整列資料，很容易把 message 擠掉
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    code = typeof parsed.code === 'string' ? parsed.code : null;
    message = typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    /* 非 JSON 回應（例如 201 空 body） */
  }
  return { status: res.status, code, message, text: raw.slice(0, 200) };
}

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

/**
 * 期待被資料庫拒絕，且**理由必須正確**。
 * `code` 為 SQLSTATE，`messageContains` 為錯誤訊息應含的關鍵字。
 * 被擋但理由不對 → 判定失敗，因為那代表這項測試沒測到它宣稱要測的東西。
 */
async function expectRejected(
  name: string,
  path: string,
  body: unknown,
  code: string,
  messageContains?: string,
): Promise<void> {
  const r = await call('POST', path, [body]);
  const rejected = r.status >= 400;
  const codeOk = r.code === code;
  const msgOk = messageContains === undefined || (r.message ?? '').includes(messageContains);

  const detail = !rejected
    ? `HTTP ${r.status} ← 竟然成功了！`
    : !codeOk
      ? `HTTP ${r.status} 被擋了，但錯誤碼是 ${r.code ?? '?'} 而非預期的 ${code}（本項測試無效）`
      : !msgOk
        ? `HTTP ${r.status} [${r.code}] 訊息不含「${messageContains}」，可能撞到別的守門：${r.message ?? r.text}`
        : `HTTP ${r.status} [${r.code}] ${r.message ?? ''}`;

  record(name, rejected && codeOk && msgOk, detail);
}

function factorRow(key: string, definition: object, hash: string): Record<string, unknown> {
  return {
    factor_key: key,
    display_name: '守門驗證探針',
    definition,
    definition_hash: hash,
    economic_rationale: RATIONALE,
    hypothesis_direction: 'higher_is_better',
    test_period_start: '2020-01-01',
    test_period_end: '2025-12-31',
    t_threshold: 3.0,
    universe: 'BOTH',
    registered_by: 'verify-script',
  };
}

console.log('=== 因子登記守門機制實測驗證 ===');
console.log(`目標：${config.url}\n`);

// ── 1. 永久探針：已存在則沿用（append-only 無法重建） ─────────────────────────
{
  const r = await call('POST', 'factor_registry', [
    factorRow(PERMANENT_KEY, PERMANENT_DEF, PERMANENT_HASH),
  ]);
  record(
    '合法因子可登記',
    r.status === 201 || r.status === 409,
    r.status === 409 ? 'HTTP 409（永久探針已存在，沿用）' : `HTTP ${r.status} ${r.text}`,
  );
}

// ── 2. 登記本身的守門 ────────────────────────────────────────────────────────
await expectRejected(
  '經濟理由過短即拒絕（空白即拒絕）',
  'factor_registry',
  {
    ...factorRow(
      `probe_short_${RUN_SUFFIX}`,
      { probe: 'short', run: RUN_SUFFIX },
      hashDefinition({ probe: 'short', run: RUN_SUFFIX }),
    ),
    economic_rationale: '因為會漲',
  },
  '23514',
  'rationale_not_blank',
);

await expectRejected(
  't 門檻低於 3.0 即拒絕',
  'factor_registry',
  {
    ...factorRow(
      `probe_lowt_${RUN_SUFFIX}`,
      { probe: 'lowt', run: RUN_SUFFIX },
      hashDefinition({ probe: 'lowt', run: RUN_SUFFIX }),
    ),
    t_threshold: 2.9,
  },
  '23514',
  'threshold_check',
);

// 0003 之前這一項是通的。錯誤碼必須是 42501（權限不足）而非 23505（鍵重複）。
await expectRejected(
  '偽造 registered_at 即拒絕（欄位級權限）',
  'factor_registry',
  {
    ...factorRow(
      `probe_forged_${RUN_SUFFIX}`,
      { probe: 'forged', run: RUN_SUFFIX },
      hashDefinition({ probe: 'forged', run: RUN_SUFFIX }),
    ),
    registered_at: '2000-01-01T00:00:00Z',
  },
  '42501',
  'permission denied',
);

await expectRejected(
  '重複的 definition_hash 即拒絕（同定義不得重複登記）',
  'factor_registry',
  factorRow(`probe_duphash_${RUN_SUFFIX}`, PERMANENT_DEF, PERMANENT_HASH),
  '23505',
  'definition_hash',
);

// ── 3. 檢定結果的守門（一律對永久探針，它不會被封存） ─────────────────────────
const goodResult = {
  factor_key: PERMANENT_KEY,
  definition_hash: PERMANENT_HASH,
  t_statistic: 1.2,
  sample_size: 100,
  observed_direction: 'higher_is_better',
  passed: false,
  method: 'purged_kfold_embargo',
};

{
  // 先證明合法的結果寫得進去，否則後面的「被拒絕」全部沒有意義
  const r = await call('POST', 'factor_test_results', [
    { ...goodResult, notes: `verify run ${RUN_SUFFIX}` },
  ]);
  record('合法檢定結果可寫入（未通過門檻，如實記錄）', r.status === 201, `HTTP ${r.status} ${r.text}`);
}

await expectRejected(
  '樣本數 < 30 即拒絕',
  'factor_test_results',
  { ...goodResult, sample_size: 29 },
  '23514',
  'sample_size_check',
);

await expectRejected(
  '標準 k-fold 即拒絕（金融資料必然洩漏）',
  'factor_test_results',
  { ...goodResult, method: 'kfold' },
  '23514',
  'method_check',
);

await expectRejected(
  'definition_hash 與登記不符即拒絕（定義鎖定不得調參）',
  'factor_test_results',
  { ...goodResult, definition_hash: 'b'.repeat(64) },
  '42501',
  'definition_hash 與登記時不符',
);

await expectRejected(
  't 值不足卻自報 passed=true 即拒絕',
  'factor_test_results',
  { ...goodResult, t_statistic: 1.2, passed: true },
  '42501',
  'passed 自報',
);

await expectRejected(
  '方向與登記相反卻自報 passed=true 即拒絕',
  'factor_test_results',
  { ...goodResult, t_statistic: 9.9, observed_direction: 'lower_is_better', passed: true },
  '42501',
  'passed 自報',
);

// ── 4. append-only ───────────────────────────────────────────────────────────
{
  const r = await call('PATCH', `factor_registry?factor_key=eq.${PERMANENT_KEY}`, {
    t_threshold: 1.0,
  });
  record(
    '登記後修改門檻即拒絕',
    r.status >= 400 && r.code === '42501',
    `HTTP ${r.status} [${r.code ?? '?'}] ${r.message ?? r.text}`,
  );
}
{
  const r = await call('DELETE', `factor_registry?factor_key=eq.${PERMANENT_KEY}`);
  record(
    '刪除登記即拒絕',
    r.status >= 400 && r.code === '42501',
    `HTTP ${r.status} [${r.code ?? '?'}] ${r.message ?? r.text}`,
  );
}

// ── 5. 封存行為（用每次新建的拋棄式探針，確保測到的是封存而非殘留狀態） ───────
{
  const reg = await call('POST', 'factor_registry', [
    factorRow(ARCHIVE_KEY, ARCHIVE_DEF, ARCHIVE_HASH),
  ]);
  record('可登記拋棄式探針供封存測試', reg.status === 201, `HTTP ${reg.status} ${reg.text}`);

  const archive = await call('POST', 'factor_status_events', [
    { factor_key: ARCHIVE_KEY, status: 'archived', reason: '守門驗證：封存後行為測試' },
  ]);
  record('可封存因子', archive.status === 201, `HTTP ${archive.status} ${archive.text}`);

  await expectRejected(
    '封存後再記錄檢定結果即拒絕（不得改條件重測）',
    'factor_test_results',
    {
      factor_key: ARCHIVE_KEY,
      definition_hash: ARCHIVE_HASH,
      t_statistic: 4.0,
      sample_size: 100,
      observed_direction: 'higher_is_better',
      passed: true,
      method: 'purged_kfold_embargo',
    },
    '42501',
    '已封存',
  );

  await expectRejected(
    '封存後再變更狀態即拒絕',
    'factor_status_events',
    { factor_key: ARCHIVE_KEY, status: 'testing', reason: '嘗試在封存後重新測試，應被拒絕' },
    '42501',
    '已封存',
  );
}

// ── 6. 試驗次數摘要 ──────────────────────────────────────────────────────────
{
  const res = await fetch(`${config.url}/rest/v1/factor_trial_summary?select=*`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  record(
    'factor_trial_summary 可讀且探針可扣除（DSR 呈報用）',
    res.status === 200 && text.includes('real_registrations'),
    `HTTP ${res.status} ${text.slice(0, 240)}`,
  );
}

const failed = results.filter((r) => !r.passed);
console.log('='.repeat(60));
console.log(`共 ${results.length} 項檢查，通過 ${results.length - failed.length}，失敗 ${failed.length}`);
for (const f of failed) {
  console.log(`  ✗ ${f.name}：${f.detail}`);
}
process.exit(failed.length > 0 ? 1 : 0);
