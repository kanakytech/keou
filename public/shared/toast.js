/* ═══════════════════════════════════════════
   KEOU AGENCY — Shared Toast System
   Drop-in replacement for inline toast() functions
   Requires .toast element in HTML: <div class="toast" id="toast"></div>
   ═══════════════════════════════════════════ */

let _toastTimeout;
let _toastExitTimeout;

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  if (!el.getAttribute('role')) { el.setAttribute('role', 'alert'); el.setAttribute('aria-live', 'assertive'); }

  // Clear any pending exit
  clearTimeout(_toastTimeout);
  clearTimeout(_toastExitTimeout);
  el.classList.remove('hiding');

  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');

  _toastTimeout = setTimeout(() => {
    el.classList.add('hiding');
    _toastExitTimeout = setTimeout(() => {
      el.classList.remove('show', 'hiding');
    }, 350);
  }, 3700);
}

window.toast = toast;
