#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ForgeEngine } from '../core/engine.js';
import { Registry } from '../core/registry.js';
import { ensureDirs, loadConfig, patchConfig, resolvePaths } from '../core/workspace.js';
import { Logger } from '../core/log.js';
import { CallLog } from '../core/calllog.js';
import { vaultFor } from '../core/credentials.js';
import { installPlugin, removePlugin, readPluginConfig, writePluginConfig, listRules, writeRule, pluginDetail } from '../core/installer.js';
import { generateSkill } from '../core/skillgen.js';
import { searchTemplates, installTemplate, listTemplates, exportTemplate, searchRemote, installRemoteTemplate } from '../core/templates.js';
import { initWorkspace } from './bootstrap.js';
import { rewriteArgv } from './argvrewrite.js';
import { packageVersion } from '../core/version.js';
import { readTasks, runBatch, summarizeBatch, type BatchTask } from '../core/scheduler.js';
import { verifyAll, verifyPlugin, lockBaseline, type VerifyItem } from '../core/integrity.js';
import { diffResults, readSnapshot, writeSnapshot, snapshotFile, extractItems } from '../core/diff.js';
import { readPipeline, runPipeline, type PipelineDef } from '../core/pipeline.js';
import {
  createKeys, signPlugin, signatureStatusAll, exportPublicKey, importPublicKey,
  listTrustedKeys, verifyWithTrusted, defaultKeyPaths,
} from '../core/signing.js';
import {
  loadSchedules, addSchedule, removeSchedule, setEnabled, markRun, dueEntries,
} from '../core/schedule.js';
import type { Permission, WorkspacePaths } from '../core/types.js';

const paths = resolvePaths();
ensureDirs(paths);

const program = new Command();
program
  .name('forge')
  .description('ForgeAPI — 把世界锻造成 AI 能调用的接口')
  .version(packageVersion())
  .option('--json', '错误以 JSON 输出（日志走 stderr）')
  .option('-v, --verbose', '详细日志')
  .option('-q, --quiet', '静默 info 日志');

function logger(): Logger {
  const o = program.opts();
  return new Logger({ verbose: Boolean(o.verbose), json: Boolean(o.json), quiet: Boolean(o.quiet) });
}

function engine(): ForgeEngine {
  return new ForgeEngine(paths, vaultFor(paths));
}

function parseParams(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  const s = raw.trim();
  if (!s) return {};
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s);
  // k=v,k2=v2 形式
  const out: Record<string, unknown> = {};
  for (const pair of s.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    let v: unknown = pair.slice(idx + 1).trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+(\.\d+)?$/.test(String(v))) v = Number(v);
    out[k] = v;
  }
  return out;
}

/** 合并参数来源：--params-file > --params */
function resolveParams(opts: any): Record<string, unknown> {
  if (opts?.paramsFile) {
    const raw = fs.readFileSync(String(opts.paramsFile), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: parsed };
  }
  return parseParams(opts?.params);
}

const PARAMS_OPTS = '-p, --params <json>';
const PARAMS_FILE_OPT = '--params-file <path>';

/** 从 --key value / --key=value 收集未声明的散参数 */
function collectArgs(cmd: Command): Record<string, unknown> {
  const o = (cmd.opts?.() || {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const SKIP = new Set(['params', 'paramsFile', 'json', 'verbose', 'quiet', 'yes', 'force', 'timeout', 'limit', 'plugin', 'error']);
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k)) continue;
    if (v === undefined) continue;
    clean[k] = v;
  }
  return clean;
}

function finish(ok: boolean, payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exitCode = ok ? 0 : 1;
}

/**
 * 流式输出（NDJSON）：把结果数组逐条写到 stdout，首行是 meta 头。
 * 适合大批量抓取——下游可边收边处理，不必等整个结果集。
 */
function streamOut(out: { ok: boolean; data?: unknown; error?: string; meta?: unknown; ms: number }): void {
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

  if (!out.ok) {
    write({ type: 'error', ok: false, error: out.error ?? '未知错误', ms: out.ms });
    process.exitCode = 1;
    return;
  }

  const d = out.data;
  // 找出结果数组：直接是数组，或 data.results / data.items / 首个数组字段
  let arr: unknown[] | null = null;
  let wrapKey = '';
  if (Array.isArray(d)) {
    arr = d;
  } else if (d && typeof d === 'object') {
    for (const k of ['results', 'items', 'topics', 'boards', 'posts', 'entries']) {
      if (Array.isArray((d as any)[k])) { arr = (d as any)[k]; wrapKey = k; break; }
    }
    if (!arr) {
      const firstArr = Object.entries(d as object).find(([, v]) => Array.isArray(v));
      if (firstArr) { arr = firstArr[1] as unknown[]; wrapKey = firstArr[0]; }
    }
  }

  write({
    type: 'meta',
    ok: true,
    ms: out.ms,
    key: wrapKey || null,
    count: arr ? arr.length : 0,
    data: arr ? undefined : d,
  });

  if (arr) {
    for (const item of arr) write({ type: 'item', value: item, key: wrapKey || null });
  }
  write({ type: 'end', ok: true, count: arr ? arr.length : 0, ms: out.ms });
}

/* =================== run =================== */
program
  .command('run <plugin>')
  .description('执行插件')
  .option('-p, --params <json>', '参数：JSON 或 k=v,k2=v2')
  .option('--params-file <path>', '从文件读取 JSON 参数（避免 shell 引号问题）')
  .option('--stream', '流式输出：每条结果一行 NDJSON（适合大批量抓取）')
  .option('--timeout <ms>', '超时（毫秒）')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (pluginName: string, opts, cmd: Command) => {
    const log = logger();
    const merged = { ...collectArgs(cmd), ...resolveParams(opts) };
    const t0 = Date.now();
    try {
      const eng = engine();
      // 子命令检测：forge run <plugin> <sub>
      const sub = cmd.args[1];
      let command: string | undefined;
      if (sub) {
        const p = await eng.load(pluginName);
        if ((p.commands || []).some((c) => c.name === sub)) command = sub;
      }
      const out = await eng.run(pluginName, { params: merged, command, logger: log });
      const entry = new CallLog(paths).newEntry({
        plugin: pluginName,
        command,
        params: merged,
        ok: out.ok,
        ms: out.ms,
        summary: out.ok ? summarize(out.data) : (out.error || '').slice(0, 200),
        error: out.error?.slice(0, 2000),
        exitCode: out.ok ? 0 : 1,
      });
      new CallLog(paths).append(entry);
      if (allOpts(cmd).stream) {
        streamOut(out);
      } else {
        finish(out.ok, { ok: out.ok, data: out.data ?? null, error: out.error ?? null, meta: out.meta ?? null, ms: out.ms });
      }
      void t0;
    } catch (e) {
      const err = e as Error;
      log.error(err.message);
      const entry = new CallLog(paths).newEntry({
        plugin: pluginName, params: merged, ok: false, ms: Date.now() - t0,
        summary: err.message.slice(0, 200), error: err.stack?.slice(0, 2000), exitCode: 1,
      });
      new CallLog(paths).append(entry);
      finish(false, { ok: false, error: err.message });
    }
  });

function summarize(data: unknown): string {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data as object);
    return `object{${keys.slice(0, 6).join(',')}${keys.length > 6 ? '…' : ''}}`;
  }
  return String(data).slice(0, 120);
}

/** 同时读取本命令与全局选项（--json 定义在 program 上） */
function allOpts(cmd: Command): Record<string, any> {
  const own = (cmd.opts?.() || {}) as Record<string, any>;
  const globals = typeof (cmd as any).optsWithGlobals === 'function'
    ? ((cmd as any).optsWithGlobals() as Record<string, any>)
    : (program.opts() as Record<string, any>);
  return { ...globals, ...own };
}

/* =================== list / info =================== */
program
  .command('list')
  .description('列出已安装插件')
  .option('--enabled', '只列启用的')
  .option('--json', 'JSON 输出')
  .action((_opts, cmd: Command) => {
    const opts = allOpts(cmd);
    const reg = new Registry(paths);
    const items = (opts.enabled ? reg.enabled() : reg.all()).map((e) => ({
      name: e.name, version: e.version, enabled: e.enabled, description: e.description, permissions: e.permissions,
    }));
    if (opts.json) return finish(true, items);
    if (!items.length) return finish(true, []);
    const rows = items.map((i) => `${i.enabled ? '[x]' : '[ ]'} ${i.name.padEnd(22)} v${i.version.padEnd(10)} ${i.description.slice(0, 60)}`);
    output.write(rows.join('\n') + '\n');
  });

program
  .command('info <plugin>')
  .description('查看插件详情')
  .action(async (name: string) => {
    const d = pluginDetail(paths, name);
    if (!d) return finish(false, { ok: false, error: `插件未安装: ${name}` });
    const eng = engine();
    const p = await eng.load(name);
    finish(true, {
      name: p.name, version: p.version, description: p.description,
      kind: d.kind, dir: d.entry.dir, enabled: d.entry.enabled,
      permissions: d.entry.permissions, schema: p.schema,
      commands: (p.commands || []).map((c) => ({ name: c.name, description: c.description })),
      hasSkill: Boolean(d.skill),
    });
  });

/* =================== schema / skill =================== */
program
  .command('schema <plugin>')
  .description('输出插件参数 Schema (JSON)')
  .action(async (name: string) => {
    const eng = engine();
    const p = await eng.load(name);
    finish(true, p.schema);
  });

program
  .command('skill <plugin>')
  .description('输出插件 Skill 文档 (Markdown)')
  .option('--write <file>', '写入文件')
  .action(async (name: string, opts) => {
    const eng = engine();
    const p = await eng.load(name);
    const rules = listRules(paths, name);
    const md = generateSkill(p, { rules });
    if (opts.write) {
      fs.writeFileSync(opts.write, md, 'utf8');
      return finish(true, { ok: true, file: path.resolve(opts.write) });
    }
    output.write(md);
  });

/* =================== install / remove / enable =================== */
program
  .command('install <source>')
  .description('安装插件（本地目录 / .tgz / 内置名 / HTTP URL / GitHub 仓库）')
  .option('-f, --force', '覆盖已存在')
  .option('-y, --yes', '自动确认权限')
  .option('--no-install', '不自动安装插件 npm 依赖')
  .action(async (source: string, opts) => {
    const log = logger();
    try {
      const rl = readline.createInterface({ input, output });
      const res = await installPlugin(paths, {
        source,
        force: opts.force,
        yes: opts.yes,
        noInstall: opts.install === false,
        onProgress: (m) => log.info(m),
        confirmPermissions: async (perms: Permission[], name: string) => {
          if (opts.yes) return true;
          if (!input.isTTY) {
            log.warn(`非交互环境，默认授予权限: ${perms.join(',')}`);
            return true;
          }
          output.write(`插件 ${name} 申请权限:\n`);
          for (const p of perms) output.write(`  - ${p}\n`);
          const a = await rl.question('允许? [y/N] ');
          return /^y(es)?$/i.test(a.trim());
        },
      });
      rl.close();
      finish(true, { ok: true, ...res });
    } catch (e) {
      log.error((e as Error).message);
      finish(false, { ok: false, error: (e as Error).message });
    }
  });

program
  .command('remove <plugin>')
  .description('卸载插件')
  .action((name: string) => {
    const ok = removePlugin(paths, name);
    finish(ok, ok ? { ok: true, removed: name } : { ok: false, error: `未安装: ${name}` });
  });

program
  .command('enable <plugin>')
  .description('启用插件')
  .action((name: string) => {
    const ok = new Registry(paths).setEnabled(name, true);
    finish(ok, ok ? { ok: true, enabled: name } : { ok: false, error: `未安装: ${name}` });
  });

program
  .command('disable <plugin>')
  .description('禁用插件')
  .action((name: string) => {
    const ok = new Registry(paths).setEnabled(name, false);
    finish(ok, ok ? { ok: true, disabled: name } : { ok: false, error: `未安装: ${name}` });
  });

/* =================== log =================== */
program
  .command('log')
  .description('查看调用日志')
  .option('-n, --limit <n>', '条数', '50')
  .option('--plugin <name>', '只看某插件')
  .option('--error', '只看失败')
  .option('--json', 'JSON 输出')
  .action((_opts, cmd: Command) => {
    const opts = allOpts(cmd);
    const entries = new CallLog(paths).list({ limit: Number(opts.limit), plugin: opts.plugin, onlyError: Boolean(opts.error) });
    if (opts.json) return finish(true, entries);
    const lines = entries.map((e) => `${e.ts} ${e.ok ? 'OK  ' : 'FAIL'} ${e.plugin}${e.command ? ':' + e.command : ''} ${e.ms}ms ${e.summary}`);
    output.write((lines.join('\n') || '(无日志)') + '\n');
  });

/* =================== config =================== */
program
  .command('config')
  .description('查看/修改全局配置')
  .option('--get', '输出当前配置 JSON')
  .option('--set <k=v>', '设置（可重复）', (v, acc: string[]) => [...(acc || []), v], [] as string[])
  .option('--path', '输出工作区路径')
  .option('--vault <action>', '凭据库: init|unlock|set|get|list|lock')
  .option('--plugin <name>', 'vault 操作对应插件')
  .option('--key <k>', 'vault 键')
  .option('--value <v>', 'vault 值')
  .option('--password <p>', '主密码')
  .action(async (opts) => {
    if (opts.path) return finish(true, paths);
    if (opts.vault) return handleVault(opts);
    if (opts.set?.length) {
      const patch: Record<string, unknown> = {};
      for (const kv of opts.set) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        const keyPath = kv.slice(0, i).split('.');
        let cur = patch;
        for (let j = 0; j < keyPath.length - 1; j++) {
          cur[keyPath[j]] = cur[keyPath[j]] || {};
          cur = cur[keyPath[j]] as Record<string, unknown>;
        }
        let v: unknown = kv.slice(i + 1);
        if (v === 'true') v = true; else if (v === 'false') v = false;
        else if (/^\d+$/.test(String(v))) v = Number(v);
        cur[keyPath[keyPath.length - 1]] = v;
      }
      const cfg = patchConfig(paths, patch);
      return finish(true, cfg);
    }
    finish(true, loadConfig(paths));
  });

async function handleVault(opts: any): Promise<void> {
  const v = vaultFor(paths);
  const pw = opts.password || process.env.FORGE_MASTER_PASSWORD;
  switch (opts.vault) {
    case 'init':
      if (!pw) return finish(false, { ok: false, error: '需要 --password 或 FORGE_MASTER_PASSWORD' });
      v.init(pw);
      return finish(true, { ok: true, initialized: true });
    case 'unlock': {
      if (!pw) return finish(false, { ok: false, error: '需要 --password' });
      const ok = v.unlock(pw);
      return finish(ok, { ok, unlocked: ok });
    }
    case 'lock':
      v.lock();
      return finish(true, { ok: true, locked: true });
    case 'set': {
      if (!opts.plugin || !opts.key) return finish(false, { ok: false, error: '需要 --plugin 与 --key' });
      if (!pw) return finish(false, { ok: false, error: '需要 --password' });
      v.unlock(pw);
      v.set(opts.plugin, opts.key, opts.value ?? '');
      return finish(true, { ok: true, plugin: opts.plugin, key: opts.key });
    }
    case 'get': {
      if (!opts.plugin || !opts.key) return finish(false, { ok: false, error: '需要 --plugin 与 --key' });
      if (!pw) return finish(false, { ok: false, error: '需要 --password' });
      v.unlock(pw);
      return finish(true, { ok: true, value: v.get(opts.plugin, opts.key) ?? null });
    }
    case 'list':
      return finish(true, { ok: true, keys: v.listKeys(opts.plugin) });
    default:
      return finish(false, { ok: false, error: `未知 vault 动作: ${opts.vault}` });
  }
}

/* =================== template =================== */
program
  .command('template [action] [name]')
  .description('模板：list | search <kw> | install <name> | export <plugin> | remote <kw> | add <url>')
  .option('--json', 'JSON 输出')
  .option('-f, --force', 'install / add 时覆盖已存在插件')
  .option('-y, --yes', 'install 时自动确认权限')
  .option('--refresh', 'remote 时强制刷新远端索引')
  .action(async (action = 'list', name: string | undefined, opts, cmd: Command) => {
    const o = allOpts(cmd);
    if (action === 'list') {
      return finish(true, listTemplates(paths));
    }
    if (action === 'search') {
      return finish(true, searchTemplates(paths, name || ''));
    }
    if (action === 'install') {
      if (!name) return finish(false, { ok: false, error: '需要模板名' });
      try {
        const r = await installTemplate(paths, name, o.force !== false, o.yes !== false);
        return finish(true, { ok: true, ...r });
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }
    if (action === 'export') {
      if (!name) return finish(false, { ok: false, error: '需要插件名' });
      try {
        const f = exportTemplate(paths, name);
        return finish(true, { ok: true, file: f });
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }
    if (action === 'remote') {
      try {
        const items = await searchRemote(paths, name || '', { refresh: Boolean(o.refresh) });
        if (o.json) return finish(true, items);
        const rows = items.map((t) => `${t.name.padEnd(24)} v${String(t.version).padEnd(8)} ${t.description.slice(0, 48)}`);
        output.write((rows.join('\n') || '(远端索引为空)') + '\n');
        return;
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }
    if (action === 'add') {
      if (!name) return finish(false, { ok: false, error: '需要来源 URL（.tgz / GitHub 仓库 / 单清单）' });
      try {
        const r = await installRemoteTemplate(paths, name, { force: o.force !== false });
        return finish(true, { ok: true, ...r });
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }
    finish(false, { ok: false, error: `未知动作: ${action}（list | search | install | export | remote | add）` });
  });

/* =================== plugins / subcommand dispatch =================== */
program
  .command('plugins <action>')
  .description('插件子命令：commands <plugin>')
  .action(async (action: string, opts, cmd: Command) => {
    if (action === 'commands') {
      const name = cmd.args[0];
      const eng = engine();
      const p = await eng.load(name);
      return finish(true, (p.commands || []).map((c) => ({ name: c.name, description: c.description })));
    }
    finish(false, { ok: false, error: `未知动作: ${action}` });
  });

/* =================== plugin config / rules =================== */
program
  .command('cfg <plugin>')
  .description('插件配置：查看 / 设置')
  .option('--set <json>', '合并写入 JSON')
  .action((name: string, opts) => {
    if (opts.set) {
      const patch = JSON.parse(opts.set);
      const cur = readPluginConfig(paths, name);
      writePluginConfig(paths, name, { ...cur, ...patch });
      return finish(true, { ok: true, config: readPluginConfig(paths, name) });
    }
    finish(true, readPluginConfig(paths, name));
  });

program
  .command('rule <plugin> [name]')
  .description('提取规则：列出 / 写入（--file 或 stdin）')
  .option('--file <path>', '从文件写入规则')
  .option('--set <yaml>', '直接写 YAML 字符串')
  .action((plugin: string, name: string | undefined, opts) => {
    if (!name) return finish(true, listRules(paths, plugin));
    let content = opts.set as string | undefined;
    if (opts.file) content = fs.readFileSync(opts.file, 'utf8');
    if (!content) return finish(false, { ok: false, error: '需要 --file 或 --set' });
    try {
      const f = writeRule(paths, plugin, name, content);
      finish(true, { ok: true, file: f });
    } catch (e) {
      finish(false, { ok: false, error: (e as Error).message });
    }
  });

/* =================== init =================== */
program
  .command('init')
  .description('初始化工作区：安装内置插件、播种模板库')
  .option('-f, --force', '重装内置插件')
  .option('--no-install', '不自动安装插件 npm 依赖（CI / 离线环境用）')
  .action(async (opts) => {
    const r = await initWorkspace({
      force: Boolean(opts.force),
      noInstall: opts.install === false,
    });
    finish(true, { ok: true, ...r, paths });
  });

/* =================== mcp =================== */
program
  .command('mcp')
  .description('启动 MCP 服务端（stdio），供 Claude Code / Cursor 等 AI 客户端调用')
  .option('--only <list>', '只暴露指定插件，逗号分隔')
  .option('--flat', '不把插件子命令暴露成独立工具')
  .option('--list', '只打印工具表（JSON）后退出')
  .allowUnknownOption(true)
  .action(async () => {
    await import('../mcp/index.js');
  });

/* =================== batch =================== */
program
  .command('batch <file>')
  .description('批量执行插件任务（任务文件：JSON 数组或 JSONL）')
  .option('-c, --concurrency <n>', '并发数', '3')
  .option('-r, --retry <n>', '每个任务最多尝试次数', '1')
  .option('--retry-delay <ms>', '重试基础退避（指数增长）', '400')
  .option('--rate <n>', '每秒最多启动任务数（0=不限）', '0')
  .option('--timeout <ms>', '单任务超时（毫秒）')
  .option('--out <file>', '结果落盘（JSONL 追加）')
  .option('--stream', '逐条输出 NDJSON（进度+结果）')
  .option('--json', '整批结果一次性 JSON 输出')
  .action(async (file: string, _opts, cmd: Command) => {
    const o = allOpts(cmd);
    const log = logger();
    let tasks: BatchTask[];
    try {
      tasks = readTasks(file);
    } catch (e) {
      return finish(false, { ok: false, error: (e as Error).message });
    }
    if (!tasks.length) return finish(false, { ok: false, error: '任务文件为空' });

    const total = tasks.length;
    const stream = Boolean(o.stream);
    if (stream) {
      process.stdout.write(JSON.stringify({ type: 'batch-start', total, concurrency: Number(o.concurrency), at: new Date().toISOString() }) + '\n');
    }

    const eng = engine();
    const results = await runBatch(
      tasks,
      async (task) => {
        const out = await eng.run(task.plugin, {
          params: task.params || {},
          command: task.command,
          logger: log,
          reuseBrowser: true,
        });
        return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
      },
      {
        concurrency: Number(o.concurrency),
        retry: Number(o.retry),
        retryDelayMs: Number(o.retryDelay),
        ratePerSec: Number(o.rate),
        timeoutMs: o.timeout ? Number(o.timeout) : undefined,
        outFile: o.out,
        onProgress: stream
          ? (ev) => process.stdout.write(JSON.stringify({
              type: 'progress', state: ev.state, index: ev.index, total: ev.total,
              plugin: ev.task.plugin, id: ev.task.id ?? null,
            }) + '\n')
          : undefined,
      },
    );

    // 浏览器池清理（批量结束）
    try { await eng.disposeBrowser(); } catch { /* ignore */ }

    const summary = summarizeBatch(results);
    for (const r of results) {
      if (!r) continue;
      const clog = new CallLog(paths);
      clog.append(clog.newEntry({
        plugin: r.task.plugin, command: r.task.command, params: r.task.params || {},
        ok: r.ok, ms: r.ms,
        summary: r.ok ? summarize(r.data) : (r.error || '').slice(0, 200),
        error: r.error?.slice(0, 2000), exitCode: r.ok ? 0 : 1,
      }));
    }

    if (stream) {
      for (const r of results) {
        if (!r) continue;
        process.stdout.write(JSON.stringify({
          type: 'result', index: r.index, plugin: r.task.plugin, id: r.task.id ?? null,
          ok: r.ok, ms: r.ms, attempts: r.attempts,
          ...(r.ok ? { data: r.data } : { error: r.error }),
        }) + '\n');
      }
      process.stdout.write(JSON.stringify({ type: 'batch-end', ...summary }) + '\n');
      process.exitCode = summary.fail ? 1 : 0;
      return;
    }

    if (o.json) {
      return finish(summary.fail === 0, { ok: summary.fail === 0, summary, results });
    }

    const rows = Object.entries(summary.byPlugin).map(([p, s]) => `${p.padEnd(20)} ok=${s.ok} fail=${s.fail}`);
    output.write(`批量完成：${summary.total} 个任务，成功 ${summary.ok}，失败 ${summary.fail}\n`);
    output.write(rows.join('\n') + '\n');
    if (summary.failures.length) {
      output.write('\n失败明细：\n');
      for (const f of summary.failures.slice(0, 20)) {
        output.write(`  #${f.index} ${f.plugin}${f.id ? `(${f.id})` : ''}: ${f.error.slice(0, 160)}\n`);
      }
    }
    process.exitCode = summary.fail ? 1 : 0;
  });

/* =================== verify =================== */
program
  .command('verify [plugin]')
  .description('校验插件完整性（对比安装时记录的基线哈希）')
  .option('--fix', '把当前状态写为新基线（单个插件或全部）')
  .option('--json', 'JSON 输出')
  .action((name: string | undefined, _opts, cmd: Command) => {
    const o = allOpts(cmd);

    if (o.fix) {
      const targets = name ? [name] : new Registry(paths).all().map((e) => e.name);
      const done = targets.map((n) => lockBaseline(paths, n)).filter(Boolean);
      return finish(true, { ok: true, baseline: done });
    }

    const items = name ? [verifyPlugin(paths, name)].filter(Boolean) as VerifyItem[] : verifyAll(paths);
    if (!items.length) return finish(false, { ok: false, error: name ? `未安装: ${name}` : '没有插件' });

    const bad = items.filter((i) => !i.ok);
    if (o.json) return finish(bad.length === 0, { ok: bad.length === 0, items });

    for (const it of items) {
      if (it.ok) {
        output.write(`[OK]   ${it.name}  ${it.actual.slice(0, 12)}…\n`);
      } else {
        output.write(`[FAIL] ${it.name}  ${it.reason}\n`);
        if (it.expected) output.write(`       基线 ${it.expected.slice(0, 12)}…  实际 ${it.actual.slice(0, 12)}…\n`);
        if (it.changedFiles?.length) {
          for (const f of it.changedFiles.slice(0, 15)) output.write(`       - ${f}\n`);
        }
        output.write('       若为有意改动：forge verify <name> --fix\n');
      }
    }
    output.write(`\n${items.length - bad.length}/${items.length} 通过\n`);
    process.exitCode = bad.length ? 1 : 0;
  });

/* =================== watch =================== */
program
  .command('watch <plugin> [name]')
  .description('抓取并与上次快照对比（新增/删除/变更）')
  .option('-p, --params <json>', '参数：JSON 或 k=v')
  .option('--params-file <path>', '从文件读取 JSON 参数')
  .option('--key <field>', '对齐键字段（缺省自动：url/link/id/title）')
  .option('--fields <list>', '只比较这些字段，逗号分隔')
  .option('--reset', '丢弃旧快照，直接建立新基线')
  .option('--json', 'JSON 输出')
  .action(async (plugin: string, name: string | undefined, _opts, cmd: Command) => {
    const o = allOpts(cmd);
    const log = logger();
    const params = resolveParams(o);
    const snapName = name || plugin;
    const snapDir = path.join(paths.data, plugin);

    if (o.reset) {
      const f = snapshotFile(snapDir, snapName);
      if (fs.existsSync(f)) fs.rmSync(f);
      return finish(true, { ok: true, reset: true, snapshot: f });
    }

    const out = await engine().run(plugin, { params, logger: log, reuseBrowser: false });
    if (!out.ok) return finish(false, { ok: false, error: out.error });

    const items = extractItems(out.data);
    const before = readSnapshot(snapDir, snapName);

    if (!before) {
      writeSnapshot(snapDir, snapName, items);
      return finish(true, {
        ok: true, baseline: true, count: items.length,
        snapshot: snapshotFile(snapDir, snapName),
        message: '已建立首个快照；再跑一次即可看到差异',
      });
    }

    const diff = diffResults({
      before,
      after: items,
      key: o.key ? String(o.key) : undefined,
      fields: o.fields ? String(o.fields).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    writeSnapshot(snapDir, snapName, items);

    if (o.json) return finish(true, { ok: true, baseline: false, diff, snapshot: snapshotFile(snapDir, snapName) });

    output.write(`对比 ${snapName}：${diff.counts.before} → ${diff.counts.after} 条\n`);
    output.write(`新增 ${diff.added.length}，删除 ${diff.removed.length}，变更 ${diff.changed.length}，未变 ${diff.unchanged}\n`);
    const brief = (x: unknown) => {
      if (x && typeof x === 'object') {
        const o2 = x as Record<string, unknown>;
        for (const k of ['title', '标题', 'name', 'url', '链接']) {
          if (typeof o2[k] === 'string') return String(o2[k]).slice(0, 100);
        }
      }
      return JSON.stringify(x).slice(0, 100);
    };
    if (diff.added.length) {
      output.write('\n新增：\n');
      for (const it of diff.added.slice(0, 20)) output.write(`  + ${brief(it)}\n`);
    }
    if (diff.removed.length) {
      output.write('\n删除：\n');
      for (const it of diff.removed.slice(0, 20)) output.write(`  - ${brief(it)}\n`);
    }
    if (diff.changed.length) {
      output.write('\n变更：\n');
      for (const c of diff.changed.slice(0, 20)) output.write(`  ~ ${c.key.slice(0, 60)} [${c.fields.join(',')}]\n`);
    }
  });

/* =================== keygen / sign =================== */
program
  .command('keygen')
  .description('生成 Ed25519 签名密钥对（~/.forgeapi/keys/）')
  .option('-f, --force', '覆盖已有密钥')
  .option('--signer <name>', '签名者名称（写进签名记录）')
  .action((_opts, cmd: Command) => {
    const o = allOpts(cmd);
    const r = createKeys(paths, { force: Boolean(o.force), signer: o.signer });
    if (!r.created) {
      return finish(true, { ok: true, created: false, keyId: r.keyId, privateKey: r.privateKey, publicKey: r.publicKey, message: '密钥已存在（加 --force 覆盖）' });
    }
    finish(true, { ok: true, created: true, keyId: r.keyId, privateKey: r.privateKey, publicKey: r.publicKey });
  });

program
  .command('sign [plugin]')
  .description('对插件内容签名（写 FORGE.SIG）；不给插件名则签全部')
  .option('--key <path>', '私钥路径（默认 ~/.forgeapi/keys/forge-ed25519.key）')
  .option('--signer <name>', '签名者名称')
  .option('--export-pub <path>', '顺带导出公钥到指定路径')
  .option('--list', '只列出签名状态')
  .option('--json', 'JSON 输出')
  .action((name: string | undefined, _opts, cmd: Command) => {
    const o = allOpts(cmd);

    if (o.list) {
      const list = signatureStatusAll(paths, { publicKeyPath: defaultKeyPaths(paths).publicKey });
      if (o.json) return finish(true, list);
      for (const it of list) {
        const tag = it.check.state.padEnd(15);
        output.write(`${tag} ${it.name}${it.check.keyId ? `  key=${it.check.keyId}` : ''}\n`);
      }
      return;
    }

    let exported: string | undefined;
    if (o.exportPub) {
      try { exported = exportPublicKey(paths, String(o.exportPub)); }
      catch (e) { return finish(false, { ok: false, error: (e as Error).message }); }
    }

    const targets = name ? [name] : new Registry(paths).all().map((e) => e.name);
    const signed: unknown[] = [];
    const failed: { plugin: string; error: string }[] = [];

    for (const t of targets) {
      try {
        const r = signPlugin(paths, t, {
          privateKeyPath: o.key ? String(o.key) : undefined,
          signer: o.signer ? String(o.signer) : undefined,
        });
        if (r) signed.push(r);
        else failed.push({ plugin: t, error: '插件未安装' });
      } catch (e) {
        failed.push({ plugin: t, error: (e as Error).message });
      }
    }

    finish(failed.length === 0, { ok: failed.length === 0, signed, failed, exportedPublicKey: exported });
  });

/* =================== trust =================== */
program
  .command('trust <action> [keyfile]')
  .description('可信公钥：import <file> | list | verify [plugin]')
  .action((action: string, keyfile: string | undefined, _opts, cmd: Command) => {
    const o = allOpts(cmd);
    if (action === 'import') {
      if (!keyfile) return finish(false, { ok: false, error: '需要公钥文件路径' });
      try {
        const r = importPublicKey(paths, keyfile);
        return finish(true, { ok: true, ...r });
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }
    if (action === 'list') {
      return finish(true, listTrustedKeys(paths));
    }
    if (action === 'verify') {
      const items = keyfile
        ? [{ name: keyfile, check: verifyWithTrusted(paths, new Registry(paths).get(keyfile)?.dir || '') }]
        : new Registry(paths).all()
            .filter((e) => fs.existsSync(e.dir))
            .map((e) => ({ name: e.name, check: verifyWithTrusted(paths, e.dir) }));
      const bad = items.filter((i) => !i.check.ok);
      if (o.json) return finish(bad.length === 0, { ok: bad.length === 0, items });
      for (const it of items) {
        output.write(`${it.check.state.padEnd(15)} ${it.name}${it.check.reason ? `  ${it.check.reason}` : ''}\n`);
      }
      process.exitCode = bad.length ? 1 : 0;
      return;
    }
    finish(false, { ok: false, error: `未知动作: ${action}（import | list | verify）` });
  });

/* =================== schedule =================== */
program
  .command('schedule [action] [target]')
  .description('内置调度：list | add | remove | enable | disable | run | daemon')
  .option('-p, --params <json>', '参数：JSON 或 k=v')
  .option('--params-file <path>', '从文件读取 JSON 参数')
  .option('--every <sec>', '固定间隔秒（≥10）')
  .option('--cron <expr>', '五字段 cron（分 时 日 月 周）')
  .option('--kind <kind>', 'run | batch | watch', 'run')
  .option('--file <path>', 'batch 的任务文件')
  .option('--key <field>', 'watch 的对齐键')
  .option('--name <name>', '调度名（add 必填）')
  .option('--json', 'JSON 输出')
  .option('--once', 'daemon 只跑一轮就退出（便于测试 / 外部 cron 调用）')
  .option('--interval <ms>', 'daemon 轮询间隔', '15000')
  .action(async (action = 'list', target: string | undefined, _opts, cmd: Command) => {
    const o = allOpts(cmd);
    const log = logger();

    /* ---- list ---- */
    if (action === 'list') {
      const store = loadSchedules(paths);
      if (o.json) return finish(true, store.entries);
      if (!store.entries.length) return finish(true, []);
      for (const e of store.entries) {
        const when = e.cron ? `cron ${e.cron}` : `every ${e.everySec}s`;
        const st = e.enabled ? 'on ' : 'off';
        output.write(
          `[${st}] ${e.name.padEnd(20)} ${e.kind.padEnd(6)} ${when.padEnd(22)} ` +
          `runs=${e.runs} fail=${e.failures}` +
          `${e.lastStatus ? ` last=${e.lastStatus}` : ''}` +
          `${e.nextRun ? ` next=${e.nextRun.slice(5, 19)}` : ''}\n`,
        );
      }
      return;
    }

    /* ---- add ---- */
    if (action === 'add') {
      const kind = String(o.kind || 'run') as 'run' | 'batch' | 'watch' | 'pipeline';
      const params = resolveParams(o);
      const name = o.name ? String(o.name) : (target || '');
      if (!name) return finish(false, { ok: false, error: '需要 --name <调度名>' });

      let args: Record<string, unknown>;
      if (kind === 'batch') {
        if (!o.file) return finish(false, { ok: false, error: 'batch 调度需要 --file <任务文件>' });
        args = { file: String(o.file) };
      } else if (kind === 'pipeline') {
        if (!o.file) return finish(false, { ok: false, error: 'pipeline 调度需要 --file <工作流文件>' });
        args = { file: String(o.file), input: params };
      } else if (kind === 'watch') {
        if (!target) return finish(false, { ok: false, error: 'watch 调度需要 <plugin> 作为 target' });
        args = { plugin: target, params, ...(o.key ? { key: String(o.key) } : {}) };
      } else {
        if (!target) return finish(false, { ok: false, error: 'run 调度需要 <plugin> 作为 target' });
        args = { plugin: target, params };
      }

      try {
        const e = addSchedule(paths, {
          name, kind, args,
          everySec: o.every ? Number(o.every) : undefined,
          cron: o.cron ? String(o.cron) : undefined,
        });
        return finish(true, { ok: true, entry: e });
      } catch (e) {
        return finish(false, { ok: false, error: (e as Error).message });
      }
    }

    /* ---- remove / enable / disable ---- */
    if (action === 'remove') {
      if (!target) return finish(false, { ok: false, error: '需要调度名' });
      const removed = removeSchedule(paths, target);
      return finish(removed, removed ? { ok: true, removed: target } : { ok: false, error: `未找到调度: ${target}` });
    }
    if (action === 'enable' || action === 'disable') {
      if (!target) return finish(false, { ok: false, error: '需要调度名' });
      const e = setEnabled(paths, target, action === 'enable');
      return finish(Boolean(e), e ? { ok: true, entry: e } : { ok: false, error: `未找到调度: ${target}` });
    }

    /* ---- run：立即执行一次 ---- */
    if (action === 'run') {
      if (!target) return finish(false, { ok: false, error: '需要调度名' });
      const store = loadSchedules(paths);
      const e = store.entries.find((x) => x.name === target || x.id === target);
      if (!e) return finish(false, { ok: false, error: `未找到调度: ${target}` });

      const r = await executeSchedule(paths, e, log);
      const updated = markRun(paths, e.name, { ok: r.ok, summary: r.summary });
      return finish(r.ok, { ok: r.ok, result: r, entry: updated });
    }

    /* ---- daemon ---- */
    if (action === 'daemon') {
      const interval = Math.max(1000, Number(o.interval || 15000));
      const once = Boolean(o.once);
      log.info(`调度守护启动：轮询 ${interval}ms${once ? '（单轮）' : ''}`);
      const eng = engine();
      let stopping = false;
      process.on('SIGINT', () => { stopping = true; log.info('收到 SIGINT，准备退出'); });
      process.on('SIGTERM', () => { stopping = true; });

      for (;;) {
        const due = dueEntries(paths);
        for (const e of due) {
          if (stopping) break;
          log.info(`执行 ${e.name}（${e.kind}）`);
          const r = await executeSchedule(paths, e, log, eng);
          const updated = markRun(paths, e.name, { ok: r.ok, summary: r.summary });
          log.info(`${e.name} → ${r.ok ? 'OK' : 'FAIL'}：${r.summary.slice(0, 120)}${updated?.nextRun ? `  下次 ${updated.nextRun}` : ''}`);
        }
        if (once || stopping) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      try { await eng.disposeBrowser(); } catch { /* ignore */ }
      log.info('调度守护退出');
      return;
    }

    finish(false, { ok: false, error: `未知动作: ${action}（list | add | remove | enable | disable | run | daemon）` });
  });

/** 执行一条调度，返回结果摘要 */
async function executeSchedule(
  paths: WorkspacePaths,
  entry: { kind: string; args: Record<string, unknown> },
  log: Logger,
  existingEngine?: ForgeEngine,
): Promise<{ ok: boolean; summary: string; data?: unknown }> {
  const eng = existingEngine || engine();
  try {
    if (entry.kind === 'run') {
      const plugin = String(entry.args.plugin || '');
      const out = await eng.run(plugin, { params: (entry.args.params as any) || {}, logger: log, reuseBrowser: true });
      logCall(paths, plugin, undefined, (entry.args.params as any) || {}, out);
      return { ok: out.ok, summary: out.ok ? summarize(out.data) : (out.error || '').slice(0, 200), data: out.data };
    }

    if (entry.kind === 'batch') {
      const file = String(entry.args.file || '');
      const tasks = readTasks(file);
      const results = await runBatch(tasks, async (t) => {
        const out = await eng.run(t.plugin, { params: t.params || {}, command: t.command, logger: log, reuseBrowser: true });
        logCall(paths, t.plugin, t.command, t.params || {}, out);
        return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
      }, { concurrency: 3 });
      const s = summarizeBatch(results);
      return { ok: s.fail === 0, summary: `批量 ${s.total} 个：成功 ${s.ok}，失败 ${s.fail}` };
    }

    if (entry.kind === 'pipeline') {
      const file = String(entry.args.file || '');
      const input = (entry.args.input as Record<string, unknown>) || {};
      const def = readPipeline(file);
      const result = await runPipeline(
        def,
        async (plugin, command, params) => {
          const out = await eng.run(plugin, { params, command, logger: log, reuseBrowser: true });
          logCall(paths, plugin, command, params, out);
          return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
        },
        { input },
      );
      const okSteps = result.steps.filter((s) => s.ok && !s.skipped).length;
      return {
        ok: result.ok,
        summary: `pipeline ${def.name || path.basename(file)}：${okSteps}/${result.steps.length} 步成功`,
        data: result.output,
      };
    }

    if (entry.kind === 'watch') {
      const plugin = String(entry.args.plugin || '');
      const snapName = String(entry.args.name || plugin);
      const params = (entry.args.params as any) || {};
      const out = await eng.run(plugin, { params, logger: log, reuseBrowser: true });
      if (!out.ok) return { ok: false, summary: out.error || '抓取失败' };

      const items = extractItems(out.data);
      const snapDir = path.join(paths.data, plugin);
      const before = readSnapshot(snapDir, snapName);
      if (!before) {
        writeSnapshot(snapDir, snapName, items);
        return { ok: true, summary: `建立基线 ${items.length} 条` };
      }
      const diff = diffResults({
        before, after: items,
        key: entry.args.key ? String(entry.args.key) : undefined,
      });
      writeSnapshot(snapDir, snapName, items);
      return {
        ok: true,
        summary: `新增 ${diff.added.length}，删除 ${diff.removed.length}，变更 ${diff.changed.length}`,
        data: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
      };
    }

    return { ok: false, summary: `未知调度类型: ${entry.kind}` };
  } catch (e) {
    return { ok: false, summary: (e as Error).message };
  }
}

function logCall(paths: WorkspacePaths, plugin: string, command: string | undefined, params: Record<string, unknown>, out: { ok: boolean; ms: number; data?: unknown; error?: string }): void {
  const clog = new CallLog(paths);
  clog.append(clog.newEntry({
    plugin, command, params, ok: out.ok, ms: out.ms,
    summary: out.ok ? summarize(out.data) : (out.error || '').slice(0, 200),
    error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
  }));
}

/* =================== pipeline =================== */
program
  .command('pipeline <file>')
  .description('执行声明式工作流（YAML/JSON），把多个插件串成数据管线')
  .option('-p, --params <json>', '输入参数：JSON 或 k=v（供 ${input.x} 引用）')
  .option('--params-file <path>', '从文件读取输入参数')
  .option('--stream', '逐步骤输出 NDJSON 进度')
  .option('--dry-run', '只解析并打印步骤计划，不执行')
  .option('--json', '完整结果 JSON 输出（默认就是）')
  .action(async (file: string, _opts, cmd: Command) => {
    const o = allOpts(cmd);
    const log = logger();
    let def;
    try {
      def = readPipeline(file);
    } catch (e) {
      return finish(false, { ok: false, error: (e as Error).message });
    }

    if (o.dryRun) {
      return finish(true, {
        ok: true,
        name: def.name,
        onError: def.onError,
        input: def.input,
        steps: def.steps.map((s) => ({
          id: s.id, plugin: s.plugin, command: s.command,
          forEach: s.forEach !== undefined, limit: s.limit,
          concurrency: s.concurrency, onError: s.onError, when: s.when !== undefined,
        })),
      });
    }

    const input = resolveParams(o);
    const eng = engine();
    const stream = Boolean(o.stream);
    if (stream) {
      process.stdout.write(JSON.stringify({ type: 'pipeline-start', name: def.name, steps: def.steps.length }) + '\n');
    }

    const started = Date.now();
    const result = await runPipeline(
      def,
      async (plugin, command, params) => {
        const out = await eng.run(plugin, { params, command, logger: log, reuseBrowser: true });
        const clog = new CallLog(paths);
        clog.append(clog.newEntry({
          plugin, command, params, ok: out.ok, ms: out.ms,
          summary: out.ok ? summarize(out.data) : (out.error || '').slice(0, 200),
          error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
        }));
        return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
      },
      {
        input,
        cred: (k) => {
          try { return vaultFor(paths).get('pipeline', k); } catch { return undefined; }
        },
        onStep: stream
          ? (ev) => process.stdout.write(JSON.stringify({ type: 'step', ...ev }) + '\n')
          : undefined,
      },
    );
    try { await eng.disposeBrowser(); } catch { /* ignore */ }

    if (stream) {
      process.stdout.write(JSON.stringify({
        type: 'pipeline-end', ok: result.ok, ms: result.ms,
        steps: result.steps.map((s) => ({ id: s.id, ok: s.ok, ms: s.ms, count: s.count, skipped: s.skipped })),
      }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'output', value: result.output }) + '\n');
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    finish(result.ok, {
      ok: result.ok,
      name: result.name,
      output: result.output,
      steps: result.steps.map((s) => ({
        id: s.id, plugin: s.plugin, command: s.command, ok: s.ok,
        skipped: s.skipped, count: s.count, ms: s.ms, error: s.error,
      })),
      error: result.error,
      ms: Date.now() - started,
    });
    void o.json;
  });

/* =================== serve =================== */
program
  .command('serve')
  .description('启动 Web 控制台')
  .option('--port <p>', '端口')
  .option('--host <h>', '监听地址')
  .action(async (opts) => {
    const cfg = loadConfig(paths);
    const port = Number(opts.port || cfg.server.port);
    const host = opts.host || cfg.server.host;
    const { startServer } = await import('../server/index.js');
    await startServer({ paths, host, port, logger: logger() });
  });

/* =================== doctor =================== */
program
  .command('doctor')
  .description('环境自检')
  .action(async () => {
    const checks: Record<string, unknown> = {};
    checks.node = process.version;
    checks.paths = paths;
    try {
      const pw = await import('playwright');
      checks.playwright = 'ok';
      try {
        const b = await pw.chromium.launch({ headless: true });
        checks.chromium = 'launched';
        await b.close();
      } catch (e) {
        checks.chromium = `失败: ${(e as Error).message.slice(0, 120)}（npx playwright install chromium）`;
      }
    } catch {
      checks.playwright = 'missing';
    }
    const reg = new Registry(paths);
    checks.plugins = reg.all().length;
    checks.enabled = reg.enabled().length;
    finish(true, checks);
  });

/* =================== 插件子命令注册（forge <plugin> <sub>） =================== */
async function registerPluginCommands(): Promise<void> {
  const reg = new Registry(paths);
  const RESERVED = new Set(['run', 'list', 'info', 'install', 'remove', 'enable', 'disable',
    'schema', 'skill', 'log', 'config', 'cfg', 'rule', 'template', 'plugins', 'init', 'serve', 'doctor', 'help']);

  for (const entry of reg.enabled()) {
    if (RESERVED.has(entry.name)) continue;
    let pluginName: string;
    let description: string;
    let commands: { name: string; description: string }[];
    try {
      const eng = engine();
      const p = await eng.load(entry.name);
      pluginName = p.name;
      description = p.description || entry.name;
      commands = (p.commands || []).map((c) => ({ name: c.name, description: c.description }));
    } catch {
      continue; // 加载失败不影响 CLI 启动
    }

    const parent = program.command(pluginName).description(description);

    for (const c of commands) {
      parent
        .command(c.name)
        .description(c.description)
        .option('-p, --params <json>', '参数：JSON 或 k=v')
        .option('--params-file <path>', '从文件读取 JSON 参数（避免 shell 引号问题）')
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async (opts: any) => {
          await runPlugin(pluginName, c.name, resolveParams(opts));
        });
    }

    parent
      .option('-p, --params <json>', '参数：JSON 或 k=v')
        .option('--params-file <path>', '从文件读取 JSON 参数（避免 shell 引号问题）')
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (opts: any) => {
        await runPlugin(pluginName, undefined, resolveParams(opts));
      });
  }
}

/** 统一执行入口：插件 + 可选子命令 */
async function runPlugin(plugin: string, command: string | undefined, params: Record<string, unknown>): Promise<void> {
  const log = logger();
  const t0 = Date.now();
  try {
    const out = await engine().run(plugin, { params, command, logger: log });
    const clog = new CallLog(paths);
    clog.append(clog.newEntry({
      plugin, command, params, ok: out.ok, ms: out.ms,
      summary: out.ok ? summarize(out.data) : (out.error || '').slice(0, 200),
      error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
    }));
    finish(out.ok, { ok: out.ok, data: out.data ?? null, error: out.error ?? null, meta: out.meta ?? null, ms: out.ms });
  } catch (e) {
    const err = e as Error;
    log.error(err.message);
    const clog = new CallLog(paths);
    clog.append(clog.newEntry({
      plugin, command, params, ok: false, ms: Date.now() - t0,
      summary: err.message.slice(0, 200), error: err.stack?.slice(0, 2000), exitCode: 1,
    }));
    finish(false, { ok: false, error: err.message });
  }
}

/* 启动：先注册插件子命令，再用 argv 归一后的参数解析 */
await registerPluginCommands().catch(() => { /* 忽略 */ });
const rewritten = rewriteArgv(process.argv, paths);
program.parseAsync(rewritten.argv).catch((e) => {
  process.stderr.write(`[forge:error] ${(e as Error).message}\n`);
  process.exitCode = 1;
});
