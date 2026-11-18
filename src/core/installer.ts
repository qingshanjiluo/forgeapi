import fs from 'node:fs';
import path from 'node:path';
import zlibMod from 'node:zlib';
import yaml from 'js-yaml';
import type { DeclarativePlugin, Permission, RegistryEntry, WorkspacePaths } from './types.js';
import { inspectPluginDir, readSkill, Registry } from './registry.js';
import { readJson, writeJson } from './workspace.js';
import { hashPluginDir } from './integrity.js';

export interface InstallOptions {
  /** 来源：本地目录 / .tgz / 内置名 / URL */
  source: string;
  /** 覆盖安装 */
  force?: boolean;
  /** 跳过权限确认 */
  yes?: boolean;
  /** 权限确认回调；返回 false 则中止 */
  confirmPermissions?: (perms: Permission[], name: string) => boolean | Promise<boolean>;
  /** 跳过依赖自动安装 */
  noInstall?: boolean;
  /** 进度回调（依赖安装等） */
  onProgress?: (msg: string) => void;
}

export interface InstallResult {
  name: string;
  version: string;
  dir: string;
  permissions: Permission[];
  dependencies?: string[];
  /** 安装时记录的内容基线哈希 */
  integrity?: string;
}

/** 从内置插件目录安装（项目自带 plugins/builtin） */
export function builtinDir(paths: WorkspacePaths): string[] {
  const candidates = [
    path.join(paths.root, 'builtin-plugins'),
    // 源码运行：src/core -> 项目根/plugins/builtin
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'plugins', 'builtin'),
    // 编译运行：dist/core -> 项目根/plugins/builtin
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', 'plugins', 'builtin'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const dirs = fs.readdirSync(c)
        .map((n) => path.join(c, n))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
      if (dirs.length) return dirs;
    }
  }
  return [];
}

export function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 从 .tgz（npm pack）解包：只处理单层 package/ 结构 */
export function extractTgz(tgz: string, dst: string): void {
  const zlib = zlibMod;
  const buf = zlib.gunzipSync(fs.readFileSync(tgz));
  let off = 0;
  fs.mkdirSync(dst, { recursive: true });
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const readStr = (s: number, l: number) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/, '').trim();
    const name = readStr(0, 100);
    const sizeOctal = readStr(124, 12);
    const type = readStr(156, 1) || '0';
    const prefix = readStr(345, 155);
    const full = prefix ? path.posix.join(prefix, name) : name;
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const rel = full.replace(/^package\//, '');
    if (rel && type === '0') {
      const target = path.join(dst, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

/**
 * 下载远端插件源。
 * 支持：
 *   1. 指向 .tgz 的直链
 *   2. 指向单个 plugin.json / plugin.yaml 的直链
 *   3. 目录列表？不支持——保持确定性：只接受文件直链或 git 仓库 URL
 * 对于 git 仓库（github.com/owner/repo[/tree/ref/path]），走 codeload tarball。
 */
async function fetchRemote(url: string, dst: string): Promise<{ dir: string; kind: string }> {
  // GitHub 仓库 → codeload tarball（默认分支或指定分支）
  const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  let target = url;
  let subPath = '';
  if (gh) {
    const [, owner, repo, ref, path] = gh;
    target = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref || 'HEAD'}`;
    subPath = path || '';
  }

  const res = await fetch(target, { headers: { 'user-agent': 'ForgeAPI/0.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${target}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';
  const isGz = /gzip|tar/.test(ctype) || /\.(tgz|tar\.gz)$/i.test(target) || target.includes('codeload');
  const isZip = /zip/.test(ctype) || /\.zip$/i.test(target);

  if (isGz) {
    const file = path.join(dst, 'pkg.tgz');
    fs.writeFileSync(file, buf);
    const out = path.join(dst, 'src');
    extractTgz(file, out);
    let dir = out;
    // GitHub tarball 顶层是 repo-ref/
    const tops = fs.readdirSync(out).filter((n) => fs.statSync(path.join(out, n)).isDirectory());
    if (tops.length === 1) dir = path.join(out, tops[0]);
    if (subPath) dir = path.join(dir, subPath);
    return { dir, kind: 'archive' };
  }
  if (isZip) {
    throw new Error('zip 暂不支持，请用 .tgz 或 GitHub 仓库地址');
  }

  // 单文件清单
  const name = path.basename(new URL(target).pathname);
  if (!/\.(json|ya?ml)$/i.test(name)) throw new Error(`不支持的文件类型: ${name}（只接受 .tgz / .json / .yaml / GitHub 仓库）`);
  fs.writeFileSync(path.join(dst, name), buf);
  return { dir: dst, kind: 'manifest' };
}

export async function installPlugin(paths: WorkspacePaths, opts: InstallOptions): Promise<InstallResult> {
  const reg = new Registry(paths);
  let srcDir = opts.source;
  let tmpDir: string | null = null;

  // 0) 远端来源：http(s) URL / 模板分享地址 → 下载到临时目录
  if (/^https?:\/\//i.test(srcDir)) {
    tmpDir = fs.mkdtempSync(path.join(paths.root, '.tmp-fetch-'));
    const download = await fetchRemote(srcDir, tmpDir);
    srcDir = download.dir;
  }

  // 1) 内置名解析
  if (!fs.existsSync(srcDir)) {
    const hit = builtinDir(paths).find((d) => path.basename(d) === opts.source || path.basename(d) === `${opts.source}`);
    if (!hit) {
      throw new Error(`找不到插件源: ${opts.source}（既不是本地路径，也不是内置插件名）`);
    }
    srcDir = hit;
  }

  // 2) 目录 / 文件
  if (fs.statSync(srcDir).isFile()) {
    const ext = path.extname(srcDir).toLowerCase();
    if (ext === '.tgz' || ext === '.gz') {
      tmpDir = fs.mkdtempSync(path.join(paths.root, '.tmp-install-'));
      extractTgz(srcDir, tmpDir);
      srcDir = tmpDir;
    } else if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
      // 单个清单 → 生成插件目录
      tmpDir = fs.mkdtempSync(path.join(paths.root, '.tmp-install-'));
      fs.copyFileSync(srcDir, path.join(tmpDir, ext === '.json' ? 'plugin.json' : 'plugin.yaml'));
      srcDir = tmpDir;
    } else {
      throw new Error(`不支持的插件源文件类型: ${ext}`);
    }
  }

  const info = inspectPluginDir(srcDir);
  if (!info) throw new Error(`插件目录缺少 manifest(plugin.json/yaml) 或入口(index.js/mjs): ${srcDir}`);

  // 3) 解析元信息与权限
  let name: string;
  let version: string;
  let description = '';
  let permissions: Permission[] = [];
  if (info.kind === 'declarative') {
    const m = info.manifest!;
    name = m.name;
    version = m.version || '0.0.0';
    description = m.description || '';
    permissions = m.permissions || [];
  } else {
    // 代码型：先 import 取元信息。缺依赖时退化为读 package.json，装完依赖再复验。
    const { pathToFileURL } = await import('node:url');
    const pkgPath = path.join(srcDir, 'package.json');
    const pkg = fs.existsSync(pkgPath) ? safeJson(pkgPath) : null;
    const fallbackName = pkg?.name || path.basename(srcDir);

    let mod: any = null;
    let loadError: { message: string; missing?: string } | null = null;
    try {
      mod = await import(pathToFileURL(info.entry).href + `?t=${Date.now()}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      const missing = /Cannot find (?:module|package) '([^']+)'/.exec(err.message)?.[1];
      if (!missing && err.code !== 'ERR_MODULE_NOT_FOUND') {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`插件入口加载失败: ${err.message.split('\n')[0]}`);
      }
      loadError = { message: err.message.split('\n')[0], missing };
      if (!pkg) {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(
          `插件 ${fallbackName} 缺少运行时依赖：${missing ?? '见原始错误'}，且目录无 package.json 可自动安装。\n` +
          `请在该插件目录放 package.json 声明依赖，或安装后手动补：\n` +
          `  cd "${path.join(paths.plugins, fallbackName)}" && npm install\n` +
          `原始错误: ${loadError.message}`,
        );
      }
      opts.onProgress?.(`插件 ${fallbackName} 依赖缺失（${missing}），将在安装后自动安装`);
    }

    if (mod) {
      const p = (mod.default || mod.plugin || mod) as any;
      name = p.name || fallbackName;
      version = p.version || pkg?.version || '0.0.0';
      description = p.description || '';
      permissions = p.permissions || [];
    } else {
      name = fallbackName;
      version = pkg?.version || '0.0.0';
      description = pkg?.description || '';
      permissions = (pkg as any)?.forgePermissions || [];
    }
  }
  if (!name) throw new Error('插件缺少 name');

  // 4) 已存在检查
  const existing = reg.get(name);
  if (existing && !opts.force) throw new Error(`插件已存在: ${name} v${existing.version}（加 --force 覆盖）`);

  // 5) 权限确认
  if (permissions.length && !opts.yes) {
    if (!opts.confirmPermissions) throw new Error(`插件 ${name} 需要权限: ${permissions.join(', ')}；加 --yes 或提供确认回调`);
    const ok = await opts.confirmPermissions(permissions, name);
    if (!ok) throw new Error('用户拒绝授予权限，安装中止');
  }

  // 6) 拷贝
  const dst = path.join(paths.plugins, name);
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  copyDir(srcDir, dst);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

  // 6.5) 依赖自动安装（代码型插件若声明了 dependencies 且未带 node_modules）
  let depsInstalled: string[] = [];
  if (info.kind === 'code' && !opts.noInstall) {
    depsInstalled = await installDependencies(dst, (msg) => opts.onProgress?.(msg));
  }

  // 7) 注册（安装即记录内容基线，便于 forge verify 校验篡改）
  const { hash, files: hashed } = hashPluginDir(dst);
  const entry: RegistryEntry = {
    name,
    version,
    dir: dst,
    file: path.relative(dst, path.join(dst, path.basename(info.entry))),
    enabled: true,
    permissions,
    description,
    installedAt: new Date().toISOString(),
    source: opts.source,
    integrity: hash,
    integrityFiles: hashed.map((f) => ({ file: f.file, sha256: f.sha256 })),
    integrityAt: new Date().toISOString(),
  };
  reg.register(entry);
  return { name, version, dir: dst, permissions, dependencies: depsInstalled, integrity: hash };
}

/** 找 npm-cli.js：当前 node 同目录 / 常见 Node 安装目录 / PATH 上的 npm 前缀 */
function findNpmCli(): string | null {
  const rel = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = [
    path.join(path.dirname(process.execPath), rel),
    path.join(path.dirname(process.execPath), '..', rel),
  ];
  // 常见安装位置（Windows：Program Files\nodejs；类 Unix：/usr/lib/node_modules）
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', rel));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', rel));
  } else {
    candidates.push('/usr/lib/node_modules/npm/bin/npm-cli.js');
    candidates.push('/usr/local/lib/node_modules/npm/bin/npm-cli.js');
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function safeJson(file: string): any {
  try {
    // Windows 工具（PowerShell Set-Content / 记事本）会带 BOM，JSON.parse 不认
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

/**
 * 若插件目录有 package.json 且声明了依赖、又没有 node_modules，则执行 npm install。
 * 失败不阻断安装（插件仍注册），只返回空数组并在 stderr 提示。
 */
async function installDependencies(
  dir: string,
  onProgress?: (msg: string) => void,
): Promise<string[]> {
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) return [];
  if (fs.existsSync(path.join(dir, 'node_modules'))) return [];

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return []; }
  const deps = Object.keys(pkg.dependencies || {});
  if (!deps.length) return [];

  onProgress?.(`安装插件依赖（${deps.length} 个）：${deps.join(', ')}`);
  try {
    const { spawnSync } = await import('node:child_process');
    const args = ['install', '--no-audit', '--no-fund'];

    // 定位 npm-cli.js（免 shell，规避 DEP0190 与转义问题）；找不到再退回 shell
    const npmCli = findNpmCli();
    const r = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: 'pipe', timeout: 180_000, encoding: 'utf8' })
      : spawnSync('npm', args, { cwd: dir, stdio: 'pipe', timeout: 180_000, encoding: 'utf8', shell: process.platform === 'win32' });

    if (r.status !== 0) {
      const detail = `${r.stderr || ''}${r.stdout || ''}${r.error ? ' ' + r.error.message : ''}`.trim();
      onProgress?.(`依赖安装失败（插件仍已注册）：${detail.slice(0, 240) || `exit ${r.status}`}`);
      return [];
    }
    // 复验：node_modules 里能看到第一个依赖就算成功
    const ok = fs.existsSync(path.join(dir, 'node_modules', deps[0]));
    return ok ? deps : [];
  } catch (e) {
    onProgress?.(`依赖安装异常：${(e as Error).message}`);
    return [];
  }
}

export function removePlugin(paths: WorkspacePaths, name: string): boolean {
  const reg = new Registry(paths);
  const e = reg.get(name);
  if (!e) return false;
  if (fs.existsSync(e.dir)) fs.rmSync(e.dir, { recursive: true, force: true });
  reg.unregister(name);
  return true;
}

export function pluginDetail(paths: WorkspacePaths, name: string) {
  const reg = new Registry(paths);
  const e = reg.get(name);
  if (!e) return null;
  const skill = readSkill(e.dir);
  const info = inspectPluginDir(e.dir);
  return { entry: e, skill, kind: info?.kind ?? 'unknown' };
}

/** 插件配置读写：~/.forgeapi/data/<plugin>/config.json */
export function pluginConfigPath(paths: WorkspacePaths, name: string): string {
  return path.join(paths.data, name, 'config.json');
}

export function readPluginConfig(paths: WorkspacePaths, name: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(pluginConfigPath(paths, name), {});
}

export function writePluginConfig(paths: WorkspacePaths, name: string, cfg: Record<string, unknown>): void {
  writeJson(pluginConfigPath(paths, name), cfg);
}

export function listRules(paths: WorkspacePaths, name: string): Record<string, unknown> {
  const dir = path.join(paths.data, name, 'rules');
  const out: Record<string, unknown> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    try {
      out[f.replace(/\.ya?ml$/i, '')] = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      out[f] = { error: (e as Error).message };
    }
  }
  return out;
}

export function writeRule(paths: WorkspacePaths, name: string, ruleName: string, content: string): string {
  const dir = path.join(paths.data, name, 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${ruleName.replace(/[^\w.-]/g, '_')}.yaml`);
  // 校验 YAML 合法性
  yaml.load(content);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}
