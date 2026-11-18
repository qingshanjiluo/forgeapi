/**
 * 插件完整性校验
 *
 * 安装时对插件目录内容算一个稳定哈希（相对路径 + 文件内容的 sha256 聚合），
 * 写进 registry 条目的 `integrity` 字段；`forge verify` 重算并比对。
 *
 * 目的：发现插件文件被事后篡改（供应链/本地投毒）。
 * 注意：这不是签名（无密钥），只防"静默改动"，用于本地可信基线对比。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspacePaths } from './types.js';
import { Registry } from './registry.js';

/** 跳过的目录/文件：运行期产物、依赖与签名文件本身（签名不能算进被签内容） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist']);
const SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'npm-debug.log', 'FORGE.SIG']);

export interface FileHash {
  file: string;
  sha256: string;
  size: number;
}

/** 列出插件目录下需要纳入基线校验的文件（相对路径，已排序） */
export function listPluginFiles(dir: string): string[] {
  const out: string[] = [];

  const walk = (cur: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(cur, e.name), rel ? `${rel}/${e.name}` : e.name);
        continue;
      }
      if (!e.isFile()) continue;
      if (SKIP_FILES.has(e.name)) continue;
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };

  walk(dir, '');
  return out.sort();
}

export function hashFile(file: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/**
 * 目录哈希：对每个文件取 `sha256(relPath + '\0' + 内容)`，再把这些摘要按路径排序后聚合。
 * 结果稳定（与文件系统顺序无关），改一个字节即变。
 */
export function hashPluginDir(dir: string): { hash: string; files: FileHash[] } {
  const files = listPluginFiles(dir).map((rel) => {
    const full = path.join(dir, rel);
    const content = fs.readFileSync(full);
    const inner = crypto.createHash('sha256').update(rel).update('\0').update(content).digest('hex');
    return { file: rel, sha256: inner, size: content.length };
  });

  const agg = crypto.createHash('sha256');
  for (const f of files) agg.update(f.file).update(':').update(f.sha256).update('\n');
  return { hash: agg.digest('hex'), files };
}

export interface VerifyItem {
  name: string;
  dir: string;
  expected: string | null;
  actual: string;
  ok: boolean;
  reason?: string;
  changedFiles?: string[];
}

/** 校验单个插件：与 registry 里记录的 integrity 比对；有 files 清单时给出变更文件 */
export function verifyPlugin(paths: WorkspacePaths, name: string): VerifyItem | null {
  const reg = new Registry(paths);
  const entry = reg.get(name);
  if (!entry) return null;
  if (!fs.existsSync(entry.dir)) {
    return { name, dir: entry.dir, expected: entry.integrity ?? null, actual: '', ok: false, reason: '插件目录不存在' };
  }
  const { hash, files } = hashPluginDir(entry.dir);
  const expected = entry.integrity ?? null;

  if (!expected) {
    return { name, dir: entry.dir, expected: null, actual: hash, ok: false, reason: '未记录基线（重新安装或 forge verify --fix）' };
  }
  if (expected === hash) return { name, dir: entry.dir, expected, actual: hash, ok: true };

  // 找出变更文件
  const changed: string[] = [];
  const baseline = entry.integrityFiles;
  if (baseline) {
    const now = new Map(files.map((f) => [f.file, f.sha256]));
    for (const b of baseline) {
      const cur = now.get(b.file);
      if (!cur) changed.push(`${b.file}（缺失）`);
      else if (cur !== b.sha256) changed.push(`${b.file}（内容变更）`);
      now.delete(b.file);
    }
    for (const extra of now.keys()) changed.push(`${extra}（新增）`);
  }

  return { name, dir: entry.dir, expected, actual: hash, ok: false, reason: '内容与基线不一致', changedFiles: changed };
}

export function verifyAll(paths: WorkspacePaths): VerifyItem[] {
  return new Registry(paths)
    .all()
    .map((e) => verifyPlugin(paths, e.name))
    .filter((x): x is VerifyItem => Boolean(x));
}

/** 把当前状态写为基线（--fix） */
export function lockBaseline(paths: WorkspacePaths, name: string): { name: string; integrity: string; files: number } | null {
  const reg = new Registry(paths);
  const entry = reg.get(name);
  if (!entry) return null;
  const { hash, files } = hashPluginDir(entry.dir);
  entry.integrity = hash;
  entry.integrityFiles = files.map((f) => ({ file: f.file, sha256: f.sha256 }));
  entry.integrityAt = new Date().toISOString();
  reg.register(entry);
  return { name, integrity: hash, files: files.length };
}