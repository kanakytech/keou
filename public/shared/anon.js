/* ═══════════════════════════════════════════
   KEOU STUDIO — Anonymous mode (community edition)
   « Launch Keou » : the FULL studio, no account, BYOK.

   How it works: when studio.html finds no session and the deployment is the
   community edition, AnonMode installs itself. It overrides Auth.authFetch
   with a mapper that routes the studio's normal API calls to the anonymous
   endpoints (/api/essai/upload, /api/essai/studio/*). No JWT ever exists in
   this mode — the browser's only capabilities are those endpoints.

   Founder's rules, enforced by the essai pipeline server-side:
   - every anonymous creation is PUBLIC in the community gallery
   - watermarked studio.kanaky.xyz, served through a protected proxy route
   - no download buttons in anonymous mode
   - visitor prompts pass the moderation filter
   - the KIE.AI key lives in this browser only (localStorage), rides each
     request as X-Provider-Key, and is never stored server-side.
   ═══════════════════════════════════════════ */

const AnonMode = (() => {
  const CONSENT_KEY = 'keou.anonConsent';
  let _active = false;

  function hasConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
  }
  function storeConsent() {
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch {}
  }

  // ── Low-level fetch with the BYOK header (no Authorization — no session) ──
  function anonFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    const pk = Auth.getProviderKey();
    if (pk) headers['X-Provider-Key'] = pk;
    return fetch(url, { ...options, headers, credentials: 'same-origin' });
  }

  function stub(obj, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
  }

  const ESSAI_IMG_RE = /\/api\/essai\/image\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // ── The mapper: studio route → anonymous route ──
  async function anonAuthFetch(url, options = {}) {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();

    // Source image upload → anonymous R2 upload
    if (u === '/api/upload' && method === 'POST') {
      return anonFetch('/api/essai/upload', options);
    }

    // Status polling — taskId in anonymous mode IS the essai uuid
    const st = u.match(/^\/api\/status\/(?:image|polish)\/([0-9a-f-]{36})/i);
    if (st) return anonFetch(`/api/essai/studio/status/${st[1]}`);

    // Generation operations → essai studio pipeline (public gallery output)
    if (method === 'POST' && ['/api/generate', '/api/polish', '/api/remix', '/api/adapt'].includes(u)) {
      if (!hasConsent()) {
        return stub({ error: 'Consent required — everything created anonymously is public.' }, 412);
      }
      let body = {};
      try { body = JSON.parse(options.body || '{}'); } catch {}
      const out = { consent: true };
      const src = String(body.imgUrl || body.imageUrl || '');
      const chained = src.match(ESSAI_IMG_RE);
      if (chained) out.sourceId = chained[1]; // previous anonymous result → resolved server-side
      else out.imageUrl = src;

      let target;
      if (u === '/api/generate') {
        target = 'generate';
        out.format = body.format || '1:1';
        if (body.creativeDirection) out.creativeDirection = body.creativeDirection;
      } else {
        target = u.slice('/api/'.length); // polish | remix | adapt
        out.format = body.ratio || body.format || '1:1';
        if (u === '/api/remix') out.remixPrompt = body.remixPrompt || '';
      }
      return anonFetch(`/api/essai/studio/${target}`, {
        method: 'POST',
        body: JSON.stringify(out),
        signal: options.signal,
      });
    }

    // Harmless stubs so the studio UI renders without account features
    if (u.startsWith('/api/projects') && method === 'GET') return stub({ projects: [] });
    if (u.startsWith('/api/campaigns')) return stub({ campaigns: [] });
    if (u.startsWith('/api/activity')) return stub({ items: [] });
    if (u.startsWith('/api/pending')) return stub({ items: [] });
    if (u.startsWith('/api/generate/packs')) return stub({ packs: [] });
    if (u === '/api/report-failure') return stub({ ok: true }); // essai pipeline finalizes failures itself

    // Everything else structurally needs an account
    return stub({ error: 'This feature needs an account — sign in to use it.' }, 403);
  }

  // ── Consent modal (blocking, first visit) ──
  function showConsentModal() {
    if (hasConsent() || document.getElementById('anon-consent-backdrop')) return;
    const wrap = document.createElement('div');
    wrap.id = 'anon-consent-backdrop';
    wrap.innerHTML = `
      <div class="anon-consent-card" role="dialog" aria-modal="true" aria-labelledby="anon-consent-title">
        <h3 id="anon-consent-title">Welcome to the anonymous studio</h3>
        <p>The full Keou studio, free, no account. Paste your own KIE.AI key — it stays in your browser and rides each request, never stored on our servers.</p>
        <p class="anon-consent-rules"><b>Everything you create here is public.</b> Each visual appears in the <a href="/essai.html" target="_blank" rel="noopener">community gallery</a> with its prompt, visible to everyone. Creations carry a studio.kanaky.xyz watermark and stay on the platform (no downloads). Forbidden content (sexual, minors, violence, hate, real people, ID documents) is refused and reportable.</p>
        <p class="anon-consent-alt">Need private client work, your library and downloads? <a href="/login.html">Create a free account</a> instead.</p>
        <div class="anon-consent-actions">
          <button type="button" id="anon-consent-accept">I understand — my creations will be public</button>
          <a href="/" id="anon-consent-leave">Back to the site</a>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#anon-consent-accept').addEventListener('click', () => {
      storeConsent();
      wrap.remove();
    });
  }

  // ── Minimal sidebar (Nav.render needs a user — we have none) ──
  function renderNav() {
    if (document.querySelector('.app-sidebar')) return;
    const icons = {
      studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
      gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="9" height="12" rx="2"/><rect x="13" y="5" width="9" height="14" rx="2"/></svg>',
      help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      pro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      login: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
    };
    const sidebar = document.createElement('div');
    sidebar.className = 'app-sidebar';
    sidebar.innerHTML = `
      <a class="app-sidebar-logo" href="/">
        <img src="/logo-keou.png" alt="Keou Studio">
      </a>
      <nav class="app-sidebar-nav">
        <a class="app-sidebar-item active" href="/studio.html" data-tooltip="Production Engine">${icons.studio}</a>
        <a class="app-sidebar-item" href="/essai.html" data-tooltip="Community gallery">${icons.gallery}</a>
        <a class="app-sidebar-item" href="/help.html" data-tooltip="Help">${icons.help}</a>
        <a class="app-sidebar-item" href="/custom.html" data-tooltip="Custom build — tailored to your workflow">${icons.pro}</a>
      </nav>
      <div class="app-sidebar-nav" style="margin-top:auto;padding-bottom:12px">
        <a class="app-sidebar-item" href="/login.html" data-tooltip="Sign in / create account">${icons.login}</a>
      </div>`;
    document.body.insertBefore(sidebar, document.body.firstChild);

    // Le studio décale son contenu de la largeur de la sidebar fixe (60px) via
    // le conteneur .app-content — même mécanique que la nav connectée
    // (shared/nav.js). Sans ce wrap, tout le contenu passait SOUS la sidebar
    // et se retrouvait rogné à gauche (« Get a key » → « a key »).
    if (!document.querySelector('.app-content')) {
      const content = document.createElement('div');
      content.className = 'app-content';
      const children = [...document.body.children].filter(
        (el) => el !== sidebar && el.tagName !== 'SCRIPT',
      );
      children.forEach((el) => content.appendChild(el));
      document.body.appendChild(content);
    }
  }

  // ── Anonymous-mode CSS (hide account-only affordances) ──
  function injectCss() {
    const css = document.createElement('style');
    css.textContent = `
      body.keou-anon .lb-dl{display:none!important}
      body.keou-anon #download-all-btn{display:none!important}
      body.keou-anon .studio-controls .project-select{display:none!important}
      #anon-consent-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);
        backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px}
      .anon-consent-card{max-width:480px;width:100%;background:#141414;border:1px solid rgba(255,255,255,.1);
        border-radius:16px;padding:28px;color:#e5e5e5}
      .anon-consent-card h3{margin:0 0 12px;font-size:18px}
      .anon-consent-card p{margin:0 0 12px;font-size:13px;line-height:1.6;color:#a3a3a3}
      .anon-consent-card a{color:#e5e5e5}
      .anon-consent-rules{padding:10px 12px;border:1px solid rgba(255,200,80,.25);
        background:rgba(255,200,80,.06);border-radius:10px}
      .anon-consent-actions{display:flex;flex-direction:column;gap:10px;margin-top:16px}
      #anon-consent-accept{padding:11px 16px;border-radius:10px;border:none;cursor:pointer;
        background:#e5e5e5;color:#0a0a0a;font-weight:600;font-size:13px}
      #anon-consent-leave{text-align:center;font-size:12px;color:#a3a3a3!important}
    `;
    document.head.appendChild(css);
  }

  // ── Block the lightbox 'D' download shortcut in anonymous mode ──
  function blockDownloadShortcut() {
    document.addEventListener('keydown', (e) => {
      if (!_active) return;
      if (e.key !== 'd' && e.key !== 'D') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.stopImmediatePropagation(); // the lightbox's document handler never fires
    }, true);
  }

  /**
   * Entry point from studio.html: no session exists. If this deployment is
   * the community edition, install anonymous mode and return true; otherwise
   * return false (caller falls back to the normal login guard).
   */
  async function tryInstall() {
    try {
      const res = await fetch('/api/auth/agency', { credentials: 'same-origin' });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.edition !== 'community') return false;
    } catch { return false; }

    _active = true;
    // Teach the Auth singleton the edition (drives IS_CM/BYOK-bar branches);
    // no token, no user — anonymous mode has no session by construction.
    Auth.setAuth({ accessToken: null, user: null, edition: 'community' });
    Auth.authFetch = anonAuthFetch;
    injectCss();
    blockDownloadShortcut();
    showConsentModal();
    return true;
  }

  return { tryInstall, renderNav, isActive: () => _active };
})();

window.AnonMode = AnonMode;
