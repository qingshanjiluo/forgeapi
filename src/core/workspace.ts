import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ForgeConfig, WorkspacePaths } from './types.js';

export function defaultConfig(): ForgeConfig {
  return {
    browser: {
      headless: true,
      timeout: 30000,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 900 },
    },
    log: { enabled: true, keepDays: 30 },
    server: { host: '127.0.0.1', port: 7842 },
    security: { requireMasterPassword: false },
    defaultSources: ['web'],
  };
}

const FORGE_HOME = process.env.FORGE_HOME || path.join(os.homedir(), '.forgeapi');

export function resolvePaths(root?: string): WorkspacePaths {
  const base = root || FORGE_HOME;
  return {
    root: base,
    plugins: path.join(base, 'plugins'),
    templates: path.join(base, 'templates'),
    logs: path.join(base, 'logs'),
    data: path.join(base, 'data'),
    credentials: path.join(base, 'credentials.json'),
    config: path.join(base, 'config.json'),
    registry: path.join(base, 'plugins.json'),
  };
}

export function ensureDirs(p: WorkspacePaths): void {
  for (const d of [p.root, p.plugins, p.templates, p.logs, p.data]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadConfig(p: WorkspacePaths): ForgeConfig {
  const base = defaultConfig();
  const saved = readJson<Partial<ForgeConfig>>(p.config, {});
  return {
    browser: { ...base.browser, ...(saved.browser || {}) },
    log: { ...base.log, ...(saved.log || {}) },
    server: { ...base.server, ...(saved.server || {}) },
    security: { ...base.security, ...(saved.security || {}) },
    defaultSources: saved.defaultSources || base.defaultSources,
  };
}

export function saveConfig(p: WorkspacePaths, cfg: ForgeConfig): void {
  writeJson(p.config, cfg);
}

/** 深合并补丁进配置 */
export function patchConfig(p: WorkspacePaths, patch: Record<string, any>): ForgeConfig {
  const cur = loadConfig(p) as any;
  const merge = (dst: any, src: any) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') {
        merge(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  };
  merge(cur, patch);
  saveConfig(p, cur);
  return cur;
}

export const workspace = { FORGE_HOME, resolvePaths, ensureDirs, loadConfig, saveConfig, patchConfig, readJson, writeJson };
