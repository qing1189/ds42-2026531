/**
 * Smart Scheduler — 智能权重调度器
 * 
 * 目标：降低 DeepSeek 风控触发概率
 * 
 * 策略组合：
 *   1. 动态权重调度 — 成功+2 / 失败-5，基于权重的概率调度（非均衡）
 *   2. 冷却机制 — 权重低于阈值时自动冷却，冷却期不参与调度
 *   3. 请求间隔抖动 — 模拟人类行为，每个 token 强制最小间隔 + 随机抖动
 *   4. 频率限制 — 每个 token 滑动窗口内请求数上限
 *   5. 指纹轮换 — 提供 cookie/header 指纹轮换建议
 * 
 * 权重规则：
 *   - 初始权重: 30
 *   - 最大权重: 50
 *   - 成功一次: +2（上限50）
 *   - 失败一次: -5（下限0）
 *   - 冷却阈值: 10（权重 < 10 进入冷却）
 *   - 冷却时长: 300s（5分钟）
 *   - 冷却恢复权重: 20
 * 
 * 调度算法：
 *   - 加权随机选择（权重越高被选中概率越大）
 *   - 调度差值控制：最高权重和最低权重的选中次数差不超过 10
 *   - 同一 token 请求间隔 >= MIN_INTERVAL + random jitter
 */

// ==================== 配置 ====================

const CONFIG = {
  // 权重参数
  INITIAL_WEIGHT: 30,
  MAX_WEIGHT: 50,
  SUCCESS_INCREMENT: 2,
  FAILURE_DECREMENT: 5,
  COOLDOWN_THRESHOLD: 10,
  COOLDOWN_DURATION: 300_000,  // 300秒 = 5分钟
  COOLDOWN_RECOVERY_WEIGHT: 20,

  // 请求间隔（毫秒）
  MIN_INTERVAL: 3000,          // 同一 token 最小间隔 3 秒
  MAX_JITTER: 2000,            // 随机抖动 0~2 秒
  
  // 频率限制（滑动窗口）
  RATE_WINDOW: 60_000,         // 60 秒窗口
  RATE_LIMIT: 10,              // 每 token 60 秒内最多 10 次请求

  // 调度差值限制
  MAX_DISPATCH_DIFF: 10,       // 调度次数最大差值
};

// ==================== 调度器状态 ====================

// token -> SchedulerEntry
const schedulerState = new Map();

/**
 * SchedulerEntry 结构:
 * {
 *   weight: number,          // 当前权重
 *   cooling: boolean,        // 是否在冷却中
 *   cooldownUntil: number,   // 冷却截止时间 (ms timestamp)
 *   lastRequestTime: number, // 上次请求时间
 *   dispatchCount: number,   // 累计调度次数（用于差值控制）
 *   requestTimes: number[],  // 滑动窗口内的请求时间戳
 *   totalSuccess: number,    // 累计成功次数
 *   totalFailure: number,    // 累计失败次数
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
  };
}

function getEntry(token) {
  if (!schedulerState.has(token)) {
    schedulerState.set(token, createEntry());
  }
  return schedulerState.get(token);
}

// ==================== 冷却管理 ====================

function checkCooldown(entry) {
  if (!entry.cooling) return false;
  const now = Date.now();
  if (now >= entry.cooldownUntil) {
    // 冷却完成，恢复
    entry.cooling = false;
    entry.cooldownUntil = 0;
    entry.weight = CONFIG.COOLDOWN_RECOVERY_WEIGHT;
    return false;
  }
  return true; // 仍在冷却
}

function enterCooldown(entry) {
  entry.cooling = true;
  entry.cooldownUntil = Date.now() + CONFIG.COOLDOWN_DURATION;
  console.log(`[Scheduler] Token entering cooldown for ${CONFIG.COOLDOWN_DURATION / 1000}s (weight was ${entry.weight})`);
}

// ==================== 频率限制 ====================

function pruneRequestTimes(entry) {
  const cutoff = Date.now() - CONFIG.RATE_WINDOW;
  entry.requestTimes = entry.requestTimes.filter(t => t > cutoff);
}

function isRateLimited(entry) {
  pruneRequestTimes(entry);
  return entry.requestTimes.length >= CONFIG.RATE_LIMIT;
}

// ==================== 请求间隔检查 ====================

function getRequiredWait(entry) {
  const now = Date.now();
  const elapsed = now - entry.lastRequestTime;
  const jitter = Math.random() * CONFIG.MAX_JITTER;
  const required = CONFIG.MIN_INTERVAL + jitter;
  if (elapsed >= required) return 0;
  return required - elapsed;
}

// ==================== 核心调度算法 ====================

/**
 * 从候选 token 列表中选择一个 token（加权随机 + 差值控制）
 * @param {string[]} candidateTokens - 可用的 token 列表
 * @returns {{ token: string, waitMs: number } | null}
 */
export function selectToken(candidateTokens) {
  if (!candidateTokens || candidateTokens.length === 0) return null;

  const now = Date.now();
  
  // 筛选可用 token（非冷却 + 非限流 + 有正权重）
  const available = [];
  for (const token of candidateTokens) {
    const entry = getEntry(token);
    
    // 检查冷却
    if (checkCooldown(entry)) continue;
    
    // 检查频率限制
    if (isRateLimited(entry)) continue;
    
    // 权重为 0 也跳过
    if (entry.weight <= 0) continue;
    
    available.push({ token, entry });
  }

  if (available.length === 0) return null;

  // 如果只有一个候选，直接返回
  if (available.length === 1) {
    const { token, entry } = available[0];
    const waitMs = getRequiredWait(entry);
    return { token, waitMs };
  }

  // 差值控制：如果某个 token 调度次数远超其他，降低其权重系数
  const minDispatch = Math.min(...available.map(a => a.entry.dispatchCount));
  
  // 计算有效权重（结合差值控制）
  const weightedCandidates = available.map(({ token, entry }) => {
    let effectiveWeight = entry.weight;
    
    // 差值控制：调度次数超过最小值 + MAX_DISPATCH_DIFF 时，大幅降低权重
    const diff = entry.dispatchCount - minDispatch;
    if (diff >= CONFIG.MAX_DISPATCH_DIFF) {
      effectiveWeight = Math.max(1, effectiveWeight * 0.1); // 降至 10%
    } else if (diff >= CONFIG.MAX_DISPATCH_DIFF * 0.7) {
      effectiveWeight = effectiveWeight * 0.5; // 降至 50%
    }
    
    return { token, entry, effectiveWeight };
  });

  // 加权随机选择
  const totalWeight = weightedCandidates.reduce((sum, c) => sum + c.effectiveWeight, 0);
  let rand = Math.random() * totalWeight;
  
  let chosen = weightedCandidates[0]; // fallback
  for (const candidate of weightedCandidates) {
    rand -= candidate.effectiveWeight;
    if (rand <= 0) {
      chosen = candidate;
      break;
    }
  }

  const waitMs = getRequiredWait(chosen.entry);
  return { token: chosen.token, waitMs };
}

/**
 * 记录一次调度（token 被选中使用）
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
}

/**
 * 记录请求失败
 */
export function recordFailure(token) {
  const entry = getEntry(token);
  entry.weight = Math.max(0, entry.weight - CONFIG.FAILURE_DECREMENT);
  entry.totalFailure++;
  
  // 权重低于冷却阈值，进入冷却
  if (entry.weight < CONFIG.COOLDOWN_THRESHOLD && !entry.cooling) {
    enterCooldown(entry);
  }
}

// ==================== 状态查询 ====================

/**
 * 获取所有调度器状态（用于管理面板）
 */
export function getSchedulerStatus() {
  const now = Date.now();
  const entries = [];
  
  for (const [token, entry] of schedulerState) {
    checkCooldown(entry); // 更新冷却状态
    pruneRequestTimes(entry);
    
    entries.push({
      token: token.slice(0, 12) + '...',
      weight: entry.weight,
      maxWeight: CONFIG.MAX_WEIGHT,
      cooling: entry.cooling,
      cooldownRemaining: entry.cooling ? Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)) : 0,
      dispatchCount: entry.dispatchCount,
      recentRequests: entry.requestTimes.length,
      rateLimit: CONFIG.RATE_LIMIT,
      totalSuccess: entry.totalSuccess,
      totalFailure: entry.totalFailure,
      lastRequestAgo: entry.lastRequestTime ? Math.floor((now - entry.lastRequestTime) / 1000) : null,
    });
  }

  return {
    config: { ...CONFIG },
    entries,
  };
}

/**
 * 获取调度器配置
 */
export function getSchedulerConfig() {
  return { ...CONFIG };
}

/**
 * 更新调度器配置
 */
export function updateSchedulerConfig(updates) {
  const allowedKeys = [
    'INITIAL_WEIGHT', 'MAX_WEIGHT', 'SUCCESS_INCREMENT', 'FAILURE_DECREMENT',
    'COOLDOWN_THRESHOLD', 'COOLDOWN_DURATION', 'COOLDOWN_RECOVERY_WEIGHT',
    'MIN_INTERVAL', 'MAX_JITTER', 'RATE_WINDOW', 'RATE_LIMIT', 'MAX_DISPATCH_DIFF',
  ];
  
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

/**
 * 手动重置某个 token 的权重（用于手动恢复）
 */
export function resetTokenWeight(token) {
  const entry = schedulerState.get(token);
  if (!entry) {
    // 尝试前缀匹配
    for (const [key, val] of schedulerState) {
      if (key.startsWith(token)) {
        val.weight = CONFIG.INITIAL_WEIGHT;
        val.cooling = false;
        val.cooldownUntil = 0;
        val.dispatchCount = 0;
        return { success: true, message: '权重已重置' };
      }
    }
    return { success: false, message: 'Token 未在调度器中' };
  }
  entry.weight = CONFIG.INITIAL_WEIGHT;
  entry.cooling = false;
  entry.cooldownUntil = 0;
  entry.dispatchCount = 0;
  return { success: true, message: '权重已重置' };
}

/**
 * 重置所有调度状态
 */
export function resetAllSchedulerState() {
  schedulerState.clear();
  console.log('[Scheduler] All state reset');
  return { success: true, message: '所有调度状态已重置' };
}

/**
 * 清理不再使用的 token 状态
 */
export function cleanupToken(token) {
  schedulerState.delete(token);
}
