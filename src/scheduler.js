/**
 * Smart Scheduler — 智能权重调度器 v2
 * 
 * 目标：降低 DeepSeek 风控触发概率
 * 
 * 策略组合：
 *   1. 动态权重调度 — 成功+2 / 失败按类型惩罚，基于权重的概率调度
 *   2. 冷却机制 — 权重低于阈值时自动冷却，冷却期不参与调度
 *   3. 请求间隔抖动 — 模拟人类行为，每个 token 强制最小间隔 + 随机抖动
 *   4. 频率限制 — 每个 token 滑动窗口内请求数上限
 *   5. 失败类型细分 — 429/403/WAF/502 不同惩罚力度
 *   6. 渐进式恢复 — 冷却结束后进入观察期，低频运行
 *   7. 时间段策略 — 凌晨自动降频，模拟真人行为
 *   8. 全局自适应限速 — 多账号同时异常时整体降速
 * 
 * 失败类型惩罚：
 *   - 429 Too Many Requests: -10 权重 + 立即冷却 600s
 *   - 403/WAF (202): -8 权重 + 立即冷却 600s + 建议换指纹
 *   - 40003 Token Invalid: -5 权重（标准）
 *   - 40004 Account Banned: -50 权重（直接死亡）
 *   - 502/503 Server Error: -1 权重（服务端问题，轻惩罚）
 *   - 其他错误: -5 权重（标准）
 * 
 * 渐进式恢复：
 *   - 冷却结束后进入"观察期"（probation）
 *   - 观察期内频率限制降为正常的 1/3
 *   - 观察期内连续 N 次成功后恢复正常
 *   - 观察期内再次失败则直接进入二次冷却（时长翻倍）
 * 
 * 时间段策略：
 *   - 凌晨 2:00-6:00 频率限制降为正常的 40%
 *   - 凌晨时段间隔增加 2x
 *   - 模拟真实用户行为模式
 * 
 * 全局自适应限速：
 *   - 30秒窗口内如果 >=3 个不同 token 失败 → 触发全局降速
 *   - 全局降速期间：所有 token 频率限制降为 50%，间隔增加 3x
 *   - 全局降速持续 120s，期间无新失败则自动解除
 */

// ==================== 配置 ====================

const CONFIG = {
  // 权重参数
  INITIAL_WEIGHT: 30,
  MAX_WEIGHT: 50,
  SUCCESS_INCREMENT: 2,
  FAILURE_DECREMENT: 5,          // 默认失败惩罚
  COOLDOWN_THRESHOLD: 10,
  COOLDOWN_DURATION: 300_000,    // 300秒 = 5分钟
  COOLDOWN_RECOVERY_WEIGHT: 20,

  // 请求间隔（毫秒）
  MIN_INTERVAL: 3000,            // 同一 token 最小间隔 3 秒
  MAX_JITTER: 2000,              // 随机抖动 0~2 秒
  
  // 频率限制（滑动窗口）
  RATE_WINDOW: 60_000,           // 60 秒窗口
  RATE_LIMIT: 10,                // 每 token 60 秒内最多 10 次请求

  // 调度差值限制
  MAX_DISPATCH_DIFF: 10,

  // === 失败类型细分 ===
  PENALTY_429: 10,               // 429 惩罚
  PENALTY_WAF: 8,                // 403/WAF 惩罚
  PENALTY_TOKEN_INVALID: 5,      // 40003 惩罚
  PENALTY_BANNED: 50,            // 40004 惩罚（致死）
  PENALTY_SERVER_ERROR: 1,       // 502/503 惩罚（轻）
  COOLDOWN_429: 600_000,         // 429 冷却时长 10 分钟
  COOLDOWN_WAF: 600_000,         // WAF 冷却时长 10 分钟

  // === 渐进式恢复 ===
  PROBATION_SUCCESS_REQUIRED: 5, // 观察期需要连续成功次数
  PROBATION_RATE_MULTIPLIER: 0.33, // 观察期频率系数（正常的1/3）
  PROBATION_COOLDOWN_MULTIPLIER: 2, // 观察期再失败，冷却时长翻倍

  // === 时间段策略 ===
  NIGHT_START_HOUR: 2,           // 深夜开始（24h 格式）
  NIGHT_END_HOUR: 6,             // 深夜结束
  NIGHT_RATE_MULTIPLIER: 0.4,   // 深夜频率系数
  NIGHT_INTERVAL_MULTIPLIER: 2, // 深夜间隔倍数

  // === 全局自适应限速 ===
  GLOBAL_FAIL_WINDOW: 30_000,    // 30 秒窗口
  GLOBAL_FAIL_THRESHOLD: 3,     // 窗口内 N 个不同 token 失败触发
  GLOBAL_SLOWDOWN_DURATION: 120_000, // 全局降速持续 120s
  GLOBAL_RATE_MULTIPLIER: 0.5,  // 全局降速时频率系数
  GLOBAL_INTERVAL_MULTIPLIER: 3, // 全局降速时间隔倍数
};

// ==================== 失败类型枚举 ====================

export const FAILURE_TYPE = {
  RATE_LIMIT: '429',           // Too Many Requests
  WAF: 'waf',                  // 403 / WAF 202
  TOKEN_INVALID: 'token_invalid', // 40003
  ACCOUNT_BANNED: 'banned',    // 40004
  SERVER_ERROR: 'server_error', // 502/503
  GENERIC: 'generic',          // 其他
};

// ==================== 调度器状态 ====================

const schedulerState = new Map();

/**
 * SchedulerEntry:
 * {
 *   weight, cooling, cooldownUntil, lastRequestTime,
 *   dispatchCount, requestTimes[], totalSuccess, totalFailure,
 *   // --- 新增 ---
 *   probation: boolean,          // 是否在观察期
 *   probationSuccessCount: number, // 观察期连续成功次数
 *   consecutiveCooldowns: number,  // 连续冷却次数（用于翻倍）
 *   lastFailureType: string,       // 最近失败类型
 * }
 */

function createEntry() {
  return {
    weight: CONFIG.INITIAL_WEIGHT,
    cooling: false,
    cooldownUntil: 0,
    lastRequestTime: 0,
    dispatchCount: 0,
    requestTimes: [],
    totalSuccess: 0,
    totalFailure: 0,
    probation: false,
    probationSuccessCount: 0,
    consecutiveCooldowns: 0,
    lastFailureType: null,
  };
}

function getEntry(token) {
  if (!schedulerState.has(token)) {
    schedulerState.set(token, createEntry());
  }
  return schedulerState.get(token);
}

// ==================== 全局自适应限速状态 ====================

const globalState = {
  recentFailures: [],           // { token, time }[]
  slowdownUntil: 0,             // 全局降速截止时间
  slowdownActive: false,
};

function isGlobalSlowdown() {
  if (!globalState.slowdownActive) return false;
  if (Date.now() >= globalState.slowdownUntil) {
    globalState.slowdownActive = false;
    console.log('[Scheduler] Global slowdown lifted');
    return false;
  }
  return true;
}

function recordGlobalFailure(token) {
  const now = Date.now();
  globalState.recentFailures.push({ token, time: now });
  
  // 清理过期记录
  const cutoff = now - CONFIG.GLOBAL_FAIL_WINDOW;
  globalState.recentFailures = globalState.recentFailures.filter(f => f.time > cutoff);
  
  // 检查是否达到阈值：N 个不同 token 在窗口内失败
  const uniqueTokens = new Set(globalState.recentFailures.map(f => f.token));
  if (uniqueTokens.size >= CONFIG.GLOBAL_FAIL_THRESHOLD && !globalState.slowdownActive) {
    globalState.slowdownActive = true;
    globalState.slowdownUntil = now + CONFIG.GLOBAL_SLOWDOWN_DURATION;
    console.log(`[Scheduler] ⚠️ GLOBAL SLOWDOWN triggered! ${uniqueTokens.size} tokens failed in ${CONFIG.GLOBAL_FAIL_WINDOW/1000}s window. Slowdown for ${CONFIG.GLOBAL_SLOWDOWN_DURATION/1000}s`);
  }
}

// ==================== 时间段策略 ====================

function isNightTime() {
  const hour = new Date().getHours();
  return hour >= CONFIG.NIGHT_START_HOUR && hour < CONFIG.NIGHT_END_HOUR;
}

// ==================== 有效频率限制计算 ====================

function getEffectiveRateLimit(entry) {
  let limit = CONFIG.RATE_LIMIT;
  
  // 观察期降频
  if (entry.probation) {
    limit = Math.max(1, Math.floor(limit * CONFIG.PROBATION_RATE_MULTIPLIER));
  }
  
  // 深夜降频
  if (isNightTime()) {
    limit = Math.max(1, Math.floor(limit * CONFIG.NIGHT_RATE_MULTIPLIER));
  }
  
  // 全局降速
  if (isGlobalSlowdown()) {
    limit = Math.max(1, Math.floor(limit * CONFIG.GLOBAL_RATE_MULTIPLIER));
  }
  
  return limit;
}

function getEffectiveInterval() {
  let interval = CONFIG.MIN_INTERVAL;
  let jitter = CONFIG.MAX_JITTER;
  
  // 深夜增加间隔
  if (isNightTime()) {
    interval *= CONFIG.NIGHT_INTERVAL_MULTIPLIER;
    jitter *= CONFIG.NIGHT_INTERVAL_MULTIPLIER;
  }
  
  // 全局降速增加间隔
  if (isGlobalSlowdown()) {
    interval *= CONFIG.GLOBAL_INTERVAL_MULTIPLIER;
    jitter *= 2;
  }
  
  return { interval, jitter };
}

// ==================== 冷却管理 ====================

function checkCooldown(entry) {
  if (!entry.cooling) return false;
  const now = Date.now();
  if (now >= entry.cooldownUntil) {
    // 冷却完成 → 进入观察期（渐进式恢复）
    entry.cooling = false;
    entry.cooldownUntil = 0;
    entry.weight = CONFIG.COOLDOWN_RECOVERY_WEIGHT;
    entry.probation = true;
    entry.probationSuccessCount = 0;
    console.log(`[Scheduler] Token exiting cooldown → entering probation (weight=${entry.weight})`);
    return false;
  }
  return true; // 仍在冷却
}

function enterCooldown(entry, duration = null) {
  // 连续冷却翻倍
  const multiplier = entry.probation ? CONFIG.PROBATION_COOLDOWN_MULTIPLIER : 1;
  const baseDuration = duration || CONFIG.COOLDOWN_DURATION;
  const actualDuration = baseDuration * multiplier * Math.pow(1.5, Math.min(entry.consecutiveCooldowns, 3));
  
  entry.cooling = true;
  entry.cooldownUntil = Date.now() + actualDuration;
  entry.probation = false;
  entry.probationSuccessCount = 0;
  entry.consecutiveCooldowns++;
  
  console.log(`[Scheduler] Token entering cooldown for ${Math.round(actualDuration / 1000)}s (weight=${entry.weight}, consecutive=${entry.consecutiveCooldowns})`);
}

// ==================== 频率限制 ====================

function pruneRequestTimes(entry) {
  const cutoff = Date.now() - CONFIG.RATE_WINDOW;
  entry.requestTimes = entry.requestTimes.filter(t => t > cutoff);
}

function isRateLimited(entry) {
  pruneRequestTimes(entry);
  const effectiveLimit = getEffectiveRateLimit(entry);
  return entry.requestTimes.length >= effectiveLimit;
}

// ==================== 请求间隔检查 ====================

function getRequiredWait(entry) {
  const now = Date.now();
  const elapsed = now - entry.lastRequestTime;
  const { interval, jitter } = getEffectiveInterval();
  const required = interval + Math.random() * jitter;
  if (elapsed >= required) return 0;
  return required - elapsed;
}

// ==================== 核心调度算法 ====================

/**
 * 从候选 token 列表中选择一个 token（加权随机 + 差值控制）
 */
export function selectToken(candidateTokens) {
  if (!candidateTokens || candidateTokens.length === 0) return null;

  // 筛选可用 token
  const available = [];
  for (const token of candidateTokens) {
    const entry = getEntry(token);
    if (checkCooldown(entry)) continue;
    if (isRateLimited(entry)) continue;
    if (entry.weight <= 0) continue;
    available.push({ token, entry });
  }

  if (available.length === 0) return null;

  if (available.length === 1) {
    const { token, entry } = available[0];
    return { token, waitMs: getRequiredWait(entry) };
  }

  // 差值控制
  const minDispatch = Math.min(...available.map(a => a.entry.dispatchCount));
  
  const weightedCandidates = available.map(({ token, entry }) => {
    let effectiveWeight = entry.weight;
    
    // 观察期中的 token 降低权重（优先用健康的）
    if (entry.probation) {
      effectiveWeight *= 0.6;
    }
    
    // 差值控制
    const diff = entry.dispatchCount - minDispatch;
    if (diff >= CONFIG.MAX_DISPATCH_DIFF) {
      effectiveWeight = Math.max(1, effectiveWeight * 0.1);
    } else if (diff >= CONFIG.MAX_DISPATCH_DIFF * 0.7) {
      effectiveWeight *= 0.5;
    }
    
    return { token, entry, effectiveWeight };
  });

  // 加权随机选择
  const totalWeight = weightedCandidates.reduce((sum, c) => sum + c.effectiveWeight, 0);
  let rand = Math.random() * totalWeight;
  
  let chosen = weightedCandidates[0];
  for (const candidate of weightedCandidates) {
    rand -= candidate.effectiveWeight;
    if (rand <= 0) {
      chosen = candidate;
      break;
    }
  }

  return { token: chosen.token, waitMs: getRequiredWait(chosen.entry) };
}

/**
 * 记录一次调度
 */
export function recordDispatch(token) {
  const entry = getEntry(token);
  entry.dispatchCount++;
  entry.lastRequestTime = Date.now();
  entry.requestTimes.push(Date.now());
}

/**
 * 记录请求成功
 */
export function recordSuccess(token) {
  const entry = getEntry(token);
  entry.weight = Math.min(CONFIG.MAX_WEIGHT, entry.weight + CONFIG.SUCCESS_INCREMENT);
  entry.totalSuccess++;
  entry.lastFailureType = null;
  
  // 渐进式恢复：观察期内成功计数
  if (entry.probation) {
    entry.probationSuccessCount++;
    if (entry.probationSuccessCount >= CONFIG.PROBATION_SUCCESS_REQUIRED) {
      // 观察期结束，完全恢复
      entry.probation = false;
      entry.probationSuccessCount = 0;
      entry.consecutiveCooldowns = 0; // 重置连续冷却计数
      console.log(`[Scheduler] Token passed probation! Fully recovered (weight=${entry.weight})`);
    }
  } else {
    // 正常成功也缓慢重置连续冷却计数
    if (entry.consecutiveCooldowns > 0) {
      entry.consecutiveCooldowns = Math.max(0, entry.consecutiveCooldowns - 0.2);
    }
  }
}

/**
 * 记录请求失败（带类型）
 * @param {string} token
 * @param {string} failureType - FAILURE_TYPE 中的值
 */
export function recordFailure(token, failureType = FAILURE_TYPE.GENERIC) {
  const entry = getEntry(token);
  entry.totalFailure++;
  entry.lastFailureType = failureType;
  
  // 报告全局失败
  recordGlobalFailure(token);
  
  // 观察期内失败 → 直接进入加重冷却
  if (entry.probation) {
    console.log(`[Scheduler] Token failed during probation! Re-entering cooldown (type=${failureType})`);
    entry.weight = Math.max(0, entry.weight - CONFIG.FAILURE_DECREMENT);
    enterCooldown(entry);
    return;
  }
  
  // 根据失败类型施加不同惩罚
  switch (failureType) {
    case FAILURE_TYPE.RATE_LIMIT: // 429
      entry.weight = Math.max(0, entry.weight - CONFIG.PENALTY_429);
      enterCooldown(entry, CONFIG.COOLDOWN_429);
      break;
      
    case FAILURE_TYPE.WAF: // 403 / WAF 202
      entry.weight = Math.max(0, entry.weight - CONFIG.PENALTY_WAF);
      enterCooldown(entry, CONFIG.COOLDOWN_WAF);
      break;
      
    case FAILURE_TYPE.TOKEN_INVALID: // 40003
      entry.weight = Math.max(0, entry.weight - CONFIG.PENALTY_TOKEN_INVALID);
      if (entry.weight < CONFIG.COOLDOWN_THRESHOLD && !entry.cooling) {
        enterCooldown(entry);
      }
      break;
      
    case FAILURE_TYPE.ACCOUNT_BANNED: // 40004
      entry.weight = 0;
      entry.cooling = true;
      entry.cooldownUntil = Date.now() + 86400_000; // 24h
      break;
      
    case FAILURE_TYPE.SERVER_ERROR: // 502/503
      entry.weight = Math.max(0, entry.weight - CONFIG.PENALTY_SERVER_ERROR);
      // 服务端错误不触发冷却
      break;
      
    default: // generic
      entry.weight = Math.max(0, entry.weight - CONFIG.FAILURE_DECREMENT);
      if (entry.weight < CONFIG.COOLDOWN_THRESHOLD && !entry.cooling) {
        enterCooldown(entry);
      }
      break;
  }
}

// ==================== 状态查询 ====================

export function getSchedulerStatus() {
  const now = Date.now();
  const entries = [];
  
  for (const [token, entry] of schedulerState) {
    checkCooldown(entry);
    pruneRequestTimes(entry);
    
    let status = 'normal';
    if (entry.cooling) status = 'cooling';
    else if (entry.probation) status = 'probation';
    else if (entry.weight < CONFIG.COOLDOWN_THRESHOLD) status = 'warning';
    
    entries.push({
      token: token.slice(0, 12) + '...',
      weight: entry.weight,
      maxWeight: CONFIG.MAX_WEIGHT,
      status,
      cooling: entry.cooling,
      cooldownRemaining: entry.cooling ? Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)) : 0,
      probation: entry.probation,
      probationProgress: entry.probation ? `${entry.probationSuccessCount}/${CONFIG.PROBATION_SUCCESS_REQUIRED}` : null,
      consecutiveCooldowns: Math.floor(entry.consecutiveCooldowns),
      dispatchCount: entry.dispatchCount,
      recentRequests: entry.requestTimes.length,
      rateLimit: getEffectiveRateLimit(entry),
      totalSuccess: entry.totalSuccess,
      totalFailure: entry.totalFailure,
      lastFailureType: entry.lastFailureType,
      lastRequestAgo: entry.lastRequestTime ? Math.floor((now - entry.lastRequestTime) / 1000) : null,
    });
  }

  return {
    config: { ...CONFIG },
    entries,
    global: {
      slowdownActive: isGlobalSlowdown(),
      slowdownRemaining: globalState.slowdownActive ? Math.max(0, Math.ceil((globalState.slowdownUntil - now) / 1000)) : 0,
      recentFailureCount: globalState.recentFailures.filter(f => f.time > now - CONFIG.GLOBAL_FAIL_WINDOW).length,
      failThreshold: CONFIG.GLOBAL_FAIL_THRESHOLD,
    },
    environment: {
      isNightMode: isNightTime(),
      currentHour: new Date().getHours(),
      nightHours: `${CONFIG.NIGHT_START_HOUR}:00 - ${CONFIG.NIGHT_END_HOUR}:00`,
    },
  };
}

export function getSchedulerConfig() {
  return { ...CONFIG };
}

export function updateSchedulerConfig(updates) {
  const allowedKeys = Object.keys(CONFIG);
  let changed = 0;
  for (const key of allowedKeys) {
    if (key in updates && typeof updates[key] === 'number' && updates[key] >= 0) {
      CONFIG[key] = updates[key];
      changed++;
    }
  }
  if (changed > 0) {
    console.log(`[Scheduler] Config updated (${changed} params)`);
  }
  return { success: true, config: { ...CONFIG }, changed };
}

export function resetTokenWeight(token) {
  // 尝试精确匹配或前缀匹配
  for (const [key, val] of schedulerState) {
    if (key === token || key.startsWith(token)) {
      val.weight = CONFIG.INITIAL_WEIGHT;
      val.cooling = false;
      val.cooldownUntil = 0;
      val.probation = false;
      val.probationSuccessCount = 0;
      val.consecutiveCooldowns = 0;
      val.dispatchCount = 0;
      val.lastFailureType = null;
      return { success: true, message: '权重已重置' };
    }
  }
  return { success: false, message: 'Token 未在调度器中' };
}

export function resetAllSchedulerState() {
  schedulerState.clear();
  globalState.recentFailures = [];
  globalState.slowdownActive = false;
  globalState.slowdownUntil = 0;
  console.log('[Scheduler] All state reset');
  return { success: true, message: '所有调度状态已重置' };
}

export function cleanupToken(token) {
  schedulerState.delete(token);
}
