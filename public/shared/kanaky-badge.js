/* kanaky-badge.js — retour vers kanaky.xyz depuis les plateformes.
 * Pastille flottante toujours visible + transition constellation
 * (voile sombre, lance lime — le pont visuel vers le site mère). */
(function () {
  if (window.__KHOME) return; window.__KHOME = 1;

  /* La pastille ne se pose que sur NOS propres instances.
   *
   * Le README promet « no attribution requirement » : imposer un renvoi
   * permanent vers notre site sur le déploiement de quelqu'un d'autre dirait le
   * contraire. Le critère est le domaine, et non l'édition : Auth.isOpensource()
   * n'est pas fiable ici — auth.js initialise l'édition à « enterprise » et
   * n'apprend la vraie qu'après un appel réseau, bien après ce script. Et six
   * pages chargent ce fichier par une balise directe, sans passer par nav.js :
   * garder le test ici est la seule place qui les couvre toutes. */
  var NOUS = ['kanaky.xyz', 'studio.kanaky.xyz', 'formations.kanaky.xyz'];
  var h = location.hostname;
  var chezNous = NOUS.some(function (d) { return h === d || h.endsWith('.' + d); });
  if (!chezNous) return;
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var css = document.createElement('style');
  css.textContent = [
    '.kh-pill{position:fixed;left:14px;bottom:14px;z-index:9990;display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:99px;background:rgba(10,10,12,.85);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.14);color:#f0f0ec;font:500 12.5px/1 "Space Grotesk",system-ui,sans-serif;letter-spacing:.03em;text-decoration:none;box-shadow:0 6px 24px rgba(0,0,0,.45);transition:border-color .25s,color .25s,transform .25s}',
    '.kh-pill:hover{border-color:#C8F060;color:#C8F060;transform:translateY(-1px)}',
    '.kh-pill svg{width:13px;height:13px}',
    '.kh-veil{position:fixed;inset:0;z-index:99990;background:#050505;opacity:0;pointer-events:none;transition:opacity .34s cubic-bezier(.22,1,.36,1)}',
    '.kh-veil.on{opacity:1;pointer-events:auto}',
    '.kh-veil svg{position:absolute;inset:0;width:100%;height:100%}',
    '.kh-veil .kh-dot{fill:#C8F060;opacity:0;transform-origin:center;animation:khDot .5s cubic-bezier(.22,1,.36,1) forwards}',
    '.kh-veil .kh-line{stroke:#C8F060;stroke-opacity:.5;stroke-width:1;stroke-dasharray:600;stroke-dashoffset:600;animation:khLine .45s ease .12s forwards}',
    '@keyframes khDot{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:scale(1)}}',
    '@keyframes khLine{to{stroke-dashoffset:0}}',
  ].join('');
  document.head.appendChild(css);
  var pill = document.createElement('a');
  pill.className = 'kh-pill'; pill.href = 'https://kanaky.xyz/';
  pill.setAttribute('aria-label', 'Retour à l’accueil kanaky.xyz');
  pill.innerHTML = '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3.5 3.5 8 7.5l4 3 3 4" stroke="currentColor" stroke-width="1" opacity=".45"/><circle cx="3.5" cy="3.5" r="1.6" fill="currentColor"/><circle cx="8" cy="7.5" r="1.4" fill="currentColor"/><circle cx="12" cy="10.5" r="1.4" fill="currentColor"/><circle cx="15" cy="14.5" r="1.8" fill="currentColor"/></svg>Accueil';
  document.body.appendChild(pill);
  pill.addEventListener('click', function (e) {
    if (reduced || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    var veil = document.createElement('div');
    veil.className = 'kh-veil';
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    veil.appendChild(cv);
    document.body.appendChild(veil);
    requestAnimationFrame(function () { veil.classList.add('on'); });
    var dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = innerWidth, H = innerHeight, mm = Math.min(W, H);
    var A = [[.34,.34],[.45,.445],[.55,.53],[.66,.645]].map(function (q) {
      return [W*.5 + (q[0]-.5)*mm*.9, H*.5 + (q[1]-.5)*mm*.9]; });
    var pts = [];
    for (var i = 0; i < 110; i++) {
      var edge = Math.random()*2*(W+H), sx, sy;
      if (edge < W) { sx = edge; sy = -12; }
      else if (edge < W+H) { sx = W+12; sy = edge-W; }
      else if (edge < 2*W+H) { sx = edge-W-H; sy = H+12; }
      else { sx = -12; sy = edge-2*W-H; }
      var tq = A[i%4];
      pts.push({sx:sx, sy:sy, tx:tq[0]+(Math.random()-.5)*9, ty:tq[1]+(Math.random()-.5)*9,
        d:Math.random()*140, s:.8+Math.random()*1.8});
    }
    var t0 = performance.now(), DUR = 460;
    (function frame(now) {
      var t = now - t0;
      c.clearRect(0,0,W,H);
      for (var k = 0; k < pts.length; k++) { var p = pts[k];
        var e2 = Math.min(1, Math.max(0, (t - p.d)/DUR)); e2 = 1 - Math.pow(1-e2,3);
        c.fillStyle = 'rgba(200,240,96,' + (.25+.75*e2).toFixed(2) + ')';
        c.beginPath(); c.arc(p.sx+(p.tx-p.sx)*e2, p.sy+(p.ty-p.sy)*e2, p.s*(.5+.5*e2), 0, 6.2832); c.fill();
      }
      var lp = Math.min(1, Math.max(0, (t-300)/260));
      if (lp > 0) {
        c.strokeStyle = 'rgba(200,240,96,.7)'; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(A[0][0], A[0][1]);
        var seg = lp*3;
        for (var j = 1; j < 4; j++) {
          if (j <= seg) c.lineTo(A[j][0], A[j][1]);
          else { var f = seg-(j-1); if (f > 0) c.lineTo(A[j-1][0]+(A[j][0]-A[j-1][0])*f, A[j-1][1]+(A[j][1]-A[j-1][1])*f); break; }
        }
        c.stroke();
        for (var g2 = 0; g2 < 4; g2++) {
          var gr = c.createRadialGradient(A[g2][0], A[g2][1], 0, A[g2][0], A[g2][1], 26*lp);
          gr.addColorStop(0, 'rgba(200,240,96,' + (.5*lp).toFixed(2) + ')'); gr.addColorStop(1, 'rgba(200,240,96,0)');
          c.fillStyle = gr; c.beginPath(); c.arc(A[g2][0], A[g2][1], 26*lp, 0, 6.2832); c.fill();
        }
      }
      if (t < 700) requestAnimationFrame(frame);
    })(t0);
    setTimeout(function () { location.href = 'https://kanaky.xyz/'; }, 660);
  });
})();
