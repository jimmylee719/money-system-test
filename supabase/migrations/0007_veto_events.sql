-- =============================================================================
-- P6 — veto_events：L2 否決層的逐筆紀錄
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼否決一定要留紀錄】
-- 一個把贏家全濾掉的否決層，比沒有否決層更糟。
-- 要判斷 L2 到底幫了還是害了，就必須知道：被擋掉的是哪些、依哪一條規則、
-- 當時官方原文怎麼寫、那一檔在排序中排第幾。
--
-- 【對照組是現成的】
-- 觀察榜 Top 5 依排名產生，**不受 L2 影響**（CLAUDE.md：觀察榜是研究紀錄）。
-- 因此 P9 算 outcomes 時，被否決的標的照樣有報酬資料可比。
-- 若被否決者的後續報酬持續勝過通過者，那就是 L2 在扣分，該砍掉重練。
--
-- 【每條規則分開記錄】
-- 「注意股」與「處置股」的把握程度完全不同：
--   處置＝確定的執行成本（人工撮合、預收全額款券）
--   注意＝只是警示，強勢股本就容易被列注意，有連贏家一起擋掉的風險
-- 混在一起記錄就永遠分不出是哪一條在扣分。
--
-- 【rule_id 的清單刻意寫死在 constraint】
-- 新增一條否決規則就必須改這個 migration，也就是必須有人看過。
-- 否決層無聲無息地多長出一條規則，是這個系統最不該發生的事。
-- =============================================================================

create table if not exists public.veto_events (
  id                  bigint      generated always as identity primary key,

  run_id              uuid        not null,

  -- 三個時間欄位語意不同：
  --   data_as_of  = 訊號日（排序所用資料的交易日）
  --   signal_at   = 產生決策時的系統時鐘（應用程式提供）
  --   inserted_at = 資料庫寫入時點（由資料庫蓋章，應用程式無權指定）
  data_as_of          date        not null,
  signal_at           timestamptz not null,
  inserted_at         timestamptz not null default now(),

  code                text        not null,
  market              text        not null,
  rule_id             text        not null,
  /** 給人看的一句話 */
  reason              text        not null,
  /** 官方公告原文，逐字保留不改寫 —— 日後要覆核判斷是否正確，靠的是這欄 */
  evidence            text        not null,

  -- 這一檔當時在 L1 排序中的位置。用來回答最關鍵的問題：
  -- 「L2 擋掉的到底是前段班還是後段班？」擋掉後段班沒什麼；擋掉前段班才是成本。
  rank_at_signal      integer,
  composite_score     numeric(12,10),

  engine_version      text        not null,
  /** true 代表當日是因來源缺漏而全面否決 —— 那是故障，不是「今天沒訊號」 */
  failed_closed       boolean     not null default false,

  constraint veto_events_market_check
    check (market in ('TWSE', 'TPEx')),
  constraint veto_events_rule_id_check
    check (rule_id in (
      'attention',
      'disposition',
      'suspended',
      'altered_trading',
      'source_unavailable'
    )),
  constraint veto_events_rank_check
    check (rank_at_signal is null or rank_at_signal >= 1),
  constraint veto_events_score_range_check
    check (composite_score is null or (composite_score >= 0 and composite_score <= 1)),
  constraint veto_events_evidence_not_blank_check
    check (length(btrim(evidence)) > 0),
  -- L0 自 2026-08-14 才開始累積，更早的日期只可能是回填或打錯
  constraint veto_events_no_backfill_check
    check (data_as_of >= date '2026-08-14')
);

comment on table public.veto_events is
  'P6 L2 否決紀錄。append-only：每筆否決一列，含官方原文與當時排名，供日後衡量 L2 的效果。';

-- 同一次執行、同一檔、同一條規則只能有一列
create unique index if not exists veto_events_slot_uniq
  on public.veto_events (run_id, code, rule_id);

create index if not exists veto_events_date_rule_idx
  on public.veto_events (data_as_of desc, rule_id);
create index if not exists veto_events_code_idx
  on public.veto_events (code, data_as_of desc);

-- =============================================================================
-- 鎖一：RLS —— 只開放讀取，不建立任何寫入 policy
-- =============================================================================
alter table public.veto_events enable row level security;

drop policy if exists veto_events_read on public.veto_events;
create policy veto_events_read
  on public.veto_events for select to anon, authenticated using (true);

-- =============================================================================
-- 鎖二：收回權限本身（含表級 INSERT，欄位級授權才會生效）
-- =============================================================================
revoke update, delete, truncate on public.veto_events from public, anon, authenticated, service_role;
revoke insert                   on public.veto_events from public, anon, authenticated, service_role;

grant select on public.veto_events to anon, authenticated, service_role;

grant insert (
  run_id, data_as_of, signal_at,
  code, market, rule_id, reason, evidence,
  rank_at_signal, composite_score, engine_version, failed_closed
) on public.veto_events to service_role;

-- =============================================================================
-- 鎖三：觸發器。沿用 0001 建立的 public.l0_reject_mutation()。
-- =============================================================================
drop trigger if exists veto_events_block_update on public.veto_events;
create trigger veto_events_block_update
  before update on public.veto_events
  for each row execute function public.l0_reject_mutation();

drop trigger if exists veto_events_block_delete on public.veto_events;
create trigger veto_events_block_delete
  before delete on public.veto_events
  for each row execute function public.l0_reject_mutation();

drop trigger if exists veto_events_block_truncate on public.veto_events;
create trigger veto_events_block_truncate
  before truncate on public.veto_events
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑：
--   npm run l2:verify   （實測三道鎖與 constraint）
--   npm run l1:picks    （會一併顯示 L2 否決結果，dry-run）
-- =============================================================================
