# -*- coding: utf-8 -*-
"""
store.py — 案件狀態儲存

設計原則：這是整個系統唯一的「案件現在走到哪一步」的真相來源。無論呼叫端是
網頁前端還是未來的 LINE webhook，都是對同一張表讀寫，狀態機邏輯完全與管道無關。

狀態機（單向前進，不回頭）：
  received            → 已受理，尚未開始處理
  ocr_processing       → 正在辨識上傳文件
  ocr_done             → OCR 完成（可能部分欄位辨識失敗，不代表整體失敗）
  pipeline_processing  → 正在呼叫規則/理賠/法官代理人
  completed            → 處理完成，可放行或已標記轉人工
  escalated_human      → 法官代理人判定需轉人工複核
  error                → 處理過程中發生無法復原的錯誤（誠實呈現，不要吞掉）

review_status（後台人員複核狀態，與上面的處理狀態機分開、互不影響）：
  not_reviewed  → 尚未有人看過（預設值）
  reviewing     → 後台人員正在看
  reviewed      → 已完成人工複核

============================================================
資料庫後端（SEAM：正式環境用 Cloud SQL，本機沒設定連線資訊時退回 SQLite）
============================================================
正式部署一定要設定 DB_INSTANCE_CONNECTION_NAME / DB_USER / DB_PASS / DB_NAME
這幾個環境變數（密碼走 Secret Manager，不要寫死），系統就會走 Cloud SQL
(PostgreSQL)。沒有設定時，退回本機 data/claims.db（SQLite），純粹方便沒有
GCP 連線或本機開發時也能跑起來 —— 這條退回邏輯呼應 seams.py 對協調層的
「打不通就明確標記、不偽裝成功」精神，不是拿來在正式環境用的。

⚠️ 正式環境絕對不要誤用 SQLite 分支：Cloud Run 容器重啟/縮到零、多實例之間
都不共享本地磁碟資料，這在 README 已經標註過。
"""
import csv
import io
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
DB_PATH = os.environ.get("SQLITE_DB_PATH", "data/claims.db")

# --- Cloud SQL 連線設定（都沒設定時視為「開發模式」，退回 SQLite） ---
DB_INSTANCE_CONNECTION_NAME = os.environ.get("DB_INSTANCE_CONNECTION_NAME")  # 例: project:region:instance
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME", "claims")
DB_IP_TYPE = os.environ.get("DB_IP_TYPE", "PUBLIC")  # PUBLIC | PRIVATE，依 Cloud Run 網路設定調整

USE_CLOUD_SQL = bool(DB_INSTANCE_CONNECTION_NAME and DB_USER and DB_PASS)

if not USE_CLOUD_SQL:
    print(
        "[開發模式] 未設定 DB_INSTANCE_CONNECTION_NAME/DB_USER/DB_PASS，"
        "改用本機 SQLite（data/claims.db）。正式環境部署前務必設定這些環境變數，"
        "改走 Cloud SQL，否則狀態不會在多實例/重啟之間保留。"
    )

_cloud_sql_connector = None  # 延遲初始化，避免開發模式時也載入 google-cloud-sql-connector


def _get_cloud_sql_connector():
    global _cloud_sql_connector
    if _cloud_sql_connector is None:
        from google.cloud.sql.connector import Connector
        _cloud_sql_connector = Connector()
    return _cloud_sql_connector


def _raw_pg_conn():
    from google.cloud.sql.connector import IPTypes
    ip_type = IPTypes.PRIVATE if DB_IP_TYPE.upper() == "PRIVATE" else IPTypes.PUBLIC
    connector = _get_cloud_sql_connector()
    return connector.connect(
        DB_INSTANCE_CONNECTION_NAME,
        "pg8000",
        user=DB_USER,
        password=DB_PASS,
        db=DB_NAME,
        ip_type=ip_type,
    )


# 統一用 '?' 當 SQL 佔位符寫查詢；Postgres(pg8000) 走 '%s'，這裡做轉換，
# 避免整份檔案要維護兩套查詢字串。查詢內容(JSON字串等)不會出現孤立的 '?'
# 字元在 SQL 語法位置上，所以這個轉換是安全的。
def _ph(sql: str) -> str:
    if USE_CLOUD_SQL:
        return sql.replace("?", "%s")
    return sql


SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS claims (
    case_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'web',
    status TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'not_reviewed',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    contact_email TEXT,
    contact_phone TEXT,
    policy_no TEXT,
    applicant_name TEXT,
    insurance_type TEXT,
    claim_amount REAL,
    incident_date TEXT,
    submitted_fields TEXT NOT NULL,
    ocr_result TEXT,
    ocr_filled_fields TEXT,
    file_paths TEXT NOT NULL,
    pipeline_result TEXT,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_review_status ON claims(review_status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_claims_channel ON claims(channel);
"""

SCHEMA_POSTGRES = """
CREATE TABLE IF NOT EXISTS claims (
    case_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'web',
    status TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'not_reviewed',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    contact_email TEXT,
    contact_phone TEXT,
    policy_no TEXT,
    applicant_name TEXT,
    insurance_type TEXT,
    claim_amount DOUBLE PRECISION,
    incident_date TEXT,
    submitted_fields TEXT NOT NULL,
    ocr_result TEXT,
    file_paths TEXT NOT NULL,
    pipeline_result TEXT,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_review_status ON claims(review_status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_claims_channel ON claims(channel);
"""


# 表已存在時（正式環境常見情況）要用 ALTER TABLE 補欄位，CREATE TABLE IF NOT
# EXISTS 不會幫既有表加新欄位。格式：(欄位名, SQLite型別, Postgres型別)。
_MIGRATION_COLUMNS = [
    ("ocr_filled_fields", "TEXT", "TEXT"),
]


def _ensure_columns(con):
    if USE_CLOUD_SQL:
        for col, _sqlite_type, pg_type in _MIGRATION_COLUMNS:
            cur = con.cursor()
            cur.execute(f"ALTER TABLE claims ADD COLUMN IF NOT EXISTS {col} {pg_type}")
    else:
        existing = {row[1] for row in con.execute("PRAGMA table_info(claims)").fetchall()}
        for col, sqlite_type, _pg_type in _MIGRATION_COLUMNS:
            if col not in existing:
                con.execute(f"ALTER TABLE claims ADD COLUMN {col} {sqlite_type}")


def init_db():
    if USE_CLOUD_SQL:
        with _conn() as con:
            cur = con.cursor()
            for stmt in [s for s in SCHEMA_POSTGRES.split(";") if s.strip()]:
                cur.execute(stmt)
            _ensure_columns(con)
    else:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        with _conn() as con:
            con.executescript(SCHEMA_SQLITE)
            _ensure_columns(con)


@contextmanager
def _conn():
    if USE_CLOUD_SQL:
        con = _raw_pg_conn()
        try:
            yield con
            con.commit()
        finally:
            con.close()
    else:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        finally:
            con.close()


def _execute(con, sql, params=()):
    """統一的游標執行小工具：SQLite 用 con.execute()，pg8000 走 con.cursor()。"""
    if USE_CLOUD_SQL:
        cur = con.cursor()
        cur.execute(_ph(sql), params)
        return cur
    return con.execute(sql, params)


def _rows_as_dicts(cur, columns=None):
    """把 pg8000 cursor 或 sqlite3 cursor 的結果統一轉成 list[dict]。"""
    if USE_CLOUD_SQL:
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    return [dict(row) for row in cur.fetchall()]


# ============================================================
# 案件建立 / 狀態更新 / 單筆查詢（原有介面，行為不變）
# ============================================================
def create_claim(submitted_fields: dict, file_paths: list, channel: str = "web") -> str:
    case_id = f"CLM-{uuid.uuid4().hex[:10].upper()}"
    now = datetime.now(TZ).isoformat(timespec="seconds")
    with _conn() as con:
        _execute(
            con,
            "INSERT INTO claims (case_id, channel, status, created_at, updated_at, "
            "contact_email, contact_phone, policy_no, applicant_name, insurance_type, "
            "claim_amount, incident_date, submitted_fields, file_paths) "
            "VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                case_id, channel, now, now,
                submitted_fields.get("contact_email"), submitted_fields.get("contact_phone"),
                submitted_fields.get("policy_no"), submitted_fields.get("applicant_name"),
                submitted_fields.get("insurance_type"), submitted_fields.get("claim_amount"),
                submitted_fields.get("incident_date"),
                json.dumps(submitted_fields, ensure_ascii=False), json.dumps(file_paths),
            ),
        )
    return case_id


def update_status(case_id: str, status: str, **fields):
    """更新狀態與任意附加欄位(ocr_result/pipeline_result/error_message，皆傳 JSON 字串或 None)。"""
    now = datetime.now(TZ).isoformat(timespec="seconds")
    sets = ["status = ?", "updated_at = ?"]
    params = [status, now]
    for k, v in fields.items():
        sets.append(f"{k} = ?")
        params.append(v)
    params.append(case_id)
    with _conn() as con:
        _execute(con, f"UPDATE claims SET {', '.join(sets)} WHERE case_id = ?", params)


def get_claim(case_id: str) -> dict | None:
    with _conn() as con:
        cur = _execute(con, "SELECT * FROM claims WHERE case_id = ?", (case_id,))
        rows = _rows_as_dicts(cur)
    if not rows:
        return None
    d = rows[0]
    for k in ("submitted_fields", "ocr_result", "file_paths", "pipeline_result", "ocr_filled_fields"):
        if d.get(k):
            d[k] = json.loads(d[k])
    return d


def apply_ocr_autofill(case_id: str, updates: dict, filled_field_names: list):
    """把 OCR 找到、但保戶表單留空的欄位補進去。

    updates 只包含真的要改的欄位（例如 {"policy_no": "...", "claim_amount": 1234}），
    filled_field_names 會存進 ocr_filled_fields，讓後台清楚知道哪些欄位是 OCR
    自動帶入、不是保戶手填的——呼應「不確定資料寧可標記不要靜默修正」的原則，
    不能讓後台或下游流程誤以為這是保戶自己填寫的資料。
    """
    if not updates:
        return
    claim = get_claim(case_id)
    if claim is None:
        return
    submitted = claim.get("submitted_fields") or {}
    submitted.update(updates)

    now = datetime.now(TZ).isoformat(timespec="seconds")
    sets = ["updated_at = ?", "submitted_fields = ?", "ocr_filled_fields = ?"]
    params = [now, json.dumps(submitted, ensure_ascii=False), json.dumps(filled_field_names, ensure_ascii=False)]
    for col in ("policy_no", "applicant_name", "insurance_type", "claim_amount", "incident_date"):
        if col in updates:
            sets.append(f"{col} = ?")
            params.append(updates[col])
    params.append(case_id)
    with _conn() as con:
        _execute(con, f"UPDATE claims SET {', '.join(sets)} WHERE case_id = ?", params)


# ============================================================
# 後台總覽用：清單查詢（篩選＋分頁）／標記複核／CSV 匯出
# ============================================================
_ALLOWED_FILTER_COLUMNS = {"status", "channel", "insurance_type", "review_status"}


def _build_filter_clause(filters: dict):
    clauses = []
    params = []
    for col in _ALLOWED_FILTER_COLUMNS:
        val = filters.get(col)
        if val:
            clauses.append(f"{col} = ?")
            params.append(val)
    q = filters.get("q")
    if q:
        like = f"%{q}%"
        clauses.append("(case_id LIKE ? OR policy_no LIKE ? OR applicant_name LIKE ?)")
        params.extend([like, like, like])
    date_from = filters.get("date_from")
    if date_from:
        clauses.append("created_at >= ?")
        params.append(date_from)
    date_to = filters.get("date_to")
    if date_to:
        clauses.append("created_at <= ?")
        params.append(date_to + "T23:59:59+08:00")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


LIST_COLUMNS = (
    "case_id, channel, status, review_status, reviewed_by, reviewed_at, "
    "created_at, updated_at, contact_email, contact_phone, policy_no, "
    "applicant_name, insurance_type, claim_amount, incident_date, error_message"
)


def list_claims(filters: dict, limit: int = 50, offset: int = 0):
    """回傳 (rows, total)。rows 只含清單用的欄位（不含大型 JSON 欄位），
    detail 頁再用 get_claim() 撈完整內容，避免總覽頁一次載入過多資料。"""
    where, params = _build_filter_clause(filters)
    with _conn() as con:
        count_cur = _execute(con, f"SELECT COUNT(*) AS n FROM claims {where}", params)
        total = _rows_as_dicts(count_cur)[0]["n"]

        list_sql = (
            f"SELECT {LIST_COLUMNS} FROM claims {where} "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        rows_cur = _execute(con, list_sql, [*params, limit, offset])
        rows = _rows_as_dicts(rows_cur)
    return rows, total


def set_review(case_id: str, review_status: str, reviewed_by: str | None = None,
                review_note: str | None = None) -> bool:
    """標記後台複核狀態。回傳 False 代表查無此案件。"""
    if review_status not in ("not_reviewed", "reviewing", "reviewed"):
        raise ValueError(f"不合法的 review_status: {review_status}")
    now = datetime.now(TZ).isoformat(timespec="seconds")
    with _conn() as con:
        cur = _execute(
            con,
            "UPDATE claims SET review_status = ?, reviewed_by = ?, reviewed_at = ?, "
            "review_note = ? WHERE case_id = ?",
            (review_status, reviewed_by, now, review_note, case_id),
        )
        # sqlite3 cursor 有 rowcount；pg8000 cursor 也有 rowcount
        return cur.rowcount > 0


def export_claims_csv(filters: dict) -> str:
    """依篩選條件匯出全部符合的案件（不分頁），回傳 CSV 字串。"""
    where, params = _build_filter_clause(filters)
    with _conn() as con:
        cur = _execute(
            con,
            f"SELECT {LIST_COLUMNS} FROM claims {where} ORDER BY created_at DESC",
            params,
        )
        rows = _rows_as_dicts(cur)

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，Excel 開啟中文才不會亂碼
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    else:
        writer = csv.DictWriter(buf, fieldnames=LIST_COLUMNS.replace(" ", "").split(","))
        writer.writeheader()
    return buf.getvalue()
