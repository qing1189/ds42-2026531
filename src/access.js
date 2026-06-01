// Access control: API keys (for /v1 & /api/v0) and the admin panel password.
// Both are independent. All state is kept in memory (hot-reload) and persisted
// to .env so it survives restarts (when .env is writable).

import { config } from 'dotenv';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { updateEnvVars } from './env_store.js';
import { getConfigValue, setConfigValue } from './persist.js';

config();

function parseList(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// ----------------------------------------------------------------------------
// API keys (multiple, hot-reloadable)
//   Sources: JSON persist > API_KEYS=key1,key2 (preferred) and/or API_KEY=key (legacy single)
// ----------------------------------------------------------------------------
const apiKeys = new Set();

// 优先从 JSON 持久化文件加载
const persistedKeys = getConfigValue('apiKeys');
if (Array.isArray(persistedKeys) && persistedKeys.length > 0) {
  for (const k of persistedKeys) if (k) apiKeys.add(k);
} else {
  // 兜底：从环境变量加载
  for (const k of parseList(process.env.API_KEYS)) apiKeys.add(k);
  if (process.env.API_KEY?.trim()) apiKeys.add(process.env.API_KEY.trim());
}

function keyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function maskKey(key) {
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function persistApiKeys() {
  updateEnvVars({ API_KEYS: [...apiKeys].join(',') });
  // 同步持久化到 JSON
  setConfigValue('apiKeys', [...apiKeys]);
}

export function hasApiKeys() {
  return apiKeys.size > 0;
}

export function isValidApiKey(key) {
  return !!key && apiKeys.has(key);
}

// Masked list for the admin UI: { id, masked }
export function listApiKeysMasked() {
  return [...apiKeys].map(k => ({ id: keyId(k), masked: maskKey(k) }));
}

// Full plaintext list for the admin UI (no masking): { id, key }
export function listApiKeysPlain() {
  return [...apiKeys].map(k => ({ id: keyId(k), key: k }));
}

// Add an explicit key, or generate one when no key is provided.
// Returns { added, generated, key? }.
export function addApiKey(key) {
  const trimmed = (key || '').trim();
  if (trimmed) {
    if (apiKeys.has(trimmed)) return { added: false, generated: false };
    apiKeys.add(trimmed);
    persistApiKeys();
    return { added: true, generated: false };
  }
  const generated = 'sk-' + randomBytes(24).toString('hex');
  apiKeys.add(generated);
  persistApiKeys();
  return { added: true, generated: true, key: generated };
}

export function removeApiKeyById(id) {
  for (const k of apiKeys) {
    if (keyId(k) === id) {
      apiKeys.delete(k);
      persistApiKeys();
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// Panel password + sessions (independent from API keys)
// ----------------------------------------------------------------------------
let panelPassword = process.env.PANEL_PASSWORD?.trim() || '';

const PANEL_SESSION_TTL = 24 * 60 * 60 * 1000; // 24h
const panelSessions = new Map(); // sessionToken -> expiresAt (ms)

export function panelAuthRequired() {
  return !!panelPassword;
}

export function verifyPanelPassword(pw) {
  if (!panelPassword) return false;
  const a = Buffer.from(String(pw ?? ''));
  const b = Buffer.from(panelPassword);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createPanelSession() {
  const token = randomBytes(24).toString('hex');
  panelSessions.set(token, Date.now() + PANEL_SESSION_TTL);
  return token;
}

export function isValidPanelSession(token) {
  if (!token) return false;
  const expires = panelSessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    panelSessions.delete(token);
    return false;
  }
  return true;
}

// Set or change the panel password. When a password already exists, the correct
// old password is required. Changing the password invalidates existing sessions.
export function setPanelPassword(newPassword, oldPassword) {
  const np = (newPassword || '').trim();
  if (np.length < 4) throw new Error('Password must be at least 4 characters');
  if (panelPassword && !verifyPanelPassword(oldPassword)) {
    throw new Error('Current password is incorrect');
  }
  panelPassword = np;
  updateEnvVars({ PANEL_PASSWORD: np });
  panelSessions.clear();
}

// Config snapshot for the UI bootstrap (no secrets).
export function getAccessConfig() {
  return {
    panelAuthRequired: panelAuthRequired(),
    apiAuthEnabled: hasApiKeys(),
    apiKeyCount: apiKeys.size,
  };
}

// Get the first configured API key (full value) for internal use (e.g. playground).
export function getFirstApiKey() {
  if (apiKeys.size === 0) return '';
  return [...apiKeys][0];
}
