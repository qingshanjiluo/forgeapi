import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { pathToFileURL } from 'node:url';
import type {
  DeclarativePlugin, ForgeConfig, ForgePlugin, PluginContext, PluginResult,
  SourceDef, WorkspacePaths,
} from './types.js';
import { ensureDataDir, vaultFor, Vault } from './credentials.js';
import { createBrowserApi } from './browser.js';
import { extractFromHtml, extractFromJson, interpolate } from './extract.js';
import { mergeResults, itemsFromBody, AggregateInput } from './aggregate.js';
import { mapLimit } from './concurrency.js';
import { inspectPluginDir, readSkill, Registry } from './registry.js';
import { loadConfig } from './workspace.js';
import { defaultLogger, Logger } from './log.js';

export interface RunOptions {
  command?: string;
  params: Record<string, unknown>;
  logger?: Logger;
  config?: ForgeConfig;
  /** Web 控制台实时进度 */
  progress?: (msg: string) => void;
  /** 强制使用某个凭据库实例（CLI 复用已解锁的 vault） */
  vault?: Vault;
  /**
   * 执行结束后是否保留 Chromium 进程。
   * CLI 单次执行 = false（否则 Node 进程被浏览器挂住，要等空闲超时）；
   * Web 服务 / MCP 常驻 = true（连续调试省掉冷启动）。
   */
  reuseBrowser?: boolean;
}

export interface RunOutcome extends PluginResult {
  ms: number;
  plugin: string;
  command?: string;
}

/** 把声明式插件包成 ForgePlugin */
function wrapDeclarative(def: DeclarativePlugin, dir: string): ForgePlugin {
  return {
    name: def.name,
    version: def.version || '0.0.0',
    description: def.description || '',
    schema: def.schema || { type: 'object', properties: {} },
    skill: def.skill,
    permissions: def.permissions || [],
    execute: async (params, ctx) => runDeclarative(def, params, ctx),
    commands: [],
  };
}

async function runDeclarative(def: DeclarativePlugin, params: Record<string, unknown>, ctx: PluginContext): Promise<PluginResult> {
  const mode = def.type;

  /* ---- 单页提取 ---- */
  if (mode === 'extract' || (!mode && (def.url || def.rule || def.fields))) {
    const url = String(interpolate(def.url ?? params.url ?? '', params, ctx.getCredential) || '');
    if (!url) return { ok: false, error: '缺少 url' };
    // 规则优先级：params.rule > def.rule > 内置 fields
    const ruleRef = String(params.rule || def.rule || '');
    let resolvedFields = def.fields || [];
    let root: string | undefined;
    let usedRule: string | null = null;
    if (ruleRef) {
      const rule = loadRuleFile(ctx.dataDir, ruleRef);
      resolvedFields = rule.fields || resolvedFields;
      root = rule.root;
      usedRule = ruleRef;
    }
    const waitFor = params.waitFor ? String(params.waitFor) : undefined;
    const data = await ctx.browser.fetchExtract(url, resolvedFields, {
      root: root || (params.root ? String(params.root) : undefined),
      waitFor,
      timeout: params.timeout ? Number(params.timeout) : undefined,
    });
    return { ok: true, data: shapeOutput(data, def), meta: { url, rule: usedRule, fields: resolvedFields.length } };
  }

  /* ---- 完整会话流程 ---- */
  if (mode === 'flow') {
    const out = await ctx.browser.runSteps(def.steps || [], params);
    if (def.output?.fields) {
      const d = out[def.output.fields[0]] as any;
      if (d) (out as any)[def.output.fields[0]] = shapeOutput(d, def);
    }
    return { ok: true, data: out, meta: { steps: (def.steps || []).length } };
  }

  /* ---- 多来源聚合 ---- */
  if (mode === 'aggregate' || (def.sources && def.sources.length)) {
    const sources = def.sources || [];
    const concurrency = Number((def as any).concurrency ?? 3);
    const inputs: AggregateInput[] = [];

    ctx.progress(`[aggregate] ${sources.length} 个来源，并发 ${concurrency}`);

    const results = await mapLimit(sources, concurrency, async (src) => {
      ctx.progress(`[source] ${src.name} (${src.type})`);
      try {
        const items = await fetchSource(src, params, ctx);
        ctx.log('debug', `来源 ${src.name} 命中 ${items.length} 条`);
        return { name: src.name, items } as AggregateInput;
      } catch (e) {
        const msg = (e as Error).message;
        ctx.log('warn', `来源 ${src.name} 失败: ${msg}`);
        return { name: src.name, items: [], error: msg } as AggregateInput;
      }
    });

    inputs.push(...results);

    // 缓存：命中则跳过（key 由插件名 + 参数 + 来源集合构成）
    const merged = mergeResults(
      inputs,
      def.merge || { strategy: 'concat' },
      (def.merge as any)?.keyMap || def.output?.keyMap,
    );
    return {
      ok: true,
      data: {
        query: params.query ?? params.q ?? null,
        results: merged.results,
        total: merged.total,
        sources: merged.sources,
      },
    };
  }

  return { ok: false, error: `插件类型未识别: ${def.type ?? 'undefined'}` };
}

/** 从插件 dataDir/rules 读取规则文件（支持带/不带扩展名） */
function loadRuleFile(dataDir: string, name: string): any {
  const base = path.join(dataDir, 'rules');
  const candidates = [
    path.join(base, name),
    path.join(base, `${name}.yaml`),
    path.join(base, `${name}.yml`),
    path.join(base, `${name}.json`),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const raw = fs.readFileSync(c, 'utf8');
    if (c.endsWith('.json')) return JSON.parse(raw);
    return yaml.load(raw);
  }
  throw new Error(`规则文件未找到: ${name}（查找于 ${base}）`);
}

function shapeOutput(data: Record<string, unknown>, def: DeclarativePlugin): Record<string, unknown> {
  if (!def.output) return data;
  if (def.output.raw) return data;
  const keyMap = def.output.keyMap || {};
  const fields = def.output.fields;
  if (!fields?.length) {
    if (!Object.keys(keyMap).length) return data;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) o[keyMap[k] || k] = v;
    return o;
  }
  const o: Record<string, unknown> = {};
  for (const f of fields) {
    const key = keyMap[f] || f;
    o[key] = (data as any)[f] ?? null;
  }
  return o;
}

async function fetchSource(src: SourceDef, params: Record<string, unknown>, ctx: PluginContext): Promise<unknown[]> {
  const interp = (v: unknown) => interpolate(v, params, ctx.getCredential);

  if (src.type === 'api' || src.type === 'json') {
    let url = String(interp(src.url ?? ''));
    if (!url) throw new Error(`来源 ${src.name} 缺少 url`);
    const qsRaw = interp(src.params);
    const qs = qsRaw && typeof qsRaw === 'object' && !Array.isArray(qsRaw) ? (qsRaw as Record<string, unknown>) : undefined;
    if (qs) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(qs)) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      url = u.toString();
    }
    const method = String(interp(src.method || 'GET')).toUpperCase();
    const hdrRaw = interp(src.headers);
    const headers: Record<string, string> = { 'user-agent': 'ForgeAPI/0.1 (+local)' };
    if (hdrRaw && typeof hdrRaw === 'object' && !Array.isArray(hdrRaw)) {
      for (const [k, v] of Object.entries(hdrRaw as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
      }
    }
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && src.body !== undefined) {
      const b = interp(src.body);
      body = typeof b === 'string' ? b : JSON.stringify(b);
      if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), src.timeout ?? 20000);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON 保留文本 */ }
      const jp = interp(src.jsonpath);
      const srcWithPath = { ...src, jsonpath: typeof jp === 'string' && jp ? jp : undefined };
      if (Array.isArray(parsed)) return parsed;
      return itemsFromBody(parsed, srcWithPath);
    } finally {
      clearTimeout(timer);
    }
  }

  if (src.type === 'webpage') {
    const url = String(interp(src.url ?? ''));
    let fields: any[] = [];
    if (typeof src.rule === 'string') {
      const rp = path.join(ctx.dataDir, 'rules', src.rule);
      if (fs.existsSync(rp)) {
        const yaml = await import('js-yaml');
        const rule = yaml.load(fs.readFileSync(rp, 'utf8')) as any;
        fields = rule.fields || [];
      }
    } else if (src.rule && typeof src.rule === 'object') {
      fields = (src.rule as any).fields || [];
    }
    const data = await ctx.browser.fetchExtract(url, fields, { waitFor: (src as any).waitFor });
    // 若规则是 list 型，取第一个 list 字段
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
    return [data];
  }

  if (src.type === 'code') {
    const fn = new Function('params', 'ctx', `"use strict"; return (async () => { ${src.code} })();`);
    const r = await fn(params, ctx);
    return Array.isArray(r) ? r : itemsFromBody(r, src);
  }

  throw new Error(`未知来源类型: ${src.type}`);
}

export class ForgeEngine {
  readonly paths: WorkspacePaths;
  readonly registry: Registry;
  private cache = new Map<string, ForgePlugin>();
  private vault: Vault | null = null;

  constructor(paths: WorkspacePaths, vault?: Vault) {
    this.paths = paths;
    this.registry = new Registry(paths);
    this.vault = vault || null;
  }

  private getVault(): Vault {
    if (!this.vault) this.vault = vaultFor(this.paths);
    return this.vault;
  }

  /** 加载插件定义（代码型动态 import，声明式包装） */
  async load(name: string): Promise<ForgePlugin> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`插件未安装: ${name}`);
    if (!entry.enabled) throw new Error(`插件已禁用: ${name}`);

    const info = inspectPluginDir(entry.dir);
    if (!info) throw new Error(`插件目录无效（无 manifest 也无入口文件）: ${entry.dir}`);

    let plugin: ForgePlugin;
    if (info.kind === 'declarative') {
      plugin = wrapDeclarative(info.manifest!, entry.dir);
      const skill = readSkill(entry.dir);
      if (skill && !plugin.skill) plugin.skill = skill;
    } else {
      const url = pathToFileURL(info.entry).href;
      let mod: any;
      try {
        mod = await import(url + `?t=${Date.now()}`);
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err.message)) {
          // 代码型插件带外部依赖：需要在该插件目录下安装
          const dep = (err.message.match(/Cannot find (?:module|package) '([^']+)'/) || [])[1] || '（见下）';
          throw new Error(
            `插件 ${name} 缺少依赖 ${dep}。在插件目录安装后再试：\n` +
            `  cd "${entry.dir}" && npm install\n` +
            `原始错误: ${err.message.split('\n')[0]}`,
          );
        }
        throw new Error(`插件 ${name} 加载失败: ${err.message}`);
      }
      const exported = (mod.default || mod.plugin || mod) as ForgePlugin;
      if (typeof exported?.execute !== 'function') {
        throw new Error(`代码插件 ${name} 未导出 execute 函数（需要 export default { name, execute }）`);
      }
      plugin = exported;
    }
    this.cache.set(name, plugin);
    return plugin;
  }

  clearCache(name?: string): void {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }

  /** 关闭浏览器池（批量任务结束 / 进程退出前） */
  async disposeBrowser(): Promise<void> {
    const { disposePool } = await import('./browserpool.js');
    await disposePool();
  }

  private makeContext(plugin: ForgePlugin, opts: RunOptions, logger: Logger): PluginContext {
    const dataDir = ensureDataDir(this.paths, plugin.name);
    const vault = this.getVault();
    const config = opts.config || loadConfig(this.paths);
    const browser = createBrowserApi({
      config,
      dataDir,
      paths: this.paths,
      plugin: plugin.name,
      log: (l, m, e) => logger[l](m, e),
      progress: opts.progress || (() => {}),
      cred: (k) => {
        try { return vault.get(plugin.name, k); } catch { return undefined; }
      },
    });
    return {
      plugin: plugin.name,
      paths: this.paths,
      dataDir,
      getCredential: (k) => {
        try { return vault.get(plugin.name, k); } catch { return undefined; }
      },
      setCredential: (k, v) => vault.set(plugin.name, k, v),
      log: (level, msg, extra) => logger[level](msg, extra),
      browser,
      config,
      progress: opts.progress || (() => {}),
    };
  }

  async run(name: string, opts: RunOptions): Promise<RunOutcome> {
    const t0 = Date.now();
    const logger = opts.logger || defaultLogger;
    // 每次执行都复核启用状态（缓存不绕过禁用）
    this.registry.reload();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`插件未安装: ${name}`);
    if (!entry.enabled) throw new Error(`插件已禁用: ${name}`);
    const plugin = await this.load(name);
    const ctx = this.makeContext(plugin, opts, logger);
    let result: PluginResult;
    try {
      if (opts.command) {
        const cmd = (plugin.commands || []).find((c) => c.name === opts.command);
        if (!cmd) throw new Error(`插件 ${name} 无子命令: ${opts.command}`);
        result = await cmd.handler(opts.params, ctx);
      } else {
        if (typeof plugin.execute !== 'function') throw new Error(`插件 ${name} 无 execute`);
        result = await plugin.execute(opts.params, ctx);
      }
    } catch (e) {
      const err = e as Error;
      logger.error(`执行失败: ${err.message}`);
      result = { ok: false, error: err.stack || err.message };
    } finally {
      try { await ctx.browser.close(); } catch { /* ignore */ }
      // CLI 单次执行：关掉 Chromium，避免进程被浏览器挂住
      if (!opts.reuseBrowser) {
        try { await ctx.browser.closeBrowser(); } catch { /* ignore */ }
      }
    }
    return { ...result, ms: Date.now() - t0, plugin: name, command: opts.command };
  }
}
