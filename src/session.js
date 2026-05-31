import { reportTokenError, reportTokenSuccess, setRequestToken, getRequestToken } from './auth.js';
import { apiHeaders, proxiedFetch } from './headers.js';
import { recordSessionHit } from './metrics.js';

const BASE_URL = 'https://chat.deepseek.com';
const SESSION_TTL = 259200; // 3 days in seconds

const sessionPool = new Map(); // key: token:model_type, value: { id, model_type, createdAt, token }

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
