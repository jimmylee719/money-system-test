/**
 * Dashboard 首頁。Server Component——service role key 只在伺服器端使用。
 *
 * 【版面上兩份清單必須壁壘分明】（CLAUDE.md）
 * 觀察榜是研究紀錄，交易訊號才是可執行的。
 * 交易訊號放最上面，觀察榜每次重申「不是買進建議」。
 *
 * 【0 檔要說清楚是哪一種 0】
 * 「沒有標的通過」與「資料累積不足」都顯示 0 檔，但意義完全相反。
 */

import { loadDashboard } from '../src/lib/dashboard/queries';
// 顯示規則與 LINE 日報共用同一支 —— 兩邊各寫各的，正是這幾天所有矛盾的來源。
import {
  PLAIN_FACTORS,
  explainFactors,
  formatLots,
  formatPrice,
  priceMove,
} from '../src/lib/l4/explain';
import type { OutcomeRow, PickRow } from '../src/lib/dashboard/queries';

export const dynamic = 'force-dynamic';

const MARKET: Record<string, string> = { TWSE: '市', TPEx: '櫃' };
const RULE: Record<string, string> = {
  attention: '注意股',
  disposition: '處置股',
  suspended: '暫停交易',
  altered_trading: '變更交易',
  margin_suspension: '停資停券',
  source_unavailable: '資料缺漏',
};

/**
 * `date` 只給「內容會隨交易日改變」的區塊用。
 *
 * 【為什麼每個區塊都要自己帶日期】
 * 2026-08-19 使用者實際反映：觀察榜看不到日期。
 * 頁首其實有「資料日 2026-08-18」，但手機往下捲到觀察榜時它早就滑出畫面了。
 * 觀察榜是研究紀錄，**日期就是紀錄本身**——CLAUDE.md 把 data_as_of 列為必含欄位，
 * 正是因為看不到日期的清單無法判斷有沒有前視偏誤。放在頁首等於沒放。
 */
function Section({
  title,
  note,
  date,
  children,
}: {
  title: string;
  note?: string;
  date?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-1 flex flex-wrap items-baseline gap-2 text-lg font-semibold text-neutral-100">
        {title}
        {date !== undefined && (
          <span className="rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-xs font-normal text-neutral-400">
            資料日 {date ?? '尚無資料'}
          </span>
        )}
      </h2>
      {note !== undefined && <p className="mb-3 text-sm text-neutral-400">{note}</p>}
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="mt-1 font-mono text-2xl text-neutral-100">{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}

function num(value: string | null, digits = 2): string {
  return value === null ? '—' : Number(value).toFixed(digits);
}

function outcomeSummary(rows: readonly OutcomeRow[], horizon: number, kind: string) {
  const subset = rows.filter((r) => r.horizon === horizon && r.list_kind === kind);
  if (subset.length === 0) {
    return null;
  }
  const values = subset.map((r) => Number(r.adjusted_return_pct));
  return { n: subset.length, mean: values.reduce((s, v) => s + v, 0) / values.length };
}

export default async function Page() {
  const data = await loadDashboard();
  const signals = data.picks.rows.filter((p) => p.list_kind === 'trade_signal');
  const watchlist = data.picks.rows.filter((p) => p.list_kind === 'watchlist');
  const sample = watchlist[0];
  const inactive = sample?.inactive_factors ?? [];

  const vetoCounts = new Map<string, number>();
  for (const v of data.vetoes.rows) {
    vetoCounts.set(v.rule_id, (vetoCounts.get(v.rule_id) ?? 0) + 1);
  }
  const vetoedCodes = new Set(data.vetoes.rows.map((v) => v.code));

  const benchmarkFirst = data.benchmark.rows[0];
  const benchmarkLast = data.benchmark.rows[data.benchmark.rows.length - 1];
  const benchmarkReturn =
    benchmarkFirst === undefined || benchmarkLast === undefined
      ? null
      : (Number(benchmarkLast.total_return_index) / Number(benchmarkFirst.total_return_index) - 1) *
        100;

  const missing = [
    data.picks.missing && 'daily_picks',
    data.vetoes.missing && 'veto_events',
    data.outcomes.missing && 'outcomes',
    data.benchmark.missing && 'benchmark_daily',
  ].filter((x): x is string => typeof x === 'string');

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 border-b border-neutral-800 pb-5">
        <h1 className="text-2xl font-bold text-neutral-50">台股分析交易助手</h1>
        <p className="mt-1 text-sm text-neutral-400">
          資料日 {data.latestDate ?? '尚無資料'}　·　v1 只通知與紀錄，不下單
        </p>
      </header>

      {missing.length > 0 && (
        <div className="mb-8 rounded border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          尚未建立的資料表：{missing.join('、')}。相關區塊為空白，不代表沒有資料。
        </div>
      )}

      {/* ── 交易訊號：唯一可執行的東西，放最前面 ── */}
      <Section
        title="交易訊號"
        date={data.latestDate}
        note="通過 L1 排序、L2 否決、L3 風控三關者。經常是 0 檔，那是正常且健康的。"
      >
        {signals.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-900/50 p-4 text-sm">
            <p className="text-neutral-200">今日 0 檔。</p>
            {inactive.length > 0 && (
              <p className="mt-2 text-neutral-400">
                ⚠️ 目前有 {inactive.length} 個因子停用中：
                {inactive.map((f) => f.reason).join('；')}
                <br />
                在資料累積足夠之前，0 檔多半是「資料還不夠」而不是「沒有機會」。
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-400">
                <tr className="border-b border-neutral-800">
                  <th className="py-2">代號</th>
                  <th>名稱</th>
                  <th className="text-right">進場</th>
                  <th className="text-right">停損</th>
                  <th className="text-right">停利</th>
                  <th className="text-right">股數</th>
                  <th className="text-right">部位</th>
                  <th className="text-right">時間出場</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {signals.map((s) => (
                  <tr key={s.code} className="border-b border-neutral-900">
                    <td className="py-2">{s.code}</td>
                    <td className="font-sans">
                      {s.name}
                      <span className="ml-1 text-xs text-neutral-500">
                        {MARKET[s.market] ?? s.market}
                      </span>
                    </td>
                    <td className="text-right">{num(s.entry_price)}</td>
                    <td className="text-right text-red-300">{num(s.stop_price)}</td>
                    <td className="text-right text-emerald-300">{num(s.take_profit_price)}</td>
                    <td className="text-right">{s.shares ?? '—'}</td>
                    <td className="text-right">
                      {s.position_value_twd === null
                        ? '—'
                        : Math.round(Number(s.position_value_twd)).toLocaleString()}
                    </td>
                    <td className="text-right">{s.time_exit_days ?? '—'} 日</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── 觀察榜 ── */}
      <Section
        title="觀察榜 Top 5"
        date={data.latestDate}
        note="⚠️ 研究紀錄，不是買進建議。依 L1 排名產生，不受 L2／L3 影響——那正是衡量兩層的對照組。"
      >
        {watchlist.length === 0 ? (
          <p className="text-sm text-neutral-400">尚無資料。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-400">
                <tr className="border-b border-neutral-800">
                  <th className="py-2">#</th>
                  <th>代號</th>
                  <th>名稱</th>
                  <th className="text-right">昨收</th>
                  <th className="text-right">收盤</th>
                  <th className="text-right">漲跌</th>
                  <th className="text-right">成交</th>
                  <th className="text-right">合成分數</th>
                  <th className="text-right">L2</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {watchlist.map((w: PickRow) => {
                  // 【?? 而不是 === null】
                  // 0013 尚未執行時，PostgREST 回來的列根本沒有這些鍵，值是 undefined。
                  // 用 === null 判斷會漏掉 undefined，接著 Number(undefined) 得到 NaN，
                  // 畫面就會顯示「昨收 NaN」。Dashboard 一 push 就重新佈署，
                  // 一定會有一段時間先於 migration，所以這裡必須擋得住。
                  const rawChange = w.change_amount ?? null;
                  const move = priceMove(
                    Number(w.price_at_push),
                    rawChange === null ? null : Number(rawChange),
                    w.change_note ?? null,
                  );
                  return (
                    <tr key={w.code} className="border-b border-neutral-900">
                      <td className="py-2">{w.rank}</td>
                      <td>{w.code}</td>
                      <td className="font-sans">
                        {w.name}
                        <span className="ml-1 text-xs text-neutral-500">
                          {MARKET[w.market] ?? w.market}
                        </span>
                      </td>
                      <td className="text-right text-neutral-400">
                        {formatPrice(move.prevClose)}
                      </td>
                      <td className="text-right">{formatPrice(move.close)}</td>
                      <td
                        className={`text-right ${
                          move.arrow === '▲'
                            ? 'text-red-300'
                            : move.arrow === '▼'
                              ? 'text-emerald-300'
                              : 'text-neutral-500'
                        }`}
                      >
                        {move.text}
                      </td>
                      <td className="text-right text-neutral-400">
                        {formatLots(w.volume_shares ?? null)}
                      </td>
                      <td className="text-right">{num(w.composite_score, 4)}</td>
                      <td className="text-right">
                        {vetoedCodes.has(w.code) ? (
                          <span className="text-amber-300">擋下</span>
                        ) : (
                          <span className="text-neutral-600">通過</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/*
        ── 上榜理由 ──
        2026-08-20 使用者回饋：「讓一般人一看也能夠了解這股票漲或跌是因為發生什麼事」。
        這裡只列出**已登記因子的原始值**，那是這檔排進前五名的全部依據。

        ⚠️ 這是「為什麼它排名靠前」，不是「為什麼它今天漲」。
        兩者不可混為一談 —— 因子取的是昨天以前的資料，今天的漲跌另有原因，
        本系統沒有能力也不打算解釋當日漲跌。硬要解釋就是編故事。
      */}
      {watchlist.length > 0 && (
        <Section
          title="為什麼這五檔上榜"
          date={data.latestDate}
          note="這些是排名的全部依據。⚠️ 這是「為什麼排名靠前」，不是「為什麼今天漲跌」——本系統不解釋當日漲跌，那需要的資料我們沒有。"
        >
          <div className="space-y-3">
            {watchlist.map((w: PickRow) => {
              const factors = explainFactors(w.factor_scores ?? []);
              return (
                <div key={w.code} className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
                  <div className="mb-2 text-sm text-neutral-200">
                    <span className="font-mono">{w.rank}. {w.code}</span> {w.name}
                    <span className="ml-2 font-mono text-xs text-neutral-500">
                      分數 {num(w.composite_score, 4)}　{w.real_factor_count}/
                      {w.active_factors.length} 項有資料
                    </span>
                  </div>
                  {factors.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      本列沒有留存因子明細（2026-08-19 以前的紀錄）。
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                      {factors.map((f) => (
                        <div key={f.factorKey} className="flex justify-between text-sm">
                          <span className="text-neutral-400">
                            {f.label}
                            <span className="ml-1 text-xs text-neutral-600">
                              （{f.betterWhen === 'higher' ? '越高越前面' : '越低越前面'}）
                            </span>
                          </span>
                          <span className="font-mono text-neutral-100">{f.valueText}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── 名詞解釋 ── 每個因子在講什麼，用白話講一次 */}
      <Section
        title="名詞解釋"
        note="上面那些數字各自是什麼意思。這些定義在因子登記時就鎖住，事後不得調整。"
      >
        <dl className="space-y-3">
          {Object.entries(PLAIN_FACTORS).map(([key, plain]) => (
            <div key={key} className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
              <dt className="text-sm font-semibold text-neutral-100">
                {plain.label}
                <span className="ml-2 text-xs font-normal text-neutral-500">
                  {plain.betterWhen === 'higher' ? '數字越高排名越前面' : '數字越低排名越前面'}
                </span>
              </dt>
              <dd className="mt-1 text-sm text-neutral-400">{plain.meaning}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* ── G3 對照 ── */}
      <Section
        title="G3：與 0050 的對照"
        note="風險調整後淨報酬須勝過 0050 買入持有，否則系統無存在價值。樣本 < 30 筆不下結論。"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="0050 含息報酬"
            value={benchmarkReturn === null ? '—' : `${benchmarkReturn.toFixed(2)}%`}
            hint={
              benchmarkFirst === undefined
                ? '尚無基準資料'
                : `${benchmarkFirst.date} 起 ${data.benchmark.rows.length} 天`
            }
          />
          {[5, 10, 20].map((h) => {
            const s = outcomeSummary(data.outcomes.rows, h, 'watchlist');
            return (
              <Stat
                key={h}
                label={`觀察榜 T+${h}`}
                value={s === null ? '—' : `${s.mean.toFixed(2)}%`}
                hint={s === null ? '尚未到期' : `${s.n} 筆${s.n < 30 ? '（不足 30，不下結論）' : ''}`}
              />
            );
          })}
        </div>
      </Section>

      {/* ── L2 否決 ── */}
      <Section
        title="L2 否決"
        date={data.latestDate}
        note="只能減少行動，不能產生訊號。被擋下的名次分布可看出 L2 的成本。"
      >
        {data.vetoes.rows.length === 0 ? (
          <p className="text-sm text-neutral-400">當日無否決紀錄。</p>
        ) : (
          <div className="flex flex-wrap gap-3 text-sm">
            {[...vetoCounts.entries()].map(([rule, count]) => (
              <span
                key={rule}
                className="rounded border border-neutral-800 bg-neutral-900/50 px-3 py-1.5"
              >
                {RULE[rule] ?? rule}　<span className="font-mono text-neutral-300">{count}</span>
              </span>
            ))}
            <span className="rounded border border-neutral-800 bg-neutral-900/50 px-3 py-1.5">
              相異標的　<span className="font-mono text-neutral-300">{vetoedCodes.size}</span>
            </span>
          </div>
        )}
      </Section>

      {/* ── L2b：本機 LLM ── */}
      <Section
        title="L2b：本機 LLM 否決（選配）"
        note="讀重大訊息原文判斷有無已發生的負面事實。只能否決，資料層無法表達買進訊號。判否決必須引用原文，引用在原文中找不到即作廢。"
      >
        {data.llm.missing ? (
          <p className="text-sm text-neutral-400">尚未建立 llm_queue（0012 migration 未執行）。</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="現役模型"
                value={data.llm.championModel === null ? '無' : '有'}
                hint={data.llm.championModel ?? '沒有模型考過 gold_set，此層未上線'}
              />
              <Stat
                label="公告佇列"
                value={String(data.llm.queueTotal)}
                hint={`已判 ${data.llm.judgedTotal}`}
              />
              <Stat
                label="未判"
                value={String(Math.max(0, data.llm.queueTotal - data.llm.judgedTotal))}
                hint="worker 未跑完；未判不會產生否決"
              />
              <Stat
                label="gold_set"
                value={`${data.llm.goldTotal}`}
                hint={`其中應否決 ${data.llm.goldVetoLabels}　需 ≥30 才能評測`}
              />
            </div>
            {/*
              【沒有 champion 時，佇列積壓完全不是重點】
              舊版不分情況都說「未判的公告等於今天少擋了」，那句話預設「已判的正在生效」。
              但沒有 champion 時**整層都不生效**——已判的 35 則是評測跑出來的考卷答案，
              不是上線後的篩選結果，一則否決都沒有套用到任何清單上。
              把缺口說成 160 會讓人以為只差那些；實際上是 195 則全部沒被看過。
            */}
            {data.llm.championModel === null ? (
              <p className="mt-3 text-sm text-amber-200">
                ⚠️ 此層整層未生效。沒有模型通過 gold_set，
                因此佇列裡 {data.llm.queueTotal} 則公告**全部**沒有被套用任何否決——
                不只是未判的那些。上方「已判 {data.llm.judgedTotal}」是評測時跑的考卷答案，
                不是上線後的篩選紀錄。
              </p>
            ) : (
              data.llm.queueTotal > data.llm.judgedTotal && (
                <p className="mt-3 text-sm text-amber-200">
                  ⚠️ 有 {data.llm.queueTotal - data.llm.judgedTotal} 則公告尚未判定。
                  這一層不 fail-closed（不會因為沒判完就全部擋掉），
                  所以未判的公告等於今天少擋了——這個數字就是那個缺口。
                </p>
              )
            )}
          </>
        )}
      </Section>

      {/* ── 閘門進度 ── */}
      <Section title="自動下單解鎖閘門" note="五道全部通過才進 v2。目前 v1 不具備任何下單功能。">
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {[
            ['G1', '≥6 個月且 ≥100 筆訊號', `目前 ${data.tradeSignalTotal} 筆`],
            ['G2', 'Expectancy>0 且 PF>1.3', '待 outcomes 累積'],
            ['G3', '勝過 0050', data.outcomes.rows.length === 0 ? '待 outcomes 累積' : '見上方'],
            ['G4', '人工執行一致率 >90%', `已記錄 ${data.userRecordCount} 筆`],
            ['G5', '資料管線連續 60 日零故障', '見 ops/ingest-log.jsonl'],
          ].map(([id, desc, status]) => (
            <div
              key={id}
              className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2"
            >
              <span>
                <span className="font-mono text-neutral-400">{id}</span>　{desc}
              </span>
              <span className="text-neutral-500">{status}</span>
            </div>
          ))}
        </div>
      </Section>

      <footer className="mt-12 border-t border-neutral-800 pt-5 text-xs leading-relaxed text-neutral-500">
        <p>
          已登記因子 {data.factorCount} 個　·　風控設定 {data.riskConfigVersion ?? '未登記'}
          　·　排序池 {sample?.ranked_count.toLocaleString() ?? '—'} 檔
        </p>
        <p className="mt-2">
          本頁內容由 AI 系統自動產生（歐盟 AI Act 第 50 條、台灣 AI 基本法）。
          不構成投資建議，僅為個人研究紀錄。本站為私人用途，不對外提供個股建議。
        </p>
      </footer>
    </main>
  );
}
