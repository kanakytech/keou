/* ═══════════════════════════════════════════
   KEOU AGENCY — Custom Select 1.0
   Replaces native <select> with dark glass dropdowns.
   Auto-enhances: select.form-input, select.filter-select,
   select.project-select — or call Select.enhance(el).
   ═══════════════════════════════════════════ */

const Select = (() => {
  let _styled = false;

  function _injectStyles() {
    if (_styled) return;
    _styled = true;
    const s = document.createElement('style');
    s.textContent = `
      .ks-select{position:relative;display:inline-flex;width:100%}
      .ks-select-trigger{
        width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;
        cursor:pointer;user-select:none;font-family:'Inter',sans-serif;
        background:rgba(0,0,0,.02);color:var(--ink);
        border:1.5px solid var(--border);border-radius:var(--radius-sm,10px);
        padding:12px 16px;font-size:14px;font-weight:500;
        transition:all .25s ease;outline:none;
        -webkit-tap-highlight-color:transparent;
      }
      .ks-select-trigger:hover{border-color:rgba(0,0,0,.18)}
      .ks-select.open .ks-select-trigger{
        border-color:rgba(0,0,0,.3);
        box-shadow:0 0 0 3px rgba(99,102,241,.08),0 0 0 1px rgba(0,0,0,.08);
      }
      .ks-select-arrow{
        width:16px;height:16px;flex-shrink:0;opacity:.45;
        transition:transform .25s cubic-bezier(.16,1,.3,1),opacity .2s;
      }
      .ks-select.open .ks-select-arrow{transform:rotate(180deg);opacity:.8}

      .ks-select-dropdown{
        position:absolute;top:calc(100% + 6px);right:0;z-index:200;
        min-width:100%;max-width:min(320px,calc(100vw - 32px));width:max-content;
        background:rgba(255,255,255,.98);
        border:1px solid rgba(0,0,0,.08);
        border-radius:var(--radius-sm,10px);
        backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
        box-shadow:0 12px 40px rgba(0,0,0,.1),0 0 0 1px rgba(0,0,0,.04);
        padding:4px;overflow-x:hidden;overflow-y:auto;max-height:240px;
        opacity:0;visibility:hidden;transform:translateY(-6px) scale(.98);
        transition:all .2s cubic-bezier(.16,1,.3,1);
        pointer-events:none;
      }
      .ks-select.open .ks-select-dropdown{
        opacity:1;visibility:visible;transform:translateY(0) scale(1);
        pointer-events:auto;
      }
      .ks-select-option{
        padding:10px 14px;border-radius:8px;cursor:pointer;
        font-size:13px;font-weight:500;color:rgba(0,0,0,.55);
        transition:all .12s ease;display:flex;align-items:center;gap:8px;
        font-family:'Inter',sans-serif;
        white-space:nowrap;
      }
      .ks-select-option:hover{background:rgba(0,0,0,.04);color:#1a1a1a}
      .ks-select-option.selected{color:#1a1a1a;font-weight:600;background:rgba(0,0,0,.06)}
      .ks-select-option.selected::before{
        content:'';width:4px;height:4px;border-radius:50%;background:#1a1a1a;flex-shrink:0;
      }

      /* ── Size: compact (filter-select, project-select) ── */
      .ks-select.compact .ks-select-trigger{padding:8px 12px;font-size:12px;font-weight:600;border-radius:100px}
      .ks-select.compact .ks-select-dropdown{border-radius:12px}
      .ks-select.compact .ks-select-option{padding:8px 12px;font-size:12px}
      .ks-select.compact .ks-select-arrow{width:14px;height:14px}

      /* scrollbar */
      .ks-select-dropdown::-webkit-scrollbar{width:4px}
      .ks-select-dropdown::-webkit-scrollbar-track{background:transparent}
      .ks-select-dropdown::-webkit-scrollbar-thumb{background:rgba(0,0,0,.12);border-radius:4px}

      @media(max-width:480px){
        .ks-select-trigger{padding:10px 14px;font-size:13px}
        .ks-select.compact .ks-select-trigger{padding:7px 10px;font-size:11px}
      }

      /* ── Dark mode (default :root) overrides ── */
      :root .ks-select-trigger{background:rgba(255,255,255,.04)}
      :root .ks-select-trigger:hover{border-color:rgba(255,255,255,.22)}
      :root .ks-select.open .ks-select-trigger{
        border-color:rgba(255,255,255,.3);
        box-shadow:0 0 0 3px rgba(99,102,241,.12),0 0 0 1px rgba(255,255,255,.08);
      }

    `;
    document.head.appendChild(s);
  }

  // Close all open selects
  function _closeAll(except) {
    document.querySelectorAll('.ks-select.open').forEach(el => {
      if (el !== except) el.classList.remove('open');
    });
  }

  // Global: close on outside click
  let _globalBound = false;
  function _bindGlobal() {
    if (_globalBound) return;
    _globalBound = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ks-select')) _closeAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _closeAll();
    });
  }

  /**
   * Enhance a native <select> into a custom dark glass dropdown.
   * @param {HTMLSelectElement} sel
   */
  function enhance(sel) {
    if (sel._ksEnhanced) return;
    sel._ksEnhanced = true;
    _injectStyles();
    _bindGlobal();

    const isCompact = sel.classList.contains('filter-select') || sel.classList.contains('project-select');
    const wasHidden = sel.style.display === 'none' || getComputedStyle(sel).display === 'none';

    // Wrapper
    const wrap = document.createElement('div');
    wrap.className = 'ks-select' + (isCompact ? ' compact' : '');
    if (wasHidden) wrap.style.display = 'none';
    sel.parentNode.insertBefore(wrap, sel);

    // Hide original select but keep in DOM for form submission
    sel.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;overflow:hidden';
    sel.tabIndex = -1;
    wrap.appendChild(sel);

    // Proxy show/hide: watch for JS changing select.style.display
    const origDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style') ||
                           Object.getOwnPropertyDescriptor(Element.prototype, 'style');
    // Simple approach: override display on the wrapper when select display changes
    sel._ksWrap = wrap;

    // Trigger button
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ks-select-trigger';
    trigger.innerHTML = `
      <span class="ks-select-text"></span>
      <svg class="ks-select-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 6l4 4 4-4"/>
      </svg>
    `;
    wrap.insertBefore(trigger, sel);

    // Dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'ks-select-dropdown';
    wrap.appendChild(dropdown);

    // Build options from native select
    function buildOptions() {
      const opts = Array.from(sel.options);
      dropdown.innerHTML = opts.map((opt, i) => `
        <div class="ks-select-option${sel.selectedIndex === i ? ' selected' : ''}" data-index="${i}" data-value="${opt.value}">
          ${opt.textContent}
        </div>
      `).join('');

      // Update trigger text
      const selected = opts[sel.selectedIndex];
      trigger.querySelector('.ks-select-text').textContent = selected ? selected.textContent : '';
    }

    buildOptions();

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('open');
      _closeAll();
      if (willOpen) {
        buildOptions(); // Refresh in case options changed dynamically
        wrap.classList.add('open');
        // Scroll selected option into view
        const selectedOpt = dropdown.querySelector('.selected');
        if (selectedOpt) selectedOpt.scrollIntoView({ block: 'nearest' });
      }
    });

    // Option click
    dropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.ks-select-option');
      if (!opt) return;
      const idx = parseInt(opt.dataset.index, 10);
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      buildOptions();
      wrap.classList.remove('open');
    });

    // Keyboard nav
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        trigger.click();
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (sel.selectedIndex < sel.options.length - 1) {
          sel.selectedIndex++;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          buildOptions();
        }
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (sel.selectedIndex > 0) {
          sel.selectedIndex--;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          buildOptions();
        }
      }
    });

    // Expose refresh for dynamic option changes
    sel._ksRefresh = buildOptions;

    return wrap;
  }

  /**
   * Auto-enhance all selects on the page.
   * Call after DOM is ready or after dynamic content is added.
   */
  function init() {
    document.querySelectorAll('select.form-input, select.filter-select, select.project-select').forEach(enhance);
  }

  /**
   * Refresh a specific select's display (e.g. after JS changes its options).
   * @param {HTMLSelectElement} sel
   */
  function refresh(sel) {
    if (sel._ksRefresh) sel._ksRefresh();
  }

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Delay slightly to let page JS populate selects first
    setTimeout(init, 0);
  }

  return { enhance, init, refresh };
})();

window.Select = Select;
