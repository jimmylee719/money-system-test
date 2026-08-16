-- =============================================================================
-- P9 — outcomes：訊號發出後的實際結果
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【這張表是整個系統唯一的成績單】
-- G1（≥100 筆訊號）、G2（期望值 >0、獲利因子 >1.3）、G3（勝過 0050）
-- 全部建立在這裡的數字上。算錯不會有人抗議，只會讓錯誤的結論看起來很可信。
--
-- 【CLAUDE.md：僅系統可寫，人工不可改】
-- 因此除了三道鎖之外，還有一個關鍵差異：**它沒有任何人工輸入的欄位**。
-- 所有數值都由 daily_picks（系統當時說了什麼）與 L0 行情（後來發生什麼）
-- 機械式推導而來，沒有任何一格可以「憑印象填」。
--
-- 【raw 與 adjusted 兩個報酬都存】
-- 兩者的差額就是除權息造成的低估幅度，可以直接稽核還原有沒有生效。
-- 只存一個的話，還原算錯了也看不出來。
--
-- 【未到期就不寫】
-- status = 'not_mature' 的結果不會寫進來。只過 3 天就寫 T+5 的數字，
-- 那個值是錯的而且事後看不出來。
-- =============================================================================

create table if not exists public.outcomes (
  id                      bigint      generated always as identity primary key,

  -- 對應的 daily_picks 列。那是「系統當時說了什麼」的唯一依據。
  pick_id                 bigint      not null,
  data_as_of              date        not null,
  code                    text        not null,
  market                  text        not null,
  list_kind               text        not null,
  /** 觀察期（交易日）：5 / 10 / 20 */
  horizon                 integer     not null,

  -- 出場
  exit_date               date        not null,
  entry_price             numeric(12,4) not null,
  exit_price              numeric(12,4) not null,

  -- 報酬（%）
  /** 未還原除權息的帳面報酬 */
  raw_return_pct          numeric(12,6) not null,
  /** 還原除權息後的含息總報酬。**評估一律用這個。** */
  adjusted_return_pct     numeric(12,6) not null,

  -- 還原明細（供稽核，不是裝飾）
  share_factor            numeric(14,10) not null default 1,
  cash_dividend_per_share numeric(12,6)  not null default 0,
  ex_right_count          integer        not null default 0,
  /** 期間內有現金增資。本系統不認購故不還原，但 P12 可據此排除觀察值。 */
  has_rights_issue        boolean        not null default false,

  -- 屏障（僅 trade_signal；觀察榜為 null）
  barrier_touched         text,
  barrier_touch_date      date,

  -- 稽核
  trading_days_used       integer     not null,
  /** 計算時使用的引擎版本，規則變動時可回溯 */
  engine_version          text        not null,
  computed_at             timestamptz not null,
  inserted_at             timestamptz not null default now(),

  constraint outcomes_horizon_check
    check (horizon in (5, 10, 20)),
  constraint outcomes_list_kind_check
    check (list_kind in ('watchlist', 'trade_signal')),
  constraint outcomes_market_check
    check (market in ('TWSE', 'TPEx')),
  constraint outcomes_prices_positive_check
    check (entry_price > 0 and exit_price > 0),
  constraint outcomes_exit_after_signal_check
    check (exit_date > data_as_of),
  constraint outcomes_trading_days_check
    check (trading_days_used = horizon),
  constraint outcomes_share_factor_check
    check (share_factor >= 1),
  constraint outcomes_barrier_check
    check (barrier_touched is null or barrier_touched in ('stop', 'target', 'time')),
  -- 觀察榜沒有屏障，交易訊號一定要有
  constraint outcomes_barrier_by_kind_check
    check (
      (list_kind = 'watchlist' and barrier_touched is null)
      or (list_kind = 'trade_signal' and barrier_touched is not null)
    ),
  -- L0 自 2026-08-14 才開始累積
  constraint outcomes_no_backfill_check
    check (data_as_of >= date '2026-08-14')
);

comment on table public.outcomes is
  'P9 訊號結果。append-only 且僅系統可寫：沒有任何人工輸入欄位，全部由 daily_picks 與行情機械推導。';

-- 同一筆 pick 的同一個觀察期只能有一列
create unique index if not exists outcomes_pick_horizon_uniq
  on public.outcomes (pick_id, horizon);

create index if not exists outcomes_date_horizon_idx
  on public.outcomes (data_as_of desc, horizon);
create index if not exists outcomes_code_idx
  on public.outcomes (code, data_as_of desc);
create index if not exists outcomes_kind_idx
  on public.outcomes (list_kind, horizon);

-- =============================================================================
-- 三道鎖
-- =============================================================================
alter table public.outcomes enable row level security;

drop policy if exists outcomes_read on public.outcomes;
create policy outcomes_read
  on public.outcomes for select to anon, authenticated using (true);

revoke update, delete, truncate on public.outcomes from public, anon, authenticated, service_role;
revoke insert                   on public.outcomes from public, anon, authenticated, service_role;

grant select on public.outcomes to anon, authenticated, service_role;

-- inserted_at 與 id 不開放。computed_at 開放，因為那是計算時點的觀察值。
grant insert (
  pick_id, data_as_of, code, market, list_kind, horizon,
  exit_date, entry_price, exit_price,
  raw_return_pct, adjusted_return_pct,
  share_factor, cash_dividend_per_share, ex_right_count, has_rights_issue,
  barrier_touched, barrier_touch_date,
  trading_days_used, engine_version, computed_at
) on public.outcomes to service_role;

drop trigger if exists outcomes_block_update on public.outcomes;
create trigger outcomes_block_update
  before update on public.outcomes
  for each row execute function public.l0_reject_mutation();

drop trigger if exists outcomes_block_delete on public.outcomes;
create trigger outcomes_block_delete
  before delete on public.outcomes
  for each row execute function public.l0_reject_mutation();

drop trigger if exists outcomes_block_truncate on public.outcomes;
create trigger outcomes_block_truncate
  before truncate on public.outcomes
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑：
--   npm run l5:verify     （實測三道鎖與 constraint）
--   npm run l5:outcomes   （dry-run，計算並列出結果，不寫入）
-- =============================================================================
