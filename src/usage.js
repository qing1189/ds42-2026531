/**
 * Usage Statistics Module
 * 
 * 按 DeepSeek 账号和 API Key 统计用量：
 *   - 总请求数
 *   - 失败请求数
 *   - 输入 token 数
 *   - 输出 token 数
 * 
 * 支持：全部重置、按单个 API Key 重置、按单个 DeepSeek 账号重置
 */

// 统计数据结构
// key -> { totalRequests, failedRequests, inputTokens, outputTokens }
const accountStats = new Map();  // DeepSeek 账号（email/phone）-> stats
const apiKeyStats = new Map();   // API Key -> stats

function emptyStats() {
  return {
    totalRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function getOrCreate(map, key) {
  if (!map.has(key)) {
    map.set(key, emptyStats());
  }
  return map.get(key);
}

// ==================== 记录用量 ====================

/**
 * 记录一次请求的用量
 * @param {object} params
 * @param {string} params.apiKey - 调用方使用的 API Key（可为空）
 * @param {string} params.account - DeepSeek 账号/email（可为空，token-only 时）
 * @param {number} params.inputTokens - 输入 token 数
 * @param {number} params.outputTokens - 输出 token 数
 * @param {boolean} params.failed - 是否失败
 */
export function recordUsage({ apiKey, account, inputTokens = 0, outputTokens = 0, failed = false }) {
  // 按 API Key 统计
  if (apiKey) {
    const stats = getOrCreate(apiKeyStats, apiKey);
    stats.totalRequests++;
    if (failed) stats.failedRequests++;
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
  }

  // 按 DeepSeek 账号统计
  if (account) {
    const stats = getOrCreate(accountStats, account);
    stats.totalRequests++;
    if (failed) stats.failedRequests++;
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
  }
}

// ==================== 查询用量 ====================

/**
 * 获取所有统计数据
 */
export function getAllUsageStats() {
  const accounts = [];
  for (const [key, stats] of accountStats) {
    accounts.push({ account: key, ...stats });
  }

  const apiKeys = [];
  for (const [key, stats] of apiKeyStats) {
    apiKeys.push({ apiKey: key, ...stats });
  }

  // 汇总
  const total = {
    totalRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  for (const s of accountStats.values()) {
    total.totalRequests += s.totalRequests;
    total.failedRequests += s.failedRequests;
    total.inputTokens += s.inputTokens;
    total.outputTokens += s.outputTokens;
  }
  // 如果有 apiKey 统计但无 account 统计（比如 token-only 场景），也纳入 total
  for (const [key, s] of apiKeyStats) {
    // 避免重复计数：只统计没有关联到账号的纯 API Key 请求
    // 实际上每个请求都会同时记录 account 和 apiKey，所以 total 从 account 侧取即可
    // 但如果请求没有关联 account（token-only），则从 apiKey 侧补充
  }
  // 更安全的做法：total 取两者的最大值集合
  // 简化：以 apiKey 统计为准做 total（因为每个请求都一定有 apiKey 或 account）
  let totalFromApiKeys = { totalRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0 };
  for (const s of apiKeyStats.values()) {
    totalFromApiKeys.totalRequests += s.totalRequests;
    totalFromApiKeys.failedRequests += s.failedRequests;
    totalFromApiKeys.inputTokens += s.inputTokens;
    totalFromApiKeys.outputTokens += s.outputTokens;
  }

  // 使用请求数较大的那个作为总计（避免遗漏）
  const finalTotal = totalFromApiKeys.totalRequests >= total.totalRequests ? totalFromApiKeys : total;

  return { total: finalTotal, accounts, apiKeys };
}

/**
 * 获取单个 API Key 的统计
 */
export function getApiKeyUsage(apiKey) {
  return apiKeyStats.get(apiKey) || emptyStats();
}

/**
 * 获取单个账号的统计
 */
export function getAccountUsage(account) {
  return accountStats.get(account) || emptyStats();
}

// ==================== 重置用量 ====================

/**
 * 重置所有统计数据
 */
export function resetAllUsage() {
  accountStats.clear();
  apiKeyStats.clear();
  console.log('[Usage] All usage stats reset');
  return { success: true, message: '所有用量统计已重置' };
}

/**
 * 重置单个 API Key 的统计
 */
export function resetApiKeyUsage(apiKey) {
  if (!apiKeyStats.has(apiKey)) {
    return { success: false, message: `API Key 无统计记录` };
  }
  apiKeyStats.delete(apiKey);
  console.log(`[Usage] API Key usage reset: ${apiKey.slice(0, 8)}...`);
  return { success: true, message: `API Key ${apiKey.slice(0, 8)}... 用量已重置` };
}

/**
 * 重置单个 DeepSeek 账号的统计
 */
export function resetAccountUsage(account) {
  if (!accountStats.has(account)) {
    return { success: false, message: `账号 ${account} 无统计记录` };
  }
  accountStats.delete(account);
  console.log(`[Usage] Account usage reset: ${account}`);
  return { success: true, message: `账号 ${account} 用量已重置` };
}

// ==================== 辅助函数 ====================

/**
 * 对 API Key 进行脱敏显示
 */
export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}
