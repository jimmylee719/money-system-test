-- =============================================================================
-- P4.5 — L0 原始 bytes 上雲（Supabase Storage）
--
-- 執行方式：Supabase SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼是 Supabase Storage 而不是 Cloudflare R2】
-- CLAUDE.md 原本指定 R2。改用 Supabase Storage 的依據是實測數字：
--
--   實測壓縮率（2026-08-16，13 個來源共 8.27 MB 原始資料）：
--     gzip level 9 → 1.09 MB，壓縮比 7.6x
--     其中櫃買行情 4.0 MB → 388 KB，壓縮比 10.3x（JSON 欄位名高度重複）
--
--   每日 1.09 MB 之下：
--     Supabase Storage 免費 1 GB  → 939 天 ≈ 2.6 年
--     Cloudflare R2    免費 10 GB → 25.7 年
--
-- G1 閘門要求 ≥6 個月，2.6 年有 5 倍餘裕。
-- 少一個外部帳號就少一個會壞掉的地方，且與帳本同一組憑證、同一個地方查問題。
-- 額度接近時再搬 R2，屆時只需換 BodyStore 實作。
--
-- 免費額度（官方 pricing 頁 2026-08-16 查證）：1 GB file storage、5 GB egress。
-- 本系統只寫幾乎不讀，egress 不構成限制。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 建立私有 bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('l0-raw', 'l0-raw', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- raw_snapshots.body_store 允許新的儲存後端
-- ---------------------------------------------------------------------------
alter table public.raw_snapshots
  drop constraint if exists raw_snapshots_body_store_check;

alter table public.raw_snapshots
  add constraint raw_snapshots_body_store_check
  check (body_store in ('file', 'r2', 'supabase_storage'));

-- ---------------------------------------------------------------------------
-- body_path 現在存的是 bucket 內的物件路徑，格式：
--   <source_id>/<data_as_of|unknown-date>/<content_hash>.json.gz
--
-- 檔名仍是原始 bytes 的 SHA-256（不是壓縮後的），
-- 因此 raw_snapshots.content_hash 可直接與物件內容解壓後互相驗證。
-- ---------------------------------------------------------------------------
comment on column public.raw_snapshots.body_path is
  'body_store=file 時為本機絕對路徑；supabase_storage 時為 bucket l0-raw 內的物件路徑。'
  '檔名為【原始 bytes】的 SHA-256，解壓後可與 content_hash 互相驗證。';

-- =============================================================================
-- 執行完成後請跑 `npm run l0:verify-storage`，
-- 它會上傳、下載、解壓、重算雜湊，證明來回一致且重複上傳不會覆蓋。
-- =============================================================================
