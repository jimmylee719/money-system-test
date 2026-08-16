-- =============================================================================
-- P7 — L3 風控：risk_config 登記 + daily_picks 補上交易訊號欄位
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼風控設定也要登記並鎖定】
-- 風控參數和因子一樣會被事後合理化：虧了就放寬停損、賺了就調高部位。
-- 那比調因子更危險——因子調錯只是訊號變差，風控調錯是直接爆倉。
-- 故與 factor_registry 同樣處理：設定物件算 SHA-256 登記，
-- 引擎執行前核對雜湊，對不上就拒絕出訊號。改設定必然留下痕跡。
--
-- 【資金是設定值不是常數】
-- 使用者選擇「先用假設值 100 萬跑，之後再改」。改資金會換一個雜湊，
-- 因此前後期的部位紀錄可以明確區分，不會混在一起算績效。
--
-- 【交易訊號與觀察榜同表不同 list_kind，但欄位要求完全不同】
-- 觀察榜是研究紀錄，沒有部位；交易訊號必須帶三道屏障與張數。
-- 用 CHECK constraint 強制：trade_signal 缺任一屏障欄位即拒絕寫入，
-- watchlist 帶了屏障欄位也拒絕——避免研究紀錄被誤讀成可執行的訊號。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- risk_config：append-only 的風控設定登記本
-- ---------------------------------------------------------------------------
create table if not exists public.risk_config (
  id                bigint      generated always as identity primary key,
  version           text        not null,
  /** 設定物件的正規化 JSON */
  config            jsonb       not null,
  /** config 的 SHA-256。引擎執行前比對，對不上就拒絕出訊號。 */
  config_hash       text        not null,
  /** 這份設定為什麼是這些數字。空白即拒絕——與因子的 economic_rationale 同理。 */
  rationale         text        not null,
  registered_by     text        not null,
  registered_at     timestamptz not null default now(),
  inserted_at       timestamptz not null default now(),

  constraint risk_config_hash_format
    check (config_hash ~ '^[0-9a-f]{64}$'),
  constraint risk_config_rationale_not_blank
    check (length(btrim(rationale)) >= 50),
  constraint risk_config_version_not_blank
    check (length(btrim(version)) > 0)
);

comment on table public.risk_config is
  'P7 風控設定登記本。append-only：改任何數字都必須新增一列，歷史永遠可回溯。';

-- 同一個版本號只能登記一次；改了內容就必須換版本號
create unique index if not exists risk_config_version_uniq on public.risk_config (version);
create unique index if not exists risk_config_hash_uniq on public.risk_config (config_hash);

-- ---------------------------------------------------------------------------
-- daily_picks：補上交易訊號專用欄位（觀察榜維持為 null）
-- ---------------------------------------------------------------------------
alter table public.daily_picks
  add column if not exists entry_price          numeric(12,4),
  add column if not exists stop_price           numeric(12,4),
  add column if not exists take_profit_price    numeric(12,4),
  add column if not exists time_exit_days       integer,
  add column if not exists lots                 integer,
  add column if not exists shares               integer,
  add column if not exists position_value_twd   numeric(18,2),
  add column if not exists risk_amount_twd      numeric(18,2),
  add column if not exists sigma_daily          numeric(14,10),
  add column if not exists vol_observations     integer,
  add column if not exists equity_at_signal_twd numeric(18,2),
  add column if not exists risk_config_version  text,
  add column if not exists risk_config_hash     text;

-- 交易訊號必須帶齊三道屏障與部位；觀察榜必須完全不帶。
-- 兩者混淆的後果是把「研究紀錄」當成「可執行訊號」，那是這個系統最不該犯的錯。
alter table public.daily_picks
  drop constraint if exists daily_picks_signal_fields_check;
alter table public.daily_picks
  add constraint daily_picks_signal_fields_check check (
    (list_kind = 'trade_signal' and
       entry_price is not null and stop_price is not null and
       take_profit_price is not null and time_exit_days is not null and
       lots is not null and shares is not null and
       position_value_twd is not null and risk_amount_twd is not null and
       sigma_daily is not null and equity_at_signal_twd is not null and
       risk_config_version is not null and risk_config_hash is not null)
    or
    (list_kind = 'watchlist' and
       entry_price is null and stop_price is null and
       take_profit_price is null and time_exit_days is null and
       lots is null and shares is null and
       position_value_twd is null and risk_amount_twd is null and
       sigma_daily is null and equity_at_signal_twd is null and
       risk_config_version is null and risk_config_hash is null)
  );

-- 三道屏障的順序必須正確：停損 < 進場 < 停利。
-- 「獲利就賣」在這個系統是被 CLAUDE.md 禁止的，停利必須高於進場價。
alter table public.daily_picks
  drop constraint if exists daily_picks_barrier_order_check;
alter table public.daily_picks
  add constraint daily_picks_barrier_order_check check (
    entry_price is null or
    (stop_price > 0 and stop_price < entry_price and take_profit_price > entry_price)
  );

alter table public.daily_picks
  drop constraint if exists daily_picks_position_positive_check;
alter table public.daily_picks
  add constraint daily_picks_position_positive_check check (
    shares is null or (shares > 0 and lots > 0 and time_exit_days >= 1)
  );

-- ---------------------------------------------------------------------------
-- 鎖一 / 鎖二 / 鎖三
-- ---------------------------------------------------------------------------
alter table public.risk_config enable row level security;

drop policy if exists risk_config_read on public.risk_config;
create policy risk_config_read
  on public.risk_config for select to anon, authenticated using (true);

revoke update, delete, truncate on public.risk_config from public, anon, authenticated, service_role;
revoke insert                   on public.risk_config from public, anon, authenticated, service_role;

grant select on public.risk_config to anon, authenticated, service_role;

-- registered_at / inserted_at 不開放：登記時點必須真實，不可回填。
grant insert (version, config, config_hash, rationale, registered_by)
  on public.risk_config to service_role;

drop trigger if exists risk_config_block_update on public.risk_config;
create trigger risk_config_block_update
  before update on public.risk_config
  for each row execute function public.l0_reject_mutation();

drop trigger if exists risk_config_block_delete on public.risk_config;
create trigger risk_config_block_delete
  before delete on public.risk_config
  for each row execute function public.l0_reject_mutation();

drop trigger if exists risk_config_block_truncate on public.risk_config;
create trigger risk_config_block_truncate
  before truncate on public.risk_config
  for each statement execute function public.l0_reject_mutation();

-- ---------------------------------------------------------------------------
-- daily_picks 的欄位級 INSERT 權限需重新授權，把新欄位納入。
-- （欄位級 grant 不會自動涵蓋後來 ALTER 加上的欄位）
-- inserted_at 與 id 一律不開放。
-- ---------------------------------------------------------------------------
revoke insert on public.daily_picks from public, anon, authenticated, service_role;

grant insert (
  run_id, revision, data_as_of, signal_at,
  list_kind, rank, code, market, name,
  price_at_push, composite_score, real_factor_count, factor_scores,
  engine_version, active_factors, inactive_factors,
  universe_size, tradable_count, ranked_count,
  entry_price, stop_price, take_profit_price, time_exit_days,
  lots, shares, position_value_twd, risk_amount_twd,
  sigma_daily, vol_observations, equity_at_signal_twd,
  risk_config_version, risk_config_hash
) on public.daily_picks to service_role;

-- =============================================================================
-- 執行完成後請跑：
--   npm run l3:register   （登記 risk-v1 設定，執行前會列出內容並要求確認）
--   npm run l3:verify     （實測三道鎖與屏障 constraint）
--   npm run l1:picks      （dry-run，會一併顯示 L3 結果）
-- =============================================================================
