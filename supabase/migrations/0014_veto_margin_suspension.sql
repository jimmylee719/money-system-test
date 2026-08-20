-- =============================================================================
-- 0014 — veto_events 允許新的否決規則：停資停券
--
-- 【這條規則與前四條的性質差異，寫在這裡是因為它會影響資料判讀】
-- attention／disposition／suspended／altered_trading 擋的是
-- 「這檔現在不能正常交易」—— 不知道就不能進場，故 fail-closed。
--
-- margin_suspension 擋的是融資融券被停。CLAUDE.md 明文禁止本系統使用
-- 融資融券，所以停券**不影響我們的執行能力**。擋它的理由是：
--   1. 停券原因實測多為「股價波動過度劇烈」，那是交易所自己認定這檔不正常；
--      而我們用波動率算停損，被認定波動過度的標的其波動率估計本身就不可信。
--   2. 停券會抽掉市場槓桿資金、迫使融資戶平倉，那個賣壓與我們的進場理由無關。
--
-- ⚠️ **此規則刻意不 fail-closed**（見 src/lib/l2/rules.ts）。
--    來源缺漏時放行，不讓一個我們根本不用的市場機制決定今天有沒有訊號。
--    日後分析 veto_events 時要記得：margin_suspension 的缺席可能是
--    「當天沒有停券公告」，也可能是「當天沒抓到這個來源」，兩者在本表無法區分。
--    要區分請查 raw_snapshots 有沒有當日的 twse_margin_suspension 快照。
--
-- 執行後請跑：npm run l2:verify
-- =============================================================================

alter table public.veto_events drop constraint if exists veto_events_rule_id_check;
alter table public.veto_events add constraint veto_events_rule_id_check
  check (rule_id in (
    'attention',
    'disposition',
    'suspended',
    'altered_trading',
    'margin_suspension',
    'llm_material_news',
    'source_unavailable'
  ));

comment on constraint veto_events_rule_id_check on public.veto_events is
  '允許的否決規則。新增規則必須同步更新 src/lib/l2/types.ts 的 VetoRuleId 與 RULE_SPECS。';
