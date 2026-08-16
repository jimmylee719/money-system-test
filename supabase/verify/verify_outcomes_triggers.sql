-- =============================================================================
-- outcomes 鎖三（觸發器）的獨立驗證 —— 在 Supabase SQL Editor 執行
--
-- 【為什麼需要單獨測】
-- 從應用程式走 service_role key 時，UPDATE/DELETE 會先被「鎖二 REVOKE」擋下，
-- 觸發器根本沒機會執行。`npm run l5:verify` 全綠只證明了鎖二有效。
--
-- SQL Editor 以資料表擁有者身分執行，擁有者保有 UPDATE/DELETE 權限，
-- 因此這裡唯一擋得住的就是觸發器 —— 正好把鎖三單獨隔離出來測。
--
-- outcomes 是 G1/G2/G3 的唯一依據。若能事後編輯，
-- 「把賠錢那幾筆刪掉」就沒有任何機制擋得住，整個評估失去意義。
-- =============================================================================

do $$
declare
  v_id      bigint;
  v_results text := '';
  v_passed  int := 0;
  v_total   int := 3;
begin
  insert into public.outcomes (
    pick_id, data_as_of, code, market, list_kind, horizon,
    exit_date, entry_price, exit_price,
    raw_return_pct, adjusted_return_pct,
    share_factor, cash_dividend_per_share, ex_right_count, has_rights_issue,
    barrier_touched, barrier_touch_date,
    trading_days_used, engine_version, computed_at
  ) values (
    999999999, date '2026-08-14', '__probe_trigger', 'TWSE', 'watchlist', 5,
    date '2026-08-21', 100, 105,
    5, 5,
    1, 0, 0, false,
    null, null,
    5, 'trigger_probe', now()
  )
  returning id into v_id;

  raise notice 'probe row inserted, id = %', v_id;

  -- 測試 1：UPDATE —— 事後把報酬改漂亮
  begin
    update public.outcomes set adjusted_return_pct = 99 where id = v_id;
    v_results := v_results || 'UPDATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: UPDATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'UPDATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: UPDATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 2：DELETE —— 刪掉賠錢的那幾筆
  begin
    delete from public.outcomes where id = v_id;
    v_results := v_results || 'DELETE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: DELETE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'DELETE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: DELETE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 3：TRUNCATE —— 整張清空重來
  begin
    truncate table public.outcomes;
    v_results := v_results || 'TRUNCATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: TRUNCATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'TRUNCATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: TRUNCATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  raise notice '=== outcomes 鎖三（觸發器）結果：% / % 通過 ===', v_passed, v_total;
  if v_passed < v_total then
    raise exception '觸發器驗證未全數通過：%', v_results;
  end if;
end
$$;

-- 探針列留在表內無法刪除 —— 這本身就是 append-only 生效的證據。
-- 下游查詢一律過濾 pick_id < 900000000。
select data_as_of, code, horizon, adjusted_return_pct, engine_version, inserted_at
from public.outcomes
where pick_id >= 900000000
order by inserted_at desc
limit 10;
