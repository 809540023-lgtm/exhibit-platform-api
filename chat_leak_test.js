// 機器人洩漏測試:確認 /api/chat 不會對非授權者吐出 L3/L4 或未授權商品。
const assert = require('assert');
const db = require('./db');
const A = require('./auth');

const L3 = ['旺季可能缺貨', '有意設台灣總代理', '¥1,050', '¥190', 'L3 內部', 'interested'];
const B2B = ['¥1,180', '¥210/份', '卸売', '批發價:¥'];

let base, srv;
async function chat(msg, token, lang) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + '/api/chat', { method: 'POST', headers: h, body: JSON.stringify({ message: msg, lang: lang || 'tc' }) });
  return (await r.json()).reply || '';
}
const absent = (txt, arr, label) => arr.forEach(m => assert.ok(!txt.includes(m), `[FAIL] ${label} 含敏感字「${m}」`));

(async () => {
  process.env.ADMIN_EMAIL = 'admin@demo.local';
  process.env.ADMIN_PASSWORD = 'AdminDemo#2026';
  const { start } = require('./server');
  srv = await start();
  base = 'http://127.0.0.1:' + srv.address().port;
  await db.query(`INSERT INTO users(email,password_hash,role,status,client_id) VALUES($1,$2,'buyer','approved','B')`, ['b@demo.local', await A.hashPassword('BuyerB#2026')]);
  const login = async (e, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
  const tokenB = await login('b@demo.local', 'BuyerB#2026');
  const tokenAdmin = await login('admin@demo.local', 'AdminDemo#2026');

  let pass = 0; const ok = m => { console.log('  ✓', m); pass++; };

  // 1) 匿名問「抹茶」「批發價」→ 不可有 B2B / L3
  let r = await chat('抹茶 批發價多少');
  absent(r, B2B, '匿名·抹茶'); absent(r, L3, '匿名·抹茶');
  ok('匿名問商務條件:無 B2B / L3 洩漏(引導登入)');

  // 2) 匿名問「我的授權商品」→ 不可列出 B2B,且提示登入
  r = await chat('我的授權商品有哪些');
  absent(r, B2B, '匿名·授權清單'); absent(r, L3, '匿名·授權清單');
  ok('匿名問授權清單:無 B2B 洩漏');

  // 3) 採購商B 問「抹茶」(未授權給B)→ 因 scopedProducts 不含 p001,應視為找不到,且無 L3
  r = await chat('抹茶的 MOQ', tokenB);
  assert.ok(!r.includes('有機抹茶') || !r.includes('¥1,180'), '[FAIL] 採購商B 看到未授權 p001 的 B2B');
  absent(r, L3, '採購商B·抹茶');
  ok('採購商B 問未授權商品:不外洩其 B2B,無 L3');

  // 4) 採購商B 問「介護食/粥」(p003 已授權)→ 應有 L2,但無 L3
  r = await chat('鮭魚粥 出口條件', tokenB);
  assert.ok(r.includes('鮭魚粥'), '[FAIL] 採購商B 看不到已授權 p003');
  absent(r, L3, '採購商B·鮭魚粥(已授權)');
  ok('採購商B 問已授權商品:給 L2,無 L3 內部備註');

  // 5) 管理人問同一商品 → 對照組:應含 L3
  r = await chat('鮭魚粥', tokenAdmin);
  assert.ok(r.includes('L3 內部') || r.includes('有意設台灣總代理'), '[FAIL] 管理人看不到 L3');
  ok('管理人問商品:可見 L3(對照組通過)');

  console.log(`\n機器人 ${pass} 項通過 ✅  問答受權限隔離保護。`);
  srv.close(); process.exit(0);
})().catch(e => { console.error('\n' + e.message); if (srv) srv.close(); process.exit(1); });
