-- =============================================================================
-- 鎖三（觸發器）的獨立驗證 —— 在 Supabase SQL Editor 執行
--
-- 【為什麼需要單獨測】
-- 從應用程式走 service_role key 時，UPDATE/DELETE 會先被「鎖二 REVOKE」擋下，
-- 觸發器根本沒機會執行。那樣只證明了鎖二有效，鎖三仍是未驗證的假設。
--
-- SQL Editor 是以資料表擁有者身分執行，擁有者保有 UPDATE/DELETE 權限，
-- 因此這裡唯一擋得住的就是觸發器 —— 正好把鎖三單獨隔離出來測。
--
-- 每個嘗試都包在 BEGIN...EXCEPTION 子交易裡，被擋下來不會中斷整個腳本。
-- 結果同時 RAISE NOTICE（你在畫面上看得到）並寫入 source_health（程式可讀取複驗）。
-- =============================================================================

do $$
declare
  v_id      bigint;
  v_results text := '';
  v_passed  int := 0;
  v_total   int := 3;
begin
  -- 先塞一列探針資料（INSERT 應該要成功）
  insert into public.raw_snapshots (
    source_id, url, market, source_tier,
    data_as_of, data_as_of_reason, data_period, fetched_at,
    content_hash, content_length, body_store, body_path,
    observed_fields, observed_data_dates, observed_data_periods,
    row_count, heterogeneous_row_count,
    http_status, etag, last_modified, duration_ms, attempt
  ) values (
    '__trigger_probe__', 'https://example.invalid/probe', 'TWSE', 'official_primary',
    null, 'invalid_json', null, now(),
    repeat('0', 64), 0, 'file', null,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    null, null,
    200, null, null, 0, 1
  )
  returning id into v_id;

  raise notice 'probe row inserted, id = %', v_id;

  -- 測試 1：UPDATE
  begin
    update public.raw_snapshots set url = 'TAMPERED' where id = v_id;
    v_results := v_results || 'UPDATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: UPDATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'UPDATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: UPDATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 2：DELETE
  begin
    delete from public.raw_snapshots where id = v_id;
    v_results := v_results || 'DELETE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: DELETE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'DELETE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: DELETE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 3：TRUNCATE
  begin
    truncate table public.raw_snapshots;
    v_results := v_results || 'TRUNCATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: TRUNCATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'TRUNCATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: TRUNCATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 把結果寫進 source_health，讓外部程式可以讀取複驗
  insert into public.source_health (
    source_id, observed_at, status, http_status, content_hash,
    fields_added, fields_removed, row_count, heterogeneous_row_count,
    data_as_of_reason, error
  ) values (
    '__trigger_probe__', now(), 'ok', null, null,
    '[]'::jsonb, '[]'::jsonb, v_passed, v_total,
    null, v_results
  );

  raise notice '=== 鎖三（觸發器）結果：% / % 通過 ===', v_passed, v_total;
  if v_passed < v_total then
    raise exception '觸發器驗證未全數通過：%', v_results;
  end if;
end
$$;

-- 探針資料留在表內無法刪除 —— 這本身就是 append-only 生效的證據。
-- 後續各層一律以 source_id 白名單查詢，不會讀到 __trigger_probe__。
select
  source_id,
  observed_at,
  row_count      as passed,
  heterogeneous_row_count as total,
  error          as details
from public.source_health
where source_id = '__trigger_probe__'
order by observed_at desc
limit 5;
