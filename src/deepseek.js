import { completion, parseSSEStream } from './chat.js';
import { pickToken } from './auth.js';
import { dispatchQueued } from './queue.js';
import { autoDeleteAfterCompletion } from './session.js';

const MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  'deepseek-v4-pro': 'expert',
  'deepseek-v4-vision': 'vision',
  'deepseek-v4-flash[1m]': 'default',
  'deepseek-v4-pro[1m]': 'expert',
  'deepseek-v4-vision[1m]': 'vision',
};

export async function handleDeepSeekCompletion(req, res) {
  const body = req.body;
  const modelType = body.model_type || MODEL_MAP[body.model] || 'default';
  const prompt = body.prompt || '';
  const thinkingEnabled = body.thinking_enabled ?? false;
  const searchEnabled = body.search_enabled ?? false;
  const parentMessageId = body.parent_message_id ?? null;
  const refFileIds = body.ref_file_ids ?? [];

  if (!prompt) {
    return res.status(400).json({ code: 1, msg: 'prompt is required' });
  }

  let slot = null;
  let completionSessionId = null;

  try {
    const result = await completion({ modelType, prompt, thinkingEnabled, searchEnabled, parentMessageId, refFileIds });
    slot = result.slot;
    completionSessionId = result.sessionId;
    const streamBody = result.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    const reader = streamBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err) {
    console.error('DeepSeek completion error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ code: 1, msg: err.message });
    } else {
      res.end();
    }
  } finally {
    if (slot) {
      // Auto-delete session on DeepSeek based on AUTO_DELETE mode
      autoDeleteAfterCompletion(slot.token, completionSessionId).catch(() => {});
      slot.release();
    }
    dispatchQueued();
  }
}
