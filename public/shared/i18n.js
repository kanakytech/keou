/* ═══════════════════════════════════════════════════════════
   KEOU STUDIO — bilingue anglais / français
   ═══════════════════════════════════════════════════════════

   Pourquoi ce mécanisme et pas des pages /fr/ séparées :
   l'indexation de kanaky.xyz souffre déjà d'une trentaine de doublons FR/EN
   qui saturent le budget de crawl. Doubler les URLs aggraverait exactement le
   problème qu'on cherche à réduire. Ici, UNE url par page ; la langue se
   choisit côté client et se retient.

   Pourquoi une substitution par nœuds de texte et pas des attributs data-i18n :
   le site fait 2 800 lignes de HTML écrites à la main. Y semer des milliers
   d'attributs serait long, illisible et cassable au moindre remaniement. Le
   dictionnaire associe la phrase anglaise — telle qu'elle est écrite dans le
   HTML — à sa traduction. Le HTML reste la source, lisible, sans balisage
   parasite.

   Contrat :
     · l'anglais est la source. Une chaîne absente du dictionnaire reste en
       anglais plutôt que d'afficher une clé technique.
     · les attributs traduits sont listés dans ATTRS.
     · un MutationObserver rattrape le texte injecté par les scripts de page.
     · window.I18N.t(en) traduit une chaîne pour le code qui construit du DOM.
*/
(function (global) {
  'use strict';

  const STORE_KEY = 'keou.lang';
  const SUPPORTED = ['en', 'fr'];
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label', 'data-tooltip', 'content'];

  // Le dictionnaire vit dans i18n-fr.js, chargé avant ce fichier.
  const DICT = global.KEOU_FR || {};

  /* Motifs à trous.
   *
   *  Un libellé construit par gabarit — `Generation #${id} failed` — rend un
   *  texte différent à chaque affichage : « Generation #42 failed ». Aucune
   *  clé fixe ne peut le rattraper, et il serait resté en anglais pour
   *  toujours. Un motif porte donc des trous {} : la clé devient une petite
   *  expression régulière, et les valeurs capturées reprennent leur place dans
   *  le français. Une quinzaine de libellés seulement sont dans ce cas, on
   *  balaie donc la liste uniquement quand la recherche exacte a échoué. */
  const PATTERNS = Object.entries(global.KEOU_FR_PATTERNS || {}).map(([en, fr]) => ({
    re: new RegExp('^' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('\\{\\}').join('(.+?)') + '$'),
    fr,
  }));

  function byPattern(s) {
    for (const p of PATTERNS) {
      const m = s.match(p.re);
      if (!m) continue;
      let i = 1;
      return p.fr.replace(/\{\}/g, () => m[i++] ?? '');
    }
    return null;
  }

  function resolveLang() {
    try {
      const q = new URLSearchParams(location.search).get('lang');
      if (SUPPORTED.includes(q)) { localStorage.setItem(STORE_KEY, q); return q; }
      const saved = localStorage.getItem(STORE_KEY);
      if (SUPPORTED.includes(saved)) return saved;
    } catch { /* localStorage indisponible : on retombe sur le navigateur */ }
    const nav = (global.navigator?.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED.includes(nav) ? nav : 'en';
  }

  let lang = resolveLang();

  /** Traduit une chaîne. Rend l'anglais tel quel si absent du dictionnaire.
   *
   *  Les clés du dictionnaire sont produites par scripts/i18n-extract.mjs, qui
   *  écrase les blancs multiples en une espace. Un nœud de texte, lui, porte
   *  l'indentation et les sauts de ligne du HTML. Sans la même normalisation
   *  ici, tout paragraphe écrit sur plusieurs lignes resterait en anglais —
   *  silencieusement, ce qui est le pire des cas. On cherche donc sur la forme
   *  normalisée, et on restitue l'espacement de bord du nœud d'origine. */
  function t(en) {
    if (lang === 'en') return en;
    const s = String(en);
    const key = s.trim().replace(/\s+/g, ' ');
    const hit = DICT[key] || byPattern(key);
    if (!hit) return en;
    return s.match(/^\s*/)[0] + hit + s.match(/\s*$/)[0];
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'TEXTAREA']);

  function translateNode(root) {
    if (lang === 'en') return;

    // 1. Nœuds de texte
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let p = n.parentElement;
        while (p) {
          if (SKIP.has(p.tagName) || p.hasAttribute('data-i18n-skip')) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const n of nodes) {
      const out = t(n.nodeValue);
      if (out !== n.nodeValue) n.nodeValue = out;
    }

    // 2. Attributs
    const els = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
    for (const el of els) {
      if (!el.getAttribute) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v || !v.trim()) continue;
        // On ne touche pas aux meta techniques (charset, viewport, og:url…)
        if (a === 'content' && el.tagName === 'META') {
          const n = (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase();
          if (!/description|og:description|og:title|twitter:description|twitter:title/.test(n)) continue;
        }
        const out = t(v);
        if (out !== v) el.setAttribute(a, out);
      }
    }
  }

  function applyLang() {
    document.documentElement.setAttribute('lang', lang);
    if (lang !== 'en') {
      const title = t(document.title);
      if (title !== document.title) document.title = title;
      translateNode(document.body || document.documentElement);
    }
  }

  function setLang(next) {
    if (!SUPPORTED.includes(next) || next === lang) return;
    try { localStorage.setItem(STORE_KEY, next); } catch { /* ignore */ }
    // Un rechargement est plus honnête qu'une traduction inverse approximative :
    // on ne sait pas reconstruire l'anglais depuis le français.
    const u = new URL(location.href);
    u.searchParams.set('lang', next);
    location.href = u.toString();
  }

  /** Le sélecteur de langue. Discret, deux lettres, pas de drapeau —
   *  un drapeau désigne un pays, pas une langue. */
  function mountSwitcher(container) {
    if (!container || container.querySelector('.i18n-switch')) return;
    const wrap = document.createElement('div');
    wrap.className = 'i18n-switch';
    wrap.setAttribute('data-i18n-skip', '');
    wrap.innerHTML = SUPPORTED.map((l) =>
      `<button type="button" data-lang="${l}" class="${l === lang ? 'on' : ''}" aria-label="${l === 'fr' ? 'Français' : 'English'}">${l.toUpperCase()}</button>`
    ).join('<span class="i18n-sep">·</span>');
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-lang]');
      if (b) setLang(b.dataset.lang);
    });
    container.appendChild(wrap);
  }

  function injectStyles() {
    if (document.getElementById('i18n-style')) return;
    const s = document.createElement('style');
    s.id = 'i18n-style';
    s.textContent = `
.i18n-switch{display:inline-flex;align-items:center;gap:4px;margin-left:6px}
.app-sidebar-nav .i18n-switch{margin:10px 0 0;justify-content:center;width:100%}
.app-sidebar-nav .i18n-switch button{padding:4px 5px;font-size:10.5px}
.i18n-switch button{background:none;border:none;padding:5px 7px;border-radius:100px;cursor:pointer;
  font-family:inherit;font-size:11.5px;font-weight:600;letter-spacing:.4px;
  color:rgba(240,240,236,.42);transition:color .18s,background .18s}
.i18n-switch button:hover{color:rgba(240,240,236,.85)}
.i18n-switch button.on{color:#c8f060}
.i18n-sep{color:rgba(240,240,236,.2);font-size:11px}
@media (max-width:640px){.i18n-switch{margin-left:2px}.i18n-switch button{padding:5px}}

/* Le français est environ 25 % plus long que l'anglais. « Fonctionnalités » et
   « Se connecter » suffisaient à faire passer la barre de navigation sur deux
   lignes là où l'anglais tenait sur une. On resserre pour la langue concernée
   plutôt que de raccourcir le vocabulaire : le mot juste prime sur le gabarit,
   et nowrap empêche qu'un libellé se coupe en plein milieu. */
.i18n-float{position:fixed;top:14px;right:16px;z-index:60;background:rgba(12,12,12,.72);
  border:1px solid rgba(240,240,236,.09);border-radius:100px;padding:1px 4px;backdrop-filter:blur(8px)}
@media (max-width:640px){.i18n-float{top:10px;right:10px}}
html[lang="fr"] .lp-nav-links{gap:3px}
html[lang="fr"] .lp-nav-link{padding-left:11px;padding-right:11px}
.lp-nav-link,.tb-links a{white-space:nowrap}
@media (max-width:900px){html[lang="fr"] .lp-nav-link{padding-left:9px;padding-right:9px;font-size:12.5px}}`;
    document.head.appendChild(s);
  }

  /** Où poser le sélecteur, par ordre de préférence. La barre latérale de
   *  l'application est construite par nav.js APRÈS le démarrage : on réessaie
   *  donc tant qu'elle n'existe pas, plutôt que d'abandonner en silence. */
  const SLOTS = ['.lp-nav-links', '.tb-links', '.app-sidebar-nav'];

  /** Repli pour les pages sans barre de navigation. */
  function mountFloating() {
    if (document.querySelector('.i18n-switch')) return;
    const host = document.createElement('div');
    host.className = 'i18n-float';
    document.body.appendChild(host);
    mountSwitcher(host);
  }

  function mountWhereverPossible() {
    for (const sel of SLOTS) {
      const el = document.querySelector(sel);
      if (el) { mountSwitcher(el); return true; }
    }
    return false;
  }

  function boot() {
    injectStyles();
    applyLang();
    if (!mountWhereverPossible()) {
      // Une page d'application construit sa barre latérale après le démarrage :
      // on l'attend. Une page sans barre du tout (connexion, page de partage)
      // n'a rien à attendre — le sélecteur s'y pose tout de suite, en flottant,
      // plutôt que de manquer pendant dix secondes ou de manquer tout court.
      if (document.querySelector('.navbar, .app-sidebar')) {
        const obs = new MutationObserver(() => { if (mountWhereverPossible()) obs.disconnect(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); if (!document.querySelector('.i18n-switch')) mountFloating(); }, 8000);
      } else {
        mountFloating();
      }
    }
    // Rattrape ce que les scripts de page injectent après coup.
    if (lang !== 'en') {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) translateNode(n);
            else if (n.nodeType === 3 && n.nodeValue?.trim()) {
              const out = t(n.nodeValue);
              if (out !== n.nodeValue) n.nodeValue = out;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.I18N = { t, lang: () => lang, setLang, translateNode, SUPPORTED };
})(window);
