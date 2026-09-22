# -*- coding: utf-8 -*-
"""
staff_rules.py — 理賠人員登錄模式（RSA）的業務規則

前端 staff.html 也會即時算一次同樣的結果給人員看，但前端的值只供顯示，
後端一律以這裡重算的結果為準，不信任前端傳上來的衍生欄位。

規則來源：RSA_train.xlsx（700 筆）＋ RSA_val.xlsx（339 筆）歷史資料。
排除「車價」類處理情形後，classify_handling() 與歷史「處理歸類」一致率約 98%
（1,039 筆中 1,019 筆一致；不一致的 20 筆幾乎都是含「車價」的紀錄）。
"""
import re
from typing import Optional

# 處理情形分組（「車價0／車價201／車價501／車價0、低底盤…」依業務決定不列入選項）
TOW_ITEMS = {"全載拖吊", "平面拖吊", "國道強排"}
FIX_ITEMS = {"接電", "接電排空", "換備胎", "打氣一輪", "打氣二輪", "打氣三輪", "代送油料"}
SPECIAL_ITEMS = {"特殊作業", "國道第二類現場處理"}
EMPTY_TRIP_ITEMS = {"已-車主其他原因取消"}

MAX_HANDLING_ITEMS = 3  # 對應 Excel 處理情形一／二／三

REPORT_NO_PATTERN = re.compile(r"^\d{7}$")  # 歷史資料的報修單號皆為 7 位數字（僅提醒，不擋）


def normalize_handling(items: list) -> list[str]:
    """去空白、去空值、保留順序、去重，最多 3 項。"""
    seen, result = set(), []
    for raw in items:
        if raw is None:
            continue
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result[:MAX_HANDLING_ITEMS]


def classify_handling(items: list[str]) -> Optional[str]:
    """依優先順序推出處理歸類；判斷不了回傳 None（交人工，不猜）。

    1. 含「已-車主其他原因取消」        → 道路救援空趟
    2. 含「特殊作業／國道第二類現場處理」 → 特殊作業
    3. 含拖吊類                          → 拖吊
    4. 只有急修類                        → 急修
    5. 其他（只有費用類或「其他」自填）  → None
    """
    s = set(items)
    if not s:
        return None
    if s & EMPTY_TRIP_ITEMS:
        return "道路救援空趟"
    if s & SPECIAL_ITEMS:
        return "特殊作業"
    if s & TOW_ITEMS:
        return "拖吊"
    if s & FIX_ITEMS:
        return "急修"
    return None


def parse_project_name(name: Optional[str]) -> dict:
    """從專案名稱解析理賠上限／里程上限／使用次數上限。

    例：「自費購道援險(30,000元,60K,3次)」→ {30000, 60, 3}
        「自費購道援險(50,000元,不限K次)」→ {50000, "不限", "不限"}
        「福斯保代自費購道援險(30,000元)」→ {30000, None, None}
    名稱沒寫的一律 None，不自動補值。
    """
    result = {"limit_amount": None, "km_limit": None, "use_limit": None}
    if not name:
        return result
    amount = re.search(r"([\d,]+)\s*元", name)
    if amount:
        result["limit_amount"] = int(amount.group(1).replace(",", ""))
    if re.search(r"不限\s*K", name, re.I):
        result["km_limit"] = "不限"
    else:
        km = re.search(r"(\d+)\s*K(?!\s*次)", name, re.I)
        if km:
            result["km_limit"] = int(km.group(1))
    if re.search(r"不限\s*K?\s*次", name, re.I):
        result["use_limit"] = "不限"
    else:
        count = re.search(r"(\d+)\s*次", name)
        if count:
            result["use_limit"] = int(count.group(1))
    return result


_TW_ID_LETTERS = "ABCDEFGHJKLMNPQRSTUVXYWZIO"


def check_driver_id(value: Optional[str]) -> Optional[str]:
    """回傳錯誤訊息；合法或空值回傳 None。

    本國身分證驗檢查碼；新式（第二碼 8/9）與舊式（第二碼 A–D）居留證只驗格式。
    """
    if not value:
        return None
    v = value.strip().upper()
    if re.fullmatch(r"[A-Z][12]\d{8}", v):
        n = _TW_ID_LETTERS.index(v[0]) + 10
        digits = [n // 10, n % 10] + [int(c) for c in v[1:]]
        weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1]
        if sum(d * w for d, w in zip(digits, weights)) % 10 != 0:
            return "駕駛人身分證字號檢查碼不符"
        return None
    if re.fullmatch(r"[A-Z][89]\d{8}", v) or re.fullmatch(r"[A-Z][A-D]\d{8}", v):
        return None
    return "駕駛人 ID 格式應為 1 個英文字母加 9 碼數字"
