import util from 'node:util';

type Level = 'info' | 'warn' | 'error' | 'debug';

const COLORS: Record<Level, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

export class Logger {
  constructor(private opts: { verbose?: boolean; json?: boolean; quiet?: boolean; sink?: (line: string) => void } = {}) {}

  private emit(level: Level, msg: string, extra?: unknown): void {
    if (this.opts.quiet && level === 'info') return;
    if (!this.opts.verbose && level === 'debug') return;

    if (this.opts.sink) {
      const text = extra === undefined ? msg : `${msg} ${safe(extra)}`;
      this.opts.sink(text);
      return;
    }
    if (this.opts.json) {
      process.stderr.write(JSON.stringify({ level, msg, extra: extra ?? null }) + '\n');
      return;
    }
    const color = process.stderr.isTTY ? COLORS[level] : '';
    const reset = process.stderr.isTTY ? RESET : '';
    const line = extra === undefined ? msg : `${msg} ${safe(extra)}`;
    process.stderr.write(`${color}[forge:${level}]${reset} ${line}\n`);
  }

  info(msg: string, extra?: unknown) { this.emit('info', msg, extra); }
  warn(msg: string, extra?: unknown) { this.emit('warn', msg, extra); }
  error(msg: string, extra?: unknown) { this.emit('error', msg, extra); }
  debug(msg: string, extra?: unknown) { this.emit('debug', msg, extra); }

  /** 结果输出：stdout，供 AI / 管道消费 */
  data(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  }
  text(value: string): void {
    process.stdout.write(value.endsWith('\n') ? value : value + '\n');
  }
}

function safe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return util.inspect(v, { depth: 4, breakLength: 120, colors: false });
  } catch {
    return String(v);
  }
}

export const defaultLogger = new Logger();
