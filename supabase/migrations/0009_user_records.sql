-- =============================================================================
-- P8 — user_records：人的決策紀錄
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼一定要跟 daily_picks 分表】（CLAUDE.md）
-- daily_picks 是「系統說了什麼」，user_records 是「人做了什麼」。
-- 兩者分開存，才算得出 G4 的「人工執行一致率 > 90%」——
-- 如果系統說 A 而你買了 B，那個差異本身就是要被衡量的東西。
-- 合在一起存，這個差異就永遠看不到了。
--
-- 【append-only：打錯了不能改，要另外補一筆】
-- 理由不是刁難，是 G4 的評估必須誠實。若可以事後編輯，
-- 「當時我就說要買那檔會漲的」這種修改沒有任何機制擋得住。
-- 打錯時再送一次即可：同一天同一檔以**最後一筆**為準，兩筆都留著。
--
-- 【v1 不下單】
-- 這張表記錄的是你在券商 App 自己做的事，不是系統的下單指令。
-- LINE 的 /rec 只寫紀錄，不會、也不能觸發任何買賣。
-- =============================================================================

create table if not exists public.user_records (
  id                bigint      generated always as identity primary key,

  -- 三個時間欄位語意不同：
  --   recorded_at = 你送出訊息的時點（取自 LINE event 的 timestamp，非系統時鐘）
  --   data_as_of  = 這筆決策對應的是哪一天的清單
  --   inserted_at = 資料庫寫入時點（由資料庫蓋章，應用程式無權指定）
  recorded_at       timestamptz not null,
  data_as_of        date,
  inserted_at       timestamptz not null default now(),

  source            text        not null,
  /** LINE 訊息 ID。webhook 可能重送，用它去重。 */
  line_message_id   text,

  action            text        not null,
  code              text,
  shares            integer,
  price             numeric(12,4),
  note              text,
  /** 你的原話，逐字保留。解析錯了才有辦法回溯。 */
  raw_text          text        not null,

  constraint user_records_source_check
    check (source in ('line', 'manual')),
  constraint user_records_action_check
    check (action in ('buy', 'sell', 'watch', 'skip', 'note')),
  -- 買賣必須有代號、股數、價格；缺一就不知道你到底做了什麼
  constraint user_records_trade_fields_check
    check (
      action not in ('buy', 'sell')
      or (code is not null and shares is not null and shares > 0
          and price is not null and price > 0)
    ),
  -- 觀望與略過必須指明哪一檔
  constraint user_records_target_check
    check (action not in ('watch', 'skip') or code is not null),
  constraint user_records_raw_text_not_blank
    check (length(btrim(raw_text)) > 0),
  constraint user_records_no_backfill_check
    check (data_as_of is null or data_as_of >= date '2026-08-14')
);

comment on table public.user_records is
  'P8 人的決策紀錄。append-only：打錯了不能改，補一筆即可，同一天同一檔以最後一筆為準。';

-- 同一則 LINE 訊息只能寫入一次（webhook 重送時靠這道擋）
create unique index if not exists user_records_line_message_uniq
  on public.user_records (line_message_id)
  where line_message_id is not null;

create index if not exists user_records_code_date_idx
  on public.user_records (code, data_as_of desc);
create index if not exists user_records_recorded_at_idx
  on public.user_records (recorded_at desc);

-- =============================================================================
-- 三道鎖
-- =============================================================================
alter table public.user_records enable row level security;

drop policy if exists user_records_read on public.user_records;
create policy user_records_read
  on public.user_records for select to anon, authenticated using (true);

revoke update, delete, truncate on public.user_records from public, anon, authenticated, service_role;
revoke insert                   on public.user_records from public, anon, authenticated, service_role;

grant select on public.user_records to anon, authenticated, service_role;

-- inserted_at 與 id 不開放。recorded_at 開放，因為那是 LINE event 的時間戳，
-- 屬於應用程式觀察到的外部事實，與 raw_snapshots.fetched_at 同理。
grant insert (
  recorded_at, data_as_of, source, line_message_id,
  action, code, shares, price, note, raw_text
) on public.user_records to service_role;

drop trigger if exists user_records_block_update on public.user_records;
create trigger user_records_block_update
  before update on public.user_records
  for each row execute function public.l0_reject_mutation();

drop trigger if exists user_records_block_delete on public.user_records;
create trigger user_records_block_delete
  before delete on public.user_records
  for each row execute function public.l0_reject_mutation();

drop trigger if exists user_records_block_truncate on public.user_records;
create trigger user_records_block_truncate
  before truncate on public.user_records
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 執行完成後請跑：
--   npm run l4:verify   （實測三道鎖與 constraint）
--   npm run l4:report   （dry-run，把日報印在終端機不推播）
-- =============================================================================
