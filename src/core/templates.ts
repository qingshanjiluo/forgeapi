import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import type { RegistryEntry, WorkspacePaths } from './types.js';
import { Registry, inspectPluginDir } from './registry.js';
import { readJson, writeJson } from './workspace.js';
import { installPlugin, copyDir } from './installer.js';

/**
 * 模板库结构（~/.forgeapi/templates/）：
 *   index.json         —— 本地模板索引 [{ name, version, description, tags, path }]
 *   registry.json      —— 远端索引缓存 [{ name, version, description, tags, url }]
 *   <name>/            —— 模板目录（等价于一个插件目录）
 */

export interface RemoteTemplateMeta {
  name: string;
  version: string;
  description: string;
  tags?: string[];
  /** 可直接安装的来源：.tgz / .json / GitHub 仓库 / 原始目录 URL */
  url: string;
}

const DEFAULT_REMOTE_REGISTRIES = [
  // 官方内置源（随包提供，可离线）
  'file://builtin',
];

export function registryCacheFile(paths: WorkspacePaths): string {
  return path.join(paths.templates, 'registry.json');
}

/** 远端仓库地址列表：环境变量 > 配置文件 > 内置 */
export function remoteRegistries(paths: WorkspacePaths): string[] {
  const env = process.env.FORGE_REGISTRY;
  if (env) return env.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const cfg = readJson<{ registries?: string[] }>(path.join(paths.templates, 'sources.json'), {});
  if (cfg.registries?.length) return cfg.registries;
  return DEFAULT_REMOTE_REGISTRIES;
}

/** 随包 templates 目录（与 bootstrap.builtinTemplateRoot 同源：从模块位置向上两级） */
export function builtinTemplatesRoot(): string {
  try {
    // 必须用 fileURLToPath：中文/空格路径在 URL.pathname 里是百分号编码的
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', '..', 'templates');
  } catch {
    return path.join(process.cwd(), 'templates');
  }
}

/**
 * 拉取远端索引。
 * 支持：
 *   - http(s)://…/index.json  → 直接解析
 *   - file://builtin          → 从随包 templates/registry.json 读
 *   - 目录路径 / file://路径  → 读该目录下 registry.json
 */
export async function fetchRemoteIndex(paths: WorkspacePaths, opts: { refresh?: boolean } = {}): Promise<RemoteTemplateMeta[]> {
  const cache = registryCacheFile(paths);
  if (!opts.refresh && fs.existsSync(cache)) {
    const cached = readJson<{ at: number; items: RemoteTemplateMeta[] }>(cache, { at: 0, items: [] });
    if (cached.items.length && Date.now() - cached.at < 6 * 3600_000) return cached.items;
  }

  const items: RemoteTemplateMeta[] = [];
  for (const src of remoteRegistries(paths)) {
    try {
      if (src === 'file://builtin') {
        // 优先级：随包 templates/registry.json → 本地模板库（export 出去的）
        const candidates = [
          path.join(builtinTemplatesRoot(), 'registry.json'),
          path.join(paths.templates, 'registry.json'),
        ];
        for (const f of candidates) {
          if (!fs.existsSync(f)) continue;
          try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as RemoteTemplateMeta[];
            if (Array.isArray(j)) items.push(...j);
            break;
          } catch { /* 尝试下一个 */ }
        }
        continue;
      }
      if (src.startsWith('file://')) {
        const f = src.slice('file://'.length);
        if (fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
          if (Array.isArray(j)) items.push(...j);
        }
        continue;
      }
      const res = await fetch(src, { headers: { 'user-agent': 'ForgeAPI/0.3' } });
      if (!res.ok) continue;
      const j = await res.json();
      if (Array.isArray(j)) items.push(...j);
      else if (Array.isArray((j as any).templates)) items.push(...(j as any).templates);
    } catch { /* 单个 registry 失败不影响其它 */ }
  }

  // 去重（同名保留后出现的，视为覆盖更新）
  const byName = new Map<string, RemoteTemplateMeta>();
  for (const t of items) if (t?.name) byName.set(t.name, t);

  const out = [...byName.values()];
  writeJson(cache, { at: Date.now(), items: out });
  return out;
}

export async function searchRemote(paths: WorkspacePaths, kw: string, opts: { refresh?: boolean } = {}): Promise<RemoteTemplateMeta[]> {
  const all = await fetchRemoteIndex(paths, opts);
  const k = kw.toLowerCase();
  if (!k) return all;
  return all.filter((t) =>
    t.name.toLowerCase().includes(k) ||
    t.description.toLowerCase().includes(k) ||
    (t.tags || []).some((g) => g.toLowerCase().includes(k)));
}

/**
 * 从远端 URL 安装模板。支持的来源形式：
 *   - `builtin:<name>`         随包模板（离线可用，等价于 template install）
 *   - `file:///abs/path`       本地目录或 tgz
 *   - 相对路径                 相对本地模板库解析
 *   - http(s)://….tgz          远程压缩包
 *   - https://github.com/o/r   仓库（codeload tarball）
 */
export async function installRemoteTemplate(paths: WorkspacePaths, url: string, opts: { force?: boolean } = {}) {
  // 1) builtin:name → 本地随包模板
  if (url.startsWith('builtin:')) {
    const name = url.slice('builtin:'.length);
    return installTemplate(paths, name, opts.force ?? true);
  }

  // 2) file:// → 直接走 installPlugin 的本地路径分支
  if (url.startsWith('file://')) {
    return installPlugin(paths, { source: url.slice('file://'.length), force: opts.force ?? true, yes: true });
  }

  // 3) 相对路径 → 相对模板库解析
  if (!/^https?:\/\//i.test(url) && !path.isAbsolute(url)) {
    const local = path.join(paths.templates, url);
    if (fs.existsSync(local)) {
      return installPlugin(paths, { source: local, force: opts.force ?? true, yes: true });
    }
    // 退回按模板名处理
    if (!url.includes('/') && !/\.[a-z0-9]+$/i.test(url)) {
      return installTemplate(paths, url, opts.force ?? true);
    }
  }

  // 4) 远程
  return installPlugin(paths, { source: url, force: opts.force ?? true, yes: true });
}

export interface TemplateMeta {
  name: string;
  version: string;
  description: string;
  tags: string[];
  path: string;
  installed?: boolean;
}

export function templateIndexFile(paths: WorkspacePaths): string {
  return path.join(paths.templates, 'index.json');
}

export function listTemplates(paths: WorkspacePaths): TemplateMeta[] {
  const idx = readJson<TemplateMeta[]>(templateIndexFile(paths), []);
  const reg = new Registry(paths);
  const existing = new Set(reg.all().map((e) => e.name));
  const fromDisk: TemplateMeta[] = [];
  if (fs.existsSync(paths.templates)) {
    for (const n of fs.readdirSync(paths.templates)) {
      const d = path.join(paths.templates, n);
      if (!fs.statSync(d).isDirectory()) continue;
      if (idx.some((t) => t.name === n)) continue;
      const info = inspectPluginDir(d);
      if (!info) continue;
      fromDisk.push({
        name: n, version: info.manifest?.version || '0.0.0',
        description: info.manifest?.description || '', tags: [], path: d,
        installed: existing.has(n),
      });
    }
  }
  return [...idx.map((t) => ({ ...t, installed: existing.has(t.name) })), ...fromDisk];
}

export function searchTemplates(paths: WorkspacePaths, kw: string): TemplateMeta[] {
  const k = kw.toLowerCase();
  return listTemplates(paths).filter((t) =>
    t.name.toLowerCase().includes(k) ||
    t.description.toLowerCase().includes(k) ||
    t.tags.some((g) => g.toLowerCase().includes(k)));
}

export async function installTemplate(paths: WorkspacePaths, name: string, force = true, yes = true) {
  const t = listTemplates(paths).find((x) => x.name === name);
  if (!t) throw new Error(`模板不存在: ${name}（forge template search <kw> 查找）`);
  return installPlugin(paths, { source: t.path, force, yes });
}

/** 把已安装插件导出为模板（可分享） */
export function exportTemplate(paths: WorkspacePaths, plugin: string): string {
  const reg = new Registry(paths);
  const e = reg.get(plugin);
  if (!e) throw new Error(`插件未安装: ${plugin}`);
  const dst = path.join(paths.templates, plugin);
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  copyDir(e.dir, dst);
  // 去掉运行期数据
  for (const junk of ['node_modules', '.cache']) {
    const j = path.join(dst, junk);
    if (fs.existsSync(j)) fs.rmSync(j, { recursive: true, force: true });
  }
  const idx = readJson<TemplateMeta[]>(templateIndexFile(paths), []);
  const meta: TemplateMeta = {
    name: e.name, version: e.version, description: e.description,
    tags: [], path: dst,
  };
  const i = idx.findIndex((t) => t.name === e.name);
  if (i >= 0) idx[i] = meta; else idx.push(meta);
  writeJson(templateIndexFile(paths), idx);
  return dst;
}

/** 内置模板播种：把项目 templates/ 下的模板拷进工作区模板库（支持声明式与代码型） */
export async function seedTemplates(paths: WorkspacePaths, builtinRoot: string): Promise<number> {
  if (!fs.existsSync(builtinRoot)) return 0;
  let n = 0;
  const idx = readJson<TemplateMeta[]>(templateIndexFile(paths), []);
  for (const name of fs.readdirSync(builtinRoot)) {
    const src = path.join(builtinRoot, name);
    let isDir = false;
    try { isDir = fs.statSync(src).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;

    const info = inspectPluginDir(src);
    if (!info) continue;

    const dst = path.join(paths.templates, name);
    if (!fs.existsSync(dst)) {
      copyDir(src, dst);
      n++;
    }

    if (idx.some((t) => t.name === name)) continue;

    // 元信息：声明式取 manifest，代码型从入口 import
    let version = '0.0.0';
    let description = '';
    if (info.manifest) {
      version = info.manifest.version || version;
      description = info.manifest.description || '';
    } else {
      try {
        const { pathToFileURL } = await import('node:url');
        const mod = await import(pathToFileURL(info.entry).href + `?t=${Date.now()}`);
        const p = (mod.default || mod.plugin || mod) as any;
        version = p?.version || version;
        description = p?.description || '';
      } catch { /* 取不到就留空 */ }
    }

    idx.push({
      name,
      version,
      description,
      tags: [],
      path: dst,
    });
  }
  writeJson(templateIndexFile(paths), idx);
  return n;
}
