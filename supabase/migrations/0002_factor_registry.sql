-- =============================================================================
-- P4 — factor_registry：因子預先登記
--
-- 執行方式：Supabase SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【這張表要對抗的不是駭客，是自己】
-- 回測最常見的自欺方式：跑完看到結果，再回頭修改因子定義／門檻／假設方向，
-- 然後宣稱「早就這樣設計」。防這件事不能靠自律，要靠制度：
--   1. 登記時就把定義、門檻、方向寫死，表為 append-only 改不了
--   2. registered_at 不開放應用程式寫入（欄位級權限），時間戳無法偽造
--   3. 通過與否由資料庫依登記的門檻與方向自行判定，不接受應用程式自報
--   4. 樣本數 < 30 直接拒絕（CLAUDE.md：樣本 < 30 不得下結論）
--   5. 封存後不得再有任何狀態事件（失敗即封存，不得改條件重測）
--   6. 所有登記（含失敗）一律計入試驗次數，供 Deflated Sharpe Ratio 使用
--
-- 三道鎖沿用 0001 的做法（RLS + REVOKE + 觸發器），l0_reject_mutation() 直接重用。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- factor_registry：因子登記本體
-- ---------------------------------------------------------------------------
create table if not exists public.factor_registry (
  id                    bigint generated always as identity primary key,

  factor_key            text        not null unique,
  display_name          text        not null,

  -- 定義鎖定：完整參數 + 其正規化雜湊。表為 append-only，登記後改不了。
  definition            jsonb       not null,
  definition_hash       text        not null unique,

  -- 經濟理由：空白即拒絕（CLAUDE.md 明文）
  economic_rationale    text        not null,

  -- 以下四項全部必須在「看到結果之前」宣告
  hypothesis_direction  text        not null,
  test_period_start     date        not null,
  test_period_end       date        not null,
  t_threshold           numeric(6,3) not null,

  universe              text        not null,
  registered_by         text        not null,

  -- 🔴 不開放應用程式寫入（見下方欄位級 GRANT），時間戳無法偽造
  registered_at         timestamptz not null default now(),
  inserted_at           timestamptz not null default now(),

  -- 「空白即拒絕」不能只擋空字串：一句敷衍的話等於沒有理由。
  -- 要求至少 50 字元，逼使用者真的寫出經濟機制。
  constraint factor_registry_rationale_not_blank
    check (length(btrim(economic_rationale)) >= 50),
  constraint factor_registry_direction_check
    check (hypothesis_direction in ('higher_is_better', 'lower_is_better')),
  -- CLAUDE.md 明訂門檻 t > 3.0，不得事後放寬
  constraint factor_registry_threshold_check
    check (t_threshold >= 3.0),
  constraint factor_registry_period_check
    check (test_period_start < test_period_end),
  constraint factor_registry_definition_hash_format
    check (definition_hash ~ '^[0-9a-f]{64}$'),
  constraint factor_registry_universe_check
    check (universe in ('TWSE', 'TPEx', 'BOTH')),
  constraint factor_registry_key_format
    check (factor_key ~ '^[a-z][a-z0-9_]{2,63}$')
);

comment on table public.factor_registry is
  'L1 因子預先登記。append-only：登記後定義、門檻、假設方向皆不可更改。';

create index if not exists factor_registry_registered_at_idx
  on public.factor_registry (registered_at desc);

-- ---------------------------------------------------------------------------
-- factor_status_events：狀態以事件累積（append-only 不能 UPDATE 狀態欄）
-- ---------------------------------------------------------------------------
create table if not exists public.factor_status_events (
  id           bigint generated always as identity primary key,
  factor_key   text        not null references public.factor_registry(factor_key),
  status       text        not null,
  reason       text        not null,
  occurred_at  timestamptz not null default now(),
  inserted_at  timestamptz not null default now(),

  constraint factor_status_events_status_check
    check (status in ('registered', 'testing', 'passed', 'archived')),
  constraint factor_status_events_reason_not_blank
    check (length(btrim(reason)) >= 10)
);

create index if not exists factor_status_events_key_idx
  on public.factor_status_events (factor_key, occurred_at desc);

-- ---------------------------------------------------------------------------
-- factor_test_results：檢定結果
-- ---------------------------------------------------------------------------
create table if not exists public.factor_test_results (
  id                  bigint generated always as identity primary key,
  factor_key          text        not null references public.factor_registry(factor_key),
  -- 必須與登記時的定義雜湊相同，防止「同名但偷改參數」
  definition_hash     text        not null,
  t_statistic         numeric     not null,
  sample_size         integer     not null,
  observed_direction  text        not null,
  -- 🔴 不接受應用程式自報，由觸發器依登記的門檻與方向覆寫
  passed              boolean     not null,
  method              text        not null,
  notes               text,
  recorded_at         timestamptz not null default now(),
  inserted_at         timestamptz not null default now(),

  -- CLAUDE.md：樣本 < 30 筆不得下結論
  constraint factor_test_results_sample_size_check
    check (sample_size >= 30),
  constraint factor_test_results_direction_check
    check (observed_direction in ('higher_is_better', 'lower_is_better')),
  -- CLAUDE.md：涉及擬合須用 Purged K-Fold CV + Embargo，標準 k-fold 禁用
  constraint factor_test_results_method_check
    check (method in ('purged_kfold_embargo', 'walk_forward', 'full_sample_descriptive'))
);

create index if not exists factor_test_results_key_idx
  on public.factor_test_results (factor_key, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 守門觸發器
-- ---------------------------------------------------------------------------

-- 登記時自動寫入第一筆狀態事件，確保每個因子都有完整狀態軌跡
create or replace function public.factor_registry_seed_status()
returns trigger
language plpgsql
as $$
begin
  insert into public.factor_status_events (factor_key, status, reason)
  values (new.factor_key, 'registered', 'auto: 因子登記完成，尚未檢定');
  return new;
end;
$$;

-- 封存後不得再有任何狀態事件：失敗即封存，不得改條件重測
create or replace function public.factor_status_events_guard()
returns trigger
language plpgsql
as $$
declare
  v_archived boolean;
begin
  select exists (
    select 1 from public.factor_status_events
    where factor_key = new.factor_key and status = 'archived'
  ) into v_archived;

  if v_archived then
    raise exception
      'factor % 已封存，不得再變更狀態（CLAUDE.md：失敗即封存，不得改條件重測）',
      new.factor_key
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- 檢定結果的守門：
--   1. definition_hash 必須與登記時相同
--   2. passed 由資料庫依「登記時」的門檻與方向判定，不接受應用程式自報
--   3. 已封存的因子不得再記錄結果
create or replace function public.factor_test_results_guard()
returns trigger
language plpgsql
as $$
declare
  v_hash      text;
  v_threshold numeric;
  v_direction text;
  v_archived  boolean;
  v_should_pass boolean;
begin
  select definition_hash, t_threshold, hypothesis_direction
    into v_hash, v_threshold, v_direction
  from public.factor_registry
  where factor_key = new.factor_key;

  if v_hash is null then
    raise exception 'factor % 未登記，不得記錄檢定結果', new.factor_key
      using errcode = '42501';
  end if;

  if new.definition_hash <> v_hash then
    raise exception
      'factor % 的 definition_hash 與登記時不符：登記=% 本次=%（定義鎖定後不得調參）',
      new.factor_key, v_hash, new.definition_hash
      using errcode = '42501';
  end if;

  select exists (
    select 1 from public.factor_status_events
    where factor_key = new.factor_key and status = 'archived'
  ) into v_archived;
  if v_archived then
    raise exception 'factor % 已封存，不得再記錄檢定結果', new.factor_key
      using errcode = '42501';
  end if;

  -- 依「登記時」宣告的門檻與方向判定，覆寫應用程式送來的 passed
  v_should_pass := (new.t_statistic >= v_threshold)
                   and (new.observed_direction = v_direction);

  if new.passed is distinct from v_should_pass then
    raise exception
      'factor % 的 passed 自報為 % 但依登記條件應為 %（t=%, 門檻=%, 觀察方向=%, 登記方向=%）',
      new.factor_key, new.passed, v_should_pass,
      new.t_statistic, v_threshold, new.observed_direction, v_direction
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists factor_registry_seed_status_trg on public.factor_registry;
create trigger factor_registry_seed_status_trg
  after insert on public.factor_registry
  for each row execute function public.factor_registry_seed_status();

drop trigger if exists factor_status_events_guard_trg on public.factor_status_events;
create trigger factor_status_events_guard_trg
  before insert on public.factor_status_events
  for each row execute function public.factor_status_events_guard();

drop trigger if exists factor_test_results_guard_trg on public.factor_test_results;
create trigger factor_test_results_guard_trg
  before insert on public.factor_test_results
  for each row execute function public.factor_test_results_guard();

-- ---------------------------------------------------------------------------
-- 試驗次數：Deflated Sharpe Ratio 必須連同試驗次數呈報（CLAUDE.md）
-- 失敗與封存的因子一律計入 —— 只算成功的就是選擇性回報。
-- ---------------------------------------------------------------------------
-- probe_% 為驗證守門機制用的探針因子，append-only 刪不掉。
-- 這裡把它單獨列出讓數字可稽核可扣除，而不是在 total 裡偷偷過濾掉
-- （偷偷過濾會製造漏洞：把真因子命名為 probe_ 即可從試驗次數消失）。
create or replace view public.factor_trial_summary
with (security_invoker = true) as
select
  (select count(*) from public.factor_registry)                                as total_registrations,
  (select count(*) from public.factor_registry where factor_key like 'probe\_%')
                                                                               as probe_registrations,
  (select count(*) from public.factor_registry where factor_key not like 'probe\_%')
                                                                               as real_registrations,
  (select count(*) from public.factor_test_results)                            as total_tests,
  (select count(*) from public.factor_test_results where passed)               as passed_tests,
  (select count(distinct factor_key) from public.factor_status_events
    where status = 'archived')                                                 as archived_factors;

comment on view public.factor_trial_summary is
  'DSR 呈報用。試驗次數含失敗與封存者，只算成功即為選擇性回報。'
  'real_registrations 才是呈報 DSR 該用的試驗次數；probe_ 為守門驗證探針。';

-- =============================================================================
-- 三道鎖（沿用 0001 的 l0_reject_mutation）
-- =============================================================================
alter table public.factor_registry      enable row level security;
alter table public.factor_status_events enable row level security;
alter table public.factor_test_results  enable row level security;

drop policy if exists factor_registry_read on public.factor_registry;
create policy factor_registry_read
  on public.factor_registry for select to anon, authenticated using (true);

drop policy if exists factor_status_events_read on public.factor_status_events;
create policy factor_status_events_read
  on public.factor_status_events for select to anon, authenticated using (true);

drop policy if exists factor_test_results_read on public.factor_test_results;
create policy factor_test_results_read
  on public.factor_test_results for select to anon, authenticated using (true);

revoke update, delete, truncate on public.factor_registry      from public, anon, authenticated, service_role;
revoke update, delete, truncate on public.factor_status_events from public, anon, authenticated, service_role;
revoke update, delete, truncate on public.factor_test_results  from public, anon, authenticated, service_role;

grant select on public.factor_registry      to anon, authenticated;
grant select on public.factor_status_events to anon, authenticated;
grant select on public.factor_test_results  to anon, authenticated;
grant select on public.factor_trial_summary to anon, authenticated, service_role;

-- 🔴 欄位級 INSERT 權限：刻意排除 registered_at / occurred_at / recorded_at /
--    inserted_at / id，讓應用程式無法偽造時間戳。
--
-- ⚠️ 2026-08-16 實測發現：光是這樣【沒有效果】。Supabase 建表時的預設權限已授予
--    service_role 整張表的 INSERT，欄位級 grant 只是「再加上」而非「限縮」。
--    必須先 revoke 表級 INSERT，欄位級授權才會生效。
--    修正在 0003_restrict_insert_columns.sql，請務必接著執行。
grant select on public.factor_registry to service_role;
grant insert (
  factor_key, display_name, definition, definition_hash, economic_rationale,
  hypothesis_direction, test_period_start, test_period_end, t_threshold,
  universe, registered_by
) on public.factor_registry to service_role;

grant select on public.factor_status_events to service_role;
grant insert (factor_key, status, reason) on public.factor_status_events to service_role;

grant select on public.factor_test_results to service_role;
grant insert (
  factor_key, definition_hash, t_statistic, sample_size,
  observed_direction, passed, method, notes
) on public.factor_test_results to service_role;

drop trigger if exists factor_registry_block_update on public.factor_registry;
create trigger factor_registry_block_update
  before update on public.factor_registry
  for each row execute function public.l0_reject_mutation();

drop trigger if exists factor_registry_block_delete on public.factor_registry;
create trigger factor_registry_block_delete
  before delete on public.factor_registry
  for each row execute function public.l0_reject_mutation();

drop trigger if exists factor_status_events_block_update on public.factor_status_events;
create trigger factor_status_events_block_update
  before update on public.factor_status_events
  for each row execute function public.l0_reject_mutation();

drop trigger if exists factor_status_events_block_delete on public.factor_status_events;
create trigger factor_status_events_block_delete
  before delete on public.factor_status_events
  for each row execute function public.l0_reject_mutation();

drop trigger if exists factor_test_results_block_update on public.factor_test_results;
create trigger factor_test_results_block_update
  before update on public.factor_test_results
  for each row execute function public.l0_reject_mutation();

drop trigger if exists factor_test_results_block_delete on public.factor_test_results;
create trigger factor_test_results_block_delete
  before delete on public.factor_test_results
  for each row execute function public.l0_reject_mutation();
