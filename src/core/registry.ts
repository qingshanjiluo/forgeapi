import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { DeclarativePlugin, RegistryEntry, WorkspacePaths } from './types.js';
import { readJson, writeJson } from './workspace.js';

export class Registry {
  private entries: Record<string, RegistryEntry>;

  constructor(private paths: WorkspacePaths) {
    this.entries = readJson<Record<string, RegistryEntry>>(paths.registry, {});
  }

  all(): RegistryEntry[] {
    return Object.values(this.entries).sort((a, b) => a.name.localeCompare(b.name));
  }

  enabled(): RegistryEntry[] {
    return this.all().filter((e) => e.enabled);
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries[name];
  }

  has(name: string): boolean {
    return Boolean(this.entries[name]);
  }

  save(): void {
    writeJson(this.paths.registry, this.entries);
  }

  /** 从磁盘重载（外部进程改了 registry 时保持一致） */
  reload(): void {
    this.entries = readJson<Record<string, RegistryEntry>>(this.paths.registry, {});
  }

  register(entry: RegistryEntry): void {
    this.entries[entry.name] = entry;
    this.save();
  }

  unregister(name: string): boolean {
    if (!this.entries[name]) return false;
    delete this.entries[name];
    this.save();
    return true;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const e = this.entries[name];
    if (!e) return false;
    e.enabled = enabled;
    this.save();
    return true;
  }
}

/* ---------------- 插件目录约定 ----------------
 * ~/.forgeapi/plugins/<name>/
 *   plugin.json | plugin.yaml   —— 声明式插件定义
 *   index.js | index.mjs        —— 代码型插件（export default ForgePlugin）
 *   index.ts                    —— 源码（需先 build）
 *   skill.md                    —— Skill 文档
 *   rules/*.yaml                —— 提取规则
 *   README.md
 */

export interface LoadedPluginFile {
  dir: string;
  entry: string;
  kind: 'code' | 'declarative';
  manifest: DeclarativePlugin | null;
}

const CODE_CANDIDATES = [
  'index.mjs', 'index.js', 'main.mjs', 'main.js',
  'dist/index.js',
  'index.ts', 'main.ts', // Node >=22.6 原生 type-stripping
];
const MANIFEST_CANDIDATES = ['plugin.json', 'plugin.yaml', 'plugin.yml', 'forge.json', 'forge.yaml'];

export function inspectPluginDir(dir: string): LoadedPluginFile | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  for (const m of MANIFEST_CANDIDATES) {
    const f = path.join(dir, m);
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const manifest = (m.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)) as DeclarativePlugin;
      return { dir, entry: f, kind: 'declarative', manifest };
    }
  }
  for (const c of CODE_CANDIDATES) {
    const f = path.join(dir, c);
    if (fs.existsSync(f)) return { dir, entry: f, kind: 'code', manifest: null };
  }
  return null;
}

export function readSkill(dir: string): string | null {
  for (const n of ['skill.md', 'SKILL.md', 'skill.markdown']) {
    const f = path.join(dir, n);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
}

export function readRules(dir: string): Record<string, unknown> {
  const rulesDir = path.join(dir, 'rules');
  const out: Record<string, unknown> = {};
  if (!fs.existsSync(rulesDir)) return out;
  for (const f of fs.readdirSync(rulesDir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    const name = f.replace(/\.ya?ml$/i, '');
    try {
      out[name] = yaml.load(fs.readFileSync(path.join(rulesDir, f), 'utf8'));
    } catch { /* 忽略坏规则 */ }
  }
  return out;
}
