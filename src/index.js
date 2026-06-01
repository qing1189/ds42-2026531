import { config } from 'dotenv';
config();

import express from 'express';
import { loadConfig, getConfigPath } from './persist.js';
import { initTokenPool, getPoolInfo, getTotalCapacity, addTokenToPool, loginAndAddToken, getAliveTokens, startHealthCheck, addAccountToPool, listAccounts, removeAccountFromPool, removeTokenFromPool } from './auth.js';
import { prewarmSessions, getSessionInfo, deleteSession, clearAllSessions, getAutoDeleteMode, setAutoDeleteMode } from './session.js';
import { handleOpenAICompletion, handleOpenAIModels } from './openai.js';
import { handleDeepSeekCompletion } from './deepseek.js';
import { getQueueInfo } from './queue.js';
import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, readChatLogs, listLogDates } from './logger.js';
import { getMetrics, getTimeseries } from './metrics.js';
import { getProxyConfig, setManualProxy, setXiequApiUrl, fetchXiequProxy, checkProxy, restoreProxyConfig } from './proxy.js';
import { getAllUsageStats, resetAllUsage, resetApiKeyUsage, resetAccountUsage } from './usage.js';
import { getSchedulerStatus, getSchedulerConfig, updateSchedulerConfig, resetTokenWeight, resetAllSchedulerState, clearTokenCooldown } from './scheduler.js';
import { getFingerprintConfig, setFingerprintConfig, getFingerprintStatus, rotateFingerprint } from './headers.js';
import {
  hasApiKeys, isValidApiKey, listApiKeysMasked, listApiKeysPlain, addApiKey, removeApiKeyById,
  panelAuthRequired, verifyPanelPassword, createPanelSession, isValidPanelSession, setPanelPassword, getAccessConfig,
  getFirstApiKey,
} from './access.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Request logging (writes to LOG_DIR or its default)
app.use(requestLogger('deepseek-2api'));

// ---- Auth helpers ---------------------------------------------------------
function bearerToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

// API key auth — guards only the proxy API endpoints. Open when no key configured.
function apiKeyAuth(req, res, next) {
  if (!hasApiKeys()) return next();
  const key = bearerToken(req);
  if (key && isValidApiKey(key)) return next();
  res.status(401).json({ error: { message: 'Invalid API key' } });
}

// Panel auth — guards the admin/performance management APIs. Open when no panel
// password configured (so the first-run setup can set one).
function panelAuth(req, res, next) {
  if (!panelAuthRequired()) return next();
  const token = bearerToken(req) || req.headers['x-panel-token'];
  if (token && isValidPanelSession(token)) return next();
  res.status(401).json({ error: { message: 'Panel authentication required' } });
}

// ---- Health check (public) ------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// ---- Proxy API (API key auth) --------------------------------------------
// OpenAI format
app.post('/v1/chat/completions', apiKeyAuth, handleOpenAICompletion);
app.get('/v1/models', apiKeyAuth, handleOpenAIModels);
// DeepSeek native format
app.post('/api/v0/chat/completion', apiKeyAuth, handleDeepSeekCompletion);

// ---- Panel pages (HTML, public) ------------------------------------------
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'index.html'));
});
app.get('/performance', (req, res) => {
  res.sendFile(join(__dirname, 'performance', 'index.html'));
});
app.get('/playground', (req, res) => {
  res.sendFile(join(__dirname, 'playground', 'index.html'));
});
app.get('/scheduler', (req, res) => {
  res.sendFile(join(__dirname, 'scheduler', 'index.html'));
});

// Playground: get default API key for auto-fill (no auth — same-origin only)
app.get('/playground/api/default-key', (req, res) => {
  res.json({ key: getFirstApiKey() });
});

// ---- Public panel endpoints (must be registered BEFORE the panelAuth guard)
app.get('/admin/api/config', (req, res) => {
  res.json(getAccessConfig());
});

app.post('/admin/api/login', (req, res) => {
  if (!panelAuthRequired()) {
    return res.json({ success: true, token: null, panelAuthRequired: false });
  }
  const { password } = req.body || {};
  if (verifyPanelPassword(password)) {
    return res.json({ success: true, token: createPanelSession() });
  }
  res.status(401).json({ error: { message: 'Incorrect panel password' } });
});

// ---- Everything else under /admin/api and /performance/api needs panel auth
app.use(['/admin/api', '/performance/api'], panelAuth);

// Admin: stats & logs
app.get('/admin/api/stats', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptimeSeconds,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    sessions: getSessionInfo(),
    autoDeleteMode: getAutoDeleteMode(),
    logStats: getLogStats(),
  });
});

app.get('/admin/api/logs', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  res.json({ logs: getRecentLogs(count), stats: getLogStats() });
});

app.get('/admin/api/logs/dates', (req, res) => {
  res.json({ dates: listLogDates() });
});

app.get('/admin/api/logs/history', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: { message: 'date param required (YYYY-MM-DD)' } });
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  res.json({ logs: readHistoricalLogs(date, count) });
});

app.get('/admin/api/logs/chats', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const count = Math.min(parseInt(req.query.count) || 20, 500);
  res.json({ chats: readChatLogs(date, count) });
});

// Admin: DeepSeek token management (hot-reload)
app.post('/admin/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, visionCapable: added.visionCapable });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const token = await loginAndAddToken(email, password);
    res.json({ success: true, token: token.slice(0, 12) + '...' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Remove a token from the pool by prefix (hot-reload)
app.post('/admin/api/token/remove', (req, res) => {
  const { tokenPrefix } = req.body || {};
  if (!tokenPrefix) {
    return res.status(400).json({ error: { message: 'tokenPrefix required' } });
  }
  const result = removeTokenFromPool(tokenPrefix);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// --- Account management (email or phone, hot-reload) ---
app.get('/admin/api/accounts', (req, res) => {
  res.json({ success: true, accounts: listAccounts() });
});

app.post('/admin/api/account/add', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email/phone and password required' } });
  }
  try {
    const result = await addAccountToPool(email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/account/remove', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: { message: 'email/phone required' } });
  }
  const result = removeAccountFromPool(email);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// Clear cooldown for a specific token (by token prefix)
app.post('/admin/api/account/clear-cooldown', (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  const result = clearTokenCooldown(token);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// Reset weight for a specific token (by token prefix)
app.post('/admin/api/account/reset-weight', (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  const result = resetTokenWeight(token);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// --- Login Proxy management (仅用于添加账号时绕过 WAF，不影响 API 转发) ---
app.get('/admin/api/proxy', (req, res) => {
  res.json({ success: true, ...getProxyConfig() });
});

app.post('/admin/api/proxy/manual', (req, res) => {
  const { proxyUrl } = req.body || {};
  setManualProxy(proxyUrl || '');
  res.json({ success: true, message: proxyUrl ? '手动代理已设置' : '手动代理已清除' });
});

app.post('/admin/api/proxy/xiequ', (req, res) => {
  const { apiUrl } = req.body || {};
  if (apiUrl && !apiUrl.startsWith('http://') && !apiUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: '携趣 API 地址需以 http:// 或 https:// 开头' } });
  }
  setXiequApiUrl(apiUrl || '');
  res.json({ success: true, message: apiUrl ? '携趣 API 已设置' : '携趣 API 已清除' });
});

app.post('/admin/api/proxy/xiequ/test', async (req, res) => {
  const { proxy, error } = await fetchXiequProxy();
  if (!proxy) {
    return res.status(502).json({ success: false, error: { message: error || '提取失败' } });
  }
  const check = await checkProxy(proxy);
  res.json({ success: true, proxy, check });
});

app.post('/admin/api/proxy/check', async (req, res) => {
  const { proxyUrl } = req.body || {};
  if (!proxyUrl) {
    return res.status(400).json({ error: { message: 'proxyUrl required' } });
  }
  const result = await checkProxy(proxyUrl);
  res.json({ success: true, ...result });
});

// --- Usage statistics (用量统计) ---
app.get('/admin/api/usage', (req, res) => {
  res.json({ success: true, ...getAllUsageStats() });
});

app.post('/admin/api/usage/reset', (req, res) => {
  const result = resetAllUsage();
  res.json(result);
});

app.post('/admin/api/usage/reset/apikey', (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: { message: 'apiKey required' } });
  }
  const result = resetApiKeyUsage(apiKey);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

app.post('/admin/api/usage/reset/account', (req, res) => {
  const { account } = req.body || {};
  if (!account) {
    return res.status(400).json({ error: { message: 'account required' } });
  }
  const result = resetAccountUsage(account);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// --- Smart Scheduler (智能调度器) ---
app.get('/admin/api/scheduler', (req, res) => {
  res.json({ success: true, ...getSchedulerStatus() });
});

app.get('/admin/api/scheduler/config', (req, res) => {
  res.json({ success: true, config: getSchedulerConfig() });
});

app.post('/admin/api/scheduler/config', (req, res) => {
  const updates = req.body || {};
  const result = updateSchedulerConfig(updates);
  res.json(result);
});

app.post('/admin/api/scheduler/reset', (req, res) => {
  const result = resetAllSchedulerState();
  res.json(result);
});

app.post('/admin/api/scheduler/reset/token', (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: { message: 'token (prefix) required' } });
  }
  const result = resetTokenWeight(token);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// --- Fingerprint rotation (指纹轮换) ---
app.get('/admin/api/fingerprint', (req, res) => {
  res.json({ success: true, config: getFingerprintConfig(), entries: getFingerprintStatus() });
});

app.post('/admin/api/fingerprint/config', (req, res) => {
  const updates = req.body || {};
  const result = setFingerprintConfig(updates);
  res.json({ success: true, config: result });
});

app.post('/admin/api/fingerprint/rotate', (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  rotateFingerprint(token);
  res.json({ success: true, message: '指纹已轮换' });
});

// --- Session cache management (hot-reload) ---
app.post('/admin/api/session/delete', (req, res) => {
  const { cacheKey } = req.body || {};
  if (!cacheKey) {
    return res.status(400).json({ error: { message: 'cacheKey required' } });
  }
  deleteSession(cacheKey).then(result => {
    if (result.success) res.json(result);
    else res.status(400).json(result);
  }).catch(err => res.status(500).json({ error: { message: err.message } }));
});

app.post('/admin/api/session/clear', (req, res) => {
  clearAllSessions().then(result => {
    res.json(result);
  }).catch(err => res.status(500).json({ error: { message: err.message } }));
});

// --- Auto-delete mode management ---
app.get('/admin/api/session/auto-delete', (req, res) => {
  res.json({ success: true, mode: getAutoDeleteMode() });
});

app.post('/admin/api/session/auto-delete', (req, res) => {
  const { mode } = req.body || {};
  if (!mode) {
    return res.status(400).json({ error: { message: 'mode required (none | single | all)' } });
  }
  const result = setAutoDeleteMode(mode);
  if (result.success) res.json(result);
  else res.status(400).json(result);
});

// Admin: API key management (hot-reload)
app.get('/admin/api/apikeys', (req, res) => {
  res.json({ keys: listApiKeysPlain() });
});

app.post('/admin/api/apikeys/add', (req, res) => {
  const { key } = req.body || {};
  try {
    const result = addApiKey(key);
    if (!result.added) {
      return res.status(409).json({ error: { message: 'API key already exists' } });
    }
    res.json({ success: true, generated: !!result.generated, key: result.key });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/apikeys/remove', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: { message: 'id required' } });
  const removed = removeApiKeyById(id);
  if (!removed) return res.status(404).json({ error: { message: 'API key not found' } });
  res.json({ success: true });
});

// Admin: panel password (set / change). Open until a password is set (first-run).
app.post('/admin/api/password/set', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  try {
    setPanelPassword(newPassword, oldPassword);
    // Issue a fresh session so the caller stays authenticated after the change.
    res.json({ success: true, token: createPanelSession() });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// Performance monitoring
app.get('/performance/api/metrics', (req, res) => {
  res.json(getMetrics());
});

app.get('/performance/api/timeseries', (req, res) => {
  const range = req.query.range || '6h';
  const points = getTimeseries(range);
  const pool = getPoolInfo();
  const totalCap = getTotalCapacity();
  const queue = getQueueInfo();
  res.json({ points, pool, totalCapacity: totalCap, queue });
});

app.listen(PORT, async () => {
  console.log(`DeepSeek 2API running on http://localhost:${PORT}`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`DeepSeek format: POST /api/v0/chat/completion`);
  console.log(`Models: GET /v1/models`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Data persist: ${getConfigPath()}`);

  // 加载持久化配置（触发各模块从 JSON 读取）
  const persistedConfig = loadConfig();
  if (Object.keys(persistedConfig).length > 0) {
    console.log(`[Persist] Loaded config keys: ${Object.keys(persistedConfig).join(', ')}`);
  } else {
    console.log(`[Persist] No persisted config found, using env/defaults`);
  }

  // 恢复代理配置
  restoreProxyConfig();

  await initTokenPool();

  const aliveTokens = getAliveTokens();
  await prewarmSessions(aliveTokens);

  startHealthCheck();
});
