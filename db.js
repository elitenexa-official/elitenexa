'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'elitenexa.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  referral_code TEXT UNIQUE,
  sponsor_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_sponsor ON users(sponsor_id);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  image_url TEXT,
  description TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  total_paise INTEGER NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','cancelled')),
  commission_paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_paise INTEGER NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  withdrawal_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  payout_details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  processed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- migration: every account gets a unique, case-insensitive User ID (users.username) ----------
const USER_ID_RE = /^[A-Za-z0-9_]{4,20}$/;
const RESERVED_IDS = new Set(['admin', 'administrator', 'root', 'support', 'elitenexa', 'system', 'help', 'official', 'staff', 'moderator']);
function userIdTaken(uid, exceptId) {
  return !!db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?) AND id<>?').get(uid, exceptId || 0);
}
function validateUserId(uid) {
  if (!USER_ID_RE.test(uid)) return 'User ID must be 4–20 characters: letters, numbers or underscore (_) only.';
  if (RESERVED_IDS.has(uid.toLowerCase())) return 'This User ID is reserved. Please choose another.';
  if (userIdTaken(uid)) return 'This User ID is already taken. Please choose another.';
  return null;
}
db.transaction(() => {
  // admin(s) keep/get the User ID "admin"
  const admins = db.prepare("SELECT id, username FROM users WHERE role='admin' ORDER BY id").all();
  admins.forEach((a, i) => {
    const want = i === 0 ? 'admin' : 'admin' + (i + 1);
    if (a.username !== want) {
      const clash = db.prepare('SELECT id FROM users WHERE lower(username)=lower(?) AND id<>?').get(want, a.id);
      if (clash) db.prepare('UPDATE users SET username=NULL WHERE id=?').run(clash.id);
      db.prepare('UPDATE users SET username=? WHERE id=?').run(want, a.id);
    }
  });
  // members without a valid/unique User ID get one derived from their email (or "member<id>")
  const seen = new Set(admins.map((_, i) => (i === 0 ? 'admin' : 'admin' + (i + 1))));
  for (const u of db.prepare("SELECT id, email, username FROM users WHERE role='member' ORDER BY id").all()) {
    let ok = u.username && USER_ID_RE.test(u.username) && !RESERVED_IDS.has(u.username.toLowerCase()) && !seen.has(u.username.toLowerCase());
    if (!ok) {
      let base = String(u.email || '').split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 14);
      if (base.length < 4 || RESERVED_IDS.has(base.toLowerCase())) base = 'member' + u.id;
      let cand = base, n = 1;
      while (seen.has(cand.toLowerCase()) || db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?) AND id<>?').get(cand, u.id)) cand = (base.slice(0, 14) + '_' + (n++)).slice(0, 20);
      db.prepare('UPDATE users SET username=? WHERE id=?').run(cand, u.id);
      u.username = cand;
    }
    seen.add(u.username.toLowerCase());
  }
})();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(lower(username))');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_email_nocase ON users(lower(email))');

const DEFAULT_SETTINGS = {
  commission_levels: [10, 5, 2],          // % of sale amount for upline generation 1, 2, 3...
  team_depth: 5,                           // how deep "My Team" shows / team volume counts
  min_withdrawal_rupees: 500,
  ranks: [                                 // based on PAID product sales volume (rupees)
    { name: 'Starter', personal: 0, team: 0 },
    { name: 'Silver', personal: 2000, team: 10000 },
    { name: 'Gold', personal: 5000, team: 50000 },
    { name: 'Diamond', personal: 10000, team: 200000 },
  ],
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch (_) {}
  }
  return out;
}
function saveSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function newReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = 'EN';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) c += chars[b % chars.length];
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code=?').get(c)) return c;
  }
}

// Optional server-managed admin password (hosted demo). On every start the 'admin' account's password hash is kept
// in sync with ADMIN_PASSWORD_HASH (a bcrypt hash; takes precedence) or ADMIN_PASSWORD (plaintext, min 12 chars).
// Values are never logged.
const BCRYPT_RE = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
const ENV_ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH ? String(process.env.ADMIN_PASSWORD_HASH).trim() : '';
const ADMIN_HASH_FROM_ENV = BCRYPT_RE.test(ENV_ADMIN_HASH);
if (ENV_ADMIN_HASH && !ADMIN_HASH_FROM_ENV) console.warn('ADMIN_PASSWORD_HASH is set but is not a valid bcrypt hash; ignoring it.');
const ENV_ADMIN_PW = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : '';
const ADMIN_PLAIN_FROM_ENV = !ADMIN_HASH_FROM_ENV && ENV_ADMIN_PW.length >= 12;
if (ENV_ADMIN_PW && ENV_ADMIN_PW.length < 12 && !ADMIN_HASH_FROM_ENV) console.warn('ADMIN_PASSWORD is set but shorter than 12 characters; ignoring it.');
const ADMIN_PW_FROM_ENV = ADMIN_HASH_FROM_ENV || ADMIN_PLAIN_FROM_ENV;
const ADMIN_PW_SOURCE = ADMIN_HASH_FROM_ENV ? 'ADMIN_PASSWORD_HASH' : (ADMIN_PLAIN_FROM_ENV ? 'ADMIN_PASSWORD' : null);

function seed() {
  const admin = db.prepare("SELECT id FROM users WHERE role='admin'").get();
  const envHash = () => ADMIN_HASH_FROM_ENV ? ENV_ADMIN_HASH : bcrypt.hashSync(ENV_ADMIN_PW, 12);
  if (!admin && ADMIN_PW_FROM_ENV) {
    db.prepare("INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?, 'admin')")
      .run('Administrator', 'admin', envHash());
    console.log(`Admin account created (password from ${ADMIN_PW_SOURCE} environment variable).`);
  } else if (ADMIN_PW_FROM_ENV) {
    const row = db.prepare("SELECT id, password_hash FROM users WHERE lower(username)='admin' AND role='admin'").get();
    const differs = row && (ADMIN_HASH_FROM_ENV ? row.password_hash !== ENV_ADMIN_HASH : !bcrypt.compareSync(ENV_ADMIN_PW, row.password_hash));
    if (differs) {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(envHash(), row.id);
      try { db.prepare("DELETE FROM sessions WHERE json_extract(sess,'$.uid')=?").run(row.id); } catch (_) {}
      console.log(`Admin password updated from ${ADMIN_PW_SOURCE} environment variable; admin sessions signed out.`);
    }
  } else if (!admin) {
    const pw = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20) + '#7a';
    db.prepare("INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?, 'admin')")
      .run('Administrator', 'admin', bcrypt.hashSync(pw, 12));
    const file = path.join(__dirname, 'ADMIN_CREDENTIALS.txt');
    fs.writeFileSync(file, `EliteNexa admin login\nURL: /login\nUsername: admin\nPassword: ${pw}\n\nChange this password after first login (Admin panel > Change password, /admin/password).\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log('Admin account created. Credentials written to ADMIN_CREDENTIALS.txt');
  }
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
    const ins = db.prepare('INSERT INTO products(name, price_paise, image_url, description, stock) VALUES (?,?,?,?,?)');
    ins.run('Sample Product 1 – replace', 149900, '/img/sample-1.svg', 'SAMPLE listing. Replace with your real product name, MRP, photo and description from Admin > Products.', 100);
    ins.run('Sample Product 2 – replace', 89900, '/img/sample-2.svg', 'SAMPLE listing. Replace with your real product name, MRP, photo and description from Admin > Products.', 100);
    ins.run('Sample Product 3 – replace', 249900, '/img/sample-3.svg', 'SAMPLE listing. Replace with your real product name, MRP, photo and description from Admin > Products.', 50);
    ins.run('Sample Product 4 – replace', 59900, '/img/sample-4.svg', 'SAMPLE listing. Replace with your real product name, MRP, photo and description from Admin > Products.', 200);
  }
}
seed();

// ---------- domain helpers ----------
function balance(userId) {
  return db.prepare('SELECT COALESCE(SUM(amount_paise),0) b FROM wallet_ledger WHERE user_id=?').get(userId).b;
}
function personalVolume(userId) {
  return db.prepare("SELECT COALESCE(SUM(total_paise),0) v FROM orders WHERE user_id=? AND status IN ('paid','delivered')").get(userId).v;
}
function downline(userId, depth) {
  return db.prepare(`
    WITH RECURSIVE tree(id, lvl) AS (
      SELECT id, 1 FROM users WHERE sponsor_id = ?
      UNION ALL
      SELECT u.id, t.lvl + 1 FROM users u JOIN tree t ON u.sponsor_id = t.id WHERE t.lvl < ?
    )
    SELECT u.id, u.name, u.email, u.referral_code, u.status, u.created_at, t.lvl,
      s.name AS sponsor_name,
      (SELECT COALESCE(SUM(total_paise),0) FROM orders o WHERE o.user_id=u.id AND o.status IN ('paid','delivered')) AS volume
    FROM tree t JOIN users u ON u.id=t.id LEFT JOIN users s ON s.id=u.sponsor_id
    ORDER BY t.lvl, u.created_at`).all(userId, depth);
}
function teamVolume(userId, depth) {
  return downline(userId, depth).reduce((a, m) => a + m.volume, 0);
}
function rankFor(userId, settings) {
  settings = settings || getSettings();
  const pv = personalVolume(userId) / 100, tv = teamVolume(userId, settings.team_depth) / 100;
  const ranks = [...settings.ranks].sort((a, b) => a.personal + a.team - (b.personal + b.team));
  let current = ranks[0], next = null;
  for (const r of ranks) { if (pv >= r.personal && tv >= r.team) current = r; }
  const idx = ranks.indexOf(current);
  next = ranks[idx + 1] || null;
  return { current, next, pv, tv };
}

// Credit upline commissions for a paid order. Runs inside a transaction.
function creditCommissions(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || order.commission_paid) return [];
  const { commission_levels } = getSettings();
  const credited = [];
  let current = db.prepare('SELECT id, sponsor_id FROM users WHERE id=?').get(order.user_id);
  for (let gen = 1; gen <= commission_levels.length; gen++) {
    if (!current || !current.sponsor_id) break;
    const sponsor = db.prepare('SELECT id, sponsor_id, status, role FROM users WHERE id=?').get(current.sponsor_id);
    if (!sponsor) break;
    const pct = Number(commission_levels[gen - 1]) || 0;
    const amt = Math.floor(order.total_paise * pct / 100);
    if (sponsor.role === 'member' && sponsor.status === 'active' && amt > 0) {
      db.prepare(`INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, order_id) VALUES (?,?,?,?,?)`)
        .run(sponsor.id, amt, 'commission', `Level ${gen} commission (${pct}%) on product sale – Order #${order.id}`, order.id);
      credited.push({ user_id: sponsor.id, gen, amt });
    }
    current = sponsor;
  }
  db.prepare('UPDATE orders SET commission_paid=1 WHERE id=?').run(order.id);
  return credited;
}
function reverseCommissions(orderId, adminId) {
  const rows = db.prepare("SELECT user_id, amount_paise FROM wallet_ledger WHERE order_id=? AND type='commission'").all(orderId);
  for (const r of rows) {
    db.prepare(`INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, order_id, created_by) VALUES (?,?,?,?,?,?)`)
      .run(r.user_id, -r.amount_paise, 'commission_reversal', `Commission reversed – Order #${orderId} was cancelled`, orderId, adminId);
  }
  db.prepare('UPDATE orders SET commission_paid=0 WHERE id=?').run(orderId);
  return rows.length;
}
function audit(adminId, action, targetUserId, details) {
  db.prepare('INSERT INTO audit_log(admin_id, action, target_user_id, details) VALUES (?,?,?,?)')
    .run(adminId, action, targetUserId || null, typeof details === 'string' ? details : JSON.stringify(details));
}

module.exports = { db, ADMIN_PW_FROM_ENV, ADMIN_PW_SOURCE, validateUserId, USER_ID_RE, getSettings, saveSetting, newReferralCode, balance, personalVolume, downline, teamVolume, rankFor, creditCommissions, reverseCommissions, audit, DATA_DIR };
