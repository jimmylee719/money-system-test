/**
 * 檢視某一版模型在 gold_set 上的逐題判定：`npm run llm:review`
 *   選項 --model=<registry id>（預設取最新的 challenger）
 *        --all（連答對的也列出來，預設只列答錯的）
 *
 * 【這支程式存在的理由】
 * 評測只會印出一個分數。但要回答「我的標註標準對不對」「模型是怎麼想的」，
 * 需要的是逐題的原始判定：它引用了哪一句、理由寫什麼、引用有沒有通過原文比對。
 * 那些資料由 llm:eval 寫進 llm_results（append-only），這裡把它讀回來排版。
 *
 * 【為什麼答錯的要分成兩類看】
 *   漏擋 false negative：該否決卻放行 → 進了不該進的場
 *   誤擋 false positive：不該否決卻擋下 → 錯過機會
 * 兩者代價不同、成因也不同，混在一起看不出模型到底哪裡不行。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { latestRevisions } from '../src/lib/l2/llm/gold';
import type { GoldItem, Verdict } from '../src/lib/l2/llm/types';

const args = process.argv.slice(2);
const SHOW_ALL = args.includes('--all');
const MODEL_ARG = args.find((a) => a.startsWith('--model='))?.split('=')[1];

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

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

// ── 挑一個模型版本 ──────────────────────────────────────────────────────────
interface ModelRow {
  readonly id: number;
  readonly model_key: string;
  readonly role: string;
  readonly prompt_version: string;
  readonly registered_at: string;
}

const models = await select<ModelRow>(
  'model_registry?model_key=not.like.__probe*&select=id,model_key,role,prompt_version,registered_at' +
    '&order=registered_at.desc&limit=20',
);
if (models.length === 0) {
  console.log('model_registry 裡沒有任何模型。先跑：npm run llm:eval');
  process.exit(1);
}
const model =
  MODEL_ARG === undefined ? models[0]! : models.find((m) => String(m.id) === MODEL_ARG);
if (model === undefined) {
  console.log(`查無 registry id=${MODEL_ARG}。目前有：${models.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

console.log('=== 逐題判定檢視 ===\n');
console.log(`模型　${model.model_key}（${model.role}，registry id=${model.id}）`);
console.log(`prompt　${model.prompt_version}`);
console.log(`登記於　${model.registered_at.slice(0, 19)}\n`);

// ── 讀考卷與判定 ────────────────────────────────────────────────────────────
interface GoldRow {
  readonly item_key: string;
  readonly revision: number;
  readonly code: string;
  readonly market: string;
  readonly clause: string;
  readonly subject: string;
  readonly detail: string;
  readonly label: string;
  readonly label_reason: string;
  readonly labeled_by: string;
  readonly source_id: string;
  readonly speak_date: string;
  readonly content_hash: string;
}

const gold = latestRevisions(
  (await select<GoldRow>('gold_set?item_key=not.like.__probe*&select=*&limit=5000')).map((r) => ({
    sourceId: r.source_id,
    code: r.code,
    market: r.market as GoldItem['market'],
    speakDate: r.speak_date,
    clause: r.clause,
    subject: r.subject,
    detail: r.detail,
    contentHash: r.content_hash,
    itemKey: r.item_key,
    label: r.label as Verdict,
    labelReason: r.label_reason,
    labeledBy: r.labeled_by,
    revision: r.revision,
  })),
);

interface ResultRow {
  readonly task_key: string;
  readonly verdict: string;
  readonly quoted_evidence: string;
  readonly evidence_verified: boolean;
  readonly parse_ok: boolean;
  readonly reason: string;
  readonly latency_ms: number;
}

const results = new Map(
  (
    await select<ResultRow>(
      `llm_results?model_registry_id=eq.${model.id}&task_key=not.like.__probe*&select=*&limit=5000`,
    )
  ).map((r) => [r.task_key, r]),
);

console.log(`考卷 ${gold.length} 題，本模型有判定 ${results.size} 題\n`);

// ── 逐題比對 ────────────────────────────────────────────────────────────────
const falseNegatives: { item: GoldItem; r: ResultRow }[] = [];
const falsePositives: { item: GoldItem; r: ResultRow }[] = [];
const correct: { item: GoldItem; r: ResultRow }[] = [];
const unanswered: GoldItem[] = [];

for (const item of gold) {
  const r = results.get(item.itemKey);
  if (r === undefined) {
    unanswered.push(item);
    continue;
  }
  if (r.verdict === item.label) correct.push({ item, r });
  else if (item.label === 'veto') falseNegatives.push({ item, r });
  else falsePositives.push({ item, r });
}

function show(title: string, list: readonly { item: GoldItem; r: ResultRow }[]): void {
  if (list.length === 0) {
    return;
  }
  console.log(`\n${'═'.repeat(74)}`);
  console.log(`${title}（${list.length} 題）`);
  console.log('═'.repeat(74));
  for (const { item, r } of list) {
    console.log(`\n${item.market} ${item.code}　${item.clause}`);
    console.log(`  主旨　　${item.subject.replace(/\s+/g, ' ').slice(0, 58)}`);
    console.log(`  標準答案 ${item.label}　　模型 ${r.verdict}　　${r.latency_ms}ms`);
    if (!r.parse_ok) {
      console.log('  ⚠️ 回應無法解析，依規則自動判為 no_veto');
    } else if (!r.evidence_verified) {
      console.log('  ⚠️ 模型判否決但引用與原文不完全一致，已作廢改判 no_veto');
      console.log('     （可能是捏造，也可能是簡體字或近義字轉寫——本檢查分不出來）');
    }
    if (r.quoted_evidence.trim() !== '') {
      console.log(`  模型引用　${r.quoted_evidence.replace(/\s+/g, ' ').slice(0, 62)}`);
    }
    if (r.reason.trim() !== '') {
      console.log(`  模型理由　${r.reason.replace(/\s+/g, ' ').slice(0, 62)}`);
    }
    console.log(`  你的理由　${item.labelReason.replace(/\s+/g, ' ').slice(0, 62)}`);
  }
}

show('❌ 漏擋（該否決卻放行）—— 代價是進了不該進的場', falseNegatives);
show('❌ 誤擋（不該否決卻擋下）—— 代價是錯過機會', falsePositives);
if (SHOW_ALL) {
  show('✓ 答對', correct);
}

// ── 依條款統計，看它在哪一類公告上不行 ──────────────────────────────────────
console.log(`\n${'═'.repeat(74)}`);
console.log('依條款統計');
console.log('═'.repeat(74));
const byClause = new Map<string, { n: number; wrong: number }>();
for (const { item } of [...correct, ...falseNegatives, ...falsePositives]) {
  const s = byClause.get(item.clause) ?? { n: 0, wrong: 0 };
  s.n += 1;
  byClause.set(item.clause, s);
}
for (const { item } of [...falseNegatives, ...falsePositives]) {
  byClause.get(item.clause)!.wrong += 1;
}
for (const [clause, s] of [...byClause].sort((a, b) => b[1].wrong - a[1].wrong)) {
  const bar = '█'.repeat(s.wrong);
  console.log(`  ${clause.padEnd(8)} ${String(s.n).padStart(3)} 題　答錯 ${String(s.wrong).padStart(2)} ${bar}`);
}

const answered = correct.length + falseNegatives.length + falsePositives.length;
console.log(`\n${'═'.repeat(74)}`);
console.log(
  `答對 ${correct.length}/${answered}（${answered === 0 ? 0 : ((correct.length / answered) * 100).toFixed(1)}%）　` +
    `漏擋 ${falseNegatives.length}　誤擋 ${falsePositives.length}` +
    (unanswered.length > 0 ? `　未作答 ${unanswered.length}` : ''),
);
const parseFail = [...results.values()].filter((r) => !r.parse_ok).length;
const evidenceFail = [...results.values()].filter((r) => r.parse_ok && !r.evidence_verified).length;
if (parseFail > 0 || evidenceFail > 0) {
  console.log(`回應品質：解析失敗 ${parseFail} 題　引用與原文不符而作廢 ${evidenceFail} 題`);
  console.log('　　⚠️ 作廢的引用請逐題看過：捏造與「簡體字／近義字轉寫」在紀錄上長得一樣，');
  console.log('　　　 但意義完全不同——後者代表模型其實判對了。');
}
console.log('\n這些判定永久留在 llm_results，日後覆核標註標準時看的就是這份紀錄。');
process.exit(0);
