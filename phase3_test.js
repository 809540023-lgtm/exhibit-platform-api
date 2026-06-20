// Phase③ 測試:展商寫入/只見自己、pending 不外洩、審核後才可見、QR、匯出依身份隔離。
const assert = require('assert');
const db = require('./db');
const A = require('./auth');

let base, srv;
async function http(method, path, token, body) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch {}
  return { status: r.status, text: txt, json };
}

(async () => {
  process.env.ADMIN_EMAIL = 'admin@demo.local';
  process.env.ADMIN_PASSWORD = 'AdminDemo#2026';
  const { start } = require('./server');
  srv = await start();
  base = 'http://127.0.0.1:' + srv.address().port;

  // 帳號:兩個展商(已核可)、一個採購商B(授權 p003/p004)、管理人
  await db.query(`INSERT INTO users(email,password_hash,role,status) VALUES($1,$2,'exhibitor','approved')`, ['exA@demo.local', await A.hashPassword('ExhA#2026')]);
  await db.query(`INSERT INTO users(email,password_hash,role,status) VALUES($1,$2,'exhibitor','approved')`, ['exB@demo.local', await A.hashPassword('ExhB#2026')]);
  await db.query(`INSERT INTO users(email,password_hash,role,status,client_id) VALUES($1,$2,'buyer','approved','B')`, ['b@demo.local', await A.hashPassword('BuyerB#2026')]);
  const login = async (e, p) => (await http('POST', '/api/auth/login', null, { email: e, password: p })).json.token;
  const exA = await login('exA@demo.local', 'ExhA#2026');
  const exB = await login('exB@demo.local', 'ExhB#2026');
  const buyerB = await login('b@demo.local', 'BuyerB#2026');
  const admin = await login('admin@demo.local', 'AdminDemo#2026');

  let pass = 0; const ok = m => { console.log('  ✓', m); pass++; };

  // 1) 展商A 上傳一筆商品 → pending
  let r = await http('POST', '/api/exhibitor/products', exA, { name: '展商A的新茶', story: '故事', price: '¥999', moq: '50盒', wholesale: '¥500', exportT: '可出口', oem: '可OEM' });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'pending');
  const newId = r.json.id;
  ok('展商A 上傳商品成功,狀態 pending');

  // 2) 展商A 只看得到自己的;展商B 看不到 A 的
  r = await http('GET', '/api/exhibitor/products', exA);
  assert.ok(r.text.includes('展商A的新茶'), '展商A 應看到自己商品');
  let rb = await http('GET', '/api/exhibitor/products', exB);
  assert.ok(!rb.text.includes('展商A的新茶'), '[FAIL] 展商B 看到展商A 的商品!');
  ok('展商只見自己上傳的商品(互不可見)');

  // 3) pending 商品不出現在 L1(消費者)與 L2(採購商B)
  r = await http('GET', '/api/products');           // 匿名 L1
  assert.ok(!r.text.includes('展商A的新茶'), '[FAIL] pending 商品出現在 L1');
  rb = await http('GET', '/api/buyer/products', buyerB);
  assert.ok(!rb.text.includes('展商A的新茶'), '[FAIL] pending 商品出現在 L2');
  ok('未審核(pending)商品不對消費者/採購商公開');

  // 4) 管理人看得到 pending,核可後 → 開放 L1
  r = await http('GET', '/api/admin/products', admin);
  assert.ok(r.text.includes('展商A的新茶'), '管理人應看到 pending 商品');
  r = await http('POST', `/api/admin/products/${newId}/approve`, admin, { fieldNote: { tc: '現場確認OK', sc: '', ja: '', en: '' } });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'approved');
  r = await http('GET', '/api/products');
  assert.ok(r.text.includes('展商A的新茶'), '[FAIL] 核可後商品未對消費者公開');
  ok('管理人核可後,商品才對外公開(審核流程生效)');

  // 5) 退回流程:再上傳一筆 → reject → 不公開
  r = await http('POST', '/api/exhibitor/products', exA, { name: '待退回商品', price: '¥1' });
  const rejId = r.json.id;
  r = await http('POST', `/api/admin/products/${rejId}/reject`, admin, { fieldNote: { tc: '資料不全', sc: '', ja: '', en: '' } });
  assert.equal(r.json.status, 'rejected');
  r = await http('GET', '/api/products');
  assert.ok(!r.text.includes('待退回商品'), '[FAIL] 退回商品仍公開');
  // 展商看得到退件回饋
  r = await http('GET', '/api/exhibitor/products', exA);
  assert.ok(r.text.includes('資料不全'), '展商應看到退件備註');
  ok('退回流程生效,展商可見退件回饋');

  // 6) QR:管理人可產生展商 QR(SVG)
  r = await http('GET', '/api/admin/qr/e01', admin);
  assert.equal(r.status, 200); assert.ok(r.json.svg.includes('<svg'), 'QR 應為 SVG');
  assert.ok(r.json.url.includes('role=exhibitor'), 'QR 應指向展商入口');
  ok('管理人可產生展商專屬 QR Code(SVG + 深連結)');

  // 7) 匯出:管理人 CSV 含 L3;採購商 CSV 不含 L3,且只含授權商品
  r = await http('GET', '/api/admin/export.csv', admin);
  assert.ok(r.text.includes('口頭(L3)') && r.text.includes('有意設台灣總代理'), '管理人 CSV 應含 L3');
  r = await http('GET', '/api/buyer/export.csv', buyerB);
  assert.ok(!r.text.includes('有意設台灣總代理') && !r.text.includes('口頭'), '[FAIL] 採購商 CSV 洩漏 L3');
  assert.ok(r.text.includes('鮭魚粥'), '採購商 CSV 應含其授權商品 p003');
  assert.ok(!r.text.includes('有機抹茶'), '[FAIL] 採購商 CSV 含未授權商品 p001');
  ok('匯出 CSV 依身份隔離:管理人含 L3、採購商只到 L2 且僅授權商品');

  // 8) 採購商不能打管理人匯出端點
  r = await http('GET', '/api/admin/export.csv', buyerB);
  assert.equal(r.status, 403);
  ok('採購商無法存取管理人匯出 API');

  console.log(`\nPhase③ ${pass} 項通過 ✅`);
  srv.close(); process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e.message)); if (srv) srv.close(); process.exit(1); });
