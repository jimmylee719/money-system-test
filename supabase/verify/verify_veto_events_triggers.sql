-- =============================================================================
-- veto_events 鎖三（觸發器）的獨立驗證 —— 在 Supabase SQL Editor 執行
--
-- 【為什麼需要單獨測】
-- 從應用程式走 service_role key 時，UPDATE/DELETE 會先被「鎖二 REVOKE」擋下，
-- 觸發器根本沒機會執行。`npm run l2:verify` 全綠只證明了鎖二有效。
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
  insert into public.veto_events (
    run_id, data_as_of, signal_at,
    code, market, rule_id, reason, evidence,
    rank_at_signal, composite_score, engine_version, failed_closed
  ) values (
    '00000000-0000-4000-8000-000000000002', date '2026-08-14', now(),
    '__probe_trigger', 'TWSE', 'attention', '觸發器驗證探針',
    '此列由 verify_veto_events_triggers.sql 產生，非真實否決',
    1, 0.5, 'trigger_probe', false
  )
  returning id into v_id;

  raise notice 'probe row inserted, id = %', v_id;

  -- 測試 1：UPDATE —— 事後改寫否決理由
  begin
    update public.veto_events set reason = 'TAMPERED' where id = v_id;
    v_results := v_results || 'UPDATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: UPDATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'UPDATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: UPDATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 2：DELETE —— 刪掉不利的否決紀錄
  begin
    delete from public.veto_events where id = v_id;
    v_results := v_results || 'DELETE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: DELETE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'DELETE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: DELETE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  -- 測試 3：TRUNCATE
  begin
    truncate table public.veto_events;
    v_results := v_results || 'TRUNCATE=FAIL(未被擋下); ';
    raise warning '✗ FAIL: TRUNCATE 沒有被擋下來';
  exception when others then
    v_passed := v_passed + 1;
    v_results := v_results || 'TRUNCATE=PASS(' || sqlstate || '); ';
    raise notice '✓ PASS: TRUNCATE 被擋 [%] %', sqlstate, sqlerrm;
  end;

  raise notice '=== veto_events 鎖三（觸發器）結果：% / % 通過 ===', v_passed, v_total;
  if v_passed < v_total then
    raise exception '觸發器驗證未全數通過：%', v_results;
  end if;
end
$$;

-- 探針列留在表內無法刪除 —— 這本身就是 append-only 生效的證據。
-- 下游查詢一律過濾 code not like '__probe%'。
select data_as_of, code, rule_id, reason, engine_version, inserted_at
from public.veto_events
where code like '__probe%'
order by inserted_at desc
limit 10;
