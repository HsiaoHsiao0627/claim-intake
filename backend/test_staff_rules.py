# -*- coding: utf-8 -*-
"""staff_rules.py 的單元測試：python -m pytest test_staff_rules.py"""
import staff_rules as r


def test_classify_priority():
    assert r.classify_handling(["全載拖吊", "已-車主其他原因取消"]) == "道路救援空趟"
    assert r.classify_handling(["平面拖吊", "特殊作業", "地下室B2作業"]) == "特殊作業"
    assert r.classify_handling(["國道第二類現場處理"]) == "特殊作業"
    assert r.classify_handling(["接電排空", "全載拖吊"]) == "拖吊"
    assert r.classify_handling(["國道強排"]) == "拖吊"
    assert r.classify_handling(["換備胎", "打氣二輪"]) == "急修"
    assert r.classify_handling(["載重費"]) is None
    assert r.classify_handling(["自行輸入的情形"]) is None
    assert r.classify_handling([]) is None


def test_normalize_handling():
    assert r.normalize_handling([" 全載拖吊 ", None, "", "全載拖吊", "特殊作業", "載重費", "多的"]) == ["全載拖吊", "特殊作業", "載重費"]


def test_parse_project_name():
    assert r.parse_project_name("自費購道援險(30,000元,60K,3次)") == {"limit_amount": 30000, "km_limit": 60, "use_limit": 3}
    assert r.parse_project_name("自費購道援險(50,000元,不限K次)") == {"limit_amount": 50000, "km_limit": "不限", "use_limit": "不限"}
    assert r.parse_project_name("福斯保代自費購道援險(30,000元)") == {"limit_amount": 30000, "km_limit": None, "use_limit": None}
    assert r.parse_project_name(None) == {"limit_amount": None, "km_limit": None, "use_limit": None}


def test_driver_id():
    assert r.check_driver_id("A123456789") is None
    assert r.check_driver_id("a123456789") is None
    assert r.check_driver_id("A800000014") is None      # 新式居留證只驗格式
    assert r.check_driver_id("AC01234567") is None      # 舊式居留證只驗格式
    assert "檢查碼" in r.check_driver_id("A123456788")
    assert "格式" in r.check_driver_id("12345")
    assert r.check_driver_id("") is None


def test_handling_to_rule_agent_fields():
    f = r.handling_to_rule_agent_fields
    assert f(["全載拖吊"]) == {"requested_service": "TOWING", "special_operation_required": False}
    assert f(["接電"]) == {"requested_service": "BATTERY_JUMP_START", "special_operation_required": False}
    assert f(["接電排空", "平面拖吊"]) == {"requested_service": "TOWING", "special_operation_required": False}
    assert f(["平面拖吊", "地下室B2作業", "特殊作業"]) == {"requested_service": "TOWING", "special_operation_required": True}
    assert f(["換備胎", "打氣二輪"]) == {"requested_service": "TIRE_CHANGE", "special_operation_required": False}
    assert f(["自行輸入的情形"]) == {"requested_service": None, "special_operation_required": None}


def test_assumed_facts_cover_rule_agent_gaps():
    assert set(r.STAFF_RSA_ASSUMED_FACTS) == {
        "vehicle_use", "contacted_designated_center", "claims_bridge_or_toll_fees",
        "vehicle_loaded_and_unwilling_to_unload", "claims_passenger_or_cargo_transport_cost"}
