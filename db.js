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
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','manager')),
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','cancelled','returned')),
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

// ---------- migration: allow the 'manager' (Approval Manager staff) role on older databases ----------
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
  if (!sql.includes("'manager'")) {
    const cols = 'id, name, email, username, phone, password_hash, role, referral_code, sponsor_id, status, created_at';
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, username TEXT UNIQUE, phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','manager')),
        referral_code TEXT UNIQUE, sponsor_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO users_new(${cols}) SELECT ${cols} FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_sponsor ON users(sponsor_id);`);
    })();
    db.pragma('foreign_keys = ON');
    const bad = db.pragma('foreign_key_check');
    if (bad.length) console.warn('foreign_key_check after users migration reported', bad.length, 'issue(s)');
  }
}
// ---------- migration: member's country (display currency + country notes) ----------
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'country')) db.exec('ALTER TABLE users ADD COLUMN country TEXT');
// ---------- migration: payout method / PayPal email / country on withdrawals ----------
{
  const have = new Set(db.prepare('PRAGMA table_info(withdrawals)').all().map(c => c.name));
  if (!have.has('payout_method')) db.exec("ALTER TABLE withdrawals ADD COLUMN payout_method TEXT NOT NULL DEFAULT 'bank_upi'");
  if (!have.has('paypal_email')) db.exec('ALTER TABLE withdrawals ADD COLUMN paypal_email TEXT');
  if (!have.has('country')) db.exec("ALTER TABLE withdrawals ADD COLUMN country TEXT NOT NULL DEFAULT 'India'");
  // currency the member typed the amount in, that amount, and the rate used (units per 1 INR); amount_paise stays INR
  if (!have.has('req_currency')) db.exec("ALTER TABLE withdrawals ADD COLUMN req_currency TEXT NOT NULL DEFAULT 'INR'");
  if (!have.has('req_amount')) db.exec('ALTER TABLE withdrawals ADD COLUMN req_amount REAL');
  if (!have.has('fx_rate')) db.exec('ALTER TABLE withdrawals ADD COLUMN fx_rate REAL NOT NULL DEFAULT 1');
}

// ---------- migration: orders may be 'returned' (approved buyback) ----------
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get().sql;
  if (!sql.includes("'returned'")) {
    const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
    const newSql = sql.replace(/CREATE TABLE\s+"?orders"?/i, 'CREATE TABLE orders_new').replace("'delivered','cancelled')", "'delivered','cancelled','returned')");
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(newSql);
      db.exec(`INSERT INTO orders_new(${cols.join(',')}) SELECT ${cols.join(',')} FROM orders; DROP TABLE orders; ALTER TABLE orders_new RENAME TO orders;
        CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);`);
    })();
    db.pragma('foreign_keys = ON');
  }
}
// ---------- migration: binary plan columns ----------
{
  const addCol = (table, name, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); };
  // binary placement (separate from the sponsor who referred the member)
  addCol('users', 'placement_parent_id', 'INTEGER REFERENCES users(id)');
  addCol('users', 'placement_side', "TEXT CHECK (placement_side IN ('L','R'))");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_placement_slot ON users(placement_parent_id, placement_side) WHERE placement_parent_id IS NOT NULL');
  // business volume per product (percent of MRP) and per order (snapshot at order time)
  addCol('products', 'bv_percent', 'REAL NOT NULL DEFAULT 60');
  addCol('orders', 'bv_total', 'INTEGER NOT NULL DEFAULT 0');
  addCol('orders', 'bv_processed', 'INTEGER NOT NULL DEFAULT 0');
  addCol('orders', 'is_repurchase', 'INTEGER NOT NULL DEFAULT 0');
  addCol('orders', 'returned_at', 'TEXT');
  addCol('wallet_ledger', 'commission_id', 'INTEGER');
  // a released commission can be credited to the wallet only once (and reversed only once)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_commission_once ON wallet_ledger(commission_id, type) WHERE commission_id IS NOT NULL');
}

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
  team_depth: 5,                           // how deep "My Team" (sponsor list) shows
  min_withdrawal_rupees: 500,
  grievance: { name: 'Grievance Officer (to be appointed)', email: 'grievance@elitenexa.example', phone: '+91 00000 00000', address: 'EliteNexa, India (registered address to be added)' },
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
  if (!db.prepare("SELECT 1 FROM products WHERE name='EliteNexa Starter Kit'").get()) {
    db.prepare('INSERT INTO products(name, price_paise, image_url, description, stock, bv_percent) VALUES (?,?,?,?,?,?)')
      .run('EliteNexa Starter Kit', 119900, '/img/starter-kit.svg', 'Optional starter kit of EliteNexa products (SAMPLE contents – replace with the real kit list). Buying it is NOT required to join. BV 60% of MRP. 30-day buyback on unopened products.', 500, 60);
  }
  if (db.prepare("SELECT COUNT(*) n FROM products WHERE name<>'EliteNexa Starter Kit'").get().n === 0) {
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
function audit(adminId, action, targetUserId, details) {
  db.prepare('INSERT INTO audit_log(admin_id, action, target_user_id, details) VALUES (?,?,?,?)')
    .run(adminId, action, targetUserId || null, typeof details === 'string' ? details : JSON.stringify(details));
}

module.exports = { db, ADMIN_PW_FROM_ENV, ADMIN_PW_SOURCE, validateUserId, USER_ID_RE, getSettings, saveSetting, newReferralCode, balance, personalVolume, downline, teamVolume, audit, DATA_DIR };
