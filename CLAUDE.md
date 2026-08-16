# CLAUDE.md — 台股分析交易助手

## 專案定位
台股波段（數日至兩週）**分析與訊號系統**。v1 只通知與紀錄，**不下單**。
目標不是預測股價，是紀律執行、成本精算、風險控制。

## 五條鐵則（違反即停工）
1. **不捏造**：來源、數字、法規條號、API 端點查不到就說查無。2. **事實／推論分開標示**。
3. **L0 只存不判斷**（append-only，永不覆寫）。4. **L2 只能否決**：不可回測的判斷（新聞／
LLM）只准減少行動，禁止產生買進訊號。5. **未驗證不宣稱完成**：過閘門才 commit。

## 架構分層
```
L4 介面  LINE 日報 / 紀錄指令 / Excel 匯出
L3 風控  部位大小 / 換手預算 / 曝險 / 熔斷      ← 硬上限，無例外
L2 否決  事件過濾 / 注意處置股 / 流動性 / 財報   ← 只減不增
L1 訊號  已登記因子 → 排序 → 候選清單           ← v1 最多 5 個因子
L0 資料  多來源抓取 / 原始快照 / append-only     ← 廣度無上限
```
## 每日產出：兩個清單，不可混淆
- **觀察榜 Top 5**：每日固定 5 檔，**研究紀錄，非買進建議**，用來評估排序有無預測力
- **交易訊號**：通過 L2+L3 者，**0～N 檔。經常是 0 檔，這是正常且健康的**

## 技術棧
- Next.js 16.2.x LTS + React 19.2.4+ + TypeScript strict + Tailwind + shadcn/ui
- Supabase (PostgreSQL + RLS)／**GitHub Actions（排程）**／Vercel（Dashboard 部署）／R2／LINE
  - 排程用 GitHub Actions 不用 Vercel Pro Cron：public repo 標準 runner 免費且無限，
    每日抓取約 30 秒；Vercel Pro 為 US$20/月。已於 2026-08-16 查證官方文件並實測。
- Python 獨立 service：因子檢定與統計運算（pandas / numpy / scipy）
- **本機 Ollama worker（L2 選配）**：非同步佇列，僅 outbound，不開 inbound port
- 字型**禁用 Inter**；無動畫函式庫；AVIF 優先
- ❌ 不設 `ANTHROPIC_API_KEY`（避免誤計費至 API）；本專案零 AI API 支出
## 資料來源優先序
1. **官方一手**（唯一可作訊號依據）：TWSE / TPEx / TAIFEX OpenAPI、MOPS  2. **交叉驗證**：
FinMind（須標記 `source_tier`）  3. ❌ 社群爬蟲、內容農場、無署名彙整頁
**端點須先實測回應 200 並記錄實際欄位，才可寫入來源註冊表**；日期格式與選取規則
（民國／西元、單日／滾動視窗）一律事先宣告，不從資料內容猜測——猜測就是判斷。
官方欄位錯字照抄不修正（如櫃買 `LatesAskPrice`、TWSE `"主旨 "` 結尾空格）。

## 核心 Schema
```
raw_snapshots   append-only  必含 data_as_of / data_period / fetched_at / content_hash
source_health   append-only  schema drift 紀錄
factor_registry append-only  必含 economic_rationale（空白即拒絕）
daily_picks     append-only  必含 data_as_of / signal_at / price_at_push
user_records    你的紀錄（買/賣/觀望/略過/備註），必含 recorded_at
outcomes        T+5/T+10/T+20 報酬與屏障觸及  ← 僅系統可寫，人工不可改
turnover_ledger / benchmark_daily / positions
llm_queue / model_registry / llm_results / gold_set
```
**append-only 須上三道鎖，缺一不可，且須實測驗證**（2026-08-16 實測修訂）：
1. RLS policy 只給 SELECT ── 擋 anon / authenticated
2. `REVOKE UPDATE, DELETE, TRUNCATE` ── **RLS 擋不住 service_role**（官方設計即為繞過
   RLS），而排程正是以 service_role 寫入；只做 RLS 等於只鎖訪客
3. `BEFORE UPDATE/DELETE/TRUNCATE` 觸發器 raise exception ── 權限被誤 grant 回來也擋
鎖三須**單獨**驗證：從程式端會先被鎖二擋掉，觸發器根本不會執行。
**三個時間欄位語意不同不可混用**：`data_as_of`（payload 自身日期）／`data_period`
（資料涵蓋期間，如月營收 8/15 公布 7 月數字）／`fetched_at`（系統時鐘）。混用即前視偏誤。
**Postgres 只存帳本與 content_hash，原始 bytes 存 R2／檔案**：13 來源每日約 6.5 MB，
入庫兩個多月即撐爆免費額度。兩邊靠 content_hash 互相稽核。
**daily_picks 與 user_records 必須分表**：系統建議與人的決策分開存，才能比對差異。

## 買賣邏輯（Triple-Barrier，不可簡化）
進場前同時寫死三道屏障：**停損**（=1R）／**停利**（≥2R）／**時間出場**（N 日未觸發即
平倉，資金週轉引擎）。屏障用報酬 **EWMA 動態調整**，不用固定百分比。
- 部位：`股數 = (總資金 × r) ÷ (進場價 − 停損價)`，r = 1%–2%
- 換手預算：每月進場筆數硬上限，超過即拒絕所有新訊號
- ❌ 不得採用「獲利就賣」：壓縮平均獲利、放任虧損無上限，且套牢部位會鎖死資金

## 因子預先登記
進入 L1 前須在**看到結果之前**登記：定義（鎖定不得調參）／經濟理由（空白即拒絕）／
檢定期間／假設方向／門檻 **t > 3.0**。失敗即封存，**不得改條件重測**。
## 驗證方法（涉及任何擬合時）
**Purged K-Fold CV + Embargo**（標準 k-fold 在金融資料必然洩漏，禁用）／**Deflated Sharpe
Ratio** 取代普通 Sharpe，須連同試驗次數呈報／**Meta-labeling**：ML 只預測「本次訊號會否
成功」→ 決定部位大小，**不預測方向**
## 模型換代規則
- Provider 抽象層走設定檔；Ollama / LM Studio 以 OpenAI 相容端點接入
- ❌ **禁止熱抽換**：新模型須 Champion/Challenger 並行，對 `gold_set` 正確率勝出才晉升
- 切換時點寫入 `model_registry`，歷史日誌永遠可回溯由哪個模型產生

## 獲利定義
主指標：Expectancy(R) > 0、Profit Factor > 1.3、MDD 在容忍值內
**基準：風險調整後淨報酬須勝過 0050 買入持有，否則系統無存在價值**
不採用：勝率、未扣成本毛報酬、忽略回撤的累積報酬。樣本 < 30 筆不得下結論。

## 禁止事項
❌ 當沖、零股沖銷（制度禁止）、融資融券、槓桿｜❌ 用 LLM 產生買進訊號
❌ 系統自動修改分析邏輯或因子參數｜❌ 回測後調參再宣稱有效（前視偏誤）
❌ 提交 `.env.local`、service role key、LINE channel secret、券商憑證
❌ 對外提供個股建議（涉《證券投資信託及顧問法》）
## 開發流程
一 Phase 一 commit（`P0: 階段名稱`），過閘門才 commit 並回報 hash；每階段只產出最小可驗證
增量；交付時說明：驗證了什麼、怎麼驗的、殘餘風險。

## Phase 順序
```
P0 成本／損益兩平        P5 L1 訊號引擎+排序      P10 Dashboard + 0050 對照
P1 L0 抓 TWSE/TPEx       P6 L2 否決層（規則式）   P11 gold_set + 本機 LLM 佇列
P2 L0 擴充 MOPS/TAIFEX   P7 L3 風控               P12 Meta-labeling + Purged CV + DSR
P3 append-only + drift   P8 LINE 日報 + /rec 紀錄 ── G1–G5 閘門 ──
P4 factor_registry       P9 outcomes + Excel 匯出  v2 自動下單
```

## 自動下單解鎖閘門（全通過才進 v2）
G1 ≥6 個月且 ≥100 筆訊號｜G2 Expectancy>0 且 PF>1.3｜G3 勝過 0050
G4 人工執行一致率 >90%｜G5 資料管線連續 60 日零故障

## 停止條件（觸發即停機檢討）
淨值回撤逾容忍值｜連續 N 筆未依規則執行｜因子 rolling 連續衰減
資料抓取連續失敗 >M 日｜滿 6 個月未勝過 0050

## 基礎設施風險（已查證，須主動監控）
- **Supabase 免費方案**：「low activity in a 7-day period」會暫停專案（官方文件）。
  每日抓取寫入資料庫即算活動；另備獨立 keep-alive 排程，抓取壞掉時仍能保住資料庫。
- **GitHub 排程自動停用**：public repo「60 天無 repository activity」排程會被停用
  （官方文件）。G5 要求連續 60 日零故障，此風險直接衝突，須以提交紀錄或心跳檔規避。
- **GitHub 排程可能延遲**：官方明示整點負載高時可能延後甚至丟棄，故一律避開整點。
## Skill／合規
Skill：`genesis-protocol`（全程）／`data-analysis`（因子檢定）／`xlsx`（Excel 匯出）
AI 揭露依歐盟 AI Act 第 50 條與台灣 AI 基本法。技術棧與法規每季覆核。
