/* ═══════════════════════════════════════════
   KC MODAL — accessibility helper
   Auto-installs focus trap + focus restoration on any .kc-modal-backdrop
   that becomes .active. No per-page wiring needed.
   ═══════════════════════════════════════════ */
(function() {
  // Track which element had focus before each modal opened, so we can restore
  // focus on close (per-modal in case multiple stack).
  const focusBefore = new WeakMap();

  function getFocusables(root) {
    return Array.from(root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  // Watch for class changes on every kc-modal-backdrop currently in the DOM,
  // and on any added later via dynamic markup.
  function attachObserver(backdrop) {
    if (backdrop._kcObserved) return;
    backdrop._kcObserved = true;
    new MutationObserver(() => {
      if (backdrop.classList.contains('active')) onOpen(backdrop);
      else onClose(backdrop);
    }).observe(backdrop, { attributes: true, attributeFilter: ['class'] });
    if (backdrop.classList.contains('active')) onOpen(backdrop);
  }

  function onOpen(backdrop) {
    if (!focusBefore.has(backdrop)) {
      focusBefore.set(backdrop, document.activeElement);
    }
    // Move focus to the first focusable element inside the modal once visible.
    requestAnimationFrame(() => {
      const f = getFocusables(backdrop);
      if (f.length === 0) return;
      // Prefer the first input/select/textarea — otherwise first button
      const firstField = f.find(el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
      (firstField || f[0]).focus();
    });
  }

  function onClose(backdrop) {
    const prev = focusBefore.get(backdrop);
    focusBefore.delete(backdrop);
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus(); } catch {}
    }
  }

  // Global Tab handler — trap focus in the topmost visible modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const open = Array.from(document.querySelectorAll('.kc-modal-backdrop.active')).pop();
    if (!open) return;
    const f = getFocusables(open);
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    // If focus has escaped the modal (e.g. user clicked nav), bring it back
    if (!open.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });

  // Initial pass + watch for backdrops added later
  function init() {
    document.querySelectorAll('.kc-modal-backdrop').forEach(attachObserver);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('kc-modal-backdrop')) attachObserver(node);
          node.querySelectorAll?.('.kc-modal-backdrop').forEach(attachObserver);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
