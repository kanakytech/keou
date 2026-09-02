/* ═══════════════════════════════════════════
   KEOU STUDIO — Anonymous mode (community edition)
   « Launch Keou » : the FULL studio, no account, BYOK.

   How it works: when studio.html or tools.html finds no session and the
   deployment is the community edition, AnonMode installs itself. It overrides
   Auth.authFetch with a mapper that routes the normal API calls to the
   anonymous endpoints (/api/essai/upload, /api/essai/studio/*). No JWT ever
   exists in this mode — the browser's only capabilities are those endpoints.

   Founder's rules, enforced by the essai pipeline server-side:
   - every anonymous creation is PUBLIC in the community gallery — image,
     video and sound alike
   - images AND video are watermarked studio.kanaky.xyz — sharp stamps the
     image, ffmpeg stamps the video (src/lib/watermark-video.js, installed by
     the Dockerfile). Sound carries none: nothing can be written into an audio
     track without ruining the very thing the visitor came for.
   - the anonymous surfaces offer no download button of their own. That is NOT
     a protection, and this file no longer claims it is — it used to call it
     « the only line left between the anonymous studio and an account ». The
     community viewer carries its own save button, so anything published there
     can be kept by any visitor. What protects the work is the watermark in the
     pixels, not a hidden button. The consent text below says exactly that.
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

  /* La clé d'idempotence du studio doit SUIVRE la requête.
   *
   * public/studio.html pose `idempotencyKey: job.id` sur chaque génération :
   * c'est ce qui permet au serveur de reconnaître deux envois du même travail
   * et de n'en facturer qu'un. L'adaptateur, lui, ne recopiait que le
   * consentement, la source, le format et la direction artistique — la clé
   * tombait ici, en silence. Un double-clic, ou le réessai automatique que
   * studio.html fait après un 500, lançait donc DEUX générations facturées sur
   * la clé KIE.AI du VISITEUR, qui paie de sa poche.
   *
   * Simple passage de champ : rien, côté client, ne dépend de ce que le serveur
   * en fait. Tant que la route anonyme l'ignore, la requête part exactement
   * comme avant ; le jour où elle la lit, la protection joue sans qu'une ligne
   * bouge ici.
   *
   * On ne recopie qu'une chaîne courte et non vide : un objet, ou une clé
   * kilométrique, n'identifie rien et n'a rien à faire dans la charge utile. */
  function reprendreIdempotence(out, body) {
    const cle = body && body.idempotencyKey;
    if (typeof cle === 'string' && cle && cle.length <= 200) out.idempotencyKey = cle;
  }

  // La route de service anonyme s'appelle /api/essai/image/ quel que soit le
  // média rendu : c'est elle qui sert aussi les MP4 et les MP3. On y lit donc
  // l'identifiant d'une création précédente pour l'enchaîner (le serveur
  // retrouve la source lui-même, aucune URL de fournisseur ne circule).
  const ESSAI_IMG_RE = /\/api\/essai\/image\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Opérations non-image du studio : le chemin qu'appelle studio.html (ou
  // tools.html) → l'opération anonyme correspondante. Deux chemins de compte
  // tombent sur le même « upscale » parce que la file anonyme n'agrandit que
  // des images : Topaz vidéo rendrait un MP4 que la chaîne aval n'attend pas
  // à cet endroit.
  // Conséquence assumée : /api/tools/video-upscale part d'un FICHIER vidéo,
  // que l'upload anonyme n'accepte pas (/api/essai/upload ne prend que des
  // images) et que resolveStudioSource refuserait de toute façon. tools.html
  // masque donc cette carte en anonyme ; l'entrée reste ici pour qu'un appel
  // égaré parte quand même vers la file plutôt que vers un 403 muet.
  const MEDIA_ROUTES = {
    '/api/video': 'video',
    '/api/upscale': 'upscale',
    '/api/tools/tts': 'tts',
    '/api/tools/sfx': 'sfx',
    '/api/tools/image-upscale': 'upscale',
    '/api/tools/video-upscale': 'video-upscale',
  };

  // ── The mapper: studio route → anonymous route ──
  async function anonAuthFetch(url, options = {}) {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();

    // Source image upload → anonymous R2 upload
    if (u === '/api/upload' && method === 'POST') {
      return anonFetch('/api/essai/upload', options);
    }

    // Sondage de statut — en anonyme le taskId EST l'uuid essai. Le type de
    // tâche cité par le studio (image, video, upscale…) ne sert qu'à choisir
    // sa route de compte : côté anonyme un seul statut les rend tous, et il
    // annonce lui-même le média obtenu.
    // Le type est donc lu comme un mot quelconque, plus comme une liste fermée :
    // tools.html sonde /api/status/img-upscale/… et /api/status/vid-upscale/…,
    // deux noms que l'énumération ne contenait pas. Ils tombaient dans le 403
    // final, la boucle de sondage avalait l'erreur, et l'agrandissement tournait
    // indéfiniment sur son spinner alors que l'image était prête.
    const st = u.match(/^\/api\/status\/[a-z-]+\/([0-9a-f-]{36})/i);
    // `wait=1` : le serveur retient sa réponse jusqu'à la fin du travail (20 s
    // au plus). Le rendu apparaît à la seconde où il existe, au lieu d'attendre
    // le prochain tour d'un sondage à 6-15 s.
    if (st) return anonFetch(`/api/essai/studio/status/${st[1]}?wait=1`);

    // Generation operations → essai studio pipeline (public gallery output)
    if (method === 'POST' && ['/api/generate', '/api/polish', '/api/remix', '/api/adapt'].includes(u)) {
      // Le clic sur Générer est le moment où le contrat devient réel : on le
      // pose ici plutôt qu'à l'arrivée. Un refus rend le même 412 qu'avant,
      // donc l'appelant n'a rien à savoir de ce changement.
      if (!(await ensureConsent())) {
        return stub({ error: 'Consent required — everything created anonymously is public.' }, 412);
      }
      let body = {};
      try { body = JSON.parse(options.body || '{}'); } catch {}
      const out = { consent: true };
      reprendreIdempotence(out, body);
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

    // Vidéo, agrandissement, voix, bruitage → même pipeline, même galerie.
    // Les paramètres gardent EXACTEMENT le nom qu'ils ont dans les routes d'un
    // compte : la file les reçoit tels quels, et les deux surfaces ne dérivent
    // pas l'une de l'autre au premier réglage ajouté.
    const mediaTarget = method === 'POST' ? MEDIA_ROUTES[u] : undefined;
    if (mediaTarget) {
      // Le clic sur Générer est le moment où le contrat devient réel : on le
      // pose ici plutôt qu'à l'arrivée. Un refus rend le même 412 qu'avant,
      // donc l'appelant n'a rien à savoir de ce changement.
      if (!(await ensureConsent())) {
        return stub({ error: 'Consent required — everything created anonymously is public.' }, 412);
      }
      let body = {};
      try { body = JSON.parse(options.body || '{}'); } catch {}
      const out = { consent: true };
      reprendreIdempotence(out, body);

      // Source : videoUrl couvre les chemins de compte qui agrandissent une
      // vidéo — ici c'est le rendu précédent du visiteur, donc une image.
      const src = String(body.imageUrl || body.videoUrl || body.imgUrl || '');
      if (src) {
        const chained = src.match(ESSAI_IMG_RE);
        if (chained) out.sourceId = chained[1];
        else out.imageUrl = src;
      }

      if (mediaTarget === 'video') {
        for (const k of ['videoModel', 'duration', 'resolution', 'mode', 'sound',
                         'aspectRatio', 'generateAudio', 'variant', 'creativeDirection', 'format']) {
          if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
        }
      } else if (mediaTarget === 'upscale' || mediaTarget === 'video-upscale') {
        if (body.upscaleFactor) out.upscaleFactor = String(body.upscaleFactor);
        if (mediaTarget === 'video-upscale' && out.imageUrl) {
          // La route vidéo lit `videoUrl` : une source externe doit arriver
          // sous ce nom, pas sous celui d'une image.
          out.videoUrl = out.imageUrl;
          delete out.imageUrl;
        }
      } else {
        // Voix et bruitage : le texte du visiteur est le prompt, il passera le
        // filtre de modération côté serveur comme n'importe quel autre.
        out.text = typeof body.text === 'string' ? body.text : '';
        if (mediaTarget === 'tts') {
          if (body.voice) out.voice = body.voice;
          // Réglages fins seulement s'ils sont réellement réglés : un NaN ou un
          // null partirait tel quel chez le fournisseur.
          for (const k of ['stability', 'similarity_boost', 'style', 'speed']) {
            if (Number.isFinite(body[k])) out[k] = body[k];
          }
        } else if (Number.isFinite(body.duration_seconds)) {
          out.duration_seconds = body.duration_seconds;
        }
      }

      return anonFetch(`/api/essai/studio/${mediaTarget}`, {
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
  /* Le consentement ne s'affiche plus à l'arrivée mais au premier acte de
   * création : quelqu'un qui découvre le studio doit pouvoir le regarder,
   * charger une photo et choisir un format avant qu'on lui demande d'accepter
   * quoi que ce soit. Le contrat est le même — il est simplement posé au
   * moment où il devient réel, c'est-à-dire juste avant que quelque chose
   * existe et devienne public. La promesse dit si le visiteur a accepté. */
  function showConsentModal() {
    if (hasConsent()) return Promise.resolve(true);
    const deja = document.getElementById('anon-consent-backdrop');
    if (deja && deja._promesse) return deja._promesse; // deux clics rapides = une seule modale
    const wrap = document.createElement('div');
    wrap.id = 'anon-consent-backdrop';
    /* Les deux conditions qui font renoncer se lisent AVANT le pavé de détail :
     * un visiteur qui survole doit tomber dessus en premier. Le texte détaillé
     * reste tel quel en dessous — c'est lui qui fait foi. (Si un jour le moteur
     * local tourne côté hébergé, la 2e puce — « your own KIE.AI key » — sera à
     * adapter : /api/engine le dira, mais ce modal s'affiche avant ce fetch.) */
    wrap.innerHTML = `
      <div class="anon-consent-card" role="dialog" aria-modal="true" aria-labelledby="anon-consent-title">
        <h3 id="anon-consent-title">Welcome to the anonymous studio</h3>
        <ul class="anon-consent-points">
          <li><b>Everything you create here is public</b> — watermarked, in the community gallery</li>
          <li><b>You bring your own KIE.AI key</b> — billed by KIE, never stored on our servers</li>
        </ul>
        <p>The full Keou studio, free, no account. Paste your own KIE.AI key — it stays in your browser and rides each request, never stored on our servers.</p>
        <p class="anon-consent-rules"><b>Everything you create here is public.</b> Every image, video and sound appears in the <a href="/essai.html" target="_blank" rel="noopener">community gallery</a> with its prompt, visible to everyone. Images and videos carry a studio.kanaky.xyz watermark; sound carries none — nothing can be written into an audio track without ruining it. The gallery viewer has a save button, so any visitor can keep what you make here. Forbidden content (sexual, minors, violence, hate, real people, ID documents) is refused and reportable.</p>
        <p class="anon-consent-alt">Need private client work, your library and downloads? <a href="/login.html">Create a free account</a> instead.</p>
        <div class="anon-consent-actions">
          <button type="button" id="anon-consent-accept">I understand — my creations will be public</button>
          <button type="button" id="anon-consent-leave">Not yet</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    // La modale se déclare role=dialog aria-modal : le focus doit y entrer,
    // y rester, et revenir sur le bouton qui l'a ouverte. Le fond ne défile
    // plus tant qu'elle est là.
    const ouvreur = document.activeElement;
    const scrollAvant = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const promesse = new Promise((resolve) => {
      // Échap = refus. Le listener est retiré dans fermer(), donc quelle que
      // soit la voie de sortie (bouton, fond, Échap) — sinon chaque ouverture
      // en laissait un de plus accroché à document.
      const focusables = () => [...wrap.querySelectorAll('a[href],button:not([disabled])')];
      /* Tab est piloté ENTIÈREMENT ici, jamais laissé au navigateur : WebKit
       * n'inclut pas les liens dans son ordre de tabulation natif, si bien que
       * « laisser passer » envoyait le focus sur body à un tour sur deux. On
       * calcule donc nous-mêmes l'élément suivant, ce qui donne le même
       * comportement sur les deux moteurs. */
      const esc = (e) => {
        if (e.key === 'Escape') { fermer(false); return; }
        if (e.key !== 'Tab') return;
        const f = focusables();
        if (!f.length) return;
        e.preventDefault();
        const i = f.indexOf(document.activeElement);
        const pas = e.shiftKey ? -1 : 1;
        const suivant = i === -1 ? (e.shiftKey ? f.length - 1 : 0) : (i + pas + f.length) % f.length;
        f[suivant].focus();
      };
      const fermer = (accepte) => {
        document.removeEventListener('keydown', esc);
        document.body.style.overflow = scrollAvant;
        if (accepte) storeConsent();
        wrap.remove();
        if (ouvreur && ouvreur.isConnected && typeof ouvreur.focus === 'function') {
          try { ouvreur.focus({ preventScroll: true }); } catch (e) {}
        }
        resolve(accepte);
      };
      wrap.querySelector('#anon-consent-accept').addEventListener('click', () => fermer(true));
      wrap.querySelector('#anon-consent-leave').addEventListener('click', () => fermer(false));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) fermer(false); });
      document.addEventListener('keydown', esc);
    });
    wrap._promesse = promesse;
    wrap.querySelector('#anon-consent-accept').focus();
    return promesse;
  }

  /** Consentement acquis, ou demandé maintenant. Rend true si on peut créer. */
  function ensureConsent() {
    return hasConsent() ? Promise.resolve(true) : showConsentModal();
  }

  // ── Minimal sidebar (Nav.render needs a user — we have none) ──
  function renderNav() {
    if (document.querySelector('.app-sidebar')) return;
    const icons = {
      studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
      gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="9" height="12" rx="2"/><rect x="13" y="5" width="9" height="14" rx="2"/></svg>',
      help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      // Même pictogramme que l'entrée « Creative Tools » de la nav connectée
      // (shared/nav.js) : deux étincelles différentes pour la même page
      // donneraient l'impression de deux produits.
      tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
      pro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      login: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
    };

    // La voix, le bruitage et le générateur de vidéo n'existent QUE sur
    // /tools.html : sans cette entrée, le visiteur sans compte ne pouvait pas
    // les atteindre — il n'y avait aucun bouton pour y aller. L'ordre reprend
    // celui de la nav connectée (studio, …, outils, aide, sur-mesure).
    const items = [
      { id: 'studio', court: 'Studio', href: '/studio.html', label: 'Production Engine', icon: icons.studio },
      { id: 'gallery', court: 'Gallery', href: '/essai.html', label: 'Community gallery', icon: icons.gallery },
      { id: 'tools', court: 'Tools', href: '/tools.html', label: 'Creative Tools', icon: icons.tools },
      { id: 'help', court: 'Help', href: '/help.html', label: 'Help', icon: icons.help },
      { id: 'custom', court: 'Custom', href: '/custom.html', label: 'Custom build — tailored to your workflow', icon: icons.pro },
    ];

    // Même règle que shared/nav.js : l'entrée active se déduit du chemin. Elle
    // était écrite en dur sur le studio, si bien que la barre montrait le
    // studio actif alors qu'on était ailleurs.
    const path = window.location.pathname;
    const active = path.includes('tools') ? 'tools'
      : path.includes('essai') ? 'gallery'
      : path.includes('help') ? 'help'
      : path.includes('custom') ? 'custom'
      : 'studio';

    const sidebar = document.createElement('div');
    sidebar.className = 'app-sidebar';
    sidebar.innerHTML = `
      <a class="app-sidebar-logo" href="/">
        <img src="/logo-keou.png" alt="Keou Studio">
      </a>
      <nav class="app-sidebar-nav">
        ${items.map((it) => `<a class="app-sidebar-item${active === it.id ? ' active' : ''}" href="${it.href}" data-tooltip="${it.label}">${it.icon}</a>`).join('')}
      </nav>
      <div class="app-sidebar-nav" style="margin-top:auto;padding-bottom:12px">
        <a class="app-sidebar-item" href="/login.html" data-tooltip="Sign in / create account">${icons.login}</a>
      </div>`;
    document.body.insertBefore(sidebar, document.body.firstChild);

    /* Une barre du bas pour le mobile — sinon il n'y a AUCUNE navigation.
     *
     * shared/styles.css masque .app-sidebar sous 768 px et donne la main à
     * .mobile-bottom-nav, que shared/nav.js construit pour un compte. Le mode
     * anonyme, lui, n'en construisait pas : sur un téléphone, le studio public
     * n'offrait plus aucun moyen d'atteindre la galerie ni les outils — juste
     * trois liens perdus dans le corps de la page. C'est pourtant le seul
     * chemin praticable pour la majorité des visiteurs.
     *
     * Cinq entrées : au-delà, les cibles deviennent trop étroites pour un
     * pouce. « Se connecter » reste donc hors de cette barre — c'est la seule
     * des six à ne rien apporter à quelqu'un venu essayer sans compte. */
    document.querySelector('.mobile-bottom-nav')?.remove();
    const barreBasse = document.createElement('div');
    barreBasse.className = 'mobile-bottom-nav';
    barreBasse.innerHTML = items.map((it) =>
      `<a class="mobile-bottom-nav-item${active === it.id ? ' active' : ''}" href="${it.href}">`
      + `${it.icon}<span>${it.court || it.label}</span></a>`
    ).join('');
    document.body.appendChild(barreBasse);

    // Le studio décale son contenu de la largeur de la sidebar fixe (60px) via
    // le conteneur .app-content — même mécanique que la nav connectée
    // (shared/nav.js). Sans ce wrap, tout le contenu passait SOUS la sidebar
    // et se retrouvait rogné à gauche (« Get a key » → « a key »).
    if (!document.querySelector('.app-content')) {
      const content = document.createElement('div');
      content.className = 'app-content';
      /* Les surfaces FIXES restent hors du wrap.
       *
       * .app-content porte une animation d'entrée (`pageIn`, qui translate) et,
       * au clic sur un lien, un `transform: translateY(-4px)` posé par
       * html[data-leaving="1"] — les deux dans shared/styles.css. Or un ancêtre
       * transformé devient le bloc conteneur de ses descendants
       * `position:fixed`. Rangée là par mégarde, la barre du bas cessait d'être
       * calée sur le bas de l'ÉCRAN pour se caler sur le bas du CONTENU : hors
       * de vue sur une page longue, et précisément pendant les 180 ms qui
       * suivent le doigt du visiteur. Le voile de consentement, lui, se
       * recentrait sur toute la hauteur du document. Les deux restent donc
       * enfants directs de <body>. */
      const children = [...document.body.children].filter(
        (el) => el !== sidebar && el !== barreBasse
          && el.id !== 'anon-consent-backdrop' && el.tagName !== 'SCRIPT',
      );
      children.forEach((el) => content.appendChild(el));
      document.body.appendChild(content);
    }
  }

  /** Barre de clé BYOK pour les pages anonymes AUTRES que le studio.
   *
   *  studio.html rend la sienne. tools.html n'en avait aucune : un visiteur
   *  qui arrivait directement sur /tools.html n'avait aucun endroit où coller
   *  sa clé KIE.AI, et chaque bouton répondait « API key required » sans lui
   *  dire où la poser. La clé ne quitte jamais ce navigateur — elle part en
   *  en-tête X-Provider-Key à chaque requête, jamais en base.
   */
  function renderByokBar(anchor) {
    const main = anchor || document.querySelector('main') || document.getElementById('app');
    if (!main || !main.parentNode || document.getElementById('byok-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'byok-bar';
    // Même divulgation que la barre du studio : le lien « Get a key » est
    // affilié — dit tel quel — et la note explique qui facture et où vit la clé.
    bar.innerHTML = `
      <div class="byok-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
        <span class="byok-label">API key</span>
        <input type="password" id="byok-input" placeholder="Paste your KIE.AI API key" autocomplete="off" spellcheck="false">
        <button type="button" id="byok-save">Save</button>
        <span id="byok-status"></span>
        <a href="https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793" target="_blank" rel="noopener" class="byok-get">Get a key &#8599;</a><span class="byok-ref">(referral link)</span>
        <a href="/help.html" class="byok-get">Help &amp; docs</a>
      </div>
      <p class="byok-note">KIE.AI is the model provider. Your key stays in this browser and is billed by KIE directly &mdash; we never see it or charge you.</p>`;
    main.parentNode.insertBefore(bar, main);

    const input = bar.querySelector('#byok-input');
    const status = bar.querySelector('#byok-status');
    const refresh = () => {
      const k = Auth.getProviderKey();
      status.textContent = k ? 'Key saved in this browser' : 'No key set';
      status.className = k ? 'ok' : '';
      if (k) input.placeholder = '••••••••••••  (saved)';
    };
    bar.querySelector('#byok-save').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { refresh(); return; } // un Save à vide ne doit pas effacer la clé déjà posée
      Auth.setProviderKey(v);
      input.value = '';
      refresh();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') bar.querySelector('#byok-save').click(); });
    refresh();
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
      .anon-consent-points{margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.6;color:#c9c9c9}
      .anon-consent-points li{margin-bottom:6px}
      .anon-consent-points b{color:#e5e5e5}
      .anon-consent-card p{margin:0 0 12px;font-size:13px;line-height:1.6;color:#a3a3a3}
      .anon-consent-card a{color:#e5e5e5}
      .anon-consent-rules{padding:10px 12px;border:1px solid rgba(255,200,80,.25);
        background:rgba(255,200,80,.06);border-radius:10px}
      .anon-consent-actions{display:flex;flex-direction:column;gap:10px;margin-top:16px}
      #anon-consent-accept{padding:11px 16px;border-radius:10px;border:none;cursor:pointer;
        background:#e5e5e5;color:#0a0a0a;font-weight:600;font-size:13px}
      #anon-consent-leave{text-align:center;font-size:12px;color:#a3a3a3!important}
      /* Barre de clé : mêmes règles que celle écrite dans studio.html, pour
         qu'une page anonyme sans style propre (tools.html) la rende à
         l'identique et pas en champ nu. */
      #byok-bar{max-width:1200px;margin:12px auto 0;padding:0 24px}
      #byok-bar .byok-inner{display:flex;align-items:center;gap:10px;padding:10px 14px;
        border:1px solid var(--line,rgba(255,255,255,.1));border-radius:12px;
        background:rgba(255,255,255,.03);font-size:12px;color:var(--ink-muted,#9a9a9a);flex-wrap:wrap}
      #byok-bar .byok-label{font-weight:600;color:var(--ink,#eee);letter-spacing:.3px}
      #byok-bar input{flex:1;min-width:180px;background:rgba(0,0,0,.25);
        border:1px solid var(--line,rgba(255,255,255,.12));border-radius:8px;
        padding:7px 10px;color:var(--ink,#eee);font-size:12px;outline:none}
      #byok-bar button{background:var(--accent,#c8f060);color:#050505;border:0;border-radius:8px;
        padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer}
      #byok-bar #byok-status.ok{color:#6fcf97}
      #byok-bar .byok-get{color:var(--ink-muted,#9a9a9a);text-decoration:none;border-bottom:1px dotted currentColor}
      #byok-bar .byok-note{margin:6px 2px 0;font-size:11px;color:var(--ink-faint,#8a8a8a);line-height:1.5}
      #byok-bar .byok-ref{font-size:10.5px;color:var(--ink-faint,#8a8a8a)}
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
    return true;
  }

  return { tryInstall, renderNav, renderByokBar, ensureConsent, isActive: () => _active };
})();

window.AnonMode = AnonMode;
