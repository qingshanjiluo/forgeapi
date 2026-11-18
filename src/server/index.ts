import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspacePaths } from '../core/types.js';
import { ForgeEngine } from '../core/engine.js';
import { Registry, inspectPluginDir, readSkill } from '../core/registry.js';
import { CallLog } from '../core/calllog.js';
import { loadConfig, patchConfig, readJson, writeJson } from '../core/workspace.js';
import { generateSkill } from '../core/skillgen.js';
import { listRules, writeRule, readPluginConfig, writePluginConfig, installPlugin, removePlugin, pluginDetail } from '../core/installer.js';
import { listTemplates, searchTemplates, installTemplate, exportTemplate } from '../core/templates.js';
import { vaultFor } from '../core/credentials.js';
import { ensureWebAssets } from './webassets.js';
import { readPipeline, runPipeline, normalizePipeline } from '../core/pipeline.js';
import { buildOpenApi } from './openapi.js';
import { loadSchedules, addSchedule, removeSchedule, setEnabled, markRun } from '../core/schedule.js';
import { signatureStatusAll, signPlugin, defaultKeyPaths } from '../core/signing.js';
import { verifyAll, lockBaseline, type VerifyItem } from '../core/integrity.js';
import { readTasks, runBatch, summarizeBatch } from '../core/scheduler.js';
import type { Logger } from '../core/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = ensureWebAssets();

export interface ServerOptions {
  paths: WorkspacePaths;
  host: string;
  port: number;
  logger: Logger;
}

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

function json(res: Res, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(s);
}

async function readBody(req: Req): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function startServer(opts: ServerOptions): Promise<http.Server> {
  const { paths, host, port, logger } = opts;
  const engine = new ForgeEngine(paths, vaultFor(paths));
  const callLog = new CallLog(paths);

  const server = http.createServer(async (req: Req, res: Res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      });
      return res.end();
    }

    /* ---------- API ---------- */
    if (p.startsWith('/api/')) {
      try {
        return await handleApi(req, res, p, url);
      } catch (e) {
        logger.error('API 异常', e);
        return json(res, 500, { ok: false, error: (e as Error).message });
      }
    }

    /* ---------- 静态资源 ---------- */
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(WEB_ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }
    // SPA 回退
    const idx = path.join(WEB_ROOT, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return fs.createReadStream(idx).pipe(res);
    }
    json(res, 404, { ok: false, error: '未找到前端资源；先执行 npm run build:web 或使用 API' });
  });

  async function handleApi(req: Req, res: Res, p: string, url: URL): Promise<void> {
    const method = req.method || 'GET';

    /* 插件列表 */
    if (p === '/api/plugins' && method === 'GET') {
      const reg = new Registry(paths);
      const items = reg.all().map((e) => ({ ...e, kind: inspectPluginDir(e.dir)?.kind }));
      return json(res, 200, { ok: true, data: items });
    }

    /* 插件详情 */
    const mDetail = p.match(/^\/api\/plugins\/([^/]+)$/);
    if (mDetail && method === 'GET') {
      const name = decodeURIComponent(mDetail[1]);
      const d = pluginDetail(paths, name);
      if (!d) return json(res, 404, { ok: false, error: '未找到插件' });
      let schema: unknown = null;
      let commands: unknown[] = [];
      try {
        const pl = await engine.load(name);
        schema = pl.schema;
        commands = (pl.commands || []).map((c) => ({ name: c.name, description: c.description, schema: c.schema || null }));
      } catch (e) {
        return json(res, 200, { ok: true, data: { entry: d.entry, skill: d.skill, kind: d.kind, loadError: (e as Error).message, schema: null, commands: [] } });
      }
      return json(res, 200, {
        ok: true,
        data: {
          entry: d.entry, skill: d.skill, kind: d.kind, schema, commands,
          config: readPluginConfig(paths, name), rules: listRules(paths, name),
        },
      });
    }

    /* 启用/禁用 */
    const mToggle = p.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
    if (mToggle && method === 'POST') {
      const name = decodeURIComponent(mToggle[1]);
      const ok = new Registry(paths).setEnabled(name, mToggle[2] === 'enable');
      engine.clearCache(name);
      return json(res, ok ? 200 : 404, { ok, error: ok ? undefined : '未找到插件' });
    }

    /* 卸载 */
    const mDel = p.match(/^\/api\/plugins\/([^/]+)$/);
    if (mDel && method === 'DELETE') {
      const name = decodeURIComponent(mDel[1]);
      const ok = removePlugin(paths, name);
      engine.clearCache(name);
      return json(res, ok ? 200 : 404, { ok, error: ok ? undefined : '未找到插件' });
    }

    /* 安装 */
    if (p === '/api/plugins/install' && method === 'POST') {
      const body = await readBody(req);
      const r = await installPlugin(paths, { source: body.source, force: body.force, yes: true });
      engine.clearCache(r.name);
      return json(res, 200, { ok: true, data: r });
    }

    /* 插件 schema / skill */
    const mSchema = p.match(/^\/api\/plugins\/([^/]+)\/schema$/);
    if (mSchema) {
      const name = decodeURIComponent(mSchema[1]);
      const pl = await engine.load(name);
      return json(res, 200, { ok: true, data: pl.schema });
    }
    const mSkill = p.match(/^\/api\/plugins\/([^/]+)\/skill$/);
    if (mSkill) {
      const name = decodeURIComponent(mSkill[1]);
      const pl = await engine.load(name);
      const md = generateSkill(pl, { rules: listRules(paths, name) });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(md);
      return;
    }

    /* 插件配置 */
    const mCfg = p.match(/^\/api\/plugins\/([^/]+)\/config$/);
    if (mCfg) {
      const name = decodeURIComponent(mCfg[1]);
      if (method === 'GET') return json(res, 200, { ok: true, data: readPluginConfig(paths, name) });
      if (method === 'PUT' || method === 'POST') {
        const body = await readBody(req);
        const cur = readPluginConfig(paths, name);
        const merged = body.merge === false ? body.config : { ...cur, ...body.config };
        writePluginConfig(paths, name, merged);
        return json(res, 200, { ok: true, data: readPluginConfig(paths, name) });
      }
    }

    /* 插件规则 */
    const mRules = p.match(/^\/api\/plugins\/([^/]+)\/rules$/);
    if (mRules) {
      const name = decodeURIComponent(mRules[1]);
      if (method === 'GET') return json(res, 200, { ok: true, data: listRules(paths, name) });
      if (method === 'PUT' || method === 'POST') {
        const body = await readBody(req);
        try {
          const f = writeRule(paths, name, body.name, body.content);
          return json(res, 200, { ok: true, data: { file: f } });
        } catch (e) {
          return json(res, 400, { ok: false, error: (e as Error).message });
        }
      }
    }

    /* 执行插件（调试台） */
    if (p === '/api/run' && method === 'POST') {
      const body = await readBody(req);
      const t0 = Date.now();
      const logs: string[] = [];
      const out = await engine.run(body.plugin, {
        params: body.params || {},
        command: body.command,
        logger,
        progress: (m) => logs.push(m),
        reuseBrowser: true, // 控制台常驻：复用 Chromium，省掉每次 5~10s 冷启动
      });
      const entry = callLog.newEntry({
        plugin: body.plugin, command: body.command, params: body.params || {},
        ok: out.ok, ms: out.ms,
        summary: out.ok ? 'ok' : (out.error || '').slice(0, 200),
        error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
      });
      callLog.append(entry);
      return json(res, 200, {
        ok: out.ok, data: out.data ?? null, error: out.error ?? null,
        meta: out.meta ?? null, ms: out.ms, logs, totalMs: Date.now() - t0,
      });
    }

    /* 执行工作流 */
    if (p === '/api/pipeline' && method === 'POST') {
      const body = await readBody(req);
      let def;
      try {
        if (body.def && typeof body.def === 'object') def = normalizePipeline(body.def);
        else if (body.file) def = readPipeline(String(body.file));
        else return json(res, 400, { ok: false, error: '需要 file 或 def' });
      } catch (e) {
        return json(res, 400, { ok: false, error: (e as Error).message });
      }
      const logs: string[] = [];
      const result = await runPipeline(
        def,
        async (plugin, command, params) => {
          const out = await engine.run(plugin, { params, command, logger, reuseBrowser: true });
          callLog.append(callLog.newEntry({
            plugin, command, params, ok: out.ok, ms: out.ms,
            summary: out.ok ? 'ok' : (out.error || '').slice(0, 200),
            error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
          }));
          return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
        },
        { input: body.input || {}, onStep: (ev) => logs.push(`${ev.state}:${ev.step}`) },
      );
      return json(res, 200, {
        ok: result.ok, output: result.output,
        steps: result.steps.map((s) => ({ id: s.id, plugin: s.plugin, ok: s.ok, skipped: s.skipped, count: s.count, ms: s.ms, error: s.error })),
        error: result.error, ms: result.ms, logs,
      });
    }

    /* 工作流列表（工作区 pipelines 目录） */
    if (p === '/api/pipeline/list' && method === 'GET') {
      const dir = path.join(paths.root, 'pipelines');
      const items: { name: string; file: string }[] = [];
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(ya?ml|json)$/i.test(f)) continue;
          items.push({ name: f.replace(/\.(ya?ml|json)$/i, ''), file: path.join(dir, f) });
        }
      }
      return json(res, 200, { ok: true, data: items });
    }

    /* OpenAPI 描述 */
    if (p === '/api/openapi.json' && method === 'GET') {
      return json(res, 200, buildOpenApi(paths));
    }

    /* ---------- 调度 ---------- */
    if (p === '/api/schedules' && method === 'GET') {
      return json(res, 200, { ok: true, data: loadSchedules(paths).entries });
    }
    if (p === '/api/schedules' && method === 'POST') {
      const body = await readBody(req);
      try {
        const entry = addSchedule(paths, {
          name: String(body.name || ''),
          kind: (body.kind || 'run') as 'run' | 'batch' | 'watch' | 'pipeline',
          args: body.args || { plugin: body.plugin, params: body.params || {} },
          everySec: body.everySec ? Number(body.everySec) : undefined,
          cron: body.cron ? String(body.cron) : undefined,
        });
        return json(res, 200, { ok: true, data: entry });
      } catch (e) {
        return json(res, 400, { ok: false, error: (e as Error).message });
      }
    }
    const mSched = p.match(/^\/api\/schedules\/([^/]+)$/);
    if (mSched && method === 'DELETE') {
      const name = decodeURIComponent(mSched[1]);
      const removed = removeSchedule(paths, name);
      return json(res, removed ? 200 : 404, { ok: removed, removed: name });
    }
    const mSchedToggle = p.match(/^\/api\/schedules\/([^/]+)\/(enable|disable)$/);
    if (mSchedToggle && method === 'POST') {
      const name = decodeURIComponent(mSchedToggle[1]);
      const e = setEnabled(paths, name, mSchedToggle[2] === 'enable');
      return json(res, e ? 200 : 404, { ok: Boolean(e), data: e });
    }
    const mSchedRun = p.match(/^\/api\/schedules\/([^/]+)\/run$/);
    if (mSchedRun && method === 'POST') {
      const name = decodeURIComponent(mSchedRun[1]);
      const entry = loadSchedules(paths).entries.find((x) => x.name === name);
      if (!entry) return json(res, 404, { ok: false, error: '未找到调度' });
      try {
        let ok = false;
        let summary = '';
        if (entry.kind === 'run') {
          const out = await engine.run(String(entry.args.plugin), {
            params: (entry.args.params as any) || {},
            logger,
            reuseBrowser: true,
          });
          ok = out.ok;
          summary = out.ok ? 'ok' : (out.error || '').slice(0, 200);
        } else {
          summary = `控制台只支持 run 类型，${entry.kind} 请走 CLI`;
        }
        const updated = markRun(paths, name, { ok, summary });
        return json(res, 200, { ok, summary, data: updated });
      } catch (e) {
        markRun(paths, name, { ok: false, summary: (e as Error).message });
        return json(res, 500, { ok: false, error: (e as Error).message });
      }
    }

    /* ---------- 校验 / 签名 ---------- */
    if (p === '/api/verify' && method === 'GET') {
      const items = verifyAll(paths);
      return json(res, 200, { ok: items.every((i) => i.ok), data: items });
    }
    if (p === '/api/verify/fix' && method === 'POST') {
      const body = await readBody(req);
      const targets = body.name ? [String(body.name)] : new Registry(paths).all().map((e) => e.name);
      const done = targets.map((n) => lockBaseline(paths, n)).filter(Boolean);
      return json(res, 200, { ok: true, data: done });
    }
    if (p === '/api/signature' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        data: signatureStatusAll(paths, { publicKeyPath: defaultKeyPaths(paths).publicKey }),
      });
    }
    if (p === '/api/signature' && method === 'POST') {
      const body = await readBody(req);
      const targets = body.name ? [String(body.name)] : new Registry(paths).all().map((e) => e.name);
      const signed: unknown[] = [];
      const failed: { plugin: string; error: string }[] = [];
      for (const t of targets) {
        try {
          const r = signPlugin(paths, t, { signer: body.signer ? String(body.signer) : undefined });
          if (r) signed.push(r); else failed.push({ plugin: t, error: '未安装' });
        } catch (e) {
          failed.push({ plugin: t, error: (e as Error).message });
        }
      }
      return json(res, failed.length ? 400 : 200, { ok: failed.length === 0, signed, failed });
    }

    /* ---------- 批量 ---------- */
    if (p === '/api/batch' && method === 'POST') {
      const body = await readBody(req);
      let tasks;
      try {
        tasks = body.tasks
          ? (Array.isArray(body.tasks) ? body.tasks : [body.tasks])
          : readTasks(String(body.file || ''));
      } catch (e) {
        return json(res, 400, { ok: false, error: (e as Error).message });
      }
      if (!tasks.length) return json(res, 400, { ok: false, error: '任务为空' });

      const logs: string[] = [];
      const results = await runBatch(
        tasks,
        async (task) => {
          const out = await engine.run(task.plugin, {
            params: task.params || {},
            command: task.command,
            logger,
            reuseBrowser: true,
          });
          callLog.append(callLog.newEntry({
            plugin: task.plugin, command: task.command, params: task.params || {},
            ok: out.ok, ms: out.ms,
            summary: out.ok ? 'ok' : (out.error || '').slice(0, 200),
            error: out.error?.slice(0, 2000), exitCode: out.ok ? 0 : 1,
          }));
          return { ok: out.ok, data: out.data, error: out.error, ms: out.ms };
        },
        {
          concurrency: Number(body.concurrency || 3),
          retry: Number(body.retry || 1),
          onProgress: (ev) => logs.push(`${ev.state}:${ev.task.plugin}`),
        },
      );
      const summary = summarizeBatch(results);
      return json(res, 200, {
        ok: summary.fail === 0,
        summary,
        results: results.map((r) => ({
          index: r.index, plugin: r.task.plugin, id: r.task.id ?? null,
          ok: r.ok, ms: r.ms, attempts: r.attempts,
          ...(r.ok ? { data: r.data } : { error: r.error }),
        })),
        logs,
      });
    }

    /* 日志 */
    if (p === '/api/logs' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 200);
      const plugin = url.searchParams.get('plugin') || undefined;
      const onlyError = url.searchParams.get('error') === '1';
      return json(res, 200, { ok: true, data: callLog.list({ limit, plugin, onlyError }) });
    }

    /* 全局配置 */
    if (p === '/api/config') {
      if (method === 'GET') return json(res, 200, { ok: true, data: loadConfig(paths) });
      if (method === 'PUT' || method === 'POST') {
        const body = await readBody(req);
        const cfg = patchConfig(paths, body.patch || body);
        return json(res, 200, { ok: true, data: cfg });
      }
    }

    /* 模板 */
    if (p === '/api/templates') {
      const q = url.searchParams.get('q');
      return json(res, 200, { ok: true, data: q ? searchTemplates(paths, q) : listTemplates(paths) });
    }
    if (p === '/api/templates/install' && method === 'POST') {
      const body = await readBody(req);
      const r = await installTemplate(paths, body.name);
      return json(res, 200, { ok: true, data: r });
    }
    if (p === '/api/templates/export' && method === 'POST') {
      const body = await readBody(req);
      const f = exportTemplate(paths, body.name);
      return json(res, 200, { ok: true, data: { dir: f } });
    }

    /* 凭据（只列键名，不返回值） */
    if (p === '/api/vault/keys' && method === 'GET') {
      const v = vaultFor(paths);
      const plugin = url.searchParams.get('plugin') || undefined;
      return json(res, 200, { ok: true, data: v.listKeys(plugin), initialized: v.initialized, unlocked: v.unlocked });
    }

    /* 健康 */
    if (p === '/api/health') {
      return json(res, 200, { ok: true, data: { version: '0.1.0', paths, uptime: process.uptime() } });
    }

    return json(res, 404, { ok: false, error: `未知 API: ${method} ${p}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  logger.info(`Web 控制台: http://${host}:${port}`);
  return server;
}

/* 直接执行入口 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const paths = (await import('../core/workspace.js')).resolvePaths();
  (await import('../core/workspace.js')).ensureDirs(paths);
  const cfg = loadConfig(paths);
  const { Logger } = await import('../core/log.js');
  startServer({ paths, host: cfg.server.host, port: cfg.server.port, logger: new Logger({ verbose: true }) });
}
