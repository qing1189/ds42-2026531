import { setRequestToken, reportTokenError, reportTokenSuccess } from './auth.js';
import { FAILURE_TYPE } from './scheduler.js';
import { solvePowChallengeWithToken } from './pow.js';
import { getSession } from './session.js';
import { streamHeaders, proxiedFetch } from './headers.js';
import { enqueueRequest, dispatchQueued } from './queue.js';

const BASE_URL = 'https://chat.deepseek.com';

export async function completion({ modelType, prompt, thinkingEnabled = false, searchEnabled = false, parentMessageId = null, refFileIds = [], preferVision = false }) {
  // Step 1: Acquire token slot first — PoW and completion must use the same token
  const slot = await enqueueRequest(preferVision);

  try {
    // Step 1.5: Respect scheduler's wait interval (anti-fingerprinting jitter)
    if (slot.waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, slot.waitMs));
    }

    // Step 2: Solve PoW using the same token
    const { powResponse } = await solvePowChallengeWithToken(slot.token);

    setRequestToken(slot.token);
    const session = await getSession(slot.token, modelType);
    setRequestToken(null);

    const body = {
      chat_session_id: session.id,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      action: null,
      preempt: false,
    };

    const res = await proxiedFetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers: await streamHeaders(slot.token, powResponse),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      // Check for specific DeepSeek error codes
      try {
        const errJson = JSON.parse(text);
        const code = errJson.code;
        // 40003 = invalid/expired token
        if (code === 40003) {
          reportTokenError(slot.token, FAILURE_TYPE.TOKEN_INVALID);
          throw new Error('Token invalid (40003)');
        }
        // 40004 = account banned
        if (code === 40004) {
          reportTokenError(slot.token, FAILURE_TYPE.ACCOUNT_BANNED);
          const entry = (await import('./auth.js')).getPoolInfo().find(t => slot.token.startsWith(t.token.replace('...', '')));
          console.error(`Account BANNED during completion: ${entry?.email || slot.token.slice(0, 12)}...`);
          throw new Error('Account banned (40004)');
        }
      } catch (parseErr) {
        if (parseErr.message.includes('Token invalid') || parseErr.message.includes('Account banned')) throw parseErr;
      }

      // HTTP status-based failure classification
      if (res.status === 429) {
        reportTokenError(slot.token, FAILURE_TYPE.RATE_LIMIT);
        throw new Error(`Rate limited (429): ${text.slice(0, 200)}`);
      }
      if (res.status === 202 || res.status === 403) {
        reportTokenError(slot.token, FAILURE_TYPE.WAF);
        throw new Error(`WAF/Forbidden (${res.status}): ${text.slice(0, 200)}`);
      }
      if (res.status === 502 || res.status === 503) {
        reportTokenError(slot.token, FAILURE_TYPE.SERVER_ERROR);
        throw new Error(`Server error (${res.status}): ${text.slice(0, 200)}`);
      }

      reportTokenError(slot.token, FAILURE_TYPE.GENERIC);
      throw new Error(`Completion request failed: ${res.status} ${text}`);
    }

    reportTokenSuccess(slot.token);
    return { body: res.body, slot, sessionId: session.id };
  } catch (err) {
    slot.release();
    dispatchQueued();
    throw err;
  }
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageIds = {};
  let currentFragmentType = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          if (line.slice(6).trim() === 'close') return;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          // Check for error codes mid-stream
          if (parsed.code === 40003) {
            yield { type: 'error', code: 40003, message: 'Token invalid' };
            return;
          }
          if (parsed.code === 40004) {
            yield { type: 'error', code: 40004, message: 'Account banned' };
            return;
          }

          if (parsed.request_message_id != null) {
            messageIds.requestMessageId = parsed.request_message_id;
            messageIds.responseMessageId = parsed.response_message_id;
          }

          if (parsed.v?.response?.fragments) {
            for (const frag of parsed.v.response.fragments) {
              if (frag.type === 'THINK' && frag.content) {
                currentFragmentType = 'THINK';
                yield { type: 'thinking', content: frag.content, messageIds };
              } else if (frag.type === 'RESPONSE' && frag.content) {
                currentFragmentType = 'RESPONSE';
                yield { type: 'content', content: frag.content, messageIds };
              }
            }
            if (parsed.v.response.accumulated_token_usage != null) {
              yield { type: 'usage', usage: parsed.v.response.accumulated_token_usage, messageIds };
            }
          }

          if (parsed.p && parsed.o) {
            if (parsed.p === 'response/fragments/-1/content' && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            } else if (parsed.p === 'response/fragments/-1/content' && !parsed.o && typeof parsed.v === 'string') {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            } else if (parsed.p === 'response/status' && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (parsed.p === 'response' && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item.p === 'accumulated_token_usage') {
                  yield { type: 'usage', usage: item.v, messageIds };
                }
              }
            } else if (parsed.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                if (frag.type === 'RESPONSE' && frag.content) {
                  currentFragmentType = 'RESPONSE';
                  yield { type: 'content', content: frag.content, messageIds };
                } else if (frag.type === 'THINK' && frag.content) {
                  currentFragmentType = 'THINK';
                  yield { type: 'thinking', content: frag.content, messageIds };
                }
              }
            }
            continue;
          }

          if (typeof parsed.v === 'string') {
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
          }

          if (Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (item.p === 'accumulated_token_usage') {
                yield { type: 'usage', usage: item.v, messageIds };
              }
            }
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
