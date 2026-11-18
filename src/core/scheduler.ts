/**
 * 批量任务调度器
 *
 * 任务文件两种格式：
 *   1) JSON 数组   [{ plugin, params, command? }, ...]
 *   2) JSONL       每行一个任务对象
 *
 * 能力：限并发、失败重试（指数退避）、可选限速（每秒最多 N 个）、
 *       结果落盘（JSONL 追加）、逐条进度回调。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface BatchTask {
  plugin: string;
  command?: string;
  params?: Record<string, unknown>;
  /** 任务标签，便于在结果里对齐 */
  id?: string;
}

export interface BatchOptions {
  concurrency?: number;
  /** 每个任务最多尝试次数（含首次） */
  retry?: number;
  /** 两次尝试之间的基础退避毫秒（指数增长） */
  retryDelayMs?: number;
  /** 每秒最多启动多少个任务（0 = 不限） */
  ratePerSec?: number;
  /** 单个任务超时毫秒 */
  timeoutMs?: number;
  /** 结果落盘路径（JSONL 追加） */
  outFile?: string;
  onProgress?: (ev: { index: number; total: number; task: BatchTask; state: 'start' | 'ok' | 'fail' | 'retry' }) => void;
}

export interface BatchResult {
  index: number;
  task: BatchTask;
  ok: boolean;
  data?: unknown;
  error?: string;
  ms: number;
  attempts: number;
}

/** 读任务文件：自动识别 JSON 数组 / JSONL */
export function readTasks(file: string): BatchTask[] {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // JSON 数组
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error('任务文件应是 JSON 数组或 JSONL');
    return arr.map(normalizeTask);
  }

  // 单个对象
  if (trimmed.startsWith('{')) {
    try {
      const one = JSON.parse(trimmed);
      if (one && typeof one === 'object' && !Array.isArray(one) && one.plugin) return [normalizeTask(one)];
    } catch { /* 落到 JSONL */ }
  }

  // JSONL
  const out: BatchTask[] = [];
  for (const [i, line] of trimmed.split('\n').entries()) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try {
      out.push(normalizeTask(JSON.parse(s)));
    } catch (e) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

function normalizeTask(t: any): BatchTask {
  if (!t || typeof t !== 'object') throw new Error('任务必须是对象');
  if (!t.plugin || typeof t.plugin !== 'string') throw new Error('任务缺少 plugin 字段');
  return {
    plugin: t.plugin,
    command: t.command,
    params: (t.params && typeof t.params === 'object') ? t.params : {},
    id: t.id,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 执行批量任务。
 * runner 由调用方提供（通常是 engine.run 的薄包装），便于测试注入假实现。
 */
export async function runBatch(
  tasks: BatchTask[],
  runner: (task: BatchTask) => Promise<{ ok: boolean; data?: unknown; error?: string; ms: number }>,
  opts: BatchOptions = {},
): Promise<BatchResult[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, tasks.length || 1));
  const maxAttempts = Math.max(1, opts.retry ?? 1);
  const baseDelay = opts.retryDelayMs ?? 400;
  const rate = opts.ratePerSec ?? 0;
  const minGap = rate > 0 ? 1000 / rate : 0;

  const results: BatchResult[] = new Array(tasks.length);
  let cursor = 0;
  let lastStart = 0;
  // 限速用串行链：并发的 worker 依次排队通过，避免同时放行
  let gateChain: Promise<void> = Promise.resolve();

  const outStream = opts.outFile
    ? (() => {
        fs.mkdirSync(path.dirname(opts.outFile!), { recursive: true });
        return fs.createWriteStream(opts.outFile!, { flags: 'a' });
      })()
    : null;

  const gate = (): Promise<void> => {
    if (!minGap) return Promise.resolve();
    gateChain = gateChain.then(async () => {
      const wait = lastStart + minGap - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    return gateChain;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      const task = tasks[index];

      let attempt = 0;
      let lastErr = '';
      let lastMs = 0;

      while (attempt < maxAttempts) {
        attempt++;
        await gate();
        opts.onProgress?.({ index, total: tasks.length, task, state: attempt === 1 ? 'start' : 'retry' });

        const t0 = Date.now();
        try {
          const r = await withTimeout(runner(task), opts.timeoutMs);
          lastMs = r.ms || Date.now() - t0;
          if (r.ok) {
            const one: BatchResult = { index, task, ok: true, data: r.data, ms: lastMs, attempts: attempt };
            results[index] = one;
            opts.onProgress?.({ index, total: tasks.length, task, state: 'ok' });
            outStream?.write(JSON.stringify({ type: 'result', ...one }) + '\n');
            break;
          }
          lastErr = r.error || '未知错误';
        } catch (e) {
          lastErr = (e as Error).message;
          lastMs = Date.now() - t0;
        }

        if (attempt < maxAttempts) {
          await sleep(baseDelay * Math.pow(2, attempt - 1));
          continue;
        }
        const failed: BatchResult = { index, task, ok: false, error: lastErr, ms: lastMs, attempts: attempt };
        results[index] = failed;
        opts.onProgress?.({ index, total: tasks.length, task, state: 'fail' });
        outStream?.write(JSON.stringify({ type: 'result', ...failed }) + '\n');
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (outStream) {
    await new Promise<void>((r) => outStream.end(() => r()));
  }
  return results;
}

async function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`任务超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** 批量结果汇总 */
export function summarizeBatch(results: BatchResult[]): {
  total: number; ok: number; fail: number; ms: number;
  byPlugin: Record<string, { ok: number; fail: number }>;
  failures: { index: number; plugin: string; id?: string; error: string }[];
} {
  let ok = 0;
  let fail = 0;
  let ms = 0;
  const byPlugin: Record<string, { ok: number; fail: number }> = {};
  const failures: { index: number; plugin: string; id?: string; error: string }[] = [];

  for (const r of results) {
    if (!r) continue;
    ms += r.ms || 0;
    const bucket = (byPlugin[r.task.plugin] ||= { ok: 0, fail: 0 });
    if (r.ok) { ok++; bucket.ok++; }
    else {
      fail++; bucket.fail++;
      failures.push({ index: r.index, plugin: r.task.plugin, id: r.task.id, error: r.error || '' });
    }
  }
  return { total: results.filter(Boolean).length, ok, fail, ms, byPlugin, failures };
}