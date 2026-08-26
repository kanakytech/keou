/**
 * Filigrane vidéo — incrustation d'un bandeau produit par sharp, via ffmpeg.
 *
 * ─── Pourquoi ce fichier existe (25/08/2026) ───
 *
 * Le studio public a été ouvert à la vidéo. Les images qui en sortent portent un
 * filigrane depuis toujours (sharp, voir watermarkImage), mais la vidéo, elle,
 * sortait en clair : l'image de déploiement ne contenait pas ffmpeg. Comme la
 * galerie communautaire est publique et que le média se sert à une URL publique,
 * masquer le bouton d'enregistrement n'aurait rien protégé du tout — c'était du
 * décor. Le seul geste qui protège vraiment est d'inscrire l'adresse dans les
 * pixels.
 *
 * Le coût a été mesuré avant de décider, pas estimé : sur une vidéo de cinq
 * secondes en 720p pesant 4,4 Mo, l'incrustation prend 0,29 s réelles et 1,71 s
 * processeur. Le fournisseur, lui, met entre une et dix minutes à rendre cette
 * même vidéo. Le filigrane ne se voit donc pas dans l'attente.
 *
 * On incruste une image plutôt que d'écrire du texte avec `drawtext` : ce filtre
 * dépend de libfreetype et manque dans certaines compilations de ffmpeg, tandis
 * que `overlay` est toujours présent. En prime, le bandeau est produit par le
 * même sharp que celui de l'image — une seule apparence à maintenir.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const TEXTE = 'studio.kanaky.xyz';

/** Au-delà, on ne réencode pas : mieux vaut une vidéo nue qu'un service bloqué. */
const TAILLE_MAX = 200 * 1024 * 1024;

/** ffmpeg rend la main bien avant ; au-delà, quelque chose ne va pas. */
const DELAI_MS = 120_000;

let _ffmpegDisponible = null;

/** ffmpeg est-il installé ? Testé une fois, puis mémorisé. */
function ffmpegPresent() {
  if (_ffmpegDisponible !== null) return _ffmpegDisponible;
  _ffmpegDisponible = new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  return _ffmpegDisponible;
}

/** Le bandeau, aux mêmes couleurs que celui de l'image. */
async function bandeau(largeurVideo) {
  const fontSize = Math.max(16, Math.round(largeurVideo * 0.024));
  const pad = Math.round(fontSize * 0.9);
  const w = Math.round(TEXTE.length * fontSize * 0.64) + pad * 2;
  const h = fontSize + pad * 2;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<text x="${w - pad}" y="${h - pad}" text-anchor="end" ` +
    `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" ` +
    `fill="#ffffff" fill-opacity="0.5" stroke="#000000" stroke-opacity="0.28" stroke-width="1.2" ` +
    `paint-order="stroke">${TEXTE}</text></svg>`
  );
  /* On COMPOSE le texte sur un fond transparent, on n'ouvre pas le SVG seul.
   *
   * `sharp(svg)` — ouvrir le SVG comme image source — rendait un bandeau VIDE
   * dans le conteneur de production : la vidéo repassait bien par ffmpeg (l'index
   * en tête du fichier le prouve) mais l'incrustation n'ajoutait rien. Le même
   * appel marche pourtant en local, et le filigrane des IMAGES, lui, sort
   * parfaitement — or celui-ci compose le SVG sur un raster au lieu de l'ouvrir.
   *
   * On emprunte donc exactement le chemin qui fonctionne, plutôt que de chercher
   * pourquoi l'autre diverge selon la machine. */
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: svg, gravity: 'southeast' }])
    .png()
    .toBuffer();
}

/* Le chemin de la police installée par le Dockerfile. */
const POLICE = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/* Échapper pour le filtre drawtext : deux-points, apostrophes et antislashs y
 * ont un sens. « studio.kanaky.xyz » n'en contient aucun, mais le jour où le
 * texte change, une adresse avec un « : » casserait tout le filtre en silence. */
function echapperDrawtext(t) {
  return t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function lancer(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
    const minuteur = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg: délai dépassé')); }, DELAI_MS);
    p.on('error', (e) => { clearTimeout(minuteur); reject(e); });
    p.on('close', (code) => {
      clearTimeout(minuteur);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg a rendu ${code} — ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

/**
 * Incruste le filigrane en bas à droite.
 *
 * Ne jette JAMAIS : une vidéo sans filigrane vaut mieux qu'une génération perdue
 * après une minute d'attente et des crédits déjà dépensés chez le fournisseur.
 * En cas d'échec on rend la vidéo d'origine et on trace la raison.
 *
 * @param {Buffer} buffer  la vidéo telle que le fournisseur l'a rendue
 * @returns {Promise<Buffer>} la vidéo filigranée, ou l'originale si impossible
 */
export async function watermarkVideo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  if (buffer.length > TAILLE_MAX) {
    console.warn(`[FILIGRANE vidéo] ignorée — ${Math.round(buffer.length / 1048576)} Mo dépassent le plafond`);
    return buffer;
  }
  if (!(await ffmpegPresent())) {
    console.warn('[FILIGRANE vidéo] ffmpeg absent — la vidéo sort sans filigrane');
    return buffer;
  }

  let dossier;
  try {
    dossier = await mkdtemp(join(tmpdir(), 'keou-fil-'));
    const entree = join(dossier, 'in.mp4');
    const marque = join(dossier, 'mark.png');
    const sortie = join(dossier, 'out.mp4');

    await writeFile(entree, buffer);
    // La largeur réelle est inconnue sans sonder le fichier ; 1280 est la
    // largeur des rendus du studio et donne un bandeau juste sur 720p comme sur
    // 1080p, où il paraît seulement un peu plus discret.
    await writeFile(marque, await bandeau(1280));

    /* Deux tentatives, parce qu'une seule laissait la vidéo NUE en silence.
     *
     * La piste sonore est d'abord recopiée telle quelle : la réencoder
     * n'apporterait rien et abîmerait un son que le visiteur a payé. Mais une
     * copie de flux échoue dès que le conteneur de sortie n'accepte pas le
     * codec d'entrée tel quel — et comme ce module rend la vidéo d'origine
     * quand il échoue, la panne était totalement muette : la vidéo sortait sans
     * filigrane et rien ne le disait. Constaté en production le 26/08 sur trois
     * générations, alors que le même code marchait sur une vidéo synthétique.
     *
     * On réessaie donc une fois en réencodant l'audio. Perdre un peu de qualité
     * sonore vaut mieux que publier un travail sans protection. */
    /* ffmpeg écrit le texte lui-même, sharp ne sert que de repli.
     *
     * Le bandeau produit par sharp sortait TRANSPARENT dans le conteneur : la
     * vidéo repassait bien par ffmpeg — l'index en tête du fichier le prouve —
     * mais l'incrustation n'ajoutait rien, et rien n'était journalisé puisque
     * rien n'avait échoué. sharp rend une image vide sans s'en plaindre.
     *
     * `drawtext` lit le fichier de police directement, sans intermédiaire. On
     * l'essaie d'abord ; si cette compilation de ffmpeg n'a pas libfreetype, on
     * retombe sur l'incrustation d'image. Chaque chemin dit lequel a servi. */
    const texteFiltre =
      `drawtext=fontfile=${POLICE}:text='${echapperDrawtext(TEXTE)}'` +
      `:x=w-tw-20:y=h-th-20:fontsize=h/22:fontcolor=white@0.55` +
      `:shadowcolor=black@0.35:shadowx=2:shadowy=2`;

    const essais = [
      { nom: 'drawtext',        filtre: ['-vf', texteFiltre],                     audio: ['-c:a', 'copy'] },
      { nom: 'drawtext+aac',    filtre: ['-vf', texteFiltre],                     audio: ['-c:a', 'aac', '-b:a', '128k'] },
      { nom: 'incrustation',    filtre: ['-filter_complex', 'overlay=W-w-16:H-h-16'], audio: ['-c:a', 'copy'], marque: true },
    ];

    let pose = null;
    let derniere = null;
    for (const e of essais) {
      const entrees = e.marque ? ['-i', entree, '-i', marque] : ['-i', entree];
      try {
        await lancer([
          '-y', '-loglevel', 'error', ...entrees, ...e.filtre,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          ...e.audio, '-movflags', '+faststart', sortie,
        ]);
        pose = e.nom;
        break;
      } catch (err) {
        derniere = err;
        console.warn(`[FILIGRANE vidéo] « ${e.nom} » refusé — ${err.message.slice(0, 130)}`);
      }
    }
    if (!pose) throw derniere || new Error('aucune méthode de filigrane n’a abouti');
    console.log(`[FILIGRANE vidéo] posé par « ${pose} »`);

    const res = await readFile(sortie);
    return res.length > 0 ? res : buffer;
  } catch (e) {
    console.error('[FILIGRANE vidéo]', e.message);
    return buffer;
  } finally {
    if (dossier) await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}
