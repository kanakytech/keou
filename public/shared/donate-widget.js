/* ═══════════════════════════════════════════
   Donate widget — floating bottom-right FAB
   Self-contained: injects its own styles, a BTC
   popover (QR + address + copy) and nothing else.
   Configure via data-attributes on the script tag:
     data-lang="en|fr"   data-project="Keou"
     data-qr="/donate-btc.svg"   data-link="/donate.html"
   ═══════════════════════════════════════════ */
(() => {
  if (window.__donateWidget) return;
  window.__donateWidget = true;

  /* La pastille de don ne se pose que sur NOS propres instances.
   *
   * Elle s'injecte sur chaque page — nav.js la charge partout, et trois pages
   * la déclarent en direct. Sur le déploiement de quelqu'un d'autre, ses
   * visiteurs se verraient proposer de donner à une adresse Bitcoin qui n'est
   * pas la sienne. Le test porte sur le domaine, comme pour kanaky-badge.js :
   * il est disponible au chargement, là où l'édition ne l'est pas encore. */
  const NOUS = ['kanaky.xyz', 'studio.kanaky.xyz', 'formations.kanaky.xyz'];
  const h = location.hostname;
  if (!NOUS.some((d) => h === d || h.endsWith('.' + d))) return;

  const BTC_ADDRESS = 'bc1q5x894tn68d34x7axt46tlcjxqzqpmyfm3d5ks9';
  const cfg = (document.currentScript && document.currentScript.dataset) || {};
  const qrSrc = cfg.qr || '/donate-btc.svg';
  const moreLink = 'link' in cfg ? cfg.link : '/donate.html';

  // data-lang="en|fr|ja" fixes the language; data-lang="auto" follows the
  // host page's <html lang="…"> (and live changes to it — language switchers).
  const TEXTS = {
    en: {
      fab: 'Support the project',
      title: (p) => 'Support ' + p,
      sub: 'This project is free and will stay that way. A Bitcoin donation of any size helps pay the servers and keeps it growing.',
      copy: 'Copy', copied: 'Copied',
      note: 'BTC on the Bitcoin network only.',
      more: 'Learn more',
    },
    fr: {
      fab: 'Soutenir le projet',
      title: (p) => 'Soutenir ' + p,
      sub: 'Ce projet est gratuit et le restera. Un don en Bitcoin, quel que soit le montant, aide à payer les serveurs et à le faire grandir.',
      copy: 'Copier', copied: 'Copié',
      note: 'BTC sur le réseau Bitcoin uniquement.',
      more: 'En savoir plus',
    },
    ja: {
      fab: 'プロジェクトを支援',
      title: (p) => p + 'を支援する',
      sub: 'このプロジェクトは無料で、これからも無料のままです。ビットコインでの寄付は、金額にかかわらず、サーバー費用と開発の継続に役立ちます。',
      copy: 'コピー', copied: 'コピーしました',
      note: '送金はビットコイン（BTC）ネットワークのみ対応です。',
      more: '詳しく見る',
    },
  };
  // Per-language project label: data-project-en / -fr / -ja, falling back to data-project.
  const PROJECT = {
    en: cfg.projectEn || cfg.project || 'Keou',
    fr: cfg.projectFr || cfg.project || 'Keou',
    ja: cfg.projectJa || cfg.project || 'Keou',
  };
  function currentLang() {
    if (cfg.lang && cfg.lang !== 'auto') return TEXTS[cfg.lang] ? cfg.lang : 'en';
    const l = (document.documentElement.lang || '').slice(0, 2).toLowerCase();
    return TEXTS[l] ? l : 'fr';
  }
  let lang = currentLang();
  let T = { ...TEXTS[lang], title: TEXTS[lang].title(PROJECT[lang]) };

  const style = document.createElement('style');
  style.textContent = `
  .dnt-fab{position:fixed;right:20px;bottom:20px;z-index:90;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;background:#f7931a;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(247,147,26,.35),0 2px 6px rgba(0,0,0,.15);transition:transform .2s,box-shadow .2s}
  .dnt-fab:hover{transform:translateY(-2px) scale(1.05);box-shadow:0 10px 26px rgba(247,147,26,.45),0 3px 8px rgba(0,0,0,.18)}
  .dnt-fab svg{width:22px;height:22px}
  .dnt-pop{position:fixed;right:20px;bottom:80px;z-index:91;width:300px;max-width:calc(100vw - 40px);background:#111;color:#f0f0ec;border:1px solid rgba(255,255,255,.12);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.22);padding:22px 20px;text-align:center;opacity:0;transform:translateY(8px) scale(.98);pointer-events:none;transition:opacity .22s,transform .22s;font-family:'Space Grotesk',system-ui,sans-serif}
  .dnt-pop.open{opacity:1;transform:none;pointer-events:auto}
  .dnt-pop h3{margin:0 0 6px;font-size:15.5px;font-weight:700;letter-spacing:-.01em;font-family:'Space Grotesk','Space Grotesk',system-ui,sans-serif}
  .dnt-pop .dnt-sub{font-size:11.5px;color:rgba(240,240,236,.55);line-height:1.6;margin:0 0 14px}
  .dnt-pop .dnt-qr{width:140px;height:140px;margin:0 auto 12px;padding:8px;background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:12px}
  .dnt-pop .dnt-qr img{width:100%;height:100%;display:block}
  .dnt-addr-row{display:flex;gap:6px;margin-bottom:8px}
  .dnt-addr{flex:1;min-width:0;font-family:'Menlo',monospace;font-size:10px;color:#f0f0ec;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 10px;overflow-x:auto;white-space:nowrap;text-align:left;-webkit-overflow-scrolling:touch}
  .dnt-copy{flex:none;border:none;border-radius:9px;background:#c8f060;color:#050505;font:inherit;font-size:11.5px;font-weight:600;padding:0 13px;cursor:pointer;transition:background .2s}
  .dnt-copy:hover{background:#d6f57e}
  .dnt-copy.ok{background:#1a7f37}
  .dnt-note{font-size:10px;color:rgba(240,240,236,.4);margin:0}
  .dnt-more{display:inline-block;margin-top:10px;font-size:11.5px;font-weight:600;color:#c8f060;text-decoration:none}
  .dnt-close{position:absolute;top:10px;right:10px;width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:#9a9a9a;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
  .dnt-close:hover{background:rgba(255,255,255,.08);color:#f0f0ec}
  @media (max-width:760px){body.has-mobile-nav .dnt-fab{bottom:88px}body.has-mobile-nav .dnt-pop{bottom:148px}}
  `;
  document.head.appendChild(style);

  const btcIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5h5a3.25 3.25 0 0 1 0 6.5h-5zM8.5 11.5h5.8a3.25 3.25 0 0 1 0 6.5H8.5z"/><path d="M8.5 5V3.2M12.5 5V3.2M8.5 20.8V18M12.5 20.8V18M8.5 5v13"/></svg>';

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'dnt-fab';
  fab.setAttribute('aria-label', T.fab);
  fab.title = T.fab;
  fab.innerHTML = btcIcon;

  const pop = document.createElement('div');
  pop.className = 'dnt-pop';
  pop.setAttribute('role', 'dialog');

  function renderPop() {
    pop.setAttribute('aria-label', T.title);
    fab.setAttribute('aria-label', T.fab);
    fab.title = T.fab;
    pop.innerHTML = `
    <button type="button" class="dnt-close" aria-label="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <h3>${T.title}</h3>
    <p class="dnt-sub">${T.sub}</p>
    <div class="dnt-qr"><img src="${qrSrc}" alt="Bitcoin QR" loading="lazy"></div>
    <div class="dnt-addr-row">
      <div class="dnt-addr">${BTC_ADDRESS}</div>
      <button type="button" class="dnt-copy">${T.copy}</button>
    </div>
    <p class="dnt-note">${T.note}</p>
    ${moreLink ? `<a class="dnt-more" href="${moreLink}">${T.more}</a>` : ''}
    `;
    bindPop();
  }

  // Follow the host page's language switcher in auto mode.
  if (!cfg.lang || cfg.lang === 'auto') {
    new MutationObserver(() => {
      const l = currentLang();
      if (l !== lang) { lang = l; T = { ...TEXTS[lang], title: TEXTS[lang].title(PROJECT[lang]) }; renderPop(); }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  function mount() {
    // Mobile bottom bars may be rendered by the app after this script runs —
    // re-check a few times so the FAB offsets above them.
    const checkNav = () => {
      if (document.querySelector('.mobile-bottom-nav') || document.querySelector('.mobile-nav')) {
        document.body.classList.add('has-mobile-nav');
      }
    };
    checkNav(); setTimeout(checkNav, 1500); setTimeout(checkNav, 4000);
    document.body.appendChild(fab);
    document.body.appendChild(pop);
  }

  const toggle = (open) => pop.classList.toggle('open', open ?? !pop.classList.contains('open'));
  fab.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });

  function bindPop() {
    pop.querySelector('.dnt-close').addEventListener('click', () => toggle(false));
    const copyBtn = pop.querySelector('.dnt-copy');
    copyBtn.addEventListener('click', async () => {
      const done = () => {
        copyBtn.classList.add('ok');
        copyBtn.textContent = T.copied;
        setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.textContent = T.copy; }, 2000);
      };
      try { await navigator.clipboard.writeText(BTC_ADDRESS); done(); }
      catch {
        const range = document.createRange();
        range.selectNodeContents(pop.querySelector('.dnt-addr'));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        try { if (document.execCommand('copy')) done(); } catch {}
      }
    });
  }
  renderPop();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
