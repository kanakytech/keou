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
  return sharp(svg).png().toBuffer();
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
    const base = [
      '-y', '-loglevel', 'error',
      '-i', entree,
      '-i', marque,
      '-filter_complex', 'overlay=W-w-16:H-h-16',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      // Déplace l'index en tête : sans ça une vidéo servie en flux ne démarre
      // qu'une fois entièrement téléchargée.
      '-movflags', '+faststart',
    ];
    try {
      await lancer([...base.slice(0, -2), '-c:a', 'copy', ...base.slice(-2), sortie]);
    } catch (premiere) {
      console.warn('[FILIGRANE vidéo] copie audio refusée, réencodage —', premiere.message.slice(0, 140));
      await lancer([...base.slice(0, -2), '-c:a', 'aac', '-b:a', '128k', ...base.slice(-2), sortie]);
    }

    const res = await readFile(sortie);
    return res.length > 0 ? res : buffer;
  } catch (e) {
    console.error('[FILIGRANE vidéo]', e.message);
    return buffer;
  } finally {
    if (dossier) await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}
