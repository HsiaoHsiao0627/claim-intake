# -*- coding: utf-8 -*-
"""
test_description_parser.py
=============================
單獨測試 DescriptionParser 的解析品質，不用跑完整套 claim-intake 流程。

執行：
  python test_description_parser.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seams

# 你那筆 CLM-3C23880E1F 案件的原始 description
TEST_CASES = [
    {
        "name": "CLM-3C23880E1F 原始案例",
        "description": "自用小客車在國道一號故障,已聯絡指定道路救援中心,申請拖吊服務至就近原廠,里程約58公里",
        "expect": {
            "vehicle_use": "自用",
            "requested_service": "TOWING",
            "location": "國道一號",
            "road_type": "國道",
            "contacted_designated_center": True,
        },
    },
    {
        "name": "沒提到的欄位應該是null，不能亂猜",
        "description": "電瓶沒電了，麻煩派人來救援",
        "expect": {
            "vehicle_use": None,          # 沒提到自用還是營業用
            "requested_service": "BATTERY_JUMP",
            "location": None,             # 沒提到地點
            "road_type": None,            # 沒提到道路類型
            "contacted_designated_center": None,  # 沒提到有沒有聯絡指定中心
        },
    },
    {
        "name": "空字串應該直接回樁，不呼叫API",
        "description": "",
        "expect": None,  # 只檢查不會噴錯，不比對內容
    },
]


async def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("❌ 未設定 GEMINI_API_KEY，會用 StubDescriptionParser 測試(全部欄位皆為null，"
              "不是真的在測解析品質，先設定金鑰再跑一次才有意義)")
    parser = seams.get_description_parser()
    print(f"使用的實作: {type(parser).__name__}\n")

    for case in TEST_CASES:
        print(f"=== {case['name']} ===")
        print(f"description: {case['description']!r}")
        result = await parser.parse(case["description"])
        print(json.dumps(result, ensure_ascii=False, indent=2))

        expect = case.get("expect")
        if expect:
            fields = result.get("fields", {})
            mismatches = []
            for key, expected_value in expect.items():
                actual = fields.get(key)
                if actual != expected_value:
                    mismatches.append(f"  {key}: 預期={expected_value!r}, 實際={actual!r}")
            if mismatches:
                print("⚠️ 與預期不符:")
                print("\n".join(mismatches))
            else:
                print("✅ 全部欄位符合預期")
        print()


if __name__ == "__main__":
    asyncio.run(main())
