/**
 * JSON 持久化模块
 * 
 * 所有配置（除端口和面板密码外）统一存储到 /app/data/config.json
 * Docker 通过映射 ./data:/app/data 实现持久化
 * 
 * 存储结构:
 * {
 *   tokens: ["token1", "token2", ...],
 *   accounts: [{ email, password }, ...],
 *   apiKeys: ["key1", "key2", ...],
 *   proxy: { manualProxy, xiequApiUrl },
 *   scheduler: { ...CONFIG overrides },
 *   fingerprint: { ROTATE_AFTER_REQUESTS, ROTATE_AFTER_MS },
 *   autoDeleteMode: "none" | "single" | "all",
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

// 数据目录：优先使用环境变量 DATA_DIR，默认 /app/data
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const CONFIG_FILE = resolve(DATA_DIR, 'config.json');

// 确保数据目录存在
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// 内存缓存
let configCache = null;

/**
 * 读取完整配置
 * @returns {object} 配置对象
 */
export function loadConfig() {
  if (configCache) return configCache;

  ensureDataDir();

  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      configCache = JSON.parse(raw);
      console.log(`[Persist] Loaded config from ${CONFIG_FILE}`);
      return configCache;
    }
  } catch (err) {
    console.warn(`[Persist] Failed to read config.json: ${err.message}`);
  }

  // 返回空配置
  configCache = {};
  return configCache;
}

/**
 * 保存完整配置到 JSON 文件
 * @param {object} config - 完整配置对象
 * @returns {boolean} 是否保存成功
 */
export function saveConfig(config) {
  ensureDataDir();

  try {
    const json = JSON.stringify(config, null, 2);
    writeFileSync(CONFIG_FILE, json, 'utf-8');
    configCache = config;
    return true;
  } catch (err) {
    console.warn(`[Persist] Failed to save config.json: ${err.message}`);
    return false;
  }
}

/**
 * 获取配置中的某个 key
 * @param {string} key - 配置键名
 * @param {*} defaultValue - 默认值
 * @returns {*} 配置值
 */
export function getConfigValue(key, defaultValue = undefined) {
  const config = loadConfig();
  return config[key] !== undefined ? config[key] : defaultValue;
}

/**
 * 更新配置中的某个 key 并保存
 * @param {string} key - 配置键名
 * @param {*} value - 配置值
 * @returns {boolean} 是否保存成功
 */
export function setConfigValue(key, value) {
  const config = loadConfig();
  config[key] = value;
  return saveConfig(config);
}

/**
 * 批量更新配置并保存（一次写入，避免多次 IO）
 * @param {object} updates - { key: value, ... }
 * @returns {boolean} 是否保存成功
 */
export function updateConfig(updates) {
  const config = loadConfig();
  for (const [key, value] of Object.entries(updates)) {
    config[key] = value;
  }
  return saveConfig(config);
}

/**
 * 获取数据目录路径
 */
export function getDataDir() {
  return DATA_DIR;
}

/**
 * 获取配置文件路径
 */
export function getConfigPath() {
  return CONFIG_FILE;
}
