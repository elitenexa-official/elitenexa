'use strict';
// DEMO_MODE only: on a fresh database (no members yet) create a small, clearly labelled demo team with paid orders
// spread over the last ~6 weeks, so the genealogy tree, earnings and income disclosure have something to show.
// Demo members get an unusable random password (nobody can log in as them); the admin can view them in
// Admin → Genealogy. Everything resets with the database (Render free has no disk).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, newReferralCode } = require('./db');
const P = require('./plan');

const TEAM = [ // [userId, name, sponsor userId, leg, country]
  ['kiran_demo', 'Kiran Rao (demo)', null, null, 'India'],
  ['asha_demo', 'Asha Sharma (demo)', 'kiran_demo', 'L', 'India'],
  ['vikram_demo', 'Vikram Singh (demo)', 'kiran_demo', 'R', 'India'],
  ['neha_demo', 'Neha Gupta (demo)', 'kiran_demo', 'L', 'India'],
  ['arjun_demo', 'Arjun Mehta (demo)', 'kiran_demo', 'R', 'India'],
  ['ravi_demo', 'Ravi Kumar (demo)', 'asha_demo', 'L', 'India'],
  ['pooja_demo', 'Pooja Nair (demo)', 'asha_demo', 'R', 'India'],
  ['sana_demo', 'Sana Khan (demo)', 'vikram_demo', 'L', 'India'],
  ['imran_demo', 'Imran Ali (demo)', 'vikram_demo', 'R', 'India'],
  ['deepak_demo', 'Deepak Joshi (demo)', 'neha_demo', 'L', 'India'],
  ['priya_demo', 'Priya Das (demo)', 'neha_demo', 'R', 'India'],
  ['rohit_demo', 'Rohit Verma (demo)', 'pooja_demo', 'L', 'India'],
  ['meera_demo', 'Meera Iyer (demo)', 'pooja_demo', 'R', 'India'],
  ['farhan_demo', 'Farhan Shaikh (demo)', 'sana_demo', 'L', 'India'],
  ['lerato_demo', 'Lerato Mokoena (demo)', 'sana_demo', 'R', 'South Africa'],
  ['thabo_demo', 'Thabo Nkosi (demo)', 'arjun_demo', 'L', 'South Africa'],
  ['kavya_demo', 'Kavya Reddy (demo)', 'arjun_demo', 'R', 'India'],
  ['sunil_demo', 'Sunil Patil (demo)', 'ravi_demo', 'L', 'India'],
  ['anita_demo', 'Anita Roy (demo)', 'imran_demo', 'R', 'India'],
  ['guest_demo', 'Gaurav Sen (demo, no purchase)', 'kavya_demo', 'L', 'India'],
];

function seedDemo() {
  if (db.prepare("SELECT COUNT(*) n FROM users WHERE role='member'").get().n > 0) return false;
  const kit = db.prepare("SELECT * FROM products WHERE name='EliteNexa Starter Kit'").get();
  const others = db.prepare("SELECT * FROM products WHERE active=1 AND id<>? ORDER BY id").all(kit.id);
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10); // unusable: nobody knows it
  const now = Date.now(), day = 86400000;
  const ids = {};
  db.transaction(() => {
    TEAM.forEach(([uid, name, sp, leg, country], i) => {
      const created = P.sqlTime(new Date(now - (60 - i) * day));
      const id = db.prepare('INSERT INTO users(name, username, email, password_hash, referral_code, sponsor_id, country, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(name, uid, `${uid}@demo.elitenexa.example`, hash, newReferralCode(), sp ? ids[sp] : null, country, created).lastInsertRowid;
      ids[uid] = id;
      if (sp) P.placeMember(id, ids[sp], leg);
    });
  })();
  // orders: everyone (except guest_demo) buys the starter kit; many repurchase later
  const plan = [];
  TEAM.forEach(([uid], i) => { if (uid !== 'guest_demo') plan.push([uid, kit, 1, 45 - i * 2]); });
  const rep = ['ravi_demo', 'pooja_demo', 'sana_demo', 'deepak_demo', 'rohit_demo', 'meera_demo', 'farhan_demo', 'lerato_demo', 'thabo_demo', 'kavya_demo', 'priya_demo', 'imran_demo', 'anita_demo', 'sunil_demo'];
  rep.forEach((uid, i) => plan.push([uid, others[i % others.length] || kit, 1 + (i % 2), 34 - i * 2]));
  rep.slice(0, 8).forEach((uid, i) => plan.push([uid, kit, 2, 8 - i]));
  plan.sort((a, b) => b[3] - a[3]);
  for (const [uid, p, qty, daysAgo] of plan) {
    const when = new Date(now - daysAgo * day - 3600000);
    db.transaction(() => {
      const oid = db.prepare(`INSERT INTO orders(user_id, product_id, product_name, unit_price_paise, qty, total_paise, address, status, created_at, paid_at, updated_at, bv_total)
        VALUES (?,?,?,?,?,?,?, 'paid', ?, ?, ?, ?)`).run(ids[uid], p.id, p.name, p.price_paise, qty, p.price_paise * qty, 'Demo address – not a real order', P.sqlTime(when), P.sqlTime(when), P.sqlTime(when), P.bvPerUnit(p.price_paise, p.bv_percent) * qty).lastInsertRowid;
      if (daysAgo > 20) db.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(oid);
      P.runCommissions({ now: when, trigger: 'demo_seed', orderIds: [oid] });
    })();
  }
  // one pending (unpaid) order and one pending buyback request
  db.prepare("INSERT INTO orders(user_id, product_id, product_name, unit_price_paise, qty, total_paise, address) VALUES (?,?,?,?,?,?,?)")
    .run(ids.guest_demo, kit.id, kit.name, kit.price_paise, 1, kit.price_paise, 'Demo address – awaiting payment', );
  db.prepare("UPDATE orders SET bv_total=? WHERE user_id=? AND status='pending'").run(P.bvPerUnit(kit.price_paise, kit.bv_percent), ids.guest_demo);
  const recent = db.prepare("SELECT id, user_id FROM orders WHERE user_id=? AND status='paid' ORDER BY id DESC").get(ids.sunil_demo);
  if (recent) db.prepare('INSERT INTO buyback_requests(order_id, user_id, reason, unopened) VALUES (?,?,?,1)').run(recent.id, recent.user_id, 'Demo: changed my mind, product unopened');
  P.releaseMatured(new Date());
  console.log(`Demo mode: seeded ${TEAM.length} demo members and ${plan.length} paid demo orders.`);
  return true;
}
module.exports = { seedDemo };
