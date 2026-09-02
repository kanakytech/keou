/**
 * Révélation au scroll — partagée par toutes les pages publiques.
 *
 * Marque `js-reveal` sur <html> AVANT d'observer : c'est cette classe qui
 * autorise styles.css à cacher `.m-reveal`. Si ce fichier ne charge pas, la
 * classe n'existe pas et tout reste visible — une page ne doit jamais dépendre
 * d'un script pour afficher son contenu.
 *
 * N'anime que opacity/transform (GPU), révèle une seule fois par élément, et
 * s'abstient entièrement quand l'utilisateur a demandé moins de mouvement.
 */
(function () {
  var doc = document.documentElement;
  var calme = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Pas d'IntersectionObserver (vieux moteur) ou mouvement réduit : on ne pose
  // même pas la classe, donc rien n'est jamais caché.
  if (calme || !('IntersectionObserver' in window)) return;
  doc.classList.add('js-reveal');

  function demarrer() {
    var cibles = document.querySelectorAll('.m-reveal');
    if (!cibles.length) return;

    var obs = new IntersectionObserver(function (entrees) {
      entrees.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        obs.unobserve(e.target); // une seule fois : rien ne re-disparaît au scroll arrière
      });
    }, {
      // Déclenche un peu avant l'entrée réelle : l'élément est déjà arrivé
      // quand l'œil se pose dessus, au lieu de s'animer sous le regard.
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.05,
    });

    cibles.forEach(function (el) {
      // Déjà dans l'écran au chargement (au-dessus de la ligne de flottaison) :
      // on révèle tout de suite, sans attendre un scroll qui ne viendra peut-être pas.
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92) el.classList.add('is-in');
      else obs.observe(el);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
  else demarrer();
})();
