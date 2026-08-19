/**
 * Champion / Challenger 評測與晉升：
 *   `npm run llm:eval`              考一次，印出成績與晉升判定
 *   `npm run llm:eval -- --write`   通過五道門檻才登記為新的 champion
 *   `npm run llm:eval -- --register` 只把挑戰者登記成 challenger（不評測、不晉升）
 *
 * 【逐題結果一律保存，晉升才需要 --write】
 * 這兩件事性質不同，所以規則也不同：
 *   保存逐題判定 = **記錄實驗發生過什麼**。append-only 的稽核資料，
 *     對正式運作沒有任何影響（worker 只認 role=champion）。
 *     一次評測要跑十幾分鐘，關掉視窗就沒了是不可接受的。
 *   晉升 champion = **改變正式運作**。這才需要 --write。
 * 專案的「預設 dry-run」規矩是為了擋住不可逆的正式變更，不是為了擋住記錄。
 *
 * 【已判過的題目會重用，不重複呼叫模型】
 * 模型版本由 (model_key, prompt_hash, params_hash) 唯一決定，temperature 為 0，
 * 同一版本對同一題再問一次應得相同答案。因此已存在 llm_results 的題目直接重用：
 * 重跑評測從十幾分鐘變成幾秒，而且成績可重現——
 * 每次重跑都得到不同分數的評測，本身就沒有評測的意義。
 *
 * 【禁止熱抽換】（CLAUDE.md）
 * 這支程式是唯一能產生 champion 的地方，而它只在五道門檻全過時才寫入：
 *   樣本 ≥ 30／同一份考卷／勝過 always-no_veto baseline／
 *   正確率嚴格高於現役／漏擋數未增加
 * 資料庫還有第二道保險：沒有成績的列根本插不進 role='champion'。
 *
 * ⚠️ 評測會對每一題實際呼叫一次本機模型，30 題可能要跑好幾分鐘。
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { contentKeyIgnoringDate } from '../src/lib/l2/llm/announce';
import { loadLlmConfig } from '../src/lib/l2/llm/config';
import {
  MIN_GOLD_SAMPLE,
  baselineScore,
  goldSetHash,
  isDegenerate,
  latestRevisions,
  scoreAgainstGold,
} from '../src/lib/l2/llm/gold';
import { evaluatePromotion } from '../src/lib/l2/llm/promotion';
import { OpenAiCompatibleProvider } from '../src/lib/l2/llm/provider';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/lib/l2/llm/prompt';
import type { GoldItem, LlmVerdict } from '../src/lib/l2/llm/types';
import { toVerdict } from '../src/lib/l2/llm/verdict';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const REGISTER_ONLY = args.includes('--register');

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });
const llmConfig = loadLlmConfig();

async function select<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

const spec = llmConfig.challenger;
console.log('=== P11 Champion / Challenger 評測 ===\n');
console.log(`挑戰者　${spec.modelKey}（${spec.provider}）`);
console.log(`端點　　${spec.endpoint}`);
console.log(`prompt　${spec.promptVersion} / ${spec.promptHash.slice(0, 16)}…\n`);

// ── 只登記 ──────────────────────────────────────────────────────────────────
if (REGISTER_ONLY) {
  if (!WRITE) {
    console.log('（dry-run。要實際登記 challenger 請加 --write）');
    process.exit(0);
  }
  await client.insert('model_registry', [
    {
      model_key: spec.modelKey,
      provider: spec.provider,
      endpoint: spec.endpoint,
      role: 'challenger',
      prompt_version: spec.promptVersion,
      prompt_hash: spec.promptHash,
      params_hash: spec.paramsHash,
      params_json: spec.params,
      note: '由 llm:eval --register 登記',
      registered_at: new Date().toISOString(),
    },
  ]);
  console.log('✓ 已登記為 challenger（沒有成績，因此不會被 worker 當成現役模型）。');
  process.exit(0);
}

// ── 確保這個模型版本已登記，並取得 model_registry_id ────────────────────────
//
// 逐題結果要能被稽核，就必須知道「是哪一版模型答的」。
// 模型版本由 (model_key, prompt_hash, params_hash) 唯一決定——
// 換模型是新版本，只改一句提示詞也是新版本，兩者都必須重新考。
interface RegistryRow {
  readonly id: number;
  readonly registered_at: string;
}

async function ensureChallengerRegistered(): Promise<number> {
  const existing = await select<RegistryRow>(
    `model_registry?model_key=eq.${encodeURIComponent(spec.modelKey)}` +
      `&prompt_hash=eq.${spec.promptHash}&params_hash=eq.${spec.paramsHash}` +
      "&role=eq.challenger&select=id,registered_at&order=registered_at.asc&limit=1",
  );
  const found = existing[0];
  if (found !== undefined) {
    console.log(`模型版本　registry id=${found.id}（登記於 ${found.registered_at.slice(0, 19)}）`);
    return found.id;
  }
  await client.insert("model_registry", [
    {
      model_key: spec.modelKey,
      provider: spec.provider,
      endpoint: spec.endpoint,
      role: "challenger",
      prompt_version: spec.promptVersion,
      prompt_hash: spec.promptHash,
      params_hash: spec.paramsHash,
      params_json: spec.params,
      note: "由 llm:eval 自動登記（challenger 無成績，worker 不會採用）",
      registered_at: new Date().toISOString(),
    },
  ]);
  const created = await select<RegistryRow>(
    `model_registry?model_key=eq.${encodeURIComponent(spec.modelKey)}` +
      `&prompt_hash=eq.${spec.promptHash}&params_hash=eq.${spec.paramsHash}` +
      "&role=eq.challenger&select=id,registered_at&order=registered_at.desc&limit=1",
  );
  const id = created[0]?.id;
  if (id === undefined) {
    throw new Error("登記 challenger 後仍查不到 registry id");
  }
  console.log(`模型版本　registry id=${id}（本次新登記）`);
  return id;
}

const MODEL_ID = await ensureChallengerRegistered();

// ── 讀考卷 ──────────────────────────────────────────────────────────────────
interface GoldRow {
  readonly item_key: string;
  readonly revision: number;
  readonly source_id: string;
  readonly code: string;
  readonly market: string;
  readonly speak_date: string;
  readonly clause: string;
  readonly subject: string;
  readonly detail: string;
  readonly content_hash: string;
  readonly label: string;
  readonly label_reason: string;
  readonly labeled_by: string;
}

const goldRows = await select<GoldRow>(
  'gold_set?item_key=not.like.__probe*&select=*&order=item_key.asc,revision.asc&limit=5000',
);
const gold: readonly GoldItem[] = latestRevisions(
  goldRows.map((r) => ({
    sourceId: r.source_id,
    code: r.code,
    market: r.market as GoldItem['market'],
    speakDate: r.speak_date,
    clause: r.clause,
    subject: r.subject,
    detail: r.detail,
    contentHash: r.content_hash,
    itemKey: r.item_key,
    label: r.label as GoldItem['label'],
    labelReason: r.label_reason,
    labeledBy: r.labeled_by,
    revision: r.revision,
  })),
);

const hash = goldSetHash(gold);
console.log(`考卷　${gold.length} 題（雜湊 ${hash.slice(0, 16)}…）`);

if (gold.length < MIN_GOLD_SAMPLE) {
  console.log(`\n✗ 題數不足 ${MIN_GOLD_SAMPLE}，不評測也不下結論（CLAUDE.md）。`);
  console.log('   先標更多題：npm run llm:gold -- --export');
  process.exit(1);
}
if (isDegenerate(gold)) {
  console.log('\n✗ 這份考卷的標準答案全部相同，沒有鑑別度，考幾分都沒有意義。');
  process.exit(1);
}

// 第三道防重複。匯出端與匯入端都濾過了，這裡是最後一道：
// 一份混了重複題的考卷，題數看起來合格、鑑別度卻被稀釋，
// 是所有失效模式裡最難察覺的一種——所以寧可多檢查一次。
const distinctContent = new Set(gold.map((g) => contentKeyIgnoringDate(g)));
if (distinctContent.size < gold.length) {
  console.log(
    `\n⚠️ 考卷裡有重複題：${gold.length} 題中只有 ${distinctContent.size} 則不同的公告。\n` +
      '   連續公告三個月的更名／面額變更公告每天都會回來一次，內容相同只有發言日期不同。\n' +
      '   重複題會稀釋 veto 比例並推高 baseline，成績不可信。請先清理再評測。',
  );
  process.exit(1);
}

const baseline = baselineScore(gold);
console.log(
  `　　 其中應否決 ${baseline.vetoLabels} 題　　` +
    `always-no_veto baseline 正確率 ${(baseline.accuracy * 100).toFixed(1)}%\n`,
);

// ── 考試 ────────────────────────────────────────────────────────────────────
//
// 已經判過的題目直接重用 llm_results 裡的紀錄，不重複呼叫模型。
// 這不只是省時間：**同一版模型對同一題應該給同一個答案**，
// 每次重跑都得到不同分數的評測，本身就沒有評測的意義。
interface StoredResult {
  readonly task_key: string;
  readonly verdict: string;
  readonly quoted_evidence: string;
  readonly evidence_verified: boolean;
  readonly parse_ok: boolean;
  readonly reason: string;
  readonly raw_response: string;
  readonly latency_ms: number;
}

const stored = new Map<string, LlmVerdict>(
  (
    await select<StoredResult>(
      `llm_results?model_registry_id=eq.${MODEL_ID}&select=task_key,verdict,quoted_evidence,` +
        'evidence_verified,parse_ok,reason,raw_response,latency_ms&limit=5000',
    )
  ).map((r) => [
    r.task_key,
    {
      taskKey: r.task_key,
      verdict: r.verdict as LlmVerdict['verdict'],
      quotedEvidence: r.quoted_evidence,
      evidenceVerified: r.evidence_verified,
      parseOk: r.parse_ok,
      reason: r.reason,
      rawResponse: r.raw_response,
      latencyMs: r.latency_ms,
    },
  ]),
);

const provider = new OpenAiCompatibleProvider(spec);
const verdicts = new Map<string, LlmVerdict>();
let failed = 0;
let reused = 0;
let judged = 0;

console.log(`── 作答中（已判過的重用，新題才呼叫模型）── 已有紀錄 ${stored.size} 題 ──`);
for (const [index, item] of gold.entries()) {
  const cached = stored.get(item.itemKey);
  if (cached !== undefined) {
    verdicts.set(item.itemKey, cached);
    reused += 1;
    const right = cached.verdict === item.label ? '✓' : '✗';
    process.stdout.write(
      `\r  ${index + 1}/${gold.length}  ${right} ${item.code} ${cached.verdict.padEnd(8)}` +
        `（標準答案 ${item.label}）　重用          `,
    );
    continue;
  }
  try {
    const completion = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(item));
    const verdict = toVerdict(item.itemKey, item, completion.content, completion.latencyMs);
    verdicts.set(item.itemKey, verdict);
    judged += 1;

    // 逐題立刻寫入。跑十幾分鐘的實驗不該因為中途中斷就整批消失，
    // 也不該因為關掉視窗，就再也查不到模型當時究竟引用了什麼。
    await client.insert('llm_results', [
      {
        task_key: verdict.taskKey,
        model_registry_id: MODEL_ID,
        model_key: spec.modelKey,
        prompt_version: spec.promptVersion,
        role_at_run: 'challenger',
        verdict: verdict.verdict,
        quoted_evidence: verdict.quotedEvidence,
        evidence_verified: verdict.evidenceVerified,
        parse_ok: verdict.parseOk,
        reason: verdict.reason,
        raw_response: verdict.rawResponse,
        latency_ms: verdict.latencyMs,
        computed_at: new Date().toISOString(),
      },
    ]);

    const right = verdict.verdict === item.label ? '✓' : '✗';
    process.stdout.write(
      `\r  ${index + 1}/${gold.length}  ${right} ${item.code} ${verdict.verdict.padEnd(8)}` +
        `（標準答案 ${item.label}）　新判          `,
    );
  } catch (error) {
    failed += 1;
    process.stdout.write(`\r  ${index + 1}/${gold.length}  ✗ 呼叫失敗：${String(error).slice(0, 60)}\n`);
  }
}
console.log('\n');
console.log(`本次新判 ${judged} 題、重用既有紀錄 ${reused} 題、呼叫失敗 ${failed} 題`);
console.log(`逐題判定已寫入 llm_results（model_registry_id=${MODEL_ID}），可事後稽核。\n`);

const score = scoreAgainstGold(gold, verdicts);

// ── 成績 ────────────────────────────────────────────────────────────────────
function line(label: string, s: { accuracy: number; correct: number; n: number; falseNegatives: number; falsePositives: number }): string {
  return (
    `${label.padEnd(26)} ${(s.accuracy * 100).toFixed(1).padStart(5)}%　` +
    `答對 ${String(s.correct).padStart(3)}/${String(s.n).padEnd(3)}　` +
    `漏擋 ${String(s.falseNegatives).padStart(2)}　誤擋 ${String(s.falsePositives).padStart(2)}`
  );
}

console.log('── 成績 ────────────────────────────────────────────────────────');
console.log(line('baseline（永遠不否決）', baseline));
console.log(line(`挑戰者 ${spec.modelKey}`, score));
if (failed > 0) {
  console.log(`\n⚠️ 有 ${failed} 題呼叫失敗，未計入。成績只反映實際作答的 ${score.n} 題。`);
}
if (score.parseFailures > 0 || score.evidenceFailures > 0) {
  console.log(
    `\n回應品質：解析失敗 ${score.parseFailures} 題、` +
      `判否決但引用在原文中找不到而作廢 ${score.evidenceFailures} 題`,
  );
}

// ── 現役模型 ────────────────────────────────────────────────────────────────
interface ChampionRow {
  readonly id: number;
  readonly model_key: string;
  readonly gold_accuracy: string | null;
  readonly gold_sample_size: number | null;
  readonly gold_set_hash: string | null;
  readonly gold_false_negatives: number | null;
  readonly gold_false_positives: number | null;
}
const championRows = await select<ChampionRow>(
  'model_registry?role=eq.champion&model_key=not.like.__probe*&select=*&order=registered_at.desc&limit=1',
);
const champion = championRows[0];

const championScore =
  champion === undefined
    ? null
    : {
        n: champion.gold_sample_size ?? 0,
        correct: Math.round(Number(champion.gold_accuracy ?? 0) * (champion.gold_sample_size ?? 0)),
        accuracy: Number(champion.gold_accuracy ?? 0),
        falseNegatives: champion.gold_false_negatives ?? 0,
        falsePositives: champion.gold_false_positives ?? 0,
        vetoLabels: baseline.vetoLabels,
        parseFailures: 0,
        evidenceFailures: 0,
      };

if (championScore !== null && champion !== undefined) {
  console.log(line(`現役 ${champion.model_key}`, championScore));
} else {
  console.log('現役　　　　　　　　　　　（尚無 champion）');
}

// ── 晉升判定 ────────────────────────────────────────────────────────────────
const decision = evaluatePromotion({
  challenger: score,
  challengerGoldSetHash: hash,
  champion: championScore,
  championGoldSetHash: champion?.gold_set_hash ?? null,
  baseline,
});

console.log('\n── 晉升判定（五道門檻，任一不過即拒絕）────────────────────────');
for (const check of decision.checks) {
  console.log(`${check.passed ? '✓' : '✗'} ${check.name}`);
  console.log(`    ${check.detail}`);
}

console.log('');
if (!decision.promote) {
  console.log('✗ 不晉升。現役模型維持不變。');
  console.log('  這是預期會經常發生的結果——換代本身有風險，不是每次評測都該換。');
  process.exit(0);
}

console.log('✓ 五道門檻全過，可晉升為新的 champion。');
if (!WRITE) {
  console.log('\n（dry-run，未寫入 model_registry。要實際晉升請加 --write）');
  process.exit(0);
}

await client.insert('model_registry', [
  {
    model_key: spec.modelKey,
    provider: spec.provider,
    endpoint: spec.endpoint,
    role: 'champion',
    prompt_version: spec.promptVersion,
    prompt_hash: spec.promptHash,
    params_hash: spec.paramsHash,
    params_json: spec.params,
    gold_accuracy: score.accuracy,
    gold_sample_size: score.n,
    gold_set_hash: hash,
    gold_false_negatives: score.falseNegatives,
    gold_false_positives: score.falsePositives,
    promoted_from: champion?.id ?? null,
    note: `由 llm:eval 晉升，考卷 ${gold.length} 題`,
    registered_at: new Date().toISOString(),
  },
]);

console.log('\n✓ 已登記為新的 champion，切換時點寫入 model_registry，歷史全數保留。');
console.log('  提醒：config/llm.json 的 enabled 仍需為 true，這一層才會實際參與否決。');
process.exit(0);
