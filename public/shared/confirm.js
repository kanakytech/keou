/* ═══════════════════════════════════════════
   IN-PLATFORM CONFIRM DIALOG
   Replaces native window.confirm() so the browser never pops a
   chrome dialog. Returns a Promise<boolean> like a real confirm.
   Uses the shared kc-modal styles already loaded by styles.css.

   Usage:
     if (!await confirmDialog('Delete this asset?')) return;
     // or with options:
     const ok = await confirmDialog({
       title: 'Delete 5 items',
       message: 'This cannot be undone.',
       confirmLabel: 'Delete',
       danger: true,
     });
   ═══════════════════════════════════════════ */
(function() {
  let _backdrop = null;
  let _resolveCurrent = null;
  let _previousFocus = null;

  function build() {
    if (_backdrop) return;
    _backdrop = document.createElement('div');
    _backdrop.className = 'kc-modal-backdrop';
    _backdrop.id = 'kc-confirm-backdrop';
    _backdrop.setAttribute('aria-hidden', 'true');
    _backdrop.innerHTML = `
      <div class="kc-modal" role="alertdialog" aria-modal="true" aria-labelledby="kc-confirm-title" aria-describedby="kc-confirm-msg">
        <h3 class="kc-modal-title" id="kc-confirm-title">Confirm</h3>
        <p class="kc-modal-sub" id="kc-confirm-msg" style="margin-bottom:24px"></p>
        <div class="kc-modal-actions">
          <button type="button" class="kc-modal-btn secondary" data-act="cancel">Cancel</button>
          <button type="button" class="kc-modal-btn primary" data-act="confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(_backdrop);

    _backdrop.addEventListener('click', (e) => {
      if (e.target === _backdrop) close(false);
      const act = e.target.closest('button')?.dataset?.act;
      if (act === 'cancel') close(false);
      if (act === 'confirm') close(true);
    });

    document.addEventListener('keydown', (e) => {
      if (!_backdrop.classList.contains('active')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });
  }

  function close(value) {
    if (!_backdrop) return;
    _backdrop.classList.remove('active');
    _backdrop.setAttribute('aria-hidden', 'true');
    if (_resolveCurrent) { _resolveCurrent(value); _resolveCurrent = null; }
    if (_previousFocus && typeof _previousFocus.focus === 'function') {
      try { _previousFocus.focus(); } catch {}
    }
    _previousFocus = null;
  }

  /**
   * Show a confirm dialog and return user's choice as a Promise<boolean>.
   * @param {string|object} opts - either the message string, or options object
   * @returns {Promise<boolean>} true if user confirmed, false otherwise
   */
  window.confirmDialog = function(opts) {
    build();
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    const title = o.title || 'Confirm';
    const message = o.message || 'Are you sure?';
    const confirmLabel = o.confirmLabel || 'OK';
    const cancelLabel = o.cancelLabel || 'Cancel';
    const danger = !!o.danger;

    _backdrop.querySelector('#kc-confirm-title').textContent = title;
    _backdrop.querySelector('#kc-confirm-msg').textContent = message;
    const cancelBtn = _backdrop.querySelector('button[data-act="cancel"]');
    const confirmBtn = _backdrop.querySelector('button[data-act="confirm"]');
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.classList.toggle('danger', danger);

    _previousFocus = document.activeElement;
    _backdrop.classList.add('active');
    _backdrop.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      // Default focus on Cancel for destructive actions (safer), Confirm otherwise
      (danger ? cancelBtn : confirmBtn).focus();
    });

    return new Promise((resolve) => { _resolveCurrent = resolve; });
  };
})();
