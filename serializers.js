// ============================================================
// 序列化器 = 安全核心
// 每個函式「白名單」式組裝輸出,絕不展開整列 row。
// L3(admin_meta)與 L4(被授權客戶名單)只出現在管理人序列化器。
// 搭配 DB 查詢層的「不 SELECT 敏感欄位」做縱深防禦。
// ============================================================

// L1 公開 — 給消費者 / 匿名。只含 consumer 區塊。
function productL1(row) {
  return {
    id: row.id,
    exhibitorId: row.exhibitor_id,
    name: row.name,
    consumer: row.consumer   // image, story, feature, origin, usage, price, buy(皆多語)
  };
}

// L2 B2B — 給已授權採購商。L1 + b2b 區塊。不含 admin_meta、不含其他客戶名單。
function productL2(row) {
  return {
    id: row.id,
    exhibitorId: row.exhibitor_id,
    name: row.name,
    consumer: row.consumer,
    b2b: row.b2b             // moq, wholesale, sample, exportT, oem, adminNote, recommend, fit_tw, fit_cn, follow
  };
}

// L3 管理人 — 全部,含內部備註與被授權客戶。
function productAdmin(row, grantedClientIds) {
  return {
    id: row.id,
    exhibitorId: row.exhibitor_id,
    name: row.name,
    consumer: row.consumer,
    b2b: row.b2b,
    reviewed: row.reviewed,
    open_l1: row.open_l1,
    open_l2: row.open_l2,
    admin: row.admin_meta,                 // verbal, attitude, risk, interested_buyers
    grantedTo: grantedClientIds || []      // L4:被開放的客戶清單
  };
}

function user(row) {
  return {
    id: row.id, email: row.email, role: row.role, status: row.status,
    client_id: row.client_id, display_name: row.display_name, lang: row.lang,
    created_at: row.created_at
  };
}

module.exports = { productL1, productL2, productAdmin, user };
