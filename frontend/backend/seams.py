# -*- coding: utf-8 -*-
"""
seams.py — 三個對外整合點：OCR / 協調層 / 通知

每個都是「介面 + 誠實的樁(stub)」。樁不假裝有真結果，缺什麼就明確回報缺什麼，
不虛構金額、不虛構判決——這樣測試時看到的任何「假資料」都清楚標示 simulated=True，
不會被誤認成真實案件結果。

# TODO SEAM 標記的地方，是接上真實系統時要換的程式碼。
"""
import os
import json as _json
import httpx
from abc import ABC, abstractmethod


# ============================================================
# 1. OCR 擷取 —— 保單文件（保單號/被保險人/保險期間）跟理賠佐證文件
#    （收據/估價單/診斷金額日期）是兩種不同性質的文件，分開擷取、
#    分開回傳，不要混在同一組欄位裡靠猜的方式合併。
# ============================================================
class OCRExtractor(ABC):
    @abstractmethod
    async def extract(self, policy_files: list, evidence_files: list) -> dict:
        """回傳 {'policy': {...}, 'evidence': {...}}，兩者結構皆為
        {'simulated': bool, 'fields': {...}, 'per_file': [...], 'errors': [...]}"""
        ...


def _empty_ocr_block(file_paths: list, note: str) -> dict:
    return {
        "simulated": True,
        "fields": {},  # 刻意留空，不虛構任何擷取欄位
        "per_file": [{"file": f, "status": "not_processed"} for f in file_paths],
        "errors": [],
        "note": note,
    }


class StubOCRExtractor(OCRExtractor):
    """尚未設定 GEMINI_API_KEY 前的樁。誠實回報「未執行」，
    不虛構任何擷取欄位，避免測試者誤以為 OCR 已經真的在跑。"""

    async def extract(self, policy_files: list, evidence_files: list) -> dict:
        note = "OCR 尚未設定 GEMINI_API_KEY，此為樁。設定後會自動改用 RealOCRExtractor。"
        return {
            "policy": _empty_ocr_block(policy_files, note),
            "evidence": _empty_ocr_block(evidence_files, note),
        }


class RealOCRExtractor(OCRExtractor):
    """呼叫 Gemini API 做多模態文件擷取。金鑰一律從環境變數讀，不寫死在程式碼裡。

    多檔案合併規則：同一欄位在不同檔案讀到不同值時，不靜默覆蓋、不挑一個當正確
    答案，改標記進 fields['_conflicts']，交給後續流程（後台人員複核／法官代理人
    的詐欺旗標）判斷，不在這層就替使用者決定哪個值才是對的。
    """

    POLICY_PROMPT = (
        "你是保險保單文件擷取助手。請從這張保單影像中擷取以下欄位，"
        "只回傳 JSON，不要有其他文字、不要用 markdown code block：\n"
        '{"policy_no": "文字或null", "insured_name": "文字或null", '
        '"policy_period_start": "YYYY-MM-DD或null", "policy_period_end": "YYYY-MM-DD或null"}\n'
        "看不清楚或文件中沒有某欄位，該欄位填 null，不要用猜測值填充。"
    )
    EVIDENCE_PROMPT = (
        "你是保險理賠文件擷取助手。請從這份文件中擷取以下欄位，"
        "只回傳 JSON，不要有其他文字、不要用 markdown code block：\n"
        '{"amount": 數字或null, "date": "YYYY-MM-DD或null", "diagnosis": "文字或null"}\n'
        "看不清楚或文件中沒有某欄位，該欄位填 null，不要用猜測值填充。"
    )

    def __init__(self, api_key: str, model: str = "gemini-flash-latest"):
        if not api_key:
            raise ValueError("GEMINI_API_KEY 未設定")
        from google import genai
        self._client = genai.Client(api_key=api_key)
        self._model = model

    async def extract(self, policy_files: list, evidence_files: list) -> dict:
        return {
            "policy": await self._extract_block(policy_files, self.POLICY_PROMPT),
            "evidence": await self._extract_block(evidence_files, self.EVIDENCE_PROMPT),
        }

    async def _extract_block(self, file_paths: list, prompt: str) -> dict:
        fields: dict = {}
        conflicts: dict = {}
        per_file = []
        errors = []

        for path in file_paths:
            try:
                extracted = await self._extract_one(path, prompt)
                per_file.append({"file": path, "status": "ok", "raw": extracted})
                for key, value in extracted.items():
                    if value is None:
                        continue
                    if key in fields and fields[key] != value:
                        conflicts.setdefault(key, [fields[key]]).append(value)
                    else:
                        fields[key] = value
            except Exception as e:
                per_file.append({"file": path, "status": "error", "error": str(e)})
                errors.append(f"{path}: {type(e).__name__}: {e}")

        if conflicts:
            fields["_conflicts"] = conflicts

        return {
            "simulated": False,
            "fields": fields,
            "per_file": per_file,
            "errors": errors,
        }

    async def _extract_one(self, file_path: str, prompt: str) -> dict:
        uploaded = await self._client.aio.files.upload(file=file_path)
        resp = await self._client.aio.models.generate_content(
            model=self._model,
            contents=[uploaded, prompt],
        )
        text = resp.text.strip()
        if text.startswith("```"):
            text = text.split("```")[1].removeprefix("json").strip()
        return _json.loads(text)


def get_ocr_extractor() -> OCRExtractor:
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        return RealOCRExtractor(api_key)
    return StubOCRExtractor()


# ============================================================
# 2. 協調層（規則→理賠→法官代理人）
# ============================================================
class OrchestratorClient(ABC):
    @abstractmethod
    async def submit(self, case_id: str, claim_data: dict) -> dict:
        """回傳協調層/法官代理人的最終結果 dict，至少含 decision 欄位。"""
        ...


class HTTPOrchestratorClient(OrchestratorClient):
    """真的去打協調層 API。若打不通(帳單暫停/尚未部署)，明確回報連線失敗，
    不偽裝成功——呼叫端會依此決定要不要落到模擬結果。"""

    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    async def submit(self, case_id: str, claim_data: dict) -> dict:
        headers = {"X-API-Key": self.api_key} if self.api_key else {}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/v1/submit-claim",
                json={"case_id": case_id, **claim_data},
                headers=headers,
            )
            resp.raise_for_status()
            return resp.json()


class SimulatedOrchestratorClient(OrchestratorClient):
    """協調層還沒部署/打不通時的替代品。回傳的每一筆結果都標記 simulated=True，
    決策邏輯只是粗略示範(金額>50萬轉人工，其餘放行)，不是真的規則/理賠/法官代理人在跑。
    測試介面時可以看到完整流程走完，但絕不能把這個結果當成真實理賠判斷。"""

    async def submit(self, case_id: str, claim_data: dict) -> dict:
        amount = claim_data.get("claim_amount") or 0
        decision = "escalate_human" if amount > 500_000 else "execute"
        return {
            "simulated": True,
            "case_id": case_id,
            "decision": decision,
            "next_agent": "human_review" if decision == "escalate_human" else "frontend",
            "reasons": ["模擬結果：協調層尚未部署或無法連線，此為佔位判斷，非真實審核"],
            "note": "這不是真實的規則/理賠/法官代理人輸出，僅供介面流程測試用。",
        }


def get_orchestrator_client() -> OrchestratorClient:
    base_url = os.environ.get("ORCHESTRATOR_URL")
    api_key = os.environ.get("ORCHESTRATOR_API_KEY")
    if base_url:
        return HTTPOrchestratorClient(base_url, api_key)
    return SimulatedOrchestratorClient()


async def submit_to_orchestrator_with_fallback(case_id: str, claim_data: dict) -> dict:
    """先試真實協調層；打不通(帳單暫停/尚未部署常見情況)就明確標記後退回模擬結果，
    不讓整條背景任務因為協調層還沒上線就整個失敗掛掉。"""
    client = get_orchestrator_client()
    if isinstance(client, SimulatedOrchestratorClient):
        return await client.submit(case_id, claim_data)
    try:
        return await client.submit(case_id, claim_data)
    except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
        fallback = await SimulatedOrchestratorClient().submit(case_id, claim_data)
        fallback["orchestrator_error"] = f"{type(e).__name__}: {e}"
        return fallback


# ============================================================
# 3. 通知（email/簡訊現在；LINE 推播之後）
# ============================================================
class Notifier(ABC):
    @abstractmethod
    async def notify(self, case_id: str, contact_email: str | None,
                      contact_phone: str | None, result: dict) -> None:
        ...


class StubNotifier(Notifier):
    """尚未接真實 SMTP/簡訊供應商前的樁：只記錄「本來會送出什麼」，不真的寄送。
    介面在同一個 case_id 查詢頁一樣看得到最終結果，方便沒有信箱/簡訊帳號時測試。"""

    async def notify(self, case_id: str, contact_email, contact_phone, result: dict) -> None:
        print(f"[通知樁] 案件 {case_id} 完成，決定={result.get('decision')}。"
              f"本來會寄送到 email={contact_email} phone={contact_phone}（尚未接真實服務）。")


# TODO SEAM ── 之後依管道擴充，例如：
# class LineNotifier(Notifier):
#     async def notify(self, case_id, contact_email, contact_phone, result):
#         # 呼叫 LINE Messaging API push message，用 LINE user_id 取代 email/phone
#         ...


def get_notifier() -> Notifier:
    return StubNotifier()
