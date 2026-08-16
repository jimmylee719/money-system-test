/**
 * 本機 LLM worker：
 *   `npm run llm:check`               只測連得上本機 runtime 與否，不讀不寫任何資料
 *   `npm run llm:worker`              列出待判任務並試跑（dry-run，不寫入）
 *   `npm run llm:worker -- --write`   實際判定並寫入 llm_results
 *   選項：--limit=N（預設 20）／--challenger（用設定檔的挑戰者而非現役 champion）
 *
 * 【只 outbound，不開任何 inbound port】（CLAUDE.md）
 * 這支程式是一般的命令列程式：它主動連 Supabase 與本機 runtime，
 * 不監聽任何埠、不接受外部連線。關掉它，系統就退回沒有 LLM 的狀態。
 *
 * 【待處理＝佇列裡沒有對應結果的任務】
 * llm_queue 是 append-only，沒有可以改的 status 欄位。
 * 「還沒判」是查出來的，不是標記出來的——於是不存在「標記成功但實際沒做」的狀態。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { loadLlmConfig } from '../src/lib/l2/llm/config';
import { OpenAiCompatibleProvider } from '../src/lib/l2/llm/provider';
import { LlmProviderError } from '../src/lib/l2/llm/provider';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/lib/l2/llm/prompt';
import type { Announcement, ModelSpec } from '../src/lib/l2/llm/types';
import { toVerdict } from '../src/lib/l2/llm/verdict';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const WRITE = args.includes('--write');
const USE_CHALLENGER = args.includes('--challenger');
const LIMIT = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '20');

const llmConfig = loadLlmConfig();

// ── --check：只測連通性 ─────────────────────────────────────────────────────
if (CHECK_ONLY) {
  const endpoint = llmConfig.challenger.endpoint.replace(/\/+$/, '');
  console.log('=== 本機模型連通性檢查 ===\n');
  console.log(`端點      ${endpoint}`);
  console.log(`模型      ${llmConfig.challenger.modelKey}`);
  console.log(`廠商      ${llmConfig.challenger.provider}\n`);
  try {
    const res = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.log(`✗ 端點有回應但狀態是 HTTP ${res.status}`);
      process.exit(1);
    }
    const body = (await res.json()) as { data?: readonly { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => String(m.id));
    console.log(`✓ 連得上。runtime 目前有 ${ids.length} 個模型：`);
    for (const id of ids.slice(0, 20)) {
      console.log(`    ${id}${id === llmConfig.challenger.modelKey ? '   ← 設定檔指定的就是這個' : ''}`);
    }
    if (!ids.includes(llmConfig.challenger.modelKey)) {
      console.log(
        `\n⚠️ 設定檔的 modelKey「${llmConfig.challenger.modelKey}」不在清單裡。` +
          '\n   請先下載該模型，或把 config/llm.json 的 modelKey 改成上面其中一個。',
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.log(`✗ 連不上：${(error as Error).message}`);
    console.log('\n可能原因：');
    console.log('  1. Ollama / LM Studio 沒有啟動');
    console.log('  2. 埠號不同（Ollama 預設 11434、LM Studio 預設 1234）→ 改 config/llm.json');
    console.log('  3. 根本還沒安裝。LLM 是選配的：不裝，整個系統照常運作，只是少一層否決。');
    process.exit(1);
  }
}

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });

async function select<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

console.log('=== P11 LLM worker ===\n');

// ── 決定用哪個模型 ──────────────────────────────────────────────────────────
interface ModelRow {
  readonly id: number;
  readonly model_key: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly role: string;
  readonly prompt_version: string;
  readonly prompt_hash: string;
  readonly params_hash: string;
}

let modelId: number;
let spec: ModelSpec;

if (USE_CHALLENGER) {
  const rows = await select<ModelRow>(
    `model_registry?model_key=eq.${encodeURIComponent(llmConfig.challenger.modelKey)}` +
      `&prompt_hash=eq.${llmConfig.challenger.promptHash}` +
      '&role=eq.challenger&select=*&order=registered_at.desc&limit=1',
  );
  const row = rows[0];
  if (row === undefined) {
    console.log('✗ model_registry 裡查無這個 challenger（同一個 modelKey + 同一份 prompt）。');
    console.log('  先跑：npm run llm:eval -- --register');
    process.exit(1);
  }
  modelId = row.id;
  spec = { ...llmConfig.challenger, role: 'challenger' };
} else {
  const rows = await select<ModelRow>(
    'model_registry?role=eq.champion&select=*&order=registered_at.desc&limit=1',
  );
  const row = rows[0];
  if (row === undefined) {
    console.log('目前沒有任何 champion——沒有模型考過 gold_set，所以沒有模型上線。');
    console.log('這不是故障，是禁止熱抽換的預期狀態。流程：');
    console.log('  1. npm run llm:gold -- --export     產生待標註檔');
    console.log('  2. 自己標註（≥ 30 題，且不能全部同一個答案）');
    console.log('  3. npm run llm:gold -- --import <檔案> --write');
    console.log('  4. npm run llm:eval -- --write      考過才會產生第一任 champion');
    process.exit(1);
  }
  modelId = row.id;
  spec = {
    modelKey: row.model_key,
    provider: row.provider as ModelSpec['provider'],
    endpoint: row.endpoint,
    role: 'champion',
    promptVersion: row.prompt_version,
    promptHash: row.prompt_hash,
    paramsHash: row.params_hash,
    params: {},
  };

  // 現役模型登記時綁的 prompt 與程式碼裡的 prompt 必須一致。
  // 不一致代表 prompt 被改過卻沒有重新評分——那就是熱抽換。
  const { PROMPT_HASH } = await import('../src/lib/l2/llm/prompt');
  if (row.prompt_hash !== PROMPT_HASH) {
    console.log('✗ 現役 champion 登記的 prompt 與目前程式碼裡的 prompt 不一致。');
    console.log(`  registry ${row.prompt_hash.slice(0, 16)}…　程式碼 ${PROMPT_HASH.slice(0, 16)}…`);
    console.log('  換 prompt 等於換模型，必須重新考 gold_set 才能上線（npm run llm:eval）。');
    process.exit(1);
  }
}

console.log(`模型　${spec.modelKey}（${spec.role}，registry id=${modelId}）`);
console.log(`端點　${spec.endpoint}`);
console.log(`prompt　${spec.promptVersion}\n`);

// ── 待處理任務 ──────────────────────────────────────────────────────────────
interface QueueRow {
  readonly task_key: string;
  readonly data_as_of: string;
  readonly source_id: string;
  readonly code: string;
  readonly market: string;
  readonly speak_date: string;
  readonly clause: string;
  readonly subject: string;
  readonly detail: string;
  readonly content_hash: string;
}

const queued = await select<QueueRow>(
  'llm_queue?task_key=not.like.__probe*&select=*&order=data_as_of.desc,id.desc&limit=2000',
);
const done = new Set(
  (
    await select<{ task_key: string }>(
      `llm_results?model_registry_id=eq.${modelId}&select=task_key&limit=5000`,
    )
  ).map((r) => r.task_key),
);
const pending = queued.filter((q) => !done.has(q.task_key));

console.log(`佇列 ${queued.length} 筆，本模型已判 ${done.size} 筆，待判 ${pending.length} 筆`);
const batch = pending.slice(0, LIMIT);
console.log(`本次處理 ${batch.length} 筆（--limit=${LIMIT}）\n`);

if (batch.length === 0) {
  console.log('沒有待判任務。');
  process.exit(0);
}

const provider = new OpenAiCompatibleProvider(spec);
const rows: Record<string, unknown>[] = [];
let vetoCount = 0;
let parseFailures = 0;
let evidenceFailures = 0;
let errors = 0;

for (const [index, task] of batch.entries()) {
  const item: Announcement = {
    sourceId: task.source_id,
    code: task.code,
    market: task.market as Announcement['market'],
    speakDate: task.speak_date,
    clause: task.clause,
    subject: task.subject,
    detail: task.detail,
    contentHash: task.content_hash,
    itemKey: task.task_key,
  };

  let raw: string;
  let latency: number;
  try {
    const completion = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(item));
    raw = completion.content;
    latency = completion.latencyMs;
  } catch (error) {
    errors += 1;
    const detail = error instanceof LlmProviderError ? error.message : String(error);
    console.log(`  [${index + 1}/${batch.length}] ${task.code} ✗ 呼叫失敗：${detail.slice(0, 120)}`);
    // 呼叫失敗**不寫入任何結果**。寫一筆 no_veto 進去，
    // 就等於把「沒判成」偽裝成「判過了沒問題」。留在待判狀態，下次再跑。
    continue;
  }

  const verdict = toVerdict(task.task_key, item, raw, latency);
  if (verdict.verdict === 'veto') vetoCount += 1;
  if (!verdict.parseOk) parseFailures += 1;
  else if (!verdict.evidenceVerified) evidenceFailures += 1;

  const mark = verdict.verdict === 'veto' ? '否決' : '　　';
  console.log(
    `  [${index + 1}/${batch.length}] ${task.market} ${task.code} ${mark} ` +
      `${latency}ms  ${task.subject.replace(/\s+/g, ' ').slice(0, 34)}`,
  );
  if (!verdict.parseOk || (verdict.parseOk && !verdict.evidenceVerified)) {
    console.log(`        ⚠️ ${verdict.reason.slice(0, 100)}`);
  }

  rows.push({
    task_key: verdict.taskKey,
    model_registry_id: modelId,
    model_key: spec.modelKey,
    prompt_version: spec.promptVersion,
    role_at_run: spec.role,
    verdict: verdict.verdict,
    quoted_evidence: verdict.quotedEvidence,
    evidence_verified: verdict.evidenceVerified,
    parse_ok: verdict.parseOk,
    reason: verdict.reason,
    raw_response: verdict.rawResponse,
    latency_ms: verdict.latencyMs,
    computed_at: new Date().toISOString(),
  });
}

console.log('');
console.log(
  `判定 ${rows.length} 筆：否決 ${vetoCount}、` +
    `解析失敗 ${parseFailures}、引用作廢 ${evidenceFailures}、呼叫失敗 ${errors}`,
);
if (parseFailures + evidenceFailures > rows.length / 2 && rows.length > 0) {
  console.log('⚠️ 超過一半的回應不可用。這個模型或 prompt 不適合，成績會很難看——那是誠實的訊號。');
}

if (!WRITE) {
  console.log('\n（dry-run，未寫入 llm_results。要實際寫入請加 --write）');
  process.exit(0);
}
if (rows.length === 0) {
  console.log('\n沒有可寫入的結果。');
  process.exit(errors > 0 ? 1 : 0);
}
await client.insert('llm_results', rows);
console.log(`\n✓ 已寫入 ${rows.length} 筆結果。`);
process.exit(0);
