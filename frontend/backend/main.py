# -*- coding: utf-8 -*-
"""
main.py — 理賠案件受理 API（測試系統，無身份驗證）

設計原則（呼應這次的五個決定）：
  1. 送出後立刻回「已受理」，實際處理在背景執行，最終用通知管道告知結果。
  2. 完全無登入/驗證，任何人皆可呼叫（測試階段限定，正式上線前必須補上，
     包含下面新增的 /v1/admin/* 後台端點——這批端點同樣刻意先不加驗證，
     正式上線前要補 Admin API Key 或帳密登入）。
  3. 上傳文件會嘗試 OCR 擷取欄位（見 seams.py，GEMINI_API_KEY 設定後改用真實
     Gemini 擷取，否則為樁）。保單照片跟理賠佐證文件是兩種不同性質的上傳，
     分開處理：保單照片擷取 policy_no/insured_name/保險期間，佐證文件擷取
     amount/date/diagnosis。保戶表單欄位留空時，OCR 讀到的值才會拿來自動
     帶入——這個「自動帶入」會誠實記在 ocr_filled_fields，後台看得出來
     哪些欄位是 OCR 補的、不是保戶手填的，不會混為一談。
  4. 沒有「申請人工複核」端點（保戶端）。後台人員標記複核狀態的端點有。
  5. 沒有任何法遵揭露文字或個資同意書邏輯。

管道無關設計：這支 API 不知道、也不需要知道呼叫者是網頁表單還是未來的 LINE
webhook——兩者都只是呼叫同一個 create_claim() + 背景流程，channel 參數只是
記錄用，不影響任何業務邏輯。這是為了呼應「以後可能要延伸到 LINE」的需求，
現在就不要把管道邏輯埋進核心流程裡。
"""
import os
import json
import shutil
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Form, UploadFile, File, BackgroundTasks, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse

import store
import seams

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="兆豐理賠案件受理 API（測試系統）")

# 測試階段對任何來源開放；上線前務必收窄成實際前端網域
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    store.init_db()


# ============================================================
# 案件受理（管道無關：網頁前端與未來 LINE webhook 都呼叫這支）
# ============================================================
@app.post("/v1/claims")
async def submit_claim(
    background_tasks: BackgroundTasks,
    insurance_type: str = Form(...),
    policy_no: Optional[str] = Form(None),
    applicant_name: Optional[str] = Form(None),
    claim_amount: Optional[float] = Form(None),
    incident_date: Optional[str] = Form(None),
    description: str = Form(""),
    contact_email: Optional[str] = Form(None),
    contact_phone: Optional[str] = Form(None),
    channel: str = Form("web"),
    policy_documents: list[UploadFile] = File(default=[]),
    evidence_documents: list[UploadFile] = File(default=[]),
):
    if not contact_email and not contact_phone:
        raise HTTPException(400, "email 與電話至少要留一個，否則無法通知結果")

    # policy_no/申請人/金額/日期 可以用手打，也可以靠上傳的保單照片／佐證文件
    # 讓 OCR 補上——但兩邊都沒有的話，這筆案件註定資料不全，直接擋在受理前，
    # 不要讓一個完全沒有保單資訊、也沒有金額的案件進到後續流程。
    if not policy_no and not policy_documents:
        raise HTTPException(400, "請填寫保單號，或上傳保單照片供系統辨識")
    if applicant_name is None and not policy_documents:
        raise HTTPException(400, "請填寫申請人姓名，或上傳保單照片供系統辨識")
    if claim_amount is None and not evidence_documents:
        raise HTTPException(400, "請填寫申請理賠金額，或上傳收據／估價單等佐證文件供系統辨識")
    if not incident_date and not evidence_documents:
        raise HTTPException(400, "請填寫事故／就醫日期，或上傳佐證文件供系統辨識")

    submitted_fields = {
        "policy_no": policy_no, "applicant_name": applicant_name,
        "insurance_type": insurance_type, "claim_amount": claim_amount,
        "incident_date": incident_date, "description": description,
        "contact_email": contact_email, "contact_phone": contact_phone,
    }

    case_id = store.create_claim(submitted_fields, file_paths={}, channel=channel)

    # 存檔（SEAM：測試階段存本地磁碟，上線後改存 Cloud Storage，
    # 用簽章網址讓前端直接上傳，避免大檔案吃掉 API 的請求大小限制）
    case_dir = UPLOAD_DIR / case_id
    saved = {"policy": [], "evidence": []}
    for doc_type, docs in (("policy", policy_documents), ("evidence", evidence_documents)):
        if not docs:
            continue
        sub_dir = case_dir / doc_type
        sub_dir.mkdir(parents=True, exist_ok=True)
        for doc in docs:
            dest = sub_dir / doc.filename
            with dest.open("wb") as f:
                shutil.copyfileobj(doc.file, f)
            saved[doc_type].append(str(dest))
    store.update_status(case_id, "received", file_paths=json.dumps(saved))

    background_tasks.add_task(_process_claim, case_id, submitted_fields, saved)

    return {
        "case_id": case_id,
        "status": "received",
        "message": "您的理賠申請已受理，審核完成後將以您留下的聯絡方式通知結果。",
    }


# ============================================================
# 背景處理流程：OCR → 自動帶入空欄位 → 協調層 → 通知
# ============================================================
# OCR 擷取欄位名 -> 表單欄位名的對應。只有表單欄位「留空」時才會用這裡的值
# 自動帶入，且一律記錄進 ocr_filled_fields，不會悄悄覆蓋保戶自己填的資料。
_POLICY_FIELD_MAP = {"policy_no": "policy_no", "insured_name": "applicant_name"}
_EVIDENCE_FIELD_MAP = {"amount": "claim_amount", "date": "incident_date"}


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


async def _process_claim(case_id: str, submitted_fields: dict, file_paths: dict):
    try:
        store.update_status(case_id, "ocr_processing")
        ocr = seams.get_ocr_extractor()
        ocr_result = await ocr.extract(file_paths.get("policy", []), file_paths.get("evidence", []))
        store.update_status(case_id, "ocr_done", ocr_result=json.dumps(ocr_result, ensure_ascii=False))

        # 只補保戶留空的欄位，絕不覆蓋保戶已填的值
        policy_fields = (ocr_result.get("policy") or {}).get("fields", {})
        evidence_fields = (ocr_result.get("evidence") or {}).get("fields", {})
        autofill, filled_names = {}, []
        for ocr_key, form_key in {**_POLICY_FIELD_MAP, **_EVIDENCE_FIELD_MAP}.items():
            source = policy_fields if ocr_key in _POLICY_FIELD_MAP else evidence_fields
            ocr_value = source.get(ocr_key)
            if _blank(submitted_fields.get(form_key)) and not _blank(ocr_value):
                autofill[form_key] = ocr_value
                filled_names.append(form_key)

        if autofill:
            store.apply_ocr_autofill(case_id, autofill, filled_names)
            submitted_fields = {**submitted_fields, **autofill}

        # 保戶手填 + OCR 自動帶入之後，關鍵欄位若仍缺，誠實停在這裡轉人工，
        # 不要讓協調層拿到 None/0 這種會被誤判成「金額為零」的資料去做決策。
        missing = [f for f in ("policy_no", "applicant_name", "claim_amount", "incident_date")
                   if _blank(submitted_fields.get(f))]
        if missing:
            store.update_status(
                case_id, "escalated_human",
                error_message=f"OCR 辨識後仍缺少必要欄位：{', '.join(missing)}，需人工確認",
            )
            return

        store.update_status(case_id, "pipeline_processing")
        claim_data = {**submitted_fields, "ocr_result": ocr_result}
        result = await seams.submit_to_orchestrator_with_fallback(case_id, claim_data)

        final_status = "escalated_human" if result.get("decision") == "escalate_human" else "completed"
        store.update_status(case_id, final_status, pipeline_result=json.dumps(result, ensure_ascii=False))

        notifier = seams.get_notifier()
        await notifier.notify(case_id, submitted_fields.get("contact_email"),
                               submitted_fields.get("contact_phone"), result)
    except Exception as e:
        # 誠實記錄錯誤，不要吞掉、不要假裝成功
        store.update_status(case_id, "error", error_message=f"{type(e).__name__}: {e}")


# ============================================================
# 狀態查詢（測試/除錯用；正式產品的主要通知管道是 email/簡訊，不是這支）
# ============================================================
@app.get("/v1/claims/{case_id}")
def get_claim_status(case_id: str):
    claim = store.get_claim(case_id)
    if claim is None:
        raise HTTPException(404, "查無此案件編號")
    return claim


@app.get("/v1/health")
def health():
    return {"status": "ok"}


# ============================================================
# 後台總覽（/admin 頁面用；⚠️ 測試階段刻意不加驗證，正式上線前必須補
# Admin API Key 或帳密登入，比照未來 policy 管理端點的做法）
# ============================================================
def _parse_admin_filters(
    status: Optional[str], channel: Optional[str], insurance_type: Optional[str],
    review_status: Optional[str], q: Optional[str],
    date_from: Optional[str], date_to: Optional[str],
) -> dict:
    return {
        "status": status, "channel": channel, "insurance_type": insurance_type,
        "review_status": review_status, "q": q,
        "date_from": date_from, "date_to": date_to,
    }


@app.get("/v1/admin/claims")
def admin_list_claims(
    status: Optional[str] = None,
    channel: Optional[str] = None,
    insurance_type: Optional[str] = None,
    review_status: Optional[str] = None,
    q: Optional[str] = Query(None, description="模糊搜尋 case_id / policy_no / applicant_name"),
    date_from: Optional[str] = Query(None, description="ISO 日期，篩 created_at 起"),
    date_to: Optional[str] = Query(None, description="ISO 日期，篩 created_at 迄"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
):
    filters = _parse_admin_filters(status, channel, insurance_type, review_status, q, date_from, date_to)
    rows, total = store.list_claims(filters, limit=page_size, offset=(page - 1) * page_size)
    return {
        "items": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size if page_size else 0,
    }


@app.get("/v1/admin/claims/export.csv")
def admin_export_claims_csv(
    status: Optional[str] = None,
    channel: Optional[str] = None,
    insurance_type: Optional[str] = None,
    review_status: Optional[str] = None,
    q: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    filters = _parse_admin_filters(status, channel, insurance_type, review_status, q, date_from, date_to)
    csv_text = store.export_claims_csv(filters)
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=claims_export.csv"},
    )


@app.get("/v1/admin/claims/{case_id}")
def admin_get_claim_detail(case_id: str):
    claim = store.get_claim(case_id)
    if claim is None:
        raise HTTPException(404, "查無此案件編號")
    return claim


@app.post("/v1/admin/claims/{case_id}/review")
def admin_set_review(
    case_id: str,
    review_status: str = Form(...),
    reviewed_by: Optional[str] = Form(None),
    review_note: Optional[str] = Form(None),
):
    try:
        ok = store.set_review(case_id, review_status, reviewed_by, review_note)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "查無此案件編號")
    return store.get_claim(case_id)


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    print(f"[警告] 找不到前端資料夾：{FRONTEND_DIR}，'/' 無法提供網頁，但 /v1/... 的 API 端點不受影響。")
