-- =============================================================================
-- P3 — L0 append-only 帳本 + schema drift 紀錄
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run
-- 本檔可重複執行（idempotent）。
--
-- 【為什麼不是只靠 RLS】
-- Supabase 官方文件明載 service 金鑰的用途是繞過 RLS，而本系統的抓取排程
-- 正是以 service_role key 寫入。只做 RLS 等於只鎖住訪客，我們自己的程式
-- 仍能改寫或刪除歷史資料 —— 那就違背了 L0「永不覆寫」的存在意義。
--
-- 因此上三道鎖：
--   鎖一 RLS policy            → 擋 anon / authenticated（只給 SELECT）
--   鎖二 REVOKE UPDATE/DELETE  → 把權限本身收掉。service_role 雖有 BYPASSRLS，
--                                仍受 GRANT 約束，故這道鎖對它有效
--   鎖三 BEFORE 觸發器直接報錯 → 最後防線，連 service_role 也擋
--
-- 註：刻意不使用 FORCE ROW LEVEL SECURITY。阻擋寫入的責任在鎖二與鎖三；
--     加 FORCE 只會讓 SQL Editor 的日常管理作業意外受阻，徒增混淆。
--
-- 【Postgres 只存帳本，不存原始 bytes】
-- 櫃買行情單日就 4.1 MB，13 個來源每日約 6.5 MB，直接塞進資料庫會在
-- 兩個多月內撐爆免費額度。原始 bytes 留在檔案儲存（日後搬 Cloudflare R2），
-- 資料庫存 content_hash 作為指紋，兩邊可互相驗證。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 鎖三使用的共用函式：拒絕任何 UPDATE / DELETE / TRUNCATE
-- ---------------------------------------------------------------------------
create or replace function public.l0_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'append-only violation: % on %.% is permanently blocked',
    tg_op, tg_table_schema, tg_table_name
    using errcode = '42501';
end;
$$;

comment on function public.l0_reject_mutation() is
  'L0 append-only 最後防線：任何 UPDATE/DELETE/TRUNCATE 一律報錯，service_role 亦不例外。';

-- ---------------------------------------------------------------------------
-- raw_snapshots：每一次抓取一列（含重複內容），永不覆寫
-- ---------------------------------------------------------------------------
create table if not exists public.raw_snapshots (
  id                       bigint generated always as identity primary key,

  -- 來源
  source_id                text        not null,
  url                      text        not null,
  market                   text        not null,
  source_tier              text        not null,

  -- 三個時間欄位語意完全不同，不可混用：
  --   data_as_of  = payload 自身的日期（例：月營收出表日 2026-08-15）
  --   data_period = 資料涵蓋期間（例：該筆營收屬於 2026-07）
  --   fetched_at  = 系統時鐘的抓取時間
  -- 把 data_period 當 data_as_of 用就是前視偏誤。
  data_as_of               date,
  data_as_of_reason        text        not null,
  data_period              text,
  fetched_at               timestamptz not null,

  -- 內容指紋
  content_hash             text        not null,
  content_length           integer     not null,

  -- 原始 bytes 的位置
  body_store               text        not null,
  body_path                text,

  -- 觀察到的事實（只記錄，不判斷）
  observed_fields          jsonb,
  observed_data_dates      jsonb       not null default '[]'::jsonb,
  observed_data_periods    jsonb       not null default '[]'::jsonb,
  row_count                integer,
  heterogeneous_row_count  integer,

  -- 傳輸
  http_status              integer     not null,
  etag                     text,
  last_modified            text,
  duration_ms              integer     not null,
  attempt                  integer     not null,

  -- 由資料庫蓋章，應用程式無法指定
  inserted_at              timestamptz not null default now(),

  constraint raw_snapshots_content_hash_format
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint raw_snapshots_data_period_format
    check (data_period is null or data_period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint raw_snapshots_body_store_check
    check (body_store in ('file', 'r2')),
  constraint raw_snapshots_data_as_of_reason_check
    check (data_as_of_reason in (
      'single_date_in_payload',
      'max_date_in_payload',
      'multiple_dates_in_payload',
      'date_field_missing',
      'date_unparsable',
      'payload_not_an_array',
      'payload_empty',
      'invalid_json'
    ))
);

comment on table public.raw_snapshots is
  'L0 原始快照帳本。append-only：每次抓取一列，含內容未變的重複抓取。';

create index if not exists raw_snapshots_source_date_idx
  on public.raw_snapshots (source_id, data_as_of desc);
create index if not exists raw_snapshots_content_hash_idx
  on public.raw_snapshots (content_hash);
create index if not exists raw_snapshots_fetched_at_idx
  on public.raw_snapshots (fetched_at desc);

-- ---------------------------------------------------------------------------
-- source_health：schema drift 與抓取失敗紀錄
-- ---------------------------------------------------------------------------
create table if not exists public.source_health (
  id                       bigint generated always as identity primary key,
  source_id                text        not null,
  observed_at              timestamptz not null,
  status                   text        not null,
  http_status              integer,
  content_hash             text,
  fields_added             jsonb       not null default '[]'::jsonb,
  fields_removed           jsonb       not null default '[]'::jsonb,
  row_count                integer,
  heterogeneous_row_count  integer,
  data_as_of_reason        text,
  error                    text,
  inserted_at              timestamptz not null default now(),

  constraint source_health_status_check
    check (status in (
      'ok',
      'schema_drift',
      'heterogeneous_rows',
      'date_unresolved',
      'fetch_failed'
    ))
);

comment on table public.source_health is
  'L0 來源健康度。append-only：每次抓取一列，記錄 schema drift 與失敗。';

create index if not exists source_health_source_time_idx
  on public.source_health (source_id, observed_at desc);
create index if not exists source_health_status_idx
  on public.source_health (status, observed_at desc);

-- =============================================================================
-- 鎖一：RLS —— 只開放讀取，不建立任何寫入 policy（未建立即預設拒絕）
-- =============================================================================
alter table public.raw_snapshots enable row level security;
alter table public.source_health enable row level security;

drop policy if exists raw_snapshots_read on public.raw_snapshots;
create policy raw_snapshots_read
  on public.raw_snapshots for select to anon, authenticated using (true);

drop policy if exists source_health_read on public.source_health;
create policy source_health_read
  on public.source_health for select to anon, authenticated using (true);

-- =============================================================================
-- 鎖二：收回權限本身。service_role 有 BYPASSRLS 但仍受 GRANT 約束。
-- =============================================================================
revoke update, delete, truncate on public.raw_snapshots from public, anon, authenticated, service_role;
revoke update, delete, truncate on public.source_health from public, anon, authenticated, service_role;

grant select          on public.raw_snapshots to anon, authenticated;
grant select          on public.source_health to anon, authenticated;
grant select, insert  on public.raw_snapshots to service_role;
grant select, insert  on public.source_health to service_role;

-- =============================================================================
-- 鎖三：觸發器。權限若被誤 grant 回來，這道仍然擋得住。
-- =============================================================================
drop trigger if exists raw_snapshots_block_update on public.raw_snapshots;
create trigger raw_snapshots_block_update
  before update on public.raw_snapshots
  for each row execute function public.l0_reject_mutation();

drop trigger if exists raw_snapshots_block_delete on public.raw_snapshots;
create trigger raw_snapshots_block_delete
  before delete on public.raw_snapshots
  for each row execute function public.l0_reject_mutation();

drop trigger if exists raw_snapshots_block_truncate on public.raw_snapshots;
create trigger raw_snapshots_block_truncate
  before truncate on public.raw_snapshots
  for each statement execute function public.l0_reject_mutation();

drop trigger if exists source_health_block_update on public.source_health;
create trigger source_health_block_update
  before update on public.source_health
  for each row execute function public.l0_reject_mutation();

drop trigger if exists source_health_block_delete on public.source_health;
create trigger source_health_block_delete
  before delete on public.source_health
  for each row execute function public.l0_reject_mutation();

drop trigger if exists source_health_block_truncate on public.source_health;
create trigger source_health_block_truncate
  before truncate on public.source_health
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑 `npm run l0:verify-append-only`，
-- 它會用 service_role key 實際去試改、試刪，證明三道鎖真的擋得住。
-- =============================================================================
