import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LogEntry, WorkspacePaths } from './types.js';
import { defaultLogger } from './log.js';

export class CallLog {
  constructor(private paths: WorkspacePaths, private keepDays = 30) {}

  private file(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return path.join(this.paths.logs, `${y}-${m}-${day}.jsonl`);
  }

  append(entry: LogEntry): void {
    try {
      fs.mkdirSync(this.paths.logs, { recursive: true });
      fs.appendFileSync(this.file(), JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      defaultLogger.warn('日志写入失败', e);
    }
  }

  newEntry(partial: Omit<LogEntry, 'id' | 'ts'>): LogEntry {
    return { id: crypto.randomUUID(), ts: new Date().toISOString(), ...partial };
  }

  list(opts: { limit?: number; plugin?: string; since?: string; onlyError?: boolean } = {}): LogEntry[] {
    const limit = opts.limit ?? 200;
    if (!fs.existsSync(this.paths.logs)) return [];
    const files = fs.readdirSync(this.paths.logs).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: LogEntry[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(this.paths.logs, f), 'utf8').split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as LogEntry;
          if (opts.plugin && e.plugin !== opts.plugin) continue;
          if (opts.since && e.ts < opts.since) continue;
          if (opts.onlyError && e.ok) continue;
          out.push(e);
          if (out.length >= limit) return out;
        } catch { /* 跳过坏行 */ }
      }
    }
    return out;
  }

  prune(): number {
    if (!fs.existsSync(this.paths.logs)) return 0;
    const cutoff = Date.now() - this.keepDays * 86400_000;
    let n = 0;
    for (const f of fs.readdirSync(this.paths.logs)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(this.paths.logs, f);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        n++;
      }
    }
    return n;
  }
}
