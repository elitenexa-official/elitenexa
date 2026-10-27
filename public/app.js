document.addEventListener('submit', function (e) {
  var f = e.target;
  if (f.classList && f.classList.contains('confirm') && !window.confirm('Are you sure?')) e.preventDefault();
});
// Live User ID availability check on the signup form
(function () {
  var inp = document.getElementById('userid'), hint = document.getElementById('userid-hint');
  if (!inp || !hint || !window.fetch) return;
  var t = null, def = hint.textContent;
  inp.addEventListener('input', function () {
    clearTimeout(t); var v = inp.value.trim();
    if (!v) { hint.textContent = def; hint.className = 'hint muted'; return; }
    t = setTimeout(function () {
      fetch('/signup/check-userid?u=' + encodeURIComponent(v), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (inp.value.trim() !== v) return;
        hint.textContent = j.message; hint.className = 'hint ' + (j.ok ? 'ok' : 'bad');
      }).catch(function () {});
    }, 350);
  });
})();
// Confirm-password match check (signup + change password forms)
document.addEventListener('input', function (e) {
  var f = e.target.form; if (!f) return;
  var a = f.querySelector('[name=password],[name=new_password]'), b = f.querySelector('[name=password2],[name=confirm_password],[name=confirm]');
  if (a && b && (e.target === a || e.target === b)) b.setCustomValidity(b.value && a.value !== b.value ? 'Passwords do not match.' : '');
});
// Dismissible admin demo-mode banner (remembered for this browser tab session)
(function () {
  var el = document.getElementById('demo-banner'); if (!el) return;
  try { if (sessionStorage.getItem('enx-demo-banner-dismissed') === '1') { el.parentNode.style.display = 'none'; return; } } catch (_) {}
  var btn = el.querySelector('[data-dismiss]');
  if (btn) btn.addEventListener('click', function () {
    el.parentNode.style.display = 'none';
    try { sessionStorage.setItem('enx-demo-banner-dismissed', '1'); } catch (_) {}
  });
})();
// Withdrawal form: show the fields for the chosen payout method
(function () {
  var sel = document.getElementById('payout_method'); if (!sel) return;
  var f = sel.form;
  function sync() {
    var pp = sel.value === 'paypal';
    f.querySelectorAll('.pm-paypal').forEach(function (el) { el.style.display = pp ? '' : 'none'; });
    f.querySelectorAll('.pm-bank').forEach(function (el) { el.style.display = pp ? 'none' : ''; });
    f.querySelector('[name=paypal_email]').required = pp;
    f.querySelector('[name=payout_details]').required = !pp;
  }
  sel.addEventListener('change', sync); sync();
})();
// Header country selector: switch on change
(function () {
  var sel = document.getElementById('country-select'); if (!sel) return;
  sel.addEventListener('change', function () { sel.form.submit(); });
})();
// Withdrawal amount typed in the member's currency: live "≈ ₹X" hint
(function () {
  var inp = document.getElementById('wd_amount'), hint = document.getElementById('wd_inr_hint');
  if (!inp || !hint) return;
  var rate = Number(inp.getAttribute('data-rate')) || 1;
  function upd() {
    var v = Number(inp.value) || 0, inr = v / rate;
    hint.textContent = '≈ ₹' + inr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  inp.addEventListener('input', upd); upd();
})();
