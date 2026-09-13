// 配置读写：数据目录 data/config.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 允许通过 PI_DATA_DIR / PI_PHOTO_DIR 覆盖数据目录（隔离测试 / 迁移数据）
export const DATA_DIR = process.env.PI_DATA_DIR
  ? path.resolve(process.env.PI_DATA_DIR)
  : path.join(ROOT, 'data');
export const PHOTO_DIR = process.env.PI_PHOTO_DIR
  ? path.resolve(process.env.PI_PHOTO_DIR)
  : path.join(ROOT, 'photos');
export const DB_PATH = path.join(DATA_DIR, 'inventory.db');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  server: { host: '127.0.0.1', port: 7860 },
  ai: {
    // provider: 'mock' 内置本地演示AI（不联网，不耗token）
    //          其他为 OpenAI 兼容接口
    provider: 'mock',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v1',
    apiKey: process.env.PI_AI_API_KEY || '', // 也可用环境变量注入，避免写进文件/源码
    model: 'glm-4.6',
    visionModel: 'glm-4v-plus',
    temperature: 0.2
  },
  lcsc: { enabled: true }
};

export const AI_PRESETS = {
  zhichu: {
    label: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v1',
    model: 'glm-4.6',
    visionModel: 'glm-4v-plus'
  },
  bailian: {
    label: '阿里云百炼 (通义千问)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen-vl-plus'
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini'
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    visionModel: ''
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    visionModel: ''
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    model: '',
    visionModel: ''
  }
};

let cached = null;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function ensureDirs() {
  ensureDir(DATA_DIR);
  ensureDir(PHOTO_DIR);
}

export function loadConfig() {
  ensureDirs();
  if (cached) return cached;
  let cfg = structuredClone(DEFAULT_CONFIG);
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...cfg, ...raw, server: { ...cfg.server, ...(raw.server || {}) }, ai: { ...cfg.ai, ...(raw.ai || {}) }, lcsc: { ...cfg.lcsc, ...(raw.lcsc || {}) } };
    }
  } catch (e) {
    console.warn('[config] 读取失败，使用默认配置:', e.message);
  }
  cached = cfg;
  return cfg;
}

export function saveConfig(patch) {
  const cfg = loadConfig();
  if (patch.server) cfg.server = { ...cfg.server, ...patch.server };
  if (patch.ai) cfg.ai = { ...cfg.ai, ...patch.ai };
  if (patch.lcsc) cfg.lcsc = { ...cfg.lcsc, ...patch.lcsc };
  // apiKey 允许保留原值：前端传 masked 时不覆盖
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  cached = cfg;
  return cfg;
}

/** 返回给前端的脱敏配置 */
export function publicConfig() {
  const cfg = loadConfig();
  return {
    server: cfg.server,
    ai: {
      provider: cfg.ai.provider,
      baseUrl: cfg.ai.baseUrl,
      model: cfg.ai.model,
      visionModel: cfg.ai.visionModel,
      temperature: cfg.ai.temperature,
      apiKeySet: !!(cfg.ai.apiKey && cfg.ai.apiKey !== '******')
    },
    lcsc: cfg.lcsc
  };
}

export function getAiConfig() {
  return loadConfig().ai;
}
