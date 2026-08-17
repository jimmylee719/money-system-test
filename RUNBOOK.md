# 本機操作手冊

這份是「要跑什麼指令」的清單。設計理由寫在 `CLAUDE.md`，這裡只講操作。

> **共通規則：所有會寫入資料庫的指令，預設都是 dry-run。**
> 先看數字，確認無誤才加 `--write`。因為每張表都是 append-only，寫進去就改不掉。

---

## 0. 第一次使用：三件事

### (1) `.env.local`

專案根目錄要有 `.env.local`（已被 gitignore 排除，**永遠不要提交、不要貼給任何人**）：

```
NEXT_PUBLIC_SUPABASE_URL=https://你的專案.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LINE_USER_ID=U...
DASHBOARD_PASSWORD=自己取一個，別跟其他密碼重複
```

`DASHBOARD_PASSWORD` 沒設的話，Dashboard 會整站 401——那是刻意的 fail-closed，不是壞掉。

### (2) 依序執行 migration

Supabase Dashboard → SQL Editor → 貼上全文 → Run。已經跑過的可以重跑，不會壞。

| 檔案 | 內容 |
|---|---|
| `supabase/migrations/0001` ～ `0011` | 已完成 |
| `supabase/migrations/0012_llm.sql` | **P11 新增，尚未執行** |

### (3) 驗證每一層的鎖有沒有真的鎖上

```bash
npm run l0:verify && npm run factors:verify && npm run l1:verify-picks && npm run l2:verify && npm run l3:verify && npm run l4:verify && npm run l5:verify && npm run llm:verify
```

任何一項沒過就不要繼續，先查清楚。

---

## 1. 每天要跑的（正常情況下 GitHub Actions 會自己跑）

排程在 `.github/workflows/l0-ingest.yml`，每日自動抓取。手動要跑的話：

### 抓資料

```bash
npm run l0:ingest -- --write
```

### 產生當日清單（先看，不寫）

```bash
npm run l1:picks
```

畫面會依序印出 L1 排序 → L2 否決 → L2b LLM → L3 風控 → LINE 日報草稿。

### 確認無誤後寫入並推播 LINE

```bash
npm run l1:picks -- --write --notify
```

### 算已到期的績效（T+5 / T+10 / T+20）

```bash
npm run l5:outcomes -- --write
```

### 與 0050 對照（G3）

```bash
npm run l6:g3 -- --write
```

---

## 2. Dashboard（本機看）

```bash
npm run dev
```

打開 http://localhost:3000 ，會跳出帳號密碼視窗：

- 帳號：**隨便打什麼都可以**（不檢查）
- 密碼：`.env.local` 裡的 `DASHBOARD_PASSWORD`

要看正式建置的版本（跟部署到 Vercel 後一樣）：

```bash
npm run build
```

```bash
npm start
```

---

## 3. 匯出 Excel

```bash
npm run l5:export
```

檔案會產生在 `exports/`（該目錄不進版控，隨時可重新產生）。

---

## 4. P11：本機 LLM 否決層（**選配，不裝也完全能用**）

這一層是加分項，不是必需品。不裝 Ollama，系統照常運作，只是少一層否決。

### 4.1 先確認 runtime 有沒有裝

```bash
npm run llm:check
```

連不上會告訴你原因，不會有任何副作用（不讀不寫任何資料）。

沒裝的話：到 <https://ollama.com/download> 下載 Windows 版，
執行 `OllamaSetup.exe`（安裝在使用者目錄，不需要系統管理員權限），
裝完會自動在背景啟動並在右下角出現圖示，監聽 `127.0.0.1:11434`。

**開一個新的終端機**（PATH 要重讀才吃得到 `ollama` 指令）：

```bash
ollama --version
```

```bash
ollama pull qwen2.5:3b
```

> **這台機器的限制（2026-08-16 實測）**：實體記憶體 5.9 GB、
> AMD Ryzen 5 3500U、內顯 Vega 8（與系統共用記憶體，Ollama 會走 CPU）。
> 7B 模型量化後約需 4～5 GB 常駐記憶體，在這台機器上會吃到虛擬記憶體，
> 慢到不堪用甚至載入失敗。所以預設用 3B；3B 還吃力就改 `qwen2.5:1.5b`。
> 跑之前把 Chrome 之類的關一關，可用記憶體差很多。

裝完再跑一次 `npm run llm:check`，它會列出 runtime 裡實際有哪些模型。
名稱跟 `config/llm.json` 的 `modelKey` 不一樣的話，改那個檔案即可。

> ⚠️ **要有心理準備**：小模型讀中文公告、還要輸出嚴格 JSON 並逐字引用原文，
> 很可能贏不過「永遠不否決」的 baseline。那不是系統壞掉——
> gold_set 的設計就是要把這件事量出來。贏不過就不上線，這一層維持關閉，
> 其餘功能完全不受影響。

### 4.2 每天晚上 19:00 之後：一個指令

排程在 18:40（台北）抓資料，所以 19:00 之後跑就有當天的東西。

```bash
npm run llm:daily
```

這一行做兩件事：把當日重大訊息排進佇列，然後匯出待標註檔到 `gold/`。

### 4.3 標註 —— **這一步一定要你自己做**

打開 `gold/` 裡最新的 `pending-<日期>.xlsx`，在「待標註」頁填兩欄：
`label`（下拉選 veto / no_veto）與 `label_reason`（為什麼）。

你要回答的是一個是非題，不是投資判斷：

> 這則公告有沒有陳述一件**已經發生**、且對公司營運或財務明顯不利的具體事實？

存檔後先檢查（不寫入）：

```bash
npm run llm:gold -- --import
```

沒問題再寫入：

```bash
npm run llm:gold -- --import --write
```

`--import` 後面不接路徑時，自動用 `gold/` 裡最新的那個檔，所以指令天天一樣，不用改日期。

> **不會叫你標重複的題目。** 更名與面額變更依規定要**連續公告三個月**
> （公告原文自己寫著），所以同一則公告每天都會再出現一次，只有發言日期在變。
> 匯出時會以「代號＋條款＋主旨＋說明」比對，標過的內容不再出題。
>
> 佇列則照常天天重排——像每週揭露基金淨值的 3432，只排一次的話之後幾天就不會被否決了。
> **否決是每天要重新套用的；重複沒意義的是考卷，不是佇列。**

至少要 30 題，而且不能全部同一個答案——否則考卷沒有鑑別度，評測會被拒絕。

### 4.4 考試與晉升

```bash
npm run llm:eval
```

會對每一題實際呼叫本機模型，印出成績與五道晉升門檻的逐條結果。
**通過才會顯示可晉升**；要真的換代再加 `--write`。

一定會同時印出一個叫 baseline 的分數：那是「永遠不否決」的對照組。
模型贏不過它，就代表這個模型沒有貢獻——不管正確率的數字看起來多高。

### 4.5 每天判定新公告

```bash
npm run llm:worker -- --write
```

### 4.6 讓這一層真的參與否決

改 `config/llm.json` 的 `"enabled": true`。
沒有 champion 的話，就算開了也不會有任何否決發生。

---

## 5. 全部驗證指令一覽

| 指令 | 驗什麼 |
|---|---|
| `npm test` | 全部單元測試 |
| `npm run typecheck` | TypeScript strict |
| `npm run l0:verify` | raw_snapshots 三道鎖 |
| `npm run l0:verify-drift` | 來源欄位有沒有變 |
| `npm run l0:audit` | 帳本與 Storage 物件逐列比對（Storage 擋不住刪除，只能事後偵測） |
| `npm run factors:verify` | factor_registry 三道鎖 |
| `npm run l1:verify-picks` | daily_picks 三道鎖 |
| `npm run l2:verify` | veto_events 三道鎖 |
| `npm run l3:verify` | risk_config 三道鎖 |
| `npm run l4:verify` | user_records 三道鎖 |
| `npm run l4:verify-webhook` | LINE webhook 端到端 |
| `npm run l5:verify` | outcomes 三道鎖 |
| `npm run llm:verify` | P11 四張表三道鎖 |

---

## 6. 常見狀況

**「交易訊號 0 檔」** —— 多半是正常的，但要看清楚是哪一種 0：
畫面會直接告訴你是「沒有標的通過」還是「資料還不夠」。
波動率要 21 個交易日才算得出來，在那之前一定是 0 檔。

**「L2 全面否決 / failed_closed」** —— 這是**故障**不是沒訊號。
表示注意股／處置股之類的來源當天沒抓到，系統不知道能不能買，所以一律不買。
先跑 `npm run l0:ingest -- --write` 補抓。

**「llm:enqueue 說整批不排」** —— 重大訊息快照跟行情快照不是同一次抓來的。
拿後來才抓到的新聞回頭否決舊訊號就是前視偏誤，所以寧可不排。重跑 `l0:ingest` 即可。

**Dashboard 401** —— `.env.local` 裡沒有 `DASHBOARD_PASSWORD`，或密碼打錯。

**金鑰不小心外流** —— 立刻到 Supabase Dashboard / LINE Developers Console 重新產生，
舊的當場失效。不要試圖「刪掉訊息」了事。
