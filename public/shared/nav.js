/* ═══════════════════════════════════════════
   KEOU AGENCY — App Sidebar Navigation
   Vertical icon sidebar (Lovart-style)
   ═══════════════════════════════════════════ */

const Nav = (() => {
  let _rendered = false;

  // SVG icons for sidebar
  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    pro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  };

  function render(options = {}) {
    const user = Auth.getUser();
    if (!user) return;

    const initials = user.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
    const isAdmin = user.role === 'admin';
    // Opensource edition: basic studio only - no accounts, no enterprise pages.
    const isOS = typeof Auth.isOpensource === 'function' && Auth.isOpensource();
    // Community edition: hosted free tier - full creative suite, BYOK, Pro upsell.
    const isCM = typeof Auth.isCommunity === 'function' && Auth.isCommunity();

    // Auto-detect active from URL
    let active = options.active || '';
    if (!active) {
      const path = window.location.pathname;
      if (path.includes('studio')) active = 'studio';
      else if (path.includes('project')) active = 'projects';
      else if (path.includes('history')) active = 'history';
      else if (path.includes('tools')) active = 'tools';
      // chat disabled for now
      else if (path.includes('analytics')) active = 'analytics';
      else if (path.includes('help')) active = 'help';
      else if (path.includes('dashboard') || path.includes('admin') || path.includes('team')) active = 'dashboard';
    }

    // Build nav items
    const navItems = isOS ? [
      { id: 'studio', label: 'Production Engine', href: '/studio.html' },
    ] : [
      { id: 'studio', label: 'Production Engine', href: '/studio.html' },
      { id: 'projects', label: 'Clients & Campaigns', href: '/projects.html' },
      { id: 'history', label: 'Content Library', href: '/history.html' },
      { id: 'tools', label: 'Creative Tools', href: '/tools.html' },
    ];
    if (!isOS) navItems.push({ id: 'help', label: 'Help', href: '/help.html' });
    if (isCM) navItems.push({ id: 'pro', label: 'Keou Pro — lifetime license', href: '/pro.html' });
    if (isAdmin && !isOS) {
      navItems.push({ id: 'analytics', label: 'Profit Dashboard', href: '/analytics.html' });
      navItems.push({ id: 'dashboard', label: 'Settings', href: '/admin.html' });
    }

    const navHtml = navItems.map(item =>
      `<a class="app-sidebar-item ${active === item.id ? 'active' : ''}" href="${item.href}" data-tooltip="${item.label}">${ICONS[item.id]}</a>`
    ).join('');

    // Create sidebar (replace .navbar if exists, or create new)
    let sidebar = document.querySelector('.app-sidebar');
    const oldNavbar = document.querySelector('.navbar');
    if (oldNavbar) oldNavbar.style.display = 'none';

    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.className = 'app-sidebar';
      document.body.insertBefore(sidebar, document.body.firstChild);
    }

    sidebar.innerHTML = `
      <a class="app-sidebar-logo" href="/studio.html">
        <img src="/logo.png" alt="Keou">
      </a>
      <nav class="app-sidebar-nav">${navHtml}</nav>
      <div class="app-sidebar-credits" id="sidebar-credits" style="margin-top:auto;padding:8px 6px;text-align:center;font-size:9px;color:var(--ink-faint);letter-spacing:.3px;line-height:1.5">
      </div>
      <div class="app-sidebar-bottom" ${isOS ? 'style="display:none"' : ''}>
        <div class="app-sidebar-avatar" id="sidebar-avatar" title="${escapeHtml(user.name)}">${escapeHtml(initials)}</div>
        <div class="app-sidebar-dropdown" id="sidebar-dropdown">
          <div class="nav-dropdown-item" style="pointer-events:none;opacity:.7;font-weight:600">
            <span>${escapeHtml(user.name)}</span>
          </div>
          <div class="nav-dropdown-item" style="pointer-events:none;opacity:.45;font-size:11px;padding-top:0">
            <span>${escapeHtml(user.email)}</span>
          </div>
          <div class="nav-dropdown-divider"></div>
          <a class="nav-dropdown-item" href="/profile.html">
            ${ICONS.profile}
            <span>Profile</span>
          </a>
          ${isAdmin ? `
          <a class="nav-dropdown-item" href="/admin.html">
            ${ICONS.admin}
            <span>Admin</span>
          </a>
          <a class="nav-dropdown-item" href="/team.html">
            ${ICONS.team}
            <span>Team</span>
          </a>
          ` : ''}
          <div class="nav-dropdown-divider"></div>
          <div class="nav-dropdown-item danger" onclick="Auth.logout()">
            ${ICONS.logout}
            <span>Log out</span>
          </div>
        </div>
      </div>
    `;

    // Wrap page content in app-content if not already done
    if (!document.querySelector('.app-content')) {
      const content = document.createElement('div');
      content.className = 'app-content';
      // Move all body children except sidebar into app-content
      const children = [...document.body.children].filter(el => el !== sidebar && el.tagName !== 'SCRIPT');
      children.forEach(el => content.appendChild(el));
      document.body.appendChild(content);
    }

    // ── Mobile Bottom Nav ──
    // Remove any existing mobile nav elements (in case render is called twice)
    document.querySelector('.mobile-bottom-nav')?.remove();
    document.querySelector('.mobile-more-overlay')?.remove();
    document.querySelector('.mobile-more-sheet')?.remove();

    const mainNavItems = isOS ? [
      { id: 'studio', label: 'Studio', href: '/studio.html', icon: ICONS.studio },
    ] : [
      { id: 'studio', label: 'Studio', href: '/studio.html', icon: ICONS.studio },
      { id: 'projects', label: 'Clients', href: '/projects.html', icon: ICONS.projects },
      { id: 'history', label: 'Library', href: '/history.html', icon: ICONS.history },
      { id: 'tools', label: 'Tools', href: '/tools.html', icon: ICONS.tools },
    ];
    const moreActive = ['help', 'dashboard', 'analytics'].includes(active) || !['studio', 'projects', 'history', 'tools'].includes(active);

    const bottomNav = document.createElement('div');
    bottomNav.className = 'mobile-bottom-nav';
    bottomNav.innerHTML = mainNavItems.map(item =>
      `<a class="mobile-bottom-nav-item ${active === item.id ? 'active' : ''}" href="${item.href}">${item.icon}<span>${item.label}</span></a>`
    ).join('') +
      `<button class="mobile-bottom-nav-item ${moreActive ? 'active' : ''}" id="mobile-more-btn" type="button">
        ${ICONS.more}
        <span>More</span>
        <span class="mobile-more-badge" id="mobile-more-badge" hidden></span>
      </button>`;
    document.body.appendChild(bottomNav);

    // ── Floating notifications bell (top-right, all viewports) ────
    // Linear/Notion/Vercel pattern : the bell is a contextual trigger,
    // not a destination — it lives top-right of the viewport, always
    // visible regardless of which page or how far you've scrolled.
    document.querySelector('.notif-fab')?.remove();
    document.querySelector('.mobile-floating-bell')?.remove(); // legacy class cleanup
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'notif-fab';
    fab.id = 'notif-fab';
    fab.setAttribute('aria-label', 'Client feedback');
    fab.innerHTML = `
      ${ICONS.bell}
      <span class="notif-fab-badge" id="notif-fab-badge" hidden></span>
    `;
    document.body.appendChild(fab);

    // Overlay
    const moreOverlay = document.createElement('div');
    moreOverlay.className = 'mobile-more-overlay';
    document.body.appendChild(moreOverlay);

    // Bottom sheet
    const moreSheet = document.createElement('div');
    moreSheet.className = 'mobile-more-sheet';
    moreSheet.innerHTML = `
      <div class="mobile-more-handle"></div>
      <div class="mobile-more-user">${escapeHtml(user.name)}<small>${escapeHtml(user.email)}</small></div>
      <div class="mobile-more-divider"></div>
      <button class="mobile-more-item" id="mobile-bell-btn" type="button">
        ${ICONS.bell}
        <span style="flex:1">Client feedback</span>
        <span class="mobile-more-bell-count" id="mobile-bell-count" hidden></span>
      </button>
      <a class="mobile-more-item" href="/help.html">${ICONS.help}<span>Help</span></a>
      ${isCM ? `<a class="mobile-more-item" href="/pro.html">${ICONS.pro}<span>Keou Pro</span></a>` : ''}
      ${isAdmin ? `<a class="mobile-more-item" href="/analytics.html">${ICONS.analytics}<span>Profit Dashboard</span></a>
      <a class="mobile-more-item" href="/admin.html">${ICONS.dashboard}<span>Settings</span></a>` : ''}
      <div class="mobile-more-divider"></div>
      <a class="mobile-more-item" href="/profile.html">${ICONS.profile}<span>Profile</span></a>
      <button class="mobile-more-item danger" id="mobile-logout-btn" type="button">${ICONS.logout}<span>Log out</span></button>
    `;
    document.body.appendChild(moreSheet);

    // More button toggle
    const moreBtn = document.getElementById('mobile-more-btn');
    if (isOS && moreBtn) moreBtn.style.display = 'none'; // no profile/help/admin sheet in opensource
    const openSheet = () => { moreOverlay.classList.add('open'); moreSheet.classList.add('open'); };
    const closeSheet = () => { moreOverlay.classList.remove('open'); moreSheet.classList.remove('open'); };
    moreBtn?.addEventListener('click', () => {
      if (moreSheet.classList.contains('open')) closeSheet(); else openSheet();
    });
    moreOverlay.addEventListener('click', closeSheet);
    document.getElementById('mobile-logout-btn')?.addEventListener('click', () => { Auth.logout(); });

    // Avatar dropdown toggle
    const avatar = document.getElementById('sidebar-avatar');
    const dropdown = document.getElementById('sidebar-dropdown');
    avatar?.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.toggle('open'); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { dropdown?.classList.remove('open'); closeSheet(); }
    });

    document.addEventListener('click', () => {
      dropdown?.classList.remove('open');
    });

    // Sidebar metric. Credits mode: prepaid balance (all roles). Legacy quota
    // mode: API spend from analytics (admins). Opensource: nothing (404s).
    const navCreditsMode = typeof Auth.isCreditsMode === 'function' && Auth.isCreditsMode();
    if (navCreditsMode) (async () => {
      try {
        const res = await Auth.authFetch('/api/billing/pricing');
        if (res.ok) {
          const d = await res.json();
          const el = document.getElementById('sidebar-credits');
          if (el) {
            el.innerHTML = `<div style="font-weight:700;color:var(--ink);font-size:11px">${(d.creditBalance || 0).toLocaleString()}</div><div>credits</div>`;
          }
          window._keouPricing = d.pricing || null;
        }
      } catch {}
    })();
    else if (isCM && !isAdmin) {
      const el = document.getElementById('sidebar-credits');
      if (el) el.innerHTML = `<a href="/pro.html" style="color:var(--ink-faint);text-decoration:none"><div style="font-weight:700;color:var(--ink);font-size:10px;letter-spacing:.5px">FREE</div><div>plan</div></a>`;
    }
    else if (!isOS) (async () => {
      try {
        const res = await Auth.authFetch('/api/analytics/roi');
        if (res.ok) {
          const d = await res.json();
          const el = document.getElementById('sidebar-credits');
          if (el) {
            const cost = d.keouCost || 0;
            const count = d.totalVisuals || 0;
            el.innerHTML = `<div style="font-weight:700;color:var(--ink);font-size:11px">$${cost.toFixed(2)}</div><div>spent</div><div style="font-weight:600;color:var(--ink-muted);margin-top:4px;font-size:10px">${count}</div><div>assets</div>`;
          }
        }
      } catch {}
    })();

    // ── Feedback notifications bell (enterprise only) ───────────
    if (isOS) { fab.style.display = 'none'; } else
    setupNotificationsBell({ closeMoreSheet: closeSheet });

    // Inject "powered by" into all footers that don't already have it.
    const isCreditsMode = typeof Auth.isCreditsMode === 'function' && Auth.isCreditsMode();
    document.querySelectorAll('footer.footer').forEach(footer => {
      if (footer.querySelector('.footer-powered')) return;
      const socials = footer.querySelector('.footer-socials');
      if (!socials) return;
      const powered = document.createElement('div');
      powered.className = 'footer-powered';
      if (isCreditsMode) { return; } // enterprise builds carry their own branding
      powered.innerHTML = `<span>Powered by</span>
        <a href="https://kie.ai" title="KIE.AI"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg><span>KIE.AI</span></a>
        <svg class="footer-sep" width="3" height="3" viewBox="0 0 3 3"><circle cx="1.5" cy="1.5" r="1.5" fill="currentColor"/></svg>
        <a href="https://fal.ai" title="Fal.ai"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Fal.ai</span></a>
        <svg class="footer-sep" width="3" height="3" viewBox="0 0 3 3"><circle cx="1.5" cy="1.5" r="1.5" fill="currentColor"/></svg>
        <a href="https://anthropic.com" title="Claude by Anthropic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 12l3 3 5-5"/></svg><span>Claude</span></a>`;
      footer.insertBefore(powered, socials);
    });

    _rendered = true;
  }

  // ─── Notifications Bell — feedback aggregator across all projects ───
  // Lifecycle:
  //   - Mounts a hidden panel + binds bell triggers (sidebar + mobile More).
  //   - Polls /api/share/feedback/notifications every 60s and on focus.
  //   - On open, marks all as seen via POST /seen (badge clears next refresh).
  //   - Click on a notification deep-links to /project.html?id=…#feedback-id
  //     so project.html can scroll + flash the matching card.
  function setupNotificationsBell(opts) {
    const closeMoreSheet = opts?.closeMoreSheet || (() => {});
    const fabBell = document.getElementById('notif-fab');
    const fabBadge = document.getElementById('notif-fab-badge');
    const mobileBellBtn = document.getElementById('mobile-bell-btn');
    const mobileBellCount = document.getElementById('mobile-bell-count');
    const mobileMoreBadge = document.getElementById('mobile-more-badge');

    // Build the panel once, append to body. Stays hidden until bell click.
    let panel = document.querySelector('.notif-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'notif-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Client feedback notifications');
      panel.setAttribute('aria-hidden', 'true');
      panel.innerHTML = `
        <div class="notif-panel-handle"></div>
        <div class="notif-panel-head">
          <h3>Client feedback</h3>
          <button class="notif-panel-close" id="notif-panel-close" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="notif-panel-list" id="notif-panel-list">
          <div class="notif-panel-empty" style="padding:32px 20px;text-align:center;color:var(--ink-faint);font-size:13px">Loading…</div>
        </div>
      `;
      document.body.appendChild(panel);

      // Backdrop for click-outside dismiss (mobile bottom sheet pattern)
      const overlay = document.createElement('div');
      overlay.className = 'notif-panel-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', closePanel);

      panel.querySelector('#notif-panel-close').addEventListener('click', closePanel);

      // Esc closes
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
      });
    }

    let cache = { items: [], unreadCount: 0 };
    let pollTimer = null;
    let inFlight = false;

    async function fetchNotifs() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await Auth.authFetch('/api/share/feedback/notifications');
        if (!res.ok) return;
        const data = await res.json();
        cache = data;
        renderBadges(data.unreadCount);
        // If panel is open, refresh its content too
        if (panel.classList.contains('open')) renderItems(data.items);
      } catch {} finally { inFlight = false; }
    }

    function renderBadges(count) {
      const has = count > 0;
      const label = count > 9 ? '9+' : String(count);
      if (fabBadge) {
        fabBadge.hidden = !has;
        fabBadge.textContent = label;
      }
      if (mobileMoreBadge) mobileMoreBadge.hidden = !has;
      if (mobileBellCount) {
        mobileBellCount.hidden = !has;
        mobileBellCount.textContent = String(count);
      }
    }

    function fmtRelative(iso) {
      const d = new Date(iso);
      const sec = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
      if (sec < 60)   return 'just now';
      if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
      return `${Math.floor(sec/86400)}d ago`;
    }

    function escAttr(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
    function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    const TYPE_META = {
      approve: { label: 'Approved',          color: '#10b981' },
      reject:  { label: 'Changes requested', color: '#ef4444' },
      comment: { label: 'Comment',           color: '#6366f1' },
    };

    // Lazy-load lightbox.js if not already loaded — pages that don't ship it
    // by default (e.g. tools.html, billing.html) still need it when the user
    // clicks a notification. Subsequent clicks reuse the cached script.
    let _lightboxLoading = null;
    function ensureLightbox() {
      if (typeof Lightbox !== 'undefined') return Promise.resolve();
      if (_lightboxLoading) return _lightboxLoading;
      _lightboxLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/shared/lightbox.js';
        s.onload = () => resolve();
        s.onerror = () => { _lightboxLoading = null; reject(new Error('lightbox load failed')); };
        document.head.appendChild(s);
      });
      return _lightboxLoading;
    }

    function renderItems(items) {
      const list = panel.querySelector('#notif-panel-list');
      if (!items || !items.length) {
        list.innerHTML = `<div class="notif-panel-empty" style="padding:48px 20px;text-align:center;color:var(--ink-faint);font-size:13px">No client feedback yet.</div>`;
        return;
      }
      list.innerHTML = items.map((it) => {
        const m = TYPE_META[it.type] || { label: it.type, color: 'var(--ink-muted)' };
        const reviewer = it.reviewer_name || 'Anonymous';
        const project = it.project_name || 'Project';
        const campaign = it.campaign_name && it.campaign_name !== 'General' ? ' · ' + escHtml(it.campaign_name) : '';
        const thumbUrl = it.result_url || '';
        const thumbHtml = thumbUrl
          ? `<div class="notif-item-thumb"><img src="${escAttr(thumbUrl)}" alt="" loading="lazy"></div>`
          : `<div class="notif-item-thumb notif-item-thumb-empty"></div>`;
        const comment = it.comment ? `<div class="notif-item-comment">${escHtml(it.comment)}</div>` : '';
        const unreadDot = it.unread ? '<span class="notif-item-dot" aria-hidden="true"></span>' : '';
        // Resolve action only on open items (resolved ones are already done)
        const resolveBtn = it.unread
          ? `<button class="notif-item-resolve" type="button" data-resolve="${it.id}" title="Mark resolved">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
             </button>`
          : '';
        return `
          <div class="notif-item ${it.unread ? 'unread' : ''}" data-fbid="${it.id}" data-pid="${it.project_id}" data-url="${escAttr(thumbUrl)}" data-gentype="${escAttr(it.gen_type || 'image')}" data-fbtype="${escAttr(it.type)}" data-comment="${escAttr(it.comment || '')}" data-reviewer="${escAttr(reviewer)}">
            <button class="notif-item-main" type="button" aria-label="View asset">
              ${thumbHtml}
              <div class="notif-item-body">
                <div class="notif-item-head">
                  <span class="notif-item-type" style="color:${m.color}">${m.label}</span>
                  ${unreadDot}
                  <span class="notif-item-time">${fmtRelative(it.created_at)}</span>
                </div>
                <div class="notif-item-meta"><strong>${escHtml(reviewer)}</strong> · ${escHtml(project)}${campaign}</div>
                ${comment}
              </div>
            </button>
            ${resolveBtn}
          </div>`;
      }).join('');

      // Body click → open Lightbox with the asset, with the comment displayed
      // as the creativeDirection meta so the agency sees what the client said.
      list.querySelectorAll('.notif-item-main').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const item = btn.closest('.notif-item');
          const url = item.dataset.url;
          if (!url) return;
          const isVideo = item.dataset.gentype === 'video' || item.dataset.gentype === 'vid-upscale';
          const fbType = item.dataset.fbtype;
          const comment = item.dataset.comment;
          const reviewer = item.dataset.reviewer;
          const FB_LABEL = { approve: 'Approved', reject: 'Changes requested', comment: 'Comment' };
          closePanel();
          try {
            await ensureLightbox();
            Lightbox.open(url, isVideo ? 'video' : 'image', {
              genType: isVideo ? 'video' : 'image',
              action: FB_LABEL[fbType] || 'Feedback',
              userName: reviewer,
              creativeDirection: comment || null,
            });
          } catch {
            // If lightbox fails to load, fall back to deep-link navigation
            const fbid = item.dataset.fbid;
            const pid = item.dataset.pid;
            window.location.href = `/project.html?id=${encodeURIComponent(pid)}#feedback-${encodeURIComponent(fbid)}`;
          }
        });
      });

      // Inline "Mark resolved" → PATCH then refresh badge. Optimistic UI :
      // the item gets the .resolved class immediately, the resolve button
      // is removed, and the next fetch updates the count.
      list.querySelectorAll('.notif-item-resolve').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fbid = btn.dataset.resolve;
          if (!fbid) return;
          btn.disabled = true;
          btn.style.opacity = '.5';
          try {
            const res = await Auth.authFetch(`/api/share/feedback/${fbid}`, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'resolved' }),
            });
            if (!res.ok) throw new Error('Failed');
            // Optimistic : update the cache locally, then re-render so the
            // resolve button disappears and the unread style is removed.
            const localItem = cache.items?.find(x => String(x.id) === String(fbid));
            if (localItem) { localItem.status = 'resolved'; localItem.unread = false; }
            cache.unreadCount = Math.max(0, (cache.unreadCount || 1) - 1);
            renderBadges(cache.unreadCount);
            renderItems(cache.items);
            // Background refresh in case other tabs already changed state
            fetchNotifs();
          } catch {
            btn.disabled = false;
            btn.style.opacity = '';
          }
        });
      });
    }

    function openPanel() {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      document.querySelector('.notif-panel-overlay')?.classList.add('open');
      renderItems(cache.items);
      // No more POST /seen — the badge is now driven by status='open' count,
      // not by a "I've looked at the bell" timestamp. The badge clears when
      // the user resolves items, not when they peek.
      fetchNotifs();
    }
    function closePanel() {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      document.querySelector('.notif-panel-overlay')?.classList.remove('open');
    }

    fabBell?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('open')) closePanel(); else openPanel();
    });
    mobileBellBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMoreSheet();
      openPanel();
    });

    // Initial fetch + 60s polling. Pause when tab hidden, resume on focus.
    fetchNotifs();
    function startPoll() {
      if (pollTimer) return;
      pollTimer = setInterval(fetchNotifs, 60000);
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPoll();
      else { fetchNotifs(); startPoll(); }
    });
    startPoll();
  }

  return { render };
})();

window.Nav = Nav;

/* ── Scroll Reveal Observer ── */
document.addEventListener('DOMContentLoaded', () => {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => obs.observe(el));
});

/* ── Lazy Image Fade-In ── */
let _imgObserver = null;
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    if (img.complete) { img.classList.add('loaded'); return; }
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  });
  // Disconnect any previous observer before creating a new one (prevents leak on re-init)
  if (_imgObserver) _imgObserver.disconnect();
  _imgObserver = new MutationObserver(mutations => {
    mutations.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) {
        const imgs = n.tagName === 'IMG' ? [n] : n.querySelectorAll?.('img[loading="lazy"]') || [];
        imgs.forEach(img => {
          if (img.complete) { img.classList.add('loaded'); return; }
          img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        });
      }
    }));
  });
  _imgObserver.observe(document.body, { childList: true, subtree: true });
});
// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null; }
});

/* ── Apple-grade page exit (fallback for browsers w/o View Transitions) ──
   Chrome 126+ / Safari 18+ get free crossfade via the @view-transition CSS
   rule. Older browsers fall here: when the user clicks a same-origin link
   we set data-leaving on <html>, which fades the content out for 180ms,
   then we proceed with the navigation. The new page's pageIn animation
   handles the entrance.

   Skipped entirely if:
   - prefers-reduced-motion is set (instant nav)
   - browser already supports View Transitions (handled by @view-transition)
   - modifier keys, target=_blank, downloads, anchor links, cross-origin */
(function setupPageExitTransition() {
  // Reduced motion → never delay nav
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // If startViewTransition exists, the browser will handle the transition
  // natively via the CSS @view-transition rule. Don't double up.
  if (typeof document.startViewTransition === 'function') return;

  let leaving = false;

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || leaving) return;
    if (e.button !== 0) return; // primary button only
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest('a[href]');
    if (!link) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;

    let url;
    try { url = new URL(link.href, location.href); } catch { return; }
    if (url.origin !== location.origin) return;
    // Same path = anchor jump → no transition
    if (url.pathname === location.pathname && url.search === location.search) return;

    e.preventDefault();
    leaving = true;
    document.documentElement.setAttribute('data-leaving', '1');
    // 180ms matches the CSS transition in styles.css "Anchor exit micro-anim"
    setTimeout(() => { window.location.href = link.href; }, 180);
  }, false);

  // Reset the leaving flag if the user uses Back/Forward to land here again
  // (bfcache restore — pageshow fires with persisted=true)
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      document.documentElement.removeAttribute('data-leaving');
      leaving = false;
    }
  });
})();
