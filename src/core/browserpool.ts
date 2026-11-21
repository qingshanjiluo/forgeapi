/**
 * 浏览器进程池 —— 进程内复用 Chromium 实例
 *
 * 问题：每次 forge run 都 chromium.launch()，冷启动 5~10s，Web 控制台连续调试时开销巨大。
 * 方案：进程内单例 Browser，按 key（headless + userAgent + locale）分桶；
 *       context 仍按插件隔离（cookie/存储不串），用完即关 context，Browser 保留。
 *
 * 退出时机：进程结束（process.on('exit')）或显式 dispose()。
 */
import type { Browser, BrowserContext } from 'playwright';
import type { ForgeConfig } from './types.js';

export interface PooledBrowser {
  browser: Browser;
  key: string;
}

const registry = new Map<string, Browser>();
const launching = new Map<string, Promise<Browser>>();
let idleTimer: NodeJS.Timeout | null = null;
/** 活跃的 BrowserApi 实例数：>0 时 idle 到期只顺延、不回收 */
let activeUsers = 0;

/** 空闲多久后自动关闭浏览器（0 = 不自动关闭） */
const IDLE_MS = Number(process.env.FORGE_BROWSER_IDLE_MS ?? 60_000);

/**
 * Chromium 启动参数：
 * - 环境里有代理时显式传入，并强制绕过 loopback（否则 localhost 目标会被代理吞掉、30s 超时）
 * - FORGE_BROWSER_ARGS 可追加自定义参数（逗号分隔）
 */
function launchArgs(): string[] {
  const args: string[] = [];
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (proxy) {
    const server = proxy.replace(/^socks5:\/\//i, 'socks5://');
    args.push(`--proxy-server=${server}`);
    // <-loopback> 表示"反向绕过"：仅当显式指定时生效，让 127.0.0.1/localhost 直连
    args.push('--proxy-bypass-list=<-loopback>');
  }
  const extra = process.env.FORGE_BROWSER_ARGS;
  if (extra) args.push(...extra.split(',').map((s) => s.trim()).filter(Boolean));
  return args;
}

function poolKey(cfg: ForgeConfig): string {
  const b = cfg.browser;
  return JSON.stringify({
    headless: b.headless,
    userAgent: b.userAgent ?? '',
    locale: b.locale,
  });
}

export async function acquireBrowser(cfg: ForgeConfig): Promise<Browser> {
  const key = poolKey(cfg);
  const existing = registry.get(key);
  if (existing?.isConnected()) {
    touchIdle();
    return existing;
  }
  const pending = launching.get(key);
  if (pending) {
    const b = await pending;
    touchIdle();
    return b;
  }

  const p = (async () => {
    const pw = await import('playwright');
    const b = await pw.chromium.launch({ headless: cfg.browser.headless, args: launchArgs() });
    registry.set(key, b);
    launching.delete(key);
    touchIdle();
    return b;
  })();

  launching.set(key, p);
  try {
    return await p;
  } catch (e) {
    launching.delete(key);
    throw e;
  }
}

export async function newPooledContext(cfg: ForgeConfig): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await acquireBrowser(cfg);
  const context = await browser.newContext({
    locale: cfg.browser.locale,
    viewport: cfg.browser.viewport,
    userAgent: cfg.browser.userAgent,
  });
  return { browser, context };
}

function touchIdle(): void {
  if (!IDLE_MS || IDLE_MS <= 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // 有插件还拿着 context（哪怕正在 40s 的 goto 中）→ 只顺延，不回收
    if (activeUsers > 0) { touchIdle(); return; }
    void disposePool();
  }, IDLE_MS);
  idleTimer.unref?.();
}

/** 刷新空闲计时：任何一次拿页面/拿 context 都应调用，防止长任务中途被 idle 回收 */
export { touchIdle as touchBrowserIdle };

/** 有 BrowserApi 开始持有浏览器 */
export function markBrowserActive(): void {
  activeUsers++;
  touchIdle();
}

/** 有 BrowserApi 释放（close()） */
export function markBrowserReleased(): void {
  activeUsers = Math.max(0, activeUsers - 1);
  touchIdle();
}

export async function disposePool(): Promise<void> {
  for (const [k, b] of registry) {
    try { await b.close(); } catch { /* ignore */ }
    registry.delete(k);
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

export function poolStatus(): { keys: string[]; connected: boolean[] } {
  return {
    keys: [...registry.keys()],
    connected: [...registry.values()].map((b) => b.isConnected()),
  };
}

process.on('exit', () => {
  for (const b of registry.values()) {
    try { void b.close(); } catch { /* ignore */ }
  }
});