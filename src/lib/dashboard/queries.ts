/**
 * Dashboard 的資料查詢。**只在伺服器端執行**。
 *
 * ⚠️ 這裡用 service role key，絕不可被打包進瀏覽器程式碼。
 *    使用它的檔案必須是 Server Component（沒有 'use client'）。
 *
 * 【缺表回空陣列，不讓整頁掛掉】
 * 各 migration 是分批執行的，Dashboard 應該在任何階段都打得開；
 * 缺哪張表會明確顯示在頁面上，不會被誤讀成「這張表沒有資料」。
 */

import 'server-only';

/** 探針列的過濾條件（各表的探針標記方式不同） */
const PROBE_FILTERS = {
  dailyPicks: 'revision=lt.1000',
  vetoEvents: 'code=not.like.__probe*',
  outcomes: 'pick_id=lt.900000000',
  benchmark: 'code=eq.0050',
  userRecords: 'line_message_id=not.like.__probe*',
  llm: 'task_key=not.like.__probe*',
} as const;

export interface QueryResult<T> {
  readonly rows: readonly T[];
  /** 資料表尚未建立 */
  readonly missing: boolean;
}

async function query<T>(pathAndQuery: string): Promise<QueryResult<T>> {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (url === undefined || key === undefined) {
    throw new Error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  }
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    // 每次進頁面都重新取，不要快取住昨天的清單
    cache: 'no-store',
  });
  if (res.status === 404) {
    return { rows: [], missing: true };
  }
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return { rows: (await res.json()) as readonly T[], missing: false };
}

export interface PickRow {
  readonly data_as_of: string;
  readonly list_kind: 'watchlist' | 'trade_signal';
  readonly rank: number;
  readonly code: string;
  readonly name: string;
  readonly market: string;
  readonly price_at_push: string;
  readonly composite_score: string;
  readonly real_factor_count: number;
  readonly active_factors: readonly string[];
  readonly inactive_factors: readonly { factorKey: string; reason: string }[];
  readonly ranked_count: number;
  readonly entry_price: string | null;
  readonly stop_price: string | null;
  readonly take_profit_price: string | null;
  readonly shares: number | null;
  readonly position_value_twd: string | null;
  readonly time_exit_days: number | null;
}

export interface VetoRow {
  readonly data_as_of: string;
  readonly code: string;
  readonly rule_id: string;
  readonly reason: string;
  readonly rank_at_signal: number | null;
}

export interface OutcomeRow {
  readonly data_as_of: string;
  readonly code: string;
  readonly list_kind: string;
  readonly horizon: number;
  readonly adjusted_return_pct: string;
  readonly raw_return_pct: string;
  readonly barrier_touched: string | null;
}

export interface BenchmarkRow {
  readonly date: string;
  readonly close: string;
  readonly total_return_index: string;
}

/**
 * P11 LLM 層的狀態。
 *
 * 「佇列裡有幾則還沒判」必須看得見：那一層沒跑完時不會 fail-closed，
 * 也就是說它會安靜地少擋一些東西。安靜的洞要在畫面上補成一個數字。
 */
export interface LlmStatus {
  readonly missing: boolean;
  readonly championModel: string | null;
  readonly queueTotal: number;
  readonly judgedTotal: number;
  readonly vetoTotal: number;
  readonly goldTotal: number;
  readonly goldVetoLabels: number;
}

export interface DashboardData {
  readonly latestDate: string | null;
  readonly picks: QueryResult<PickRow>;
  readonly vetoes: QueryResult<VetoRow>;
  readonly outcomes: QueryResult<OutcomeRow>;
  readonly benchmark: QueryResult<BenchmarkRow>;
  readonly userRecordCount: number;
  readonly tradeSignalTotal: number;
  readonly factorCount: number;
  readonly riskConfigVersion: string | null;
  readonly llm: LlmStatus;
}

export async function loadDashboard(): Promise<DashboardData> {
  const latest = await query<{ data_as_of: string }>(
    `daily_picks?${PROBE_FILTERS.dailyPicks}&select=data_as_of&order=data_as_of.desc&limit=1`,
  );
  const latestDate = latest.rows[0]?.data_as_of ?? null;

  /**
   * 同一天可能有多個 revision。
   *
   * ⚠️ 2026-08-16 實測抓到的錯誤：只過濾 revision < 1000 會把
   *    revision 1 與 revision 2 一起撈出來，畫面上每一檔都出現兩次。
   *    數字本身沒錯，但每檔被算了兩次——這種錯誤不會報錯，只會誤導。
   *
   * 設計上「同一天出第二份清單」必須明確指定新的 revision，兩份都永久留存
   * （見 0006 migration）。顯示時**只看最新的那一份**，
   * 舊版本仍在資料庫裡可稽核。
   */
  const revisionRow =
    latestDate === null
      ? { rows: [], missing: false }
      : await query<{ revision: number }>(
          `daily_picks?${PROBE_FILTERS.dailyPicks}&data_as_of=eq.${latestDate}` +
            '&select=revision&order=revision.desc&limit=1',
        );
  const latestRevision = revisionRow.rows[0]?.revision ?? 1;

  const [picks, vetoes, outcomes, benchmark, records, allSignals, factors, risk] =
    await Promise.all([
      latestDate === null
        ? Promise.resolve<QueryResult<PickRow>>({ rows: [], missing: latest.missing })
        : query<PickRow>(
            `daily_picks?${PROBE_FILTERS.dailyPicks}&data_as_of=eq.${latestDate}` +
              `&revision=eq.${latestRevision}&select=*&order=list_kind.asc,rank.asc`,
          ),
      latestDate === null
        ? Promise.resolve<QueryResult<VetoRow>>({ rows: [], missing: false })
        : query<VetoRow>(
            `veto_events?${PROBE_FILTERS.vetoEvents}&data_as_of=eq.${latestDate}` +
              '&select=data_as_of,code,rule_id,reason,rank_at_signal&order=rank_at_signal.asc',
          ),
      query<OutcomeRow>(
        `outcomes?${PROBE_FILTERS.outcomes}&select=data_as_of,code,list_kind,horizon,` +
          'adjusted_return_pct,raw_return_pct,barrier_touched&order=data_as_of.desc',
      ),
      query<BenchmarkRow>(
        `benchmark_daily?${PROBE_FILTERS.benchmark}&select=date,close,total_return_index&order=date.asc`,
      ),
      query<{ id: number }>(`user_records?${PROBE_FILTERS.userRecords}&select=id`),
      // G1 計數同樣要去重：同一天的多個 revision 不是多筆訊號。
      // 以 (data_as_of, code) 為鍵去重，而不是直接數列數。
      query<{ data_as_of: string; code: string }>(
        `daily_picks?${PROBE_FILTERS.dailyPicks}&list_kind=eq.trade_signal&select=data_as_of,code`,
      ),
      query<{ id: number }>('factor_registry?factor_key=not.like.probe_*&select=id'),
      query<{ version: string }>('risk_config?select=version&order=registered_at.desc&limit=1'),
    ]);

  const [champion, llmQueue, llmResults, goldRows] = await Promise.all([
    query<{ model_key: string }>(
      'model_registry?role=eq.champion&model_key=not.like.__probe*' +
        '&select=model_key&order=registered_at.desc&limit=1',
    ),
    query<{ task_key: string }>(`llm_queue?${PROBE_FILTERS.llm}&select=task_key`),
    query<{ task_key: string; verdict: string }>(
      `llm_results?${PROBE_FILTERS.llm}&select=task_key,verdict`,
    ),
    query<{ item_key: string; label: string }>(
      'gold_set?item_key=not.like.__probe*&select=item_key,label',
    ),
  ]);

  return {
    latestDate,
    picks,
    vetoes,
    outcomes,
    benchmark,
    userRecordCount: records.rows.length,
    tradeSignalTotal: new Set(allSignals.rows.map((s) => `${s.data_as_of}|${s.code}`)).size,
    factorCount: factors.rows.length,
    riskConfigVersion: risk.rows[0]?.version ?? null,
    llm: {
      missing: llmQueue.missing,
      championModel: champion.rows[0]?.model_key ?? null,
      queueTotal: llmQueue.rows.length,
      // 同一則公告若被多個模型判過，只算一則已判
      judgedTotal: new Set(llmResults.rows.map((r) => r.task_key)).size,
      vetoTotal: llmResults.rows.filter((r) => r.verdict === 'veto').length,
      goldTotal: new Set(goldRows.rows.map((r) => r.item_key)).size,
      goldVetoLabels: goldRows.rows.filter((r) => r.label === 'veto').length,
    },
  };
}
