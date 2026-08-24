/**
 * Studio Prompts — single source of truth for the production-engine prompts.
 *
 * Used by BOTH execution paths:
 *   - src/lib/keou-actions.js  (authenticated studio: per-user generations)
 *   - src/lib/essai-queue.js   (anonymous studio: essai pipeline, watermarked
 *     outputs published to the community gallery)
 *
 * Keeping them here guarantees the anonymous studio produces the exact same
 * visual quality as the logged-in studio — same director's brief, same rules.
 */

export const IMAGE_PROMPT = JSON.stringify({
  system_role: '商业产品视觉导演',
  output_format: { quality: '超写实', style: '高端电影级广告' },
  核心规则: { 产品锁定: { 规则: '绝对锁定', 说明: '产品必须与原始图片完全一致，不允许任何修改', 禁止: ['重绘', '再生成', '改变形状', '改变文字', '改变标志'], 允许: '只允许在产品周围生成新的真实环境' } },
  文字与标志: { 锁定级别: '最高', 要求: '所有文字、标志、标签必须完全保持不变' },
  产品识别: { 自动识别: true, 规则: '识别产品类型并选择正确的视觉模式' },
  可穿戴规则: { 判断: '只要是人类穿戴物（服装、包、背包、鞋子、饰品、眼镜、手表等）', 必须: '始终使用真实人类模特', 人体要求: '真实皮肤质感，可见毛孔，细微瑕疵，自然次表面散射，真实阴影，禁止任何CGI或游戏感' },
  视觉模式: { 可穿戴: { 场景: '高级时尚电影级拍摄', 风格: 'VOGUE级编辑视觉' }, 非可穿戴: { 场景: '符合真实使用场景的高端商业环境' } },
  真实感模拟: { 说明: '模拟高级ComfyUI写实流程', 包含: ['皮肤微细节', '真实材质', '自然光照', '真实景深', '电影色彩', '轻微胶片颗粒'], 禁止: ['塑料感', 'CG渲染感', '游戏风格'] },
  负面规则: { 禁止: ['文字变形', '产品重复', '幻想元素', '卡通风格', '不真实材质'] },
  最终目标: { 描述: '生成看起来像由顶级广告团队耗资数十万美元制作的超写实商业视觉，产品100%保持不变' },
});

export const VIDEO_PROMPT = 'You are a world-class cinematic advertising director creating premium commercial content for modern digital brands. The product shown in the reference image must be treated as a FIXED 2D PROJECTION locked in place, not as a 3D object. The visible face is ABSOLUTELY IMMUTABLE: identical pixels, geometry, colors, text and logos, at all times. Do NOT reinterpret, redraw, reconstruct, infer depth, rotate, reveal unseen angles, or hallucinate any geometry. The product must remain perfectly frontal and static. All motion must come exclusively from cinematic camera movement, lighting transitions, environmental effects, depth simulation, and timing. Choose ONE powerful commercial movement style per video. Enhance with premium lighting sweeps, dynamic shadows, volumetric light rays, atmospheric particles, shallow DOF, and background parallax. Absolutely no product deformation, warping, scaling inconsistencies, drifting, flickering, AI artifacts, or CGI look. The final result must feel ultra-realistic, polished, and agency-ready.';

export const POLISH_PROMPT = 'You are a senior commercial retoucher with 15 years of experience at top agencies. Apply professional studio-grade polish: enhance lighting with soft directional studio light, improve material textures for premium/tactile feel, add subtle reflections and highlights emphasizing product form, refine color grading to high-end commercial photography standards, apply micro-contrast for depth. Do NOT change structure, shape, text, logos, or labels. Do NOT add new elements. Output: top commercial photography with premium post-production.';

export const ADAPT_PROMPT = JSON.stringify({
  system_role: '精确图像格式适配专家',
  核心任务: '将原始图像精确复制到新的宽高比，不进行任何视觉修改',
  绝对规则: { 禁止修改: ['产品外观', '颜色', '光照', '质感', '文字', '标志', '背景风格', '角色外观', '构图元素'] },
  扩展规则: '扩展画布时，自然延伸现有背景，保持100%相同的风格、颜色和光线',
  禁止: ['新元素', '改变现有元素', '场景重新诠释', '文字改变', '色调改变'],
  目的: '输出与原图视觉完全相同，仅宽高比不同',
});

/**
 * Merge the visitor's creative direction into the base image prompt (same
 * rule as the authenticated studio: the direction shapes scene/light/mood,
 * never the product itself). Falls back to the base prompt on parse issues.
 */
export function buildImagePrompt(creativeDirection) {
  if (!creativeDirection) return IMAGE_PROMPT;
  try {
    const bp = JSON.parse(IMAGE_PROMPT);
    bp['用户创意方向'] = { 方向: creativeDirection, 规则: '融入场景、光线、氛围，但绝不改变产品本身' };
    return JSON.stringify(bp);
  } catch (err) {
    console.error('[PROMPT PARSE]', err.message);
    return IMAGE_PROMPT;
  }
}
