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

  parts.push(renderAgentReplies(data));

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
  // 先清空：案例刻意不帶的欄位（例如責任比例未定的案例不帶 own_fault_pct）
  // 才不會殘留上一個案例的值。form.reset() 會保留 hidden 欄位的預設值。
  form.reset();
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
    // 留空的欄位不要送空字串：後端 own_fault_pct／claim_amount 是數字欄位，
    // 收到 "" 會直接回 422，導致「責任比例尚有爭議可先留空」「金額可由
    // 收據辨識」這兩條路徑送不出去。沒送等同 None，交給後端原本的缺漏處理。
    for (const [k, v] of [...fd.entries()]) {
      if (typeof v === "string" && v.trim() === "") fd.delete(k);
    }

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


// ============================================================
// 三個代理人的自然語言回覆（2026-10 新增）
//
// 把 pipeline_result 裡規則／理賠／法官三個代理人的結構化輸出，改寫成
// 各自用第一人稱說明「我判斷了什麼、為什麼」。這裡只做「翻譯」：
// 每一句話都對應到 JSON 裡真的存在的欄位，不額外呼叫 LLM、不補推測。
// 代理人這次沒有被呼叫（前一關沒過、服務沒回應、模擬結果）也照實說，
// 不讓「沒有回應」看起來像「判斷通過」。原始 JSON 仍保留在下方可展開區塊。
// ============================================================
const RSA_FIELD_LABELS = {
  "policy.active_on_incident_date": "事故當下保單是否有效",
  "policy.rsa_addon_purchased": "是否投保道路救援附加條款",
  "vehicle.vehicle_use": "車輛用途（自用／營業用）",
  "incident.requested_service": "申請的救援服務項目",
  "incident.location": "故障地點",
  "incident.contacted_designated_center": "是否透過指定救援中心報修",
  "incident.special_operation_required": "是否需要特殊作業",
  "exclusion_facts.claims_bridge_or_toll_fees": "是否請求過橋或過路費",
  "exclusion_facts.vehicle_loaded_and_unwilling_to_unload": "車上是否載貨且不願卸貨",
  "exclusion_facts.claims_passenger_or_cargo_transport_cost": "是否請求乘客或貨物的運送費用",
  "documents.policy_record": "保單文件",
  "documents.service_request_record": "救援派工／服務紀錄",
};

const AGREEMENT_STATUS_TEXT = {
  AGREED: "輔助模型的判斷跟我一致",
  DISAGREED: "輔助模型的判斷跟我不一致",
  ADVISORY_OUTPUT_INVALID: "輔助模型這次沒有給出可比對的結果",
};

function _money(n) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return null;
  return `NT$ ${Number(n).toLocaleString("zh-Hant-TW")}`;
}

function _confidenceText(c) {
  if (c === null || c === undefined || c === "") return null;
  const n = Number(c);
  if (!Number.isNaN(n)) return n <= 1 ? `${Math.round(n * 100)}%` : `${n}`;
  return { high: "高", medium: "中", low: "低" }[String(c).toLowerCase()] || String(c);
}

function _list(items) {
  return items.filter(Boolean).map(escapeHtml).join("、");
}

function _agentCard(name, role, tone, statusText, paragraphs) {
  const body = paragraphs.filter(Boolean).map(p => `<p>${p}</p>`).join("");
  return `<div class="agent-reply ${tone}">
    <div class="agent-reply-head"><strong>${name}</strong><span class="agent-reply-role">${role}</span>
      <span class="agent-reply-status">${escapeHtml(statusText)}</span></div>
    ${body}
  </div>`;
}

// ---------------- 法官代理人（RSA／TPL 共用同一支 judge-agent） ----------------
function _judgeParagraphs(j) {
  const out = [];
  const fair = j.fairness_check || {};
  const fraud = j.fraud_flags || {};
  const audit = j.audit_trail || {};
  if (fair.fair_range && fair.precedent_n) {
    const amt = _money(fair.claim_amount);
    out.push(`我拿 ${escapeHtml(fair.precedent_n)} 筆歷史相似案件比對，合理金額區間是 ${_money(fair.fair_range[0])} 到 ${_money(fair.fair_range[1])}（中位數 ${_money(fair.median)}）`
      + (amt ? `，這次的建議金額 ${amt} ${fair.within_tolerance ? "落在區間內" : "落在區間外"}。` : "。"));
  } else if (fair.precedent_insufficient) {
    out.push(`可以拿來比對的歷史案件不夠（找到 ${escapeHtml(fair.precedent_n ?? 0)} 筆），我沒辦法判斷這個金額公不公平。`);
  }
  const flags = Array.isArray(fraud.flags) ? fraud.flags : [];
  const hits = flags.filter(f => f.status === "hit");
  const na = flags.filter(f => f.status === "na");
  if (flags.length) {
    const checked = flags.length - na.length;
    if (hits.length) out.push(`詐欺規則有 ${hits.length} 條命中：${_list(hits.map(f => f.reason || f.flag_id))}。`);
    else if (checked > 0) out.push(`我實際檢查了 ${checked} 條詐欺規則，沒有命中的項目。`);
    if (na.length === flags.length) {
      out.push(`${flags.length} 條詐欺規則都因為缺少資料（例如保單起訖日、報案日、歷史請領紀錄）沒辦法檢查。這代表「沒檢查」，不是「檢查過沒問題」。`);
    } else if (na.length) {
      out.push(`另外 ${na.length} 條因為缺少資料沒辦法檢查，這代表「沒檢查」，不是「檢查過沒問題」。`);
    }
  }
  const rr = audit.reasoning_review || {};
  if (rr.reviewed) {
    out.push(rr.flagged
      ? `我也看了理賠代理人的推理過程，發現問題：${_list(rr.issues || [])}。`
      : "我也看了理賠代理人的推理過程，引用的案例與條款跟它說的一致。");
  }
  const reasons = Array.isArray(j.reasons) ? j.reasons : [];
  if (j.decision === "execute") out.push("綜合以上，我同意這個金額，可以放行。");
  else if (j.decision === "return_for_recalc") out.push(`綜合以上，我把金額退回請理賠代理人重算：${_list(reasons)}。`);
  else if (j.decision === "escalate_human") out.push(`綜合以上，我建議交給承辦人員複核，原因是：${_list(reasons)}。`);
  return out;
}

function _judgeStatus(decision) {
  return { execute: ["同意放行", "ok"], return_for_recalc: ["退回重算", "warn"], escalate_human: ["建議轉人工", "warn"] }[decision]
    || ["未提供結論", "muted"];
}

// ---------------- RSA ----------------
function _rsaReplies(data, pr) {
  const cards = [];
  const final = pr.rsa_final_decision;
  const reason = (Array.isArray(pr.reasons) && pr.reasons[0]) || "";

  // 規則代理人
  let p = [], status = "未提供結論", tone = "muted";
  if (final === "ELIGIBLE_FOR_PROCESS") {
    status = "可受理"; tone = "ok";
    p.push("我檢查了保單在事故當下有效、有投保道路救援附加條款，也沒有觸發不保或不負擔的事由，必要的欄位跟文件都齊全，所以判斷這件可以進入理賠受理程序。");
    const assumed = Object.keys(pr.staff_assumed_facts || {});
    const ASSUMED_LABELS = { vehicle_use: "車輛用途", contacted_designated_center: "是否透過指定救援中心報修",
      claims_bridge_or_toll_fees: "過橋／過路費", vehicle_loaded_and_unwilling_to_unload: "載貨不願卸貨",
      claims_passenger_or_cargo_transport_cost: "乘客或貨物運送費用" };
    if (assumed.length) p.push(`提醒：其中「${_list(assumed.map(k => ASSUMED_LABELS[k] || k))}」是理賠人員模式的暫定假設，不是人員逐案輸入的資料。`);
    const agree = AGREEMENT_STATUS_TEXT[pr.rsa_agreement_status];
    if (pr.rsa_release_status === "RELEASED") p.push(`${agree ? agree + "，" : ""}條款證據也足夠，我的結論可以直接採用。`);
    else p.push(`不過${agree || "交叉比對沒有完全通過"}，所以我的結論還需要承辦人員確認後才能放行。`);
  } else if (final === "EXCLUDED") {
    status = "不在保障範圍"; tone = "bad";
    p.push(`我判斷這件不在保障範圍：${escapeHtml(reason)}`);
    p.push("拒賠需要承辦人員用正式的方式通知申請人，所以我把案件轉給人工，不由系統直接結案。");
  } else if (final === "NEED_MORE_INFORMATION") {
    status = "資料不足"; tone = "warn";
    const missing = (pr.rsa_missing_fields || []).map(f => RSA_FIELD_LABELS[f] || f);
    p.push("目前的資料還不夠讓我下結論。");
    if (missing.length) p.push(`還缺這些：${_list(missing)}。補齊之後我可以重新判斷。`);
  } else if (reason) {
    p.push(escapeHtml(reason));
  }
  cards.push(_agentCard("規則代理人", "判斷能不能賠", tone, status, p));

  // 理賠代理人
  p = []; status = "這次沒有輪到我"; tone = "muted";
  if (pr.rsa_suggested_amount !== undefined && pr.rsa_suggested_amount !== null) {
    status = "已建議金額"; tone = "ok";
    const conf = _confidenceText(pr.rsa_amount_confidence);
    p.push(`我參考歷史相似案件跟收費標準，建議理賠 ${_money(pr.rsa_suggested_amount)}${conf ? `（信心：${escapeHtml(conf)}）` : ""}。`);
    if (pr.rsa_amount_reasoning) p.push(`我的理由：${escapeHtml(pr.rsa_amount_reasoning)}`);
  } else if (pr.rsa_amount_note) {
    status = "沒有回應"; tone = "warn";
    p.push("規則代理人判斷可以受理，但這次我沒有成功回應（可能服務還在啟動或尚未設定），金額需要承辦人員估算。");
  } else {
    p.push("規則代理人還沒判斷可以受理，在那之前估算金額沒有意義，所以這次我沒有被呼叫。");
  }
  cards.push(_agentCard("理賠代理人", "建議賠多少", tone, status, p));

  // 法官代理人
  const j = pr.rsa_judge_raw || (pr.rsa_judge_decision ? { decision: pr.rsa_judge_decision, reasons: pr.rsa_judge_reasons } : null);
  if (j) {
    const [st, tn] = _judgeStatus(j.decision);
    cards.push(_agentCard("法官代理人", "稽核金額與詐欺風險", tn, st, _judgeParagraphs(j)));
  } else if (pr.rsa_judge_note) {
    cards.push(_agentCard("法官代理人", "稽核金額與詐欺風險", "warn", "沒有回應",
      ["理賠代理人已經給了金額，但這次我沒有成功完成稽核，金額公平性跟詐欺風險需要承辦人員複核。"]));
  } else {
    cards.push(_agentCard("法官代理人", "稽核金額與詐欺風險", "muted", "這次沒有輪到我",
      ["前面還沒有產生建議金額，沒有東西可以讓我稽核。"]));
  }
  return cards;
}

// ---------------- TPL ----------------
function _tplReplies(data, pr) {
  const cards = [];
  const sf = data.submitted_fields || {};
  const rules = pr.tpl_rules_agent_decision;
  const claim = pr.tpl_claim_agent_suggestion;

  // 規則代理人
  if (rules) {
    const tone = { "理賠": "ok", "拒賠": "bad", "疑似詐欺": "bad", "資料不足": "warn" }[rules.decision] || "muted";
    const conf = _confidenceText(rules.confidence);
    const p = [];
    if (rules.simulated) {
      // 樁／呼叫失敗：不是規則代理人真的判斷過，不能用第一人稱假裝有結論
      cards.push(_agentCard("規則代理人", "判斷能不能賠", "muted", "沒有連到",
        [`這次沒有真的連到我（${escapeHtml(rules.reasoning || "服務未設定或呼叫失敗")}），系統保守地當成「${escapeHtml(rules.decision || "資料不足")}」轉人工，這不是我的判斷。`]));
    } else {
    p.push(`我的判斷是「${escapeHtml(rules.decision || "未提供")}」${conf ? `（信心 ${escapeHtml(conf)}）` : ""}。`);
    if (rules.reasoning) p.push(`我的理由：${escapeHtml(rules.reasoning)}`);
    if ((rules.missing_data || []).length) p.push(`還缺：${_list(rules.missing_data)}。`);
    if ((rules.fraud_indicators || []).length) p.push(`我注意到的可疑跡象：${_list(rules.fraud_indicators)}。`);
    if ((rules.citation_warnings || []).length) p.push(`系統發現我引用了不存在的證據編號（${_list(rules.citation_warnings)}），這次判斷的可信度要打折扣。`);
    if (rules.decision !== "理賠" || rules.needs_manual_review) p.push("這個結論需要承辦人員處理，所以後面的金額計算先不進行。");
    cards.push(_agentCard("規則代理人", "判斷能不能賠", tone, rules.decision || "未提供結論", p));
    }
  } else {
    const why = data.error_message ? `：${escapeHtml(data.error_message)}` : "。";
    cards.push(_agentCard("規則代理人", "判斷能不能賠", "muted", "這次沒有輪到我",
      [`案件在交給我之前就先轉人工了${why}`]));
  }

  // 理賠代理人
  if (claim) {
    const p = [];
    if (claim.tpl_agent_error) {
      cards.push(_agentCard("理賠代理人", "建議賠多少", "warn", "沒有回應",
        [`這次呼叫我失敗了（${escapeHtml(claim.tpl_agent_error)}），金額需要承辦人員估算。`]));
    } else {
      if (claim.simulated) p.push("（這次沒有真的連到理賠代理人服務，以下沒有真實的金額建議。）");
      const items = Array.isArray(claim.suggested_items) ? claim.suggested_items : [];
      const counted = items.filter(i => i && i.final_amount !== null && i.final_amount !== undefined && i.status !== "not_applicable");
      const pending = items.filter(i => i && i.status === "pending_evidence");
      const pct = sf.own_fault_pct;
      if (claim.total_suggested_amount !== null && claim.total_suggested_amount !== undefined) {
        p.push(`我依本車肇責 ${escapeHtml(pct ?? "（未提供）")}% 計算，建議理賠總額 ${_money(claim.total_suggested_amount)}${_confidenceText(claim.confidence) ? `（信心：${escapeHtml(_confidenceText(claim.confidence))}）` : ""}。`);
      }
      if (counted.length) p.push(`各項目：${counted.map(i => `${escapeHtml(i.item_category || "未分類")} ${_money(i.final_amount)}`).join("、")}。`);
      if (pending.length) p.push(`${_list(pending.map(i => i.item_category))} 證據不足，我沒有把它算進總額。`);
      const firstReason = counted.find(i => i.reasoning_summary);
      if (firstReason) p.push(`以「${escapeHtml(firstReason.item_category)}」為例，我的理由是：${escapeHtml(firstReason.reasoning_summary)}`);
      cards.push(_agentCard("理賠代理人", "建議賠多少", claim.simulated ? "muted" : "ok",
        claim.simulated ? "模擬結果" : "已建議金額", p));
    }
  } else {
    const why = rules ? `規則代理人判斷「${escapeHtml(rules.decision || "未提供")}」` : "案件沒有進到規則判斷";
    cards.push(_agentCard("理賠代理人", "建議賠多少", "muted", "這次沒有輪到我",
      [`${why}，在確定可以理賠之前估算金額沒有意義，所以這次我沒有被呼叫。`]));
  }

  // 法官代理人：只有理賠代理人真的跑過，頂層的 decision 才是法官代理人的結論
  if (claim) {
    const [st, tn] = _judgeStatus(pr.decision);
    const p = pr.simulated ? ["（這次沒有真的連到法官代理人服務，以下為保守的佔位結果。）"] : [];
    cards.push(_agentCard("法官代理人", "稽核金額與詐欺風險", tn, st, p.concat(_judgeParagraphs(pr))));
  } else {
    cards.push(_agentCard("法官代理人", "稽核金額與詐欺風險", "muted", "這次沒有輪到我",
      ["前面還沒有產生建議金額，沒有東西可以讓我稽核。"]));
  }
  return cards;
}

function renderAgentReplies(data) {
  _ensureAgentReplyStyles();
  const pr = data.pipeline_result;
  const isTpl = data.insurance_type === "第三人責任險";
  const header = `<div class="agent-replies-title">三個代理人的說明</div>`;

  if (!pr) {
    // 還在處理中：代理人還沒有結果，先不顯示
    if (!(data.status === "escalated_human" && data.error_message)) return "";
    // 在呼叫任何代理人之前就轉人工（例如 TPL 沒填肇責比例、OCR 後仍缺必要欄位）
    const FIELD_NAMES = { own_fault_pct: "本車肇責比例", accident_area: "事故地區", injury_desc: "傷勢描述",
      policy_no: "保單號碼", applicant_name: "被保險人姓名", claim_amount: "申請理賠金額", incident_date: "事故日期" };
    const msg = String(data.error_message).replace(/[a-z_]+/g, m => FIELD_NAMES[m] || m);
    return `<div class="agent-replies">${header}
      ${_agentCard("規則代理人", "判斷能不能賠", "muted", "這次沒有輪到我",
        [`案件在交給我之前就先轉人工了，原因是：${escapeHtml(msg)}`])}
      ${_agentCard("理賠代理人", "建議賠多少", "muted", "這次沒有輪到我",
        ["前一關還沒判斷可以理賠，所以這次我沒有被呼叫。"])}
      ${_agentCard("法官代理人", "稽核金額與詐欺風險", "muted", "這次沒有輪到我",
        ["前面還沒有產生建議金額，沒有東西可以讓我稽核。"])}
    </div>`;
  }

  if (!isTpl && pr.simulated) {
    const why = pr.orchestrator_error ? `（連線錯誤：${escapeHtml(pr.orchestrator_error)}）` : "";
    return `<div class="agent-replies">${header}
      ${_agentCard("三個代理人", "", "muted", "沒有連到", [`這次沒有真的連到規則／理賠／法官代理人${why}，上面的結果是系統的模擬佔位判斷，不代表任何代理人的意見。`])}
    </div>`;
  }

  const cards = isTpl ? _tplReplies(data, pr) : _rsaReplies(data, pr);
  return `<div class="agent-replies">${header}${cards.join("")}</div>`;
}

function _ensureAgentReplyStyles() {
  if (document.getElementById("agent-reply-styles")) return;
  const css = `
  .agent-replies { margin-top: 14px; }
  .agent-replies-title { font-weight: 700; font-size: 13.5px; margin-bottom: 8px; }
  .agent-reply { background: #fff; border: 1px solid #d8dee2; border-left-width: 4px; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; }
  .agent-reply.ok { border-left-color: #0f5c56; }
  .agent-reply.warn { border-left-color: #c48a1d; }
  .agent-reply.bad { border-left-color: #8a2c22; }
  .agent-reply.muted { border-left-color: #a9b4bb; }
  .agent-reply-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .agent-reply-role { font-size: 12px; color: #4a5b68; }
  .agent-reply-status { margin-left: auto; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: #eef1f2; color: #4a5b68; }
  .agent-reply.ok .agent-reply-status { background: #e3efed; color: #0f5c56; }
  .agent-reply.warn .agent-reply-status { background: #fdf3e3; color: #7a4a06; }
  .agent-reply.bad .agent-reply-status { background: #fbeaea; color: #8a2c22; }
  .agent-reply p { margin: 4px 0; font-size: 13.5px; line-height: 1.7; }`;
  const el = document.createElement("style");
  el.id = "agent-reply-styles";
  el.textContent = css;
  document.head.appendChild(el);
}
