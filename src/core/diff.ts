/**
 * 结果差异计算（用于 forge watch）
 *
 * 对两次抓取结果按某个键对齐，输出 added / removed / changed。
 * 键的选择：显式指定 > url > link > 链接 > id > title > 标题 > 整条 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface DiffInput {
  /** 上一次结果（数组） */
  before: unknown[];
  /** 本次结果（数组） */
  after: unknown[];
  /** 对齐键字段名 */
  key?: string;
  /** 参与比较的字段（缺省全部） */
  fields?: string[];
}

export interface DiffOutput {
  key: string;
  added: unknown[];
  removed: unknown[];
  changed: { key: string; before: unknown; after: unknown; fields: string[] }[];
  unchanged: number;
  counts: { before: number; after: number };
}

const KEY_CANDIDATES = ['url', 'link', '链接', 'id', 'guid', 'title', '标题', 'name'];

export function pickKey(item: unknown, explicit?: string): string | null {
  if (item === null || item === undefined) return null;
  if (typeof item !== 'object') return String(item);

  const obj = item as Record<string, unknown>;
  const asKey = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    return null;
  };

  if (explicit) return asKey(obj[explicit]);

  for (const k of KEY_CANDIDATES) {
    const key = asKey(obj[k]);
    if (key) return key;
  }
  // 兜底：结构哈希
  return stableStringify(obj);
}

function stableStringify(v: unknown): string {
  const seen = new WeakSet();
  const walk = (x: unknown): unknown => {
    if (x && typeof x === 'object') {
      if (seen.has(x as object)) return '[circular]';
      seen.add(x as object);
      if (Array.isArray(x)) return x.map(walk);
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) o[k] = walk((x as any)[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

function fieldsOf(item: unknown): string[] {
  return item && typeof item === 'object' ? Object.keys(item as object) : ['value'];
}

export function diffResults(input: DiffInput): DiffOutput {
  const keyName = input.key || 'auto';
  const beforeMap = new Map<string, unknown>();
  for (const it of input.before) {
    const k = pickKey(it, input.key);
    if (k) beforeMap.set(k, it);
  }

  const afterMap = new Map<string, unknown>();
  for (const it of input.after) {
    const k = pickKey(it, input.key);
    if (k) afterMap.set(k, it);
  }

  const added: unknown[] = [];
  const removed: unknown[] = [];
  const changed: DiffOutput['changed'] = [];
  let unchanged = 0;

  for (const [k, afterItem] of afterMap) {
    const beforeItem = beforeMap.get(k);
    if (beforeItem === undefined) { added.push(afterItem); continue; }

    const fieldsToCheck = input.fields?.length ? input.fields : fieldsOf(afterItem);
    const diffFields: string[] = [];
    for (const f of fieldsToCheck) {
      const b = (beforeItem as any)?.[f];
      const a = (afterItem as any)?.[f];
      if (stableStringify(b) !== stableStringify(a)) diffFields.push(f);
    }
    if (diffFields.length) changed.push({ key: k, before: beforeItem, after: afterItem, fields: diffFields });
    else unchanged++;
  }

  for (const k of beforeMap.keys()) {
    if (!afterMap.has(k)) removed.push(beforeMap.get(k));
  }

  return {
    key: keyName,
    added,
    removed,
    changed,
    unchanged,
    counts: { before: input.before.length, after: input.after.length },
  };
}

/* ---------------- watch 快照存取 ---------------- */

export function snapshotFile(dir: string, name: string): string {
  return path.join(dir, 'snapshots', `${name.replace(/[^\w.-]/g, '_')}.json`);
}

export function readSnapshot(dir: string, name: string): unknown[] | null {
  const f = snapshotFile(dir, name);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null;
  } catch { return null; }
}

export function writeSnapshot(dir: string, name: string, items: unknown[]): string {
  const f = snapshotFile(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), items }, null, 2), 'utf8');
  return f;
}

/** 从插件返回值中提取主结果数组（与 CLI --stream 同规则） */
export function extractItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of ['results', 'items', 'topics', 'boards', 'posts', 'entries']) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[];
    }
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as unknown[];
  }
  return [];
}