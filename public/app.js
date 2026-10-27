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
