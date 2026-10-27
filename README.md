# EliteNexa – direct selling website

Node.js + Express + SQLite (better-sqlite3) + server-rendered EJS. Black & gold brand theme (Cinzel / Montserrat), official logos in `public/brand/`.

**Business model built in (do not change without legal advice):** earnings come **only** from paid product orders (upline commission on own team's product sales). No joining fee, no income for sign-ups, no donations/"help" schemes, no member-to-member transfers. The wallet is an internal earnings ledger; members request withdrawals and the admin pays out externally. The public `/income-plan` page shows live commission % and rank targets, the income disclaimer and the Consumer Protection (Direct Selling) Rules, 2021 note.

## Run locally
```bash
npm install          # needs Node 18+ (tested on Node 20; better-sqlite3 11.x has prebuilt binaries)
PORT=3100 npm start  # http://127.0.0.1:3100
```
On first start the app creates `data/elitenexa.db`, 4 SAMPLE products, and an `admin` account with a random password written to `ADMIN_CREDENTIALS.txt` (chmod 600). Log in at `/admin/login` (or `/login`) with User ID `admin`, then change the password at **Admin → Change password** (`/admin/password`).

Environment variables:
| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3100 | HTTP port |
| `HOST` | 127.0.0.1 (0.0.0.0 when `RENDER` is set) | Bind address (`0.0.0.0` on a server/container) |
| `SESSION_SECRET` | auto-generated in `data/.session_secret` | Cookie signing secret |
| `DATA_DIR` | `./data` | SQLite DB location (put on a persistent disk) |
| `BASE_URL` | request host | Used for referral links and og:image, e.g. `https://elitenexa.in` |
| `COOKIE_SECURE` | auto | Default `auto`: cookie gets `Secure` when the request arrived over HTTPS (proxy/tunnel). Set `1` to force |
| `ADMIN_PASSWORD` | – | Optional (min 12 chars). On every start the `admin` account's password is set to this value (no `ADMIN_CREDENTIALS.txt` is written). Never logged |
| `ADMIN_PASSWORD_HASH` | – | Optional bcrypt hash (`$2a$`/`$2b$`…). On every start the `admin` password hash is set to it (admin sessions signed out when it changes). **Takes precedence over `ADMIN_PASSWORD`**; an invalid hash is ignored with a warning. Never logged |
| `ADMIN_SETUP_TOKEN` | – | Optional, ≥ 24 chars. Enables the one-time hash tool `/admin/setup-hash?token=…` (404 otherwise). Remove after use |
| `DEMO_MODE` | – | `1` shows admins a dismissible "Demo mode – data resets when the server restarts" banner |
| `TRUST_PROXY` | `loopback` | Trusts X-Forwarded-* from local proxies (cloudflared/Nginx on same box). Set `1` for one remote hop (Render/Railway) |

## Accounts
- Members pick their own **User ID** at signup (4–20 letters/numbers/_, unique case-insensitively) plus a password (min 8, confirmed). Login accepts User ID or email.
- Referral: `?ref=` / the signup field accept a member's referral code **or** their User ID.
- Change password: members `/profile/password`, admin `/admin/password` (12+ chars; other sessions are signed out; audit-logged).
- Two-factor authentication: see **Two-factor authentication (2FA)** below.

## Staff roles
- **Admin** (`admin`): full access to `/admin`.
- **Approval Manager** (staff, not a member): created/disabled/re-enabled and password-reset by the admin at **Admin → Approval Managers** (`/admin/managers`); the admin chooses the User ID and sets the password (12+ chars). Managers log in at `/admin/login` and can **only**: see the dashboard summary, view orders and mark pending orders *paid* / *cancelled*, view withdrawal requests and approve (with the payout reference) or reject them. Every other `/admin` route (wallet credit/debit, products, members, settings, managers, audit log, messages, change password) returns **403** for them; enforced server-side (`MANAGER_ALLOWED` in `server.js`) and the links are hidden. All their actions are in the audit log with their User ID. Disabling or resetting a manager signs out their sessions.

## Payouts (withdrawals)
Members request a withdrawal to **their own** account: **Bank / UPI** (UPI ID or A/c + IFSC) or **PayPal** (PayPal email, validated) plus their **country** (India, South Africa, UAE, US, UK, … , Other). The amount is held in the ledger until processed. The approval page shows method, PayPal email and country, and approving requires the **UTR** (bank/UPI) or the **PayPal transaction ID**. The site never sends money: pay the member from your PayPal/bank first, then record the reference. Members see a note that international PayPal payouts may include PayPal fees and currency conversion. Member-to-member transfers remain impossible.

## Countries & currencies
- **Base currency is INR.** Orders, commissions, wallet balances and payouts are stored and calculated in INR paise; commission maths is unchanged.
- **Country selector** in the header (flag + name). Visitors: saved in the `enx_country` cookie (1 year). Members: saved on their profile (`users.country`; also asked on signup and editable on *Profile*). A member's saved country wins over the cookie. Default: India. Countries without their own currency ("Other") use USD; a disabled currency falls back to INR.
- **Display:** every public/member amount uses the `money(paise)` helper, converted at the admin-set rate. Checkout (shop, orders) and wallet/withdrawal pages also show a small "≈ ₹X" hint for non-INR currencies. Admin pages always show INR.
- **Withdrawals:** a member types the amount in their own currency; the server converts it to INR at the current rate and stores the INR amount plus `req_currency`, `req_amount` and `fx_rate`. The approval page (admin/manager) shows both.
- **Admin → Currencies** (`/admin/currencies`, admin only, managers get 403): edit rates (units per 1 INR), symbols, enable/disable, with last-updated time. Every change is audit-logged. Seeded rates (INR, ZAR, USD, GBP, EUR, AED, CAD, AUD, SGD, MYR, NPR, BDT, LKR, NGN, KES) are **approximate and set by admin**. Update them regularly from a reliable source.
- **Legal note by country:** India shows the Consumer Protection (Direct Selling) Rules, 2021 note. Other countries see "Direct selling rules differ by country; check your local regulations before joining." (Income Plan page + footer).

## Features
- **Public:** Home, Products, Income Plan (+ disclaimer), About, Contact (messages saved for admin), Signup (optional referral code / `?ref=CODE` link), Login.
- **Member:** dashboard (wallet, pending commission, left/right BV, rank by pairs, left & right referral links), profile & password, place order with BV shown (stays *pending* until admin marks paid), my orders (+ buyback request), genealogy, my earnings, my team (downline up to configured depth with each member's paid sales volume), wallet ledger with reason for every entry, withdrawal request to own Bank/UPI or PayPal with country (amount held until processed).
- **Admin (`/admin`):** stats (pending commission, payout % of sales, pending buybacks); members (search, block/activate); products CRUD with **BV %** per product; orders (pending → paid/cancelled, paid → delivered/cancelled/returned); **marking paid runs the binary commission engine** (see below); cancelling a paid order reverses its BV and claws back its commissions and restores stock; manual wallet credit/debit with mandatory reason; withdrawals approve (with UTR / PayPal transaction ID) / reject (funds returned); **Plan settings** (`/admin/plan`, admin only, every change audit-logged with before/after); **Genealogy** (any member's binary tree by username or referral code); **Commission runs** (log of every run, payout-cap scaling, "Run now"); **Buybacks** (approve with refund reference / reject with reason); Approval Managers (limited staff role); settings (team depth, min withdrawal, Grievance Officer details); full audit log; contact messages.

## Compensation plan (binary, product-sales only)
All values below are defaults and can be changed in **Admin → Plan settings** (validated: pair 0–25 %, matching total ≤ 20 %, repurchase total ≤ 30 %, max payout 1–50 %, cooling-off ≥ buyback window).
- **Joining is free.** The ₹1,199 **Starter Kit** (sample product, `public/img/starter-kit.svg`) is optional. BV is set per product (default 60 % of price → kit = 719 BV). Nobody earns anything for recruiting or for someone joining; income comes **only from BV of paid product orders**. There are no member-to-member transfers and no crypto.
- **Placement:** the referral link carries `?ref=CODE&leg=L|R` (or the member picks a leg at signup). The new member goes to the outermost free slot of that leg (auto-spillover). Sponsor (who referred) and placement parent are stored separately.
- **Pair commission:** 10 % of each matched pair (719 BV left + 719 BV right = ₹71.90). Unmatched BV carries forward without expiry. **Daily cap 10 pairs/member/day (IST)**; pairs above the cap are flushed (recorded per day in `pair_days` and disclosed on the Income Plan page). Blocked accounts flush their pairs.
- **Matching bonus:** 5 % (sponsor L1) / 3 % (L2) of the pair income of personally sponsored members.
- **Repurchase commission:** an order is a repurchase when the buyer already has a processed paid order. Its BV still flows up both legs, plus 10 % / 5 % / 5 % of its BV goes up the sponsor line (L1–L3).
- **Payout cap:** each run targets ≤ 38 % of that run's sales. If the gross is higher, all commissions in the run are scaled down proportionally and the scaling is logged (run note + audit log).
- **Ranks** (recognition only, no money): Star 10, Team Manager 100, Director 500, Crown 2000 cumulative pairs.
- **Pending → released:** commissions are created only when an order is marked **paid**, stay *pending* for 30 days (cooling-off = buyback window), then are released to the wallet automatically (lazy release on page loads + "Run now"). A pending buyback request holds release of that order's commissions.
- **Buyback:** within 30 days of the order, unopened, 90 % refund (paid outside the app with a reference). Admin approval marks the order *returned*, restores stock, reverses its BV and claws back all its commissions (pending ones are cancelled, released ones are debited). Legs may go negative after a reversal (disclosed).
- **Idempotency:** `UNIQUE(source_order_id, beneficiary_id, type, level)` plus DB transactions, so re-running never double-pays.
- The old fixed-level (L1/L2/L3) order commission was **removed** and replaced by this plan.
- **Pages:** member *Genealogy* (`/genealogy`, own downline only), *My earnings* (`/earnings`, by type + daily pairs/flush), buyback request on *My orders*; public *Income Plan* (terms, worked example, flush/forfeiture disclosure, consumer rights, income disclosure computed from data), *Buyback policy* (`/buyback-policy`), *Grievance Officer* (`/grievance`, 15-day resolution, details set in Admin → Settings).
- **`DEMO_MODE=1`:** on a DB with no members, `demo.js` seeds 20 demo members (`*_demo`, cannot log in), 41 back-dated paid orders run through the real engine, one pending order and one pending buyback, so the tree, earnings and income disclosure have data. The Income Plan labels the disclosure as **demo data**.
- **Security:** bcrypt password hashes, server-side sessions in SQLite (httpOnly, SameSite=Lax), CSRF token on every POST, Helmet + CSP, login rate limit, input validation, money stored as integer paise, DB transactions for wallet/order changes.

## Two-factor authentication (2FA)
Standard TOTP (RFC 6238: SHA-1, 6 digits, 30-s steps, ±1 step clock tolerance) – works with **Google Authenticator, Authy, Microsoft Authenticator** and any other authenticator app.
- **Where:** admin and managers → **Admin → Security (2FA)** (`/admin/security`); members (optional) → **Security (2FA)** (`/profile/security`).
- **Enable:** click **Enable 2FA** → scan the QR code (or type the setup key shown below it) → enter the current 6-digit code → 2FA is switched on only after that code is correct. **10 one-time backup codes** are shown once – save them (each logs in once if the phone is lost). Other sessions of that account are signed out.
- **Login:** after the correct password the user goes to `/login/2fa` and enters the app code (or a backup code). The step expires after 5 minutes; 5 wrong codes send the user back to the password step (plus per-IP and per-account limits). Each 30-s code works only once; the real session is created only after the code passes.
- **Turn off:** current password + a code (app or backup). **Regenerate backup codes:** current app code.
- **Managers:** admin setting **Require 2FA for managers** (Admin → Settings, default **on**): a manager without 2FA is sent to the Security page after login and can do nothing else until it is set up, and cannot switch it off. If a manager loses the phone and backup codes, the admin clicks **Reset 2FA** on Admin → Approval Managers (signs them out; they set it up again at next login).
- **Storage:** the TOTP secret is encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET` via HKDF); backup codes are stored only as HMAC-SHA256 hashes. Changing `SESSION_SECRET` makes stored secrets unreadable (users then need a reset; `ADMIN_TOTP_SECRET` still works for the admin).
- **Audit log:** 2FA enabled / disabled, backup code used, backup codes regenerated, manager 2FA reset, 2FA enforced from env, settings change.

### Keeping admin 2FA on when the database resets (Render free plan) – `ADMIN_TOTP_SECRET`
On a host without a persistent disk the DB is wiped on every restart, which would also switch 2FA off. Set env var **`ADMIN_TOTP_SECRET`** (base32, spaces/lower-case allowed) and the `admin` account gets 2FA **enforced with that secret at every startup**:
1. Log in as `admin` → **Security (2FA)** → **Enable 2FA** → scan the QR code with the authenticator app → enter the code. Save the 10 backup codes.
2. The page then shows the base32 secret in a yellow box. In Render → service **elitenexa** → **Environment** → add `ADMIN_TOTP_SECRET` = that value → **Save** (the service redeploys).
3. After the redeploy, log in: password, then the 6-digit code from the same app entry. The Security page now says 2FA is enforced by the server setting (it cannot be switched off there; remove the env var to turn it off).
Notes: backup codes live in the DB, so on the free plan they stop working after a restart – generate a new set on the Security page after a restart if you want them (or rely on the env secret, which you can always re-add to a new authenticator). Treat `ADMIN_TOTP_SECRET` like a password. If the value is invalid the server logs a warning and ignores it.

## Tests
`python3 scripts/e2e_test.py http://127.0.0.1:3100` (Python Playwright + Chrome) runs the full flow (signup with referral + leg → order → admin marks paid → binary placement/spillover, pairs, matching, repurchase, daily cap flush, payout cap, pending → release, buyback approve/reject with clawback, plan settings + audit → manual credit/debit → withdrawal approve/reject → cancel reversal → products CRUD → settings → block/activate → Approval Manager permissions (allowed routes 200, forbidden GET/POST 403) → PayPal withdrawal approved by a manager → manager disable/reset → 2FA: forced manager setup, enable flow with QR, login code step, wrong/reused codes, 5-fail lockout, expiry, backup codes once, regenerate, disable, admin reset of a manager's 2FA, require-2FA setting, optional member 2FA, `ADMIN_TOTP_SECRET` enforcement on a throw-away second server (port 3199, fresh DB) → setup-hash tool → CSRF; TOTP codes are computed independently in Python) and saves screenshots to `screenshots/`.

## Deploy
### Free demo on Render (Blueprint)
`render.yaml` defines one free web service `elitenexa` (Node 20, Singapore, `npm ci` / `npm start`, health check `/`). In Render: **New → Blueprint**, pick this GitHub repo, enter a value for `ADMIN_PASSWORD` (12+ chars) when asked; `SESSION_SECRET` is generated automatically. The free plan has **no persistent disk**: the SQLite DB resets on every restart/spin-down (after ~15 min idle), and the app re-seeds the sample products (incl. Starter Kit), the `admin` login and (with `DEMO_MODE=1`) the demo binary-plan data (password = `ADMIN_PASSWORD`). Demo only – use a VPS or a paid plan with a disk for real members.

#### Setting the admin password without typing plaintext into Render
1. In Render → Environment, add `ADMIN_SETUP_TOKEN` = a random string of 24+ characters and save (service redeploys).
2. Open `https://<your-app>.onrender.com/admin/setup-hash?token=<that token>`, enter the new admin password twice (a password manager can generate/save it here, User ID `admin`) and click **Generate hash**. The page does **not** change any account; it only shows a bcrypt (cost 12) hash.
3. Copy the hash into Render env var `ADMIN_PASSWORD_HASH`, **delete `ADMIN_SETUP_TOKEN`** (and `ADMIN_PASSWORD` if set), save. After the redeploy, log in at `/login` as `admin` with that password.
The tool is rate-limited, compares the token in constant time, and returns 404 for a missing/wrong token or when the env var is not set.

### Production
Any host that runs Node and keeps a persistent disk for `data/`:
- **VPS (Hostinger/DigitalOcean/AWS Lightsail):** `git clone`, `npm ci`, `HOST=0.0.0.0 PORT=3100 BASE_URL=https://yourdomain COOKIE_SECURE=1 TRUST_PROXY=1 pm2 start server.js --name elitenexa`, put Nginx + Let's Encrypt in front (`proxy_pass http://127.0.0.1:3100`).
- **Render / Railway:** Node web service, start command `npm start`, attach a persistent volume and set `DATA_DIR` to it, plus the env vars above.
- Back up `data/elitenexa.db` regularly (e.g. `sqlite3 data/elitenexa.db ".backup backup.db"`).
- Not suitable for serverless/static hosts (Netlify, Vercel) because SQLite needs a persistent disk.

## Before going live (checklist)
0. Set `DEMO_MODE` to `0` (or remove it) before real members join; demo members/orders are only seeded on an empty DB.
1. Replace the 4 **SAMPLE** products (Admin → Products) with real products, MRP and photos.
2. Fill in real company details, support email and the **Grievance Officer** (Admin → Settings; placeholder until set) (required by the Direct Selling Rules, 2021), plus Terms, Privacy, Return/Refund policies.
3. Get the plan and documents reviewed by a lawyer/CA (company registration, GST, TDS u/s 194H on commissions, KYC/PAN before payouts).
4. Online payments for orders and automated payouts: integrate a licensed gateway such as **Razorpay** (Payments + Payouts). Today the admin marks orders paid and pays withdrawals manually.
