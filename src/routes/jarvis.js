/**
 * Jarvis Mode — Agentic Chat Route
 *
 * POST /api/jarvis/chat  { message, history?, imageUrl? }
 * Streams SSE response with Claude tool-use loop.
 * Tools map 1:1 to keou-actions.js functions.
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  executeGenerateImage,
  executeGenerateVideo,
  executePolish,
  executeRemix,
  executeAdapt,
  executeTts,
  executeSfx,
  executeImageUpscale,
  executeVideoUpscale,
  getCreditsInfo,
} from '../lib/keou-actions.js';
import { query, queryOne, queryAll } from '../db.js';

const router = Router();

// ─── System Prompt ───

const SYSTEM_PROMPT = `You are Keou, the AI creative director built into the Keou platform.

## How you behave
- Talk like a creative colleague — short, direct, helpful. No walls of text.
- Respond in the same language the user writes in.
- BEFORE generating, ask clarifying questions if the request is vague:
  - "What vibe are you going for?" / "Indoor or outdoor?" / "What format?" etc.
  - Only ask 1-2 quick questions, not a quiz.
- If the user is clear about what they want, act immediately — no unnecessary questions.
- Keep your responses to 2-3 sentences max. No bullet-point lists unless the user asks for details.

## Tool selection
- "generate/create visual/image/photo/variant" → generate_image
- "generate video/clip" → generate_video
- "polish/retouch/enhance" → polish_image
- "remix/transform" → remix_image
- "adapt/resize format" → adapt_format
- "read aloud / voiceover / TTS" → text_to_speech (ONLY for text→audio)
- "sound effect" → sound_effect
- "upscale" → upscale_image or upscale_video
- NEVER use text_to_speech for image/video generation.

## When generating multiple variants
Call generate_image multiple times with different creativeDirection values (different scenes, moods, lighting).

## Image handling
- If the user attached an image, you see it visually AND the URL is in the text as [Attached image URL: ...]. Use that URL for tools.
- If they say "this image" or "my last one", check history or use list_recent_generations.
- If no image is available and required, ask them to attach one.

## Output style
- Mention generation IDs briefly (e.g., "Launched #245, #246, #247").
- Don't repeat what each generation is — the user can see the results inline.
- If a tool fails, say what went wrong in one sentence and suggest a fix.`;

// ─── Tool Definitions ───

const TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate a product visual from a reference image. Creates a professional commercial photo with the product placed in a realistic environment. Costs 1 image credit.',
    input_schema: {
      type: 'object',
      properties: {
        imgUrl: { type: 'string', description: 'URL of the product image to use as reference' },
        format: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], description: 'Aspect ratio. Default: 1:1' },
        creativeDirection: { type: 'string', description: 'Optional creative direction for the scene (e.g., "luxury beach setting at sunset", "minimalist white studio")' },
        projectId: { type: 'number', description: 'Project ID to assign to. Optional.' },
        campaignId: { type: 'number', description: 'Campaign ID. Optional.' },
      },
      required: ['imgUrl'],
    },
  },
  {
    name: 'generate_video',
    description: 'Generate a commercial video from a product image. Creates a cinematic product video with camera movement and lighting effects. Costs 1 video credit.',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the product image' },
        videoModel: { type: 'string', enum: ['grok-imagine', 'kling-2.6', 'kling-3.0', 'veo3', 'seedance-2'], description: 'Video model. Default: grok-imagine' },
        creativeDirection: { type: 'string', description: 'Creative direction for camera/lighting' },
        duration: { type: 'number', description: 'Duration in seconds. Depends on model (6-30s for grok, 5-10s for kling-2.6, etc.)' },
        resolution: { type: 'string', enum: ['480p', '720p'], description: 'Resolution. Default: 720p' },
        mode: { type: 'string', description: 'Mode (model-dependent: "normal"/"fun" for grok, "std"/"pro" for kling-3.0)' },
        sound: { type: 'boolean', description: 'Enable sound (kling models only)' },
        aspectRatio: { type: 'string', description: 'Aspect ratio. Default: 16:9' },
        generateAudio: { type: 'boolean', description: 'Generate audio (seedance-2 only)' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['imageUrl'],
    },
  },
  {
    name: 'polish_image',
    description: 'Apply professional studio-grade retouching to a product image. Enhances lighting, textures, reflections, and color grading without changing the product. Costs 1 image credit.',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the image to polish' },
        ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], description: 'Aspect ratio. Default: 1:1' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['imageUrl'],
    },
  },
  {
    name: 'remix_image',
    description: 'Transform an image with a creative prompt while keeping the base composition. Costs 1 image credit.',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the image to remix' },
        remixPrompt: { type: 'string', description: 'Creative prompt describing the desired transformation' },
        ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], description: 'Aspect ratio. Default: 1:1' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['imageUrl', 'remixPrompt'],
    },
  },
  {
    name: 'adapt_format',
    description: 'Adapt an image to a different aspect ratio. Extends the canvas naturally without changing the product. Costs 1 image credit.',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the image to adapt' },
        ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], description: 'Target aspect ratio' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['imageUrl', 'ratio'],
    },
  },
  {
    name: 'text_to_speech',
    description: 'Convert text to speech audio using ElevenLabs. Free (no credits).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to convert to speech' },
        voice: { type: 'string', description: 'Voice name. Default: Rachel. Options: Rachel, Drew, Clyde, Paul, Domi, Dave, Fin, Sarah, Antoni, Thomas, Charlie, George, Emily, Elli, Callum, Patrick, Harry, Liam, Dorothy, Josh, Arnold, Charlotte, Matilda, Matthew, James, Joseph, Serena, Adam, Nicole' },
        stability: { type: 'number', description: '0-1. Voice stability. Default: 0.5' },
        similarity_boost: { type: 'number', description: '0-1. Voice similarity. Default: 0.75' },
        style: { type: 'number', description: '0-1. Style exaggeration.' },
        speed: { type: 'number', description: '0.5-2. Playback speed.' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'sound_effect',
    description: 'Generate a sound effect from a text description. Free (no credits).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Description of the sound effect (e.g., "ocean waves crashing", "futuristic whoosh")' },
        duration_seconds: { type: 'number', description: 'Duration in seconds. Optional.' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['text'],
    },
  },
  {
    name: 'upscale_image',
    description: 'Upscale an image to higher resolution (4x or 8x). Free (no credits).',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the image to upscale' },
        upscaleFactor: { type: 'string', enum: ['4', '8'], description: 'Upscale factor. Default: 4' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['imageUrl'],
    },
  },
  {
    name: 'upscale_video',
    description: 'Upscale a video to higher resolution (2x or 4x). Free (no credits).',
    input_schema: {
      type: 'object',
      properties: {
        videoUrl: { type: 'string', description: 'URL of the video to upscale' },
        upscaleFactor: { type: 'string', enum: ['2', '4'], description: 'Upscale factor. Default: 4' },
        projectId: { type: 'number' },
        campaignId: { type: 'number' },
      },
      required: ['videoUrl'],
    },
  },
  {
    name: 'get_credits_info',
    description: 'Check remaining image and video credits for the agency.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_generations',
    description: 'List the user\'s recent generations to find image/video URLs for further processing.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of recent items. Default: 10' },
        type: { type: 'string', enum: ['image', 'video', 'polish', 'tts', 'sfx', 'img-upscale', 'vid-upscale'], description: 'Filter by type. Optional.' },
      },
    },
  },
];

// ─── Tool Executor ───

async function executeTool(userId, toolName, toolInput) {
  switch (toolName) {
    case 'generate_image':
      return await executeGenerateImage(userId, toolInput);
    case 'generate_video':
      return await executeGenerateVideo(userId, toolInput);
    case 'polish_image':
      return await executePolish(userId, toolInput);
    case 'remix_image':
      return await executeRemix(userId, toolInput);
    case 'adapt_format':
      return await executeAdapt(userId, toolInput);
    case 'text_to_speech':
      return await executeTts(userId, toolInput);
    case 'sound_effect':
      return await executeSfx(userId, toolInput);
    case 'upscale_image':
      return await executeImageUpscale(userId, toolInput);
    case 'upscale_video':
      return await executeVideoUpscale(userId, toolInput);
    case 'get_credits_info':
      return await getCreditsInfo();
    case 'list_recent_generations': {
      const limit = Math.min(Math.max(parseInt(toolInput.limit) || 10, 1), 50);
      if (toolInput.type) {
        const rows = await queryAll(
          `SELECT g.id, g.type, g.status, g.input_url, g.result_url, g.format, g.created_at,
                  p.name as project_name
           FROM generations g
           LEFT JOIN projects p ON g.project_id = p.id
           WHERE g.user_id = $1 AND g.type = $2
           ORDER BY g.created_at DESC LIMIT $3`,
          [userId, toolInput.type, limit]
        );
        return { generations: rows };
      }
      const rows = await queryAll(
        `SELECT g.id, g.type, g.status, g.input_url, g.result_url, g.format, g.created_at,
                p.name as project_name
         FROM generations g
         LEFT JOIN projects p ON g.project_id = p.id
         WHERE g.user_id = $1
         ORDER BY g.created_at DESC LIMIT $2`,
        [userId, limit]
      );
      return { generations: rows };
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── Chat Route (Streaming SSE) ───

router.post('/chat', requireAuth, async (req, res) => {
  const { message, history = [], imageUrl, imageUrls, conversationId } = req.body;
  const allImageUrls = imageUrls?.length ? imageUrls : (imageUrl ? [imageUrl] : []);
  if (!message && !allImageUrls.length) return res.status(400).json({ error: 'Message required' });

  // Try DB key first, fall back to env var
  let apiKey = config.anthropic.apiKey;
  try {
    const { queryOne } = await import('../db.js');
    const { decryptKey } = await import('../utils/crypto.js');
    const row = await queryOne("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
    if (row?.value) apiKey = decryptKey(row.value);
  } catch (e) { /* DB key not available, use env var */ }
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured — add it in Settings → API Keys' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // C3 — stop the agentic loop if the client disconnects (don't keep firing paid
  // tool-calls into a dead socket) and never write after the response is closed.
  let aborted = false;
  req.on('close', () => { aborted = true; });

  const send = (event, data) => {
    if (res.writableEnded || aborted) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const client = new Anthropic({ apiKey });
    const userId = req.user.id;

    // Build messages array from history + current message
    const messages = [];

    // Include conversation history (last 20 turns max)
    const recentHistory = history.slice(-20);
    for (const h of recentHistory) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // Current user message
    const userContent = [];
    if (allImageUrls.length) {
      for (const url of allImageUrls) {
        userContent.push({ type: 'image', source: { type: 'url', url } });
      }
    }
    // Include image URLs in the text so Claude can pass them to tools
    let textMsg = message || (allImageUrls.length ? 'Describe these images' : '');
    if (allImageUrls.length) {
      textMsg += `\n\n[Attached image URLs: ${allImageUrls.join(', ')}]`;
    }
    userContent.push({ type: 'text', text: textMsg });
    messages.push({ role: 'user', content: userContent });

    // Agentic loop — max 10 iterations
    let currentMessages = [...messages];
    const MAX_ITERATIONS = 10;
    let fullAssistantText = ''; // Track across all iterations
    const collectedGenerationIds = []; // Track generation IDs for media persistence

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (aborted) break; // C3 — client gone, stop spending on tool-calls
      const stream = client.messages.stream({
        model: config.anthropic.model,
        max_tokens: 16384,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: currentMessages,
      });

      // Collect the full response
      let assistantText = '';
      const toolUseBlocks = [];
      let stopReason = '';

      // Stream text chunks to client
      stream.on('text', (text) => {
        assistantText += text;
        fullAssistantText += text;
        send('text', { text });
      });
      // C3 — catch async stream errors so they can't become an unhandled rejection (process crash).
      // finalMessage() below also rejects on error and is handled by the outer try/catch.
      stream.on('error', (err) => { console.error('[Jarvis stream]', err?.message || err); });

      const finalMessage = await stream.finalMessage();
      stopReason = finalMessage.stop_reason;

      // Collect tool use blocks
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // If no tool use, we're done
      if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
        break;
      }

      // Execute tools and continue the loop
      currentMessages.push({ role: 'assistant', content: finalMessage.content });

      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        send('tool_call', { tool: toolBlock.name, input: toolBlock.input });

        try {
          const result = await executeTool(userId, toolBlock.name, toolBlock.input);
          if (result && result.generationId) {
            collectedGenerationIds.push(result.generationId);
          }
          send('tool_result', { tool: toolBlock.name, result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const errorMsg = err.message || 'Tool execution failed';
          send('tool_error', { tool: toolBlock.name, error: errorMsg });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify({ error: errorMsg }),
            is_error: true,
          });
        }
      }

      currentMessages.push({ role: 'user', content: toolResults });
    }

    // ─── Persist conversation ───
    let finalConvId = null;
    const reqConvId = conversationId != null ? parseInt(conversationId) : null;
    const userText = message || '';

    try {
      // C4 — only reuse a conversation the caller actually owns; a foreign or invalid
      // conversationId falls back to creating a fresh one (never write into another user's convo).
      if (Number.isInteger(reqConvId)) {
        const owned = await queryOne('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [reqConvId, userId]);
        if (owned) finalConvId = owned.id;
      }
      if (!finalConvId) {
        // Auto-create conversation with first message as title
        const title = userText.slice(0, 60) || 'New conversation';
        const conv = await queryOne(
          'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
          [userId, title]
        );
        finalConvId = conv.id;
      } else {
        // Update timestamp
        await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [finalConvId, userId]);
      }

      // Save messages
      if (userText || allImageUrls.length) {
        await query(
          'INSERT INTO conversation_messages (conversation_id, role, content, image_url) VALUES ($1, $2, $3, $4)',
          [finalConvId, 'user', userText, allImageUrls[0] || null]
        );
      }
      if (fullAssistantText) {
        const genIds = collectedGenerationIds.length > 0 ? JSON.stringify(collectedGenerationIds) : '[]';
        await query(
          'INSERT INTO conversation_messages (conversation_id, role, content, generation_ids) VALUES ($1, $2, $3, $4)',
          [finalConvId, 'assistant', fullAssistantText, genIds]
        );
      }
    } catch (dbErr) {
      console.error('[KEOU] Failed to persist conversation:', dbErr.message);
    }

    send('done', { conversationId: finalConvId });
  } catch (err) {
    console.error('[KEOU] Chat error:', err.message);
    send('error', { error: err.message || 'Internal error' });
  } finally {
    res.end();
  }
});

// ─── TTS Route (synchronous — polls KIE until audio ready) ───

import { getApiKey } from '../lib/keou-actions.js';

function extractAudioUrl(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) return parsed[0] || '';
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed.resultUrls?.[0] || parsed.resultUrl || parsed.result_url || parsed.output_url || parsed.url || '';
    }
  } catch (err) {
    console.error('[JARVIS AUDIO PARSE]', err.message);
    if (typeof raw === 'string' && raw.startsWith('http')) return raw;
  }
  return '';
}

// ─── Speech-to-Text (Whisper STT only — returns text for textarea) ───

import multer from 'multer';
const sttUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/stt', requireAuth, sttUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file required' });
  if (!config.openai?.apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  try {
    const sttForm = new FormData();
    sttForm.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), 'voice.webm');
    sttForm.append('model', 'whisper-1');

    const sttRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      body: sttForm,
    });

    if (!sttRes.ok) return res.status(500).json({ error: 'Transcription failed' });
    const data = await sttRes.json();
    res.json({ text: data.text?.trim() || '' });
  } catch (err) {
    console.error('[STT]', err.message);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// ─── LEGACY: TTS route kept for chat tool (executeTts still uses it) ───
router.post('/tts', requireAuth, async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const userId = req.user.id;
  const ttsText = text.length > 500 ? text.slice(0, 500) : text;

  try {
    const result = await executeTts(userId, { text: ttsText, voice: voice || 'Rachel' });

    // Check if result is immediate (Fal sync) — already completed in DB
    const gen = await queryOne('SELECT status, result_url FROM generations WHERE id = $1', [result.generationId]);
    if (gen?.status === 'completed' && gen.result_url) {
      return res.json({ audioUrl: gen.result_url, generationId: result.generationId });
    }

    // Async (KIE) — poll via provider
    if (!result.taskId) return res.status(500).json({ error: 'TTS task creation failed' });

    const { getProvider, getProviderApiKey } = await import('../lib/providers/index.js');
    const provider = await getProvider();
    const apiKey = await getProviderApiKey(provider.name);
    const maxAttempts = 15;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const genRow = await queryOne('SELECT status, result_url, metadata FROM generations WHERE id = $1', [result.generationId]);
      if (genRow?.status === 'completed' && genRow.result_url) {
        return res.json({ audioUrl: genRow.result_url, generationId: result.generationId });
      }
      if (genRow?.status === 'failed') {
        return res.status(500).json({ error: 'TTS generation failed' });
      }

      // Also try direct provider poll
      const pollResult = await provider.pollTask(apiKey, {
        taskId: result.taskId,
        recordId: result.recordId,
        metadata: typeof genRow?.metadata === 'string' ? genRow.metadata : JSON.stringify(genRow?.metadata || {}),
      });

      if (pollResult.status === 'completed' && pollResult.resultUrl) {
        await query('UPDATE generations SET status=$1, result_url=$2, completed_at=NOW() WHERE id=$3', ['completed', pollResult.resultUrl, result.generationId]);
        return res.json({ audioUrl: pollResult.resultUrl, generationId: result.generationId });
      }
      if (pollResult.status === 'failed') {
        return res.status(500).json({ error: 'TTS generation failed' });
      }
    }

    return res.status(504).json({ error: 'TTS generation timed out' });
  } catch (err) {
    console.error('[KEOU] TTS error:', err.message);
    return res.status(500).json({ error: err.message || 'TTS failed' });
  }
});

export default router;
