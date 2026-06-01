/**
 * Login Proxy Manager
 * 
 * 仅用于添加账号时的登录请求，绕过 DeepSeek WAF 拦截。
 * 支持：
 *   1. 手动添加 HTTP 代理
 *   2. 携趣 IP 短效代理 API 自动提取
 *   3. 代理可用性检测
 * 
 * 代理格式统一为 ip:port 或 user:pass@ip:port（不含协议头），
 * 内部使用时自动添加 http:// 前缀。
 * 
 * 携趣短效代理在每一次登录账号时重新从携趣 API 拉取新的代理用以登陆。
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

// 登录代理配置（内存存储，热加载）
const proxyConfig = {
  // 手动代理 (ip:port 或 user:pass@ip:port)
  manualProxy: '',
  // 携趣 API 提取地址
  xiequApiUrl: '',
};

// 统一格式化代理地址：确保有 http:// 前缀
function formatProxyUrl(proxy) {
  if (!proxy) return '';
  proxy = proxy.trim();
  if (proxy.startsWith('http://') || proxy.startsWith('https://') || proxy.startsWith('socks5://')) {
    return proxy;
  }
  return `http://${proxy}`;
}

// ==================== 配置管理 ====================

export function getProxyConfig() {
  return {
    manualProxy: proxyConfig.manualProxy,
    xiequApiUrl: proxyConfig.xiequApiUrl,
  };
}

export function setManualProxy(url) {
  // 去掉用户可能多加的 http:// 前缀，统一存储为 ip:port 格式
  let cleaned = (url || '').trim();
  cleaned = cleaned.replace(/^https?:\/\//, '');
  proxyConfig.manualProxy = cleaned;
  console.log(`[LoginProxy] Manual proxy set: ${proxyConfig.manualProxy || '(cleared)'}`);
}

export function setXiequApiUrl(url) {
  proxyConfig.xiequApiUrl = (url || '').trim();
  console.log(`[LoginProxy] Xiequ API URL set: ${proxyConfig.xiequApiUrl || '(cleared)'}`);
}

// ==================== 携趣 API 提取 ====================

const IP_PORT_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/;

function parseXiequResponse(text) {
  if (!text || !text.trim()) return null;
  text = text.trim();

  // 尝试 JSON 格式
  try {
    const data = JSON.parse(text);
    if (typeof data === 'object' && data !== null) {
      const code = data.code;
      if (code !== undefined && String(code) !== '0' && String(code) !== '200') {
        console.warn(`[LoginProxy] Xiequ API error code=${code}, msg=${data.msg || data.message || ''}`);
      }
      const items = data.data || data.list || [];
      if (Array.isArray(items) && items.length > 0) {
        const item = items[0];
        if (typeof item === 'object') {
          const ip = item.ip || item.IP;
          const port = item.port || item.Port;
          if (ip && port) return `${ip}:${port}`;
        }
      }
    }
  } catch {
    // not JSON, try regex
  }

  // 正则兜底：提取第一个 ip:port
  const m = text.match(IP_PORT_RE);
  if (m) return `${m[1]}:${m[2]}`;

  console.warn(`[LoginProxy] Cannot parse xiequ response: ${text.slice(0, 200)}`);
  return null;
}

export async function fetchXiequProxy(timeout = 15000) {
  const apiUrl = proxyConfig.xiequApiUrl;
  if (!apiUrl) return { proxy: null, error: '未配置携趣 API 地址' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (deepseek-2api/proxy-fetcher)',
        'Accept': '*/*',
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      return { proxy: null, error: `HTTP ${res.status}: ${snippet}` };
    }

    const text = await res.text();
    const proxy = parseXiequResponse(text);
    if (proxy) {
      return { proxy, error: null };
    }
    return { proxy: null, error: `返回内容无法解析为 ip:port: ${text.slice(0, 200)}` };
  } catch (err) {
    return { proxy: null, error: `${err.name}: ${err.message}` };
  }
}

// ==================== 代理可用性检测 ====================

export async function checkProxy(proxyUrl, timeout = 10000) {
  if (!proxyUrl) return { ok: false, error: '代理地址为空' };

  const fullUrl = formatProxyUrl(proxyUrl);

  try {
    const agent = new ProxyAgent(fullUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const startTime = Date.now();
    const res = await undiciFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_path: '/api/v0/users/login' }),
      dispatcher: agent,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latency = Date.now() - startTime;

    // 只要能连通就算可用（WAF 202 也说明代理本身能工作）
    if (res.status === 202) {
      return { ok: true, latency, note: 'WAF challenge (可能需住宅IP)', status: res.status };
    }
    if (res.status >= 200 && res.status < 500) {
      return { ok: true, latency, status: res.status };
    }
    return { ok: false, error: `HTTP ${res.status}`, latency, status: res.status };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

// ==================== 获取登录代理 ====================

/**
 * 获取用于登录的代理 URL（含 http:// 前缀）。
 * 优先级：携趣 API（每次重新拉取新代理） > 手动代理 > null（直连）
 * 
 * 注意：携趣短效代理在每一次登录账号时重新从 API 拉取新的代理，
 * 确保每次登录都使用全新的 IP 地址。
 */
export async function acquireLoginProxy() {
  // 1. 优先携趣 API（短效代理）— 每次都重新拉取新代理
  if (proxyConfig.xiequApiUrl) {
    const { proxy, error } = await fetchXiequProxy();
    if (proxy) {
      console.log(`[LoginProxy] Xiequ proxy acquired: ${proxy}`);
      return formatProxyUrl(proxy);
    }
    console.warn(`[LoginProxy] Xiequ fetch failed: ${error}, falling back to manual proxy`);
  }

  // 2. 手动代理
  if (proxyConfig.manualProxy) {
    return formatProxyUrl(proxyConfig.manualProxy);
  }

  // 3. 无代理（直连）
  return null;
}

/**
 * 使用登录代理执行 fetch 请求。
 * 仅用于 DeepSeek 登录相关接口，不影响 API 转发。
 * 携趣短效代理在每次调用时都会重新从 API 拉取新的代理。
 */
export async function loginProxiedFetch(url, options = {}) {
  const proxyUrl = await acquireLoginProxy();
  if (proxyUrl) {
    try {
      const agent = new ProxyAgent(proxyUrl);
      options.dispatcher = agent;
      return undiciFetch(url, options);
    } catch (err) {
      console.warn(`[LoginProxy] Failed to create ProxyAgent for ${proxyUrl}: ${err.message}`);
    }
  }
  // 无代理或代理创建失败，使用直连
  return fetch(url, options);
}

// ─── Persistence support ───

export function restoreProxyConfig(config) {
  if (!config || typeof config !== 'object') return;
  if (config.manualProxy) {
    proxyConfig.manualProxy = config.manualProxy;
    console.log(`[Persist] Restored manual proxy: ${proxyConfig.manualProxy}`);
  }
  if (config.xiequApiUrl) {
    proxyConfig.xiequApiUrl = config.xiequApiUrl;
    console.log(`[Persist] Restored xiequ API URL: ${proxyConfig.xiequApiUrl}`);
  }
}
