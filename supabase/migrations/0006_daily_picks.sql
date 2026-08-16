-- =============================================================================
-- P5 — daily_picks：每日觀察榜與交易訊號的 append-only 紀錄
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【這張表存的是「系統當天說了什麼」，不是「後來證明對不對」】
-- 一旦寫入就永遠不能改。系統若在某天推了一份爛清單，那份爛清單必須留著，
-- 否則 G1（≥100 筆訊號）與 G3（勝過 0050）的評估就是自己給自己打分數。
--
-- 【daily_picks 與 user_records 必須分表】（CLAUDE.md）
-- 這裡只放系統的建議；人實際買了沒、買多少、為什麼略過，一律進 user_records。
-- 兩張表分開存，才能算出 G4 的「人工執行一致率」。
--
-- 【list_kind 的兩份清單語意完全不同，不可混淆】（CLAUDE.md）
--   watchlist    每日固定 5 檔，**研究紀錄，不是買進建議**
--                用途是累積樣本，檢驗排序到底有沒有預測力
--   trade_signal 通過 L2 否決與 L3 風控者，0～N 檔
--                **經常是 0 檔，那是正常且健康的**（那天就沒有這種列）
--
-- 【重跑同一天不會覆蓋，而是被拒絕】
-- 唯一索引是 (data_as_of, list_kind, revision, rank)。
-- 同一天要出第二份清單，必須明確指定 revision = 2，兩份都會永久留著。
-- 「悄悄修正昨天的推薦」在這個結構下做不到。
-- =============================================================================

create table if not exists public.daily_picks (
  id                  bigint      generated always as identity primary key,

  -- 一次產生視為一個 run，同一 run 的 5 檔共用 run_id
  run_id              uuid        not null,
  revision            integer     not null default 1,

  -- 三個時間欄位語意不同，不可混用：
  --   data_as_of  = 排序所用資料的交易日（來自 L0 的 data_as_of）
  --   signal_at   = 產生這份清單時的系統時鐘（應用程式提供，屬觀察事實）
  --   inserted_at = 資料庫寫入時點（由資料庫蓋章，應用程式無權指定）
  data_as_of          date        not null,
  signal_at           timestamptz not null,
  inserted_at         timestamptz not null default now(),

  list_kind           text        not null,
  rank                integer     not null,
  code                text        not null,
  market              text        not null,
  name                text        not null,

  -- 推播當下的參考價＝當日收盤價。日後算報酬時的基準，不可事後調整。
  price_at_push       numeric(12,4) not null,

  composite_score     numeric(12,10) not null,
  -- 這一檔實際算得出來的因子數（其餘為補的中性值 0.5）。
  -- 沒有這個欄位就無法分辨「五個因子都看好」與「只有一個因子有資料」。
  real_factor_count   integer     not null,
  -- 每個因子的 raw / winsorized / score / imputed，逐檔留存供 P12 稽核
  factor_scores       jsonb       not null,

  -- 當日全域資訊。append-only 表刻意不做 join，直接記在每一列。
  engine_version      text        not null,
  active_factors      jsonb       not null,
  inactive_factors    jsonb       not null,
  universe_size       integer     not null,
  tradable_count      integer     not null,
  ranked_count        integer     not null,

  constraint daily_picks_list_kind_check
    check (list_kind in ('watchlist', 'trade_signal')),
  constraint daily_picks_market_check
    check (market in ('TWSE', 'TPEx')),
  constraint daily_picks_rank_check
    check (rank >= 1),
  constraint daily_picks_revision_check
    check (revision >= 1),
  constraint daily_picks_score_range_check
    check (composite_score >= 0 and composite_score <= 1),
  constraint daily_picks_price_positive_check
    check (price_at_push > 0),
  -- 至少要有一個真實因子值，全靠補值的股票不得上榜
  constraint daily_picks_real_factor_check
    check (real_factor_count >= 1),
  -- L0 自 2026-08-14 才開始累積，更早的日期只可能是回填或打錯
  constraint daily_picks_no_backfill_check
    check (data_as_of >= date '2026-08-14')
);

comment on table public.daily_picks is
  'P5 每日清單。append-only：觀察榜為研究紀錄非買進建議；交易訊號經常是 0 檔。';

-- 同一天同一種清單的同一個名次只能有一列。重跑必須明確換 revision。
create unique index if not exists daily_picks_slot_uniq
  on public.daily_picks (data_as_of, list_kind, revision, rank);

create index if not exists daily_picks_date_idx
  on public.daily_picks (data_as_of desc, list_kind);
create index if not exists daily_picks_code_idx
  on public.daily_picks (code, data_as_of desc);
create index if not exists daily_picks_run_idx
  on public.daily_picks (run_id);

-- =============================================================================
-- 鎖一：RLS —— 只開放讀取，不建立任何寫入 policy
-- =============================================================================
alter table public.daily_picks enable row level security;

drop policy if exists daily_picks_read on public.daily_picks;
create policy daily_picks_read
  on public.daily_picks for select to anon, authenticated using (true);

-- =============================================================================
-- 鎖二：收回權限本身（含表級 INSERT，欄位級授權才會生效）
-- =============================================================================
revoke update, delete, truncate on public.daily_picks from public, anon, authenticated, service_role;
revoke insert                   on public.daily_picks from public, anon, authenticated, service_role;

grant select on public.daily_picks to anon, authenticated, service_role;

-- inserted_at 與 id 不開放：寫入時點必須真實，不可回填。
grant insert (
  run_id, revision, data_as_of, signal_at,
  list_kind, rank, code, market, name,
  price_at_push, composite_score, real_factor_count, factor_scores,
  engine_version, active_factors, inactive_factors,
  universe_size, tradable_count, ranked_count
) on public.daily_picks to service_role;

-- =============================================================================
-- 鎖三：觸發器。權限若被誤 grant 回來，這道仍然擋得住。
-- 沿用 0001 建立的 public.l0_reject_mutation()。
-- =============================================================================
drop trigger if exists daily_picks_block_update on public.daily_picks;
create trigger daily_picks_block_update
  before update on public.daily_picks
  for each row execute function public.l0_reject_mutation();

drop trigger if exists daily_picks_block_delete on public.daily_picks;
create trigger daily_picks_block_delete
  before delete on public.daily_picks
  for each row execute function public.l0_reject_mutation();

drop trigger if exists daily_picks_block_truncate on public.daily_picks;
create trigger daily_picks_block_truncate
  before truncate on public.daily_picks
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑：
--   npm run l1:picks          （只算不寫，先看數字）
--   npm run l1:verify-picks   （實際嘗試改寫／刪除／偽造 inserted_at，證明擋得住）
-- =============================================================================
