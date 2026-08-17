/**
 * Champion / Challenger 評測與晉升：
 *   `npm run llm:eval`              考一次並印出成績與晉升判定（不寫入）
 *   `npm run llm:eval -- --write`   通過五道門檻才登記為新的 champion
 *   `npm run llm:eval -- --register` 只把挑戰者登記成 challenger（不評測、不晉升）
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
const provider = new OpenAiCompatibleProvider(spec);
const verdicts = new Map<string, LlmVerdict>();
let failed = 0;

console.log('── 作答中（每題都會實際呼叫一次本機模型）────────────────────────');
for (const [index, item] of gold.entries()) {
  try {
    const completion = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(item));
    const verdict = toVerdict(item.itemKey, item, completion.content, completion.latencyMs);
    verdicts.set(item.itemKey, verdict);
    const right = verdict.verdict === item.label ? '✓' : '✗';
    process.stdout.write(
      `\r  ${index + 1}/${gold.length}  ${right} ${item.code} ${verdict.verdict.padEnd(8)}` +
        `（標準答案 ${item.label}）           `,
    );
  } catch (error) {
    failed += 1;
    process.stdout.write(`\r  ${index + 1}/${gold.length}  ✗ 呼叫失敗：${String(error).slice(0, 60)}\n`);
  }
}
console.log('\n');

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
