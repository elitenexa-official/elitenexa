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
| `DEMO_MODE` | – | `1` shows admins a dismissible "Demo mode – data resets when the server restarts" banner |
| `TRUST_PROXY` | `loopback` | Trusts X-Forwarded-* from local proxies (cloudflared/Nginx on same box). Set `1` for one remote hop (Render/Railway) |

## Accounts
- Members pick their own **User ID** at signup (4–20 letters/numbers/_, unique case-insensitively) plus a password (min 8, confirmed). Login accepts User ID or email.
- Referral: `?ref=` / the signup field accept a member's referral code **or** their User ID.
- Change password: members `/profile/password`, admin `/admin/password` (12+ chars; other sessions are signed out; audit-logged).

## Features
- **Public:** Home, Products, Income Plan (+ disclaimer), About, Contact (messages saved for admin), Signup (optional referral code / `?ref=CODE` link), Login.
- **Member:** dashboard (wallet, personal/team sales volume, rank progress, referral link), profile & password, place order (stays *pending* until admin marks paid), my orders, my team (downline up to configured depth with each member's paid sales volume), wallet ledger with reason for every entry, withdrawal request (amount held until processed).
- **Admin (`/admin`):** stats; members (search, block/activate); products CRUD; orders (pending → paid/cancelled, paid → delivered/cancelled); **marking paid auto-credits upline commission** per Settings (default L1 10%, L2 5%, L3 2%; total capped at 60%); cancelling a paid order reverses commission and restores stock; manual wallet credit/debit with mandatory reason; withdrawals approve (with UTR ref) / reject (funds returned); settings (commission %, team depth, min withdrawal, rank names & targets); full audit log of admin actions with timestamps; contact messages.
- **Security:** bcrypt password hashes, server-side sessions in SQLite (httpOnly, SameSite=Lax), CSRF token on every POST, Helmet + CSP, login rate limit, input validation, money stored as integer paise, DB transactions for wallet/order changes.

## Tests
`python3 scripts/e2e_test.py http://127.0.0.1:3100` (Python Playwright + Chrome) runs the full flow (signup with referral → order → admin marks paid → L1/L2 commission → manual credit/debit → withdrawal approve/reject → cancel reversal → products CRUD → settings → block/activate → CSRF) and saves screenshots to `screenshots/`.

## Deploy
### Free demo on Render (Blueprint)
`render.yaml` defines one free web service `elitenexa` (Node 20, Singapore, `npm ci` / `npm start`, health check `/`). In Render: **New → Blueprint**, pick this GitHub repo, enter a value for `ADMIN_PASSWORD` (12+ chars) when asked; `SESSION_SECRET` is generated automatically. The free plan has **no persistent disk**: the SQLite DB resets on every restart/spin-down (after ~15 min idle), and the app re-seeds the 4 sample products and the `admin` login (password = `ADMIN_PASSWORD`). Demo only – use a VPS or a paid plan with a disk for real members.

### Production
Any host that runs Node and keeps a persistent disk for `data/`:
- **VPS (Hostinger/DigitalOcean/AWS Lightsail):** `git clone`, `npm ci`, `HOST=0.0.0.0 PORT=3100 BASE_URL=https://yourdomain COOKIE_SECURE=1 TRUST_PROXY=1 pm2 start server.js --name elitenexa`, put Nginx + Let's Encrypt in front (`proxy_pass http://127.0.0.1:3100`).
- **Render / Railway:** Node web service, start command `npm start`, attach a persistent volume and set `DATA_DIR` to it, plus the env vars above.
- Back up `data/elitenexa.db` regularly (e.g. `sqlite3 data/elitenexa.db ".backup backup.db"`).
- Not suitable for serverless/static hosts (Netlify, Vercel) because SQLite needs a persistent disk.

## Before going live (checklist)
1. Replace the 4 **SAMPLE** products (Admin → Products) with real products, MRP and photos.
2. Fill in real company details, support email and **grievance officer** on About/Contact (required by the Direct Selling Rules, 2021), plus Terms, Privacy, Return/Refund policies.
3. Get the plan and documents reviewed by a lawyer/CA (company registration, GST, TDS u/s 194H on commissions, KYC/PAN before payouts).
4. Online payments for orders and automated payouts: integrate a licensed gateway such as **Razorpay** (Payments + Payouts). Today the admin marks orders paid and pays withdrawals manually.
