-- =============================================================================
-- P4 修正 — 收回整張表的 INSERT，改為欄位級 INSERT
--
-- 執行方式：Supabase SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【為什麼需要這支】
-- 2026-08-16 實測發現：0001 與 0002 只 revoke 了 UPDATE/DELETE/TRUNCATE，
-- 沒有 revoke INSERT。Supabase 建表時的預設權限已授予 service_role
-- 【整張表】的 INSERT，因此後續的欄位級 `grant insert (欄位清單)` 完全沒有作用
-- —— 應用程式仍可自行指定 registered_at / inserted_at / occurred_at / recorded_at。
--
-- 實測證據：送出 registered_at = '2000-01-01' 的登記，資料庫回應 HTTP 201。
--
-- 欄位級權限要生效，必須先收回表級 INSERT。順序不可顛倒。
--
-- 【修正後的保證】
-- 「由資料庫蓋章的時間戳，應用程式無法指定」從此是可驗證的事實，
-- 而不是「我們的程式剛好沒有送那個欄位」。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 步驟一：收回所有角色的表級 INSERT
-- ---------------------------------------------------------------------------
revoke insert on public.raw_snapshots        from public, anon, authenticated, service_role;
revoke insert on public.source_health        from public, anon, authenticated, service_role;
revoke insert on public.factor_registry      from public, anon, authenticated, service_role;
revoke insert on public.factor_status_events from public, anon, authenticated, service_role;
revoke insert on public.factor_test_results  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 步驟二：只把「應用程式該填的欄位」授權回去
--         一律排除 id / inserted_at 及各表由資料庫蓋章的時間欄位。
-- ---------------------------------------------------------------------------

-- raw_snapshots：fetched_at 是應用程式的時鐘讀數（屬觀察事實，應由程式提供），
--                inserted_at 才是資料庫的寫入時點，不開放。
grant insert (
  source_id, url, market, source_tier,
  data_as_of, data_as_of_reason, data_period, fetched_at,
  content_hash, content_length, body_store, body_path,
  observed_fields, observed_data_dates, observed_data_periods,
  row_count, heterogeneous_row_count,
  http_status, etag, last_modified, duration_ms, attempt
) on public.raw_snapshots to service_role;

grant insert (
  source_id, observed_at, status, http_status, content_hash,
  fields_added, fields_removed, row_count, heterogeneous_row_count,
  data_as_of_reason, error
) on public.source_health to service_role;

-- factor_registry：registered_at 是「登記時點」，正是最需要防偽造的欄位，不開放。
grant insert (
  factor_key, display_name, definition, definition_hash, economic_rationale,
  hypothesis_direction, test_period_start, test_period_end, t_threshold,
  universe, registered_by
) on public.factor_registry to service_role;

-- factor_status_events：occurred_at 不開放，狀態變更時點必須真實。
grant insert (factor_key, status, reason) on public.factor_status_events to service_role;

-- factor_test_results：recorded_at 不開放，結果記錄時點必須晚於登記且不可回填。
grant insert (
  factor_key, definition_hash, t_statistic, sample_size,
  observed_direction, passed, method, notes
) on public.factor_test_results to service_role;

-- ---------------------------------------------------------------------------
-- 步驟三：確認 SELECT 權限未受影響
-- ---------------------------------------------------------------------------
grant select on public.raw_snapshots        to anon, authenticated, service_role;
grant select on public.source_health        to anon, authenticated, service_role;
grant select on public.factor_registry      to anon, authenticated, service_role;
grant select on public.factor_status_events to anon, authenticated, service_role;
grant select on public.factor_test_results  to anon, authenticated, service_role;
grant select on public.factor_trial_summary to anon, authenticated, service_role;

-- =============================================================================
-- 執行完成後請跑：
--   npm run l0:verify        （L0 兩張表）
--   npm run factors:verify   （因子登記三張表）
-- 兩者都會實際嘗試偽造時間戳，證明被擋下來。
-- =============================================================================
