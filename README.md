# 展覽平台後端 — Phase ②(權限模型 + 後端欄位過濾 + 登入)

把展場資料的分級可見性從「前端條件渲染」升級為**後端強制隔離**。

## 安全模型(雙層縱深防禦)
1. **查詢層**:非管理人的 API 查詢**根本不 SELECT** 敏感欄位
   - `/api/products`(消費者/匿名)只 `SELECT consumer`;`b2b`、`admin_meta` 不離開資料庫。
   - `/api/buyer/products`(採購商)`SELECT consumer,b2b`,且 `JOIN grants` 只回該客戶被授權(L4)且 `open_l2` 的商品;`admin_meta` 不離開資料庫。
2. **序列化層**(`serializers.js`):白名單式組裝輸出,絕不展開整列 row。L3/L4 只出現在管理人序列化器。

→ 結果:消費者/採購商在瀏覽器 DevTools/Network 看不到任何報價、內部備註或客戶名單。`leak_test.js` 自動驗證(6 項全過)。

## 角色與資料層級
- L1 公開(消費者/匿名) · L2 B2B(採購商,需登入+核可+被授權) · L3 內部(僅管理人) · L4 指定客戶(grants 表)
- 帳號流程:採購商/展商**自助註冊 → pending → 管理人核可/退回 → 方可登入**。管理人不可自助註冊(由 seed 環境變數建立)。

## 部署(Render Web Service + Postgres)
1. 建 Render **PostgreSQL** 實例,取得 Internal Database URL。
2. 建 Render **Web Service**,連到本 repo:
   - Build Command:`npm install`
   - Start Command:`npm start`
3. 環境變數(Environment):
   | 變數 | 說明 |
   |------|------|
   | `DATABASE_URL` | Render Postgres 連線字串(可用 Add from Database 自動帶入) |
   | `JWT_SECRET` | 隨機長字串(權杖簽章用) |
   | `ADMIN_EMAIL` | 初始管理人信箱 |
   | `ADMIN_PASSWORD` | 初始管理人密碼(**由您自行輸入,我不經手**) |
   | `PGSSL` | 若連線報 SSL 錯誤可設 `disable` |
4. 首次啟動會自動建表(migrate)+ 灌入範例資料(seed)+ 建立管理人帳號。

## 本地測試
```
npm install
npm test     # 跑 leak_test.js(用 pg-mem,不需真 Postgres)
```

## 待接(後續 Phase)
- 郵件寄送(註冊/核可通知)— 接 Resend/SendGrid API key。
- 展商上傳 + 審核寫入流程(Phase ③)。
- 設計系統化(Phase ①)、i18n 全語系在地化(Phase ④,目前 UI 已四語、商品資料庫四語)。
