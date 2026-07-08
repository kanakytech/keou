/**
 * Export pack presets — common deliverable bundles agencies need.
 * Each format triggers a single executeAdapt call with the target ratio.
 *
 * Adding a new preset : append a `formats` array; each entry needs a stable
 * `name` (used in the ZIP filename), `ratio` (passed to KIE/Fal as 'W:H'),
 * and `label` (shown in the picker UI).
 */
export const PACKS = {
  'social-essentials': {
    label: 'Social essentials',
    description: 'Instagram post + story, Facebook ad, Pinterest. 4 formats.',
    formats: [
      { name: 'instagram_post',  ratio: '1:1',  label: 'Instagram Post' },
      { name: 'instagram_story', ratio: '9:16', label: 'Instagram Story' },
      { name: 'facebook_ad',     ratio: '16:9', label: 'Facebook Ad' },
      { name: 'pinterest',       ratio: '3:4',  label: 'Pinterest' },
    ],
  },
  'full-marketing': {
    label: 'Full marketing pack',
    description: 'Social + paid ads + web hero. 8 formats.',
    formats: [
      { name: 'instagram_post',  ratio: '1:1',  label: 'Instagram Post' },
      { name: 'instagram_story', ratio: '9:16', label: 'Instagram Story' },
      { name: 'facebook_ad',     ratio: '16:9', label: 'Facebook Ad' },
      { name: 'pinterest',       ratio: '3:4',  label: 'Pinterest' },
      { name: 'tiktok_cover',    ratio: '9:16', label: 'TikTok / Reel cover' },
      { name: 'web_hero',        ratio: '16:9', label: 'Web hero' },
      { name: 'linkedin_landscape', ratio: '16:9', label: 'LinkedIn landscape' },
      { name: 'twitter_card',    ratio: '16:9', label: 'Twitter / X card' },
    ],
  },
  'square-only': {
    label: 'Square only',
    description: 'For e-commerce product listings. Single format, multiple sizes.',
    formats: [
      { name: 'square_thumb',  ratio: '1:1', label: 'Square (catalog)' },
    ],
  },
};

export function getPack(packId) {
  return Object.prototype.hasOwnProperty.call(PACKS, packId) ? PACKS[packId] : null;
}

export function listPacks() {
  return Object.entries(PACKS).map(([id, p]) => ({
    id,
    label: p.label,
    description: p.description,
    formatCount: p.formats.length,
    formats: p.formats.map(f => ({ name: f.name, ratio: f.ratio, label: f.label })),
  }));
}

/**
 * Build a filesystem-safe filename slug from arbitrary string input.
 * Used for ZIP entries: ClientName_CampaignName_AssetName_v1_format_ratio.png
 */
export function slugify(s, max = 60) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'asset';
}

/**
 * Build the canonical ZIP entry name for a pack item.
 * Schema: NN_packname_format_RATIOxRATIO.png
 * Where NN is the order index (01, 02, ...) so files sort naturally.
 */
export function packEntryName(index, format, ext = 'png') {
  const ratioSafe = format.ratio.replace(':', 'x');
  const order = String(index + 1).padStart(2, '0');
  return `${order}_${format.name}_${ratioSafe}.${ext}`;
}
