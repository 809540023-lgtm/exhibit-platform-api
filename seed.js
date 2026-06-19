// 將種子資料寫入資料庫(冪等:已存在則略過)。也建立初始管理人帳號。
const { query } = require('./db');
const { hashPassword } = require('./auth');
const data = require('./seed-data');

async function seed() {
  // 展覽
  await query(
    `INSERT INTO exhibitions(id,name,date,venue,organizer,scale,status)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
    [data.exhibition.id, JSON.stringify(data.exhibition.name), data.exhibition.date,
     JSON.stringify(data.exhibition.venue), data.exhibition.organizer,
     JSON.stringify(data.exhibition.scale), JSON.stringify(data.exhibition.status)]
  );
  // 展商
  for (const e of data.exhibitors) {
    await query(
      `INSERT INTO exhibitors(id,name,booth,category,reviewed,status)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [e.id, JSON.stringify(e.name), e.booth, JSON.stringify(e.category), e.reviewed, e.status]
    );
  }
  // 商品
  for (const p of data.products) {
    await query(
      `INSERT INTO products(id,exhibitor_id,name,consumer,b2b,admin_meta,reviewed,open_l1,open_l2)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.exhibitor_id, JSON.stringify(p.name), JSON.stringify(p.consumer),
       JSON.stringify(p.b2b), JSON.stringify(p.admin_meta), p.reviewed, p.open_l1, p.open_l2]
    );
  }
  // L4 授權
  for (const g of data.grants) {
    await query(
      `INSERT INTO grants(client_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [g.client_id, g.product_id]
    );
  }
  // 初始管理人(密碼來自環境變數,不寫死)
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPw = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPw) {
    const exists = await query(`SELECT 1 FROM users WHERE email=$1`, [adminEmail]);
    if (exists.rowCount === 0) {
      await query(
        `INSERT INTO users(email,password_hash,role,status,display_name,lang)
         VALUES($1,$2,'admin','approved',$3,'tc')`,
        [adminEmail, await hashPassword(adminPw), 'Administrator']
      );
      console.log('Seeded admin:', adminEmail);
    }
  }
}

module.exports = { seed };
