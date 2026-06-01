import { completion, parseSSEStream } from './chat.js';
import { resolveImageToRefId } from './upload.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { recordTTFB, recordTokenSpeed } from './metrics.js';
import { autoDeleteAfterCompletion } from './session.js';

const MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  'deepseek-v4-pro': 'expert',
  'deepseek-v4-vision': 'vision',
  'deepseek-v4-flash[1m]': 'default',
  'deepseek-v4-pro[1m]': 'expert',
  'deepseek-v4-vision[1m]': 'vision',
};

function mapModel(model) {
  const mapped = MODEL_MAP[model];
  if (!mapped) throw new Error(`Unknown model: ${model}. Available: ${Object.keys(MODEL_MAP).join(', ')}`);
  return mapped;
}

async function extractImages(messages, token) {
  const refFileIds = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          try {
            const fileId = await resolveImageToRefId(part.image_url.url, token);
            refFileIds.push(fileId);
          } catch (err) {
            console.error('Image upload failed:', err.message);
          }
        }
      }
    }
  }
  return refFileIds;
}

function buildPrompt(messages) {
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      prompt += `[System]: ${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            prompt += `[User]: ${part.text}\n\n`;
          }
        }
      } else {
        prompt += `[User]: ${msg.content}\n\n`;
      }
    } else if (msg.role === 'assistant') {
      prompt += `[Assistant]: ${msg.content}\n\n`;
    }
  }
  return prompt.trim();
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false, max_tokens } = req.body;

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const modelType = mapModel(model);
  const prompt = buildPrompt(messages);
  const thinkingEnabled = req.body.thinking_enabled ?? true;
  const searchEnabled = req.body.search_enabled ?? (modelType !== 'vision');
  // Default: send thinking as separate reasoning_content field (recognized by Claude Code, OpenAI clients)
  // Set merge_thinking=true or MERGE_THINKING=true to merge into content with <arg_key> tags instead
  const mergeThinking = req.body.merge_thinking ?? (process.env.MERGE_THINKING === 'true');

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestStart = Date.now();
  let result;

  try {
    let refFileIds = [];
    let uploadSlot = null;
    if (modelType === 'vision') {
      uploadSlot = await enqueueRequest(true);
      try {
        refFileIds = await extractImages(messages, uploadSlot.token);
      } finally {
        uploadSlot.release();
        dispatchQueued();
      }
    }

    result = await completion({ modelType, prompt, thinkingEnabled, searchEnabled, refFileIds, preferVision: modelType === 'vision' });
  } catch (err) {
    console.error('Completion error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot, sessionId: completionSessionId } = result;

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      res.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let inThinkingPhase = thinkingEnabled;
      let thinkingTagOpened = false;
      let firstChunkTime = null;
      let streamUsage = 0;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'error') {
          if (event.code === 40004) {
            console.error(`Account BANNED in stream: ${slot.token.slice(0, 12)}...`);
          }
          throw new Error(event.message || `DeepSeek error ${event.code}`);
        }
        if (event.type === 'content') {
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            recordTTFB(model, firstChunkTime - requestStart);
          }
          if (mergeThinking && thinkingTagOpened) {
            thinkingTagOpened = false;
            res.write(`data: ${JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: '\n</think>\n' }, finish_reason: null }],
            })}\n\n`);
          }
          inThinkingPhase = false;
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'thinking' && inThinkingPhase) {
          if (mergeThinking) {
            if (!thinkingTagOpened) {
              thinkingTagOpened = true;
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { content: '<think>\n' }, finish_reason: null }],
              })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (event.type === 'usage') {
          streamUsage = event.usage;
        } else if (event.type === 'done') {
          if (mergeThinking && thinkingTagOpened) {
            thinkingTagOpened = false;
            res.write(`data: ${JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: '\n</think>\n' }, finish_reason: null }],
            })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          // Record token speed at stream end
          const streamDuration = Date.now() - requestStart;
          if (streamUsage > 0 && streamDuration > 0) {
            recordTokenSpeed(model, streamUsage, streamDuration);
          }
        }
      }
      res.end();
    } else {
      let fullContent = '';
      let fullThinking = '';
      let usage = 0;
      let inThinkingPhase = thinkingEnabled;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'error') {
          if (event.code === 40004) {
            console.error(`Account BANNED in stream: ${slot.token.slice(0, 12)}...`);
          }
          throw new Error(event.message || `DeepSeek error ${event.code}`);
        }
        if (event.type === 'content') {
          fullContent += event.content;
          inThinkingPhase = false;
        } else if (event.type === 'thinking' && inThinkingPhase) {
          fullThinking += event.content;
        } else if (event.type === 'usage') usage = event.usage;
      }

      // Record TTFB and token speed for non-streaming
      const totalDuration = Date.now() - requestStart;
      recordTTFB(model, totalDuration);
      if (usage > 0 && totalDuration > 0) {
        recordTokenSpeed(model, usage, totalDuration);
      }

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: mergeThinking && fullThinking
              ? `<think>\n${fullThinking}\n</think>\n${fullContent}`
              : fullContent,
            ...((!mergeThinking && fullThinking) ? { reasoning_content: fullThinking } : {}),
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: usage,
          total_tokens: usage,
        },
      };
      res.json(response);
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    slot.release();
    dispatchQueued();
    // Auto-delete session on DeepSeek based on AUTO_DELETE mode
    autoDeleteAfterCompletion(slot.token, completionSessionId).catch(() => {});
  }
}

export function handleOpenAIModels(req, res) {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAP).map((id, i) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'deepseek',
    })),
  });
}
