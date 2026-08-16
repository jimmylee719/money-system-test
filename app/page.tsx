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
import type { OutcomeRow, PickRow } from '../src/lib/dashboard/queries';

export const dynamic = 'force-dynamic';

const MARKET: Record<string, string> = { TWSE: '市', TPEx: '櫃' };
const RULE: Record<string, string> = {
  attention: '注意股',
  disposition: '處置股',
  suspended: '暫停交易',
  altered_trading: '變更交易',
  source_unavailable: '資料缺漏',
};

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-neutral-100">{title}</h2>
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
                  <th className="text-right">收盤</th>
                  <th className="text-right">合成分數</th>
                  <th className="text-right">真實因子</th>
                  <th className="text-right">L2</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {watchlist.map((w: PickRow) => (
                  <tr key={w.code} className="border-b border-neutral-900">
                    <td className="py-2">{w.rank}</td>
                    <td>{w.code}</td>
                    <td className="font-sans">
                      {w.name}
                      <span className="ml-1 text-xs text-neutral-500">
                        {MARKET[w.market] ?? w.market}
                      </span>
                    </td>
                    <td className="text-right">{num(w.price_at_push)}</td>
                    <td className="text-right">{num(w.composite_score, 4)}</td>
                    <td className="text-right">
                      {w.real_factor_count}/{w.active_factors.length}
                    </td>
                    <td className="text-right">
                      {vetoedCodes.has(w.code) ? (
                        <span className="text-amber-300">擋下</span>
                      ) : (
                        <span className="text-neutral-600">通過</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
      <Section title="L2 否決" note="只能減少行動，不能產生訊號。被擋下的名次分布可看出 L2 的成本。">
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
