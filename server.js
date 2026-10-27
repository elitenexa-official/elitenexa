'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const D = require('./db');
const CUR = require('./currency');
const P = require('./plan');
if (process.env.DEMO_MODE === '1') require('./demo').seedDemo();
const { db } = D;

const PORT = Number(process.env.PORT) || 3100;
const BRAND = 'EliteNexa';

// Session secret: env var, otherwise persisted random secret in data dir
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(D.DATA_DIR, '.session_secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8').trim();
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Behind a reverse proxy / Cloudflare tunnel (cloudflared connects from loopback and sets X-Forwarded-*).
// Default trusts loopback proxies only; TRUST_PROXY overrides (e.g. "1" for one hop on Render/Nginx).
app.set('trust proxy', process.env.TRUST_PROXY ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : 'loopback');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
// Session-less JSON endpoint (registered before the session middleware so a background check can never
// create/overwrite the login cookie while the signup form is being submitted)
app.get('/signup/check-userid', (req, res) => {
  const uid = String(req.query.u == null ? '' : req.query.u).trim().slice(0, 40);
  const err = D.validateUserId(uid);
  res.set('Cache-Control', 'no-store').json({ ok: !err, message: err || 'User ID is available.' });
});
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: SECRET, resave: false, saveUninitialized: false, name: 'enx.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1' ? true : 'auto' /* 'auto' = Secure cookie when the request arrived over https (e.g. via tunnel) */, maxAge: 1000 * 60 * 60 * 8 },
}));

// ---------- helpers ----------
const inr = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toPaise = (v) => { const n = Number(String(v || '').replace(/,/g, '').trim()); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : '';
const pwError = (pw, min = 8) => pw.length < min ? `Password must be at least ${min} characters.` : (pw.length > 128 ? 'Password is too long (max 128 characters).' : null);
const PAYOUT_COUNTRIES = CUR.COUNTRY_NAMES;
const PAYOUT_METHODS = { bank_upi: 'Bank / UPI', paypal: 'PayPal' };
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  if (!m) return null; try { return decodeURIComponent(m.slice(name.length + 1)); } catch (_) { return null; }
}
function flash(req, type, msg) { req.session.flash = { type, msg }; }

app.use((req, res, next) => { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex'); next(); });

// Load user + common locals
app.use((req, res, next) => {
  res.locals.user = null;
  if (req.session.uid) {
    const u = db.prepare('SELECT id, name, email, username, phone, country, role, referral_code, sponsor_id, status, created_at FROM users WHERE id=?').get(req.session.uid);
    if (!u || u.status !== 'active') { req.session.uid = null; } else { req.user = u; res.locals.user = u; }
  }
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash; delete req.session.flash;
  res.locals.DEMO_MODE = process.env.DEMO_MODE === '1'; res.locals.ADMIN_PW_FROM_ENV = D.ADMIN_PW_FROM_ENV; res.locals.ADMIN_PW_SOURCE = D.ADMIN_PW_SOURCE;
  res.locals.isStaff = isStaff(res.locals.user); res.locals.isManager = !!res.locals.user && res.locals.user.role === 'manager';
  res.locals.PAYOUT_COUNTRIES = PAYOUT_COUNTRIES;
  // Country + display currency: a member's saved country wins over the visitor cookie; default India.
  const ck = readCookie(req, 'enx_country');
  const country = (req.user && req.user.role === 'member' && CUR.validCountry(req.user.country)) ? req.user.country : (CUR.validCountry(ck) ? ck : CUR.DEFAULT_COUNTRY);
  const cur = CUR.currencyForCountry(country);
  req.country = country; req.cur = cur;
  res.locals.country = country; res.locals.countryInfo = CUR.countryInfo(country); res.locals.COUNTRIES = CUR.COUNTRIES;
  res.locals.cur = cur; res.locals.isIndia = country === 'India';
  res.locals.money = CUR.formatter(cur);                                   // INR paise -> visitor's currency
  res.locals.inrHint = (paise) => cur.code === 'INR' ? '' : `≈ ${inr(paise)}`; // small "≈ ₹X" hint
  res.locals.fmtCur = (amount, code) => CUR.fmt(Number(amount || 0), CUR.getCurrency(code) || CUR.getCurrency('INR'));
  res.locals.plan = P.getPlan(); res.locals.TYPE_LABEL = P.TYPE_LABEL;
  res.locals.inr = inr; res.locals.fmtDate = fmtDate; res.locals.path = req.path; res.locals.BRAND = BRAND;
  res.locals.baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  next();
});
// CSRF: per-session token, required on every POST
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const t = req.body && req.body._csrf;
    const ok = typeof t === 'string' && t.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf));
    if (!ok) return res.status(403).render('error', { title: 'Security check failed', message: 'Your form expired or was invalid. Please go back, refresh the page and try again.' });
  }
  next();
});

const requireMember = (req, res, next) => (req.user && req.user.role === 'member') ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'manager');
// Staff area (/admin): admin = full access; manager ("Approval Manager") = limited, see MANAGER_ALLOWED below
const requireStaff = (req, res, next) => isStaff(req.user) ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
const forbidden = (res) => res.status(403).render('error', { title: 'Access denied', message: 'Your account does not have permission to open this page.' });

// Simple login rate limit (per IP, in memory)
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, a); return a.length >= 10;
}

// ---------- public ----------
app.get('/', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id LIMIT 4').all();
  res.render('home', { title: 'Premium products, honest opportunity', products, settings: D.getSettings() });
});
app.get('/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id').all();
  res.render('products', { title: 'Products', products });
});
const starterKit = () => db.prepare("SELECT * FROM products WHERE name='EliteNexa Starter Kit'").get() || null;
app.get('/income-plan', (req, res) => res.render('income-plan', { title: 'Income Plan', settings: D.getSettings(), kit: starterKit(), disclosure: P.incomeDisclosure() }));
app.get('/buyback-policy', (req, res) => res.render('buyback-policy', { title: 'Buyback & Cooling-off Policy' }));
app.get('/grievance', (req, res) => res.render('grievance', { title: 'Grievance Officer', g: D.getSettings().grievance }));
app.get('/about', (req, res) => res.render('about', { title: 'About' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact', form: {} }));
app.post('/contact', (req, res) => {
  const form = { name: clean(req.body.name, 100), email: clean(req.body.email, 200), message: clean(req.body.message, 2000) };
  if (!form.name || !EMAIL_RE.test(form.email) || form.message.length < 5)
    return res.status(400).render('contact', { title: 'Contact', form, error: 'Please enter your name, a valid email and a message.' });
  db.prepare('INSERT INTO contact_messages(name,email,message) VALUES (?,?,?)').run(form.name, form.email, form.message);
  flash(req, 'ok', 'Thank you! Your message has been received. We will reply by email.');
  res.redirect('/contact');
});

// Referral: accepts a member's referral code (e.g. ENAB12CD) or their User ID
const findSponsor = (ref) => db.prepare("SELECT id, name, username FROM users WHERE (referral_code=upper(?) OR lower(username)=lower(?)) AND status='active' AND role='member'").get(ref, ref);
app.get('/signup', (req, res) => {
  if (req.user) return res.redirect(isStaff(req.user) ? '/admin' : '/dashboard');
  const ref = clean(req.query.ref, 20);
  const sponsor = ref ? findSponsor(ref) : null;
  const leg = req.query.leg === 'R' ? 'R' : 'L';
  res.render('signup', { title: 'Join free', form: { ref, leg }, sponsor });
});
// Country / currency selector (header + anywhere). Visitors: cookie. Members: also saved to their profile.
app.post('/country', (req, res) => {
  const c = clean(req.body.country, 60);
  const back = clean(req.body.back, 300);
  const safeBack = back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/\\') ? back : '/';
  if (CUR.validCountry(c)) {
    res.cookie('enx_country', c, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: true, secure: req.secure });
    if (req.user && req.user.role === 'member') db.prepare('UPDATE users SET country=? WHERE id=?').run(c, req.user.id);
  }
  res.redirect(safeBack);
});
app.post('/signup', (req, res) => {
  const form = { name: clean(req.body.name, 100), userid: clean(req.body.userid, 40), email: clean(req.body.email, 200).toLowerCase(), phone: clean(req.body.phone, 20), ref: clean(req.body.ref, 20), country: clean(req.body.country, 60) || req.country, leg: req.body.leg === 'R' ? 'R' : 'L' };
  const pw = String(req.body.password || ''), pw2 = String(req.body.password2 || '');
  const errs = [];
  if (form.name.length < 2) errs.push('Please enter your full name.');
  const uidErr = D.validateUserId(form.userid); if (uidErr) errs.push(uidErr);
  if (!EMAIL_RE.test(form.email)) errs.push('Please enter a valid email address.');
  if (form.phone && !/^[+0-9 \-]{8,16}$/.test(form.phone)) errs.push('Phone number looks invalid.');
  if (!CUR.validCountry(form.country)) errs.push('Please choose your country from the list.');
  const pe = pwError(pw); if (pe) errs.push(pe);
  if (pw !== pw2) errs.push('Passwords do not match.');
  if (!req.body.agree) errs.push('Please accept the Terms and read the Income Plan & disclaimer.');
  let sponsor = null;
  if (form.ref) {
    sponsor = findSponsor(form.ref);
    if (!sponsor) errs.push('Referral code / sponsor User ID not found. Leave it empty or check it.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(form.email)) errs.push('An account with this email already exists. Please log in.');
  if (errs.length) return res.status(400).render('signup', { title: 'Join free', form, sponsor, error: errs.join(' ') });
  let info;
  const hash = bcrypt.hashSync(pw, 12);
  try {
    // signup + binary placement in one transaction (placement = outermost free slot of the chosen leg under the sponsor).
    // Joining is free and creates NO commission and NO BV for anyone.
    info = db.transaction(() => {
      const r = db.prepare('INSERT INTO users(name,username,email,phone,country,password_hash,referral_code,sponsor_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(form.name, form.userid, form.email, form.phone || null, form.country, hash, D.newReferralCode(), sponsor ? sponsor.id : null);
      if (sponsor) P.placeMember(r.lastInsertRowid, sponsor.id, form.leg);
      return r;
    })();
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(400).render('signup', { title: 'Join free', form, sponsor, error: 'This User ID or email was just taken. Please choose another.' });
    throw e;
  }
  req.session.regenerate(() => {
    req.session.uid = info.lastInsertRowid;
    flash(req, 'ok', `Welcome to EliteNexa! Your free account is ready. Your User ID is ${form.userid}.`);
    res.redirect('/dashboard');
  });
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(isStaff(req.user) ? '/admin' : '/dashboard');
  res.render('login', { title: 'Log in', form: {}, next: clean(req.query.next, 200) });
});
app.post('/login', (req, res) => {
  const id = clean(req.body.login, 200).toLowerCase().replace(/^@/, ''); const pw = String(req.body.password || '');
  const next = clean(req.body.next, 200);
  if (tooMany(req.ip)) return res.status(429).render('login', { title: 'Log in', form: { login: id }, next, error: 'Too many attempts. Please wait 15 minutes and try again.' });
  const u = db.prepare('SELECT * FROM users WHERE lower(username)=? OR lower(email)=?').get(id, id);
  if (!u || !bcrypt.compareSync(pw, u.password_hash)) {
    attempts.get(req.ip).push(Date.now());
    return res.status(401).render('login', { title: 'Log in', form: { login: id }, next, error: 'Incorrect User ID/email or password.' });
  }
  if (u.status !== 'active') return res.status(403).render('login', { title: 'Log in', form: { login: id }, next, error: 'This account is blocked. Please contact support.' });
  req.session.regenerate(() => {
    req.session.uid = u.id;
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : null;
    const ok = safeNext && (isStaff(u) ? safeNext.startsWith('/admin') : !safeNext.startsWith('/admin'));
    res.redirect(ok ? safeNext : (isStaff(u) ? '/admin' : '/dashboard'));
  });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- member ----------
const m = express.Router();
const MEMBER_PREFIXES = ['/dashboard', '/profile', '/shop', '/orders', '/team', '/wallet', '/genealogy', '/earnings'];
m.use((req, res, next) => MEMBER_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/')) ? requireMember(req, res, next) : next());
// matured commissions (cooling-off over) are moved to the withdrawable wallet whenever a member page is opened
m.use((req, res, next) => { if (req.user && req.user.role === 'member') P.releaseMatured(); next(); });
function memberSummary(u) {
  const s = D.getSettings(); const plan = P.getPlan();
  const legs = P.legs(u.id);
  const rank = P.rankOf(legs.pairs_total, plan);
  const team = D.downline(u.id, s.team_depth);
  rank.pv = D.personalVolume(u.id) / 100; rank.tv = team.reduce((a, t) => a + t.volume, 0) / 100;
  return { s, plan, legs, rank, team, bal: D.balance(u.id), pending: P.pendingTotal(u.id), counts: P.tree(u.id, 0).counts };
}
m.get('/dashboard', (req, res) => {
  const sum = memberSummary(req.user);
  const ledger = db.prepare('SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY id DESC LIMIT 8').all(req.user.id);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5').all(req.user.id);
  const sponsor = req.user.sponsor_id ? db.prepare('SELECT name, referral_code FROM users WHERE id=?').get(req.user.sponsor_id) : null;
  res.render('member/dashboard', { title: 'Dashboard', ...sum, ledger, orders, sponsor });
});
m.get('/profile', (req, res) => res.render('member/profile', { title: 'My profile' }));
m.post('/profile', (req, res) => {
  const name = clean(req.body.name, 100), phone = clean(req.body.phone, 20), country = clean(req.body.country, 60) || req.country;
  if (name.length < 2 || (phone && !/^[+0-9 \-]{8,16}$/.test(phone))) { flash(req, 'err', 'Please enter a valid name and phone.'); return res.redirect('/profile'); }
  if (!CUR.validCountry(country)) { flash(req, 'err', 'Please choose your country from the list.'); return res.redirect('/profile'); }
  db.prepare('UPDATE users SET name=?, phone=?, country=? WHERE id=?').run(name, phone || null, country, req.user.id);
  flash(req, 'ok', 'Profile updated.'); res.redirect('/profile');
});
// Shared change-password handler (member: min 8 chars, admin: min 12 chars)
function changePassword(req, res, { view, back, min, title }) {
  const cur = String(req.body.current_password || ''), np = String(req.body.new_password || ''), np2 = String(req.body.confirm_password || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  let err = null;
  if (!bcrypt.compareSync(cur, row.password_hash)) err = 'Current password is incorrect.';
  else if (pwError(np, min)) err = pwError(np, min);
  else if (np !== np2) err = 'New password and confirmation do not match.';
  else if (np === cur) err = 'New password must be different from the current password.';
  if (err) return res.status(400).render(view, { title, min, error: err });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(np, 12), req.user.id);
  // sign out every other session of this account
  try { db.prepare("DELETE FROM sessions WHERE sid<>? AND json_extract(sess,'$.uid')=?").run(req.sessionID, req.user.id); } catch (_) {}
  if (req.user.role === 'admin') D.audit(req.user.id, 'admin_password_changed', null, '');
  flash(req, 'ok', 'Password changed successfully. Use the new password next time you log in.');
  res.redirect(back);
}
m.get('/profile/password', (req, res) => res.render('member/password', { title: 'Change password', min: 8 }));
m.post('/profile/password', (req, res) => changePassword(req, res, { view: 'member/password', back: '/profile/password', min: 8, title: 'Change password' }));
m.get('/shop', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id').all();
  res.render('member/shop', { title: 'Place an order', products });
});
m.post('/orders', (req, res) => {
  const pid = Number(req.body.product_id), qty = Number(req.body.qty), address = clean(req.body.address, 500);
  if (!Number.isInteger(pid) || !Number.isInteger(qty) || qty < 1 || qty > 50) { flash(req, 'err', 'Please choose a product and a quantity between 1 and 50.'); return res.redirect('/shop'); }
  if (address.length < 10) { flash(req, 'err', 'Please enter a complete delivery address.'); return res.redirect('/shop'); }
  try {
    const id = db.transaction(() => {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(pid);
      if (!p) throw new Error('Product not found.');
      if (p.stock < qty) throw new Error(`Only ${p.stock} in stock.`);
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, pid);
      return db.prepare('INSERT INTO orders(user_id,product_id,product_name,unit_price_paise,qty,total_paise,address,bv_total) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.user.id, pid, p.name, p.price_paise, qty, p.price_paise * qty, address, P.bvPerUnit(p.price_paise, p.bv_percent) * qty).lastInsertRowid;
    })();
    flash(req, 'ok', `Order #${id} placed. Status is Pending until payment is confirmed by EliteNexa.`);
    res.redirect('/orders');
  } catch (e) { flash(req, 'err', e.message); res.redirect('/shop'); }
});
function buybackEligible(o, plan) {
  if (!['paid', 'delivered'].includes(o.status) || !o.paid_at || o.bb_status) return false;
  return Date.now() <= P.addDays(P.parseSql(o.paid_at), plan.buyback_days).getTime();
}
m.get('/orders', (req, res) => {
  const plan = P.getPlan();
  const orders = db.prepare('SELECT o.*, b.status AS bb_status, b.refund_paise AS bb_refund, b.admin_note AS bb_note, b.refund_ref AS bb_ref FROM orders o LEFT JOIN buyback_requests b ON b.order_id=o.id WHERE o.user_id=? ORDER BY o.id DESC').all(req.user.id);
  orders.forEach(o => { o.canBuyback = buybackEligible(o, plan); o.buybackUntil = o.paid_at ? P.sqlTime(P.addDays(P.parseSql(o.paid_at), plan.buyback_days)) : null; });
  res.render('member/orders', { title: 'My orders', orders });
});
m.post('/orders/:id/buyback', (req, res) => {
  const plan = P.getPlan(); const reason = clean(req.body.reason, 500);
  const o = db.prepare('SELECT o.*, b.status AS bb_status FROM orders o LEFT JOIN buyback_requests b ON b.order_id=o.id WHERE o.id=? AND o.user_id=?').get(Number(req.params.id), req.user.id);
  if (!o) { flash(req, 'err', 'Order not found.'); return res.redirect('/orders'); }
  if (!buybackEligible(o, plan)) { flash(req, 'err', `Buyback is possible only for paid orders within ${plan.buyback_days} days of payment, once per order.`); return res.redirect('/orders'); }
  if (!req.body.unopened) { flash(req, 'err', 'Buyback applies to unopened, unused products. Please confirm the product is unopened.'); return res.redirect('/orders'); }
  if (reason.length < 5) { flash(req, 'err', 'Please tell us briefly why you are returning the product.'); return res.redirect('/orders'); }
  try {
    db.prepare('INSERT INTO buyback_requests(order_id, user_id, reason, unopened) VALUES (?,?,?,1)').run(o.id, req.user.id, reason);
    flash(req, 'ok', `Buyback request for order #${o.id} submitted. EliteNexa will contact you for the product return; after approval ${plan.buyback_refund_pct}% of the order value is refunded.`);
  } catch (e) { flash(req, 'err', 'A buyback request for this order already exists.'); }
  res.redirect('/orders');
});
m.get('/genealogy', (req, res) => {
  let root = req.user.id;
  const q = clean(req.query.u, 40);
  if (q) {
    const t = db.prepare("SELECT id FROM users WHERE lower(username)=lower(?) AND role='member'").get(q);
    if (t && P.isInDownline(req.user.id, t.id)) root = t.id;
    else { flash(req, 'err', 'That member is not in your binary team.'); return res.redirect('/genealogy'); }
  }
  const rootUser = db.prepare('SELECT id, username, placement_parent_id FROM users WHERE id=?').get(root);
  const up = root !== req.user.id && rootUser.placement_parent_id ? db.prepare('SELECT username FROM users WHERE id=?').get(rootUser.placement_parent_id) : null;
  res.render('member/genealogy', { title: 'Genealogy', ...memberSummary(req.user), t: P.tree(root, 3), base: '/genealogy', up: up && up.username, isSelf: root === req.user.id });
});
m.get('/earnings', (req, res) => {
  const rows = db.prepare(`SELECT c.*, f.username AS from_uid FROM commissions c LEFT JOIN users f ON f.id=c.from_user_id WHERE c.beneficiary_id=? ORDER BY c.id DESC LIMIT 300`).all(req.user.id);
  const days = db.prepare('SELECT * FROM pair_days WHERE user_id=? ORDER BY day DESC LIMIT 30').all(req.user.id);
  res.render('member/earnings', { title: 'My earnings', ...memberSummary(req.user), e: P.earnings(req.user.id), rows, days });
});
m.get('/team', (req, res) => {
  const sum = memberSummary(req.user);
  res.render('member/team', { title: 'My team', ...sum });
});
m.get('/wallet', (req, res) => {
  const sum = memberSummary(req.user);
  const ledger = db.prepare('SELECT l.*, a.username AS admin_name FROM wallet_ledger l LEFT JOIN users a ON a.id=l.created_by WHERE l.user_id=? ORDER BY l.id DESC').all(req.user.id);
  const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  res.render('member/wallet', { title: 'My wallet', ...sum, ledger, withdrawals });
});
m.post('/wallet/withdraw', (req, res) => {
  // Member types the amount in their display currency; it is converted to INR (base) at the current rate.
  const cur = req.cur, money = CUR.formatter(cur);
  const reqAmt = Number(String(req.body.amount || '').replace(/,/g, '').trim());
  const f = Math.pow(10, cur.decimals);
  const reqAmount = Number.isFinite(reqAmt) ? Math.round(reqAmt * f) / f : NaN;
  let amt = Number.isFinite(reqAmount) && reqAmount > 0 ? CUR.toINRPaise(reqAmount, cur) : NaN;
  // rounding tolerance: asking for the displayed full balance must not fail by a fraction of a paisa
  const bal0 = D.balance(req.user.id);
  if (Number.isInteger(amt) && amt > bal0 && cur.code !== 'INR' && amt - bal0 <= Math.ceil(100 / (cur.rate_per_inr * f))) amt = bal0;
  const method = req.body.payout_method === 'paypal' ? 'paypal' : 'bank_upi';
  const paypal = method === 'paypal' ? clean(req.body.paypal_email, 200).toLowerCase() : null;
  const country = clean(req.body.country, 60) || 'India';
  const details = method === 'paypal' ? `PayPal: ${paypal}` : clean(req.body.payout_details, 300);
  const s = D.getSettings();
  if (!Number.isInteger(amt) || amt <= 0) { flash(req, 'err', 'Enter a valid amount.'); return res.redirect('/wallet'); }
  if (amt < s.min_withdrawal_rupees * 100) { flash(req, 'err', `Minimum withdrawal is ${money(s.min_withdrawal_rupees * 100)}${cur.code === 'INR' ? '' : ' (≈ ' + inr(s.min_withdrawal_rupees * 100) + ')'}.`); return res.redirect('/wallet'); }
  if (!PAYOUT_COUNTRIES.includes(country)) { flash(req, 'err', 'Please choose your country from the list.'); return res.redirect('/wallet'); }
  if (method === 'paypal' && !EMAIL_RE.test(paypal)) { flash(req, 'err', 'Enter a valid PayPal email address (your own PayPal account).'); return res.redirect('/wallet'); }
  if (method === 'bank_upi' && details.length < 5) { flash(req, 'err', 'Enter your UPI ID or bank account details for payout.'); return res.redirect('/wallet'); }
  try {
    db.transaction(() => {
      if (D.balance(req.user.id) < amt) throw new Error('Amount is more than your available balance.');
      const wid = db.prepare('INSERT INTO withdrawals(user_id, amount_paise, payout_details, payout_method, paypal_email, country, req_currency, req_amount, fx_rate) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.id, amt, details, method, paypal, country, cur.code, reqAmount, cur.rate_per_inr).lastInsertRowid;
      db.prepare("INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, withdrawal_id) VALUES (?,?, 'withdrawal_hold', ?, ?)")
        .run(req.user.id, -amt, `Withdrawal request #${wid} (amount on hold until processed)${cur.code === 'INR' ? '' : ` – requested ${CUR.fmt(reqAmount, cur)} at 1 INR = ${cur.rate_per_inr} ${cur.code}`}`, wid);
    })();
    flash(req, 'ok', 'Withdrawal request submitted. You will be notified once it is processed.');
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/wallet');
});
app.use(m);

// ---------- admin ----------
const a = express.Router();
a.use(requireStaff);
// Approval Managers may ONLY use these routes; everything else under /admin is 403 for them (enforced server-side).
const MANAGER_ALLOWED = [
  ['GET', /^\/$/], ['GET', /^\/orders$/], ['POST', /^\/orders\/\d+\/status$/],
  ['GET', /^\/withdrawals$/], ['POST', /^\/withdrawals\/\d+$/],
];
a.use((req, res, next) => {
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'manager' && MANAGER_ALLOWED.some(([m, re]) => m === req.method && re.test(req.path))) return next();
  return forbidden(res);
});
a.use((req, res, next) => { res.locals.money = inr; res.locals.inrHint = () => ''; next(); }); // staff area: base currency (INR)
a.get('/', (req, res) => {
  P.releaseMatured();
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const stats = {
    members: q("SELECT COUNT(*) n FROM users WHERE role='member'").n,
    blocked: q("SELECT COUNT(*) n FROM users WHERE role='member' AND status='blocked'").n,
    pendingOrders: q("SELECT COUNT(*) n FROM orders WHERE status='pending'").n,
    sales: q("SELECT COALESCE(SUM(total_paise),0) v FROM orders WHERE status IN ('paid','delivered')").v,
    commissions: q("SELECT COALESCE(SUM(amount_paise),0) v FROM wallet_ledger WHERE type IN ('commission','commission_reversal')").v,
    pendingComm: q("SELECT COALESCE(SUM(amount_paise),0) v FROM commissions WHERE status='pending'").v,
    payoutPct: (() => { const s = q("SELECT COALESCE(SUM(total_paise),0) v FROM orders WHERE status IN ('paid','delivered')").v; const c = q("SELECT COALESCE(SUM(amount_paise),0) v FROM commissions WHERE status<>'reversed'").v; return s ? c * 100 / s : 0; })(),
    pendingBuybacks: q("SELECT COUNT(*) n FROM buyback_requests WHERE status='pending'").n,
    liability: q("SELECT COALESCE(SUM(amount_paise),0) v FROM wallet_ledger").v,
    pendingWd: q("SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) v FROM withdrawals WHERE status='pending'"),
    paidOut: q("SELECT COALESCE(SUM(amount_paise),0) v FROM withdrawals WHERE status='approved'").v,
  };
  const recentOrders = db.prepare('SELECT o.*, u.name AS member FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 6').all();
  const recentAudit = req.user.role === 'admin' ? db.prepare('SELECT l.*, a.username AS admin, t.name AS target FROM audit_log l LEFT JOIN users a ON a.id=l.admin_id LEFT JOIN users t ON t.id=l.target_user_id ORDER BY l.id DESC LIMIT 6').all() : [];
  res.render('admin/dashboard', { title: 'Admin dashboard', stats, recentOrders, recentAudit });
});
a.get('/members', (req, res) => {
  const search = clean(req.query.q, 100);
  const like = `%${search}%`;
  const members = db.prepare(`SELECT u.*, s.name AS sponsor_name,
      (SELECT COUNT(*) FROM users d WHERE d.sponsor_id=u.id) AS directs,
      (SELECT COALESCE(SUM(total_paise),0) FROM orders o WHERE o.user_id=u.id AND o.status IN ('paid','delivered')) AS volume,
      (SELECT COALESCE(SUM(amount_paise),0) FROM wallet_ledger w WHERE w.user_id=u.id) AS balance
    FROM users u LEFT JOIN users s ON s.id=u.sponsor_id
    WHERE u.role='member' AND (? = '' OR u.name LIKE ? OR u.email LIKE ? OR u.referral_code LIKE ? OR u.username LIKE ?)
    ORDER BY u.id DESC`).all(search, like, like, like, like);
  res.render('admin/members', { title: 'Members', members, search });
});
a.post('/members/:id/status', (req, res) => {
  const id = Number(req.params.id), status = req.body.status === 'blocked' ? 'blocked' : 'active';
  const r = db.prepare("UPDATE users SET status=? WHERE id=? AND role='member'").run(status, id);
  if (r.changes) { D.audit(req.user.id, status === 'blocked' ? 'member_blocked' : 'member_activated', id, ''); flash(req, 'ok', `Member ${status === 'blocked' ? 'blocked' : 'activated'}.`); }
  res.redirect('/admin/members');
});

a.get('/products', (req, res) => res.render('admin/products', { title: 'Products', products: db.prepare('SELECT * FROM products ORDER BY id').all() }));
a.get('/products/new', (req, res) => res.render('admin/product-form', { title: 'New product', p: { active: 1, stock: 0, bv_percent: P.getPlan().default_bv_pct } }));
a.get('/products/:id/edit', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) return res.redirect('/admin/products');
  res.render('admin/product-form', { title: 'Edit product', p });
});
a.post('/products/save', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const p = { id, name: clean(req.body.name, 150), price_paise: toPaise(req.body.price), image_url: clean(req.body.image_url, 500),
    description: clean(req.body.description, 3000), stock: Number(req.body.stock), active: req.body.active ? 1 : 0,
    bv_percent: req.body.bv_percent === undefined || req.body.bv_percent === '' ? P.getPlan().default_bv_pct : Number(req.body.bv_percent) };
  const errs = [];
  if (p.name.length < 2) errs.push('Name is required.');
  if (!Number.isInteger(p.price_paise) || p.price_paise < 0) errs.push('Enter a valid price.');
  if (!Number.isInteger(p.stock) || p.stock < 0) errs.push('Stock must be a whole number ≥ 0.');
  if (!Number.isFinite(p.bv_percent) || p.bv_percent < 0 || p.bv_percent > 100) errs.push('BV must be 0–100% of the price.');
  if (p.image_url && !/^(https?:\/\/|\/)[^\s"'<>]+$/.test(p.image_url)) errs.push('Image URL must start with https:// or /');
  if (errs.length) return res.status(400).render('admin/product-form', { title: id ? 'Edit product' : 'New product', p, error: errs.join(' ') });
  if (id) db.prepare('UPDATE products SET name=?, price_paise=?, image_url=?, description=?, stock=?, active=?, bv_percent=? WHERE id=?').run(p.name, p.price_paise, p.image_url, p.description, p.stock, p.active, p.bv_percent, id);
  else p.id = db.prepare('INSERT INTO products(name, price_paise, image_url, description, stock, active, bv_percent) VALUES (?,?,?,?,?,?,?)').run(p.name, p.price_paise, p.image_url, p.description, p.stock, p.active, p.bv_percent).lastInsertRowid;
  D.audit(req.user.id, id ? 'product_updated' : 'product_created', null, { product_id: p.id, name: p.name, price: p.price_paise / 100, stock: p.stock, active: p.active, bv_percent: p.bv_percent, bv_per_unit: P.bvPerUnit(p.price_paise, p.bv_percent) });
  flash(req, 'ok', 'Product saved.'); res.redirect('/admin/products');
});
a.post('/products/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) n FROM orders WHERE product_id=?').get(id).n;
  if (used) { db.prepare('UPDATE products SET active=0 WHERE id=?').run(id); flash(req, 'ok', 'Product has orders, so it was hidden (deactivated) instead of deleted.'); }
  else { db.prepare('DELETE FROM products WHERE id=?').run(id); flash(req, 'ok', 'Product deleted.'); }
  D.audit(req.user.id, used ? 'product_deactivated' : 'product_deleted', null, { product_id: id });
  res.redirect('/admin/products');
});

a.get('/orders', (req, res) => {
  const status = ['pending', 'paid', 'delivered', 'cancelled', 'returned'].includes(req.query.status) ? req.query.status : '';
  const orders = db.prepare(`SELECT o.*, u.name AS member, u.email, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE (?='' OR o.status=?) ORDER BY o.id DESC`).all(status, status);
  res.render('admin/orders', { title: 'Orders', orders, status });
});
const TRANSITIONS = { pending: ['paid', 'cancelled'], paid: ['delivered', 'cancelled'], delivered: [], cancelled: [], returned: [] };
a.post('/orders/:id/status', (req, res) => {
  const id = Number(req.params.id), to = String(req.body.status || '');
  try {
    const msg = db.transaction(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!o) throw new Error('Order not found.');
      if (!TRANSITIONS[o.status].includes(to)) throw new Error(`Cannot change order from ${o.status} to ${to}.`);
      if (req.user.role === 'manager' && !['paid', 'cancelled'].includes(to)) throw new Error('Approval Managers can only mark orders paid or cancelled.');
      db.prepare("UPDATE orders SET status=?, updated_at=datetime('now'), paid_at=CASE WHEN ?='paid' THEN datetime('now') ELSE paid_at END WHERE id=?").run(to, to, id);
      let extra = '';
      if (to === 'paid') {
        // commission run for this order: BV up the binary tree, pairs, matching, repurchase, payout cap -> PENDING
        const r = P.runCommissions({ trigger: 'order_paid', byUser: req.user.id, orderIds: [id] });
        extra = ` ${o.bv_total} BV added to the binary tree (run #${r.runId}). ${r.rows ? `${r.rows} commission entr${r.rows === 1 ? 'y' : 'ies'} totalling ${inr(r.paid)} recorded as pending (cooling-off ${P.getPlan().cooling_off_days} days)` : 'No commission from this order yet'}${r.scale < 1 ? ` – payout cap applied (×${r.scale.toFixed(4)})` : ''}.`;
      }
      if (to === 'cancelled') {
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(o.qty, o.product_id);
        if (o.bv_processed) { const r = P.reverseOrder(id, req.user.id, 'was cancelled'); extra = ` BV removed from the tree; ${r.reversedPending + r.reversedReleased} commission entr${r.reversedPending + r.reversedReleased === 1 ? 'y' : 'ies'} (${inr(r.amount)}) reversed.`; }
      }
      D.audit(req.user.id, 'order_' + to, o.user_id, `Order #${id} ${o.status} → ${to} by ${req.user.role} ${req.user.username}.${extra}`);
      return `Order #${id} marked ${to}.${extra}`;
    })();
    flash(req, 'ok', msg);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/admin/orders' + (req.body.back_status ? '?status=' + encodeURIComponent(req.body.back_status) : ''));
});

a.get('/wallet', (req, res) => {
  const members = db.prepare("SELECT id, name, username, email, referral_code FROM users WHERE role='member' ORDER BY name").all();
  const selected = req.query.member ? Number(req.query.member) : null;
  const adjustments = db.prepare(`SELECT l.*, u.name AS member, u.email, a.username AS admin FROM wallet_ledger l JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.created_by WHERE l.type IN ('admin_credit','admin_debit') ORDER BY l.id DESC LIMIT 50`).all();
  const memberLedger = selected ? db.prepare('SELECT l.*, a.username AS admin FROM wallet_ledger l LEFT JOIN users a ON a.id=l.created_by WHERE l.user_id=? ORDER BY l.id DESC LIMIT 50').all(selected) : [];
  const selBal = selected ? D.balance(selected) : null;
  res.render('admin/wallet', { title: 'Wallet adjustments', members, adjustments, selected, memberLedger, selBal });
});
a.post('/wallet/adjust', (req, res) => {
  const uid = Number(req.body.user_id), type = req.body.type === 'debit' ? 'debit' : 'credit';
  const amt = toPaise(req.body.amount), reason = clean(req.body.reason, 300);
  const member = db.prepare("SELECT id, name FROM users WHERE id=? AND role='member'").get(uid);
  const back = '/admin/wallet' + (member ? '?member=' + uid : '');
  if (!member) { flash(req, 'err', 'Select a member.'); return res.redirect(back); }
  if (!Number.isInteger(amt) || amt <= 0 || amt > 10000000) { flash(req, 'err', 'Enter a valid amount (up to ₹1,00,000).'); return res.redirect(back); }
  if (reason.length < 5) { flash(req, 'err', 'A clear reason (at least 5 characters) is mandatory for every manual adjustment.'); return res.redirect(back); }
  db.transaction(() => {
    db.prepare('INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, created_by) VALUES (?,?,?,?,?)')
      .run(uid, type === 'credit' ? amt : -amt, 'admin_' + type, reason, req.user.id);
    D.audit(req.user.id, 'wallet_' + type, uid, `${type === 'credit' ? 'Credited' : 'Debited'} ${inr(amt)} – Reason: ${reason}`);
  })();
  flash(req, 'ok', `${type === 'credit' ? 'Credited' : 'Debited'} ${inr(amt)} ${type === 'credit' ? 'to' : 'from'} ${member.name}. Logged in audit log.`);
  res.redirect(back);
});

a.get('/withdrawals', (req, res) => {
  const rows = db.prepare(`SELECT w.*, u.name AS member, u.email, u.username AS member_uid, a.username AS admin, a.role AS admin_role FROM withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN users a ON a.id=w.processed_by ORDER BY (w.status='pending') DESC, w.id DESC`).all();
  res.render('admin/withdrawals', { title: 'Withdrawals', rows });
});
a.post('/withdrawals/:id', (req, res) => {
  const id = Number(req.params.id), action = req.body.action;
  const note = clean(action === 'approve' ? req.body.reference : req.body.reason, 300);
  try {
    db.transaction(() => {
      const w = db.prepare("SELECT * FROM withdrawals WHERE id=? AND status='pending'").get(id);
      if (!w) throw new Error('Request not found or already processed.');
      if (action === 'approve') {
        const refLabel = w.payout_method === 'paypal' ? 'PayPal transaction ID' : 'UTR';
        if (note.length < 3) throw new Error(`Enter the ${refLabel} of the payment you made before approving.`);
        db.prepare("UPDATE withdrawals SET status='approved', admin_note=?, processed_by=?, processed_at=datetime('now') WHERE id=?").run(`${refLabel}: ${note}`, req.user.id, id);
        D.audit(req.user.id, 'withdrawal_approved', w.user_id, `Withdrawal #${id} ${inr(w.amount_paise)} approved by ${req.user.role} ${req.user.username}.${w.req_currency && w.req_currency !== 'INR' ? ` Requested ${w.req_amount} ${w.req_currency} @ ${w.fx_rate}/INR.` : ''} Method: ${PAYOUT_METHODS[w.payout_method] || w.payout_method}${w.paypal_email ? ' (' + w.paypal_email + ')' : ''}, country: ${w.country}. ${refLabel}: ${note}`);
      } else if (action === 'reject') {
        if (note.length < 3) throw new Error('Enter a reason when rejecting.');
        db.prepare("UPDATE withdrawals SET status='rejected', admin_note=?, processed_by=?, processed_at=datetime('now') WHERE id=?").run(note, req.user.id, id);
        db.prepare("INSERT INTO wallet_ledger(user_id, amount_paise, type, reason, withdrawal_id, created_by) VALUES (?,?, 'withdrawal_release', ?, ?, ?)")
          .run(w.user_id, w.amount_paise, `Withdrawal #${id} rejected – amount returned to wallet (${note})`, id, req.user.id);
        D.audit(req.user.id, 'withdrawal_rejected', w.user_id, `Withdrawal #${id} ${inr(w.amount_paise)} rejected by ${req.user.role} ${req.user.username}: ${note}`);
      } else throw new Error('Unknown action.');
    })();
    flash(req, 'ok', `Withdrawal #${id} ${action === 'approve' ? 'approved' : 'rejected'}.`);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/admin/withdrawals');
});

a.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings', s: D.getSettings() }));
a.post('/settings', (req, res) => {
  const depth = Number(req.body.team_depth), minW = Number(req.body.min_withdrawal_rupees);
  const g = { name: clean(req.body.g_name, 120), email: clean(req.body.g_email, 200), phone: clean(req.body.g_phone, 30), address: clean(req.body.g_address, 300) };
  const errs = [];
  if (!Number.isInteger(depth) || depth < 1 || depth > 20) errs.push('Team depth must be 1–20.');
  if (!Number.isFinite(minW) || minW < 0) errs.push('Minimum withdrawal must be ≥ 0.');
  if (g.name.length < 3 || !EMAIL_RE.test(g.email) || g.phone.length < 6) errs.push('Grievance Officer needs a name, a valid email and a phone number.');
  if (errs.length) { flash(req, 'err', errs.join(' ')); return res.redirect('/admin/settings'); }
  const before = D.getSettings();
  D.saveSetting('team_depth', depth); D.saveSetting('min_withdrawal_rupees', minW); D.saveSetting('grievance', g);
  D.audit(req.user.id, 'settings_updated', null, { before: { team_depth: before.team_depth, min_withdrawal_rupees: before.min_withdrawal_rupees, grievance: before.grievance }, after: { team_depth: depth, min_withdrawal_rupees: minW, grievance: g } });
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});
// ---------- Binary plan settings (admin only; managers get 403 from the guard) ----------
const pctList = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
a.get('/plan', (req, res) => res.render('admin/plan', { title: 'Plan settings', p: P.getPlan(), defaults: P.DEFAULT_PLAN }));
a.post('/plan', (req, res) => {
  const names = [].concat(req.body.rank_name || []), pairs = [].concat(req.body.rank_pairs || []);
  const p = {
    pair_bv: Number(req.body.pair_bv), pair_pct: Number(req.body.pair_pct), daily_pair_cap: Number(req.body.daily_pair_cap),
    matching_pcts: pctList(req.body.matching_pcts), repurchase_pcts: pctList(req.body.repurchase_pcts),
    max_payout_pct: Number(req.body.max_payout_pct), cooling_off_days: Number(req.body.cooling_off_days), buyback_days: Number(req.body.buyback_days),
    buyback_refund_pct: Number(req.body.buyback_refund_pct), default_bv_pct: Number(req.body.default_bv_pct),
    ranks: names.map((n, i) => ({ name: clean(n, 30), pairs: Number(pairs[i]) })).filter(r => r.name).sort((x, y) => x.pairs - y.pairs),
  };
  const errs = P.validatePlan(p);
  if (errs.length) return res.status(400).render('admin/plan', { title: 'Plan settings', p, defaults: P.DEFAULT_PLAN, error: errs.join(' ') });
  const before = P.getPlan();
  P.savePlan(p);
  const changed = Object.keys(p).filter(k => JSON.stringify(p[k]) !== JSON.stringify(before[k]));
  D.audit(req.user.id, 'plan_settings_updated', null, { changed, before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, p[k]])) });
  flash(req, 'ok', changed.length ? `Plan settings saved (${changed.join(', ')}). The public Income Plan page shows the new values; they apply to orders paid from now on.` : 'No changes.');
  res.redirect('/admin/plan');
});
// ---------- Genealogy lookup ----------
a.get('/genealogy', (req, res) => {
  const q = clean(req.query.u, 40);
  let root = null;
  if (q) root = db.prepare("SELECT id, username, placement_parent_id FROM users WHERE role='member' AND (lower(username)=lower(?) OR referral_code=upper(?))").get(q, q);
  else root = db.prepare("SELECT id, username, placement_parent_id FROM users WHERE role='member' AND placement_parent_id IS NULL ORDER BY (SELECT COUNT(*) FROM users c WHERE c.placement_parent_id=users.id) DESC, id LIMIT 1").get();
  if (q && !root) flash(req, 'err', 'Member not found.');
  const up = root && root.placement_parent_id ? db.prepare('SELECT username FROM users WHERE id=?').get(root.placement_parent_id) : null;
  res.render('admin/genealogy', { title: 'Genealogy', q, t: root ? P.tree(root.id, 3) : null, up: up && up.username, base: '/admin/genealogy' });
});
// ---------- Commission runs ----------
a.get('/commissions', (req, res) => {
  const runs = db.prepare('SELECT r.*, u.username AS by_uid FROM commission_runs r LEFT JOIN users u ON u.id=r.by_user ORDER BY r.id DESC LIMIT 100').all();
  const rows = db.prepare('SELECT c.*, b.username AS ben_uid, f.username AS from_uid FROM commissions c JOIN users b ON b.id=c.beneficiary_id LEFT JOIN users f ON f.id=c.from_user_id ORDER BY c.id DESC LIMIT 200').all();
  const totals = db.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(amount_paise),0) v FROM commissions GROUP BY status').all();
  res.render('admin/commissions', { title: 'Commission runs', runs, rows, totals });
});
a.post('/commissions/run', (req, res) => {
  const r = P.runCommissions({ trigger: 'manual', byUser: req.user.id });
  D.audit(req.user.id, 'commission_run', null, `Manual run #${r.runId}: ${r.orders} new paid order(s), ${r.rows} commission entr${r.rows === 1 ? 'y' : 'ies'} (${inr(r.paid)}), ${r.released} matured commission(s) released${r.scale < 1 ? `, payout cap applied ×${r.scale.toFixed(4)}` : ''}.`);
  flash(req, 'ok', `Run #${r.runId} done: ${r.orders} new paid order(s), ${r.rows} new commission entr${r.rows === 1 ? 'y' : 'ies'} (${inr(r.paid)}), ${r.released} released to wallets.`);
  res.redirect('/admin/commissions');
});
// ---------- Buyback requests (admin only) ----------
a.get('/buybacks', (req, res) => {
  const rows = db.prepare(`SELECT b.*, o.product_name, o.qty, o.total_paise, o.paid_at, o.status AS order_status, u.name AS member, u.username AS member_uid, a.username AS admin
    FROM buyback_requests b JOIN orders o ON o.id=b.order_id JOIN users u ON u.id=b.user_id LEFT JOIN users a ON a.id=b.processed_by ORDER BY (b.status='pending') DESC, b.id DESC`).all();
  rows.forEach(r => { r.pendingComm = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) v FROM commissions WHERE source_order_id=? AND status IN ('pending','released')").get(r.order_id); });
  res.render('admin/buybacks', { title: 'Buyback requests', rows });
});
a.post('/buybacks/:id', (req, res) => {
  const id = Number(req.params.id), action = req.body.action;
  try {
    const msg = db.transaction(() => {
      const b = db.prepare("SELECT * FROM buyback_requests WHERE id=? AND status='pending'").get(id);
      if (!b) throw new Error('Request not found or already processed.');
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(b.order_id);
      if (action === 'approve') {
        const ref = clean(req.body.refund_ref, 200);
        if (!req.body.received_unopened) throw new Error('Confirm that the product was received back unopened before approving.');
        if (ref.length < 3) throw new Error('Enter the refund reference (UTR / PayPal transaction ID) of the refund you paid.');
        if (!['paid', 'delivered'].includes(o.status)) throw new Error(`Order #${o.id} is ${o.status}; cannot buy back.`);
        const refund = Math.floor(o.total_paise * P.getPlan().buyback_refund_pct / 100);
        db.prepare("UPDATE orders SET status='returned', returned_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(o.id);
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(o.qty, o.product_id);
        const r = o.bv_processed ? P.reverseOrder(o.id, req.user.id, 'returned under buyback') : { reversedPending: 0, reversedReleased: 0, amount: 0 };
        db.prepare("UPDATE buyback_requests SET status='approved', refund_paise=?, refund_ref=?, processed_by=?, processed_at=datetime('now') WHERE id=?").run(refund, ref, req.user.id, id);
        const n = r.reversedPending + r.reversedReleased;
        D.audit(req.user.id, 'buyback_approved', o.user_id, `Buyback #${id} for order #${o.id}: refund ${inr(refund)} (ref ${ref}); ${o.bv_total} BV removed; ${n} commission entr${n === 1 ? 'y' : 'ies'} clawed back (${inr(r.amount)}).`);
        return `Buyback #${id} approved. Refund ${inr(refund)} recorded; ${n} related commission entr${n === 1 ? 'y' : 'ies'} (${inr(r.amount)}) clawed back.`;
      } else if (action === 'reject') {
        const note = clean(req.body.reason, 300);
        if (note.length < 3) throw new Error('Enter a reason when rejecting.');
        db.prepare("UPDATE buyback_requests SET status='rejected', admin_note=?, processed_by=?, processed_at=datetime('now') WHERE id=?").run(note, req.user.id, id);
        D.audit(req.user.id, 'buyback_rejected', o.user_id, `Buyback #${id} for order #${o.id} rejected: ${note}`);
        return `Buyback #${id} rejected.`;
      }
      throw new Error('Unknown action.');
    })();
    flash(req, 'ok', msg);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/admin/buybacks');
});
a.get('/password', (req, res) => res.render('admin/password', { title: 'Change password', min: 12 }));
a.post('/password', (req, res) => changePassword(req, res, { view: 'admin/password', back: '/admin/password', min: 12, title: 'Change password' }));
a.get('/audit', (req, res) => {
  const rows = db.prepare('SELECT l.*, a.username AS admin, a.role AS admin_role, t.name AS target, t.email AS target_email FROM audit_log l LEFT JOIN users a ON a.id=l.admin_id LEFT JOIN users t ON t.id=l.target_user_id ORDER BY l.id DESC LIMIT 500').all();
  res.render('admin/audit', { title: 'Audit log', rows });
});
// ---------- Currencies (admin only; managers get 403 from the guard above) ----------
a.get('/currencies', (req, res) => res.render('admin/currencies', { title: 'Currencies', currencies: CUR.allCurrencies(), countries: CUR.COUNTRIES }));
a.post('/currencies/:code', (req, res) => {
  const c = CUR.getCurrency(String(req.params.code || '').toUpperCase());
  if (!c) { flash(req, 'err', 'Currency not found.'); return res.redirect('/admin/currencies'); }
  if (c.code === 'INR') { flash(req, 'err', 'INR is the base currency: its rate is always 1 and it cannot be disabled.'); return res.redirect('/admin/currencies'); }
  const rate = Number(String(req.body.rate_per_inr || '').trim()), enabled = req.body.enabled ? 1 : 0;
  const symbol = clean(req.body.symbol, 6) || c.symbol;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) { flash(req, 'err', `${c.code}: enter a valid rate (units of ${c.code} for 1 INR).`); return res.redirect('/admin/currencies'); }
  db.prepare("UPDATE currencies SET rate_per_inr=?, enabled=?, symbol=?, updated_at=datetime('now') WHERE code=?").run(rate, enabled, symbol, c.code);
  D.audit(req.user.id, 'currency_updated', null, `${c.code}: rate (per 1 INR) ${c.rate_per_inr} → ${rate}; enabled ${c.enabled ? 'yes' : 'no'} → ${enabled ? 'yes' : 'no'}; symbol "${c.symbol}" → "${symbol}"`);
  flash(req, 'ok', `${c.code} updated: 1 INR = ${rate} ${c.code}${enabled ? '' : ' (disabled – its countries now see INR)'}.`);
  res.redirect('/admin/currencies');
});

// ---------- Approval Managers (admin only) ----------
const managerList = () => db.prepare("SELECT id, name, username, status, created_at FROM users WHERE role='manager' ORDER BY id").all();
const renderManagers = (res, extra = {}, code = 200) => res.status(code).render('admin/managers', { title: 'Approval Managers', managers: managerList(), form: {}, error: null, ...extra });
a.get('/managers', (req, res) => renderManagers(res));
a.post('/managers', (req, res) => {
  const form = { name: clean(req.body.name, 100), username: clean(req.body.username, 40) };
  const pw = String(req.body.new_password || ''), pw2 = String(req.body.confirm_password || '');
  let error = null;
  if (form.name.length < 2) error = 'Enter the manager\'s name.';
  else error = D.validateUserId(form.username) || pwError(pw, 12) || (pw !== pw2 ? 'Password and confirmation do not match.' : null);
  if (error) return renderManagers(res, { form, error }, 400);
  const id = db.prepare("INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?, 'manager')").run(form.name, form.username, bcrypt.hashSync(pw, 12)).lastInsertRowid;
  D.audit(req.user.id, 'manager_created', id, `Approval Manager "${form.username}" (${form.name}) created`);
  flash(req, 'ok', `Approval Manager ${form.username} created. Share the password with them privately.`); res.redirect('/admin/managers');
});
const getManager = (id) => db.prepare("SELECT id, name, username, status FROM users WHERE id=? AND role='manager'").get(Number(id));
const dropSessions = (uid) => { try { db.prepare("DELETE FROM sessions WHERE json_extract(sess,'$.uid')=?").run(uid); } catch (_) {} };
a.post('/managers/:id/status', (req, res) => {
  const mg = getManager(req.params.id); if (!mg) { flash(req, 'err', 'Manager not found.'); return res.redirect('/admin/managers'); }
  const status = req.body.status === 'blocked' ? 'blocked' : 'active';
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, mg.id);
  if (status === 'blocked') dropSessions(mg.id);
  D.audit(req.user.id, status === 'blocked' ? 'manager_disabled' : 'manager_enabled', mg.id, `Approval Manager "${mg.username}" ${status === 'blocked' ? 'disabled' : 'enabled'}`);
  flash(req, 'ok', `Manager ${mg.username} ${status === 'blocked' ? 'disabled' : 'enabled'}.`); res.redirect('/admin/managers');
});
a.post('/managers/:id/password', (req, res) => {
  const mg = getManager(req.params.id); if (!mg) { flash(req, 'err', 'Manager not found.'); return res.redirect('/admin/managers'); }
  const pw = String(req.body.new_password || ''), pw2 = String(req.body.confirm_password || '');
  const error = pwError(pw, 12) || (pw !== pw2 ? 'Password and confirmation do not match.' : null);
  if (error) { flash(req, 'err', `${mg.username}: ${error}`); return res.redirect('/admin/managers'); }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 12), mg.id);
  dropSessions(mg.id);
  D.audit(req.user.id, 'manager_password_reset', mg.id, `Password reset for Approval Manager "${mg.username}" (their sessions signed out)`);
  flash(req, 'ok', `Password for ${mg.username} reset. Their existing sessions were signed out.`); res.redirect('/admin/managers');
});
a.get('/messages', (req, res) => res.render('admin/messages', { title: 'Contact messages', rows: db.prepare('SELECT * FROM contact_messages ORDER BY id DESC').all() }));
// ---------- one-time admin password-hash tool (only when ADMIN_SETUP_TOKEN is set, >= 24 chars) ----------
// Never changes any account: it only turns a typed password into a bcrypt hash for the ADMIN_PASSWORD_HASH env var.
const SETUP_TOKEN = String(process.env.ADMIN_SETUP_TOKEN || '');
const SETUP_ON = SETUP_TOKEN.length >= 24;
const setupHits = new Map();
function setupLimited(ip) {
  const now = Date.now(); const h = (setupHits.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  h.push(now); setupHits.set(ip, h); return h.length > 30;
}
function setupTokenOk(t) {
  if (typeof t !== 'string') return false;
  const x = crypto.createHash('sha256').update(t).digest(), y = crypto.createHash('sha256').update(SETUP_TOKEN).digest();
  return crypto.timingSafeEqual(x, y);
}
const setupNotFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' });
function setupHandler(req, res) {
  if (!SETUP_ON) return setupNotFound(res);
  res.set('Cache-Control', 'no-store');
  if (setupLimited(req.ip)) return res.status(429).render('error', { title: 'Too many attempts', message: 'Please wait 15 minutes and try again.' });
  const token = req.method === 'POST' ? req.body.token : req.query.token;
  if (!setupTokenOk(token)) return setupNotFound(res); // wrong/missing token looks like "not found"
  if (req.method === 'GET') return res.render('admin/setup-hash', { title: 'Admin password hash', token, hash: null, error: null });
  const pw = String(req.body.password || ''), pw2 = String(req.body.confirm || '');
  let error = pwError(pw, 12);
  if (!error && pw !== pw2) error = 'Password and confirmation do not match.';
  if (error) return res.status(400).render('admin/setup-hash', { title: 'Admin password hash', token, hash: null, error });
  res.render('admin/setup-hash', { title: 'Admin password hash', token, hash: bcrypt.hashSync(pw, 12), error: null });
}
app.get('/admin/setup-hash', setupHandler);
app.post('/admin/setup-hash', setupHandler);
app.get('/admin/login', (req, res) => res.redirect(req.user && req.user.role === 'admin' ? '/admin' : '/login?next=/admin'));
app.use('/admin', a);

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' }); });

// Bind: HOST env wins; on Render (RENDER is set by the platform) listen on all interfaces; locally stay on loopback.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
app.listen(PORT, HOST, () => console.log(`${BRAND} running on http://${HOST}:${PORT}${process.env.DEMO_MODE === '1' ? ' (demo mode)' : ''}`));
