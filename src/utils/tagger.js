import { queryOne, query } from '../db.js';
import { config } from '../config.js';

/* ═══════════════════════════════════════════
   KEOU — Auto-Tagging Engine
   Tier 1: Metadata inference (free, instant)
   Tier 2: Cloudflare Workers AI ResNet-50 (quasi-free, async)
   ═══════════════════════════════════════════ */

// ── ImageNet label → product category mapping ──
const LABEL_MAP = {
  // Fashion
  jersey: 'fashion', suit: 'fashion', cloak: 'fashion', poncho: 'fashion',
  kimono: 'fashion', stole: 'fashion', sarong: 'fashion', bikini: 'fashion',
  swimming_trunks: 'fashion', miniskirt: 'fashion', jean: 'fashion',
  overskirt: 'fashion', hoopskirt: 'fashion', trench_coat: 'fashion',
  fur_coat: 'fashion', lab_coat: 'fashion', pajama: 'fashion',
  sweatshirt: 'fashion', cardigan: 'fashion',

  // Footwear
  running_shoe: 'footwear', sandal: 'footwear', boot: 'footwear',
  cowboy_boot: 'footwear', clog: 'footwear', loafer: 'footwear',
  shoe_shop: 'footwear', sneaker: 'footwear',

  // Accessories
  handbag: 'accessories', purse: 'accessories', wallet: 'accessories',
  backpack: 'accessories', satchel: 'accessories', briefcase: 'accessories',
  sunglasses: 'accessories', sunglass: 'accessories', necklace: 'accessories',
  watch: 'accessories', digital_watch: 'accessories', analog_clock: 'accessories',
  bow_tie: 'accessories', bolo_tie: 'accessories', neck_brace: 'accessories',
  hair_slide: 'accessories', buckle: 'accessories', hatband: 'accessories',
  umbrella: 'accessories', scarf: 'accessories',

  // Beauty
  lipstick: 'beauty', perfume: 'beauty', lotion: 'beauty',
  hair_spray: 'beauty', face_powder: 'beauty', soap_dispenser: 'beauty',
  cream: 'beauty', cosmetic: 'beauty',

  // Food & Drink
  wine_bottle: 'food-drink', beer_bottle: 'food-drink', water_bottle: 'food-drink',
  pop_bottle: 'food-drink', cup: 'food-drink', coffee_mug: 'food-drink',
  espresso: 'food-drink', teapot: 'food-drink', pitcher: 'food-drink',
  goblet: 'food-drink', beer_glass: 'food-drink', cocktail_shaker: 'food-drink',
  red_wine: 'food-drink', eggnog: 'food-drink', chocolate_sauce: 'food-drink',
  grocery_store: 'food-drink', bakery: 'food-drink', confectionery: 'food-drink',
  ice_cream: 'food-drink', trifle: 'food-drink', carbonara: 'food-drink',
  pizza: 'food-drink', cheeseburger: 'food-drink', plate: 'food-drink',
  bowl: 'food-drink', mixing_bowl: 'food-drink',

  // Electronics
  cellular_telephone: 'electronics', laptop: 'electronics', notebook: 'electronics',
  desktop_computer: 'electronics', monitor: 'electronics', screen: 'electronics',
  television: 'electronics', iPod: 'electronics', headphone: 'electronics',
  earphone: 'electronics', speaker: 'electronics', loudspeaker: 'electronics',
  microphone: 'electronics', mouse: 'electronics', keyboard: 'electronics',
  remote_control: 'electronics', joystick: 'electronics', camera: 'electronics',
  Polaroid_camera: 'electronics', reflex_camera: 'electronics',
  digital_camera: 'electronics', projector: 'electronics', modem: 'electronics',
  printer: 'electronics', hard_disc: 'electronics', CD_player: 'electronics',
  tape_player: 'electronics', radio: 'electronics',

  // Home
  table_lamp: 'home', desk: 'home', bookcase: 'home', china_cabinet: 'home',
  wardrobe: 'home', chest: 'home', dining_table: 'home', studio_couch: 'home',
  rocking_chair: 'home', folding_chair: 'home', throne: 'home', park_bench: 'home',
  four_poster: 'home', candle: 'home', lamp_shade: 'home', window_shade: 'home',
  shower_curtain: 'home', quilt: 'home', pillow: 'home', doormat: 'home',
  vase: 'home', flower_pot: 'home', medicine_chest: 'home', bath_towel: 'home',
  toilet_seat: 'home', washbasin: 'home', bathtub: 'home',
  refrigerator: 'home', washer: 'home', iron: 'home', toaster: 'home',
  Dutch_oven: 'home', frying_pan: 'home', wok: 'home', spatula: 'home',
  crock_pot: 'home', caldron: 'home', coffeepot: 'home',

  // Sport
  basketball: 'sport', soccer_ball: 'sport', football_helmet: 'sport',
  baseball: 'sport', tennis_ball: 'sport', golf_ball: 'sport',
  volleyball: 'sport', ping_pong_ball: 'sport', puck: 'sport',
  ski: 'sport', snowboard: 'sport', surfboard: 'sport', paddleboard: 'sport',
  dumbbell: 'sport', barbell: 'sport', punching_bag: 'sport',
  mountain_bike: 'sport', bicycle: 'sport', unicycle: 'sport',
  racket: 'sport', paddle: 'sport',

  // Tools & Industrial
  power_drill: 'tools-industrial', chain_saw: 'tools-industrial',
  lawn_mower: 'tools-industrial', hammer: 'tools-industrial',
  screwdriver: 'tools-industrial', hatchet: 'tools-industrial',
  wrench: 'tools-industrial', plunger: 'tools-industrial',
  nail: 'tools-industrial', screw: 'tools-industrial',
  paintbrush: 'tools-industrial', spray_can: 'tools-industrial',
  oil_filter: 'tools-industrial', gas_pump: 'tools-industrial',
  fire_extinguisher: 'tools-industrial', toolbox: 'tools-industrial',
};

// ── Tier 1: Infer tags from existing metadata ──
export function inferMetadataTags(gen) {
  const tags = [];

  // Type tag
  const typeMap = { image: 'photo', video: 'video', polish: 'polished', remix: 'remix', adapt: 'adapted' };
  if (typeMap[gen.type]) tags.push(typeMap[gen.type]);

  // Format tag
  const fmtMap = { '1:1': 'square', '9:16': 'portrait', '3:4': 'portrait', '4:3': 'landscape', '16:9': 'landscape' };
  if (gen.format && fmtMap[gen.format]) tags.push(fmtMap[gen.format]);

  return tags;
}

// ── Tier 2: Classify image with Cloudflare Workers AI ──
export async function classifyImage(imageUrl) {
  const { accountId, aiToken } = config.cf || {};
  if (!accountId || !aiToken) return null;

  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;

    const imgBuffer = await imgRes.arrayBuffer();

    // Send to Cloudflare Workers AI ResNet-50
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/microsoft/resnet-50`;
    const cfRes = await fetch(cfUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from(imgBuffer),
    });

    if (!cfRes.ok) return null;
    const data = await cfRes.json();

    if (!data.success || !data.result?.length) return null;

    // Get top prediction with confidence > 0.15
    for (const pred of data.result) {
      const label = (pred.label || '').toLowerCase().replace(/\s+/g, '_');
      const score = pred.score || 0;

      if (score < 0.15) continue;

      // Try direct match
      if (LABEL_MAP[label]) return LABEL_MAP[label];

      // Try partial match (e.g., "running_shoe" matches "shoe")
      for (const [key, category] of Object.entries(LABEL_MAP)) {
        if (label.includes(key) || key.includes(label)) return category;
      }
    }

    return 'other';
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[Tagger] Classification error:', err.message);
    }
    return null;
  }
}

// ── Main: Tag a generation (fire-and-forget) ──
export async function tagGeneration(generationId) {
  try {
    const gen = await queryOne(
      'SELECT id, type, format, result_url, status FROM generations WHERE id = $1',
      [generationId]
    );
    if (!gen || gen.status !== 'completed' || !gen.result_url) return;

    // Tier 1 — metadata tags (always works)
    const tags = inferMetadataTags(gen);

    // Tier 2 — vision classification (best effort)
    const isImage = gen.type === 'image' || gen.type === 'polish' || gen.type === 'remix';
    if (isImage && gen.result_url) {
      const category = await classifyImage(gen.result_url);
      if (category) tags.push(category);
    }

    // Deduplicate and save
    const uniqueTags = [...new Set(tags)];
    await query('UPDATE generations SET tags = $1 WHERE id = $2', [JSON.stringify(uniqueTags), generationId]);
    console.log(`  [Tagger] #${generationId} tagged: ${uniqueTags.join(', ')}`);
  } catch (err) {
    console.error(`[Tagger] Failed to tag #${generationId}:`, err.message);
  }
}

// ── Retroactive: Tag all untagged completed generations ──
export async function retagAll() {
  const { queryAll } = await import('../db.js');
  // Select items that have no product category tag (only Tier 1 tags or empty)
  const productCategories = ['fashion','footwear','accessories','beauty','food-drink','electronics','home','sport','tools-industrial','other'];
  const untagged = (await queryAll(
    "SELECT id, type, format, result_url, status, tags FROM generations WHERE status = 'completed' AND type IN ('image','polish','remix')"
  )).filter(g => {
    try {
      const tags = JSON.parse(g.tags || '[]');
      return !tags.some(t => productCategories.includes(t));
    } catch { return true; }
  });

  console.log(`[Tagger] Retroactive tagging: ${untagged.length} items`);
  let count = 0;

  for (const gen of untagged) {
    const tags = inferMetadataTags(gen);

    // Tier 2 for images (with rate limiting)
    const isImage = gen.type === 'image' || gen.type === 'polish' || gen.type === 'remix';
    if (isImage && gen.result_url) {
      const category = await classifyImage(gen.result_url);
      if (category) tags.push(category);
      // Small delay to stay within CF rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    const uniqueTags = [...new Set(tags)];
    await query('UPDATE generations SET tags = $1 WHERE id = $2', [JSON.stringify(uniqueTags), gen.id]);
    count++;
  }

  console.log(`[Tagger] Retroactive done: ${count} items tagged`);
  return count;
}
