import { reportTokenError, reportTokenSuccess, setRequestToken, getRequestToken } from './auth.js';
import { apiHeaders, proxiedFetch } from './headers.js';
import { recordSessionHit } from './metrics.js';

const BASE_URL = 'https://chat.deepseek.com';
const SESSION_TTL = 259200; // 3 days in seconds

const sessionPool = new Map(); // key: token:model_type, value: { id, model_type, createdAt, token }

// --- Auto-delete mode: 'none' | 'single' | 'all' ---
// 'none'   — keep sessions (default)
// 'single' — delete the current session on DeepSeek after each chat completion
// 'all'    — delete ALL sessions on DeepSeek after each chat completion
let autoDeleteMode = (process.env.AUTO_DELETE || 'none').toLowerCase().trim();
if (!['none', 'single', 'all'].includes(autoDeleteMode)) {
  console.warn(`Invalid AUTO_DELETE value "${autoDeleteMode}", falling back to "none"`);
  autoDeleteMode = 'none';
}

export function getAutoDeleteMode() {
  return autoDeleteMode;
}

export function setAutoDeleteMode(mode) {
  mode = (mode || 'none').toLowerCase().trim();
  if (!['none', 'single', 'all'].includes(mode)) {
    return { success: false, message: `无效的模式 "${mode}"，可选值: none, single, all` };
  }
  autoDeleteMode = mode;
  return { success: true, message: `自动删除模式已设置为: ${mode}` };
}

export async function createSession(token, modelType = 'default') {
  const res = await proxiedFetch(`${BASE_URL}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: await apiHeaders(token),
    body: JSON.stringify({}),
  });
  const json = await res.json();

  // Token invalid — report error so auth.js can mark it dead
  if (json.code === 40003) {
    reportTokenError(token);
    throw new Error('Token invalid (40003)');
  }

  const session = json.data?.biz_data?.chat_session;
  if (!session) {
    reportTokenError(token);
    throw new Error(`Session create failed: ${json.msg || JSON.stringify(json)}`);
  }

  reportTokenSuccess(token);
  return session;
}

export async function getSession(token, modelType) {
  const cacheKey = `${token.slice(0, 12)}:${modelType}`;
  const now = Date.now() / 1000;
  const cached = sessionPool.get(cacheKey);

  if (cached && (now - cached.createdAt) < SESSION_TTL) {
    recordSessionHit(true);
    return cached;
  }

  const session = await createSession(token, modelType);
  recordSessionHit(false);
  session.createdAt = now;
  session.token = token;
  sessionPool.set(cacheKey, session);
  return session;
}

// Remove cached sessions for a specific token prefix (used after token refresh)
export function invalidateTokenSessions(tokenPrefix) {
  for (const key of sessionPool.keys()) {
    if (key.startsWith(tokenPrefix + ':')) {
      sessionPool.delete(key);
    }
  }
}

export function getSessionInfo() {
  const now = Date.now() / 1000;
  const entries = [];
  for (const [key, val] of sessionPool) {
    const age = now - val.createdAt;
    entries.push({
      key,
      modelType: val.model_type,
      ageSeconds: Math.floor(age),
      ttlRemainingSeconds: Math.max(0, Math.floor(SESSION_TTL - age)),
    });
  }
  return { count: sessionPool.size, ttl: SESSION_TTL, sessions: entries };
}

// Delete a single cached session by its cache key (hot-reload).
// Now also deletes the session on DeepSeek's remote server.
export async function deleteSession(cacheKey) {
  const cached = sessionPool.get(cacheKey);
  if (!cached) {
    return { success: false, message: `会话 ${cacheKey} 不存在` };
  }

  // Delete from DeepSeek remote
  const remoteResult = await deleteRemoteSession(cached.token, cached.id);
  // Always remove from local cache regardless of remote result
  sessionPool.delete(cacheKey);

  if (remoteResult.success) {
    return { success: true, message: `会话 ${cacheKey} 已删除（本地+远程）` };
  } else {
    return { success: true, message: `会话 ${cacheKey} 本地已删除，远程删除失败: ${remoteResult.error}` };
  }
}

// Clear the entire session cache (hot-reload).
// Now also deletes all sessions on DeepSeek's remote server for each token.
export async function clearAllSessions() {
  const count = sessionPool.size;
  const tokensProcessed = new Set();
  const errors = [];

  for (const [key, session] of sessionPool) {
    if (!tokensProcessed.has(session.token)) {
      tokensProcessed.add(session.token);
      const result = await deleteAllRemoteSessions(session.token);
      if (!result.success) {
        errors.push(result.error);
      }
    }
  }

  sessionPool.clear();

  if (errors.length === 0) {
    return { success: true, message: `已清空 ${count} 个会话缓存（本地+远程）` };
  } else {
    return { success: true, message: `已清空 ${count} 个会话缓存（本地），部分远程删除失败: ${errors.join('; ')}` };
  }
}

// --- Remote session deletion APIs ---

// Delete a single session on DeepSeek
export async function deleteRemoteSession(token, sessionId) {
  if (!token || !sessionId) {
    return { success: false, error: 'token or sessionId missing' };
  }
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/chat_session/delete`, {
      method: 'POST',
      headers: await apiHeaders(token),
      body: JSON.stringify({ chat_session_id: sessionId }),
    });
    const json = await res.json();
    if (json.code === 0) {
      console.log(`[session] Remote session deleted: ${sessionId.slice(0, 8)}...`);
      return { success: true };
    }
    // Token invalid
    if (json.code === 40003) {
      reportTokenError(token);
      return { success: false, error: 'Token invalid (40003)' };
    }
    return { success: false, error: `code=${json.code} msg=${json.msg || ''}` };
  } catch (err) {
    console.error(`[session] Remote session delete error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Delete ALL sessions on DeepSeek for a given token
export async function deleteAllRemoteSessions(token) {
  if (!token) {
    return { success: false, error: 'token missing' };
  }
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/chat_session/delete_all`, {
      method: 'POST',
      headers: await apiHeaders(token),
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (json.code === 0) {
      console.log(`[session] All remote sessions deleted for token ${token.slice(0, 12)}...`);
      return { success: true };
    }
    if (json.code === 40003) {
      reportTokenError(token);
      return { success: false, error: 'Token invalid (40003)' };
    }
    return { success: false, error: `code=${json.code} msg=${json.msg || ''}` };
  } catch (err) {
    console.error(`[session] Remote delete-all error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Auto-delete handler: called after each completion based on autoDeleteMode
export async function autoDeleteAfterCompletion(token, sessionId) {
  if (autoDeleteMode === 'none') return;

  try {
    if (autoDeleteMode === 'single') {
      if (!sessionId) {
        console.warn('[auto_delete] Skipped: session_id is empty');
        return;
      }
      const result = await deleteRemoteSession(token, sessionId);
      if (result.success) {
        // Also remove from local cache
        for (const [key, val] of sessionPool) {
          if (val.id === sessionId) {
            sessionPool.delete(key);
            break;
          }
        }
        console.log(`[auto_delete] single: session ${sessionId.slice(0, 8)}... deleted`);
      } else {
        console.warn(`[auto_delete] single: failed - ${result.error}`);
      }
    } else if (autoDeleteMode === 'all') {
      const result = await deleteAllRemoteSessions(token);
      if (result.success) {
        // Clear all local sessions for this token
        for (const [key, val] of sessionPool) {
          if (val.token === token) {
            sessionPool.delete(key);
          }
        }
        console.log(`[auto_delete] all: sessions deleted for token ${token.slice(0, 12)}...`);
      } else {
        console.warn(`[auto_delete] all: failed - ${result.error}`);
      }
    }
  } catch (err) {
    console.error(`[auto_delete] Error: ${err.message}`);
  }
}

export async function prewarmSessions(tokens, modelTypes = ['default', 'expert']) {
  const { getPoolInfo } = await import('./auth.js');
  const poolInfo = getPoolInfo();
  const alivePrefixes = poolInfo.filter(t => !t.dead && t.token !== 'NONE').map(t => t.token.replace('...', ''));

  console.log(`Pre-warming sessions for ${alivePrefixes.length} alive tokens × ${modelTypes.length} model types...`);
  const promises = [];
  for (const token of tokens) {
    const prefix = token.slice(0, 12);
    if (!alivePrefixes.includes(prefix)) continue;
    for (const modelType of modelTypes) {
      const cacheKey = `${prefix}:${modelType}`;
      if (!sessionPool.has(cacheKey)) {
        promises.push(
          getSession(token, modelType).catch(() => {})
        );
      }
    }
    if (promises.length >= 6) {
      await Promise.allSettled(promises.splice(0));
    }
  }
  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
  console.log(`Session pool: ${sessionPool.size} cached sessions`);
}
