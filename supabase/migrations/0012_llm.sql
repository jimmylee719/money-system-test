-- =============================================================================
-- P11 — gold_set + 本機 LLM 佇列
--   model_registry / gold_set / llm_queue / llm_results
--
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上全文 → Run。可重複執行。
--
-- 【CLAUDE.md 第四條鐵則：L2 只能否決】
-- 這四張表存在的唯一理由，是讓 LLM 讀重大訊息原文後**否決**候選標的。
-- 這件事在資料層就被鎖死：`llm_results.verdict` 的 check constraint
-- 只有 'veto' 與 'no_veto' 兩個值。
-- 資料庫裡**不存在**任何可以表達「買進」的欄位或值——
-- 不是靠程式自律，是這個結構根本無法表達那個意思。
--
-- 【禁止熱抽換】
-- role='champion' 的列必須同時填上 gold_accuracy / gold_sample_size /
-- gold_set_hash，缺一即被 constraint 擋下。
-- 換句話說：**沒有考過 gold_set 的模型，資料庫不讓它當 champion**。
--
-- 【為什麼四張表都是 append-only（含佇列）】
-- 一般佇列會就地把 status 從 pending 改成 done，但那需要 UPDATE 權限，
-- 而 UPDATE 權限一旦開給 service_role，這張表就不再是不可竄改的紀錄。
-- 這裡改用「有沒有結果」來決定待辦：
--     待處理 = llm_queue 裡沒有對應 llm_results 的列
-- 佇列本身永不修改，處理歷程完全可回溯。
-- =============================================================================


-- =============================================================================
-- 1. model_registry — 模型換代紀錄
--
-- 「目前的 champion」= role='champion' 中 registered_at 最新的那一列。
-- 舊的 champion 全部保留，歷史日誌永遠可回溯由哪個模型產生。
-- =============================================================================
create table if not exists public.model_registry (
  id                bigint      generated always as identity primary key,

  /** 模型識別，如 qwen2.5:7b-instruct。照抄 provider 的名稱，不美化 */
  model_key         text        not null,
  /** ollama / lmstudio / openai_compatible */
  provider          text        not null,
  /** 本機端點，如 http://127.0.0.1:11434/v1。⚠️ 不得填入任何含金鑰的網址 */
  endpoint          text        not null,

  /** champion（現役）或 challenger（並行測試中） */
  role              text        not null,

  /**
   * 換 prompt 等同換模型。
   * 同一個模型配不同 prompt 是兩個不同的系統，必須分開登記、分開評分。
   */
  prompt_version    text        not null,
  prompt_hash       text        not null,
  /** temperature / seed / max_tokens 等推論參數的雜湊 */
  params_hash       text        not null,
  params_json       jsonb       not null,

  /** 晉升時在 gold_set 上的成績。champion 必填，challenger 可留空 */
  gold_accuracy     numeric(6,4),
  gold_sample_size  integer,
  gold_set_hash     text,
  /** 漏擋（該否決卻沒否決）與誤擋（不該否決卻否決）分開記，總正確率會騙人 */
  gold_false_negatives integer,
  gold_false_positives integer,

  /** 前一任 champion 的 id。第一任為 null */
  promoted_from     bigint,
  note              text        not null default '',

  registered_at     timestamptz not null,
  inserted_at       timestamptz not null default now(),

  constraint model_registry_role_check
    check (role in ('champion', 'challenger')),
  constraint model_registry_provider_check
    check (provider in ('ollama', 'lmstudio', 'openai_compatible')),
  /**
   * 端點必須是本機。CLAUDE.md：本機 Ollama worker，僅 outbound，不開 inbound port，
   * 且本專案零 AI API 支出。允許外部端點就等於允許意外計費。
   */
  constraint model_registry_local_endpoint_check
    check (endpoint ~ '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$'),
  /** 禁止熱抽換：沒有 gold_set 成績就不能當 champion */
  constraint model_registry_champion_needs_score_check
    check (
      role <> 'champion'
      or (
        gold_accuracy is not null
        and gold_sample_size is not null
        and gold_set_hash is not null
        and gold_false_negatives is not null
        and gold_false_positives is not null
      )
    ),
  /** CLAUDE.md：樣本 < 30 筆不得下結論 */
  constraint model_registry_min_sample_check
    check (gold_sample_size is null or gold_sample_size >= 30),
  constraint model_registry_accuracy_range_check
    check (gold_accuracy is null or (gold_accuracy >= 0 and gold_accuracy <= 1))
);

comment on table public.model_registry is
  'P11 模型換代紀錄。append-only：champion 必須帶 gold_set 成績，禁止熱抽換。';

create index if not exists model_registry_role_idx
  on public.model_registry (role, registered_at desc);


-- =============================================================================
-- 2. gold_set — 人工標註的標準答案
--
-- 這是考卷。模型考幾分、能不能晉升，全看這張表。
-- 因此它必須由**人**填寫：LLM 不得標註自己的考卷。
-- =============================================================================
create table if not exists public.gold_set (
  id            bigint      generated always as identity primary key,

  /** 穩定識別碼：{market}:{code}:{發言日期}:{內容雜湊前 12 碼} */
  item_key      text        not null,
  /** 重標時寫新的 revision，舊的保留。查詢取最新 revision */
  revision      integer     not null default 1,

  source_id     text        not null,
  code          text        not null,
  market        text        not null,
  /** 發言日期（ISO）。這是事件時點，不是抓取時點 */
  speak_date    date        not null,

  /** 官方原文，逐字保留不改寫不摘要 */
  clause        text        not null,
  subject       text        not null,
  detail        text        not null,
  /** 官方 payload 的 SHA-256，與 llm_queue 互相稽核 */
  content_hash  text        not null,

  /** 標準答案。只有兩個值——這張表也無法表達「買進」 */
  label         text        not null,
  /** 為什麼這樣標。空白即拒絕，理由同 factor_registry 的 economic_rationale */
  label_reason  text        not null,
  labeled_by    text        not null,
  labeled_at    timestamptz not null,

  inserted_at   timestamptz not null default now(),

  constraint gold_set_label_check
    check (label in ('veto', 'no_veto')),
  constraint gold_set_reason_not_blank_check
    check (length(btrim(label_reason)) >= 4),
  constraint gold_set_market_check
    check (market in ('TWSE', 'TPEx')),
  constraint gold_set_revision_check
    check (revision >= 1),
  /** 標註者必須是人。留下這欄就是為了日後能查「這題是誰標的」 */
  constraint gold_set_labeler_not_blank_check
    check (length(btrim(labeled_by)) >= 1),
  constraint gold_set_no_backfill_check
    check (speak_date >= date '2026-08-01')
);

comment on table public.gold_set is
  'P11 標準答案集。append-only：模型的考卷，必須由人標註，重標寫新 revision。';

create unique index if not exists gold_set_item_revision_uniq
  on public.gold_set (item_key, revision);
create index if not exists gold_set_speak_date_idx
  on public.gold_set (speak_date desc);


-- =============================================================================
-- 3. llm_queue — 待判任務
--
-- append-only。狀態不存在這張表裡，而是由 llm_results 是否有對應列決定。
-- =============================================================================
create table if not exists public.llm_queue (
  id            bigint      generated always as identity primary key,

  /** 與 gold_set.item_key 同一套規則，故同一則公告在兩張表可以對得起來 */
  task_key      text        not null,

  /** 這則公告要影響哪一天的訊號 */
  data_as_of    date        not null,
  source_id     text        not null,
  code          text        not null,
  market        text        not null,
  speak_date    date        not null,

  clause        text        not null,
  subject       text        not null,
  detail        text        not null,
  content_hash  text        not null,

  enqueued_at   timestamptz not null,
  inserted_at   timestamptz not null default now(),

  constraint llm_queue_market_check
    check (market in ('TWSE', 'TPEx')),
  /**
   * 【前視偏誤的判準是「排入當下」，不是「訊號日」】
   *
   * 一開始這裡寫的是 `speak_date <= data_as_of`，那是錯的，實測時才發現：
   * 8/14（週五）收盤的行情產生訊號，公司在 8/15（週六）發布重大訊息，
   * 而這筆訊號最快也要 8/17（週一）開盤才進場——
   * 8/15 的公告在進場前就已經公開，用它來否決不但不是前視，
   * 反而是「明知有壞消息還照買」。原本的寫法會把最該擋的新聞全部丟掉。
   *
   * 真正的前視是：用**排入當下還沒發生**的公告。
   * 所以判準改成公告日不得晚於排入時的台北日期。
   * 至於「不可以拿好幾天後才抓到的新聞回頭否決舊訊號」，
   * 那由 llm-enqueue.ts 的同批抓取檢查負責（與 L2 既有的 isSameRun 同一套規則）。
   */
  constraint llm_queue_not_future_check
    check (speak_date <= ((enqueued_at at time zone 'Asia/Taipei')::date)),
  constraint llm_queue_no_backfill_check
    check (data_as_of >= date '2026-08-14')
);

comment on table public.llm_queue is
  'P11 LLM 待判佇列。append-only：待處理 = 沒有對應 llm_results 的列，狀態不就地修改。';

create unique index if not exists llm_queue_task_key_uniq
  on public.llm_queue (task_key);
create index if not exists llm_queue_data_as_of_idx
  on public.llm_queue (data_as_of desc);


-- =============================================================================
-- 4. llm_results — 模型判定結果
--
-- ⚠️ 整個系統最重要的一條 constraint 在這裡：
--     verdict in ('veto', 'no_veto')
-- 沒有第三個值。LLM 在結構上無法產生買進訊號。
-- =============================================================================
create table if not exists public.llm_results (
  id                bigint      generated always as identity primary key,

  task_key          text        not null,
  model_registry_id bigint      not null,
  model_key         text        not null,
  prompt_version    text        not null,
  /** 判定當下該模型的角色，之後晉升也不會改變這筆紀錄的歸屬 */
  role_at_run       text        not null,

  /** 只准否決或不否決。這是 CLAUDE.md 第四條鐵則的資料層實作 */
  verdict           text        not null,

  /**
   * 模型引用的原文片段。程式端會驗證它確實是 detail/subject 的子字串，
   * 驗不過就作廢改判 no_veto 並把 evidence_verified 記為 false。
   * 引用了原文沒有的句子＝幻覺，不得作為否決依據。
   */
  quoted_evidence   text        not null default '',
  evidence_verified boolean     not null,
  /** 回應是否解析成功。失敗時 verdict 一律 no_veto，見下方 check */
  parse_ok          boolean     not null,

  reason            text        not null default '',
  /** 原始回應全文，逐字保留供稽核 */
  raw_response      text        not null,

  latency_ms        integer     not null,
  computed_at       timestamptz not null,
  inserted_at       timestamptz not null default now(),

  constraint llm_results_verdict_check
    check (verdict in ('veto', 'no_veto')),
  constraint llm_results_role_check
    check (role_at_run in ('champion', 'challenger')),
  /**
   * 解析失敗不得否決。
   * 讓「模型壞掉」等於「全部擋掉」，就是把停機權交給一個不可回測的元件；
   * 壞掉時應退回沒有 LLM 的狀態，也就是不否決——但要留下 parse_ok=false 的證據。
   */
  constraint llm_results_parse_fail_cannot_veto_check
    check (parse_ok or verdict = 'no_veto'),
  /** 幻覺的引用不得構成否決 */
  constraint llm_results_veto_needs_evidence_check
    check (verdict <> 'veto' or (evidence_verified and length(btrim(quoted_evidence)) > 0)),
  constraint llm_results_latency_check
    check (latency_ms >= 0)
);

comment on table public.llm_results is
  'P11 LLM 判定結果。append-only：verdict 只有 veto/no_veto，資料層無法表達買進訊號。';

create unique index if not exists llm_results_task_model_uniq
  on public.llm_results (task_key, model_registry_id);
create index if not exists llm_results_task_idx
  on public.llm_results (task_key);


-- =============================================================================
-- 三道鎖（四張表各上一次）
--
-- 鎖一 RLS      ── 擋 anon / authenticated
-- 鎖二 REVOKE   ── 擋 service_role（RLS 對它無效，官方設計即為繞過）
-- 鎖三 TRIGGER  ── 權限被誤 grant 回來也擋
-- =============================================================================

-- ── model_registry ──────────────────────────────────────────────────────────
alter table public.model_registry enable row level security;
drop policy if exists model_registry_read on public.model_registry;
create policy model_registry_read
  on public.model_registry for select to anon, authenticated using (true);

revoke update, delete, truncate on public.model_registry from public, anon, authenticated, service_role;
revoke insert                   on public.model_registry from public, anon, authenticated, service_role;
grant select on public.model_registry to anon, authenticated, service_role;
grant insert (
  model_key, provider, endpoint, role, prompt_version, prompt_hash,
  params_hash, params_json, gold_accuracy, gold_sample_size, gold_set_hash,
  gold_false_negatives, gold_false_positives, promoted_from, note, registered_at
) on public.model_registry to service_role;

drop trigger if exists model_registry_block_update on public.model_registry;
create trigger model_registry_block_update
  before update on public.model_registry
  for each row execute function public.l0_reject_mutation();
drop trigger if exists model_registry_block_delete on public.model_registry;
create trigger model_registry_block_delete
  before delete on public.model_registry
  for each row execute function public.l0_reject_mutation();
drop trigger if exists model_registry_block_truncate on public.model_registry;
create trigger model_registry_block_truncate
  before truncate on public.model_registry
  for each statement execute function public.l0_reject_mutation();

-- ── gold_set ────────────────────────────────────────────────────────────────
alter table public.gold_set enable row level security;
drop policy if exists gold_set_read on public.gold_set;
create policy gold_set_read
  on public.gold_set for select to anon, authenticated using (true);

revoke update, delete, truncate on public.gold_set from public, anon, authenticated, service_role;
revoke insert                   on public.gold_set from public, anon, authenticated, service_role;
grant select on public.gold_set to anon, authenticated, service_role;
grant insert (
  item_key, revision, source_id, code, market, speak_date,
  clause, subject, detail, content_hash,
  label, label_reason, labeled_by, labeled_at
) on public.gold_set to service_role;

drop trigger if exists gold_set_block_update on public.gold_set;
create trigger gold_set_block_update
  before update on public.gold_set
  for each row execute function public.l0_reject_mutation();
drop trigger if exists gold_set_block_delete on public.gold_set;
create trigger gold_set_block_delete
  before delete on public.gold_set
  for each row execute function public.l0_reject_mutation();
drop trigger if exists gold_set_block_truncate on public.gold_set;
create trigger gold_set_block_truncate
  before truncate on public.gold_set
  for each statement execute function public.l0_reject_mutation();

-- ── llm_queue ───────────────────────────────────────────────────────────────
alter table public.llm_queue enable row level security;
drop policy if exists llm_queue_read on public.llm_queue;
create policy llm_queue_read
  on public.llm_queue for select to anon, authenticated using (true);

revoke update, delete, truncate on public.llm_queue from public, anon, authenticated, service_role;
revoke insert                   on public.llm_queue from public, anon, authenticated, service_role;
grant select on public.llm_queue to anon, authenticated, service_role;
grant insert (
  task_key, data_as_of, source_id, code, market, speak_date,
  clause, subject, detail, content_hash, enqueued_at
) on public.llm_queue to service_role;

drop trigger if exists llm_queue_block_update on public.llm_queue;
create trigger llm_queue_block_update
  before update on public.llm_queue
  for each row execute function public.l0_reject_mutation();
drop trigger if exists llm_queue_block_delete on public.llm_queue;
create trigger llm_queue_block_delete
  before delete on public.llm_queue
  for each row execute function public.l0_reject_mutation();
drop trigger if exists llm_queue_block_truncate on public.llm_queue;
create trigger llm_queue_block_truncate
  before truncate on public.llm_queue
  for each statement execute function public.l0_reject_mutation();

-- ── llm_results ─────────────────────────────────────────────────────────────
alter table public.llm_results enable row level security;
drop policy if exists llm_results_read on public.llm_results;
create policy llm_results_read
  on public.llm_results for select to anon, authenticated using (true);

revoke update, delete, truncate on public.llm_results from public, anon, authenticated, service_role;
revoke insert                   on public.llm_results from public, anon, authenticated, service_role;
grant select on public.llm_results to anon, authenticated, service_role;
grant insert (
  task_key, model_registry_id, model_key, prompt_version, role_at_run,
  verdict, quoted_evidence, evidence_verified, parse_ok,
  reason, raw_response, latency_ms, computed_at
) on public.llm_results to service_role;

drop trigger if exists llm_results_block_update on public.llm_results;
create trigger llm_results_block_update
  before update on public.llm_results
  for each row execute function public.l0_reject_mutation();
drop trigger if exists llm_results_block_delete on public.llm_results;
create trigger llm_results_block_delete
  before delete on public.llm_results
  for each row execute function public.l0_reject_mutation();
drop trigger if exists llm_results_block_truncate on public.llm_results;
create trigger llm_results_block_truncate
  before truncate on public.llm_results
  for each statement execute function public.l0_reject_mutation();

-- =============================================================================
-- 5. veto_events 新增一條 rule_id：llm_material_news
--
-- 0007 的註解寫著「新增一條否決規則就必須改這個 migration，也就是必須有人看過。
-- 否決層無聲無息地多長出一條規則，是這個系統最不該發生的事。」
-- 這裡就是那個「必須有人看過」的地方，所以把話講在前面：
--
--   這一條與既有四條**性質不同**。
--   attention / disposition / suspended / altered_trading 依據的是交易所公告的事實。
--   llm_material_news 依據的是一個本機模型對公告文字的判讀——
--   不可回測、可能出錯、而且沒有任何人能保證它明天的判斷跟今天一樣。
--
--   允許它存在的唯一理由是：它只能減少行動。
--   讓它獨立成一條 rule_id 的理由是：日後要能單獨衡量它、單獨把它關掉。
-- =============================================================================
alter table public.veto_events drop constraint if exists veto_events_rule_id_check;
alter table public.veto_events add constraint veto_events_rule_id_check
  check (rule_id in (
    'attention',
    'disposition',
    'suspended',
    'altered_trading',
    'llm_material_news',
    'source_unavailable'
  ));

-- =============================================================================
-- 執行完成後請跑：
--   npm run llm:verify        （四張表三道鎖與 constraint 實測）
-- =============================================================================
