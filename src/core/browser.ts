import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ForgeConfig, SessionStep, FieldRule, ExtractRule, WorkspacePaths } from './types.js';
import { extractFromHtml, interpolate } from './extract.js';
import { readJson, writeJson } from './workspace.js';
import { newPooledContext, disposePool, touchBrowserIdle, markBrowserActive, markBrowserReleased } from './browserpool.js';

export interface BrowserApi {
  /** 获取（惰性启动）页面；同一插件复用同一 context */
  page: () => Promise<Page>;
  /** 完整跑一遍会话步骤，返回步骤输出 */
  runSteps: (steps: SessionStep[], vars?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** 打开 URL 并按字段规则提取（HTML 路径，纯 http 也能用） */
  fetchExtract: (url: string, fields: FieldRule[], opts?: { root?: string; waitFor?: string; timeout?: number }) => Promise<Record<string, unknown>>;
  /** 保存/读取 cookie */
  saveCookies: (path?: string) => Promise<string>;
  loadCookies: (path?: string) => Promise<number>;
  close: () => Promise<void>;
  /** 关闭整个浏览器池（进程退出前清理） */
  closeBrowser: () => Promise<void>;
}

interface BrowserDeps {
  config: ForgeConfig;
  dataDir: string;
  paths: WorkspacePaths;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: unknown) => void;
  progress: (msg: string) => void;
  cred: (k: string) => string | undefined;
  plugin: string;
}

export function createBrowserApi(deps: BrowserDeps): BrowserApi {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let holding = false;
  const cookieFile = path.join(deps.dataDir, 'cookies.json');

  const getBrowser = async (): Promise<Browser> => {
    if (browser && browser.isConnected()) return browser;
    // 进程内复用：不重复 launch Chromium
    const pooled = await newPooledContext(deps.config);
    browser = pooled.browser;
    context = pooled.context;

    // 自动加载已保存 cookie
    if (fs.existsSync(cookieFile)) {
      try {
        const saved = readJson<any[]>(cookieFile, []);
        if (Array.isArray(saved) && saved.length) await context.addCookies(saved);
        deps.log('debug', `已加载 ${saved.length} 条 cookie`);
      } catch { /* ignore */ }
    }
    return browser;
  };

  const getPage = async (): Promise<Page> => {
    // 长任务（如 guba 东财重试 30s+ 再切淘股吧）撞上 60s idle 回收会让 goto 报
    // "Target page, context or browser has been closed" —— 所以拿页面时标记活跃 + 刷新 idle
    if (!holding) { holding = true; markBrowserActive(); }
    touchBrowserIdle();
    if (page && !page.isClosed()) return page;
    await getBrowser();
    touchBrowserIdle();
    page = await context!.newPage();
    page.setDefaultTimeout(deps.config.browser.timeout);
    return page;
  };

  const resolveRule = (rule?: string | ExtractRule): ExtractRule | null => {
    if (!rule) return null;
    if (typeof rule !== 'string') return rule;
    const candidates = [
      path.join(deps.dataDir, 'rules', rule),
      path.join(deps.dataDir, rule),
      path.isAbsolute(rule) ? rule : path.join(deps.dataDir, 'rules', `${rule}.yaml`),
      path.isAbsolute(rule) ? rule : path.join(deps.dataDir, 'rules', `${rule}.yml`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const text = fs.readFileSync(c, 'utf8');
        return parseYamlRule(text);
      }
    }
    throw new Error(`规则文件未找到: ${rule}`);
  };

  const runSteps = async (steps: SessionStep[], vars: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const p = await getPage();
    const out: Record<string, unknown> = {};
    const shots: string[] = [];
    let stepIndex = 0;

    for (const raw of steps) {
      stepIndex++;
      const s = interpolate(raw, vars, deps.cred) as SessionStep;
      deps.progress(`[step ${stepIndex}/${steps.length}] ${s.action}${s.url ? ' ' + s.url : ''}${s.selector ? ' ' + s.selector : ''}`);
      deps.log('debug', `step ${stepIndex}: ${s.action}`, { url: s.url, selector: s.selector });

      switch (s.action) {
        case 'goto': {
          if (!s.url) throw new Error(`step ${stepIndex}: goto 缺少 url`);
          const resp = await p.goto(s.url, { waitUntil: 'domcontentloaded', timeout: s.timeout });
          if (resp && !resp.ok() && resp.status() >= 400) {
            deps.log('warn', `goto ${s.url} 返回 ${resp.status()}`);
          }
          break;
        }
        case 'fill':
          await p.fill(s.selector!, s.value ?? '');
          break;
        case 'type':
          await p.type(s.selector!, s.value ?? '', { delay: s.delay ?? 20 });
          break;
        case 'click':
          await p.click(s.selector!, { timeout: s.timeout });
          break;
        case 'press':
          await p.press(s.selector || 'body', s.value || 'Enter');
          break;
        case 'wait':
          await p.waitForTimeout(s.ms ?? s.delay ?? 500);
          break;
        case 'waitFor':
          await p.waitForSelector(s.selector!, { timeout: s.timeout ?? deps.config.browser.timeout });
          break;
        case 'scroll': {
          const times = s.times ?? 1;
          for (let i = 0; i < times; i++) {
            await p.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
            await p.waitForTimeout(s.delay ?? 300);
          }
          break;
        }
        case 'eval': {
          const r = await p.evaluate(s.script ?? s.value ?? 'null');
          const key = s.key || 'eval';
          const prev = out[key];
          out[key] = prev === undefined ? r : Array.isArray(prev) ? [...prev, r] : [prev, r];
          break;
        }
        case 'extract': {
          const rule = resolveRule(s.rule);
          const fields = s.fields || rule?.fields || [];
          const html = await p.content();
          const data = extractFromHtml(html, fields, { root: rule?.root, rootKind: rule?.rootKind });
          const key = s.key || (rule?.name || 'data');
          out[key] = data;
          break;
        }
        case 'screenshot': {
          const f = s.path || path.join(deps.dataDir, `shot-${Date.now()}.png`);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          await p.screenshot({ path: f, fullPage: s.fullPage ?? true });
          shots.push(f);
          out.screenshots = shots;
          break;
        }
        case 'cookie-save': {
          const f = s.path || cookieFile;
          const cookies = await context!.cookies();
          writeJson(f, cookies);
          out.cookieFile = f;
          break;
        }
        case 'cookie-load': {
          const f = s.path || cookieFile;
          const cookies = readJson<any[]>(f, []);
          await context!.addCookies(cookies);
          out.cookiesLoaded = cookies.length;
          break;
        }
        case 'sleep':
          await new Promise((r) => setTimeout(r, s.ms ?? 1000));
          break;
        default:
          throw new Error(`未知 step action: ${(s as any).action}`);
      }
    }
    out._finalUrl = p.url();
    out._title = await p.title().catch(() => '');
    return out;
  };

  /** 判断字段树里是否含 XPath 选择器 */
function usesXPath(f: FieldRule): boolean {
  const s = (f.selector || '').trim();
  if (f.kind === 'xpath') return true;
  if (s.startsWith('/') || s.startsWith('//') || s.startsWith('(')) return true;
  if (f.fields?.length) return f.fields.some(usesXPath);
  return false;
}

/** 在页面上下文执行提取（支持 CSS 与 XPath），由 Playwright serialize 返回 */
function domExtract(arg: { fields: FieldRule[]; root: string | null }): Record<string, unknown> {
  const nrm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const queryAll = (sel: string, scope: ParentNode): Element[] => {
    if (!sel) return [];
    if (sel.startsWith('/') || sel.startsWith('//') || sel.startsWith('(')) {
      const doc = (scope as Document).evaluate ? (scope as Document) : document;
      const it = doc.evaluate(sel, scope as Node, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out: Element[] = [];
      for (let i = 0; i < it.snapshotLength; i++) {
        const n = it.snapshotItem(i);
        if (n && n.nodeType === 1) out.push(n as Element);
      }
      return out;
    }
    return Array.from(scope.querySelectorAll(sel));
  };

  const coerce = (v: string, type?: string, tr?: string): unknown => {
    if (type === 'number') {
      const m = v.replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    }
    if (type === 'bool') return ['true', '1', 'yes', '是', '有'].includes(v.trim().toLowerCase());
    if (tr === 'lower') return v.toLowerCase();
    if (tr === 'upper') return v.toUpperCase();
    if (tr === 'number') {
      const m = v.replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    }
    return v.trim();
  };

  const leaf = (f: any, scope: ParentNode | null): unknown => {
    const t = f.type || 'text';
    if (t === 'list') {
      const nodes = queryAll(f.selector || '', scope || document);
      const out: unknown[] = [];
      for (const n of nodes.slice(0, f.limit ?? nodes.length)) {
        if (f.fields?.length) {
          const o: any = {};
          for (const sub of f.fields) o[sub.name] = leaf(sub, n);
          out.push(o);
        } else {
          out.push(coerce(nrm(n.textContent), t, f.transform));
        }
      }
      return out;
    }
    if (!f.selector) {
      if (!scope) return f.optional ? undefined : null;
      const n = scope as Element;
      if (t === 'html') return n.innerHTML ?? '';
      if (t === 'attr') return f.attr ? n.getAttribute(f.attr) : null;
      if (t === 'url') return n.getAttribute('href') ?? n.getAttribute('src') ?? null;
      return coerce(nrm(n.textContent), t, f.transform);
    }
    const first = queryAll(f.selector, scope || document)[0];
    if (!first) return f.optional ? undefined : null;
    if (t === 'html') return first.innerHTML;
    if (t === 'attr') return f.attr ? first.getAttribute(f.attr) : null;
    if (t === 'url') return first.getAttribute('href') ?? first.getAttribute('src') ?? null;
    return coerce(nrm(first.textContent), t, f.transform);
  };

  const scopes = arg.root ? queryAll(arg.root, document) : [null];
  if (arg.root && !scopes.length) return {};
  const out: Record<string, unknown> = {};
  for (const f of arg.fields) {
    if (arg.root) {
      // 根选择器命中多个时，取第一个作为容器
      const v = leaf(f, scopes[0] as ParentNode);
      if (v !== undefined) out[f.name] = v;
    } else {
      const v = leaf(f, null);
      if (v !== undefined) out[f.name] = v;
    }
  }
  return out;
}

const fetchExtract = async (url: string, fields: FieldRule[], opts: { root?: string; waitFor?: string; timeout?: number } = {}) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    if (opts.waitFor) await p.waitForSelector(opts.waitFor, { timeout: opts.timeout ?? deps.config.browser.timeout });
    const html = await p.content();
    // 含 XPath 时走真实 DOM（cheerio 无 XPath）
    const hasXPath = fields.some(usesXPath);
    if (hasXPath) {
      const res = await p.evaluate(domExtract, { fields, root: opts.root ?? null });
      return res as Record<string, unknown>;
    }
    return extractFromHtml(html, fields, { root: opts.root });
  };

  return {
    page: getPage,
    runSteps,
    fetchExtract,
    saveCookies: async (f?: string) => {
      await getBrowser();
      const target = f || cookieFile;
      writeJson(target, await context!.cookies());
      return target;
    },
    loadCookies: async (f?: string) => {
      await getBrowser();
      const cookies = readJson<any[]>(f || cookieFile, []);
      await context!.addCookies(cookies);
      return cookies.length;
    },
    close: async () => {
      // 只关 context（隔离：cookie/存储不跨插件），Chromium 进程留给池复用
      try { if (page && !page.isClosed()) await page.close(); } catch { /* ignore */ }
      try { if (context) await context.close(); } catch { /* ignore */ }
      page = null; context = null; browser = null;
      if (holding) { holding = false; markBrowserReleased(); }
    },
    /** 关闭整个浏览器池（进程退出或显式清理时用） */
    closeBrowser: async () => { await disposePool(); },
  };
}

/** YAML 规则解析 */
export function parseYamlRule(text: string): ExtractRule {
  return yaml.load(text) as ExtractRule;
}
