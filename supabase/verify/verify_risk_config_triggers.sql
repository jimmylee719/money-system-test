-- =============================================================================
-- risk_config 鎖三（觸發器）的獨立驗證 —— 在 Supabase SQL Editor 執行
--
-- 【為什麼需要單獨測】
-- 從應用程式走 service_role key 時，UPDATE/DELETE 會先被「鎖二 REVOKE」擋下，
-- 觸發器根本沒機會執行。`npm run l3:verify` 全綠只證明了鎖二有效。
--
-- SQL Editor 以資料表擁有者身分執行，擁有者保有 UPDATE/DELETE 權限，
-- 因此這裡唯一擋得住的就是觸發器 —— 正好把鎖三單獨隔離出來測。
-- =============================================================================

do $$
declare
  v_id      bigint;
  v_results text := '';
  v_passed  int := 0;
  v_total   int := 3;
begin
  insert into public.risk_config (version, config, config_hash, rationale, registered_by)
  values (
    '__trigger_probe',
    '{"probe": true}'::jsonb,
    repeat('d', 64),
    '此列由 verify_risk_config_triggers.sql 產生，用於單獨驗證觸發器，非真實風控設定。',
    'trigger_probe'
  )
  returning id into v_id;

  raise notice 'probe row inserted, id = %', v_id;

  -- 測試 1：UPDATE —— 事後放寬風控參數
  begin
    update public.risk_config set config_hash = repeat('e', 64) where id = v_id;
    v_results := v_results || 'UPDATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: UPDATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'UPDATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: UPDATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 2：DELETE —— 刪掉舊設定假裝一直都是現在這套
  begin
    delete from public.risk_config where id = v_id;
    v_results := v_results || 'DELETE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: DELETE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'DELETE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: DELETE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 3：TRUNCATE
  begin
    truncate table public.risk_config;
    v_results := v_results || 'TRUNCATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: TRUNCATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'TRUNCATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: TRUNCATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  raise notice '=== risk_config 鎖三（觸發器）結果：% / % 通過 ===', v_passed, v_total;
  if v_passed < v_total then
    raise exception '觸發器驗證未全數通過：%', v_results;
  end if;
end
$$;

-- 探針列留在表內無法刪除 —— 這本身就是 append-only 生效的證據。
select version, config_hash, registered_by, registered_at
from public.risk_config
order by registered_at desc;
