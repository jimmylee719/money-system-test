-- =============================================================================
-- daily_picks 鎖三（觸發器）的獨立驗證 —— 在 Supabase SQL Editor 執行
--
-- 【為什麼需要單獨測】
-- 從應用程式走 service_role key 時，UPDATE/DELETE 會先被「鎖二 REVOKE」擋下，
-- 觸發器根本沒機會執行。`npm run l1:verify-picks` 全綠只證明了鎖二有效，
-- 鎖三仍然是未驗證的假設。
--
-- SQL Editor 以資料表擁有者身分執行，擁有者保有 UPDATE/DELETE 權限，
-- 因此這裡唯一擋得住的就是觸發器 —— 正好把鎖三單獨隔離出來測。
--
-- 每個嘗試都包在 BEGIN...EXCEPTION 子交易裡，被擋下來不會中斷整個腳本。
-- =============================================================================

do $$
declare
  v_id      bigint;
  v_results text := '';
  v_passed  int := 0;
  v_total   int := 3;
begin
  -- 探針列：revision 放在 900000 以上，與真實清單（revision < 1000）明顯區隔
  insert into public.daily_picks (
    run_id, revision, data_as_of, signal_at,
    list_kind, rank, code, market, name,
    price_at_push, composite_score, real_factor_count, factor_scores,
    engine_version, active_factors, inactive_factors,
    universe_size, tradable_count, ranked_count
  ) values (
    '00000000-0000-4000-8000-000000000001', 999999, date '2026-08-14', now(),
    'watchlist', 1, '__trigger_probe', 'TWSE', '觸發器驗證探針',
    1, 0.5, 1, '[]'::jsonb,
    'trigger_probe', '[]'::jsonb, '[]'::jsonb,
    0, 0, 0
  )
  returning id into v_id;

  raise notice 'probe row inserted, id = %', v_id;

  -- 測試 1：UPDATE —— 改寫已推出去的推薦價
  begin
    update public.daily_picks set price_at_push = 9999 where id = v_id;
    v_results := v_results || 'UPDATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: UPDATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'UPDATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: UPDATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 2：DELETE —— 刪掉不好看的歷史推薦
  begin
    delete from public.daily_picks where id = v_id;
    v_results := v_results || 'DELETE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: DELETE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'DELETE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: DELETE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 3：TRUNCATE —— 整張清空重來
  begin
    truncate table public.daily_picks;
    v_results := v_results || 'TRUNCATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: TRUNCATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'TRUNCATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: TRUNCATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  raise notice '=== daily_picks 鎖三（觸發器）結果：% / % 通過 ===', v_passed, v_total;
  if v_passed < v_total then
    raise exception '觸發器驗證未全數通過：%', v_results;
  end if;
end
$$;

-- 探針列留在表內無法刪除 —— 這本身就是 append-only 生效的證據。
-- 下游查詢一律過濾 revision < 1000，不會讀到探針。
select
  data_as_of, list_kind, revision, rank, code, engine_version, inserted_at
from public.daily_picks
where revision >= 1000
order by inserted_at desc
limit 10;
