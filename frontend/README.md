# 理賠案件受理系統（測試版）

給保戶自己上網申請理賠用的對外系統原型。目的是先確認「送出申請 → 背景處理 →
狀態通知」這條流程走得通，之後才接真實的 OCR、協調層、通知服務。

## 本機執行方式

```bash
cd backend
pip install -r requirements.txt
mkdir -p data uploads
uvicorn main:app --host 0.0.0.0 --port 8000
```

開瀏覽器到 `http://localhost:8000/` 就是前端（FastAPI 直接把 `frontend/` 當靜態檔案吃）。

## 已經是真的、已經測試過的部分

- `POST /v1/claims`：受理申請（表單欄位＋多檔上傳），立刻回 `case_id` 與「已受理」
- 背景流程：狀態依序走過 `received → ocr_processing → ocr_done → pipeline_processing → completed/escalated_human`，每一步都寫進 SQLite（`data/claims.db`）
- `GET /v1/claims/{case_id}`：查詢目前狀態（測試/除錯用；正式版主要通知管道是 email/簡訊，不是這支）
- 前端表單驗證（email/電話至少填一項）、拖曳上傳、送出後的「已受理，審核中」畫面
- 已用真實 HTTP 請求端到端測試過：小額案件走 `execute`、超過門檻走 `escalate_human`、查無案件回 404、缺聯絡方式回 400

## 三個 SEAM（樁，尚未接真實服務）— 見 `backend/seams.py`

| SEAM | 現況 | 接上真實服務時要做的事 |
|---|---|---|
| OCR 擷取 | **已接上 Gemini API**（`RealOCRExtractor`），`GEMINI_API_KEY` 沒設定時退回 `StubOCRExtractor`，誠實回報「尚未處理」 | 已完成，設定環境變數即可，見下方「OCR（新增）」 |
| 協調層 | 找不到 `ORCHESTRATOR_URL` 環境變數，或呼叫失敗，會退回 `SimulatedOrchestratorClient`（結果一律標記 `simulated: true`，決策邏輯只是示範用的金額門檻，不是真的規則/理賠/法官代理人） | 設定 `ORCHESTRATOR_URL`／`ORCHESTRATOR_API_KEY` 環境變數，`HTTPOrchestratorClient` 就會生效 |
| 通知（email/簡訊） | `StubNotifier`，只印 log，不真的寄送 | 接真實 SMTP/簡訊供應商；未來若要接 LINE，新增 `LineNotifier` 實作同一個 `Notifier` 介面即可，不用動其他程式碼 |

## 管道無關設計（為了以後接 LINE）

`POST /v1/claims` 不知道、也不需要知道呼叫者是網頁表單還是 LINE webhook——兩者
都是呼叫同一支 API，`channel` 欄位只是記錄用途。未來要接 LINE，只需要：
1. 寫一個 LINE webhook handler，把使用者訊息轉換成同樣的表單欄位，呼叫這支 API
2. 實作 `LineNotifier`（`seams.py` 裡已經留好介面與範例）
3. 完全不用動 `store.py` 或核心流程邏輯

## 部署到 Cloud Run 前，務必處理的事（目前是測試系統，刻意先跳過）

- **無身份驗證**：任何人都能呼叫，正式上線前必須補（這次决定先不做）
- **SQLite 與上傳檔案存在容器本地磁碟，Cloud Run 上會遺失**：容器重啟/縮到零、
  多實例之間都不共享這份資料。正式上線前必須換成 Cloud SQL/Firestore（狀態）
  ＋ Cloud Storage（檔案，前端直接用簽章網址上傳，不要繞經 API）
- 沒有「申請人工複核」按鈕（這次決定先不做，之後視需要再加）
- 沒有任何法遵揭露文字或個資同意書邏輯（這次決定先不做，正式上線前需要教授/
  兆豐法遵審查）
- CORS 目前對任何來源開放（`allow_origins=["*"]`），上線前要收窄成正式前端網域

## OCR（新增）

保單照片跟理賠佐證文件（收據/估價單/診斷證明）是兩種不同性質的文件，前端拆成
兩個上傳欄位（`policy_documents`／`evidence_documents`），後端分開送給 Gemini：

- 保單照片 → 擷取 `policy_no`／`insured_name`／`policy_period_start`／`policy_period_end`
- 佐證文件 → 擷取 `amount`／`date`／`diagnosis`

保戶表單上的 `policy_no`／`applicant_name`／`claim_amount`／`incident_date` 現在都
改成選填——保戶可以自己打，也可以靠上傳對應文件讓系統自動帶入，但兩邊都沒有
的話會在受理前擋下來（400）。OCR 讀到的值只會拿來補「保戶留空」的欄位，絕不
覆蓋保戶已經手填的值；哪些欄位是 OCR 補的會誠實記錄在 `ocr_filled_fields`，
後台 `/admin.html` 詳細資料裡看得到，不會跟保戶自己填的資料混為一談。同一份
文件送多張、欄位讀到不同值時，也不會靜默選一個當正確答案，會標記進
`ocr_result.*.fields._conflicts`。

OCR 之後若關鍵欄位仍缺（保戶沒填、OCR 也沒讀到），案件會直接標記
`escalated_human` 並記錄缺哪些欄位，不會讓協調層拿到 `None`/`0` 這種容易被
誤判的資料去做決策。

**環境變數：**

```
GEMINI_API_KEY=<你的 Gemini API 金鑰>
```

沒有設定時自動退回 `StubOCRExtractor`（誠實回報「尚未處理」，不虛構任何欄位），
方便沒有金鑰時也能測試其他流程。金鑰建議走 Secret Manager，不要用一般環境變數
明文帶密鑰：

```powershell
"你的 Gemini API 金鑰" | Out-Null  # 先確認沒有多餘換行的做法見下方
[System.IO.File]::WriteAllText("$PWD\gemini_key_temp.txt", "你的金鑰")
gcloud secrets create gemini-api-key --data-file="$PWD\gemini_key_temp.txt"
Remove-Item "$PWD\gemini_key_temp.txt"

gcloud secrets add-iam-policy-binding gemini-api-key `
  --member="serviceAccount:<你的Cloud Run服務帳號>" `
  --role="roles/secretmanager.secretAccessor"
```

部署時加上：
```
--set-secrets "DB_PASS=claim-intake-db-pass:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

## 資料庫（新增）

`data/claims.db` 的 schema 現在多了 `review_status`／`reviewed_by`／`reviewed_at`／
`review_note`（後台複核用）以及從 `submitted_fields` 拆出來的結構化欄位
（`policy_no`／`applicant_name`／`insurance_type`／`claim_amount`／`incident_date`），
方便後台清單查詢/篩選/搜尋，同時仍保留完整原始 JSON 在 `submitted_fields`，不會
因為拆欄位而遺失或竄改使用者送出的原始資料。

**正式環境務必改用 Cloud SQL**，設定以下環境變數即可（密碼建議走 Secret Manager）：

```
DB_INSTANCE_CONNECTION_NAME=<project>:<region>:<instance>
DB_USER=<db user>
DB_PASS=<db password>
DB_NAME=claims
DB_IP_TYPE=PUBLIC   # 若 Cloud Run 走 VPC 連接器接 Private IP，改成 PRIVATE
```

沒有設定上述變數時，`store.py` 會自動退回本機 SQLite（`data/claims.db`），
方便本機開發/沒有 GCP 連線時測試——**這條退回路徑只給開發用，正式部署一定要
設定 Cloud SQL 環境變數**，否則狀態不會在 Cloud Run 多實例/重啟之間保留（這點
在上面「部署到 Cloud Run 前」那段本來就有提醒）。

第一次接上 Cloud SQL 前，記得：
1. 在 Cloud SQL 建立 PostgreSQL 執行個體與 `claims` 資料庫
2. 建立一個有權限的 DB 使用者，密碼存進 Secret Manager
3. Cloud Run 的服務帳號要有 `Cloud SQL Client` IAM 角色
4. `store.init_db()` 會在啟動時自動建表/建索引，不需要另外手動跑 migration

## 後台總覽頁面（新增）

- 網址：`/admin.html`（跟保戶端 `/` 同一個 Cloud Run 服務，同源）
- API：
  - `GET /v1/admin/claims` — 清單，支援 `status`／`channel`／`insurance_type`／
    `review_status`／`q`（模糊搜尋案件編號/保單號/申請人）／`date_from`／`date_to`／
    `page`／`page_size`
  - `GET /v1/admin/claims/{case_id}` — 單筆完整詳細資料（含 OCR/協調層結果）
  - `POST /v1/admin/claims/{case_id}/review` — 標記複核狀態
    (`not_reviewed`/`reviewing`/`reviewed`)，可附複核人員與備註
  - `GET /v1/admin/claims/export.csv` — 依目前篩選條件匯出 CSV（Excel 可直接開，
    已加 UTF-8 BOM 避免中文亂碼）

⚠️ **這批 `/v1/admin/*` 端點目前完全沒有存取控制**（比照這次的決定：測試階段
先不加驗證）。正式上線前務必補上 Admin API Key 或帳密登入，並把 CORS 從
`allow_origins=["*"]` 收窄——不然任何人都能看到所有保戶的理賠申請資料。

## 部署到 Cloud Run（測試環境，帳單需啟用）

```powershell
gcloud run deploy claim-intake `
  --source . `
  --region asia-east1 `
  --allow-unauthenticated `
  --set-env-vars ORCHESTRATOR_URL=<協調層網址>
```

`--allow-unauthenticated` 是刻意的：這支服務要給保戶的瀏覽器直接呼叫，跟規則/
理賠/法官代理人那三支「僅協調層可呼叫」的私有服務性質不同。
