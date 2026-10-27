"""End-to-end test + screenshots for the local EliteNexa app. Usage: python3 scripts/e2e_test.py [base_url]"""
import re, sys, os, subprocess
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3100'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
# Admin password: ADMIN_PASSWORD env (server started with the same value) or the local ADMIN_CREDENTIALS.txt
ADMIN_PW = os.environ.get('E2E_ADMIN_PW') or os.environ.get('ADMIN_PASSWORD') or re.search(r'Password: (\S+)', open(os.path.join(ROOT, 'ADMIN_CREDENTIALS.txt')).read()).group(1)
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))
def money(txt): return float(re.sub(r'[^\d.\-]', '', txt))
import time; run = str(int(time.time()))[-6:]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    def ctx(): 
        c = b.new_context(viewport={'width': 1366, 'height': 860}); pg = c.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.errs = errs; return pg
    def signup(pg, name, email, ref=None, userid=None):
        pg.goto(BASE + '/signup' + (f'?ref={ref}' if ref else ''))
        userid = userid or email.split('@')[0]
        pg.fill('[name=name]', name); pg.fill('[name=userid]', userid); pg.fill('[name=email]', email); pg.fill('[name=phone]', '9876543210')
        pg.fill('[name=password]', 'Test12345'); pg.fill('[name=password2]', 'Test12345'); pg.check('[name=agree]')
        pg.click('button:has-text("Create free account")')
        try: pg.wait_for_url('**/dashboard', timeout=15000)
        except Exception:
            print('   signup failed on', pg.url, '|', pg.inner_text('main')[:300].replace('\n', ' '), '| invalid:', pg.evaluate("[...document.querySelectorAll('input')].filter(i=>!i.checkValidity()).map(i=>i.name+':'+i.validationMessage)")); raise
        return re.search(r'ref=(EN[A-Z0-9]+)', pg.inner_text('.copybox')).group(1)
    def login(pg, ident, pw):
        pg.goto(BASE + '/login'); pg.fill('[name=login]', ident); pg.fill('[name=password]', pw); pg.click('button:has-text("Log in")'); pg.wait_for_load_state()
    def balance(pg):
        pg.goto(BASE + '/wallet'); return money(pg.inner_text('.stat.big b'))

    pub = ctx()
    pub.goto(BASE + '/'); pub.wait_for_load_state('networkidle')
    check('homepage loads with logo', pub.locator('header .brand img[src*="logo_horizontal"]').count() == 1)
    pub.screenshot(path=f'{SHOTS}/01-homepage.png', full_page=True)
    pub.goto(BASE + '/income-plan'); pub.wait_for_load_state('networkidle')
    t = pub.inner_text('main')
    check('income plan shows disclaimer + DS Rules 2021', 'no guaranteed' in t.lower() or 'not** guarantee' in t or 'does not guarantee' in t.lower().replace('\n',' ') and 'Direct Selling) Rules, 2021' in t)
    pub.screenshot(path=f'{SHOTS}/02-income-plan.png', full_page=True)
    m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
    m.goto(BASE + '/'); m.wait_for_load_state('networkidle')
    check('mobile: no horizontal overflow', m.evaluate('document.documentElement.scrollWidth') <= 391)
    m.screenshot(path=f'{SHOTS}/03-homepage-mobile.png', full_page=False)
    pub.goto(BASE + '/login'); pub.wait_for_load_state('networkidle')
    check('login form asks for "User ID or Email"', 'User ID or Email' in pub.inner_text('form'))
    pub.screenshot(path=f'{SHOTS}/11-login.png')
    pub.goto(BASE + '/signup'); pub.wait_for_load_state('networkidle')
    check('signup form has User ID + password + confirm', pub.locator('[name=userid]').count() == 1 and pub.locator('[name=password]').count() == 1 and pub.locator('[name=password2]').count() == 1)
    pub.screenshot(path=f'{SHOTS}/10-signup.png', full_page=True)
    m.goto(BASE + '/signup'); m.wait_for_load_state('networkidle'); m.screenshot(path=f'{SHOTS}/10b-signup-mobile.png', full_page=True)
    m.goto(BASE + '/login'); m.wait_for_load_state('networkidle'); m.screenshot(path=f'{SHOTS}/11b-login-mobile.png', full_page=False)

    A, B, C = ctx(), ctx(), ctx()
    uidA = f'Asha_{run}'
    codeA = signup(A, 'Asha Sharma', f'asha{run}@example.com', userid=uidA)
    check('signup A (no referral) with chosen User ID', codeA.startswith('EN') and uidA in A.inner_text('main'), codeA)
    # duplicate User ID (different case) rejected; invalid User ID rejected; password mismatch rejected
    D1 = ctx(); D1.goto(BASE + '/signup')
    D1.fill('[name=name]', 'Dup User'); D1.fill('[name=userid]', uidA.upper()); D1.fill('[name=email]', f'dup{run}@example.com'); D1.fill('[name=password]', 'Test12345'); D1.fill('[name=password2]', 'Test12345'); D1.check('[name=agree]')
    D1.click('button:has-text("Create free account")'); check('duplicate User ID (case-insensitive) rejected', 'already taken' in D1.inner_text('main'))
    D1.evaluate("document.querySelector('[name=userid]').removeAttribute('pattern');document.querySelector('[name=userid]').removeAttribute('minlength')")
    D1.fill('[name=userid]', 'a b'); D1.fill('[name=password]', 'Test12345'); D1.fill('[name=password2]', 'Test12345'); D1.check('[name=agree]')
    D1.click('button:has-text("Create free account")'); check('invalid User ID rejected', '4–20 characters' in D1.inner_text('main'))
    D1.fill('[name=userid]', f'dup{run}'); D1.fill('[name=password]', 'Test12345'); D1.fill('[name=password2]', 'Test12399'); D1.check('[name=agree]')
    D1.evaluate("document.querySelector('[name=password2]').setCustomValidity('')"); D1.evaluate("document.querySelector('form.form').noValidate = true")
    D1.click('button:has-text("Create free account")'); check('password mismatch rejected', 'do not match' in D1.inner_text('main'))
    D1.goto(BASE + f'/signup/check-userid?u={uidA.lower()}'); check('live User ID check reports taken', '"ok":false' in D1.inner_text('body'))
    # login with User ID (any case) and with email
    L = ctx(); login(L, uidA.lower(), 'Test12345'); check('login with User ID (case-insensitive)', L.url.endswith('/dashboard'))
    L2 = ctx(); login(L2, f'ASHA{run}@example.com', 'Test12345'); check('login with email', L2.url.endswith('/dashboard'))
    L3 = ctx(); login(L3, uidA, 'wrongpass1'); check('wrong password rejected', 'Incorrect User ID/email or password' in L3.inner_text('main'))
    A.goto(BASE + '/profile'); check('profile shows User ID', A.locator('input[disabled]').first.input_value() == uidA)
    B.goto(BASE + f'/signup?ref={codeA}')
    check('referral link shows sponsor name', 'Asha Sharma' in B.inner_text('main'))
    codeB = signup(B, 'Ravi Kumar', f'ravi{run}@example.com', codeA)
    codeC = signup(C, 'Meena Patel', f'meena{run}@example.com', f'ravi{run}')  # sponsor by User ID
    check('referral via sponsor User ID works', 'Meena Patel' in (B.goto(BASE + '/team') and B.inner_text('main')))
    B.goto(BASE + '/team'); check('B team lists C as L1', 'Meena Patel' in B.inner_text('main'))
    A.goto(BASE + '/team'); tA = A.inner_text('main'); check('A team lists B (L1) and C (L2)', 'Ravi Kumar' in tA and 'Meena Patel' in tA and 'L2' in tA)

    # bad referral code rejected
    X = ctx(); X.goto(BASE + '/signup?ref=ENNOPE99')
    X.fill('[name=name]', 'Bad Ref'); X.fill('[name=userid]', f'badref{run}'); X.fill('[name=email]', f'bad{run}@example.com'); X.fill('[name=password]', 'Test12345'); X.fill('[name=password2]', 'Test12345'); X.check('[name=agree]')
    X.click('button:has-text("Create free account")'); check('invalid referral code rejected', 'not found' in X.inner_text('main'))

    # C places order: first product qty 2
    C.goto(BASE + '/shop'); f = C.locator('form.product').first
    price = money(f.locator('.price').inner_text())
    f.locator('[name=qty]').fill('2'); f.locator('[name=address]').fill('12 MG Road, Pune 411001'); f.locator('button').click()
    C.wait_for_url('**/orders'); ot = C.inner_text('main')
    oid = re.search(r'Order #(\d+) placed', ot).group(1)
    check('order placed with pending status', 'pending' in ot.lower(), f'order #{oid}, total {price*2}')
    check('no commission before payment', balance(B) == 0 and balance(A) == 0)

    AD = ctx(); AD.goto(BASE + '/admin/login'); AD.fill('[name=login]', 'admin'); AD.fill('[name=password]', ADMIN_PW); AD.click('button:has-text("Log in")')
    AD.wait_for_url('**/admin'); check('admin login', AD.url.endswith('/admin'))
    AD.goto(BASE + '/admin/orders?status=pending')
    AD.locator(f'form[action="/admin/orders/{oid}/status"]:has(input[value=paid]) button').click(); AD.wait_for_load_state()
    msg = AD.inner_text('.alert'); print('   admin msg:', msg)
    total = price * 2
    bB, bA = balance(B), balance(A)
    check('L1 commission 10% credited to B', abs(bB - round(total * 0.10, 2)) < 0.01, f'{bB}')
    check('L2 commission 5% credited to A', abs(bA - round(total * 0.05, 2)) < 0.01, f'{bA}')
    check('buyer C gets no commission for own order', balance(C) == 0)
    check('ledger shows reason', 'Level 1 commission (10%)' in B.inner_text('main'))
    # paid twice prevention
    AD.goto(BASE + '/admin/orders'); check('paid order no longer offers "Mark paid"', AD.locator(f'form[action="/admin/orders/{oid}/status"]:has(input[value=paid])').count() == 0)

    # manual credit/debit
    aid = None
    AD.goto(BASE + '/admin/members?q=' + uidA.lower()); check('admin members list shows User ID', uidA in AD.inner_text('main') and 'user id' in AD.inner_text('thead').lower())
    AD.screenshot(path=f'{SHOTS}/12-admin-members.png', full_page=True)
    AD.goto(BASE + '/admin/members?q=' + codeA); aid = re.search(r'member=(\d+)', AD.locator('a[href*="/admin/wallet?member="]').first.get_attribute('href')).group(1)
    AD.goto(BASE + f'/admin/wallet?member={aid}')
    AD.select_option('[name=type]', 'credit'); AD.fill('[name=amount]', '500'); AD.fill('[name=reason]', 'abc'); AD.evaluate("document.querySelector('[name=reason]').removeAttribute('minlength')")
    AD.click('button:has-text("Apply adjustment")'); check('adjustment without proper reason rejected', 'reason' in AD.inner_text('.alert').lower() and 'mandatory' in AD.inner_text('.alert').lower())
    AD.select_option('[name=type]', 'credit'); AD.fill('[name=amount]', '500'); AD.fill('[name=reason]', 'Festive bonus correction – approved by management')
    AD.click('button:has-text("Apply adjustment")'); AD.wait_for_load_state()
    AD.select_option('[name=type]', 'debit'); AD.fill('[name=amount]', '50'); AD.fill('[name=reason]', 'Courier charge recovery for order #' + oid)
    AD.click('button:has-text("Apply adjustment")'); AD.wait_for_load_state()
    exp = round(total * 0.05 + 500 - 50, 2); bA = balance(A)
    check('manual credit ₹500 + debit ₹50 applied', abs(bA - exp) < 0.01, f'{bA} vs {exp}')
    AD.goto(BASE + '/admin/audit'); au = AD.inner_text('main')
    check('audit log records admin + reason', 'wallet credit' in au and 'wallet debit' in au and 'Festive bonus' in au)
    AD.goto(BASE + f'/admin/wallet?member={aid}'); AD.wait_for_load_state('networkidle')
    AD.screenshot(path=f'{SHOTS}/07-admin-wallet-adjustment.png', full_page=True)

    # withdrawal request + approve (A), request + reject (B after credit)
    A.goto(BASE + '/wallet'); A.evaluate("document.querySelector('[name=amount]').removeAttribute('min')"); A.fill('[name=amount]', '100'); A.fill('[name=payout_details]', 'asha@upi'); A.click('button:has-text("Submit request")')
    check('withdrawal below minimum rejected', 'Minimum withdrawal' in A.inner_text('.alert'))
    A.fill('[name=amount]', '99999'); A.fill('[name=payout_details]', 'asha@upi'); A.click('button:has-text("Submit request")')
    check('withdrawal above balance rejected', 'more than your available balance' in A.inner_text('.alert'))
    A.fill('[name=amount]', '500'); A.fill('[name=payout_details]', 'asha@upi'); A.click('button:has-text("Submit request")')
    check('withdrawal request submitted + held', 'submitted' in A.inner_text('.alert') and abs(balance(A) - (exp - 500)) < 0.01)
    AD.goto(BASE + '/admin/withdrawals'); row = AD.locator('tr', has_text='asha@upi').first
    row.locator('[name=reference]').fill('UTR123456789'); row.locator('button[value=approve]').click(); AD.wait_for_load_state()
    check('admin approved withdrawal', 'approved' in AD.inner_text('.alert'))
    A.goto(BASE + '/wallet'); check('member sees approved withdrawal', 'UTR123456789' in A.inner_text('main'))

    AD.goto(BASE + '/admin/members?q=' + codeB); bid = re.search(r'member=(\d+)', AD.locator('a[href*="/admin/wallet?member="]').first.get_attribute('href')).group(1)
    AD.goto(BASE + f'/admin/wallet?member={bid}'); AD.select_option('[name=type]', 'credit'); AD.fill('[name=amount]', '300'); AD.fill('[name=reason]', 'Test credit for withdrawal rejection flow'); AD.click('button:has-text("Apply adjustment")')
    before = balance(B); B.fill('[name=amount]', '500'); B.fill('[name=payout_details]', 'ravi@upi'); B.click('button:has-text("Submit request")')
    AD.goto(BASE + '/admin/withdrawals'); row = AD.locator('tr', has_text='ravi@upi').first
    row.locator('[name=reason]').fill('KYC pending – please upload PAN'); row.locator('button[value=reject]').click(); AD.wait_for_load_state()
    check('rejected withdrawal returns funds', abs(balance(B) - before) < 0.01, f'{balance(B)}')

    # ---------- Approval Manager: create, permissions, actions ----------
    MG_PW = 'MgrPass-' + run + 'xyZ9'; MG_PW2 = 'MgrPass2-' + run + 'abQ7'; mguid = f'mgr{run}'
    AD.goto(BASE + '/admin/managers')
    check('managers page: password fields are new-password', all(AD.locator(f'#new-manager-form [name={n}][type=password][autocomplete=new-password]').count() == 1 for n in ('new_password', 'confirm_password')))
    AD.fill('#mg_name', 'Priya Manager'); AD.fill('#mg_username', mguid); AD.fill('#mg_new_password', MG_PW); AD.fill('#mg_confirm_password', MG_PW + 'x')
    AD.evaluate("document.getElementById('mg_confirm_password').setCustomValidity('')"); AD.click('button:has-text("Create manager")')
    check('manager create: mismatch rejected', 'do not match' in AD.inner_text('main'))
    AD.fill('#mg_new_password', MG_PW); AD.fill('#mg_confirm_password', MG_PW); AD.click('button:has-text("Create manager")'); AD.wait_for_load_state()
    check('manager created', f'{mguid} created' in AD.inner_text('.alert') and AD.locator(f'.manager-row[data-manager="{mguid}"]').count() == 1)
    AD.goto(BASE + '/admin/members?q=' + mguid); check('manager is not listed as a member', mguid not in AD.inner_text('main'))
    MG = ctx(); MG.goto(BASE + '/admin/login'); MG.fill('[name=login]', mguid); MG.fill('[name=password]', MG_PW); MG.click('button:has-text("Log in")'); MG.wait_for_load_state()
    check('manager logs in at /admin/login', MG.url.endswith('/admin'), MG.url)
    side = MG.inner_text('aside.side')
    check('manager sidebar shows only allowed links', all(x in side for x in ('Dashboard', 'Orders', 'Withdrawals')) and not any(x in side for x in ('Wallet adjustments', 'Products', 'Members', 'Settings', 'Audit', 'Approval Managers', 'Messages', 'Change password')))
    for path in ('/admin', '/admin/orders', '/admin/orders?status=pending', '/admin/withdrawals'):
        r = MG.goto(BASE + path); check(f'manager allowed GET {path}', r.status == 200 and '/login' not in MG.url, r.status)
    for path in ('/admin/wallet', '/admin/products', '/admin/products/new', '/admin/products/1/edit', '/admin/members', '/admin/settings', '/admin/managers', '/admin/audit', '/admin/messages', '/admin/password'):
        r = MG.goto(BASE + path); check(f'manager forbidden GET {path} -> 403', r.status == 403, r.status)
    MG.goto(BASE + '/admin'); mtok = MG.locator('input[name=_csrf]').first.input_value()
    for path, data in (('/admin/wallet/adjust', {'user_id': '1', 'type': 'credit', 'amount': '100', 'reason': 'manager should not do this'}),
                       ('/admin/products/save', {'name': 'Hack', 'price': '1', 'stock': '1'}), ('/admin/products/1/delete', {}),
                       ('/admin/members/1/status', {'status': 'blocked'}), ('/admin/settings', {'commission_levels': '50'}),
                       ('/admin/managers', {'name': 'X', 'username': 'mgrhack1', 'new_password': 'x' * 14, 'confirm_password': 'x' * 14}),
                       ('/admin/password', {'current_password': MG_PW, 'new_password': 'y' * 14, 'confirm_password': 'y' * 14})):
        r = MG.request.post(BASE + path, form={'_csrf': mtok, **data}, max_redirects=0); check(f'manager forbidden POST {path} -> 403', r.status == 403, r.status)
    MG.goto(BASE + '/admin'); check('manager dashboard hides audit section', 'Recent admin actions' not in MG.inner_text('main') and 'Approval Manager' in MG.inner_text('main'))

    # manager marks a new pending order paid (C orders again)
    C.goto(BASE + '/shop'); f = C.locator('form.product').first; f.locator('[name=qty]').fill('1'); f.locator('[name=address]').fill('12 MG Road, Pune 411001'); f.locator('button').click()
    C.wait_for_url('**/orders'); oid2 = re.search(r'Order #(\d+) placed', C.inner_text('main')).group(1)
    MG.goto(BASE + '/admin/orders?status=pending'); check('manager sees no "Mark delivered" buttons', MG.locator('input[name=status][value=delivered]').count() == 0)
    MG.locator(f'form[action="/admin/orders/{oid2}/status"]:has(input[name=status][value=paid]) button').click(); MG.wait_for_load_state()
    check('manager marks order paid (commission credited)', f'Order #{oid2} marked paid' in MG.inner_text('.alert'), MG.inner_text('.alert')[:120])
    r = MG.request.post(BASE + f'/admin/orders/{oid2}/status', form={'_csrf': mtok, 'status': 'delivered'}, max_redirects=0)
    MG.goto(BASE + '/admin/orders'); check('manager cannot mark delivered', 'only mark orders paid or cancelled' in MG.inner_text('main'))

    # ---------- PayPal withdrawal (C, South Africa) approved by manager ----------
    AD.goto(BASE + '/admin/members?q=' + codeC); cid = re.search(r'member=(\d+)', AD.locator('a[href*="/admin/wallet?member="]').first.get_attribute('href')).group(1)
    AD.goto(BASE + f'/admin/wallet?member={cid}'); AD.select_option('[name=type]', 'credit'); AD.fill('[name=amount]', '800'); AD.fill('[name=reason]', 'Test credit for PayPal withdrawal flow'); AD.click('button:has-text("Apply adjustment")'); AD.wait_for_load_state()
    C.goto(BASE + '/wallet'); cbal = balance(C)
    check('wallet form has PayPal option + country list', C.locator('select[name=payout_method] option[value=paypal]').count() == 1 and C.locator('select[name=country] option', has_text='South Africa').count() == 1 and C.locator('select[name=country] option', has_text='India').count() == 1)
    C.select_option('[name=payout_method]', 'paypal'); check('PayPal fee/currency note shown', C.locator('#paypal-fee-note').is_visible() and 'currency conversion' in C.inner_text('#paypal-fee-note'))
    C.fill('[name=amount]', '600'); C.evaluate("document.querySelector('[name=paypal_email]').type='text'"); C.fill('[name=paypal_email]', 'not-an-email'); C.select_option('[name=country]', 'South Africa'); C.click('button:has-text("Submit request")')
    check('invalid PayPal email rejected', 'valid PayPal email' in C.inner_text('.alert'))
    C.select_option('[name=payout_method]', 'paypal'); C.fill('[name=amount]', '600'); C.fill('[name=paypal_email]', f'meena{run}@paypal-test.example'); C.select_option('[name=country]', 'South Africa'); C.click('button:has-text("Submit request")')
    check('PayPal withdrawal submitted + held', 'submitted' in C.inner_text('.alert') and abs(balance(C) - (cbal - 600)) < 0.01)
    MG.goto(BASE + '/admin/withdrawals'); check('approval page shows payout note', 'Pay the member from your PayPal/bank first, then enter the transaction ID here. The site does not send money itself.' in MG.inner_text('#payout-note'))
    wrow = MG.locator('tr', has_text=f'meena{run}@paypal-test.example').first
    check('approval shows method, PayPal email, country', 'PayPal' in wrow.locator('.wd-method').inner_text() and wrow.locator('.wd-country').inner_text() == 'South Africa')
    check('approval field labelled PayPal transaction ID', 'PayPal transaction ID' in wrow.locator('form').inner_text())
    wrow.locator('button[value=approve]').click(); MG.wait_for_load_state()
    check('approve without transaction ID rejected', 'PayPal transaction ID' in MG.inner_text('.alert'))
    wrow = MG.locator('tr', has_text=f'meena{run}@paypal-test.example').first
    wrow.locator('[name=reference]').fill('PPTX9AB12345'); wrow.locator('button[value=approve]').click(); MG.wait_for_load_state()
    check('manager approved PayPal withdrawal', 'approved' in MG.inner_text('.alert'))
    C.goto(BASE + '/wallet'); cw = C.inner_text('main'); check('member sees PayPal payout + transaction ID', 'PPTX9AB12345' in cw and 'South Africa' in cw)
    MG.goto(BASE + '/admin/withdrawals'); MG.wait_for_load_state('networkidle'); MG.screenshot(path=f'{SHOTS}/14-manager-withdrawals.png', full_page=True)
    AD.goto(BASE + '/admin/audit'); au = AD.inner_text('main')
    check('audit log records manager actions with username', f'by manager {mguid}' in au and 'PPTX9AB12345' in au and 'manager created' in au)

    # disable / reset manager
    AD.goto(BASE + '/admin/managers'); AD.locator(f'.manager-row[data-manager="{mguid}"] button:has-text("Disable")').click(); AD.wait_for_load_state()
    MG.goto(BASE + '/admin'); check('disabled manager is signed out', '/login' in MG.url)
    M2 = ctx(); login(M2, mguid, MG_PW); check('disabled manager cannot log in', 'blocked' in M2.inner_text('main'))
    AD.goto(BASE + '/admin/managers'); AD.locator(f'.manager-row[data-manager="{mguid}"] button:has-text("Enable")').click(); AD.wait_for_load_state()
    mr = AD.locator(f'.manager-row[data-manager="{mguid}"]'); mr.locator('summary').click()
    check('reset form fields are new-password', mr.locator('input[type=password][autocomplete=new-password]').count() == 2)
    mr.locator('[name=new_password]').fill(MG_PW2); mr.locator('[name=confirm_password]').fill(MG_PW2); mr.locator('button:has-text("Reset password")').click(); AD.wait_for_load_state()
    check('manager password reset', 'reset' in AD.inner_text('.alert'))
    M3 = ctx(); login(M3, mguid, MG_PW); check('old manager password rejected', '/login' in M3.url)
    login(M3, mguid, MG_PW2); check('new manager password works', M3.url.endswith('/admin'))
    AD.goto(BASE + '/admin/managers'); AD.wait_for_load_state('networkidle'); AD.screenshot(path=f'{SHOTS}/15-admin-managers.png', full_page=True)

    # cancel a paid order -> commission reversal
    C.goto(BASE + '/shop'); f = C.locator('form.product').nth(1); p2 = money(f.locator('.price').inner_text())
    f.locator('[name=address]').fill('12 MG Road, Pune 411001'); f.locator('button').click(); C.wait_for_url('**/orders')
    oid2 = re.search(r'Order #(\d+) placed', C.inner_text('main')).group(1)
    b0 = balance(B)
    AD.goto(BASE + '/admin/orders'); AD.locator(f'form[action="/admin/orders/{oid2}/status"]:has(input[value=paid]) button').click(); AD.wait_for_load_state()
    b1 = balance(B)
    AD.on('dialog', lambda d: d.accept())
    AD.goto(BASE + '/admin/orders'); AD.locator(f'form[action="/admin/orders/{oid2}/status"]:has(input[value=cancelled]) button').click(); AD.wait_for_load_state()
    check('cancel after paid reverses commission', abs(b1 - b0 - p2 * 0.10) < 0.01 and abs(balance(B) - b0) < 0.01, f'{b0}->{b1}->{balance(B)}')
    # mark first order delivered
    AD.goto(BASE + '/admin/orders'); AD.locator(f'form[action="/admin/orders/{oid}/status"]:has(input[value=delivered]) button').click(); AD.wait_for_load_state()
    check('order marked delivered', 'delivered' in AD.inner_text('.alert'))

    # products CRUD
    AD.goto(BASE + '/admin/products/new'); AD.fill('[name=name]', f'Test Product {run}'); AD.fill('[name=price]', '1234.50'); AD.fill('[name=stock]', '5'); AD.fill('textarea[name=description]', 'Created by test'); AD.click('button:has-text("Save product")')
    check('admin creates product', f'Test Product {run}' in AD.inner_text('main'))
    AD.locator('tr', has_text=f'Test Product {run}').locator('a:has-text("Edit")').click(); AD.fill('[name=price]', '999'); AD.click('button:has-text("Save product")')
    check('admin edits product', '₹999.00' in AD.locator('tr', has_text=f'Test Product {run}').inner_text())
    AD.locator('tr', has_text=f'Test Product {run}').locator('button:has-text("Delete")').click(); AD.wait_for_load_state()
    check('admin deletes product', f'Test Product {run}' not in AD.inner_text('main'))

    # settings change reflects on income plan
    AD.goto(BASE + '/admin/settings'); AD.fill('[name=commission_levels]', '10, 5, 2, 1'); AD.click('button:has-text("Save settings")')
    pub.goto(BASE + '/income-plan'); check('settings change shows on income plan', 'Level 4' in pub.inner_text('main'))
    AD.goto(BASE + '/admin/settings'); AD.fill('[name=commission_levels]', '10, 5, 2'); AD.click('button:has-text("Save settings")')
    AD.fill('[name=commission_levels]', '40, 30'); AD.click('button:has-text("Save settings")')
    check('settings reject >60% total payout', 'cannot exceed 60%' in AD.inner_text('.alert'))

    # block / activate
    X2 = ctx(); signup(X2, 'Block Test', f'block{run}@example.com')
    AD.goto(BASE + f'/admin/members?q=block{run}'); AD.locator('button:has-text("Block")').first.click(); AD.wait_for_load_state()
    X2.goto(BASE + '/dashboard'); check('blocked member is logged out', '/login' in X2.url)
    X2.fill('[name=login]', f'block{run}@example.com'); X2.fill('[name=password]', 'Test12345'); X2.click('button:has-text("Log in")')
    check('blocked member cannot log in', 'blocked' in X2.inner_text('main'))
    AD.goto(BASE + f'/admin/members?q=block{run}'); AD.locator('button:has-text("Activate")').first.click(); AD.wait_for_load_state()
    check('member re-activated', 'activated' in AD.inner_text('.alert'))

    # member change password
    A.goto(BASE + '/profile/password')
    check('member change-password form fields', all(A.locator(f'[name={n}][autocomplete={ac}]').count() == 1 for n, ac in [('current_password', 'current-password'), ('new_password', 'new-password'), ('confirm_password', 'new-password')]))
    A.fill('[name=current_password]', 'nope12345'); A.fill('[name=new_password]', 'NewPass2026'); A.fill('[name=confirm_password]', 'NewPass2026'); A.click('button:has-text("Change password")')
    check('member change password: wrong current rejected', 'Current password is incorrect' in A.inner_text('main'))
    A.fill('[name=current_password]', 'Test12345'); A.fill('[name=new_password]', 'NewPass2026'); A.fill('[name=confirm_password]', 'NewPass2026'); A.click('button:has-text("Change password")'); A.wait_for_load_state()
    check('member password changed', 'Password changed' in A.inner_text('.alert'))
    L4 = ctx(); login(L4, uidA, 'Test12345'); check('old member password no longer works', '/login' in L4.url)
    login(L4, uidA, 'NewPass2026'); check('new member password works', L4.url.endswith('/dashboard'))
    A.goto(BASE + '/dashboard'); check('changing password keeps current session', A.url.endswith('/dashboard'))
    L.goto(BASE + '/dashboard'); check('other sessions signed out after password change', '/login' in L.url)
    # admin change password (change then revert so ADMIN_CREDENTIALS.txt stays valid)
    AD.goto(BASE + '/admin/password')
    if os.environ.get('ADMIN_PASSWORD') or os.environ.get('ADMIN_PASSWORD_HASH'): check('admin password page notes server-managed password', AD.locator('#env-managed-note').count() == 1)
    else: check('no server-managed note without ADMIN_PASSWORD', AD.locator('#env-managed-note').count() == 0)
    if os.environ.get('DEMO_MODE') == '1':
        check('demo banner shown to admin', AD.locator('#demo-banner').count() == 1)
        AD.click('#demo-banner [data-dismiss]'); check('demo banner dismissible', not AD.locator('#demo-banner').is_visible())
        A.goto(BASE + '/dashboard'); check('demo banner hidden from members', A.locator('#demo-banner').count() == 0)
    check('admin change-password page fields', all(AD.locator(f'[name={n}][autocomplete={ac}]').count() == 1 for n, ac in [('current_password', 'current-password'), ('new_password', 'new-password'), ('confirm_password', 'new-password')]) and AD.locator('[name=username][autocomplete=username]').count() == 1)
    AD.screenshot(path=f'{SHOTS}/13-admin-change-password.png', full_page=True)
    TMP = 'TempAdminPw#' + run
    AD.fill('[name=current_password]', ADMIN_PW); AD.fill('[name=new_password]', TMP); AD.fill('[name=confirm_password]', TMP + 'x')
    AD.evaluate("document.querySelector('#change-password-form').noValidate = true"); AD.evaluate("document.querySelector('[name=confirm_password]').setCustomValidity('')")
    AD.click('button:has-text("Change password")'); check('admin change password: mismatch rejected', 'do not match' in AD.inner_text('main'))
    AD.fill('[name=current_password]', ADMIN_PW); AD.fill('[name=new_password]', 'short'); AD.fill('[name=confirm_password]', 'short')
    AD.evaluate("document.querySelector('#change-password-form').noValidate = true"); AD.click('button:has-text("Change password")'); check('admin change password: <12 chars rejected', 'at least 12' in AD.inner_text('main'))
    AD.fill('[name=current_password]', ADMIN_PW); AD.fill('[name=new_password]', TMP); AD.fill('[name=confirm_password]', TMP); AD.click('button:has-text("Change password")'); AD.wait_for_load_state()
    check('admin password changed', 'Password changed' in AD.inner_text('.alert'))
    L5 = ctx(); login(L5, 'admin', TMP); check('admin logs in with new password', L5.url.endswith('/admin'))
    AD.goto(BASE + '/admin/password'); AD.fill('[name=current_password]', TMP); AD.fill('[name=new_password]', ADMIN_PW); AD.fill('[name=confirm_password]', ADMIN_PW); AD.click('button:has-text("Change password")'); AD.wait_for_load_state()
    L6 = ctx(); login(L6, 'admin', ADMIN_PW); check('admin password reverted to original', L6.url.endswith('/admin'))
    AD.goto(BASE + '/admin/audit'); check('audit log records admin password change', 'admin password changed' in AD.inner_text('main').lower() or 'admin_password_changed' in AD.inner_text('main'))

    # access control
    A.goto(BASE + '/admin'); check('member cannot open admin panel', '/admin' not in A.url.replace(BASE, '')[:6] or '/login' in A.url)
    X3 = ctx(); X3.goto(BASE + '/admin/password'); check('admin change-password requires login', '/login' in X3.url)

    # screenshots of member + admin
    A.goto(BASE + '/dashboard'); A.wait_for_load_state('networkidle'); check('dashboard shows User ID', uidA in A.inner_text('main')); A.screenshot(path=f'{SHOTS}/05-member-dashboard.png', full_page=True)
    A.goto(BASE + '/wallet'); A.wait_for_load_state('networkidle'); A.screenshot(path=f'{SHOTS}/05b-member-wallet.png', full_page=True)
    A.goto(BASE + '/team'); A.wait_for_load_state('networkidle'); A.screenshot(path=f'{SHOTS}/05c-member-team.png', full_page=True)
    AD.goto(BASE + '/admin'); AD.wait_for_load_state('networkidle'); AD.screenshot(path=f'{SHOTS}/06-admin-dashboard.png', full_page=True)
    AD.goto(BASE + '/admin/orders'); AD.wait_for_load_state('networkidle'); AD.screenshot(path=f'{SHOTS}/08-admin-orders.png', full_page=True)
    AD.goto(BASE + '/admin/withdrawals'); AD.wait_for_load_state('networkidle'); AD.screenshot(path=f'{SHOTS}/09-admin-withdrawals.png', full_page=True)
    # one-time admin password-hash tool
    SETUP_TOKEN = os.environ.get('ADMIN_SETUP_TOKEN', '')
    S = ctx()
    if len(SETUP_TOKEN) < 24:
        r = S.goto(BASE + '/admin/setup-hash'); check('setup-hash is 404 when ADMIN_SETUP_TOKEN not set', r.status == 404, r.status)
        r = S.goto(BASE + '/admin/setup-hash?token=' + 'x' * 32); check('setup-hash is 404 with any token when env not set', r.status == 404, r.status)
    else:
        r = S.goto(BASE + '/admin/setup-hash'); check('setup-hash 404 without token', r.status == 404, r.status)
        r = S.goto(BASE + '/admin/setup-hash?token=' + 'x' * len(SETUP_TOKEN)); check('setup-hash 404 with wrong token', r.status == 404, r.status)
        r = S.goto(BASE + '/admin/setup-hash?token=' + SETUP_TOKEN); check('setup-hash form opens with token', r.status == 200, r.status)
        check('setup-hash form fields', all(S.locator(f'input#{n}[name={n}][type=password][autocomplete=new-password]').count() == 1 for n in ('password', 'confirm')) and S.locator('input[type=hidden][name=token]').count() == 1)
        S.fill('#password', 'Short12'); S.fill('#confirm', 'Short12'); S.evaluate("document.querySelectorAll('#setup-hash-form input').forEach(i=>i.removeAttribute('minlength'))"); S.click('button:has-text("Generate hash")')
        check('setup-hash rejects < 12 chars', 'at least 12' in S.inner_text('main') and S.locator('#hash').count() == 0)
        S.fill('#password', 'HashTestPass2026'); S.fill('#confirm', 'HashTestPass2026x'); S.evaluate("document.getElementById('confirm').setCustomValidity('')"); S.click('button:has-text("Generate hash")')
        check('setup-hash rejects mismatch', 'do not match' in S.inner_text('main') and S.locator('#hash').count() == 0)
        S.fill('#password', 'HashTestPass2026'); S.fill('#confirm', 'HashTestPass2026'); S.click('button:has-text("Generate hash")'); S.wait_for_load_state()
        h = S.inner_text('#hash').strip() if S.locator('#hash').count() else ''
        check('setup-hash shows bcrypt cost-12 hash', re.fullmatch(r'\$2[aby]\$12\$[./A-Za-z0-9]{53}', h) is not None)
        check('setup-hash shows instructions', 'Copy this into Render env var ADMIN_PASSWORD_HASH, then remove ADMIN_SETUP_TOKEN.' in S.inner_text('main'))
        check('setup-hash does not echo the password', 'HashTestPass2026' not in S.content())
        ver = subprocess.run(['node', '-e', 'process.stdout.write(String(require("bcryptjs").compareSync(process.argv[1], process.argv[2])))', 'HashTestPass2026', h], capture_output=True, text=True, cwd=ROOT).stdout
        check('setup-hash output verifies with bcrypt', ver == 'true', ver)
        L7 = ctx(); login(L7, 'admin', ADMIN_PW); check('setup-hash did not change admin password', L7.url.endswith('/admin'))
    allerrs = sum([x.errs for x in (pub, A, B, C, AD, MG)], [])
    check('no JS page errors', not allerrs, str(allerrs[:3]))
    b.close()

# CSRF: POST without token must be 403
code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-d', 'login=admin&password=x', BASE + '/login'], capture_output=True, text=True).stdout
check('CSRF: POST without token rejected (403)', code == '403', code)
ok = sum(1 for _, r in results if r); print(f'\n{ok}/{len(results)} checks passed')
sys.exit(0 if ok == len(results) else 1)
