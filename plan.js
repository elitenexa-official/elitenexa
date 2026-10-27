'use strict';
// EliteNexa Binary compensation plan engine.
// Every rupee of commission comes from the Business Volume (BV) of PAID product orders. Nothing is ever paid for
// signing up, joining or recruiting. Amounts are INR paise; BV is whole points (1 BV ≈ ₹1 of MRP × the product's BV %).
const { db, getSettings, saveSetting, audit } = require('./db');

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS binary_legs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  left_bv INTEGER NOT NULL DEFAULT 0,        -- unmatched BV carried forward on the left leg (can go negative after a buyback)
  right_bv INTEGER NOT NULL DEFAULT 0,
  total_left INTEGER NOT NULL DEFAULT 0,     -- lifetime BV received on each leg
  total_right INTEGER NOT NULL DEFAULT 0,
  pairs_total INTEGER NOT NULL DEFAULT 0,    -- lifetime matched pairs (paid + flushed) – used for rank
  pairs_paid INTEGER NOT NULL DEFAULT 0,
  pairs_flushed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bv_events (       -- every change to a member's legs, so an order can be reversed exactly
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  run_id INTEGER,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('bv','pair','flush')),
  side TEXT,
  left_delta INTEGER NOT NULL DEFAULT 0,
  right_delta INTEGER NOT NULL DEFAULT 0,
  pairs INTEGER NOT NULL DEFAULT 0,
  day TEXT,
  reversed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bv_events_order ON bv_events(order_id);
CREATE INDEX IF NOT EXISTS idx_bv_events_user ON bv_events(user_id);
CREATE TABLE IF NOT EXISTS pair_days (       -- paid pairs per member per IST calendar day (daily cap)
  user_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  pairs_paid INTEGER NOT NULL DEFAULT 0,
  pairs_flushed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS commission_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  by_user INTEGER REFERENCES users(id),
  orders_count INTEGER NOT NULL DEFAULT 0,
  sales_paise INTEGER NOT NULL DEFAULT 0,
  gross_paise INTEGER NOT NULL DEFAULT 0,     -- commission before the payout cap
  cap_paise INTEGER NOT NULL DEFAULT 0,       -- max payout % × sales of this run
  paid_paise INTEGER NOT NULL DEFAULT 0,      -- commission actually credited (pending)
  scale REAL NOT NULL DEFAULT 1,
  scaled INTEGER NOT NULL DEFAULT 0,
  released_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES commission_runs(id),
  source_order_id INTEGER NOT NULL REFERENCES orders(id),
  beneficiary_id INTEGER NOT NULL REFERENCES users(id),
  from_user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('pair','matching','repurchase')),
  level INTEGER NOT NULL DEFAULT 0,
  pairs INTEGER NOT NULL DEFAULT 0,
  bv INTEGER NOT NULL DEFAULT 0,
  gross_paise INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','released','reversed')),
  release_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT,
  reversed_at TEXT,
  UNIQUE (source_order_id, beneficiary_id, type, level)   -- idempotency: never pay the same thing twice
);
CREATE INDEX IF NOT EXISTS idx_commissions_ben ON commissions(beneficiary_id, status);
CREATE INDEX IF NOT EXISTS idx_commissions_release ON commissions(status, release_at);
CREATE TABLE IF NOT EXISTS buyback_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  unopened INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  refund_paise INTEGER,
  refund_ref TEXT,
  admin_note TEXT,
  processed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
`);

// ---------------------------------------------------------------- plan settings
const DEFAULT_PLAN = {
  pair_bv: 719,               // BV needed on EACH leg for one pair
  pair_pct: 10,               // % of pair BV paid per pair  (719 × 10% = ₹71.90)
  daily_pair_cap: 10,         // max paid pairs per member per IST day; extra matched pairs are flushed
  matching_pcts: [5, 3],      // % of the pair income of personally sponsored members, generation 1, 2
  repurchase_pcts: [10, 5, 5],// % of repurchase BV paid up the sponsor line (total 20%)
  max_payout_pct: 38,         // hard cap: total commission of a run ≤ this % of that run's paid sales
  cooling_off_days: 30,       // commissions stay pending this long, then become withdrawable
  buyback_days: 30,           // member may request buyback of unopened products within this many days of payment
  buyback_refund_pct: 90,
  default_bv_pct: 60,
  ranks: [{ name: 'Star', pairs: 10 }, { name: 'Team Manager', pairs: 100 }, { name: 'Director', pairs: 500 }, { name: 'Crown', pairs: 2000 }],
};
function getPlan() {
  const s = getSettings();
  return { ...DEFAULT_PLAN, ...(s.plan || {}) };
}
function savePlan(p) { saveSetting('plan', p); }
function validatePlan(p) {
  const e = [];
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!int(p.pair_bv, 1, 1000000)) e.push('Pair BV must be a whole number ≥ 1.');
  if (!num(p.pair_pct, 0, 25)) e.push('Pair commission must be 0–25% of pair BV.');
  if (!int(p.daily_pair_cap, 1, 1000)) e.push('Daily pair cap must be 1–1000.');
  if (!Array.isArray(p.matching_pcts) || p.matching_pcts.length > 5 || p.matching_pcts.some(x => !num(x, 0, 20)) || p.matching_pcts.reduce((a, b) => a + b, 0) > 20) e.push('Matching bonus: up to 5 levels, each 0–20%, total ≤ 20%.');
  if (!Array.isArray(p.repurchase_pcts) || p.repurchase_pcts.length > 5 || p.repurchase_pcts.some(x => !num(x, 0, 30)) || p.repurchase_pcts.reduce((a, b) => a + b, 0) > 30) e.push('Repurchase commission: up to 5 levels, total ≤ 30% of repurchase BV.');
  if (!num(p.max_payout_pct, 1, 50)) e.push('Maximum payout must be 1–50% of sales.');
  if (!int(p.buyback_days, 0, 90)) e.push('Buyback window must be 0–90 days.');
  if (!int(p.cooling_off_days, 0, 120)) e.push('Cooling-off must be 0–120 days.');
  if (Number.isInteger(p.cooling_off_days) && Number.isInteger(p.buyback_days) && p.cooling_off_days < p.buyback_days) e.push('Cooling-off (pending) period cannot be shorter than the buyback window, otherwise commission on a returned product could already have been paid out.');
  if (!num(p.buyback_refund_pct, 0, 100)) e.push('Buyback refund must be 0–100%.');
  if (!num(p.default_bv_pct, 0, 100)) e.push('Default BV must be 0–100% of MRP.');
  if (!Array.isArray(p.ranks) || !p.ranks.length || p.ranks.some(r => !r.name || !int(r.pairs, 1, 10000000))) e.push('Each rank needs a name and a pairs target ≥ 1.');
  return e;
}

// ---------------------------------------------------------------- helpers
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');               // UTC, same format as datetime('now')
const istDay = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10); // calendar day in India (UTC+5:30)
const parseSql = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
function ensureLegs(uid) { db.prepare('INSERT OR IGNORE INTO binary_legs(user_id) VALUES (?)').run(uid); }
function legs(uid) {
  return db.prepare('SELECT * FROM binary_legs WHERE user_id=?').get(uid) || { user_id: uid, left_bv: 0, right_bv: 0, total_left: 0, total_right: 0, pairs_total: 0, pairs_paid: 0, pairs_flushed: 0 };
}
const userRow = (id) => db.prepare('SELECT id, name, username, role, status, sponsor_id, placement_parent_id, placement_side FROM users WHERE id=?').get(id);
const bvPerUnit = (price_paise, bv_percent) => Math.floor(price_paise * Number(bv_percent) / 10000); // BV points per unit

// ---------------------------------------------------------------- placement
// Sponsor chooses (via link) or the new member chooses the leg; the member is placed in the outermost free slot of that
// leg under the sponsor (spillover). Sponsor (who referred) and placement parent are stored separately.
function findPlacement(sponsorId, side) {
  side = side === 'R' ? 'R' : 'L';
  let parent = sponsorId;
  for (let guard = 0; guard < 100000; guard++) {
    const child = db.prepare('SELECT id FROM users WHERE placement_parent_id=? AND placement_side=?').get(parent, side);
    if (!child) return { parent, side };
    parent = child.id;
  }
  throw new Error('Placement depth limit reached.');
}
function placeMember(userId, sponsorId, side) {
  if (!sponsorId) return null;          // no sponsor: the member starts their own tree (root)
  const pos = findPlacement(sponsorId, side);
  db.prepare('UPDATE users SET placement_parent_id=?, placement_side=? WHERE id=?').run(pos.parent, pos.side, userId);
  return pos;
}
function isInDownline(rootId, uid) {   // placement tree
  let cur = db.prepare('SELECT id, placement_parent_id FROM users WHERE id=?').get(uid);
  for (let g = 0; cur && g < 100000; g++) {
    if (cur.id === rootId) return true;
    if (!cur.placement_parent_id) return false;
    cur = db.prepare('SELECT id, placement_parent_id FROM users WHERE id=?').get(cur.placement_parent_id);
  }
  return false;
}
function childrenOf(uid) {
  const rows = db.prepare('SELECT id, placement_side FROM users WHERE placement_parent_id=?').all(uid);
  return { L: (rows.find(r => r.placement_side === 'L') || {}).id || null, R: (rows.find(r => r.placement_side === 'R') || {}).id || null };
}
function subtreeCount(uid) {
  return db.prepare(`WITH RECURSIVE t(id) AS (SELECT id FROM users WHERE placement_parent_id=? UNION ALL SELECT u.id FROM users u JOIN t ON u.placement_parent_id=t.id) SELECT COUNT(*) n FROM t`).get(uid).n;
}
function rankOf(pairsTotal, plan) {
  plan = plan || getPlan();
  const ranks = [...plan.ranks].sort((a, b) => a.pairs - b.pairs);
  let current = { name: 'Member', pairs: 0 }, next = ranks[0] || null;
  for (let i = 0; i < ranks.length; i++) if (pairsTotal >= ranks[i].pairs) { current = ranks[i]; next = ranks[i + 1] || null; }
  return { current, next, pairs: pairsTotal };
}
// Binary tree for display: `depth` levels below root, positions '', 'L', 'R', 'LL', ...
function tree(rootId, depth) {
  const plan = getPlan();
  const nodes = [];
  const walk = (uid, pos, lvl) => {
    if (lvl > depth) return;
    if (!uid) { nodes.push({ pos, empty: true, lvl }); return; }
    const u = userRow(uid); const l = legs(uid);
    const sp = u.sponsor_id ? db.prepare('SELECT username FROM users WHERE id=?').get(u.sponsor_id) : null;
    nodes.push({ pos, lvl, id: u.id, name: u.name, username: u.username, status: u.status, sponsor: sp && sp.username, side: u.placement_side, legs: l, rank: rankOf(l.pairs_total, plan).current.name, team: { L: null, R: null } });
    const c = childrenOf(uid);
    walk(c.L, pos + 'L', lvl + 1); walk(c.R, pos + 'R', lvl + 1);
  };
  walk(rootId, '', 0);
  const c = childrenOf(rootId);
  return { nodes, counts: { L: c.L ? 1 + subtreeCount(c.L) : 0, R: c.R ? 1 + subtreeCount(c.R) : 0 }, depth };
}

// ---------------------------------------------------------------- commission run
// Processes every PAID order whose BV has not been processed yet: adds BV up the placement tree, matches pairs
// (daily cap, flush), computes matching bonus and repurchase commission, applies the hard payout cap for the run
// (scaling everything down proportionally if needed) and records all commissions as PENDING until the cooling-off
// period ends. Must be called inside a transaction (it wraps itself in one; better-sqlite3 nests via savepoints).
const runCommissions = db.transaction((opts = {}) => {
  const now = opts.now || new Date();
  const plan = getPlan();
  const orders = db.prepare("SELECT * FROM orders WHERE status IN ('paid','delivered') AND bv_processed=0 ORDER BY paid_at, id" ).all()
    .filter(o => !opts.orderIds || opts.orderIds.includes(o.id));
  const runId = db.prepare('INSERT INTO commission_runs(trigger, by_user, created_at) VALUES (?,?,?)').run(opts.trigger || 'manual', opts.byUser || null, sqlTime(now)).lastInsertRowid;
  const day = istDay(now);
  const rows = [];                      // { order, beneficiary, from, type, level, pairs, bv, gross, note }
  let sales = 0;
  for (const o of orders) {
    sales += o.total_paise;
    const buyer = userRow(o.user_id);
    const isRep = !!db.prepare("SELECT 1 FROM orders WHERE user_id=? AND id<>? AND bv_processed=1 AND status IN ('paid','delivered')").get(o.user_id, o.id);
    db.prepare('UPDATE orders SET bv_processed=1, commission_paid=1, is_repurchase=? WHERE id=?').run(isRep ? 1 : 0, o.id);
    const bv = o.bv_total;
    const pairIncome = new Map();       // earner id -> gross paise from this order
    if (bv > 0) {
      // 1. BV up the placement tree; 2. pair matching at every upline member
      let child = buyer;
      for (let g = 0; child && child.placement_parent_id && g < 100000; g++) {
        const anc = userRow(child.placement_parent_id); const side = child.placement_side;
        ensureLegs(anc.id);
        const col = side === 'L' ? 'left' : 'right';
        db.prepare(`UPDATE binary_legs SET ${col}_bv=${col}_bv+?, total_${col}=total_${col}+? WHERE user_id=?`).run(bv, bv, anc.id);
        db.prepare('INSERT INTO bv_events(order_id, run_id, user_id, kind, side, left_delta, right_delta, day, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(o.id, runId, anc.id, 'bv', side, side === 'L' ? bv : 0, side === 'R' ? bv : 0, day, sqlTime(now));
        const l = legs(anc.id);
        const possible = Math.floor(Math.min(l.left_bv, l.right_bv) / plan.pair_bv);
        if (possible > 0) {
          const eligible = anc.role === 'member' && anc.status === 'active';
          const done = (db.prepare('SELECT pairs_paid FROM pair_days WHERE user_id=? AND day=?').get(anc.id, day) || { pairs_paid: 0 }).pairs_paid;
          const payable = eligible ? Math.max(0, Math.min(possible, plan.daily_pair_cap - done)) : 0;
          const flushed = possible - payable;
          const used = possible * plan.pair_bv;
          db.prepare('UPDATE binary_legs SET left_bv=left_bv-?, right_bv=right_bv-?, pairs_total=pairs_total+?, pairs_paid=pairs_paid+?, pairs_flushed=pairs_flushed+? WHERE user_id=?')
            .run(used, used, possible, payable, flushed, anc.id);
          db.prepare('INSERT INTO pair_days(user_id, day, pairs_paid, pairs_flushed) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET pairs_paid=pairs_paid+excluded.pairs_paid, pairs_flushed=pairs_flushed+excluded.pairs_flushed')
            .run(anc.id, day, payable, flushed);
          const ev = db.prepare('INSERT INTO bv_events(order_id, run_id, user_id, kind, left_delta, right_delta, pairs, day, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
          if (payable) ev.run(o.id, runId, anc.id, 'pair', -payable * plan.pair_bv, -payable * plan.pair_bv, payable, day, sqlTime(now));
          if (flushed) ev.run(o.id, runId, anc.id, 'flush', -flushed * plan.pair_bv, -flushed * plan.pair_bv, flushed, day, sqlTime(now));
          if (payable) {
            const gross = Math.floor(payable * plan.pair_bv * plan.pair_pct);   // BV(₹) × pct/100 × 100 paise
            if (gross > 0) {
              rows.push({ order: o.id, ben: anc.id, from: buyer.id, type: 'pair', level: 0, pairs: payable, bv: payable * plan.pair_bv, gross,
                note: `${payable} pair${payable > 1 ? 's' : ''} × ${plan.pair_bv} BV × ${plan.pair_pct}%${flushed ? ` (${flushed} more flushed: daily cap ${plan.daily_pair_cap})` : ''}` });
              pairIncome.set(anc.id, gross);
            }
          }
        }
        child = anc;
      }
      // 3. matching bonus on the pair income of personally sponsored members (sponsor line, generation 1..n)
      const agg = new Map();
      for (const [earnerId, gross] of pairIncome) {
        let cur = userRow(earnerId);
        plan.matching_pcts.forEach((pct, i) => {
          if (!cur || !cur.sponsor_id) { cur = null; return; }
          const sp = userRow(cur.sponsor_id);
          const amt = Math.floor(gross * pct / 100);
          if (sp && sp.role === 'member' && sp.status === 'active' && amt > 0) {
            const k = sp.id + ':' + (i + 1);
            const a = agg.get(k) || { ben: sp.id, level: i + 1, gross: 0, from: [] };
            a.gross += amt; a.from.push(earnerId); agg.set(k, a);
          }
          cur = sp;
        });
      }
      for (const a of agg.values()) {
        const names = a.from.map(id => userRow(id).username).join(', ');
        rows.push({ order: o.id, ben: a.ben, from: a.from.length === 1 ? a.from[0] : null, type: 'matching', level: a.level, pairs: 0, bv: 0, gross: a.gross,
          note: `Matching bonus L${a.level} (${plan.matching_pcts[a.level - 1]}%) on pair income of ${names}` });
      }
      // 4. repurchase commission (every paid order after the buyer's first one) up the sponsor line
      if (isRep) {
        let cur = buyer;
        plan.repurchase_pcts.forEach((pct, i) => {
          if (!cur || !cur.sponsor_id) { cur = null; return; }
          const sp = userRow(cur.sponsor_id);
          const amt = Math.floor(bv * pct);       // BV(₹) × pct/100 × 100 paise
          if (sp && sp.role === 'member' && sp.status === 'active' && amt > 0)
            rows.push({ order: o.id, ben: sp.id, from: buyer.id, type: 'repurchase', level: i + 1, pairs: 0, bv, gross: amt, note: `Repurchase L${i + 1} (${pct}% of ${bv} BV)` });
          cur = sp;
        });
      }
    }
  }
  // 5. hard payout cap for this run
  const gross = rows.reduce((a, r) => a + r.gross, 0);
  const cap = Math.floor(sales * plan.max_payout_pct / 100);
  const scale = gross > cap ? cap / gross : 1;
  const releaseAt = sqlTime(addDays(now, plan.cooling_off_days));
  const ins = db.prepare(`INSERT INTO commissions(run_id, source_order_id, beneficiary_id, from_user_id, type, level, pairs, bv, gross_paise, amount_paise, release_at, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let paid = 0;
  for (const r of rows) {
    const amt = scale < 1 ? Math.floor(r.gross * scale) : r.gross;
    paid += amt;
    ins.run(runId, r.order, r.ben, r.from, r.type, r.level, r.pairs, r.bv, r.gross, amt, releaseAt, r.note + (scale < 1 ? ` – scaled to ${(scale * 100).toFixed(2)}% by the ${plan.max_payout_pct}% payout cap` : ''), sqlTime(now));
  }
  const note = scale < 1 ? `Payout cap applied: gross ₹${(gross / 100).toFixed(2)} > ${plan.max_payout_pct}% of sales ₹${(sales / 100).toFixed(2)} = ₹${(cap / 100).toFixed(2)}; all commissions scaled ×${scale.toFixed(4)}` : null;
  db.prepare('UPDATE commission_runs SET orders_count=?, sales_paise=?, gross_paise=?, cap_paise=?, paid_paise=?, scale=?, scaled=?, note=? WHERE id=?')
    .run(orders.length, sales, gross, cap, paid, scale, scale < 1 ? 1 : 0, note, runId);
  if (scale < 1) audit(opts.byUser || null, 'payout_cap_applied', null, `Run #${runId}: ${note}`);
  const released = releaseMatured(now);
  db.prepare('UPDATE commission_runs SET released_count=? WHERE id=?').run(released, runId);
  return { runId, orders: orders.length, sales, gross, cap, paid, scale, rows: rows.length, released };
});

// Pending commissions whose cooling-off has ended become withdrawable (credited to the wallet ledger once).
// Held back while a buyback request for the source order is pending.
const releaseMatured = db.transaction((now) => {
  now = now || new Date();
  const due = db.prepare(`SELECT c.* FROM commissions c WHERE c.status='pending' AND c.release_at <= ?
    AND NOT EXISTS (SELECT 1 FROM buyback_requests b WHERE b.order_id=c.source_order_id AND b.status='pending')`).all(sqlTime(now));
  let n = 0;
  for (const c of due) {
    const r = db.prepare("UPDATE commissions SET status='released', released_at=? WHERE id=? AND status='pending'").run(sqlTime(now), c.id);
    if (!r.changes) continue;
    if (c.amount_paise > 0) db.prepare("INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, order_id, commission_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(c.beneficiary_id, c.amount_paise, 'commission', `${TYPE_LABEL[c.type]}${c.level ? ' L' + c.level : ''} released after cooling-off – Order #${c.source_order_id} (${c.note})`, c.source_order_id, c.id, sqlTime(now));
    n++;
  }
  return n;
});
const TYPE_LABEL = { pair: 'Pair commission', matching: 'Matching bonus', repurchase: 'Repurchase commission' };

// Reverse everything an order caused (buyback approved, or paid order cancelled): its BV and pairs are taken back
// out of every upline member's legs and every commission sourced from it is reversed (pending ones cancelled,
// already-released ones debited from the wallet).
const reverseOrder = db.transaction((orderId, byUser, why) => {
  let reversedPending = 0, reversedReleased = 0, amount = 0;
  for (const c of db.prepare("SELECT * FROM commissions WHERE source_order_id=? AND status IN ('pending','released')").all(orderId)) {
    db.prepare("UPDATE commissions SET status='reversed', reversed_at=datetime('now') WHERE id=?").run(c.id);
    if (c.status === 'released' && c.amount_paise > 0) {
      db.prepare("INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, order_id, commission_id, created_by) VALUES (?,?,?,?,?,?,?)")
        .run(c.beneficiary_id, -c.amount_paise, 'commission_reversal', `${TYPE_LABEL[c.type]} reversed – Order #${orderId} ${why}`, orderId, c.id, byUser || null);
      reversedReleased++;
    } else reversedPending++;
    amount += c.amount_paise;
  }
  for (const e of db.prepare('SELECT * FROM bv_events WHERE order_id=? AND reversed=0 ORDER BY id DESC').all(orderId)) {
    if (e.kind === 'bv') db.prepare('UPDATE binary_legs SET left_bv=left_bv-?, right_bv=right_bv-?, total_left=total_left-?, total_right=total_right-? WHERE user_id=?').run(e.left_delta, e.right_delta, e.left_delta, e.right_delta, e.user_id);
    else {
      const paidCol = e.kind === 'pair' ? 'pairs_paid' : 'pairs_flushed';
      db.prepare(`UPDATE binary_legs SET left_bv=left_bv-?, right_bv=right_bv-?, pairs_total=pairs_total-?, ${paidCol}=${paidCol}-? WHERE user_id=?`).run(e.left_delta, e.right_delta, e.pairs, e.pairs, e.user_id);
      db.prepare(`UPDATE pair_days SET ${paidCol}=MAX(0, ${paidCol}-?) WHERE user_id=? AND day=?`).run(e.pairs, e.user_id, e.day);
    }
    db.prepare('UPDATE bv_events SET reversed=1 WHERE id=?').run(e.id);
  }
  return { reversedPending, reversedReleased, amount };
});

// ---------------------------------------------------------------- reporting
function earnings(uid) {
  const by = db.prepare('SELECT type, status, COUNT(*) n, COALESCE(SUM(amount_paise),0) v FROM commissions WHERE beneficiary_id=? GROUP BY type, status').all(uid);
  const t = { pair: {}, matching: {}, repurchase: {} };
  for (const r of by) t[r.type][r.status] = r.v;
  const sum = (st) => ['pair', 'matching', 'repurchase'].reduce((a, k) => a + (t[k][st] || 0), 0);
  return { byType: t, pending: sum('pending'), released: sum('released'), reversed: sum('reversed') };
}
const pendingTotal = (uid) => db.prepare("SELECT COALESCE(SUM(amount_paise),0) v FROM commissions WHERE beneficiary_id=? AND status='pending'").get(uid).v;
function incomeDisclosure() {
  const members = db.prepare("SELECT u.id, COALESCE((SELECT SUM(amount_paise) FROM commissions c WHERE c.beneficiary_id=u.id AND c.status<>'reversed'),0) e FROM users u WHERE u.role='member'").all();
  const vals = members.map(m => m.e).sort((a, b) => a - b);
  const n = vals.length, earners = vals.filter(v => v > 0);
  const median = n ? (n % 2 ? vals[(n - 1) / 2] : Math.round((vals[n / 2 - 1] + vals[n / 2]) / 2)) : 0;
  const bands = [[0, 0, 'Nothing (₹0)'], [1, 100000, 'Up to ₹1,000'], [100001, 1000000, '₹1,001 – ₹10,000'], [1000001, 10000000, '₹10,001 – ₹1,00,000'], [10000001, Infinity, 'More than ₹1,00,000']]
    .map(([lo, hi, label]) => { const c = vals.filter(v => v >= lo && v <= hi).length; return { label, lo, hi, count: c, pct: n ? (c * 100 / n) : 0, avg: c ? Math.round(vals.filter(v => v >= lo && v <= hi).reduce((a, b) => a + b, 0) / c) : 0 }; });
  const topN = Math.max(1, Math.ceil(n * 0.01));
  const top = vals.slice(-topN);
  return { members: n, earners: earners.length, earnersPct: n ? earners.length * 100 / n : 0, total: vals.reduce((a, b) => a + b, 0),
    average: n ? Math.round(vals.reduce((a, b) => a + b, 0) / n) : 0, median, max: n ? vals[n - 1] : 0,
    top1avg: top.length ? Math.round(top.reduce((a, b) => a + b, 0) / top.length) : 0, topN, bands,
    since: (db.prepare("SELECT MIN(created_at) d FROM users WHERE role='member'").get() || {}).d };
}

module.exports = { DEFAULT_PLAN, getPlan, savePlan, validatePlan, findPlacement, placeMember, isInDownline, childrenOf, tree, legs, rankOf, bvPerUnit,
  runCommissions, releaseMatured, reverseOrder, earnings, pendingTotal, incomeDisclosure, istDay, sqlTime, parseSql, addDays, TYPE_LABEL };
