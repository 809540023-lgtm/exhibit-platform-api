// 免登入展場上傳測試:token 必需、送出即公開、無 L3 洩漏、下架生效、上傳 token 不能讀資料。
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
  const adminTok = (await http('POST', '/api/auth/login', null, { email: 'admin@demo.local', password: 'AdminDemo#2026' })).json.token;

  let pass = 0; const ok = m => { console.log('  ✓', m); pass++; };

  // 1) 無 token → 401
  let r = await http('POST', '/api/upload', null, { company: '駭客', name: '垃圾' });
  assert.equal(r.status, 401);
  ok('無 token 的上傳被拒(防止隨機灌入)');

  // 2) 管理人取得展場上傳 QR(含 token)
  r = await http('GET', '/api/admin/upload-qr', adminTok);
  assert.equal(r.status, 200); assert.ok(r.json.svg.includes('<svg') && r.json.token, '應回 SVG + token');
  assert.ok(r.json.url.includes('?upload='), 'URL 應為免登入上傳深連結');
  const upTok = r.json.token;
  ok('管理人可產生展場上傳 QR(token + SVG)');

  // 3) 持 token 免登入上傳 → 200,且送出即公開(出現在 L1)
  r = await http('POST', '/api/upload', null, { token: upTok, company: '京都豆菓子本舖', name: '黑豆煎餅', price: '¥680', story: '百年老舖', moq: '100', wholesale: '¥320' });
  assert.equal(r.status, 200); assert.ok(r.json.id, '應回新商品 id');
  const pid = r.json.id;
  let l1 = await http('GET', '/api/products');
  assert.ok(l1.text.includes('黑豆煎餅'), '[FAIL] 送出後未立即公開於 L1');
  ok('免登入上傳成功,且「送出即公開」立即出現在消費者端');

  // 4) 即使是公開商品,L1 仍不外洩 B2B / L3(批發/MOQ 不在 consumer 端)
  assert.ok(!l1.text.includes('¥320') && !l1.text.includes('"moq"') && !l1.text.includes('wholesale'), '[FAIL] L1 洩漏 B2B 欄位');
  ok('公開商品在 L1 仍只給 consumer 欄位,無批發/MOQ/L3 洩漏');

  // 5) 上傳 token 不是使用者 token,不能讀任何後台資料
  r = await http('GET', '/api/admin/products', upTok);
  assert.ok([401, 403].includes(r.status) && !r.text.includes('admin_meta') && !r.text.includes('有意設台灣總代理'), '[FAIL] 上傳 token 讀到 admin 資料');
  r = await http('GET', '/api/buyer/products', upTok);
  assert.ok([401, 403].includes(r.status), '[FAIL] 上傳 token 讀到 buyer 資料');
  ok('上傳 token 只能上傳,無法讀取 admin / buyer 資料(被拒)');

  // 6) 管理人下架 → 不再出現在 L1
  r = await http('POST', `/api/admin/products/${pid}/takedown`, adminTok, {});
  assert.equal(r.json.status, 'removed');
  l1 = await http('GET', '/api/products');
  assert.ok(!l1.text.includes('黑豆煎餅'), '[FAIL] 下架後仍公開');
  ok('管理人下架生效,商品自消費者端移除');

  // 7) 同公司再次上傳 → 不重複建立展商(沿用同一 exhibitor)
  const before = (await db.query(`SELECT COUNT(*)::int n FROM exhibitors WHERE name->>'tc'=$1`, ['京都豆菓子本舖'])).rows[0].n;
  await http('POST', '/api/upload', null, { token: upTok, company: '京都豆菓子本舖', name: '抹茶煎餅', price: '¥720' });
  const after = (await db.query(`SELECT COUNT(*)::int n FROM exhibitors WHERE name->>'tc'=$1`, ['京都豆菓子本舖'])).rows[0].n;
  assert.equal(before, after, '[FAIL] 同公司重複建立展商');
  ok('同公司多次上傳沿用同一展商,不重複建檔');

  console.log(`\n免登入上傳 ${pass} 項通過 ✅`);
  srv.close(); process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e.message)); if (srv) srv.close(); process.exit(1); });
