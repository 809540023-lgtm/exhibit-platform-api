// ============================================================
// 機器人問答引擎(意圖式,權限隔離)
// 關鍵:資料一律走「依身份的範圍查詢」,與 API 端點相同 ——
//   匿名/消費者 → 只讀 L1(consumer);
//   採購商(approved)→ 只讀其被授權(grants)的 L2(consumer+b2b),不含 admin_meta;
//   管理人 → 全部(含 L3 admin_meta)。
// 因此機器人在結構上不可能對非授權者吐出 L3/L4。
// ============================================================
const db = require('./db');

// ---- 小型多語措辭 ----
function P(tc, sc, ja, en) { return { tc, sc, ja, en }; }
const pick = (o, lang) => (o && o[lang] !== undefined ? o[lang] : (o && o.tc) || '');
const SAY = {
  hello: P(
    '您好!我是展會資料助理。你可以問我:展會資訊、你被授權的商品、某商品的 MOQ/批發價/出口/OEM、報名審核流程,或展商上傳方式。',
    '您好!我是展会资料助理。你可以问我:展会信息、你被授权的商品、某商品的 MOQ/批发价/出口/OEM、报名审核流程,或展商上传方式。',
    'こんにちは。展示会データアシスタントです。展示会情報、許可された商品、商品のMOQ・卸価格・輸出・OEM、登録審査の流れ、出展者の登録方法などをお尋ねください。',
    "Hi! I'm the expo data assistant. Ask me about the expo, your authorized products, a product's MOQ / wholesale / export / OEM, the approval process, or how exhibitors upload."),
  needLogin: P(
    '這部分屬於 B2B 採購資料,請先以採購商帳號登入(需管理人核可)。未登入只能查看公開的商品展示。',
    '这部分属于 B2B 采购资料,请先以采购商账号登录(需管理人核可)。未登录只能查看公开的商品展示。',
    'これはB2B調達情報です。バイヤーアカウントでログインしてください(管理者の承認が必要)。未ログインでは公開商品のみご覧いただけます。',
    'This is B2B sourcing data — please log in as a buyer (admin approval required). Without login you can only see public product info.'),
  noneAuthorized: P(
    '目前沒有開放給你的授權商品。請聯繫管理人開通(L4 授權)。',
    '目前没有开放给你的授权商品。请联系管理人开通(L4 授权)。',
    '現在あなたに許可された商品はありません。管理者に開放(L4許可)をご依頼ください。',
    'No products are authorized to you yet. Please ask the admin to grant access (L4).'),
  yourProducts: P('你目前被授權的商品:', '你目前被授权的商品:', '許可されている商品:', 'Your authorized products:'),
  publicProducts: P('公開展示的商品:', '公开展示的商品:', '公開商品:', 'Public products:'),
  notFound: P(
    '我沒找到對應的商品。試試輸入商品關鍵字,例如「抹茶」「介護食」「仙貝」,或問「我的商品」。',
    '我没找到对应的商品。试试输入商品关键字,例如「抹茶」「介护食」「仙贝」,或问「我的商品」。',
    '該当する商品が見つかりません。「抹茶」「介護食」「せんべい」などのキーワードや「私の商品」とお尋ねください。',
    "I couldn't find that product. Try a keyword like \"matcha\", \"care food\", \"senbei\", or ask \"my products\"."),
  process: P(
    '報名/帳號流程:① 在對應入口自助註冊(採購商或展商)→ ② 狀態為「待審核」→ ③ 管理人核可後 → ④ 即可登入。採購商登入後只看得到被授權(L4)的商品。',
    '报名/账号流程:① 在对应入口自助注册(采购商或展商)→ ② 状态为「待审核」→ ③ 管理人核可后 → ④ 即可登录。采购商登录后只看得到被授权(L4)的商品。',
    '登録/アカウントの流れ:① 各入口で登録(バイヤーまたは出展者)→ ② 「審査待ち」→ ③ 管理者承認 → ④ ログイン可能。バイヤーは許可(L4)された商品のみ閲覧できます。',
    'Account flow: ① Self-register at your portal (buyer or exhibitor) → ② status "pending" → ③ admin approves → ④ you can log in. Buyers only see products granted to them (L4).'),
  exhibitorHelp: P(
    '展商上傳:登入展商帳號後,可登錄公司基本資料與商品資料(品類、規格、MOQ、批發價、出口/OEM 條件、型錄、照片、影片),送出後進入「待審核」,由管理人審核並補充現場資訊。',
    '展商上传:登录展商账号后,可登录公司基本资料与商品资料(品类、规格、MOQ、批发价、出口/OEM 条件、样册、照片、视频),送出后进入「待审核」,由管理人审核并补充现场信息。',
    '出展者の登録:出展者アカウントでログイン後、会社情報と商品情報(カテゴリ、仕様、MOQ、卸価格、輸出/OEM条件、カタログ、写真、動画)を登録できます。提出後は「審査待ち」となり、管理者が審査・現場情報を補足します。',
    'Exhibitor upload: after logging in as an exhibitor, register company and product data (category, specs, MOQ, wholesale, export/OEM terms, catalog, photos, video). On submit it becomes "pending" for admin review.'),
  fallback: P(
    '我可以幫你查:展會資訊、你的授權商品、商品的 MOQ/批發/出口/OEM、報名審核流程、展商上傳方式。請換個說法或輸入商品關鍵字。',
    '我可以帮你查:展会信息、你的授权商品、商品的 MOQ/批发/出口/OEM、报名审核流程、展商上传方式。请换个说法或输入商品关键字。',
    '展示会情報、許可商品、商品のMOQ/卸/輸出/OEM、登録審査の流れ、出展者の登録方法をご案内できます。言い換えるか商品キーワードをご入力ください。',
    'I can help with: expo info, your authorized products, a product\'s MOQ/wholesale/export/OEM, the approval process, exhibitor upload. Try rephrasing or a product keyword.'),
  labelMOQ: P('MOQ', 'MOQ', 'MOQ', 'MOQ'),
  labelWholesale: P('批發價', '批发价', '卸価格', 'Wholesale'),
  labelExport: P('出口', '出口', '輸出', 'Export'),
  labelOEM: P('OEM/ODM', 'OEM/ODM', 'OEM/ODM', 'OEM/ODM'),
  labelSample: P('樣品', '样品', 'サンプル', 'Sample'),
  loginHintB2B: P(
    '(商務條件如批發價、MOQ 僅對已登入且被授權的採購商開放。)',
    '(商务条件如批发价、MOQ 仅对已登录且被授权的采购商开放。)',
    '(卸価格・MOQ等の商務条件は、ログイン済みかつ許可されたバイヤーのみ閲覧可。)',
    '(Business terms like wholesale & MOQ are only shown to logged-in, authorized buyers.)')
};

// 商品關鍵字(多語) → 用於辨識使用者問哪個商品
const PRODUCT_KEYWORDS = {
  p001: ['抹茶', 'matcha', 'まっちゃ'],
  p002: ['茶包', '煎茶', 'sencha', 'teabag', 'ティーバッグ'],
  p003: ['介護', '鮭', '粥', 'porridge', 'salmon', 'おかゆ', '介护'],
  p004: ['果凍', '果冻', 'ゼリー', 'jelly', '營養', '营养', 'nutrition'],
  p005: ['仙貝', '煎餅', 'senbei', 'せんべい', '醬油', '酱油']
};

const includesAny = (s, arr) => arr.some(k => s.includes(k.toLowerCase()));

// 依身份取得可見商品(與端點同邏輯,縱深防禦:非管理人不 SELECT 敏感欄位)
async function scopedProducts(auth) {
  if (auth && auth.role === 'admin' && auth.status === 'approved') {
    const r = await db.query(`SELECT id,name,consumer,b2b,admin_meta FROM products ORDER BY id`);
    return { tier: 'admin', rows: r.rows };
  }
  if (auth && auth.role === 'buyer' && auth.status === 'approved' && auth.client_id) {
    const r = await db.query(
      `SELECT p.id,p.name,p.consumer,p.b2b FROM products p
       JOIN grants g ON g.product_id=p.id
       WHERE g.client_id=$1 AND p.open_l2=true ORDER BY p.id`, [auth.client_id]);
    return { tier: 'buyer', rows: r.rows };
  }
  const r = await db.query(`SELECT id,name,consumer FROM products WHERE open_l1=true ORDER BY id`);
  return { tier: 'public', rows: r.rows };
}

function fmtProductLine(p, tier, lang) {
  const name = pick(p.name, lang);
  if (tier === 'public') return `• ${name} — ${pick(p.consumer.price, lang)}`;
  // buyer / admin 有 b2b
  const d = p.b2b;
  return `• ${name} — ${pick(SAY.labelMOQ, lang)}:${pick(d.moq, lang)}｜${pick(SAY.labelWholesale, lang)}:${pick(d.wholesale, lang)}`;
}

function productDetail(p, tier, lang) {
  const name = pick(p.name, lang);
  if (tier === 'public') {
    const c = p.consumer;
    return `${name}\n${pick(c.story, lang)}\n${pick(c.feature, lang)}\n${pick(c.price, lang)}\n${pick(SAY.loginHintB2B, lang)}`;
  }
  const d = p.b2b;
  let s = `${name}\n` +
    `${pick(SAY.labelMOQ, lang)}:${pick(d.moq, lang)}\n` +
    `${pick(SAY.labelWholesale, lang)}:${pick(d.wholesale, lang)}\n` +
    `${pick(SAY.labelExport, lang)}:${pick(d.exportT, lang)}\n` +
    `${pick(SAY.labelOEM, lang)}:${pick(d.oem, lang)}\n` +
    `${pick(SAY.labelSample, lang)}:${pick(d.sample, lang)}\n` +
    `${pick(d.adminNote, lang)}`;
  if (tier === 'admin' && p.admin_meta) {
    const a = p.admin_meta;
    s += `\n[L3 內部] ${pick(a.verbal, lang)}｜${pick(a.risk, lang)}｜興趣:${(a.interested || []).join(',')}`;
  }
  return s;
}

// 主入口:回傳 { reply }
async function answer(message, auth, lang) {
  lang = ['tc', 'sc', 'ja', 'en'].includes(lang) ? lang : 'tc';
  const q = String(message || '').toLowerCase().trim();
  if (!q) return { reply: pick(SAY.hello, lang) };

  // 問候 / 求助
  if (includesAny(q, ['你好', '您好', 'hi', 'hello', 'help', '幫助', '帮助', 'こんにちは', '使い方', '能做什麼', '能做什么'])) {
    return { reply: pick(SAY.hello, lang) };
  }
  // 展會資訊
  if (includesAny(q, ['展會', '展会', '日期', '時間', '时间', '地點', '地点', '什麼時候', '什么时候', 'when', 'where', 'venue', 'date', '会場', '会期', 'jfex'])) {
    const r = await db.query(`SELECT name,date,venue,organizer,scale FROM exhibitions LIMIT 1`);
    if (r.rowCount) {
      const e = r.rows[0];
      return { reply: `${pick(e.name, lang)}\n${e.date}｜${pick(e.venue, lang)}｜${e.organizer}｜${pick(e.scale, lang)}` };
    }
  }
  // 報名 / 帳號 / 審核流程
  if (includesAny(q, ['報名', '报名', '註冊', '注册', '審核', '审核', '登入', '登录', '帳號', '账号', 'account', 'register', 'approve', 'login', '登録', '審査'])) {
    return { reply: pick(SAY.process, lang) };
  }
  // 展商上傳
  if (includesAny(q, ['上傳', '上传', '展商', '出展', 'exhibitor', 'upload', '型錄', '样册', 'カタログ', '我是廠商', '我是厂商'])) {
    return { reply: pick(SAY.exhibitorHelp, lang) };
  }

  // 取得身份可見商品
  const { tier, rows } = await scopedProducts(auth);

  // 指定商品
  let target = null;
  for (const p of rows) {
    if (PRODUCT_KEYWORDS[p.id] && includesAny(q, PRODUCT_KEYWORDS[p.id])) { target = p; break; }
  }
  if (target) return { reply: productDetail(target, tier, lang) };

  // 列出我的商品 / 授權商品 / 商品清單
  if (includesAny(q, ['我的商品', '授權', '授权', '清單', '清单', '有哪些', 'list', 'products', 'my product', '商品一覧', '一覧'])) {
    if (tier === 'public') {
      if (includesAny(q, ['授權', '授权', '我的', 'my', '採購', '采购', 'b2b'])) return { reply: pick(SAY.needLogin, lang) };
      const lines = rows.map(p => fmtProductLine(p, tier, lang)).join('\n');
      return { reply: `${pick(SAY.publicProducts, lang)}\n${lines}\n${pick(SAY.loginHintB2B, lang)}` };
    }
    if (!rows.length) return { reply: pick(SAY.noneAuthorized, lang) };
    const lines = rows.map(p => fmtProductLine(p, tier, lang)).join('\n');
    return { reply: `${pick(SAY.yourProducts, lang)}\n${lines}` };
  }

  // 詢問商務條件但未登入
  if (includesAny(q, ['批發', '批发', '價格', '价格', 'moq', '出口', 'oem', '報價', '报价', 'wholesale', 'price', 'export']) && tier === 'public') {
    return { reply: pick(SAY.needLogin, lang) };
  }

  return { reply: pick(SAY.fallback, lang) };
}

module.exports = { answer };
