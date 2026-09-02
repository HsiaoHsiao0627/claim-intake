// ============================================================
// common.js — RSA / TPL 兩個理賠申請頁面共用的邏輯
// （上傳區元件、demo 案例代入、表單送出、案件狀態查詢）。
// 兩頁的 HTML 結構（欄位 id/name）遵循同樣的命名慣例，這份共用邏輯
// 才能同時套用在 rsa.html 與 tpl.html 上，不用各自維護一份重複程式碼。
// ============================================================

// 前端跟後端部署在同一個 Cloud Run 服務裡（同一個容器），所以永遠用相對路徑、
// 同源呼叫即可，不用寫死網域。本機測試（uvicorn 跑在 localhost:8000）跟部署到
// Cloud Run 後（網址變成 https://xxx.run.app）都會自動打對地方。
const API_BASE = "";

// 保單照片跟理賠佐證文件是兩組獨立的上傳區，各自維護自己的檔案清單，
// 因為後端會分開送給 OCR（一個辨識保單號/姓名，一個辨識金額/日期）。
function setupUploadZone(zoneId, inputId, listId) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let files = [];

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("dragover");
    addFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => addFiles(input.files));

  function addFiles(newFiles) {
    for (const f of newFiles) files.push(f);
    render();
  }
  function render() {
    list.innerHTML = files.map((f, i) =>
      `<div>${f.name}（${(f.size/1024).toFixed(1)} KB） <a href="#" data-i="${i}" class="rm" style="color:#8a2c22">移除</a></div>`
    ).join("");
    list.querySelectorAll(".rm").forEach(a => a.addEventListener("click", e => {
      e.preventDefault();
      files.splice(Number(a.dataset.i), 1);
      render();
    }));
  }

  return {
    getFiles: () => files,
    reset: () => { files = []; render(); },
    // 示範案例用：塞進去的不是使用者真的選的檔案，是純前端產生的極小佔位
    // 檔案（見下方 makeDemoFile），純粹是為了讓後端「有沒有上傳文件」的
    // 判斷能被誠實觸發（RSA Rule Agent 需要知道 policy_record／
    // service_request_record 是否存在），檔名會清楚標明是 demo 檔案，
    // 不會被誤認成真實文件。
    addSimulated: (newFiles) => addFiles(newFiles)
  };
}

// 純前端產生的極小佔位圖檔（1x1 透明 PNG），只用來讓「有沒有上傳文件」這件事
// 對後端來說是真的，不代表任何真實保單或救援單據內容。
// 純前端產生的極小佔位圖檔（1x1 透明 PNG），只用來讓「有沒有上傳文件」這件事
// 對後端來說是真的，不代表任何真實保單或救援單據內容。
function makeDemoFile(name) {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: "image/png" });
}

// demo 案例若有真實示範照片時，把內嵌的 base64 JPEG 轉成真的 File 物件，行為上
// 跟使用者自己選檔案上傳完全一樣，OCR 會真的讀到照片內容，不是空殼佔位圖。
// 案例一、三、四用：把內嵌的 base64 JPEG 轉成真的 File 物件，行為上
// 跟使用者自己選檔案上傳完全一樣，OCR 會真的讀到照片內容，不是空殼佔位圖。
function dataUriToFile(dataUri, filename) {
  const [header, base64] = dataUri.split(",");
  const mimeMatch = header.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

// ============================================================
// 案件狀態自然語言呈現：把 /v1/claims/{case_id} 回傳的原始 JSON
// 轉成保戶看得懂的中文摘要，原始 JSON 收進可展開的除錯區塊，
// 不完全拿掉（開發/除錯時還是常常需要看完整欄位）。
// ============================================================
const CLAIM_STATUS_LABELS = {
  received: "已受理，準備開始處理",
  ocr_processing: "正在辨識您上傳的文件",
  ocr_done: "文件辨識完成，準備解析事故描述",
  description_parsing: "正在解析事故經過描述",
  pipeline_processing: "正在進行理賠資格判斷",
  completed: "審核完成",
  escalated_human: "已轉交人工複核",
  error: "處理時發生錯誤",
};

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatClaimAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return "未提供";
  const num = Number(amount);
  return Number.isNaN(num) ? escapeHtml(amount) : `NT$ ${num.toLocaleString("zh-Hant-TW")}`;
}


function renderClaimSummary(data) {
  const statusLabel = CLAIM_STATUS_LABELS[data.status] || data.status || "未知狀態";
  const parts = [];

  parts.push(`<div class="claim-summary-row"><strong>案件編號：</strong>${escapeHtml(data.case_id)}</div>`);
  parts.push(`<div class="claim-summary-row"><strong>目前狀態：</strong>${escapeHtml(statusLabel)}</div>`);
  parts.push(`<div class="claim-summary-row"><strong>申請人：</strong>${escapeHtml(data.applicant_name) || "未提供"}（保單號：${escapeHtml(data.policy_no) || "未提供"}）</div>`);
  parts.push(`<div class="claim-summary-row"><strong>險種：</strong>${escapeHtml(data.insurance_type) || "未提供"}</div>`);
  parts.push(`<div class="claim-summary-row"><strong>申請金額：</strong>${formatClaimAmount(data.claim_amount)}</div>`);
  parts.push(`<div class="claim-summary-row"><strong>事故／就醫日期：</strong>${escapeHtml(data.incident_date) || "未提供"}</div>`);

  const pipeline = data.pipeline_result;
  if (data.status === "error") {
    parts.push(`<div class="claim-summary-decision claim-summary-error">
      <strong>處理發生錯誤</strong><br>${escapeHtml(data.error_message) || "詳情請洽系統管理員。"}
    </div>`);
  } else if (pipeline) {
    const decision = pipeline.decision;
    const reasons = Array.isArray(pipeline.reasons) ? pipeline.reasons.join("；") : null;
    if (decision === "execute") {
      parts.push(`<div class="claim-summary-decision claim-summary-approve">
        <strong>✓ 系統判斷：符合受理條件</strong><br>
        ${escapeHtml(reasons) || "案件資料完整，系統已完成資格判斷。"}
      </div>`);
    } else if (decision === "escalate_human") {
      parts.push(`<div class="claim-summary-decision claim-summary-review">
        <strong>⚠ 系統判斷：需人工複核</strong><br>
        ${escapeHtml(reasons) || "系統判斷此案件需要由人工複核。"}
      </div>`);
    } else {
      parts.push(`<div class="claim-summary-decision">系統判斷結果：${escapeHtml(decision) || "尚無結論"}</div>`);
    }
  } else if (data.status && data.status !== "escalated_human") {
    parts.push(`<div class="claim-summary-decision claim-summary-pending">案件仍在處理中，尚未有最終判斷結果，請稍後再查詢一次。</div>`);
  }

  const rawJson = escapeHtml(JSON.stringify(data, null, 2));
  parts.push(`<details class="claim-summary-raw"><summary>查看完整原始資料（除錯用）</summary><pre>${rawJson}</pre></details>`);

  return parts.join("");
}


// ============================================================
// Demo 案例代入（泛用寫法）：依 demoCase.data 內的欄位名稱對應到表單同名
// 欄位，欄位在該頁面不存在（例如 TPL 頁面沒有 RSA 專屬的 policy_active／
// rsa_addon_purchased）就直接跳過，不會報錯——這樣 RSA、TPL 兩頁的
// DEMO_CASES 資料結構可以不同，仍然共用同一份代入邏輯。
// ============================================================
function applyDemoCaseGeneric(form, demoCase, policyUpload, evidenceUpload) {
  const d = demoCase.data;
  Object.keys(d).forEach(key => {
    const el = form.elements[key];
    if (el) el.value = d[key];
  });

  // 先清空目前的上傳清單。有真實示範照片（demoImages）的案例優先用真的
  // 照片（OCR 會真的讀到內容）；沒有真實照片但仍要示範「有上傳文件」的
  // 案例退回極小佔位圖；「資料不全」類的案例刻意不附文件，示範文件缺漏
  // 時的誠實轉人工。
  policyUpload.reset();
  evidenceUpload.reset();
  if (demoCase.demoImages) {
    policyUpload.addSimulated([dataUriToFile(demoCase.demoImages.policy, "保單照片.jpg")]);
    evidenceUpload.addSimulated([dataUriToFile(demoCase.demoImages.evidence, "佐證文件.jpg")]);
  } else if (demoCase.attachDemoFiles) {
    policyUpload.addSimulated([makeDemoFile("demo_保單照片.png")]);
    evidenceUpload.addSimulated([makeDemoFile("demo_佐證文件.png")]);
  }
}

function renderDemoList(demoCases, listId, onSelect) {
  const list = document.getElementById(listId);
  list.innerHTML = demoCases.map(c => `
    <button type="button" class="demo-item" data-id="${c.id}">
      <span class="demo-tag ${c.tag}">${c.tagLabel}</span>
      <div class="demo-item-title">${c.title}</div>
      <div class="demo-item-desc">${c.desc}</div>
    </button>
  `).join("");
  list.querySelectorAll(".demo-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const demoCase = demoCases.find(c => c.id === btn.dataset.id);
      if (demoCase) onSelect(demoCase);
    });
  });
}

function markActiveDemoItem(id) {
  document.querySelectorAll(".demo-item").forEach(el => el.classList.remove("active"));
  const activeBtn = document.querySelector(`.demo-item[data-id="${id}"]`);
  if (activeBtn) activeBtn.classList.add("active");
}

// ============================================================
// 整頁初始化：接上傳區、demo 側欄、表單送出、案件狀態查詢。
// RSA／TPL 兩頁的 HTML（表單欄位 id/name、demo 側欄結構）維持一致的命名，
// 呼叫這支就能把整頁邏輯接起來，各頁面的 <script> 只需要定義自己的
// DEMO_CASES 陣列並呼叫 initClaimPage()。
// ============================================================
function initClaimPage({ demoCases = [] } = {}) {
  const policyUpload = setupUploadZone("policyUploadZone", "policyFileInput", "policyFileList");
  const evidenceUpload = setupUploadZone("uploadZone", "fileInput", "fileList");
  const form = document.getElementById("claimForm");

  function resetForm() {
    form.reset();
    policyUpload.reset();
    evidenceUpload.reset();
    document.getElementById("confirmCard").classList.add("hidden");
    document.getElementById("formCard").classList.remove("hidden");
    document.getElementById("errBox").style.display = "none";
    document.querySelectorAll(".demo-item").forEach(el => el.classList.remove("active"));
  }

  if (demoCases.length) {
    renderDemoList(demoCases, "demoList", (demoCase) => {
      applyDemoCaseGeneric(form, demoCase, policyUpload, evidenceUpload);
      document.getElementById("confirmCard").classList.add("hidden");
      document.getElementById("formCard").classList.remove("hidden");
      document.getElementById("errBox").style.display = "none";
      markActiveDemoItem(demoCase.id);
    });
    const resetBtn = document.getElementById("demoResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetForm);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = document.getElementById("errBox");
    errBox.style.display = "none";

    const email = form.contact_email.value.trim();
    const phone = form.contact_phone.value.trim();
    const policyFiles = policyUpload.getFiles();
    const evidenceFiles = evidenceUpload.getFiles();

    if (!email && !phone) {
      errBox.textContent = "email 與電話至少要留一項，否則無法通知您審核結果。";
      errBox.style.display = "block";
      return;
    }
    if (!form.policy_no.value.trim() && policyFiles.length === 0) {
      errBox.textContent = "請填寫保單號碼，或上傳保單照片讓系統自動辨識。";
      errBox.style.display = "block";
      return;
    }
    if (!form.applicant_name.value.trim() && policyFiles.length === 0) {
      errBox.textContent = "請填寫被保險人姓名，或上傳保單照片讓系統自動辨識。";
      errBox.style.display = "block";
      return;
    }
    if (!form.claim_amount.value && evidenceFiles.length === 0) {
      errBox.textContent = "請填寫申請理賠金額，或上傳收據／估價單讓系統自動辨識。";
      errBox.style.display = "block";
      return;
    }
    if (!form.incident_date.value && evidenceFiles.length === 0) {
      errBox.textContent = "請填寫事故／就醫日期，或上傳佐證文件讓系統自動辨識。";
      errBox.style.display = "block";
      return;
    }

    // 2026-08 新增：第三人責任險案件要呼叫 TPL Claim Agent，accident_area／
    // own_fault_pct／injury_desc 是它的必填參數（尤其 own_fault_pct 攸關理賠
    // 金額計算）。這裡刻意不在前端強制擋——責任比例爭議未定是理賠案件的
    // 正常情況之一（保戶當下可能真的不知道），跟 policy_no/claim_amount
    // 那種「有文件可以補」的必填不同，這三個欄位沒有文件可以自動帶入。
    // 留空一樣讓案件送出，由後端已有的「缺必要欄位→轉人工」邏輯誠實處理，
    // 不要在前端就把案件擋下來，這樣才符合本專案的一貫原則。

    const btn = document.getElementById("submitBtn");
    btn.disabled = true; btn.textContent = "送出中…";

    // 用 FormData(form) 自動收集表單上所有具 name 屬性的欄位（含 hidden 的
    // insurance_type／channel），只有兩個上傳用的 file input 需要換成我們
    // 自己管理的檔案清單——拖曳／demo 代入的檔案不會反映在 input.files 上，
    // 一定要手動 append，否則會漏掉。
    const fd = new FormData(form);
    fd.delete("policy_documents");
    fd.delete("evidence_documents");
    for (const f of policyFiles) fd.append("policy_documents", f);
    for (const f of evidenceFiles) fd.append("evidence_documents", f);

    try {
      const resp = await fetch(`${API_BASE}/v1/claims`, { method: "POST", body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `送出失敗（狀態碼 ${resp.status}）`);
      }
      const data = await resp.json();
      document.getElementById("caseIdDisplay").textContent = data.case_id;
      document.getElementById("formCard").classList.add("hidden");
      document.getElementById("confirmCard").classList.remove("hidden");
    } catch (err) {
      errBox.textContent = err.message || "送出時發生錯誤，請稍後再試。";
      errBox.style.display = "block";
    } finally {
      btn.disabled = false; btn.textContent = "送出申請";
    }
  });

  const lookupBtn = document.getElementById("lookupBtn");
  if (lookupBtn) {
    lookupBtn.addEventListener("click", async () => {
      const caseId = document.getElementById("lookupInput").value.trim();
      const box = document.getElementById("statusResult");
      if (!caseId) return;
      box.style.display = "block";
      box.innerHTML = "查詢中…";
      try {
        const resp = await fetch(`${API_BASE}/v1/claims/${encodeURIComponent(caseId)}`);
        if (!resp.ok) { box.innerHTML = "查無此案件編號。"; return; }
        const data = await resp.json();
        box.innerHTML = renderClaimSummary(data);
      } catch {
        box.innerHTML = "查詢失敗，請確認 API 是否啟動。";
      }
    });
  }

  return { policyUpload, evidenceUpload, form };
}
