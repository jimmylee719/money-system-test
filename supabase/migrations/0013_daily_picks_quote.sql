-- =============================================================================
-- 0013 — daily_picks 補上當日行情細節（漲跌／成交量／成交金額）
--
-- 【為什麼要存】
-- 2026-08-20 使用者回饋：「LINE 收到的訊息我看不太懂」，
-- 要求顯示昨收、今收、漲跌與成交量。日報那邊可以即時算，
-- 但 Dashboard 是從 daily_picks 讀的 —— 沒存進來就只能顯示一個收盤價。
--
-- 【這些欄位不參與排序，也不改變任何既有行為】
-- 純粹是把當日行情原封不動留存下來。排名仍完全由 composite_score 決定。
-- 既然要在畫面上呈現，就必須跟名次一起凍結在同一列，
-- 否則日後回頭看，會拿今天的行情去解釋昨天的名次。
--
-- 【全部可為 null，這是刻意的】
-- 2026-08-14 / 08-18 / 08-19 三天的既有列沒有這些資料，事後也不該回填 ——
-- append-only 的意義就是「當時記了什麼就是什麼」。舊列留 null，如實表示當時沒記。
--
-- ⚠️ change_note 不可省略。除權息日的 change 是相對於除權息參考價，
--    不是相對於昨天的收盤；沒有這個註記，畫面會理直氣壯地用
--    close − change 顯示一個錯的「昨收」。官方原文逐字保留，不改寫不摘要。
--
-- 執行後請跑：
--   npm run l1:verify-picks   （三道鎖與 constraint 實測）
--   npm run l1:picks          （dry-run，確認新欄位有值）
-- =============================================================================

alter table public.daily_picks
  add column if not exists change_amount  numeric(12,4),
  add column if not exists change_note    text,
  add column if not exists volume_shares  bigint,
  add column if not exists turnover_value numeric(20,2);

comment on column public.daily_picks.change_amount is
  '當日漲跌（元）。官方原值，除權息日為 null。';
comment on column public.daily_picks.change_note is
  '官方漲跌欄的非數值註記，逐字保留（如 除權／除息）。有值代表當日漲跌不可與昨收直接比較。';
comment on column public.daily_picks.volume_shares is
  '成交股數。TWSE TradeVolume 與 TPEx TradingShares 均以股為單位（2026-08-20 實測比對成交金額確認）。';
comment on column public.daily_picks.turnover_value is
  '成交金額（元）。';

-- 成交量不可為負。抓到負值代表來源格式變了，寧可寫入失敗也不要靜默存進去。
alter table public.daily_picks
  drop constraint if exists daily_picks_volume_nonneg_check;
alter table public.daily_picks
  add constraint daily_picks_volume_nonneg_check check (
    (volume_shares is null or volume_shares >= 0) and
    (turnover_value is null or turnover_value >= 0)
  );

-- ---------------------------------------------------------------------------
-- 欄位級 INSERT 權限需重新授權，把新欄位納入。
-- （欄位級 grant 不會自動涵蓋後來 ALTER 加上的欄位 —— 見 0008 同樣的處理）
-- inserted_at 與 id 一律不開放：寫入時點必須真實，不可回填。
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
  risk_config_version, risk_config_hash,
  change_amount, change_note, volume_shares, turnover_value
) on public.daily_picks to service_role;

-- 鎖一（RLS 只給 SELECT）與鎖三（BEFORE UPDATE/DELETE/TRUNCATE 觸發器）
-- 在 0006 已建立，作用於整張表，加欄位不影響，故此處不重建。
