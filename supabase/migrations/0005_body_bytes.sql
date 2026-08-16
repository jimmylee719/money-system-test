-- =============================================================================
-- P4.5 補強 — 記錄壓縮後實際佔用大小，供容量監控使用
--
-- 執行方式：Supabase SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼要多一個欄位】
-- 容量監控需要知道「實際佔用多少空間」。已有的 content_length 是【壓縮前】大小，
-- 與實際佔用差 7.6 倍，不能拿來算額度。
--
-- 替代方案是事後逐檔向 Storage 查詢大小，但那會在物件累積到數千個時
-- 變成數千次 API 呼叫，又慢又吃 egress 額度（免費方案 5 GB/月）。
-- 寫入時順手記下來，之後只要一次 SQL 聚合。
--
-- 既有列為 NULL（當時沒有這個欄位），容量統計會如實回報「未知大小的列數」，
-- 不會拿舊資料去推估而給出假精確的數字。
-- =============================================================================

alter table public.raw_snapshots
  add column if not exists body_bytes integer;

comment on column public.raw_snapshots.body_bytes is
  '原始 bytes 壓縮後、實際佔用儲存空間的大小。content_length 為壓縮前大小，兩者不可混用。'
  '0005 之前寫入的列為 NULL。';

-- 欄位級 INSERT 權限：把新欄位加進允許清單（0003 的清單沒有它）
grant insert (
  source_id, url, market, source_tier,
  data_as_of, data_as_of_reason, data_period, fetched_at,
  content_hash, content_length, body_store, body_path, body_bytes,
  observed_fields, observed_data_dates, observed_data_periods,
  row_count, heterogeneous_row_count,
  http_status, etag, last_modified, duration_ms, attempt
) on public.raw_snapshots to service_role;

-- =============================================================================
-- 執行完成後跑 `npm run l0:ingest` 讓新資料帶上大小，再跑 `npm run l0:audit`
-- 即可看到容量統計與剩餘天數推算。
-- =============================================================================
