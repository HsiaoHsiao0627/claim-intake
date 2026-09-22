// ============================================================
// staff_rsa.js — staff.html「道路救援 RSA」分頁（理賠人員登錄）
//
// 欄位對齊 RSA Excel（報修日期／時間／單號、專案名稱、車號、駕駛人、
// 故障地點、拖吊目的地、處理情形一～三、km）。前端算出的「處理歸類」
// 「專案上限」只供人員檢視，後端 staff_rules.py 會重算一次並以後端為準。
// 依賴 common.js 提供的 API_BASE、setupUploadZone、escapeHtml。
// ============================================================
(function () {
  // 處理情形選項（依 RSA_train／RSA_val 歷史資料整理；「車價」類依業務決定不列入）
  const OPTION_GROUPS = [
    { name: "拖吊", items: ["全載拖吊", "平面拖吊", "國道強排"] },
    { name: "急修", items: ["接電", "接電排空", "換備胎", "打氣一輪", "打氣二輪", "打氣三輪", "代送油料"] },
    { name: "現場作業", items: ["特殊作業", "國道第二類現場處理", "地下室B1作業", "地下室B2作業", "地下室B3作業", "地下室B4作業", "立體停車場3F", "立體停車場5F", "加人／加車作業"] },
    { name: "費用與狀態", items: ["載重費", "已-車主其他原因取消"] },
  ];
  const MAX_PICK = 3;
  const TOW = ["全載拖吊", "平面拖吊", "國道強排"];
  const FIX = ["接電", "接電排空", "換備胎", "打氣一輪", "打氣二輪", "打氣三輪", "代送油料"];
  const NUMS = ["一", "二", "三"];

  // 與 backend/staff_rules.py 的 classify_handling() 同一套規則
  function classify(items) {
    if (!items.length) return null;
    if (items.includes("已-車主其他原因取消")) return "道路救援空趟";
    if (items.includes("特殊作業") || items.includes("國道第二類現場處理")) return "特殊作業";
    if (items.some(x => TOW.includes(x))) return "拖吊";
    if (items.some(x => FIX.includes(x))) return "急修";
    return null;
  }

  // 與 backend/staff_rules.py 的 parse_project_name() 同一套規則
  function parseProject(name) {
    if (!name) return null;
    const amt = name.match(/([\d,]+)\s*元/);
    const km = name.match(/(\d+)\s*K(?!\s*次)/i);
    const cnt = name.match(/(\d+)\s*次/);
    return {
      limit_amount: amt ? Number(amt[1].replace(/,/g, "")) : null,
      km_limit: /不限\s*K/i.test(name) ? "不限" : (km ? Number(km[1]) : null),
      use_limit: /不限\s*K?\s*次/i.test(name) ? "不限" : (cnt ? Number(cnt[1]) : null),
    };
  }

  // 身分證驗檢查碼；居留證只驗格式。回傳 ok / arc / bad(檢查碼不符) / fmt(格式錯)
  function checkTwId(id) {
    const letters = "ABCDEFGHJKLMNPQRSTUVXYWZIO";
    if (/^[A-Z][12]\d{8}$/.test(id)) {
      const n = letters.indexOf(id[0]) + 10;
      const digits = [Math.floor(n / 10), n % 10, ...id.slice(1).split("").map(Number)];
      const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
      return digits.reduce((s, d, i) => s + d * w[i], 0) % 10 === 0 ? "ok" : "bad";
    }
    if (/^[A-Z][89]\d{8}$/.test(id) || /^[A-Z][A-D]\d{8}$/.test(id)) return "arc";
    return "fmt";
  }

  const $ = id => document.getElementById(id);
  const val = id => { const v = $(id).value.trim(); return v === "" ? null : v; };
  const form = $("rsaForm");
  const policyUpload = setupUploadZone("rsaPolicyZone", "rsaPolicyInput", "rsaPolicyList");
  const evidenceUpload = setupUploadZone("rsaEvZone", "rsaEvInput", "rsaEvList");

  let picks = [];          // [{ value, other }]
  let incidentTouched = false;
  let reportNoState = { value: null, duplicateOf: null };

  // ---------------- 處理情形多選 ----------------
  function buildPanel() {
    const panel = $("rsaMsPanel");
    panel.innerHTML = "";
    OPTION_GROUPS.forEach(g => {
      const wrap = document.createElement("div");
      wrap.className = "ms-group";
      wrap.innerHTML = `<h4>${g.name}</h4>`;
      const opts = document.createElement("div");
      opts.className = "ms-opts";
      g.items.forEach(v => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ms-opt"; b.textContent = v; b.dataset.v = v;
        b.addEventListener("click", () => toggle(v));
        opts.appendChild(b);
      });
      wrap.appendChild(opts);
      panel.appendChild(wrap);
    });
    const other = document.createElement("div");
    other.className = "ms-group";
    other.innerHTML = `<h4>其他（非常見情形）</h4>
      <div class="ms-other"><input id="rsaOtherInput" placeholder="其他：自行輸入"><button type="button" id="rsaOtherAdd">加入</button></div>`;
    panel.appendChild(other);
    const foot = document.createElement("div");
    foot.className = "ms-foot";
    foot.innerHTML = `<span id="rsaMsCount"></span><button type="button" id="rsaMsDone">完成</button>`;
    panel.appendChild(foot);
    $("rsaOtherAdd").addEventListener("click", addOther);
    $("rsaOtherInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addOther(); } });
    $("rsaMsDone").addEventListener("click", closePanel);
  }
  function toggle(v) {
    const i = picks.findIndex(p => p.value === v && !p.other);
    if (i >= 0) picks.splice(i, 1);
    else if (picks.length < MAX_PICK) picks.push({ value: v, other: false });
    renderPicks();
  }
  function addOther() {
    const v = $("rsaOtherInput").value.trim();
    if (!v || picks.length >= MAX_PICK || picks.some(p => p.value === v)) return;
    picks.push({ value: v, other: true });
    $("rsaOtherInput").value = "";
    renderPicks();
  }
  function renderPicks() {
    const trig = $("rsaMsTrigger");
    trig.querySelectorAll(".chip").forEach(c => c.remove());
    $("rsaMsPlaceholder").style.display = picks.length ? "none" : "";
    picks.forEach((p, i) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.innerHTML = `<span class="ord">${NUMS[i]}</span>${p.other ? "其他：" : ""}${escapeHtml(p.value)}<button type="button" aria-label="移除 ${escapeHtml(p.value)}">×</button>`;
      c.querySelector("button").addEventListener("click", e => { e.stopPropagation(); picks.splice(i, 1); renderPicks(); });
      trig.appendChild(c);
    });
    document.querySelectorAll("#rsaMsPanel .ms-opt").forEach(b => {
      const on = picks.some(p => p.value === b.dataset.v && !p.other);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.disabled = !on && picks.length >= MAX_PICK;
    });
    $("rsaOtherInput").disabled = $("rsaOtherAdd").disabled = picks.length >= MAX_PICK;
    $("rsaMsCount").textContent = `已選 ${picks.length} / ${MAX_PICK}`;
    const cls = classify(picks.map(p => p.value));
    const badge = $("rsaClsBadge");
    const map = { "拖吊": "tow", "急修": "fix", "特殊作業": "spc", "道路救援空趟": "empty" };
    if (!picks.length) { badge.className = "cls empty"; badge.textContent = "尚未選擇"; }
    else if (!cls) { badge.className = "cls none"; badge.textContent = "無法自動判斷，送出後交人工確認"; }
    else { badge.className = "cls " + map[cls]; badge.textContent = cls; }
    if (picks.length) setInvalid("handling", false);
  }
  function openPanel() { $("rsaMs").classList.add("open"); $("rsaMsTrigger").setAttribute("aria-expanded", "true"); }
  function closePanel() { $("rsaMs").classList.remove("open"); $("rsaMsTrigger").setAttribute("aria-expanded", "false"); }
  $("rsaMsTrigger").addEventListener("click", () => $("rsaMs").classList.contains("open") ? closePanel() : openPanel());
  document.addEventListener("click", e => { if (!$("rsaMs").contains(e.target)) closePanel(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });

  // ---------------- 專案名稱 ----------------
  function renderProject() {
    const p = parseProject(val("rsa_project_name"));
    const box = $("rsaProjectParsed");
    if (!p) { box.innerHTML = ""; return; }
    const f = (v, unit) => v === null ? "未載明" : (typeof v === "number" ? `${v.toLocaleString()} ${unit}` : v);
    box.innerHTML = `<span>理賠上限 <b>${f(p.limit_amount, "元")}</b></span>
      <span>拖吊里程 <b>${f(p.km_limit, "km")}</b></span>
      <span>使用次數 <b>${f(p.use_limit, "次")}</b></span>`;
  }
  $("rsa_project_name").addEventListener("input", renderProject);

  // ---------------- 報修單號：格式提醒＋即時重複檢查 ----------------
  function showMsg(id, kind, text) { const m = $(id); m.className = kind ? `msg ${kind} show` : "msg"; m.textContent = text || ""; }
  async function checkReportNo() {
    const v = val("rsa_report_no");
    reportNoState = { value: v, duplicateOf: null };
    setInvalid("report_no", false);
    if (!v) { showMsg("rsaReportNoMsg"); return; }
    try {
      const resp = await fetch(`${API_BASE}/v1/staff/report-no/${encodeURIComponent(v)}`);
      if (!resp.ok) throw new Error();
      const data = await resp.json();
      if (val("rsa_report_no") !== v) return; // 查詢期間已被改掉
      if (data.exists) {
        reportNoState.duplicateOf = data.case_id;
        setInvalid("report_no", true);
        showMsg("rsaReportNoMsg", "err", `報修單號 ${v} 已登錄過（案件 ${data.case_id}），同一張派工單不可重複送出。`);
        return;
      }
    } catch {
      showMsg("rsaReportNoMsg", "warn", "目前無法即時檢查單號是否重複，送出時系統會再檢查一次。");
      return;
    }
    if (!/^\d{7}$/.test(v)) showMsg("rsaReportNoMsg", "warn", "歷史資料的報修單號皆為 7 位數字，請確認是否輸入正確。");
    else showMsg("rsaReportNoMsg", "ok", "單號可使用。");
  }
  $("rsa_report_no").addEventListener("blur", checkReportNo);
  $("rsa_report_no").addEventListener("input", () => { showMsg("rsaReportNoMsg"); setInvalid("report_no", false); reportNoState = { value: null, duplicateOf: null }; });

  // ---------------- 駕駛人 ID ----------------
  // 格式錯誤會擋；檢查碼不符只提醒（歷史資料 1,039 筆中有 3 筆檢查碼不符）
  function checkDriverId() {
    const el = $("rsa_driver_id");
    el.value = el.value.toUpperCase().trim();
    setInvalid("driver_id", false);
    showMsg("rsaDriverIdMsg");
    if (!el.value) return "ok";
    const r = checkTwId(el.value);
    if (r === "ok" || r === "arc") return "ok";
    if (r === "bad") { showMsg("rsaDriverIdMsg", "warn", "身分證字號檢查碼不符，請再確認；若派工單上確實如此，仍可送出，系統會標記提醒。"); return "warn"; }
    setInvalid("driver_id", true);
    showMsg("rsaDriverIdMsg", "err", "格式應為 1 個英文字母加 9 碼數字（身分證或居留證）。");
    return "err";
  }
  $("rsa_driver_id").addEventListener("blur", checkDriverId);

  // ---------------- 事故日期預設帶入報修日期 ----------------
  $("rsa_report_date").addEventListener("change", () => { if (!incidentTouched) $("rsa_incident_date").value = $("rsa_report_date").value; });
  $("rsa_incident_date").addEventListener("input", () => { incidentTouched = true; });

  // ---------------- 驗證 → 預覽 → 送出 ----------------
  function setInvalid(f, on) {
    const el = form.querySelector(`.field[data-f="${f}"]`);
    if (el) el.classList.toggle("invalid", !!on);
  }
  function showErrors(errs) {
    const box = $("rsaErrBox");
    if (!errs.length) { box.style.display = "none"; return; }
    box.innerHTML = `<b>還有 ${errs.length} 個問題需要處理：</b><ul>${errs.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const errs = [];
    [["rsa_report_date", "report_date", "報修日期"], ["rsa_report_time", "report_time", "報修時間"],
     ["rsa_report_no", "report_no", "報修單號"], ["rsa_project_name", "project_name", "專案名稱"],
     ["rsa_plate_no", "plate_no", "車號"], ["rsa_incident_date", "incident_date", "事故日期"],
     ["rsa_claim_amount", "claim_amount", "申請理賠金額"]].forEach(([id, f, label]) => {
      const miss = !val(id); setInvalid(f, miss); if (miss) errs.push(`${label}未填寫`);
    });
    const policyMiss = !val("rsa_policy_no") && policyUpload.getFiles().length === 0;
    setInvalid("policy_no", policyMiss);
    if (policyMiss) errs.push("保單號碼未填寫（或上傳保單照片）");
    if (!picks.length) { setInvalid("handling", true); errs.push("處理情形至少選擇一項"); }
    if (val("rsa_report_no") && reportNoState.value !== val("rsa_report_no")) await checkReportNo();
    if (reportNoState.duplicateOf) errs.push(`報修單號已登錄過（案件 ${reportNoState.duplicateOf}）`);
    if (checkDriverId() === "err") errs.push("駕駛人 ID 格式有誤");
    showErrors(errs);
    if (!errs.length) showPreview();
  });

  function collect() {
    const items = picks.map(p => p.value);
    return {
      insurance_type: "車險", channel: "staff_web", intake_mode: "staff",
      report_date: val("rsa_report_date"), report_time: val("rsa_report_time"), report_no: val("rsa_report_no"),
      policy_no: val("rsa_policy_no"), policy_active: val("rsa_policy_active"), project_name: val("rsa_project_name"),
      plate_no: val("rsa_plate_no"), driver_id: val("rsa_driver_id"), driver_name: val("rsa_driver_name"),
      incident_date: val("rsa_incident_date"), accident_km: val("rsa_accident_km"),
      fault_location: val("rsa_fault_location"), tow_destination: val("rsa_tow_destination"),
      handling_1: items[0] || null, handling_2: items[1] || null, handling_3: items[2] || null,
      claim_amount: val("rsa_claim_amount"), description: val("rsa_description"),
    };
  }

  function showPreview() {
    const d = collect();
    const proj = parseProject(d.project_name) || {};
    const policyFiles = policyUpload.getFiles().length, evFiles = evidenceUpload.getFiles().length;
    const rows = [
      ["sec", "報修資訊"], ["報修日期", d.report_date], ["報修時間", d.report_time], ["報修單號", d.report_no],
      ["sec", "保單與專案"],
      ["保單號碼", d.policy_no ?? (policyFiles ? "（由保單照片辨識帶入）" : null)],
      ["保單照片", policyFiles ? `${policyFiles} 個檔案` : null],
      ["保單於事故當下是否有效", d.policy_active], ["專案名稱", d.project_name],
      ["已投保道援附加條款", "是（由專案名稱推得）"],
      ["理賠上限", proj.limit_amount], ["拖吊里程上限", proj.km_limit], ["使用次數上限", proj.use_limit],
      ["sec", "車輛與駕駛人"], ["車號", d.plate_no], ["駕駛人ＩＤ", d.driver_id], ["駕駛人姓名", d.driver_name],
      ["sec", "事故與處理"], ["事故日期", d.incident_date], ["事故公里數", d.accident_km],
      ["故障地點", d.fault_location], ["拖吊目的地", d.tow_destination],
      ["處理情形一", d.handling_1], ["處理情形二", d.handling_2], ["處理情形三", d.handling_3],
      ["處理歸類（自動）", classify(picks.map(p => p.value))],
      ["申請理賠金額", d.claim_amount], ["事故簡述", d.description],
      ["佐證文件", evFiles ? `${evFiles} 個檔案` : null],
    ];
    $("rsaPvTable").innerHTML = rows.map(r => r[0] === "sec"
      ? `<tr class="sec"><th colspan="2">${r[1]}</th></tr>`
      : `<tr><th>${r[0]}</th><td class="${r[1] == null ? "null" : ""}">${r[1] == null ? "null" : escapeHtml(r[1])}</td></tr>`
    ).join("");
    form.classList.add("hidden");
    $("rsaPreview").classList.remove("hidden");
    $("rsaPreview").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("rsaBackEdit").addEventListener("click", () => {
    $("rsaPreview").classList.add("hidden");
    form.classList.remove("hidden");
  });

  $("rsaSubmitBtn").addEventListener("click", async () => {
    const btn = $("rsaSubmitBtn");
    btn.disabled = true; btn.textContent = "送出中…";
    const fd = new FormData();
    Object.entries(collect()).forEach(([k, v]) => { if (v !== null && v !== undefined) fd.append(k, v); });
    policyUpload.getFiles().forEach(f => fd.append("policy_documents", f));
    evidenceUpload.getFiles().forEach(f => fd.append("evidence_documents", f));
    try {
      const resp = await fetch(`${API_BASE}/v1/claims`, { method: "POST", body: fd });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || `送出失敗（狀態碼 ${resp.status}）`);
      $("rsaCaseId").textContent = data.case_id;
      $("rsaConfirmCategory").textContent = `處理歸類：${data.service_category || "無法自動判斷，已交人工確認"}`;
      $("rsaConfirmWarn").textContent = (data.validation_warnings || []).length ? `系統提醒：${data.validation_warnings.join("；")}` : "";
      $("rsaPreview").classList.add("hidden");
      $("rsaConfirm").classList.remove("hidden");
      $("lookupInput").value = data.case_id;
    } catch (err) {
      $("rsaPreview").classList.add("hidden");
      form.classList.remove("hidden");
      showErrors([err.message || "送出時發生錯誤，請稍後再試。"]);
    } finally {
      btn.disabled = false; btn.textContent = "確認送出";
    }
  });

  // ---------------- 重設／demo ----------------
  function resetForm() {
    form.reset();
    form.classList.remove("hidden");
    $("rsaPreview").classList.add("hidden");
    $("rsaConfirm").classList.add("hidden");
    policyUpload.reset(); evidenceUpload.reset();
    picks = []; incidentTouched = false; reportNoState = { value: null, duplicateOf: null };
    showMsg("rsaReportNoMsg"); showMsg("rsaDriverIdMsg");
    form.querySelectorAll(".field.invalid").forEach(f => f.classList.remove("invalid"));
    $("rsaErrBox").style.display = "none";
    document.querySelectorAll("#rsaDemoList .demo-item").forEach(b => b.classList.remove("active"));
    renderPicks(); renderProject();
  }
  $("rsaNewCase").addEventListener("click", resetForm);
  $("rsaDemoReset").addEventListener("click", resetForm);

  // Demo 案例（暫定內容；車號、姓名為虛構，歷史資料這兩欄已雜湊）
  const RSA_STAFF_DEMO_CASES = [
    { id: "tow", tag: "approve", tagLabel: "拖吊", title: "一般拖吊", desc: "市區拋錨全載拖吊，欄位齊全",
      data: { report_date: "2026-02-28", report_time: "13:54", report_no: "9612301", policy_no: "POL-2026-88901", policy_active: "是",
        project_name: "自費購道援險(30,000元,60K,3次)", plate_no: "ABC-1234", driver_id: "A123456789", driver_name: "王大明",
        accident_km: "25", fault_location: "新北市林口區文化一路一段近崇林國中天橋", tow_destination: "私人廠//大義街16號",
        claim_amount: "2800", description: "引擎無法發動，現場檢查後需拖回保養廠。" },
      picks: ["全載拖吊"] },
    { id: "fix", tag: "approve", tagLabel: "急修", title: "接電急修", desc: "電瓶沒電，現場接電完成",
      data: { report_date: "2026-02-01", report_time: "19:45", report_no: "9612455", policy_no: "POL-2026-77120", policy_active: "是",
        project_name: "自費購道援險(50,000元,不限K次)", plate_no: "BKR-5520", driver_id: "H120530963", driver_name: "陳小華",
        accident_km: "0", fault_location: "桃園市桃園區富國路646巷6弄40號", tow_destination: "", claim_amount: "950", description: "" },
      picks: ["接電"] },
    { id: "special", tag: "review", tagLabel: "特殊作業", title: "地下室特殊作業", desc: "平面拖吊加地下室作業，歸類為特殊作業",
      data: { report_date: "2026-03-12", report_time: "08:20", report_no: "9620018", policy_no: "POL-2026-66031", policy_active: "",
        project_name: "自費購道援險(10,000元,20K,3次)", plate_no: "RDN-7781", driver_id: "", driver_name: "林美玲",
        accident_km: "8", fault_location: "台中市西屯區市政路500號 B2 停車場", tow_destination: "原廠台中服務廠",
        claim_amount: "4700", description: "車輛停放於地下二樓，需以特殊設備拉出。" },
      picks: ["平面拖吊", "特殊作業", "地下室B2作業"] },
  ];
  renderDemoList(RSA_STAFF_DEMO_CASES, "rsaDemoList", c => {
    resetForm();
    Object.entries(c.data).forEach(([k, v]) => { const el = $("rsa_" + k); if (el) el.value = v; });
    $("rsa_incident_date").value = c.data.report_date;
    picks = c.picks.map(v => ({ value: v, other: false }));
    renderPicks(); renderProject();
    checkReportNo(); checkDriverId();
    document.querySelectorAll("#rsaDemoList .demo-item").forEach(b => b.classList.toggle("active", b.dataset.id === c.id));
  });

  buildPanel();
  renderPicks();
})();
