# 台股分析交易助手

台股波段（數日至兩週）**分析與訊號系統**。v1 只產生訊號、通知與紀錄，**不下單**。
目標不是預測股價，是紀律執行、成本精算、風險控制。

開發規範見 [CLAUDE.md](CLAUDE.md)。

## 現況

| Phase | 內容 | 狀態 |
|---|---|---|
| P0 | 成本／損益兩平模組 | ✅ 完成 |
| P1 | L0 抓 TWSE/TPEx | ✅ 完成 |
| P2 | L0 擴充 MOPS/TAIFEX | ✅ 完成 |
| P3 | append-only 上 Supabase + drift | 未開始 |
| … | 見 CLAUDE.md Phase 順序 | |

## 指令

```bash
npm install
npm test            # 107 個離線測試（不碰網路）
npm run typecheck
npm run l0:ingest   # 實際連線抓取 13 個來源，存到 ./data/raw
```

對真實官方端點的契約測試預設跳過，手動執行：

```bash
$env:L0_LIVE='1'; npx vitest run src/lib/l0/__tests__/live-contract.test.ts
```

## P0 模組：`src/lib/cost`

純函式、無副作用、零外部依賴。

| 檔案 | 用途 |
|---|---|
| `types.ts` | 全部 interface / type |
| `money.ts` | bigint 金額運算與捨入 |
| `fee-schedule.ts` | 費率常數 + 法規來源 + 施行期限檢核 |
| `cost.ts` | 手續費／證交稅／損益兩平／R 倍數 |

### 為何不用浮點數

金額一律以「分」(cent = 1/100 元) 的 `bigint` 表示。原因：

1. **中間值會溢位。** 成交額 1,000 萬元 = 1e9 分，× 1425 (ppm) × 10000 (bps)
   ≈ 1.4e16 > `Number.MAX_SAFE_INTEGER` (9.007e15)，浮點會靜默失真。
2. **捨入必須顯式。** 手續費有最低額與「元以下」處理，本質是整數運算。
3. **零依賴。** 不引入 decimal.js / big.js。

價格輸入超過 2 位小數即拋錯——錯誤擋在邊界，不讓誤差傳進計算。

### 費率依據（每季覆核，最後查證 2026-08-16）

| 項目 | 值 | 來源 |
|---|---|---|
| 手續費**上限** | 1.425‰ | [TWSE 民國97/2/1 公告](https://www.twse.com.tw/staticFiles/marketAnnounce/setAnnounce/0970003165.htm) |
| 證交稅（股票） | 3‰ | [證券交易稅條例 §2 第1款](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=G0340078&flno=2) |
| 現股當沖證交稅 | 1.5‰，至 2027-12-31 | [證券交易稅條例 §2-2](https://law.moj.gov.tw/LawClass/LawSingle.aspx?flno=2-2&pcode=G0340078) |

**1.425‰ 是上限不是固定費率**，實際費率與折讓由券商自訂。
最低手續費（常見 20 元）與「元以下」捨入方式**查無法規依據**，屬券商商業條件，
一律列為 `BrokerFeeConfig` 輸入參數，不寫死。

⚠️ 本系統禁止當沖。`day_trade` 模式僅供成本比較，任何呼叫都會回傳 warning。

## 環境變數

`.env.local` 存實際金鑰，**已被 gitignore 排除，不會上傳**。
`.env.example` 是範本（只放假值，會進版控）。填寫指引寫在 `.env.local` 檔內。

## L0 資料層：`src/lib/l0`（P1 行情 + P2 MOPS/TAIFEX）

L0 鐵則：**只存不判斷**。原始回應逐位元組保存，不清洗、不篩選、不改欄位名、
不修正官方怪癖：

- 櫃買行情 `LatesAskPrice`（少一個 t）
- TWSE 重大訊息 `"主旨 "`（結尾帶一個空格；櫃買的 `"主旨"` 則沒有）
- 櫃買基本資料 `UnifiedBusinessNo.`、`Paidin.Capital.NTDollars`（帶點）

| 檔案 | 用途 |
|---|---|
| `sources.ts` | 已實測驗證的端點註冊表 + 基準欄位 |
| `roc-date.ts` | 民國年 ↔ 西元（`"1150814"` → `"2026-08-14"`） |
| `date-formats.ts` | 多格式日期解析（西元壓縮、民國年月），格式由來源事先宣告 |
| `snapshot.ts` | payload 觀察、SHA-256、schema drift 比對 |
| `fetcher.ts` | HTTP 抓取，fetch／時鐘／sleep 皆注入，可離線測試 |
| `file-store.ts` | append-only 檔案儲存 |
| `ingest.ts` | 編排：依序抓取 + 禮貌延遲，單一來源失敗不中斷其他 |

### 已驗證端點（13 個，2026-08-16 實測，每季覆核）

端點目錄來源：
[TWSE](https://openapi.twse.com.tw/v1/swagger.json)（143 個）／
[TPEx](https://www.tpex.org.tw/openapi/swagger.json)（225 個）／
[TAIFEX](https://openapi.taifex.com.tw/swagger.json)（135 個）。

| SourceId | 內容 | 給哪個 Phase 用 |
|---|---|---|
| `twse_stock_day_all` | 上市個股日成交資訊 | P5 價量因子／P9 報酬 |
| `twse_bwibbu_all` | 上市本益比／殖利率／淨值比 | P5 評價因子 |
| `tpex_mainboard_daily_close_quotes` | 上櫃每日收盤行情 | P5 價量因子／P9 報酬 |
| `tpex_mainboard_peratio_analysis` | 上櫃本益比／殖利率／淨值比 | P5 評價因子 |
| `mops_twse_monthly_revenue` | 上市月營收 | P5 營收動能 |
| `mops_tpex_monthly_revenue` | 上櫃月營收 | P5 營收動能 |
| `mops_twse_company_profile` | 上市公司基本資料 | P5 分群／P6 規模門檻 |
| `mops_tpex_company_profile` | 上櫃股票基本資料 | P5 分群／P6 規模門檻 |
| `mops_twse_material_announcements` | 上市每日重大訊息 | P6 L2 事件過濾 |
| `mops_tpex_material_announcements` | 上櫃每日重大訊息 | P6 L2 事件過濾 |
| `taifex_institutional_futures_options` | 三大法人期貨與選擇權 | P6 L2 市場環境 |
| `taifex_put_call_ratio` | 臺指選擇權 Put/Call 比 | P6 L2 市場情緒 |
| `taifex_large_traders_futures` | 期貨大額交易人未沖銷部位 | P6 L2 市場環境 |

### 日期規則：三個欄位不可混為一談

| 欄位 | 來源 | 例 |
|---|---|---|
| `fetched_at` | 系統時鐘 | 2026-08-16T00:46:01Z |
| `data_as_of` | payload 的日期欄位 | 2026-08-15（月營收出表日） |
| `data_period` | payload 的期間欄位 | 2026-07（營收所屬月份） |

月營收在 **8/15 才公布 7 月的數字**。把 `data_period` 當成 `data_as_of` 用，
就是拿未來資訊解釋過去股價（前視偏誤）。

日期格式與選取規則**由來源事先宣告**，不從資料內容猜測：

- `dateFormat`：`roc_compact`（`"1150814"`）／`ad_compact`（TAIFEX 的 `"20260814"`）
- `dateSelection`：`unique`（單日快照）／`max`（滾動視窗，如 PutCallRatio 一次回 23 天）

### append-only 怎麼保證

1. 檔名就是內容的 SHA-256 → 內容一變必然是不同檔案，不可能覆蓋舊資料
2. 寫入用 `flag: 'wx'`（存在即失敗），不用 `'w'`
3. `FileSnapshotStore` **沒有** delete / update 方法（有測試斷言這件事）
4. `manifest.jsonl` 每次抓取追加一行，含失敗，永不重寫

`data_as_of` 一律從 payload 的日期欄位取得，**不用系統時鐘推定**；
無法唯一判定時記為 `null` 並寫下原因（`multiple_dates_in_payload` /
`date_field_missing` / `date_unparsable` / `invalid_json` …）。

儲存位置：`./data/raw`（已 gitignore）。P3 換成 Supabase + RLS 時只換
`SnapshotStore` 實作，抓取層不動。

## 免責

本專案為個人研究與紀律執行工具，不對外提供個股建議
（涉《證券投資信託及顧問法》）。所有輸出僅供參考。
