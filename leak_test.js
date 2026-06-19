// ============================================================
// 自動化洩漏測試 ≈ DevTools 實測
// 啟動真實 server(pg-mem),用各角色 token 打 API,
// 掃描回應內容,斷言 L3/L4 敏感字串完全不出現在不該看到的角色回應中。
// ============================================================
const assert = require('assert');
const db = require('./db');
const A = require('./auth');

// L3 內部專屬字串(只該出現在管理人回應)
const L3_MARKERS = [
  '旺季可能缺貨',        // p001 risk
  '有意設台灣總代理',     // p003 attitude
  '¥1,050',             // p001 verbal quote
  '¥190',               // p003 verbal quote
  'interested',         // admin_meta 的鍵
  '需確認進口食品法規'    // p003 risk
];
// L2 B2B 字串(不該出現在消費者/匿名回應)
const B2B_MARKERS = ['¥1,180', '¥210/份', 'MOQ 500罐', '批發', 'wholesale', '卸売'];

let base, srv;
async function http(method, pathname, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, text, json };
}
function assertAbsent(haystack, markers, label) {
  for (const m of markers) {
    assert.ok(!haystack.includes(m), `[FAIL] ${label} 不該包含敏感字串「${m}」,但出現了!`);
  }
}
function assertPresent(haystack, marker, label) {
  assert.ok(haystack.includes(marker), `[FAIL] ${label} 應包含「${marker}」但沒有`);
}

(async () => {
  process.env.ADMIN_EMAIL = 'admin@demo.local';
  process.env.ADMIN_PASSWORD = 'AdminDemo#2026';
  const { start } = require('./server');
  srv = await start();
  base = 'http://127.0.0.1:' + srv.address().port;

  // 建立測試帳號:採購商 B(client B,授權 p003/p004)、採購商 A(client A)
  await db.query(`INSERT INTO users(email,password_hash,role,status,client_id,display_name)
    VALUES($1,$2,'buyer','approved','B','Buyer B')`, ['buyerB@demo.local', await A.hashPassword('BuyerB#2026')]);
  await db.query(`INSERT INTO users(email,password_hash,role,status,client_id,display_name)
    VALUES($1,$2,'buyer','approved','A','Buyer A')`, ['buyerA@demo.local', await A.hashPassword('BuyerA#2026')]);
  // 待審核採購商(不該能登入)
  await db.query(`INSERT INTO users(email,password_hash,role,status,client_id)
    VALUES($1,$2,'buyer','pending','B')`, ['pending@demo.local', await A.hashPassword('Pending#2026')]);

  let pass = 0;
  const ok = (m) => { console.log('  ✓', m); pass++; };

  // 1) 匿名消費者:/api/products 不得含任何 B2B / L3 字串
  {
    const r = await http('GET', '/api/products');
    assert.equal(r.status, 200);
    assertAbsent(r.text, B2B_MARKERS, '消費者 /api/products');
    assertAbsent(r.text, L3_MARKERS, '消費者 /api/products');
    assertPresent(r.text, '有機抹茶', '消費者 /api/products');  // L1 內容仍在
    ok('匿名消費者只拿到 L1,無 B2B / L3 洩漏');
  }

  // 2) 待審核帳號不能登入
  {
    const r = await http('POST', '/api/auth/login', null, { email: 'pending@demo.local', password: 'Pending#2026' });
    assert.equal(r.status, 403); assert.equal(r.json.error, 'account_not_approved');
    ok('待審核帳號被拒絕登入');
  }

  // 3) 採購商 B 登入 → /api/buyer/products:有 p003/p004(L2),無 L3,且無未授權商品
  let tokenB;
  {
    const lr = await http('POST', '/api/auth/login', null, { email: 'buyerB@demo.local', password: 'BuyerB#2026' });
    assert.equal(lr.status, 200); tokenB = lr.json.token;
    const r = await http('GET', '/api/buyer/products', tokenB);
    assert.equal(r.status, 200);
    assertPresent(r.text, '鮭魚粥', '採購商B');               // p003 已授權,L2 可見
    assertPresent(r.text, '¥210/份', '採購商B');             // p003 批發價(L2)可見
    assertAbsent(r.text, L3_MARKERS, '採購商B /api/buyer/products');  // L3 不可見
    assert.ok(!r.text.includes('有機抹茶'), '[FAIL] 採購商B 看到未授權商品 p001!'); // L4:p001 未授權給B
    ok('採購商B 只見授權商品的 L2,無 L3、無未授權商品(L4 生效)');
  }

  // 4) 採購商 B 不能打管理人端點
  {
    const r = await http('GET', '/api/admin/products', tokenB);
    assert.equal(r.status, 403);
    ok('採購商B 無法存取管理人 API');
  }

  // 5) 無 token 不能打 buyer / admin 端點
  {
    const r1 = await http('GET', '/api/buyer/products');
    const r2 = await http('GET', '/api/admin/products');
    assert.equal(r1.status, 401); assert.equal(r2.status, 401);
    ok('未登入無法存取 buyer / admin API');
  }

  // 6) 管理人登入 → 確實看得到 L3(對照組,證明資料存在但被正確隔離)
  {
    const lr = await http('POST', '/api/auth/login', null, { email: 'admin@demo.local', password: 'AdminDemo#2026' });
    assert.equal(lr.status, 200);
    const r = await http('GET', '/api/admin/products', lr.json.token);
    assert.equal(r.status, 200);
    assertPresent(r.text, '有意設台灣總代理', '管理人');  // L3 對管理人可見
    assertPresent(r.text, 'grantedTo', '管理人');         // L4 名單對管理人可見
    ok('管理人可見 L3 內部備註與 L4 授權名單(對照組通過)');
  }

  console.log(`\n全部 ${pass} 項通過 ✅  伺服器端權限隔離有效。`);
  srv.close();
  process.exit(0);
})().catch(e => { console.error('\n' + e.message); if (srv) srv.close(); process.exit(1); });
