-- =============================================================================
-- P10 — benchmark_daily：0050 的每日總報酬指數
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【CLAUDE.md：風險調整後淨報酬須勝過 0050 買入持有，否則系統無存在價值】
-- 這是 G3，也是整個專案唯一真正重要的問題。
--
-- 【必須用含息比含息】
-- 0050 每年配息。拿「0050 不含息」比「個股含息」是放水，反過來是自我懲罰。
-- total_return_index 已還原配息，close 保留原始收盤價供稽核，兩者都存。
--
-- 【0050 不在標的池】
-- 它是 ETF 不在公司名冊裡（實測確認），因此永遠不會被當成候選標的，
-- 只當基準。這是結構上的保證，不是靠約定。
-- =============================================================================

create table if not exists public.benchmark_daily (
  id                  bigint      generated always as identity primary key,

  code                text        not null,
  date                date        not null,
  /** 原始收盤價，供稽核 */
  close               numeric(12,4) not null,
  /** 當日除息金額（元／股），0 表示無 */
  cash_dividend       numeric(12,6) not null default 0,
  /** 當日配股率，0 表示無 */
  stock_dividend_ratio numeric(14,10) not null default 0,
  /** 含息總報酬指數，起點 100 */
  total_return_index  numeric(18,8) not null,

  engine_version      text        not null,
  computed_at         timestamptz not null,
  inserted_at         timestamptz not null default now(),

  constraint benchmark_daily_close_positive_check
    check (close > 0),
  constraint benchmark_daily_index_positive_check
    check (total_return_index > 0),
  constraint benchmark_daily_dividend_check
    check (cash_dividend >= 0 and stock_dividend_ratio >= 0),
  constraint benchmark_daily_no_backfill_check
    check (date >= date '2026-08-14')
);

comment on table public.benchmark_daily is
  'P10 基準（0050）每日總報酬指數。append-only：已還原配息，close 保留原值供稽核。';

create unique index if not exists benchmark_daily_code_date_uniq
  on public.benchmark_daily (code, date);
create index if not exists benchmark_daily_date_idx
  on public.benchmark_daily (date desc);

-- =============================================================================
-- 三道鎖
-- =============================================================================
alter table public.benchmark_daily enable row level security;

drop policy if exists benchmark_daily_read on public.benchmark_daily;
create policy benchmark_daily_read
  on public.benchmark_daily for select to anon, authenticated using (true);

revoke update, delete, truncate on public.benchmark_daily from public, anon, authenticated, service_role;
revoke insert                   on public.benchmark_daily from public, anon, authenticated, service_role;

grant select on public.benchmark_daily to anon, authenticated, service_role;

grant insert (
  code, date, close, cash_dividend, stock_dividend_ratio,
  total_return_index, engine_version, computed_at
) on public.benchmark_daily to service_role;

drop trigger if exists benchmark_daily_block_update on public.benchmark_daily;
create trigger benchmark_daily_block_update
  before update on public.benchmark_daily
  for each row execute function public.l0_reject_mutation();

drop trigger if exists benchmark_daily_block_delete on public.benchmark_daily;
create trigger benchmark_daily_block_delete
  before delete on public.benchmark_daily
  for each row execute function public.l0_reject_mutation();

drop trigger if exists benchmark_daily_block_truncate on public.benchmark_daily;
create trigger benchmark_daily_block_truncate
  before truncate on public.benchmark_daily
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑：
--   npm run l6:benchmark   （建立／更新 0050 指數，dry-run 預設）
--   npm run l6:g3          （與 0050 的對照報告）
-- =============================================================================
