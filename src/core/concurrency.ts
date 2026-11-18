/**
 * 并发map与缓存工具
 * - mapLimit：限并发的批量执行（浏览器抓取不能无限并发）
 * - LruCache：插件级结果缓存（TTL + 容量）
 */
import fs from 'node:fs';
import path from 'node:path';

/** 限并发映射：保持输入顺序 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  const out = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** 简单 LRU + TTL 缓存，落盘可选（进程内为主） */
export class ResultCache {
  private map = new Map<string, { v: unknown; exp: number }>();
  private file: string | null;

  constructor(private opts: { ttlMs?: number; max?: number; file?: string } = {}) {
    this.file = opts.file ?? null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, { v: unknown; exp: number }>;
        const now = Date.now();
        for (const [k, e] of Object.entries(raw)) if (e.exp > now) this.map.set(k, e);
      } catch { /* 忽略坏缓存 */ }
    }
  }

  get(key: string): unknown | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) { this.map.delete(key); return undefined; }
    // LRU 触碰
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const ttl = ttlMs ?? this.opts.ttlMs ?? 60_000;
    const max = this.opts.max ?? 200;
    this.map.set(key, { v: value, exp: Date.now() + ttl });
    while (this.map.size > max) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
    if (this.file) this.flush();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.map.clear();
    if (this.file) this.flush();
  }

  get size(): number {
    this.prune();
    return this.map.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.exp <= now) this.map.delete(k);
  }

  private flush(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const obj: Record<string, { v: unknown; exp: number }> = {};
      for (const [k, e] of this.map) obj[k] = e;
      fs.writeFileSync(this.file, JSON.stringify(obj), 'utf8');
    } catch { /* 忽略写失败 */ }
  }
}

/** 稳定 key（对象按键排序） */
export function cacheKey(parts: unknown): string {
  return JSON.stringify(parts, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((o, k) => { (o as any)[k] = (v as any)[k]; return o; }, {});
    }
    return v;
  });
}