# 台股分析交易助手

台股波段（數日至兩週）**分析與訊號系統**。v1 只產生訊號、通知與紀錄，**不下單**。
目標不是預測股價，是紀律執行、成本精算、風險控制。

開發規範見 [CLAUDE.md](CLAUDE.md)。

## 現況

| Phase | 內容 | 狀態 |
|---|---|---|
| P0 | 成本／損益兩平模組 | ✅ 完成 |
| P1 | L0 抓 TWSE/TPEx | 未開始 |
| … | 見 CLAUDE.md Phase 順序 | |

## 指令

```bash
npm install
npm test        # Vitest，44 個測試
npm run typecheck
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

## 免責

本專案為個人研究與紀律執行工具，不對外提供個股建議
（涉《證券投資信託及顧問法》）。所有輸出僅供參考。
